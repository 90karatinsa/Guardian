#!/usr/bin/env tsx
import process from 'node:process';
import path from 'node:path';
import logger from '../src/logger.js';
import metrics, { type MetricsRegistry } from '../src/metrics/index.js';
import configManager, { type GuardianConfig } from '../src/config/index.js';
import { runRetentionOnce, type RetentionTaskOptions } from '../src/tasks/retention.js';

type MaintenanceSummary = {
  removedEvents: number;
  archivedSnapshots: number;
  prunedArchives: number;
  warnings: number;
};

export interface MaintenanceRunResult {
  skipped: boolean;
  options: RetentionTaskOptions | null;
  result: Awaited<ReturnType<typeof runRetentionOnce>> | null;
}

export interface MaintenanceOptions {
  config?: GuardianConfig;
  logger?: typeof logger;
  metrics?: MetricsRegistry;
}

export async function runMaintenance(overrides: MaintenanceOptions = {}): Promise<MaintenanceRunResult> {
  const activeLogger = overrides.logger ?? logger;
  const activeMetrics = overrides.metrics ?? metrics;

  activeLogger.info('Guardian maintenance starting');

  const config = overrides.config ?? configManager.getConfig();
  const module = await import('../src/run-guard.js');
  const buildRetentionOptions = module.buildRetentionOptions as typeof import('../src/run-guard.js')['buildRetentionOptions'];

  const retentionOptions = buildRetentionOptions({
    retention: config.events?.retention,
    video: config.video,
    person: config.person,
    logger: activeLogger
  });

  if (!retentionOptions) {
    activeLogger.info('Retention maintenance skipped (retention disabled)');
    return { skipped: true, options: null, result: null };
  }

  const result = await runRetentionOnce({ ...retentionOptions, metrics: activeMetrics });

  if (result.skipped) {
    activeLogger.info('Retention maintenance skipped (retention disabled)');
    return { skipped: true, options: retentionOptions, result };
  }

  const totals = normalizeOutcome(result) ?? {
    removedEvents: 0,
    archivedSnapshots: 0,
    prunedArchives: 0,
    warnings: result.warnings.length
  };

  activeLogger.info(
    {
      removedEvents: totals.removedEvents,
      archivedSnapshots: totals.archivedSnapshots,
      prunedArchives: totals.prunedArchives,
      warnings: totals.warnings,
      archiveDir: retentionOptions.archiveDir,
      snapshotDirs: retentionOptions.snapshotDirs.map(dir => path.resolve(dir)),
      vacuum: result.vacuum
    },
    'Database retention completed'
  );

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      activeLogger.warn({ warning }, 'Retention maintenance warning');
    }
  }

  if (result.vacuum.ran) {
    activeLogger.info({ vacuum: result.vacuum }, 'VACUUM completed');
  } else {
    activeLogger.info({ vacuum: result.vacuum }, 'VACUUM skipped');
  }

  return { skipped: false, options: retentionOptions, result };
}

async function main() {
  await runMaintenance();
}

function normalizeOutcome(result: Awaited<ReturnType<typeof runRetentionOnce>>): MaintenanceSummary | null {
  const outcome = result.outcome;
  if (!outcome) {
    return null;
  }

  return {
    removedEvents: outcome.removedEvents,
    archivedSnapshots: outcome.archivedSnapshots,
    prunedArchives: outcome.prunedArchives,
    warnings: result.warnings.length
  } satisfies MaintenanceSummary;
}

main().catch(error => {
  logger.error({ err: error }, 'Guardian maintenance failed');
  process.exitCode = 1;
});
