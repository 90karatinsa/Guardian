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

export interface RetentionPolicyOptions {
  retentionDays: number;
  snapshotDir: string;
  archiveDir: string;
  now?: number;
}

export interface RetentionOutcome {
  removedEvents: number;
  archivedSnapshots: number;
}

export function applyRetentionPolicy(options: RetentionPolicyOptions): RetentionOutcome {
  const { retentionDays, snapshotDir, archiveDir } = options;
  const now = options.now ?? Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffTs = now - retentionMs;

  const removedEvents = pruneEventsOlderThan(cutoffTs);
  const archivedSnapshots = rotateSnapshots(snapshotDir, archiveDir, cutoffTs);

  return { removedEvents, archivedSnapshots };
}

export function vacuumDatabase() {
  db.exec('VACUUM');
}

function rotateSnapshots(snapshotDir: string, archiveDir: string, cutoffTs: number): number {
  if (!fs.existsSync(snapshotDir)) {
    return 0;
  }

  fs.mkdirSync(archiveDir, { recursive: true });

  const entries = fs.readdirSync(snapshotDir);
  let moved = 0;

  for (const entry of entries) {
    const sourcePath = path.join(snapshotDir, entry);
    if (path.resolve(sourcePath) === path.resolve(archiveDir)) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(sourcePath);
    } catch (error) {
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (stats.mtimeMs >= cutoffTs) {
      continue;
    }

    const targetPath = ensureUniqueArchivePath(archiveDir, entry);
    fs.renameSync(sourcePath, targetPath);
    moved += 1;
  }

  return moved;
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
