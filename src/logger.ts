import pino from 'pino';
import config from 'config';
import metrics from './metrics/index.js';

const level = config.has('logging.level') ? config.get<string>('logging.level') : 'info';
const name = config.has('app.name') ? config.get<string>('app.name') : 'Guardian';

const logger = pino({
  name,
  level,
  hooks: {
    logMethod(inputArgs, method, logLevel) {
      const resolvedLevel =
        typeof logLevel === 'number' ? pino.levels.labels[logLevel] ?? String(logLevel) : logLevel;
      metrics.incrementLogLevel(resolvedLevel);
      return method.apply(this, inputArgs);
    }
  }
});

export default logger;
