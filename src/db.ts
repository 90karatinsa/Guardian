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
  );

  CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    embedding TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_source_detector ON events (source, detector);
  CREATE INDEX IF NOT EXISTS idx_events_channel ON events (json_extract(meta, '$.channel'));
  CREATE INDEX IF NOT EXISTS idx_faces_label ON faces (label);
`);

const insertStatement = db.prepare(
  'INSERT INTO events (ts, source, detector, severity, message, meta) VALUES (@ts, @source, @detector, @severity, @message, @meta)'
);

const deleteOlderThanStatement = db.prepare('DELETE FROM events WHERE ts < @cutoff');

const insertFaceStatement = db.prepare(
  'INSERT INTO faces (label, embedding, metadata, created_at) VALUES (@label, @embedding, @metadata, @createdAt)'
);

const listFacesStatement = db.prepare('SELECT id, label, embedding, metadata, created_at AS createdAt FROM faces');

const getFaceStatement = db.prepare('SELECT id, label, embedding, metadata, created_at AS createdAt FROM faces WHERE id = @id');

const deleteFaceStatement = db.prepare('DELETE FROM faces WHERE id = @id');

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

type FaceRow = {
  id: number;
  label: string;
  embedding: string;
  metadata: string | null;
  createdAt: number;
};

export type FaceRecord = {
  id: number;
  label: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  createdAt: number;
};

export interface ListEventsOptions {
  limit?: number;
  offset?: number;
  detector?: string;
  source?: string;
  channel?: string;
  channels?: string[];
  camera?: string;
  severity?: EventSeverity;
  since?: number;
  until?: number;
  search?: string;
  snapshot?: 'with' | 'without';
}

export interface PaginatedEvents {
  items: EventRecordWithId[];
  total: number;
}

export interface FaceMatchResult {
  face: FaceRecord;
  distance: number;
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

export interface StoreFaceOptions {
  label: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export function storeFace(options: StoreFaceOptions): FaceRecord {
  const embedding = JSON.stringify(options.embedding);
  insertFaceStatement.run({
    label: options.label,
    embedding,
    metadata: options.metadata ? JSON.stringify(options.metadata) : null,
    createdAt: options.createdAt ?? Date.now()
  });

  const row = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  const fetched = getFaceStatement.get({ id: row.id }) as FaceRow | undefined;
  if (!fetched) {
    throw new Error('Failed to insert face record');
  }
  return mapFaceRow(fetched);
}

export function listFaces(): FaceRecord[] {
  const rows = listFacesStatement.all() as FaceRow[];
  return rows.map(row => mapFaceRow(row));
}

export function deleteFace(id: number): boolean {
  const result = deleteFaceStatement.run({ id });
  return typeof result.changes === 'number' && result.changes > 0;
}

export function findNearestFace(embedding: number[], threshold: number): FaceMatchResult | null {
  const faces = listFaces();
  if (faces.length === 0) {
    return null;
  }

  const normalized = normalizeEmbedding(embedding);
  let best: FaceMatchResult | null = null;

  for (const face of faces) {
    const distance = euclideanDistance(normalized, face.embedding);
    if (best === null || distance < best.distance) {
      best = { face, distance };
    }
  }

  if (!best || best.distance > threshold) {
    return null;
  }

  return best;
}

export function listEvents(options: ListEventsOptions = {}): PaginatedEvents {
  const filters: string[] = [];
  const params: Record<string, unknown> = {};

  const channelFilters = collectChannelFilters(options);
  if (channelFilters.length === 1) {
    filters.push("json_extract(meta, '$.channel') = @channel0");
    params.channel0 = channelFilters[0];
  } else if (channelFilters.length > 1) {
    const placeholders = channelFilters.map((_, index) => `@channel${index}`);
    filters.push(`json_extract(meta, '$.channel') IN (${placeholders.join(', ')})`);
    channelFilters.forEach((value, index) => {
      params[`channel${index}`] = value;
    });
  }

  if (options.detector) {
    filters.push('detector = @detector');
    params.detector = options.detector;
  }

  if (options.source) {
    filters.push('source = @source');
    params.source = options.source;
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

  if (options.search) {
    filters.push(
      `(
        LOWER(message) LIKE @search ESCAPE '\\' OR
        LOWER(detector) LIKE @search ESCAPE '\\' OR
        LOWER(source) LIKE @search ESCAPE '\\'
      )`
    );
    params.search = `%${escapeLike(options.search.toLowerCase())}%`;
  }

  if (options.snapshot === 'with') {
    filters.push("COALESCE(json_extract(meta, '$.snapshot'), '') <> ''");
  } else if (options.snapshot === 'without') {
    filters.push("COALESCE(json_extract(meta, '$.snapshot'), '') = ''");
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

export function clearFaces() {
  db.prepare('DELETE FROM faces').run();
}

export type VacuumMode = 'auto' | 'full';

export type SnapshotRotationMode = 'archive' | 'delete' | 'ignore';

export interface SnapshotRotationOptions {
  mode?: SnapshotRotationMode;
  retentionDays?: number;
  perCameraMax?: Record<string, number>;
}

export interface VacuumOptions {
  mode?: VacuumMode;
  target?: string;
  analyze?: boolean;
  reindex?: boolean;
  optimize?: boolean;
  pragmas?: string[];
  run?: 'always' | 'on-change';
}

export interface RetentionPolicyOptions {
  retentionDays: number;
  snapshotDir?: string;
  snapshotDirs?: string[];
  archiveDir: string;
  maxArchivesPerCamera?: number;
  snapshot?: SnapshotRotationOptions;
  now?: number;
}

export interface RetentionOutcome {
  removedEvents: number;
  archivedSnapshots: number;
  prunedArchives: number;
  warnings: Array<{ path: string; error: Error; camera: string }>;
  perCamera: Record<string, { archivedSnapshots: number; prunedArchives: number }>;
}

export function applyRetentionPolicy(options: RetentionPolicyOptions): RetentionOutcome {
  const { retentionDays, archiveDir } = options;
  const now = options.now ?? Date.now();
  const retentionMs = Math.max(retentionDays, 0) * 24 * 60 * 60 * 1000;
  const cutoffTs = now - retentionMs;

  const removedEvents = pruneEventsOlderThan(cutoffTs);
  const snapshotOptions = normalizeSnapshotOptions(options, now);
  const directories = snapshotOptions.mode === 'ignore' ? [] : collectSnapshotDirectories(options);
  let archivedSnapshots = 0;
  let prunedArchives = 0;
  const perCamera: Record<string, { archivedSnapshots: number; prunedArchives: number }> = {};
  const warnings: Array<{ path: string; error: Error; camera: string }> = [];

  for (const { sourceDir, archiveBase } of directories) {
    const cameraId = path.basename(sourceDir);
    const perCameraLimit = snapshotOptions.perCameraMax?.[cameraId];
    const resolvedLimit =
      typeof perCameraLimit === 'number' && Number.isFinite(perCameraLimit)
        ? Math.max(0, Math.floor(perCameraLimit))
        : options.maxArchivesPerCamera;
    const rotation = rotateSnapshots(
      sourceDir,
      archiveBase,
      snapshotOptions.cutoffTs,
      snapshotOptions.mode,
      resolvedLimit,
      cameraId
    );
    archivedSnapshots += rotation.moved;
    prunedArchives += rotation.pruned;
    warnings.push(...rotation.warnings);
    const cameraStats = perCamera[cameraId] ?? { archivedSnapshots: 0, prunedArchives: 0 };
    cameraStats.archivedSnapshots += rotation.moved;
    cameraStats.prunedArchives += rotation.pruned;
    perCamera[cameraId] = cameraStats;
  }

  return { removedEvents, archivedSnapshots, prunedArchives, warnings, perCamera };
}

export function vacuumDatabase(options: VacuumOptions | VacuumMode = 'auto') {
  const normalized = normalizeVacuumOptions(options);
  const { run: _run, ...vacuum } = normalized;

  if (vacuum.mode === 'full') {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  if (vacuum.reindex) {
    db.exec('REINDEX');
  }

  if (vacuum.analyze) {
    db.exec('ANALYZE');
  }

  const target = vacuum.target ? ` ${vacuum.target}` : '';
  db.exec(`VACUUM${target}`.trim());

  if (vacuum.optimize) {
    db.exec('PRAGMA optimize');
  }

  for (const pragma of vacuum.pragmas ?? []) {
    const trimmed = typeof pragma === 'string' ? pragma.trim() : '';
    if (trimmed) {
      db.exec(trimmed);
    }
  }
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
  warnings: Array<{ path: string; error: Error; camera: string }>;
};

function rotateSnapshots(
  snapshotDir: string,
  archiveDir: string,
  cutoffTs: number,
  mode: SnapshotRotationMode,
  maxArchivesPerCamera: number | undefined,
  cameraId: string
): RotationOutcome {
  if (mode === 'ignore' || !fs.existsSync(snapshotDir)) {
    return { moved: 0, pruned: 0, warnings: [] };
  }

  if (mode === 'archive') {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const entries = fs.readdirSync(snapshotDir);
  let moved = 0;
  const warnings: Array<{ path: string; error: Error; camera: string }> = [];

  for (const entry of entries) {
    const sourcePath = path.join(snapshotDir, entry);
    if (path.resolve(sourcePath) === path.resolve(archiveDir)) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(sourcePath);
    } catch (error) {
      warnings.push({ path: sourcePath, error: toError(error), camera: cameraId });
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (stats.mtimeMs >= cutoffTs) {
      continue;
    }

    try {
      if (mode === 'delete') {
        fs.rmSync(sourcePath, { force: true });
        moved += 1;
      } else {
        const archivePath = buildArchivePath(archiveDir, snapshotDir, stats.mtimeMs);
        const targetPath = ensureUniqueArchivePath(archivePath, entry);
        fs.renameSync(sourcePath, targetPath);
        moved += 1;
      }
    } catch (error) {
      warnings.push({ path: sourcePath, error: toError(error), camera: cameraId });
    }
  }

  let pruned = 0;
  if (mode === 'archive') {
    try {
      pruned = pruneArchiveLimit(archiveDir, snapshotDir, maxArchivesPerCamera);
    } catch (error) {
      warnings.push({
        path: path.join(archiveDir, path.basename(snapshotDir)),
        error: toError(error),
        camera: cameraId
      });
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

function pruneArchiveLimit(
  archiveDir: string,
  snapshotDir: string,
  limit: number | undefined
): number {
  const cameraRoot = path.join(archiveDir, path.basename(snapshotDir));
  if (!fs.existsSync(cameraRoot)) {
    return 0;
  }

  if (typeof limit !== 'number' || limit < 0) {
    return 0;
  }

  const files = collectArchiveFiles(cameraRoot);
  if (files.length <= limit) {
    return 0;
  }

  const sorted = files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const excess = sorted.slice(limit);
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

function mapFaceRow(row: FaceRow): FaceRecord {
  let embedding: number[] = [];
  try {
    const parsed = JSON.parse(row.embedding);
    if (Array.isArray(parsed)) {
      embedding = parsed.map(value => Number(value)).filter(value => Number.isFinite(value));
    }
  } catch (error) {
    embedding = [];
  }

  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      const parsedMetadata = JSON.parse(row.metadata);
      if (parsedMetadata && typeof parsedMetadata === 'object') {
        metadata = parsedMetadata as Record<string, unknown>;
      }
    } catch (error) {
      metadata = undefined;
    }
  }

  return {
    id: row.id,
    label: row.label,
    embedding,
    metadata,
    createdAt: row.createdAt
  };
}

function normalizeEmbedding(values: number[]) {
  const length = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0));
  if (!Number.isFinite(length) || length === 0) {
    return values.map(() => 0);
  }
  return values.map(value => value / length);
}

function euclideanDistance(a: number[], b: number[]) {
  const max = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < max; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
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

function normalizeSnapshotOptions(options: RetentionPolicyOptions, now: number) {
  const snapshot = options.snapshot ?? {};
  const mode = snapshot.mode ?? 'archive';
  const days = typeof snapshot.retentionDays === 'number' ? snapshot.retentionDays : options.retentionDays;
  const retentionMs = Math.max(days, 0) * 24 * 60 * 60 * 1000;
  const cutoffTs = now - retentionMs;
  const perCameraMax = snapshot.perCameraMax
    ? Object.fromEntries(
        Object.entries(snapshot.perCameraMax)
          .filter(([camera, value]) => typeof camera === 'string' && camera.trim() && typeof value === 'number' && Number.isFinite(value) && value >= 0)
          .map(([camera, value]) => [camera, Math.floor(value)])
      )
    : undefined;
  return { mode, cutoffTs, perCameraMax } as const;
}

function normalizeVacuumOptions(options: VacuumOptions | VacuumMode): Required<VacuumOptions> {
  if (typeof options === 'string') {
    return {
      mode: options,
      target: undefined,
      analyze: false,
      reindex: false,
      optimize: false,
      pragmas: undefined,
      run: 'on-change'
    };
  }

  const mode = options.mode ?? 'auto';
  const pragmas = Array.isArray(options.pragmas)
    ? options.pragmas
        .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(entry => entry.length > 0)
    : undefined;
  return {
    mode,
    target: options.target?.trim() || undefined,
    analyze: options.analyze === true,
    reindex: options.reindex === true,
    optimize: options.optimize === true,
    pragmas,
    run: options.run === 'always' ? 'always' : 'on-change'
  };
}

function escapeLike(value: string) {
  return value.replace(/([_%\\])/g, '\\$1');
}

function collectChannelFilters(options: { channel?: string; channels?: string[] }): string[] {
  const set = new Set<string>();
  if (typeof options.channel === 'string') {
    const trimmed = options.channel.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  if (Array.isArray(options.channels)) {
    for (const candidate of options.channels) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const trimmed = candidate.trim();
      if (trimmed) {
        set.add(trimmed);
      }
    }
  }
  return Array.from(set);
}

export default db;
