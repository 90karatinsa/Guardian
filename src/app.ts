import config from 'config';
import { fileURLToPath } from 'node:url';
import eventBus from './eventBus.js';
import logger from './logger.js';

type HealthStatus = 'ok' | 'starting' | 'stopping' | 'degraded';

export type HealthIndicatorContext = {
  service: {
    status: string;
    startedAt: number | null;
  };
};

export type HealthIndicatorResult = {
  status: HealthStatus;
  details?: Record<string, unknown>;
};

export type HealthIndicator = (context: HealthIndicatorContext) =>
  | HealthIndicatorResult
  | Promise<HealthIndicatorResult>;

export type ShutdownHookContext = {
  reason: string;
  signal?: NodeJS.Signals;
};

export type ShutdownHook = (context: ShutdownHookContext) => void | Promise<void>;

type RegisteredIndicator = {
  name: string;
  indicator: HealthIndicator;
};

type RegisteredHook = {
  name: string;
  hook: ShutdownHook;
};

const healthIndicators: RegisteredIndicator[] = [];
const shutdownHooks: RegisteredHook[] = [];

export function registerHealthIndicator(name: string, indicator: HealthIndicator) {
  const existingIndex = healthIndicators.findIndex(entry => entry.name === name);
  const entry: RegisteredIndicator = { name, indicator };
  if (existingIndex >= 0) {
    healthIndicators[existingIndex] = entry;
  } else {
    healthIndicators.push(entry);
  }

  return () => {
    const index = healthIndicators.findIndex(item => item.name === name);
    if (index >= 0) {
      healthIndicators.splice(index, 1);
    }
  };
}

export async function collectHealthChecks(context: HealthIndicatorContext) {
  const results: Array<{ name: string; status: HealthStatus; details?: Record<string, unknown> }> = [];
  for (const entry of healthIndicators) {
    try {
      const result = await entry.indicator(context);
      results.push({ name: entry.name, status: result.status, details: result.details });
    } catch (error) {
      const err = error as Error;
      results.push({
        name: entry.name,
        status: 'degraded',
        details: {
          error: err.message ?? String(err)
        }
      });
    }
  }
  return results;
}

export function registerShutdownHook(name: string, hook: ShutdownHook) {
  const existingIndex = shutdownHooks.findIndex(entry => entry.name === name);
  const entry: RegisteredHook = { name, hook };
  if (existingIndex >= 0) {
    shutdownHooks[existingIndex] = entry;
  } else {
    shutdownHooks.push(entry);
  }

  return () => {
    const index = shutdownHooks.findIndex(item => item.name === name);
    if (index >= 0) {
      shutdownHooks.splice(index, 1);
    }
  };
}

export async function runShutdownHooks(context: ShutdownHookContext) {
  const results: Array<{ name: string; status: 'ok' | 'error'; error?: Error }> = [];
  const hooks = [...shutdownHooks].reverse();
  for (const entry of hooks) {
    try {
      await entry.hook(context);
      results.push({ name: entry.name, status: 'ok' });
    } catch (error) {
      results.push({ name: entry.name, status: 'error', error: error as Error });
    }
  }
  return results;
}

export function resetAppLifecycle() {
  healthIndicators.splice(0, healthIndicators.length);
  shutdownHooks.splice(0, shutdownHooks.length);
}

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
