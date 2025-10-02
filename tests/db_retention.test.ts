import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { clearEvents, storeEvent, getDatabaseDiskUsage } from '../src/db.js';
import * as dbModule from '../src/db.js';
import { runRetentionOnce, startRetentionTask } from '../src/tasks/retention.js';
import { __test__ as guardTestUtils } from '../src/run-guard.ts';
import { EventRecord } from '../src/types.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

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
        },
        diskSavingsBytes: expect.any(Number)
      });

      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({
        archivedSnapshots: 3,
        perCamera: {
          [cameraKey]: { archivedSnapshots: 3, prunedArchives: 0 }
        },
        diskSavingsBytes: expect.any(Number)
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('RetentionCrossDeviceArchive falls back to copy when snapshot move crosses devices', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 10, 12);
    vi.setSystemTime(now);

    const staleTs = now - 45 * dayMs;
    const snapshotPath = path.join(cameraOneDir, 'cross-device-old.jpg');
    fs.writeFileSync(snapshotPath, 'stale');
    fs.utimesSync(snapshotPath, staleTs / 1000, staleTs / 1000);

    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (source === snapshotPath) {
        const error = new Error('EXDEV move') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      return realRename(source, target);
    });
    const copySpy = vi.spyOn(fs, 'copyFileSync');
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

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
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(copySpy).toHaveBeenCalledTimes(1);
      expect(unlinkSpy).toHaveBeenCalledWith(snapshotPath);
      const cameraKey = path.basename(cameraOneDir);
      const perCamera = result.outcome?.perCamera?.[cameraKey];
      expect(perCamera?.archivedSnapshots).toBe(1);
      const archiveDate = formatArchiveDate(staleTs);
      const archiveRoot = path.join(archiveDir, cameraKey, archiveDate);
      const archivedFiles = collectArchiveFiles(archiveRoot);
      expect(archivedFiles).toContain(path.join(archiveRoot, 'cross-device-old.jpg'));
      const runArgs = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runArgs?.archivedSnapshots).toBe(1);
    } finally {
      renameSpy.mockRestore();
      copySpy.mockRestore();
      unlinkSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RetentionDiskSavingsMetrics records disk usage and vacuum table stats', async () => {
    const now = Date.now();
    const staleTs = now - 90 * dayMs;
    const payload = 'x'.repeat(32 * 1024);
    for (let i = 0; i < 12; i += 1) {
      storeEvent({
        ts: staleTs - i * 1000,
        source: 'video:test-camera',
        detector: 'motion',
        severity: 'info',
        message: `${i}:${payload}`,
        meta: { channel: 'video:test-camera' }
      } as EventRecord);
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

    const beforeUsage = getDatabaseDiskUsage();

    const result = await runRetentionOnce({
      enabled: true,
      retentionDays: 0,
      intervalMs: 60000,
      archiveDir,
      snapshotDirs: [],
      vacuum: { mode: 'auto', run: 'always', target: 'main', analyze: true, optimize: true },
      logger,
      metrics: metrics as any
    });

    expect(result.skipped).toBe(false);
    expect(result.disk.before.totalBytes).toBe(beforeUsage.totalBytes);
    expect(result.disk.after.totalBytes).toBeLessThan(result.disk.before.totalBytes);
    expect(result.disk.savingsBytes).toBeGreaterThan(0);
    expect(result.vacuum.disk?.after.totalBytes).toBe(result.disk.after.totalBytes);
    const eventsTable = result.vacuum.tables?.find(table => table.name === 'events');
    expect(eventsTable?.freedBytes ?? 0).toBeGreaterThan(0);
    const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
    expect(runCall?.diskSavingsBytes).toBe(result.disk.savingsBytes);
    const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
    expect(infoCall?.[0]).toMatchObject({ diskSavingsBytes: result.disk.savingsBytes });
  });

  it('RetentionSnapshotRotation prunes archives per camera and updates vacuum index version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 11, 1);
    vi.setSystemTime(now);

    const cameraKey = path.basename(cameraOneDir);
    const staleTs = now - 35 * dayMs;
    const olderTs = now - 65 * dayMs;
    const staleFiles = [
      path.join(cameraOneDir, 'rot-old-a.jpg'),
      path.join(cameraOneDir, 'rot-old-b.jpg'),
      path.join(cameraOneDir, 'rot-old-c.jpg')
    ];
    const freshFile = path.join(cameraOneDir, 'rot-fresh.jpg');

    for (const file of staleFiles) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, staleTs / 1000, staleTs / 1000);
    }

    fs.writeFileSync(freshFile, freshFile);
    fs.utimesSync(freshFile, now / 1000, now / 1000);

    const existingArchiveDir = path.join(archiveDir, cameraKey, '2024-07-01');
    fs.mkdirSync(existingArchiveDir, { recursive: true });
    const preexistingArchive = path.join(existingArchiveDir, 'archived-preexisting.jpg');
    fs.writeFileSync(preexistingArchive, preexistingArchive);
    fs.utimesSync(preexistingArchive, olderTs / 1000, olderTs / 1000);

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
        retentionDays: 20,
        intervalMs: 60000,
        archiveDir,
        snapshotDirs: [cameraOneDir],
        snapshot: {
          mode: 'archive',
          retentionDays: 10,
          maxArchivesPerCamera: {
            [cameraKey]: 2
          }
        },
        vacuum: {
          mode: 'auto',
          run: 'always',
          pragmas: ['PRAGMA optimize']
        },
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(result.vacuum.ran).toBe(true);
      expect(result.vacuum.mode).toBe('auto');
      expect(result.vacuum.pragmas).toEqual(['PRAGMA optimize']);
      expect(result.vacuum.indexVersion).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.vacuum.ensuredIndexes ?? [])).toBe(true);

      staleFiles.forEach(file => {
        expect(fs.existsSync(file)).toBe(false);
      });
      expect(fs.existsSync(freshFile)).toBe(true);

      const archiveRoot = path.join(archiveDir, cameraKey);
      const archivedFiles = collectArchiveFiles(archiveRoot);
      expect(archivedFiles.length).toBeLessThanOrEqual(2);

      const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(versionRow.user_version).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('RetentionVacuumIndexRebuild recreates missing indexes and reports ensure summary', async () => {
    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const indexDefinitions = [
      ...(dbModule.__test__?.EVENT_INDEX_DEFINITIONS ?? []),
      ...(dbModule.__test__?.FACE_INDEX_DEFINITIONS ?? [])
    ];
    for (const definition of indexDefinitions) {
      db.exec(`DROP INDEX IF EXISTS ${definition.name}`);
    }
    db.exec('PRAGMA user_version = 0');

    const result = await runRetentionOnce({
      enabled: true,
      retentionDays: 30,
      intervalMs: 60000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      vacuum: { mode: 'auto', run: 'always' },
      logger,
      metrics: metrics as any
    });

    const expectedNames = indexDefinitions.map(definition => definition.name).sort();
    const ensured = [...(result.vacuum.ensuredIndexes ?? [])].sort();
    expect(result.vacuum.ran).toBe(true);
    expect(ensured).toEqual(expectedNames);
    expect(result.vacuum.indexVersion).toBe(dbModule.__test__?.EVENT_INDEX_SCHEMA_VERSION ?? 1);
    expect(result.vacuum.indexVersionChanged).toBe(true);
    const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
    expect(infoCall?.[0]?.vacuumTasks?.indexVersionChanged).toBe(true);
    const loggedIndexes = [...(infoCall?.[0]?.vacuumTasks?.ensuredIndexes ?? [])].sort();
    expect(loggedIndexes).toEqual(expectedNames);
  });

  it('RetentionSnapshotDeleteMode deletes stale snapshots without archiving and skips vacuum', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 10, 5);
    vi.setSystemTime(now);

    const staleTs = now - 60 * dayMs;
    const staleFiles = [
      path.join(cameraOneDir, 'delete-old-a.jpg'),
      path.join(cameraOneDir, 'delete-old-b.jpg')
    ];
    for (const file of staleFiles) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, staleTs / 1000, staleTs / 1000);
    }

    const freshFile = path.join(cameraOneDir, 'delete-fresh.jpg');
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
        snapshot: { mode: 'delete', retentionDays: 45 },
        vacuum: { mode: 'auto', run: 'never' },
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(result.outcome?.archivedSnapshots).toBe(0);
      expect(result.outcome?.removedEvents).toBe(staleFiles.length);
      expect(result.outcome?.prunedArchives).toBe(0);
      const cameraKey = path.basename(cameraOneDir);
      expect(result.outcome?.perCamera?.[cameraKey]?.archivedSnapshots ?? 0).toBe(0);
      expect(result.vacuum.ran).toBe(false);
      expect(result.vacuum.runMode).toBe('never');

      staleFiles.forEach(file => {
        expect(fs.existsSync(file)).toBe(false);
      });
      expect(fs.existsSync(freshFile)).toBe(true);

      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall?.removedEvents).toBe(staleFiles.length);
      expect(typeof runCall?.diskSavingsBytes === 'number').toBe(true);
      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({
        removedEvents: staleFiles.length,
        archivedSnapshots: 0,
        prunedArchives: 0,
        diskSavingsBytes: expect.any(Number)
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
        },
        diskSavingsBytes: expect.any(Number)
      });
      const firstMetrics = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(firstMetrics).toMatchObject({ archivedSnapshots: 1, diskSavingsBytes: expect.any(Number) });

      vacuumSpy.mockClear();
      logger.info.mockClear();
      metrics.recordRetentionRun.mockClear();

      await vi.advanceTimersByTimeAsync(1000);
      await vi.runOnlyPendingTimersAsync();

      expect(vacuumSpy).not.toHaveBeenCalled();
      const secondInfo = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(secondInfo?.[0]).toMatchObject({
        vacuumMode: 'skipped',
        vacuumRunMode: 'on-change',
        diskSavingsBytes: expect.any(Number)
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
        },
        diskSavingsBytes: expect.any(Number)
      });
    } finally {
      task.stop();
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RetentionDisabledDoesNotReschedule stops scheduling after a disabled run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const policySpy = vi
      .spyOn(dbModule, 'applyRetentionPolicy')
      .mockReturnValue({
        removedEvents: 0,
        archivedSnapshots: 0,
        prunedArchives: 0,
        perCamera: {},
        warnings: []
      } as any);
    const baselineDisk = getDatabaseDiskUsage();
    const vacuumSpy = vi
      .spyOn(dbModule, 'vacuumDatabase')
      .mockReturnValue({
        run: 'never',
        mode: 'auto',
        analyze: false,
        reindex: false,
        optimize: false,
        target: undefined,
        pragmas: undefined,
        indexVersion: 1,
        indexVersionChanged: false,
        ensuredIndexes: [],
        disk: { before: baselineDisk, after: baselineDisk, savingsBytes: 0 },
        tables: []
      });

    const task = startRetentionTask({
      enabled: true,
      retentionDays: 30,
      intervalMs: 1000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      vacuum: { mode: 'auto', run: 'never' },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();
      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);

      logger.info.mockClear();

      task.configure({
        enabled: false,
        retentionDays: 30,
        intervalMs: 1000,
        archiveDir,
        snapshotDirs: [cameraOneDir],
        vacuum: { mode: 'auto', run: 'never' },
        logger,
        metrics: metrics as any
      });

      await vi.runOnlyPendingTimersAsync();

      expect(logger.info).toHaveBeenCalledWith({ enabled: false }, 'Retention task skipped');
      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);
    } finally {
      task.stop();
      policySpy.mockRestore();
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RetentionTaskDisableReschedule clears pending timers when disabling during a run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const baselineDisk = getDatabaseDiskUsage();
    const vacuumSpy = vi
      .spyOn(dbModule, 'vacuumDatabase')
      .mockReturnValue({
        run: 'never',
        mode: 'auto',
        analyze: false,
        reindex: false,
        optimize: false,
        target: undefined,
        pragmas: undefined,
        indexVersion: 1,
        indexVersionChanged: false,
        ensuredIndexes: [],
        disk: { before: baselineDisk, after: baselineDisk, savingsBytes: 0 },
        tables: []
      });

    let task: ReturnType<typeof startRetentionTask>;
    const policySpy = vi.spyOn(dbModule, 'applyRetentionPolicy');
    policySpy.mockImplementation(() => {
      if (task) {
        task.configure({
          enabled: false,
          retentionDays: 30,
          intervalMs: 1000,
          archiveDir,
          snapshotDirs: [cameraOneDir],
          vacuum: { mode: 'auto', run: 'never' },
          logger,
          metrics: metrics as any
        });
      }
      return {
        removedEvents: 0,
        archivedSnapshots: 0,
        prunedArchives: 0,
        perCamera: {},
        warnings: []
      } as any;
    });

    task = startRetentionTask({
      enabled: true,
      retentionDays: 30,
      intervalMs: 1000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      vacuum: { mode: 'auto', run: 'never' },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();

      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith({ enabled: false }, 'Retention task skipped');
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);
      expect(policySpy).toHaveBeenCalledTimes(1);
    } finally {
      task.stop();
      policySpy.mockRestore();
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RetentionTaskDisableDuringRun skips extra runs and resumes once re-enabled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const baselineDisk = getDatabaseDiskUsage();
    const vacuumSpy = vi
      .spyOn(dbModule, 'vacuumDatabase')
      .mockReturnValue({
        run: 'never',
        mode: 'auto',
        analyze: false,
        reindex: false,
        optimize: false,
        target: undefined,
        pragmas: undefined,
        indexVersion: 1,
        indexVersionChanged: false,
        ensuredIndexes: [],
        disk: { before: baselineDisk, after: baselineDisk, savingsBytes: 0 },
        tables: []
      });

    let task: ReturnType<typeof startRetentionTask>;
    const policySpy = vi.spyOn(dbModule, 'applyRetentionPolicy');
    policySpy.mockImplementation(() => {
      if (task) {
        task.configure({
          enabled: false,
          retentionDays: 30,
          intervalMs: 1000,
          archiveDir,
          snapshotDirs: [cameraOneDir],
          vacuum: { mode: 'auto', run: 'never' },
          logger,
          metrics: metrics as any
        });
      }
      return {
        removedEvents: 0,
        archivedSnapshots: 0,
        prunedArchives: 0,
        perCamera: {},
        warnings: []
      } as any;
    });

    task = startRetentionTask({
      enabled: true,
      retentionDays: 30,
      intervalMs: 1000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      vacuum: { mode: 'auto', run: 'never' },
      logger,
      metrics: metrics as any
    });

    try {
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();

      expect(policySpy).toHaveBeenCalledTimes(1);
      const skipCalls = logger.info.mock.calls.filter(([, message]) => message === 'Retention task skipped');
      expect(skipCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();

      expect(policySpy).toHaveBeenCalledTimes(1);

      task.configure({
        enabled: true,
        retentionDays: 30,
        intervalMs: 1000,
        archiveDir,
        snapshotDirs: [cameraOneDir],
        vacuum: { mode: 'auto', run: 'never' },
        logger,
        metrics: metrics as any
      });

      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();

      expect(policySpy).toHaveBeenCalledTimes(2);
      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(2);
    } finally {
      task.stop();
      policySpy.mockRestore();
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('DatabaseChannelIndexMaintenance validates channel index and on-change vacuum', async () => {
    const indexes = db.prepare("PRAGMA index_list('events')").all() as Array<{ name: string }>;
    const indexNames = indexes.map(entry => entry.name);
    expect(indexNames).toContain('idx_events_channel');
    expect(indexNames).toContain('idx_events_camera');
    expect(indexNames).toContain('idx_events_snapshot_path');
    expect(indexNames).toContain('idx_events_face_snapshot');

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

    const vacuumSpy = vi.spyOn(dbModule, 'vacuumDatabase');

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
      expect(vacuumSpy).toHaveBeenCalledTimes(1);

      expect(metrics.recordRetentionRun).toHaveBeenCalled();
      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({ archivedSnapshots: expect.any(Number), diskSavingsBytes: expect.any(Number) });

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
      expect(completionCall?.[0]).toMatchObject({
        vacuumRunMode: 'always',
        vacuumMode: 'full',
        diskSavingsBytes: expect.any(Number)
      });

      vacuumSpy.mockClear();

      const disabled = await runRetentionOnce({
        enabled: true,
        retentionDays: 30,
        intervalMs: 60000,
        archiveDir,
        snapshotDirs: [cameraOneDir, cameraTwoDir],
        vacuum: false,
        snapshot: { mode: 'archive', retentionDays: 10 },
        logger,
        metrics: metrics as any
      });

      expect(disabled.vacuum.ran).toBe(false);
      expect(disabled.vacuum.runMode).toBe('never');
      expect(disabled.vacuum.mode).toBe('skipped');
      expect(vacuumSpy).not.toHaveBeenCalled();
    } finally {
      vacuumSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RetentionArchiveRotation surfaces rotation warnings in results', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 2, 12);
    vi.setSystemTime(now);

    const staleFile = path.join(cameraOneDir, 'stale.jpg');
    fs.writeFileSync(staleFile, staleFile);
    fs.utimesSync(staleFile, (now - 45 * dayMs) / 1000, (now - 45 * dayMs) / 1000);

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rotation failed');
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

      expect(result.warnings.length).toBeGreaterThan(0);
      const warning = result.warnings[0];
      expect(warning?.reason).toBe('rotation failed');
      expect(warning?.path).toContain(path.basename(staleFile));
      expect(metrics.recordRetentionWarning).toHaveBeenCalledWith({
        camera: path.basename(cameraOneDir),
        path: expect.stringContaining('stale.jpg'),
        reason: 'rotation failed'
      });
    } finally {
      renameSpy.mockRestore();
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
        prunedArchives: 0,
        diskSavingsBytes: expect.any(Number)
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
        },
        diskSavingsBytes: expect.any(Number)
      });
    } finally {
      task.stop();
    }
  });

  it('RetentionVacuumErrorWarning surfaces vacuum failure without aborting the run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 3, 5);
    vi.setSystemTime(now);

    const vacuumSpy = vi.spyOn(dbModule, 'vacuumDatabase').mockImplementation(() => {
      throw new Error('vacuum exploded');
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

    try {
      const result = await runRetentionOnce({
        enabled: true,
        retentionDays: 30,
        intervalMs: 60000,
        archiveDir,
        snapshotDirs: [cameraOneDir],
        vacuum: { mode: 'auto', run: 'always' },
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(result.vacuum.ran).toBe(false);
      expect(result.vacuum.mode).toBe('auto');
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            camera: null,
            path: 'vacuum',
            reason: 'vacuum-failed'
          })
        ])
      );
      expect(metrics.recordRetentionWarning).toHaveBeenCalledWith({
        camera: null,
        path: 'vacuum',
        reason: 'vacuum-failed'
      });
      expect(metrics.recordRetentionRun).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Retention vacuum failed'
      );
    } finally {
      vacuumSpy.mockRestore();
      vi.useRealTimers();
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
      expect(infoCall?.[0]).toMatchObject({
        prunedArchives: 1,
        archivedSnapshots: 4,
        diskSavingsBytes: expect.any(Number)
      });

      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall).toMatchObject({
        removedEvents: 1,
        archivedSnapshots: 4,
        prunedArchives: 1,
        diskSavingsBytes: expect.any(Number)
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
      expect(typeof runCall?.diskSavingsBytes === 'number').toBe(true);
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
        removedEvents: 0,
        diskSavingsBytes: expect.any(Number)
      });
    } finally {
      task.stop();
      vacuumSpy.mockRestore();
    }
  });

  it('RetentionPerCameraMaxRotation prioritizes per-camera overrides over global limits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 8, 15);
    vi.setSystemTime(now);

    const camOneKey = path.basename(cameraOneDir);
    const camTwoKey = path.basename(cameraTwoDir);
    const staleTs = now - 45 * dayMs;

    const camOneFiles = [
      path.join(cameraOneDir, 'cam1-a.jpg'),
      path.join(cameraOneDir, 'cam1-b.jpg'),
      path.join(cameraOneDir, 'cam1-c.jpg')
    ];
    const camTwoFiles = [
      path.join(cameraTwoDir, 'cam2-a.jpg'),
      path.join(cameraTwoDir, 'cam2-b.jpg'),
      path.join(cameraTwoDir, 'cam2-c.jpg')
    ];

    for (const file of [...camOneFiles, ...camTwoFiles]) {
      fs.writeFileSync(file, file);
      fs.utimesSync(file, staleTs / 1000, staleTs / 1000);
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
        maxArchivesPerCamera: 2,
        snapshot: {
          mode: 'archive',
          retentionDays: 20,
          perCameraMax: {
            [camOneKey]: 1
          }
        },
        vacuum: { mode: 'auto', run: 'never' },
        logger,
        metrics: metrics as any
      });

      expect(result.skipped).toBe(false);
      expect(result.outcome).toBeDefined();
      const perCamera = result.outcome?.perCamera ?? {};
      expect(perCamera[camOneKey]).toMatchObject({
        archivedSnapshots: camOneFiles.length,
        prunedArchives: camOneFiles.length - 1
      });
      expect(perCamera[camTwoKey]).toMatchObject({
        archivedSnapshots: camTwoFiles.length,
        prunedArchives: camTwoFiles.length - 2
      });

      const runCall = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(runCall?.perCamera?.[camOneKey]?.prunedArchives).toBe(camOneFiles.length - 1);
      expect(runCall?.perCamera?.[camTwoKey]?.prunedArchives).toBe(camTwoFiles.length - 2);
      expect(typeof runCall?.diskSavingsBytes === 'number').toBe(true);

      const camOneArchives = collectArchiveFiles(path.join(archiveDir, camOneKey));
      const camTwoArchives = collectArchiveFiles(path.join(archiveDir, camTwoKey));
      expect(camOneArchives.length).toBeLessThanOrEqual(1);
      expect(camTwoArchives.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('RetentionVacuumOnChangeSummary skips idle vacuums and reports ensured indexes when pruning', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 11, 20);
    vi.setSystemTime(now);

    const cameraKey = path.basename(cameraOneDir);
    const metrics = {
      recordRetentionRun: vi.fn(),
      recordRetentionWarning: vi.fn()
    } as const;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const baseOptions = {
      enabled: true,
      retentionDays: 30,
      intervalMs: 60000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      snapshot: {
        mode: 'archive',
        retentionDays: 14,
        maxArchivesPerCamera: { [cameraKey]: 2 }
      },
      vacuum: { mode: 'auto', run: 'on-change' } as const,
      logger,
      metrics: metrics as any
    } satisfies Parameters<typeof runRetentionOnce>[0];

    try {
      const idleResult = await runRetentionOnce(baseOptions);

      expect(idleResult.vacuum.ran).toBe(false);
      expect(idleResult.vacuum.mode).toBe('skipped');
      expect(idleResult.vacuum.runMode).toBe('on-change');
      expect(idleResult.disk.savingsBytes).toBeGreaterThanOrEqual(0);
      const idleInfo = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(idleInfo?.[0]).toMatchObject({ vacuumMode: 'skipped', vacuumRunMode: 'on-change' });
      const idleMetrics = metrics.recordRetentionRun.mock.calls.at(-1)?.[0];
      expect(idleMetrics).toMatchObject({ archivedSnapshots: 0, prunedArchives: 0, diskSavingsBytes: expect.any(Number) });

      metrics.recordRetentionRun.mockClear();
      logger.info.mockClear();

      const staleTs = now - 45 * dayMs;
      const staleFiles = [
        path.join(cameraOneDir, 'summary-older-a.jpg'),
        path.join(cameraOneDir, 'summary-older-b.jpg'),
        path.join(cameraOneDir, 'summary-older-c.jpg')
      ];
      for (const file of staleFiles) {
        fs.writeFileSync(file, file);
        fs.utimesSync(file, staleTs / 1000, staleTs / 1000);
      }

      const archiveRoot = path.join(archiveDir, cameraKey, formatArchiveDate(staleTs - dayMs));
      fs.mkdirSync(archiveRoot, { recursive: true });
      const existingArchives = [
        path.join(archiveRoot, 'existing-a.jpg'),
        path.join(archiveRoot, 'existing-b.jpg'),
        path.join(archiveRoot, 'existing-c.jpg')
      ];
      for (const existing of existingArchives) {
        fs.writeFileSync(existing, existing);
        fs.utimesSync(existing, (staleTs - 2 * dayMs) / 1000, (staleTs - 2 * dayMs) / 1000);
      }

      db.exec("DROP INDEX IF EXISTS idx_events_ts");

      const changedResult = await runRetentionOnce(baseOptions);

      expect(changedResult.vacuum.ran).toBe(true);
      expect(changedResult.vacuum.mode).toBe('auto');
      expect(changedResult.vacuum.runMode).toBe('on-change');
      expect(Array.isArray(changedResult.vacuum.ensuredIndexes)).toBe(true);
      expect(changedResult.vacuum.ensuredIndexes).toContain('idx_events_ts');
      expect(typeof changedResult.vacuum.disk?.savingsBytes).toBe('number');
      expect(changedResult.disk.savingsBytes).toBeGreaterThanOrEqual(0);

      const perCamera = changedResult.outcome?.perCamera?.[cameraKey];
      expect(perCamera?.archivedSnapshots).toBe(staleFiles.length);
      expect(perCamera?.prunedArchives).toBeGreaterThanOrEqual(existingArchives.length);

      const archivedFiles = collectArchiveFiles(path.join(archiveDir, cameraKey));
      expect(archivedFiles.length).toBeLessThanOrEqual(2);

      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);
      const runCall = metrics.recordRetentionRun.mock.calls[0]?.[0];
      expect(runCall).toMatchObject({
        archivedSnapshots: staleFiles.length,
        prunedArchives: expect.any(Number),
        diskSavingsBytes: changedResult.disk.savingsBytes
      });
      expect(runCall?.perCamera?.[cameraKey]?.prunedArchives).toBeGreaterThanOrEqual(existingArchives.length);

      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({
        vacuumMode: 'auto',
        vacuumRunMode: 'on-change',
        vacuumTasks: expect.objectContaining({ analyze: false, reindex: false, optimize: false }),
        diskSavingsBytes: changedResult.disk.savingsBytes,
        perCamera: expect.objectContaining({ [cameraKey]: expect.any(Object) })
      });
    } finally {
      vi.useRealTimers();
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

  it('RetentionTimerUnref detaches scheduled timers when retention is disabled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    type FakeTimer = {
      callback: (...args: any[]) => unknown;
      args: any[];
      delay: number;
      active: boolean;
      ref: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };

    const timers: FakeTimer[] = [];
    const setTimeoutSpy = vi
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        const entry: FakeTimer = {
          callback,
          args,
          delay: typeof delay === 'number' ? delay : 0,
          active: true,
          ref: vi.fn(),
          unref: vi.fn()
        };
        entry.ref.mockReturnValue(entry as unknown as NodeJS.Timeout);
        entry.unref.mockReturnValue(entry as unknown as NodeJS.Timeout);
        timers.push(entry);
        return entry as unknown as NodeJS.Timeout;
      }) as any);
    const clearTimeoutSpy = vi
      .spyOn(global, 'clearTimeout')
      .mockImplementation(((handle: any) => {
        if (handle && typeof handle === 'object') {
          handle.active = false;
        }
      }) as any);

    const runDeferred = createDeferred<void>();
    const skipDeferred = createDeferred<void>();

    const metrics = {
      recordRetentionRun: vi.fn(() => runDeferred.resolve()),
      recordRetentionWarning: vi.fn()
    };
    const logger = {
      info: vi.fn((_payload: unknown, message: string) => {
        if (message === 'Retention task skipped') {
          skipDeferred.resolve();
        }
      }),
      warn: vi.fn(),
      error: vi.fn()
    };

    const baseOptions = {
      retentionDays: 1,
      intervalMs: 60_000,
      archiveDir,
      snapshotDirs: [cameraOneDir],
      vacuum: false as const
    };

    const task = startRetentionTask({
      ...baseOptions,
      enabled: true,
      logger,
      metrics: metrics as any
    });

    try {
      expect(timers).toHaveLength(1);
      const initialTimer = timers.shift();
      if (!initialTimer) {
        throw new Error('Expected initial retention timer');
      }
      expect(initialTimer.unref).toHaveBeenCalledTimes(1);

      initialTimer.callback(...initialTimer.args);
      await runDeferred.promise;

      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);

      await Promise.resolve();

      expect(timers.length).toBeGreaterThan(0);
      const intervalTimer = timers.shift();
      if (!intervalTimer) {
        throw new Error('Expected interval retention timer');
      }
      expect(intervalTimer.unref).toHaveBeenCalledTimes(1);

      task.configure({ ...baseOptions, enabled: false });

      expect(clearTimeoutSpy).toHaveBeenCalledWith(intervalTimer);

      expect(timers.length).toBeGreaterThan(0);
      const restoreTimer = timers.shift();
      if (!restoreTimer) {
        throw new Error('Expected restore retention timer');
      }
      expect(restoreTimer.unref).toHaveBeenCalledTimes(1);

      restoreTimer.callback(...restoreTimer.args);
      await skipDeferred.promise;

      expect(metrics.recordRetentionRun).toHaveBeenCalledTimes(1);
      expect(metrics.recordRetentionWarning).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith({ enabled: false }, 'Retention task skipped');
      expect(timers).toHaveLength(0);
    } finally {
      task.stop();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe('DbMaintenance', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('DbMaintenanceSkipWhenDisabled', async () => {
    vi.resetModules();
    const buildRetentionOptions = vi.fn().mockReturnValue(null);
    const runRetentionOnce = vi.fn();

    vi.doMock('../src/run-guard.js', () => ({ buildRetentionOptions }));
    vi.doMock('../src/tasks/retention.js', () => ({ runRetentionOnce }));

    const { runMaintenance } = await import('../scripts/db-maintenance.ts');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runMaintenance({
      config: { events: {}, video: {}, person: {} } as any,
      logger
    });

    expect(result).toEqual({ skipped: true, options: null, result: null });
    expect(buildRetentionOptions).toHaveBeenCalledTimes(1);
    expect(runRetentionOnce).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Guardian maintenance starting');
    expect(logger.info).toHaveBeenCalledWith('Retention maintenance skipped (retention disabled)');
  });

  it('DbMaintenanceRunSummarizesOutcome', async () => {
    vi.resetModules();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const retentionOptions = {
      enabled: true,
      retentionDays: 7,
      intervalMs: 60000,
      archiveDir: '/tmp/archive',
      snapshotDirs: ['./snapshots'],
      vacuum: 'auto',
      snapshot: { mode: 'archive', retentionDays: 3 },
      logger
    } as any;
    const buildRetentionOptions = vi.fn().mockReturnValue(retentionOptions);
    const retentionResult = {
      skipped: false,
      warnings: [{ path: '/tmp/archive/file', error: new Error('warn'), camera: 'snap' }],
      outcome: {
        removedEvents: 2,
        archivedSnapshots: 3,
        prunedArchives: 1,
        warnings: [],
        perCamera: { snap: { archivedSnapshots: 2, prunedArchives: 1 } }
      },
      vacuum: {
        ran: true,
        runMode: 'on-change',
        mode: 'auto',
        analyze: true,
        reindex: false,
        optimize: true,
        target: 'events',
        pragmas: ['auto_vacuum'],
        disk: {
          before: { pages: 10, pageSize: 4096, sizeBytes: 40960 },
          after: { pages: 9, pageSize: 4096, sizeBytes: 36864 },
          savingsBytes: 4096
        }
      },
      rescheduled: false,
      disk: {
        before: { pages: 10, pageSize: 4096, sizeBytes: 40960 },
        after: { pages: 9, pageSize: 4096, sizeBytes: 36864 },
        savingsBytes: 4096
      }
    } as any;
    const runRetentionOnce = vi.fn().mockResolvedValue(retentionResult);

    vi.doMock('../src/run-guard.js', () => ({ buildRetentionOptions }));
    vi.doMock('../src/tasks/retention.js', () => ({ runRetentionOnce }));

    const { runMaintenance } = await import('../scripts/db-maintenance.ts');

    const result = await runMaintenance({
      config: {
        events: { retention: { enabled: true } },
        video: { channels: {} },
        person: {}
      } as any,
      logger
    });

    expect(result.skipped).toBe(false);
    expect(result.options).toBe(retentionOptions);
    expect(result.result).toBe(retentionResult);
    expect(buildRetentionOptions).toHaveBeenCalledWith(
      expect.objectContaining({ retention: expect.anything(), video: expect.anything(), person: expect.anything() })
    );
    expect(runRetentionOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveDir: '/tmp/archive',
        snapshotDirs: retentionOptions.snapshotDirs,
        metrics: expect.any(Object)
      })
    );

    expect(logger.info).toHaveBeenCalledWith('Guardian maintenance starting');

    const summaryCall = logger.info.mock.calls.find(([, message]) => message === 'Database retention completed');
    expect(summaryCall?.[0]).toMatchObject({
      removedEvents: 2,
      archivedSnapshots: 3,
      prunedArchives: 1,
      warnings: 1,
      diskSavingsBytes: 4096,
      snapshotDirs: [path.resolve('./snapshots')]
    });

    const vacuumCall = logger.info.mock.calls.find(([, message]) => message === 'VACUUM completed');
    expect(vacuumCall?.[0]).toMatchObject({ vacuum: retentionResult.vacuum });
    expect(logger.warn).toHaveBeenCalledWith({ warning: retentionResult.warnings[0] }, 'Retention maintenance warning');
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

