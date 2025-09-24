import Database from 'better-sqlite3';
import config from 'config';
import fs from 'node:fs';
import path from 'node:path';
import { EventRecord, EventSeverity } from './types.js';

const dbPath = config.get<string>('database.path');
const directory = path.dirname(dbPath);
fs.mkdirSync(directory, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    detector TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_source_detector ON events (source, detector);
`);

const insertStatement = db.prepare(
  'INSERT INTO events (ts, source, detector, severity, message, meta) VALUES (@ts, @source, @detector, @severity, @message, @meta)'
);

const deleteOlderThanStatement = db.prepare('DELETE FROM events WHERE ts < @cutoff');

type EventRow = {
  id: number;
  ts: number;
  source: string;
  detector: string;
  severity: string;
  message: string;
  meta: string | null;
};

export type EventRecordWithId = EventRecord & { id: number };

export interface ListEventsOptions {
  limit?: number;
  offset?: number;
  detector?: string;
  source?: string;
  channel?: string;
  camera?: string;
  severity?: EventSeverity;
  since?: number;
  until?: number;
}

export interface PaginatedEvents {
  items: EventRecordWithId[];
  total: number;
}

export function storeEvent(event: EventRecord) {
  insertStatement.run({
    ts: event.ts,
    source: event.source,
    detector: event.detector,
    severity: event.severity,
    message: event.message,
    meta: event.meta ? JSON.stringify(event.meta) : null
  });
}

export function listEvents(options: ListEventsOptions = {}): PaginatedEvents {
  const filters: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.detector) {
    filters.push('detector = @detector');
    params.detector = options.detector;
  }

  if (options.source) {
    filters.push('source = @source');
    params.source = options.source;
  }

  if (options.channel) {
    filters.push("json_extract(meta, '$.channel') = @channel");
    params.channel = options.channel;
  }

  if (options.camera) {
    filters.push(
      "(source = @camera OR json_extract(meta, '$.camera') = @camera OR json_extract(meta, '$.channel') = @camera)"
    );
    params.camera = options.camera;
  }

  if (options.severity) {
    filters.push('severity = @severity');
    params.severity = options.severity;
  }

  if (typeof options.since === 'number') {
    filters.push('ts >= @since');
    params.since = options.since;
  }

  if (typeof options.until === 'number') {
    filters.push('ts <= @until');
    params.until = options.until;
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  const query = `
    SELECT id, ts, source, detector, severity, message, meta
    FROM events
    ${whereClause}
    ORDER BY ts DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;

  const totalQuery = `SELECT COUNT(*) AS count FROM events ${whereClause}`;

  const rows = db.prepare(query).all({ ...params, limit, offset }) as EventRow[];
  const totalRow = db.prepare(totalQuery).get(params) as { count?: number } | undefined;

  return {
    items: rows.map(row => mapRow(row)),
    total: typeof totalRow?.count === 'number' ? totalRow.count : 0
  };
}

export function getEventById(id: number): EventRecordWithId | null {
  const row = db
    .prepare('SELECT id, ts, source, detector, severity, message, meta FROM events WHERE id = ?')
    .get(id) as EventRow | undefined;

  if (!row) {
    return null;
  }

  return mapRow(row);
}

export function clearEvents() {
  db.prepare('DELETE FROM events').run();
}

export function pruneEventsOlderThan(cutoffTs: number): number {
  const result = deleteOlderThanStatement.run({ cutoff: cutoffTs });
  return typeof result.changes === 'number' ? result.changes : 0;
}

export type VacuumMode = 'auto' | 'full';

export interface RetentionPolicyOptions {
  retentionDays: number;
  snapshotDir?: string;
  snapshotDirs?: string[];
  archiveDir: string;
  maxArchivesPerCamera?: number;
  now?: number;
}

export interface RetentionOutcome {
  removedEvents: number;
  archivedSnapshots: number;
  prunedArchives: number;
  warnings: Array<{ path: string; error: Error }>;
}

export function applyRetentionPolicy(options: RetentionPolicyOptions): RetentionOutcome {
  const { retentionDays, archiveDir } = options;
  const now = options.now ?? Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffTs = now - retentionMs;

  const removedEvents = pruneEventsOlderThan(cutoffTs);
  const directories = collectSnapshotDirectories(options);
  let archivedSnapshots = 0;
  let prunedArchives = 0;
  const warnings: Array<{ path: string; error: Error }> = [];

  for (const { sourceDir, archiveBase } of directories) {
    const rotation = rotateSnapshots(sourceDir, archiveBase, cutoffTs, options.maxArchivesPerCamera);
    archivedSnapshots += rotation.moved;
    prunedArchives += rotation.pruned;
    warnings.push(...rotation.warnings);
  }

  return { removedEvents, archivedSnapshots, prunedArchives, warnings };
}

export function vacuumDatabase(mode: VacuumMode = 'auto') {
  if (mode === 'full') {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  db.exec('VACUUM');
}

type SnapshotDirectory = {
  sourceDir: string;
  archiveBase: string;
};

function collectSnapshotDirectories(options: RetentionPolicyOptions): SnapshotDirectory[] {
  const directories = new Map<string, SnapshotDirectory>();

  const addDirectory = (dir: string | undefined) => {
    if (!dir) {
      return;
    }
    const resolved = path.resolve(dir);
    if (!directories.has(resolved)) {
      directories.set(resolved, {
        sourceDir: resolved,
        archiveBase: path.resolve(options.archiveDir)
      });
    }
  };

  addDirectory(options.snapshotDir);

  for (const dir of options.snapshotDirs ?? []) {
    addDirectory(dir);
  }

  return [...directories.values()];
}

type RotationOutcome = {
  moved: number;
  pruned: number;
  warnings: Array<{ path: string; error: Error }>;
};

function rotateSnapshots(
  snapshotDir: string,
  archiveDir: string,
  cutoffTs: number,
  maxArchivesPerCamera?: number
): RotationOutcome {
  if (!fs.existsSync(snapshotDir)) {
    return { moved: 0, pruned: 0, warnings: [] };
  }

  fs.mkdirSync(archiveDir, { recursive: true });

  const entries = fs.readdirSync(snapshotDir);
  let moved = 0;
  const warnings: Array<{ path: string; error: Error }> = [];

  for (const entry of entries) {
    const sourcePath = path.join(snapshotDir, entry);
    if (path.resolve(sourcePath) === path.resolve(archiveDir)) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(sourcePath);
    } catch (error) {
      warnings.push({ path: sourcePath, error: toError(error) });
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (stats.mtimeMs >= cutoffTs) {
      continue;
    }

    try {
      const archivePath = buildArchivePath(archiveDir, snapshotDir, stats.mtimeMs);
      const targetPath = ensureUniqueArchivePath(archivePath, entry);
      fs.renameSync(sourcePath, targetPath);
      moved += 1;
    } catch (error) {
      warnings.push({ path: sourcePath, error: toError(error) });
    }
  }

  let pruned = 0;
  if (typeof maxArchivesPerCamera === 'number' && maxArchivesPerCamera >= 0) {
    try {
      pruned = pruneArchiveLimit(archiveDir, snapshotDir, maxArchivesPerCamera);
    } catch (error) {
      warnings.push({ path: path.join(archiveDir, path.basename(snapshotDir)), error: toError(error) });
    }
  }

  return { moved, pruned, warnings };
}

function buildArchivePath(archiveDir: string, snapshotDir: string, mtimeMs: number): string {
  const dateFolder = formatArchiveDate(mtimeMs);
  const cameraFolder = path.basename(snapshotDir);
  const targetDir = path.join(archiveDir, cameraFolder, dateFolder);
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

function pruneArchiveLimit(archiveDir: string, snapshotDir: string, limit: number): number {
  const cameraRoot = path.join(archiveDir, path.basename(snapshotDir));
  if (!fs.existsSync(cameraRoot)) {
    return 0;
  }

  const files = collectArchiveFiles(cameraRoot);
  if (files.length <= limit) {
    return 0;
  }

  const sorted = files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const excess = sorted.slice(Math.max(limit, 0));
  let removed = 0;

  for (const file of excess) {
    try {
      fs.rmSync(file.path, { force: true });
      removed += 1;
    } catch (error) {
      throw toError(error);
    }
  }

  cleanupEmptyDirectories(cameraRoot);
  return removed;
}

function collectArchiveFiles(root: string): Array<{ path: string; mtimeMs: number }> {
  const results: Array<{ path: string; mtimeMs: number }> = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current);
    for (const entry of entries) {
      const resolved = path.join(current, entry);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(resolved);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(resolved);
      } else if (stats.isFile()) {
        results.push({ path: resolved, mtimeMs: stats.mtimeMs });
      }
    }
  }

  return results;
}

function cleanupEmptyDirectories(root: string) {
  const stack: string[] = [root];
  const visited: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    visited.push(current);
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }

  for (const dir of visited.sort((a, b) => b.length - a.length)) {
    if (dir === root) {
      continue;
    }
    try {
      const contents = fs.readdirSync(dir);
      if (contents.length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // ignore
    }
  }
}

function toError(input: unknown): Error {
  if (input instanceof Error) {
    return input;
  }
  return new Error(typeof input === 'string' ? input : JSON.stringify(input));
}

function ensureUniqueArchivePath(directory: string, filename: string): string {
  let candidate = path.join(directory, filename);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  const parsed = path.parse(filename);
  let index = 1;
  while (true) {
    const nextName = `${parsed.name}-${index}${parsed.ext}`;
    candidate = path.join(directory, nextName);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function formatArchiveDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapRow(row: EventRow): EventRecordWithId {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source,
    detector: row.detector,
    severity: row.severity as EventSeverity,
    message: row.message,
    meta: row.meta ? safeParseMeta(row.meta) : undefined
  };
}

function safeParseMeta(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    // ignore parsing errors and fall through
  }
  return undefined;
}

function clampLimit(limit?: number) {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 25;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 100);
}

function clampOffset(offset?: number) {
  if (typeof offset !== 'number' || Number.isNaN(offset)) {
    return 0;
  }
  return Math.max(Math.floor(offset), 0);
}

export default db;
