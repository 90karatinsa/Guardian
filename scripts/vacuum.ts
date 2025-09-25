#!/usr/bin/env tsx
import process from 'node:process';
import { vacuumDatabase, VacuumMode, VacuumOptions } from '../src/db.js';
import logger from '../src/logger.js';

function parseArgs(argv: string[]): VacuumOptions {
  const options: VacuumOptions = {};
  const pragmas: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const mode = arg.split('=')[1] as VacuumMode;
      if (mode === 'auto' || mode === 'full') {
        options.mode = mode;
      }
      continue;
    }

    if (arg === '--full') {
      options.mode = 'full';
      continue;
    }

    if (arg === '--analyze') {
      options.analyze = true;
      continue;
    }

    if (arg === '--reindex') {
      options.reindex = true;
      continue;
    }

    if (arg === '--optimize') {
      options.optimize = true;
      continue;
    }

    if (arg.startsWith('--target=')) {
      options.target = arg.split('=')[1] ?? undefined;
      continue;
    }

    if (arg.startsWith('--pragma=')) {
      const pragma = arg.slice('--pragma='.length);
      if (pragma) {
        pragmas.push(pragma);
      }
      continue;
    }
  }

  if (pragmas.length > 0) {
    options.pragmas = pragmas;
  }

  return options;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  logger.info({ options }, 'running manual vacuum');
  vacuumDatabase(options);
  logger.info('vacuum completed');
}

main().catch(error => {
  logger.error({ err: error }, 'vacuum command failed');
  process.exitCode = 1;
});
