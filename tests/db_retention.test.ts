import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { clearEvents, storeEvent } from '../src/db.js';
import { startRetentionTask } from '../src/tasks/retention.js';
import { EventRecord } from '../src/types.js';

describe('RetentionMaintenance', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  let tempDir: string;
  let archiveDir: string;
  let cameraOneDir: string;
  let cameraTwoDir: string;

  beforeEach(() => {
    clearEvents();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-retention-'));
    archiveDir = path.join(tempDir, 'archive');
    cameraOneDir = path.join(tempDir, 'cam-one');
    cameraTwoDir = path.join(tempDir, 'cam-two');
    fs.mkdirSync(cameraOneDir, { recursive: true });
    fs.mkdirSync(cameraTwoDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('RetentionVacuumPolicy honors run mode and emits metrics', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 0, 1);
    vi.setSystemTime(now);

    const execSpy = vi.spyOn(db, 'exec');
    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const task = startRetentionTask({
      enabled: true,
      retentionDays: 30,
      intervalMs: 1000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      vacuum: {
        mode: 'full',
        analyze: true,
        reindex: true,
        optimize: true,
        pragmas: ['PRAGMA incremental_vacuum', ''],
        run: 'always'
      },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();
      expect(execSpy).toHaveBeenCalledWith('VACUUM');
      expect(metrics.recordRetentionRun).toHaveBeenCalledWith({
        removedEvents: 0,
        archivedSnapshots: 0,
        prunedArchives: 0
      });
      expect(metrics.recordRetentionWarning).not.toHaveBeenCalled();

      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({
        vacuumMode: 'full',
        vacuumRunMode: 'always',
        vacuumTasks: {
          analyze: true,
          reindex: true,
          optimize: true,
          target: undefined
        }
      });
    } finally {
      task.stop();
    }
  });

  it('SnapshotArchiveQuota enforces per-camera limits and reports warnings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 3, 15);
    vi.setSystemTime(now);

    const oldEvent: EventRecord = {
      ts: now - 45 * dayMs,
      source: 'sensor:retention',
      detector: 'motion',
      severity: 'info',
      message: 'old event',
      meta: {}
    };
    storeEvent(oldEvent);

    const files = [
      path.join(cameraOneDir, 'c1-old.jpg'),
      path.join(cameraOneDir, 'c1-older.jpg'),
      path.join(cameraTwoDir, 'c2-a.jpg'),
      path.join(cameraTwoDir, 'c2-b.jpg'),
      path.join(cameraTwoDir, 'c2-c.jpg')
    ];
    for (const file of files) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, (now - 40 * dayMs) / 1000, (now - 40 * dayMs) / 1000);
    }

    const realRename = fs.renameSync.bind(fs);
    let failNext = true;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      if (failNext) {
        failNext = false;
        throw new Error('move failed');
      }
      return realRename(...(args as Parameters<typeof fs.renameSync>));
    });

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const task = startRetentionTask({
      enabled: true,
      retentionDays: 30,
      intervalMs: 1000,
      archiveDir,
      snapshotDirs: [cameraOneDir, cameraTwoDir],
      maxArchivesPerCamera: 3,
      snapshot: {
        mode: 'archive',
        retentionDays: 10,
        perCameraMax: {
          [path.basename(cameraOneDir)]: 1,
          [path.basename(cameraTwoDir)]: 2
        }
      },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();

      expect(renameSpy).toHaveBeenCalled();
      expect(metrics.recordRetentionWarning).toHaveBeenCalledWith({
        camera: path.basename(cameraOneDir),
        path: expect.stringContaining('c1'),
        reason: 'move failed'
      });
      const warnCall = logger.warn.mock.calls.find(([, message]) => message === 'Retention archive warning');
      expect(warnCall?.[0]).toMatchObject({ camera: path.basename(cameraOneDir) });

      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({ prunedArchives: 1, archivedSnapshots: 4 });

      expect(metrics.recordRetentionRun).toHaveBeenCalledWith({
        removedEvents: 1,
        archivedSnapshots: 4,
        prunedArchives: 1
      });

      const camOneFiles = collectArchiveFiles(path.join(archiveDir, path.basename(cameraOneDir)));
      const camTwoFiles = collectArchiveFiles(path.join(archiveDir, path.basename(cameraTwoDir)));
      expect(camOneFiles.length).toBeLessThanOrEqual(1);
      expect(camTwoFiles.length).toBe(2);
    } finally {
      task.stop();
      renameSpy.mockRestore();
    }
  });
});

function collectArchiveFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(resolved);
      } else if (entry.isFile()) {
        files.push(resolved);
      }
    }
  }
  return files;
}

