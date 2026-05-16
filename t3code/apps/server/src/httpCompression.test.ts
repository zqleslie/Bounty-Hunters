/**
 * Tests for HTTP compression middleware.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  shouldSkipContentType,
  isCompressibleContentType,
  parseAcceptEncoding,
  DEFAULT_COMPRESSION_CONFIG,
  CompressionConfig,
} from "./httpCompression.ts";

describe("httpCompression — content type detection", () => {
  describe("shouldSkipContentType", () => {
    it("skips image content types", () => {
      assert.isTrue(shouldSkipContentType("image/png"));
      assert.isTrue(shouldSkipContentType("image/jpeg"));
      assert.isTrue(shouldSkipContentType("image/svg+xml"));
      assert.isTrue(shouldSkipContentType("IMAGE/PNG"));
    });

    it("skips video and audio content types", () => {
      assert.isTrue(shouldSkipContentType("video/mp4"));
      assert.isTrue(shouldSkipContentType("audio/mpeg"));
    });

    it("skips font content types", () => {
      assert.isTrue(shouldSkipContentType("font/woff2"));
      assert.isTrue(shouldSkipContentType("application/vnd.ms-fontobject"));
    });

    it("skips already-compressed formats", () => {
      assert.isTrue(shouldSkipContentType("application/pdf"));
      assert.isTrue(shouldSkipContentType("application/zip"));
      assert.isTrue(shouldSkipContentType("application/gzip"));
    });

    it("allows JSON content type", () => {
      assert.isFalse(shouldSkipContentType("application/json"));
    });

    it("allows text content types", () => {
      assert.isFalse(shouldSkipContentType("text/html"));
      assert.isFalse(shouldSkipContentType("text/plain"));
    });

    it("handles content type with charset", () => {
      assert.isFalse(shouldSkipContentType("application/json; charset=utf-8"));
    });

    it("returns false for undefined content type", () => {
      assert.isFalse(shouldSkipContentType(undefined));
    });
  });

  describe("isCompressibleContentType", () => {
    it("identifies compressible content types", () => {
      assert.isTrue(isCompressibleContentType("application/json"));
      assert.isTrue(isCompressibleContentType("text/html"));
      assert.isTrue(isCompressibleContentType("text/css"));
      assert.isTrue(isCompressibleContentType("application/javascript"));
      assert.isTrue(isCompressibleContentType("application/ld+json"));
      assert.isTrue(isCompressibleContentType("application/vnd.api+json"));
    });

    it("rejects non-compressible content types", () => {
      assert.isFalse(isCompressibleContentType("image/png"));
      assert.isFalse(isCompressibleContentType("application/octet-stream"));
    });

    it("returns false for undefined content type", () => {
      assert.isFalse(isCompressibleContentType(undefined));
    });
  });

  describe("parseAcceptEncoding", () => {
    it("prefers brotli over gzip", () => {
      assert.equal(parseAcceptEncoding("gzip, br"), "br");
      assert.equal(parseAcceptEncoding("br, gzip"), "br");
      assert.equal(parseAcceptEncoding("gzip;q=0.8, br;q=1.0"), "br");
    });

    it("returns gzip when only gzip is accepted", () => {
      assert.equal(parseAcceptEncoding("gzip"), "gzip");
      assert.equal(parseAcceptEncoding("gzip, deflate"), "gzip");
      assert.equal(parseAcceptEncoding("gzip;q=0.8"), "gzip");
    });

    it("returns null when no compression is supported", () => {
      assert.isNull(parseAcceptEncoding("identity"));
      assert.isNull(parseAcceptEncoding(undefined));
      assert.isNull(parseAcceptEncoding(""));
    });
  });
});

describe("httpCompression — configuration", () => {
  it("default config has 1KB minimum", () => {
    assert.equal(DEFAULT_COMPRESSION_CONFIG.minSizeBytes, 1024);
  });

  it("default config has brotli quality 4", () => {
    assert.equal(DEFAULT_COMPRESSION_CONFIG.brotliQuality, 4);
  });

  it("default compression level respects COMPRESSION_LEVEL env var", () => {
    const original = process.env.COMPRESSION_LEVEL;
    process.env.COMPRESSION_LEVEL = "9";
    const mod = require("./httpCompression.ts");
    assert.equal(mod.DEFAULT_COMPRESSION_CONFIG.compressionLevel, 9);
    if (original !== undefined) {
      process.env.COMPRESSION_LEVEL = original;
    } else {
      delete process.env.COMPRESSION_LEVEL;
    }
  });
});
