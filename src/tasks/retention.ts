import path from 'node:path';
import loggerModule from '../logger.js';
import metricsModule, { MetricsRegistry } from '../metrics/index.js';
import {
  applyRetentionPolicy,
  RetentionOutcome,
  RetentionPolicyOptions,
  vacuumDatabase,
  VacuumMode,
  VacuumOptions,
  SnapshotRotationOptions
} from '../db.js';

type RetentionLogger = Pick<typeof loggerModule, 'info' | 'warn' | 'error'>;

export interface RetentionTaskOptions {
  enabled?: boolean;
  retentionDays: number;
  intervalMs: number;
  archiveDir: string;
  snapshotDirs: string[];
  maxArchivesPerCamera?: number;
  vacuumMode?: VacuumMode;
  vacuum?: VacuumMode | VacuumOptions;
  snapshot?: SnapshotRotationOptions & {
    maxArchivesPerCamera?: number | Record<string, number>;
  };
  logger?: RetentionLogger;
  metrics?: MetricsRegistry;
}

type NormalizedOptions = {
  enabled: boolean;
  retentionDays: number;
  intervalMs: number;
  archiveDir: string;
  snapshotDirs: string[];
  maxArchivesPerCamera?: number;
  vacuum: Required<VacuumOptions>;
  snapshot?: SnapshotRotationOptions;
};

export class RetentionTask {
  private options: NormalizedOptions;
  private readonly logger: RetentionLogger;
  private readonly metrics: MetricsRegistry;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(options: RetentionTaskOptions) {
    this.options = normalizeOptions(options);
    this.logger = options.logger ?? loggerModule;
    this.metrics = options.metrics ?? metricsModule;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.scheduleNext(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  configure(options: RetentionTaskOptions) {
    this.options = normalizeOptions(options);

    if (this.stopped) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, delayMs);
  }

  private async runOnce() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      if (!this.options.enabled) {
        this.logger.info({ enabled: false }, 'Retention task skipped');
        return;
      }

      const snapshotDirs = dedupeDirectories(this.options.snapshotDirs);
      const archiveDir = this.options.archiveDir;

      const outcome = runPolicy({
        retentionDays: this.options.retentionDays,
        archiveDir,
        snapshotDirs,
        maxArchivesPerCamera: this.options.maxArchivesPerCamera,
        snapshot: this.options.snapshot
      });

      const shouldVacuum =
        this.options.vacuum.run === 'always' ||
        (this.options.vacuum.run !== 'always' &&
          (outcome.removedEvents > 0 || outcome.archivedSnapshots > 0 || outcome.prunedArchives > 0));

      for (const warning of outcome.warnings) {
        this.logger.warn(
          { path: warning.path, camera: warning.camera, err: warning.error },
          'Retention archive warning'
        );
        this.metrics.recordRetentionWarning({
          camera: warning.camera,
          path: warning.path,
          reason: warning.error.message ?? warning.error.name
        });
      }

      if (shouldVacuum) {
        vacuumDatabase(this.options.vacuum);
      }

      this.metrics.recordRetentionRun({
        removedEvents: outcome.removedEvents,
        archivedSnapshots: outcome.archivedSnapshots,
        prunedArchives: outcome.prunedArchives,
        perCamera: outcome.perCamera
      });

      this.logger.info(
        {
          removedEvents: outcome.removedEvents,
          archivedSnapshots: outcome.archivedSnapshots,
          prunedArchives: outcome.prunedArchives,
          retentionDays: this.options.retentionDays,
          vacuumMode: shouldVacuum ? this.options.vacuum.mode ?? 'auto' : 'skipped',
          vacuumRunMode: this.options.vacuum.run,
          vacuumTasks:
            shouldVacuum
              ? {
                  analyze: this.options.vacuum.analyze === true,
                  reindex: this.options.vacuum.reindex === true,
                  optimize: this.options.vacuum.optimize === true,
                  target: this.options.vacuum.target
                }
              : undefined,
          perCamera: outcome.perCamera
        },
        'Retention task completed'
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Retention task failed');
    } finally {
      this.running = false;

      if (!this.stopped) {
        this.scheduleNext(this.options.intervalMs);
      }
    }
  }
}

export function startRetentionTask(options: RetentionTaskOptions): RetentionTask {
  const task = new RetentionTask(options);
  task.start();
  return task;
}

function normalizeOptions(options: RetentionTaskOptions): NormalizedOptions {
  const intervalMs = Math.max(1000, Math.floor(options.intervalMs));
  const archiveDir = path.resolve(options.archiveDir);
  const snapshotDirs = dedupeDirectories(options.snapshotDirs);
  const snapshotAliasLimit = extractSnapshotGlobalLimit(options.snapshot);
  const snapshot = normalizeSnapshotConfig(options.snapshot);
  const vacuum = normalizeVacuumConfig(options);
  const explicitMax =
    typeof options.maxArchivesPerCamera === 'number' &&
    Number.isFinite(options.maxArchivesPerCamera) &&
    options.maxArchivesPerCamera >= 0
      ? Math.floor(options.maxArchivesPerCamera)
      : undefined;
  const maxArchivesPerCamera =
    typeof explicitMax === 'number' ? explicitMax : snapshotAliasLimit;

  return {
    enabled: options.enabled !== false,
    retentionDays: Math.max(0, Math.floor(options.retentionDays)),
    intervalMs,
    archiveDir,
    snapshotDirs,
    maxArchivesPerCamera,
    vacuum,
    snapshot
  };
}

function dedupeDirectories(directories: string[]): string[] {
  const set = new Set<string>();
  for (const entry of directories) {
    if (!entry) {
      continue;
    }
    set.add(path.resolve(entry));
  }
  return [...set];
}

function runPolicy(options: {
  retentionDays: number;
  archiveDir: string;
  snapshotDirs: string[];
  maxArchivesPerCamera?: number;
  snapshot?: SnapshotRotationOptions;
}): RetentionOutcome {
  const policy: RetentionPolicyOptions = {
    retentionDays: options.retentionDays,
    archiveDir: options.archiveDir,
    snapshotDirs: options.snapshotDirs,
    maxArchivesPerCamera: options.maxArchivesPerCamera,
    snapshot: options.snapshot
  };

  return applyRetentionPolicy(policy);
}

function normalizeSnapshotConfig(
  snapshot?: RetentionTaskOptions['snapshot']
): SnapshotRotationOptions | undefined {
  if (!snapshot) {
    return undefined;
  }

  const normalized: SnapshotRotationOptions = { mode: snapshot.mode ?? 'archive' };
  if (typeof snapshot.retentionDays === 'number' && Number.isFinite(snapshot.retentionDays)) {
    normalized.retentionDays = Math.max(0, Math.floor(snapshot.retentionDays));
  }
  const perCameraSource = resolvePerCameraSource(snapshot);
  if (perCameraSource) {
    normalized.perCameraMax = perCameraSource;
  }
  return normalized;
}

function resolvePerCameraSource(
  snapshot: RetentionTaskOptions['snapshot']
): Record<string, number> | undefined {
  const candidate =
    snapshot?.perCameraMax && typeof snapshot.perCameraMax === 'object'
      ? snapshot.perCameraMax
      : snapshot?.maxArchivesPerCamera && typeof snapshot.maxArchivesPerCamera === 'object'
        ? snapshot.maxArchivesPerCamera
        : undefined;

  if (!candidate || Array.isArray(candidate)) {
    return undefined;
  }

  const entries = Object.entries(candidate)
    .filter(([camera, value]) => typeof camera === 'string' && camera.trim().length > 0)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .map(([camera, value]) => [camera, Math.floor(value)] as const);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function extractSnapshotGlobalLimit(
  snapshot?: RetentionTaskOptions['snapshot']
): number | undefined {
  const alias = snapshot?.maxArchivesPerCamera;
  if (typeof alias === 'number' && Number.isFinite(alias) && alias >= 0) {
    return Math.floor(alias);
  }
  return undefined;
}

function normalizeVacuumConfig(options: RetentionTaskOptions): Required<VacuumOptions> {
  const base = options.vacuum;
  const legacyMode = options.vacuumMode;

  if (typeof base === 'string') {
    return normalizeVacuumConfig({ ...options, vacuum: { mode: base } });
  }

  if (base && typeof base === 'object') {
    const pragmas = Array.isArray(base.pragmas)
      ? base.pragmas
          .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(entry => entry.length > 0)
      : undefined;

    return {
      mode: base.mode ?? legacyMode ?? 'auto',
      target: base.target?.trim() || undefined,
      analyze: base.analyze === true,
      reindex: base.reindex === true,
      optimize: base.optimize === true,
      pragmas,
      run: base.run === 'always' ? 'always' : 'on-change'
    } satisfies Required<VacuumOptions>;
  }

  if (legacyMode) {
    return {
      mode: legacyMode,
      target: undefined,
      analyze: false,
      reindex: false,
      optimize: false,
      pragmas: undefined,
      run: 'on-change'
    };
  }

  return {
    mode: 'auto',
    target: undefined,
    analyze: false,
    reindex: false,
    optimize: false,
    pragmas: undefined,
    run: 'on-change'
  };
}
