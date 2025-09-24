import path from 'node:path';
import loggerModule from '../logger.js';
import {
  applyRetentionPolicy,
  RetentionOutcome,
  RetentionPolicyOptions,
  vacuumDatabase,
  VacuumMode
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
  logger?: RetentionLogger;
}

type NormalizedOptions = {
  enabled: boolean;
  retentionDays: number;
  intervalMs: number;
  archiveDir: string;
  snapshotDirs: string[];
  maxArchivesPerCamera?: number;
  vacuumMode: VacuumMode;
};

export class RetentionTask {
  private options: NormalizedOptions;
  private readonly logger: RetentionLogger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(options: RetentionTaskOptions) {
    this.options = normalizeOptions(options);
    this.logger = options.logger ?? loggerModule;
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
        maxArchivesPerCamera: this.options.maxArchivesPerCamera
      });

      for (const warning of outcome.warnings) {
        this.logger.warn({ path: warning.path, err: warning.error }, 'Retention archive warning');
      }

      if (outcome.removedEvents > 0) {
        vacuumDatabase(this.options.vacuumMode);
      }

      this.logger.info(
        {
          removedEvents: outcome.removedEvents,
          archivedSnapshots: outcome.archivedSnapshots,
          prunedArchives: outcome.prunedArchives,
          retentionDays: this.options.retentionDays,
          vacuumMode: outcome.removedEvents > 0 ? this.options.vacuumMode : 'skipped'
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

  return {
    enabled: options.enabled !== false,
    retentionDays: Math.max(0, Math.floor(options.retentionDays)),
    intervalMs,
    archiveDir,
    snapshotDirs,
    maxArchivesPerCamera:
      typeof options.maxArchivesPerCamera === 'number' && options.maxArchivesPerCamera >= 0
        ? Math.floor(options.maxArchivesPerCamera)
        : undefined,
    vacuumMode: options.vacuumMode ?? 'auto'
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
}): RetentionOutcome {
  const policy: RetentionPolicyOptions = {
    retentionDays: options.retentionDays,
    archiveDir: options.archiveDir,
    snapshotDirs: options.snapshotDirs,
    maxArchivesPerCamera: options.maxArchivesPerCamera
  };

  return applyRetentionPolicy(policy);
}
