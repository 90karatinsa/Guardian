import pino from 'pino';
import config from 'config';
import metrics from './metrics/index.js';

const level = config.has('logging.level') ? config.get<string>('logging.level') : 'info';
const name = config.has('app.name') ? config.get<string>('app.name') : 'Guardian';

type LogContext = {
  message?: string;
  detector?: string;
};

function extractContext(args: unknown[]): LogContext {
  let message: string | undefined;
  let detector: string | undefined;

  for (const value of args) {
    if (typeof value === 'string' && value.length > 0 && !message) {
      message = value;
    } else if (value && typeof value === 'object') {
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.detector === 'string' && candidate.detector.length > 0 && !detector) {
        detector = candidate.detector;
      }
    }
  }

  return { message, detector };
}

const logger = pino({
  name,
  level,
  hooks: {
    logMethod(inputArgs, method, logLevel) {
      const resolvedLevel =
        typeof logLevel === 'number' ? pino.levels.labels[logLevel] ?? String(logLevel) : logLevel;
      const context = extractContext(inputArgs);
      metrics.incrementLogLevel(resolvedLevel, context);
      return method.apply(this, inputArgs);
    }
  }
});

export default logger;
