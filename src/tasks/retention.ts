import path from 'node:path';
import loggerModule from '../logger.js';
import metricsModule, { MetricsRegistry, type RetentionWarningSnapshot } from '../metrics/index.js';
import {
  applyRetentionPolicy,
  getDatabaseDiskUsage,
  getDatabaseTableStats,
  RetentionOutcome,
  RetentionPolicyOptions,
  vacuumDatabase,
  VacuumMode,
  VacuumOptions,
  SnapshotRotationOptions,
  type DatabaseDiskUsageSnapshot,
  type VacuumTableStat
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
  vacuum?: boolean | VacuumMode | VacuumOptions;
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

export type RetentionVacuumSummary = {
  ran: boolean;
  runMode: Required<VacuumOptions>['run'];
  mode: VacuumMode | 'skipped';
  analyze: boolean;
  reindex: boolean;
  optimize: boolean;
  target?: string;
  pragmas?: string[];
  indexVersion?: number;
  ensuredIndexes?: string[];
  disk?: {
    before: DatabaseDiskUsageSnapshot;
    after: DatabaseDiskUsageSnapshot;
    savingsBytes: number;
  };
  tables?: VacuumTableStat[];
};

export type RetentionRunResult = {
  skipped: boolean;
  reason?: 'disabled';
  outcome?: RetentionOutcome;
  warnings: RetentionWarningSnapshot[];
  vacuum: RetentionVacuumSummary;
  rescheduled: boolean;
  disk: {
    before: DatabaseDiskUsageSnapshot;
    after: DatabaseDiskUsageSnapshot;
    savingsBytes: number;
  };
};

export class RetentionTask {
  private options: NormalizedOptions;
  private readonly logger: RetentionLogger;
  private readonly metrics: MetricsRegistry;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private pendingSkip = false;

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
    this.pendingSkip = false;
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

    if (!this.options.enabled) {
      if (this.running) {
        this.pendingSkip = true;
      } else {
        this.scheduleNext(0);
      }
      return;
    }

    this.pendingSkip = false;

    if (this.running) {
      return;
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

    let result: RetentionRunResult | null = null;
    const options = this.options;

    try {
      result = await executeRetentionRun(options, this.logger, this.metrics);
    } catch (error) {
      this.logger.error({ err: error }, 'Retention task failed');
    } finally {
      this.running = false;

      if (!this.stopped) {
        const latestOptions = this.options;
        const shouldReschedule =
          (result?.rescheduled ?? latestOptions.enabled) && latestOptions.enabled;

        if (shouldReschedule) {
          this.pendingSkip = false;
          this.scheduleNext(latestOptions.intervalMs);
        } else if (this.pendingSkip && !this.timer) {
          this.pendingSkip = false;
          this.scheduleNext(0);
        } else if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
          this.pendingSkip = false;
        } else {
          this.pendingSkip = false;
        }
      }
    }
  }
}

export function startRetentionTask(options: RetentionTaskOptions): RetentionTask {
  const task = new RetentionTask(options);
  task.start();
  return task;
}

export async function runRetentionOnce(options: RetentionTaskOptions): Promise<RetentionRunResult> {
  const normalized = normalizeOptions(options);
  const logger = options.logger ?? loggerModule;
  const metrics = options.metrics ?? metricsModule;
  return executeRetentionRun(normalized, logger, metrics);
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

  if (base === false) {
    return {
      mode: legacyMode ?? 'auto',
      target: undefined,
      analyze: false,
      reindex: false,
      optimize: false,
      pragmas: undefined,
      run: 'never'
    } satisfies Required<VacuumOptions>;
  }

  if (base === true) {
    return {
      mode: legacyMode ?? 'auto',
      target: undefined,
      analyze: false,
      reindex: false,
      optimize: false,
      pragmas: undefined,
      run: 'on-change'
    } satisfies Required<VacuumOptions>;
  }

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
      run:
        base.run === 'always'
          ? 'always'
          : base.run === 'never'
            ? 'never'
            : 'on-change'
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

async function executeRetentionRun(
  options: NormalizedOptions,
  logger: RetentionLogger,
  metrics: MetricsRegistry
): Promise<RetentionRunResult> {
  if (!options.enabled) {
    const vacuum: RetentionVacuumSummary = {
      ran: false,
      runMode: options.vacuum.run,
      mode: 'skipped',
      analyze: false,
      reindex: false,
      optimize: false
    };
    logger.info({ enabled: false }, 'Retention task skipped');
    return { skipped: true, reason: 'disabled', warnings: [], vacuum, rescheduled: false };
  }

  const snapshotDirs = dedupeDirectories(options.snapshotDirs);
  const archiveDir = options.archiveDir;

  const diskBefore = getDatabaseDiskUsage();

  const tableBaseline = getDatabaseTableStats();

  const outcome = runPolicy({
    retentionDays: options.retentionDays,
    archiveDir,
    snapshotDirs,
    maxArchivesPerCamera: options.maxArchivesPerCamera,
    snapshot: options.snapshot
  });

  const shouldVacuum =
    options.vacuum.run === 'always'
      ? true
      : options.vacuum.run === 'on-change'
        ? outcome.removedEvents > 0 || outcome.archivedSnapshots > 0 || outcome.prunedArchives > 0
        : false;

  const warnings: RetentionWarningSnapshot[] = [];
  for (const warning of outcome.warnings) {
    const summary: RetentionWarningSnapshot = {
      camera: warning.camera ?? null,
      path: warning.path,
      reason: warning.error.message ?? warning.error.name
    };
    warnings.push(summary);
    logger.warn({ path: warning.path, camera: warning.camera, err: warning.error }, 'Retention archive warning');
    metrics.recordRetentionWarning(summary);
  }

  let vacuumResult: ReturnType<typeof vacuumDatabase> | null = null;
  if (shouldVacuum) {
    vacuumResult = vacuumDatabase(options.vacuum, tableBaseline);
  }

  metrics.recordRetentionRun({
    removedEvents: outcome.removedEvents,
    archivedSnapshots: outcome.archivedSnapshots,
    prunedArchives: outcome.prunedArchives,
    perCamera: outcome.perCamera,
    diskSavingsBytes: Math.max(0, diskBefore.totalBytes - (vacuumResult?.disk.after.totalBytes ?? diskBefore.totalBytes))
  });

  const vacuumSummary: RetentionVacuumSummary = {
    ran: shouldVacuum,
    runMode: vacuumResult?.run ?? options.vacuum.run,
    mode: shouldVacuum ? vacuumResult?.mode ?? options.vacuum.mode ?? 'auto' : 'skipped',
    analyze: shouldVacuum ? vacuumResult?.analyze === true : false,
    reindex: shouldVacuum ? vacuumResult?.reindex === true : false,
    optimize: shouldVacuum ? vacuumResult?.optimize === true : false,
    target: shouldVacuum ? vacuumResult?.target ?? options.vacuum.target ?? undefined : undefined,
    pragmas: shouldVacuum ? vacuumResult?.pragmas : undefined,
    indexVersion: shouldVacuum ? vacuumResult?.indexVersion : undefined,
    ensuredIndexes:
      shouldVacuum && vacuumResult?.ensuredIndexes && vacuumResult.ensuredIndexes.length > 0
        ? vacuumResult.ensuredIndexes
        : undefined,
    disk: shouldVacuum && vacuumResult ? vacuumResult.disk : undefined,
    tables: shouldVacuum && vacuumResult ? vacuumResult.tables : undefined
  };

  const diskAfter = shouldVacuum
    ? vacuumResult?.disk.after ?? getDatabaseDiskUsage()
    : getDatabaseDiskUsage();
  const diskSummary = {
    before: diskBefore,
    after: diskAfter,
    savingsBytes: Math.max(0, diskBefore.totalBytes - diskAfter.totalBytes)
  } satisfies RetentionRunResult['disk'];

  logger.info(
    {
      removedEvents: outcome.removedEvents,
      archivedSnapshots: outcome.archivedSnapshots,
      prunedArchives: outcome.prunedArchives,
      retentionDays: options.retentionDays,
      vacuumMode: vacuumSummary.mode,
      vacuumRunMode: options.vacuum.run,
      vacuumTasks: shouldVacuum
        ? {
            analyze: vacuumSummary.analyze,
            reindex: vacuumSummary.reindex,
            optimize: vacuumSummary.optimize,
            target: vacuumSummary.target,
            pragmas: vacuumSummary.pragmas,
            indexVersion: vacuumSummary.indexVersion,
            ensuredIndexes: vacuumSummary.ensuredIndexes,
            disk: vacuumSummary.disk,
            tables: vacuumSummary.tables
          }
        : undefined,
      perCamera: outcome.perCamera,
      diskSavingsBytes: diskSummary.savingsBytes
    },
    'Retention task completed'
  );

  return {
    skipped: false,
    outcome,
    warnings,
    vacuum: vacuumSummary,
    rescheduled: true,
    disk: diskSummary
  };
}
