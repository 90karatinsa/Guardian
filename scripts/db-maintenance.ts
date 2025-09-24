import config from 'config';
import path from 'node:path';
import logger from '../src/logger.js';
import { applyRetentionPolicy, vacuumDatabase } from '../src/db.js';

const retentionDays = config.has('database.retentionDays')
  ? config.get<number>('database.retentionDays')
  : 30;
const snapshotDir = config.has('person.snapshotDir')
  ? config.get<string>('person.snapshotDir')
  : 'snapshots';
const archiveDir = config.has('person.snapshotArchiveDir')
  ? config.get<string>('person.snapshotArchiveDir')
  : path.join(snapshotDir, 'archive');

const outcome = applyRetentionPolicy({
  retentionDays,
  snapshotDir,
  archiveDir
});

logger.info(
  {
    retentionDays,
    removedEvents: outcome.removedEvents
  },
  'Database retention completed'
);

logger.info(
  {
    archiveDir,
    archivedSnapshots: outcome.archivedSnapshots
  },
  'Snapshot archive rotation complete'
);

vacuumDatabase();
logger.info('Vacuum completed');
