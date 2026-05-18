<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Artisan::command('logs:clear {--days= : Number of days to retain log files (default: 7)}', function () {
    $logDir = storage_path('logs');
    $days = (int) ($this->option('days') ?: 7);
    $count = 0;
    $freedBytes = 0;

    if (!is_dir($logDir)) {
        $this->error("Log directory does not exist: {$logDir}");
        return;
    }

    foreach (new FilesystemIterator($logDir) as $file) {
        if (!$file->isFile()) {
            continue;
        }

        $modifiedAt = $file->getMTime();
        $cutoff = now()->subDays($days)->timestamp;

        if ($modifiedAt < $cutoff) {
            $freedBytes += $file->getSize();
            unlink($file->getPathname());
            $count++;
        }
    }

    $freedHuman = match (true) {
        $freedBytes >= 1073741824 => round($freedBytes / 1073741824, 2) . ' GB',
        $freedBytes >= 1048576 => round($freedBytes / 1048576, 2) . ' MB',
        $freedBytes >= 1024 => round($freedBytes / 1024, 2) . ' KB',
        default => $freedBytes . ' B',
    };

    $this->info("Cleared {$count} log file(s) older than {$days} days. Freed: {$freedHuman}");
})->purpose('Clear log files older than a specified number of days');

Schedule::command('logs:clear')->dailyAt('00:00');