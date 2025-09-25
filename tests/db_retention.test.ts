import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { applyRetentionPolicy, clearEvents, storeEvent, vacuumDatabase } from '../src/db.js';
import { startRetentionTask } from '../src/tasks/retention.js';
import { EventRecord } from '../src/types.js';

describe('EventRetention', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  let tempDir: string;
  let snapshotDir: string;
  let archiveDir: string;

  beforeEach(() => {
    clearEvents();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-retention-'));
    snapshotDir = path.join(tempDir, 'snapshots');
    archiveDir = path.join(tempDir, 'archive');
    fs.mkdirSync(snapshotDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('RetentionVacuumRotation rotates snapshots and enforces maintenance order', () => {
    const now = Date.UTC(2024, 0, 31);
    const recentEvent: EventRecord = {
      ts: now - 5 * dayMs,
      source: 'sensor:1',
      detector: 'detector',
      severity: 'info',
      message: 'keep',
      meta: {}
    };
    const oldEvent: EventRecord = {
      ts: now - 40 * dayMs,
      source: 'sensor:1',
      detector: 'detector',
      severity: 'info',
      message: 'remove',
      meta: {}
    };

    storeEvent(recentEvent);
    storeEvent(oldEvent);

    const oldSnapshot = path.join(snapshotDir, 'old.jpg');
    const olderSnapshot = path.join(snapshotDir, 'older.jpg');
    const recentSnapshot = path.join(snapshotDir, 'recent.jpg');
    fs.writeFileSync(oldSnapshot, 'old');
    fs.writeFileSync(olderSnapshot, 'older');
    fs.writeFileSync(recentSnapshot, 'recent');
    fs.utimesSync(oldSnapshot, now / 1000 - 40 * 24 * 60 * 60, now / 1000 - 40 * 24 * 60 * 60);
    fs.utimesSync(olderSnapshot, now / 1000 - 50 * 24 * 60 * 60, now / 1000 - 50 * 24 * 60 * 60);
    fs.utimesSync(recentSnapshot, now / 1000 - 5 * 24 * 60 * 60, now / 1000 - 5 * 24 * 60 * 60);

    const outcome = applyRetentionPolicy({
      retentionDays: 30,
      snapshotDir,
      archiveDir,
      maxArchivesPerCamera: 1,
      snapshot: { mode: 'archive', retentionDays: 35 },
      now
    });

    const row = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    expect(row.count).toBe(1);
    expect(outcome.removedEvents).toBe(1);
    expect(outcome.archivedSnapshots).toBe(2);
    expect(outcome.prunedArchives).toBe(1);
    expect(outcome.warnings).toHaveLength(0);

    const archiveRoots = fs.readdirSync(archiveDir);
    expect(archiveRoots).toContain(path.basename(snapshotDir));
    const cameraRoot = path.join(archiveDir, path.basename(snapshotDir));
    const datedFolders = fs.readdirSync(cameraRoot);
    expect(datedFolders).toHaveLength(1);
    const datedDir = path.join(cameraRoot, datedFolders[0]);
    expect(fs.statSync(datedDir).isDirectory()).toBe(true);
    const nestedFiles = fs.readdirSync(datedDir);
    expect(nestedFiles).toContain('old.jpg');
    expect(nestedFiles).not.toContain('older.jpg');
    expect(fs.existsSync(path.join(snapshotDir, 'old.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'older.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'recent.jpg'))).toBe(true);

    const execSpy = vi.spyOn(db, 'exec');
    vacuumDatabase({
      mode: 'full',
      analyze: true,
      reindex: true,
      optimize: true,
      target: 'main',
      pragmas: ['PRAGMA incremental_vacuum']
    });

    expect(execSpy.mock.calls.map(call => call[0])).toEqual([
      'PRAGMA wal_checkpoint(TRUNCATE)',
      'REINDEX',
      'ANALYZE',
      'VACUUM main',
      'PRAGMA optimize',
      'PRAGMA incremental_vacuum'
    ]);
    execSpy.mockRestore();
  });

  it('RetentionScheduler prunes events and triggers vacuum maintenance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 1, 1);
    vi.setSystemTime(now);

    const staleEvent: EventRecord = {
      ts: now - 60 * dayMs,
      source: 'sensor:old',
      detector: 'motion',
      severity: 'warning',
      message: 'too old',
      meta: { snapshot: path.join(snapshotDir, 'stale.jpg') }
    };
    const recentEvent: EventRecord = {
      ts: now - 5 * dayMs,
      source: 'sensor:keep',
      detector: 'motion',
      severity: 'info',
      message: 'keep me',
      meta: { channel: 'video:keep' }
    };

    storeEvent(staleEvent);
    storeEvent(recentEvent);

    const stalePath = path.join(snapshotDir, 'stale.jpg');
    fs.writeFileSync(stalePath, 'snapshot');
    fs.utimesSync(stalePath, (now - 60 * dayMs) / 1000, (now - 60 * dayMs) / 1000);

    const execSpy = vi.spyOn(db, 'exec');
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
      snapshotDirs: [snapshotDir],
      maxArchivesPerCamera: 5,
      vacuumMode: 'full',
      logger
    });

    try {
      await vi.runOnlyPendingTimersAsync();

      const remaining = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
      expect(remaining.count).toBe(1);

      expect(execSpy).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
      expect(execSpy).toHaveBeenCalledWith('VACUUM');

      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({
        removedEvents: 1,
        archivedSnapshots: 1,
        prunedArchives: 0,
        vacuumMode: 'full',
        vacuumTasks: {
          analyze: false,
          reindex: false,
          optimize: false,
          target: undefined
        }
      });
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      task.stop();
    }
  });

  it('RetentionScheduler skips vacuum when nothing is pruned', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.UTC(2024, 2, 1);
    vi.setSystemTime(now);

    const recentEvent: EventRecord = {
      ts: now - 2 * dayMs,
      source: 'sensor:fresh',
      detector: 'motion',
      severity: 'info',
      message: 'still fresh',
      meta: {}
    };

    storeEvent(recentEvent);

    const execSpy = vi.spyOn(db, 'exec');
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
      snapshotDirs: [snapshotDir],
      maxArchivesPerCamera: 2,
      vacuumMode: 'full',
      logger
    });

    try {
      await vi.runOnlyPendingTimersAsync();

      const infoCall = logger.info.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(infoCall?.[0]).toMatchObject({
        removedEvents: 0,
        archivedSnapshots: 0,
        prunedArchives: 0,
        vacuumMode: 'skipped'
      });
      expect(execSpy).not.toHaveBeenCalledWith('VACUUM');
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      task.stop();
    }
  });
});
