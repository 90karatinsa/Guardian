import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import db, { applyRetentionPolicy, clearEvents, storeEvent } from '../src/db.js';
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
  });

  it('removes database records older than retention and archives snapshots', () => {
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
    const recentSnapshot = path.join(snapshotDir, 'recent.jpg');
    fs.writeFileSync(oldSnapshot, 'old');
    fs.writeFileSync(recentSnapshot, 'recent');
    fs.utimesSync(oldSnapshot, now / 1000 - 40 * 24 * 60 * 60, now / 1000 - 40 * 24 * 60 * 60);
    fs.utimesSync(recentSnapshot, now / 1000 - 5 * 24 * 60 * 60, now / 1000 - 5 * 24 * 60 * 60);

    const outcome = applyRetentionPolicy({
      retentionDays: 30,
      snapshotDir,
      archiveDir,
      now
    });

    const row = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    expect(row.count).toBe(1);
    expect(outcome.removedEvents).toBe(1);
    expect(outcome.archivedSnapshots).toBe(1);

    expect(fs.existsSync(path.join(archiveDir, 'old.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'old.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'recent.jpg'))).toBe(true);
  });
});
