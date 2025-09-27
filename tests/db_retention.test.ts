import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { clearEvents, storeEvent } from '../src/db.js';
import * as dbModule from '../src/db.js';
import { runRetentionOnce, startRetentionTask } from '../src/tasks/retention.js';
import { __test__ as guardTestUtils } from '../src/run-guard.ts';
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

  it('RetentionFaceSnapshotRotation archives nested face snapshots with snapshots', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 9, 1);
    vi.setSystemTime(now);

    const faceDir = path.join(cameraOneDir, 'faces');
    const nestedDir = path.join(faceDir, 'nested');
    fs.mkdirSync(nestedDir, { recursive: true });

    const staleTs = now - 45 * dayMs;
    const staleFiles = [
      path.join(cameraOneDir, 'snapshot-old.png'),
      path.join(faceDir, 'face-crop.png'),
      path.join(nestedDir, 'face-nested.png')
    ];

    for (const file of staleFiles) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, staleTs / 1000, staleTs / 1000);
    }

    const freshFile = path.join(cameraOneDir, 'snapshot-fresh.png');
    fs.writeFileSync(freshFile, freshFile);
    fs.utimesSync(freshFile, now / 1000, now / 1000);

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    try {
      const result = await runRetentionOnce({
        enabled: true,
        retentionDays: 30,
        intervalMs: 60000,
        archiveDir,
        snapshotDirs: [cameraOneDir],
        snapshot: { mode: 'archive', retentionDays: 10 },
        vacuum: { mode: 'auto', run: 'on-change' },
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(result.outcome?.archivedSnapshots).toBe(3);
      const cameraKey = path.basename(cameraOneDir);
      expect(result.outcome?.perCamera?.[cameraKey]?.archivedSnapshots).toBe(3);

      const archiveDate = formatArchiveDate(staleTs);
      const archiveRoot = path.join(archiveDir, cameraKey, archiveDate);
      const archivedFiles = collectArchiveFiles(archiveRoot);
      expect(archivedFiles).toEqual(
        expect.arrayContaining([
          path.join(archiveRoot, 'snapshot-old.png'),
          path.join(archiveRoot, 'faces', 'face-crop.png'),
          path.join(archiveRoot, 'faces', 'nested', 'face-nested.png')
        ])
      );

      for (const file of staleFiles) {
        expect(fs.existsSync(file)).toBe(false);
      }
      expect(fs.existsSync(freshFile)).toBe(true);

      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({
        archivedSnapshots: 3,
        perCamera: {
          [cameraKey]: { archivedSnapshots: 3, prunedArchives: 0 }
        }
      });

      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({
        archivedSnapshots: 3,
        perCamera: {
          [cameraKey]: { archivedSnapshots: 3, prunedArchives: 0 }
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('RetentionVacuumScheduling follows run policy and reports index maintenance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 4, 5);
    vi.setSystemTime(now);

    const staleTs = now - 40 * dayMs;
    const staleFile = path.join(cameraOneDir, 'rtsp-old.png');
    fs.writeFileSync(staleFile, staleFile);
    fs.utimesSync(staleFile, staleTs / 1000, staleTs / 1000);

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const vacuumSpy = vi.spyOn(dbModule, 'vacuumDatabase');

    const task = startRetentionTask({
      enabled: true,
      retentionDays: 30,
      intervalMs: 1000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      snapshot: { mode: 'archive', retentionDays: 10 },
      vacuum: { mode: 'auto', run: 'on-change', analyze: true, reindex: true },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();

      expect(vacuumSpy).toHaveBeenCalledTimes(1);
      expect(vacuumSpy.mock.calls[0]?.[0]).toMatchObject({
        run: 'on-change',
        analyze: true,
        reindex: true
      });
      const firstInfo = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(firstInfo?.[0]).toMatchObject({
        vacuumMode: 'auto',
        vacuumRunMode: 'on-change',
        vacuumTasks: {
          analyze: true,
          reindex: true,
          optimize: false,
          target: undefined
        }
      });
      const firstMetrics = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(firstMetrics).toMatchObject({ archivedSnapshots: 1 });

      vacuumSpy.mockClear();
      logger.info.mockClear();
      metrics.recordRetentionRun.mockClear();

      await vi.advanceTimersByTimeAsync(1000);
      await vi.runOnlyPendingTimersAsync();

      expect(vacuumSpy).not.toHaveBeenCalled();
      const secondInfo = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(secondInfo?.[0]).toMatchObject({
        vacuumMode: 'skipped',
        vacuumRunMode: 'on-change'
      });

      task.configure({
        enabled: true,
        retentionDays: 30,
        intervalMs: 1000,
        archiveDir,
        snapshotDirs: [cameraOneDir],
        snapshot: { mode: 'archive', retentionDays: 10 },
        vacuum: { mode: 'auto', run: 'always', analyze: false, reindex: true },
        logger,
        metrics: metrics as any
      });

      vacuumSpy.mockClear();
      logger.info.mockClear();

      await vi.runOnlyPendingTimersAsync();

      expect(vacuumSpy).toHaveBeenCalledTimes(1);
      expect(vacuumSpy.mock.calls[0]?.[0]).toMatchObject({ run: 'always', reindex: true });
      const thirdInfo = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(thirdInfo?.[0]).toMatchObject({
        vacuumMode: 'auto',
        vacuumRunMode: 'always',
        vacuumTasks: {
          analyze: false,
          reindex: true,
          optimize: false,
          target: undefined
        }
      });
    } finally {
      task.stop();
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('DatabaseChannelIndexMaintenance validates channel index and on-change vacuum', async () => {
    const indexes = db.prepare("PRAGMA index_list('events')").all() as Array<{ name: string }>;
    const indexNames = indexes.map(entry => entry.name);
    expect(indexNames).toContain('idx_events_channel');

    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 7, 1);
    vi.setSystemTime(now);

    const execSpy = vi.spyOn(db, 'exec');
    const vacuumSpy = vi.spyOn(dbModule, 'vacuumDatabase');
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
      retentionDays: 1,
      intervalMs: 500,
      archiveDir,
      snapshotDirs: [],
      vacuum: { mode: 'auto', run: 'on-change' },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();
      let vacuumCalls = execSpy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.startsWith('VACUUM'));
      expect(vacuumCalls.length).toBe(0);
      expect(vacuumSpy).not.toHaveBeenCalled();

      execSpy.mockClear();
      vacuumSpy.mockClear();

      storeEvent({
        ts: now - 3 * dayMs,
        source: 'cam-index',
        detector: 'motion',
        severity: 'info',
        message: 'stale event',
        meta: { channel: 'video:indexed' }
      });

      await vi.advanceTimersByTimeAsync(500);
      await vi.runOnlyPendingTimersAsync();

      vacuumCalls = execSpy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.startsWith('VACUUM'));
      expect(vacuumCalls.length).toBeGreaterThanOrEqual(1);
      expect(vacuumSpy).toHaveBeenCalledTimes(1);
    } finally {
      task.stop();
      execSpy.mockRestore();
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RetentionVacuumRotation enforces per-camera quotas and returns vacuum summary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 8, 1);
    vi.setSystemTime(now);

    const files = [
      path.join(cameraOneDir, 'cam1-old-a.jpg'),
      path.join(cameraOneDir, 'cam1-old-b.jpg'),
      path.join(cameraTwoDir, 'cam2-old-a.jpg'),
      path.join(cameraTwoDir, 'cam2-old-b.jpg'),
      path.join(cameraTwoDir, 'cam2-old-c.jpg')
    ];
    for (const file of files) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, (now - 40 * dayMs) / 1000, (now - 40 * dayMs) / 1000);
    }

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    try {
      const result = await runRetentionOnce({
        enabled: true,
        retentionDays: 30,
        intervalMs: 60000,
        archiveDir,
        snapshotDirs: [cameraOneDir, cameraTwoDir],
        vacuum: {
          mode: 'full',
          run: 'always',
          analyze: true,
          reindex: true,
          optimize: true,
          pragmas: ['PRAGMA optimize']
        },
        snapshot: {
          mode: 'archive',
          retentionDays: 10,
          maxArchivesPerCamera: {
            [path.basename(cameraOneDir)]: 1,
            [path.basename(cameraTwoDir)]: 2
          }
        },
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(result.vacuum.ran).toBe(true);
      expect(result.vacuum.mode).toBe('full');
      expect(result.vacuum.runMode).toBe('always');
      expect(result.vacuum.analyze).toBe(true);
      expect(result.vacuum.reindex).toBe(true);
      expect(result.vacuum.optimize).toBe(true);
      expect(result.vacuum.pragmas).toEqual(['PRAGMA optimize']);

      expect(metrics.recordRetentionRun).toHaveBeenCalled();
      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({ archivedSnapshots: expect.any(Number) });

      const perCamera = result.outcome?.perCamera ?? {};
      const camOneKey = path.basename(cameraOneDir);
      const camTwoKey = path.basename(cameraTwoDir);
      expect(perCamera[camOneKey]?.archivedSnapshots).toBeDefined();
      expect(perCamera[camTwoKey]?.archivedSnapshots).toBeDefined();

      const camOneFiles = collectArchiveFiles(path.join(archiveDir, camOneKey));
      const camTwoFiles = collectArchiveFiles(path.join(archiveDir, camTwoKey));
      expect(camOneFiles.length).toBeLessThanOrEqual(1);
      expect(camTwoFiles.length).toBeLessThanOrEqual(2);

      const completionCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(completionCall?.[0]).toMatchObject({ vacuumRunMode: 'always', vacuumMode: 'full' });
    } finally {
      vi.useRealTimers();
    }
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
      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({
        removedEvents: 0,
        archivedSnapshots: 0,
        prunedArchives: 0
      });
      expect(runCall?.perCamera).toMatchObject({
        [path.basename(cameraOneDir)]: { archivedSnapshots: 0, prunedArchives: 0 }
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

      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({
        removedEvents: 1,
        archivedSnapshots: 4,
        prunedArchives: 1
      });
      expect(runCall?.perCamera).toMatchObject({
        [path.basename(cameraOneDir)]: { archivedSnapshots: 2, prunedArchives: expect.any(Number) },
        [path.basename(cameraTwoDir)]: { archivedSnapshots: 2, prunedArchives: expect.any(Number) }
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

  it('RetentionPerCameraQuota applies alias limits and skips on-change vacuum when idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 6, 1);
    vi.setSystemTime(now);

    const files = [
      path.join(cameraOneDir, 'c1-a.jpg'),
      path.join(cameraOneDir, 'c1-b.jpg'),
      path.join(cameraOneDir, 'c1-c.jpg'),
      path.join(cameraTwoDir, 'c2-a.jpg'),
      path.join(cameraTwoDir, 'c2-b.jpg'),
      path.join(cameraTwoDir, 'c2-c.jpg')
    ];
    for (const file of files) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, (now - 35 * dayMs) / 1000, (now - 35 * dayMs) / 1000);
    }

    const vacuumSpy = vi.spyOn(dbModule, 'vacuumDatabase');
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
      intervalMs: 500,
      archiveDir,
      snapshotDirs: [cameraOneDir, cameraTwoDir],
      snapshot: {
        mode: 'archive',
        retentionDays: 10,
        maxArchivesPerCamera: {
          [path.basename(cameraOneDir)]: 1,
          [path.basename(cameraTwoDir)]: 2
        }
      } as any,
      logger,
      metrics: metrics as any,
      vacuum: {
        mode: 'auto',
        run: 'on-change'
      }
    });

    try {
      await vi.runOnlyPendingTimersAsync();

      expect(vacuumSpy).toHaveBeenCalledTimes(1);
      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      const camOneKey = path.basename(cameraOneDir);
      const camTwoKey = path.basename(cameraTwoDir);
      expect(runCall?.perCamera?.[camOneKey]).toMatchObject({
        archivedSnapshots: expect.any(Number),
        prunedArchives: expect.any(Number)
      });
      expect(runCall?.perCamera?.[camTwoKey]).toMatchObject({
        archivedSnapshots: expect.any(Number),
        prunedArchives: expect.any(Number)
      });
      expect(runCall?.perCamera?.[camOneKey]?.prunedArchives).toBeGreaterThanOrEqual(1);

      const camOneFiles = collectArchiveFiles(path.join(archiveDir, camOneKey));
      const camTwoFiles = collectArchiveFiles(path.join(archiveDir, camTwoKey));
      expect(camOneFiles.length).toBeLessThanOrEqual(1);
      expect(camTwoFiles.length).toBeLessThanOrEqual(2);

      const initialVacuumCalls = vacuumSpy.mock.calls.length;
      metrics.recordRetentionRun.mockClear();

      await vi.advanceTimersByTimeAsync(500);
      await vi.runOnlyPendingTimersAsync();

      expect(vacuumSpy.mock.calls.length).toBe(initialVacuumCalls);
      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);
      const secondRun = metrics.recordRetentionRun.mock.calls[0]?.[0];
      expect(secondRun).toMatchObject({
        archivedSnapshots: 0,
        prunedArchives: 0,
        removedEvents: 0
      });
    } finally {
      task.stop();
      vacuumSpy.mockRestore();
    }
  });

  it('RetentionChannelSnapshotRotation rotates channel snapshots and records per-camera totals', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 5, 10);
    vi.setSystemTime(now);

    const globalDir = path.join(tempDir, 'global-snapshots');
    const channelDir = path.join(tempDir, 'channel-lobby');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(channelDir, { recursive: true });

    const directories = guardTestUtils.collectSnapshotDirectories(
      {
        framesPerSecond: 10,
        channels: {
          'video:lobby': { person: { snapshotDir: channelDir } }
        },
        cameras: [
          {
            id: 'cam-a',
            channel: 'video:lobby',
            person: { snapshotDir: cameraOneDir }
          }
        ]
      } as any,
      { modelPath: 'person.onnx', score: 0.5, snapshotDir: globalDir } as any
    );

    expect(new Set(directories)).toEqual(
      new Set([
        path.resolve(globalDir),
        path.resolve(channelDir),
        path.resolve(cameraOneDir)
      ])
    );

    const oldFiles = [
      path.join(globalDir, 'global-old.jpg'),
      path.join(channelDir, 'channel-one.jpg'),
      path.join(channelDir, 'channel-two.jpg')
    ];
    for (const file of oldFiles) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, (now - 40 * dayMs) / 1000, (now - 40 * dayMs) / 1000);
    }

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
      snapshotDirs: directories,
      snapshot: { mode: 'archive', retentionDays: 7 },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();

      expect(execSpy).toHaveBeenCalledWith('VACUUM');
      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({
        removedEvents: 0,
        archivedSnapshots: 3
      });
      expect(runCall?.perCamera).toMatchObject({
        [path.basename(globalDir)]: { archivedSnapshots: 1, prunedArchives: 0 },
        [path.basename(channelDir)]: {
          archivedSnapshots: 2,
          prunedArchives: expect.any(Number)
        },
        [path.basename(cameraOneDir)]: { archivedSnapshots: 0, prunedArchives: 0 }
      });
    } finally {
      task.stop();
      execSpy.mockRestore();
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

function formatArchiveDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

