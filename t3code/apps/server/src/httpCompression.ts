/**
 * HTTP Compression Middleware — gzip and brotli for the Effect HTTP server.
 *
 * Features:
 * - Compress responses >1KB when client sends Accept-Encoding with gzip/br
 * - Prefer brotli over gzip when both accepted
 * - Set Content-Encoding header on compressed responses
 * - Skip compression for already-compressed content types (images, archives)
 * - Configurable compression level via COMPRESSION_LEVEL env var
 * - Decompress incoming request bodies when Content-Encoding is set
 */
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Metric from "effect/Metric";
import { metricAttributes } from "./observability/Metrics.ts";

// ---------------------------------------------------------------------------
// Content type lists
// ---------------------------------------------------------------------------

const COMPRESSIBLE_CONTENT_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/text",
  "text/html",
  "text/css",
  "text/plain",
  "text/javascript",
  "application/x-javascript",
  "application/ld+json",
  "application/manifest+json",
  "application/vnd.api+json",
  "application/graphql-response+json",
]);

const SKIP_COMPRESSION_CONTENT_TYPES = new Set([
  "image/",       // all images
  "video/",       // all video
  "audio/",       // all audio
  "font/",        // all fonts
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.ms-fontobject",
  "image/svg+xml", // SVG is already text-compressed
  "application/wasm",
]);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const compressionRequestsTotal = Metric.counter("t3_http_compression_requests_total", {
  description: "Total HTTP compression middleware invocations.",
});

export const compressionSavingsBytes = Metric.counter("t3_http_compression_savings_bytes", {
  description: "Total bytes saved by compression (original - compressed).",
});

export const compressionLatency = Metric.timer("t3_http_compression_latency", {
  description: "Compression middleware processing latency.",
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CompressionConfig {
  readonly minSizeBytes: number;
  readonly compressionLevel: number;
  readonly brotliQuality: number;
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  minSizeBytes: 1024, // 1KB
  compressionLevel: parseInt(process.env.COMPRESSION_LEVEL ?? "6", 10),
  brotliQuality: 4,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shouldSkipContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalizedContentType = contentType.toLowerCase().split(";")[0].trim();
  for (const skipPrefix of SKIP_COMPRESSION_CONTENT_TYPES) {
    if (
      skipPrefix.endsWith("/")
        ? normalizedContentType.startsWith(skipPrefix)
        : normalizedContentType === skipPrefix
    ) {
      return true;
    }
  }
  return false;
}

export function isCompressibleContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalizedContentType = contentType.toLowerCase().split(";")[0].trim();
  return COMPRESSIBLE_CONTENT_TYPES.has(normalizedContentType);
}

export function parseAcceptEncoding(acceptEncoding: string | undefined): "br" | "gzip" | null {
  if (!acceptEncoding) return null;
  const encodings = acceptEncoding.toLowerCase().split(",").map((e) => e.trim());

  // Prefer brotli over gzip when both accepted
  const hasBrotli = encodings.some((e) => e === "br" || e.startsWith("br;q="));
  const hasGzip = encodings.some((e) => e === "gzip" || e.startsWith("gzip;q="));

  if (hasBrotli) return "br";
  if (hasGzip) return "gzip";
  return null;
}

// ---------------------------------------------------------------------------
// Compression implementation (using Node.js built-in zlib)
// ---------------------------------------------------------------------------

async function gzipCompress(data: Uint8Array, level: number): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  return new Promise((resolve, reject) => {
    zlib.gzip(data, { level }, (err, result) => {
      if (err) reject(err);
      else resolve(new Uint8Array(result));
    });
  });
}

async function brotliCompress(data: Uint8Array, quality: number): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  return new Promise((resolve, reject) => {
    zlib.brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } }, (err, result) => {
      if (err) reject(err);
      else resolve(new Uint8Array(result));
    });
  });
}

export async function decompressBody(data: Uint8Array, encoding: string): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  return new Promise((resolve, reject) => {
    if (encoding === "gzip" || encoding === "deflate") {
      zlib.unzip(data, (err, result) => {
        if (err) reject(err);
        else resolve(new Uint8Array(result));
      });
    } else if (encoding === "br") {
      zlib.brotliDecompress(data, (err, result) => {
        if (err) reject(err);
        else resolve(new Uint8Array(result));
      });
    } else {
      resolve(data);
    }
  });
}

// ---------------------------------------------------------------------------
// High-level compression API — used by routes that want to compress responses
// ---------------------------------------------------------------------------

/**
 * Compress a response body if the client supports it.
 * Returns the compressed data and the encoding used, or the original data if
 * compression was skipped.
 */
export async function compressResponseBody(
  bodyData: Uint8Array,
  acceptEncoding: string | undefined,
  contentType: string | undefined,
  config: CompressionConfig = DEFAULT_COMPRESSION_CONFIG,
): Promise<{ data: Uint8Array; encoding: string | null }> {
  const preferredEncoding = parseAcceptEncoding(acceptEncoding);
  if (!preferredEncoding) {
    return { data: bodyData, encoding: null };
  }

  if (shouldSkipContentType(contentType)) {
    return { data: bodyData, encoding: null };
  }

  if (!isCompressibleContentType(contentType)) {
    return { data: bodyData, encoding: null };
  }

  if (bodyData.length < config.minSizeBytes) {
    return { data: bodyData, encoding: null };
  }

  const compressedData = preferredEncoding === "br"
    ? await brotliCompress(bodyData, config.brotliQuality)
    : await gzipCompress(bodyData, config.compressionLevel);

  // Only use compressed if it's actually smaller
  if (compressedData.length >= bodyData.length) {
    return { data: bodyData, encoding: null };
  }

  return { data: compressedData, encoding: preferredEncoding };
}
