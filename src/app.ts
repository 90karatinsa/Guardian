import config from 'config';
import { fileURLToPath } from 'node:url';
import eventBus from './eventBus.js';
import logger from './logger.js';

export async function bootstrap() {
  logger.info('Guardian bootstrap starting');

  eventBus.emitEvent({
    source: 'system',
    detector: 'bootstrap',
    severity: 'info',
    message: 'system up',
    meta: {
      thresholds: config.get('events.thresholds')
    }
  });

  logger.info('Bootstrap completed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootstrap().catch(error => {
    logger.error({ err: error }, 'Bootstrap failed');
    process.exitCode = 1;
  });
}
