import { EventEmitter } from 'node:events';
import pino from 'pino';
import config from 'config';
import metrics, { type PrometheusLogLevelOptions } from './metrics/index.js';

const level = config.has('logging.level') ? config.get<string>('logging.level') : 'info';
const name = config.has('app.name') ? config.get<string>('app.name') : 'Guardian';

const AVAILABLE_LOG_LEVELS = new Set(
  Object.keys(pino.levels.values).map(level => level.toLowerCase())
);

const levelEvents = new EventEmitter();

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
      } else if (!detector) {
        const meta = candidate.meta as Record<string, unknown> | undefined;
        if (meta && typeof meta.detector === 'string' && meta.detector.length > 0) {
          detector = meta.detector;
        }
        const context = candidate.context as Record<string, unknown> | undefined;
        if (context && typeof context.detector === 'string' && context.detector.length > 0) {
          detector = context.detector;
        }
        const event = candidate.event as Record<string, unknown> | undefined;
        if (event && typeof event.detector === 'string' && event.detector.length > 0) {
          detector = event.detector;
        }
      }
      if (typeof candidate.message === 'string' && candidate.message.length > 0 && !message) {
        message = candidate.message;
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

let currentLevel = logger.level;
let lastLevelChangePrevious: string | null = null;
metrics.recordLogLevelChange(currentLevel, currentLevel);

metrics.onReset(() => {
  metrics.recordLogLevelChange(currentLevel, lastLevelChangePrevious ?? currentLevel);
});

function normalizeLevel(value: string) {
  return value.trim().toLowerCase();
}

function assertLevel(level: string) {
  if (!AVAILABLE_LOG_LEVELS.has(level)) {
    const available = Array.from(AVAILABLE_LOG_LEVELS).sort().join(', ');
    throw new Error(`Unknown log level "${level}" (available: ${available})`);
  }
}

export function getLogLevel(): string {
  return currentLevel;
}

export function getAvailableLogLevels(): string[] {
  return Array.from(AVAILABLE_LOG_LEVELS).sort();
}

export function setLogLevel(nextLevel: string): string {
  const normalized = normalizeLevel(nextLevel);
  assertLevel(normalized);
  const previous = currentLevel;
  if (previous === normalized) {
    return currentLevel;
  }

  logger.level = normalized as pino.LevelWithSilent;
  currentLevel = logger.level;
  metrics.recordLogLevelChange(currentLevel, previous);
  lastLevelChangePrevious = previous;
  levelEvents.emit('change', currentLevel, previous);
  logger.info({ level: currentLevel }, 'Log level updated');
  return currentLevel;
}

export function onLogLevelChange(listener: (level: string, previous: string | null) => void) {
  const wrapper = (level: string, previous: string | null) => {
    listener(level, previous);
  };
  levelEvents.on('change', wrapper);
  return () => {
    levelEvents.off('change', wrapper);
  };
}

export function getLogLevelMetrics() {
  return metrics.exportLogLevelMetrics();
}

export function getLogLevelPrometheusMetrics(options?: PrometheusLogLevelOptions) {
  return metrics.exportLogLevelCountersForPrometheus(options);
}

export default logger;
