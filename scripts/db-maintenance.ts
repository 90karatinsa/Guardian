#!/usr/bin/env tsx
import process from 'node:process';
import path from 'node:path';
import logger from '../src/logger.js';
import metrics from '../src/metrics/index.js';
import configManager from '../src/config/index.js';
import { runRetentionOnce } from '../src/tasks/retention.js';

type MaintenanceSummary = {
  removedEvents: number;
  archivedSnapshots: number;
  prunedArchives: number;
  warnings: number;
};

async function main() {
  logger.info('Guardian maintenance starting');

  const config = configManager.getConfig();
  const module = await import('../src/run-guard.js');
  const buildRetentionOptions = module.buildRetentionOptions as typeof import('../src/run-guard.js')['buildRetentionOptions'];

  const retentionOptions = buildRetentionOptions({
    retention: config.events?.retention,
    video: config.video,
    person: config.person,
    logger
  });

  if (!retentionOptions) {
    logger.info('Retention maintenance skipped (retention disabled)');
    return;
  }

  const result = await runRetentionOnce({ ...retentionOptions, metrics });

  if (result.skipped) {
    logger.info('Retention maintenance skipped (retention disabled)');
    return;
  }

  const totals = normalizeOutcome(result) ?? {
    removedEvents: 0,
    archivedSnapshots: 0,
    prunedArchives: 0,
    warnings: result.warnings.length
  };

  logger.info(
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
      logger.warn({ warning }, 'Retention maintenance warning');
    }
  }

  if (result.vacuum.ran) {
    logger.info({ vacuum: result.vacuum }, 'VACUUM completed');
  } else {
    logger.info({ vacuum: result.vacuum }, 'VACUUM skipped');
  }
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
