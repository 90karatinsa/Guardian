import config from 'config';
import { fileURLToPath } from 'node:url';
import eventBus from './eventBus.js';
import logger from './logger.js';
import metrics, { type MetricsSnapshot } from './metrics/index.js';
import { validateConfig, type GuardianConfig } from './config/index.js';

type HealthStatus = 'ok' | 'starting' | 'stopping' | 'degraded';

export type HealthIndicatorContext = {
  service: {
    status: string;
    startedAt: number | null;
  };
  metrics?: MetricsSnapshot;
  metricsCreatedAt?: string;
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

export type IntegrationManifest = {
  docker: {
    healthcheck: string;
    readyCommand: string;
    stopCommand: string;
    logLevel: {
      get: string;
      set: string;
    };
  };
  systemd: {
    serviceFile: string;
    execStartPre: string;
    execStart: string;
    execReload: string;
    execStop: string;
    execStopPost: string[];
    hooksCommand: string;
    healthCommand: string;
    readyCommand: string;
    logLevel: {
      get: string;
      set: string;
    };
  };
};

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

const CLI_BIN = 'pnpm exec tsx src/cli.ts';
const HEALTH_BIN = 'pnpm exec tsx scripts/healthcheck.ts';
const SYSTEMD_CLI = `/usr/bin/env ${CLI_BIN}`;
const SYSTEMD_HEALTH = `/usr/bin/env ${HEALTH_BIN}`;

const integrationManifest: IntegrationManifest = {
  docker: {
    healthcheck: `${HEALTH_BIN} --health || exit 1`,
    readyCommand: `${CLI_BIN} --ready`,
    stopCommand: `${CLI_BIN} stop`,
    logLevel: {
      get: `${CLI_BIN} log-level get`,
      set: `${CLI_BIN} log-level set <level>`
    }
  },
  systemd: {
    serviceFile: 'deploy/guardian.service',
    execStartPre: `${SYSTEMD_HEALTH} --health`,
    execStart: `${SYSTEMD_CLI} daemon start`,
    execReload: `${SYSTEMD_CLI} daemon status --json`,
    execStop: `${SYSTEMD_CLI} daemon stop`,
    execStopPost: [
      `${SYSTEMD_CLI} daemon hooks --reason systemd-stop --signal SIGTERM`,
      '/usr/bin/env pnpm exec tsx scripts/db-maintenance.ts'
    ],
    hooksCommand: `${SYSTEMD_CLI} daemon hooks --reason systemd-stop --signal SIGTERM`,
    healthCommand: `${SYSTEMD_HEALTH} --health`,
    readyCommand: `${SYSTEMD_CLI} --ready`,
    logLevel: {
      get: `${SYSTEMD_CLI} log-level get`,
      set: `${SYSTEMD_CLI} log-level set <level>`
    }
  }
};

export function getIntegrationManifest(): IntegrationManifest {
  return {
    docker: {
      healthcheck: integrationManifest.docker.healthcheck,
      readyCommand: integrationManifest.docker.readyCommand,
      stopCommand: integrationManifest.docker.stopCommand,
      logLevel: {
        get: integrationManifest.docker.logLevel.get,
        set: integrationManifest.docker.logLevel.set
      }
    },
    systemd: {
      serviceFile: integrationManifest.systemd.serviceFile,
      execStartPre: integrationManifest.systemd.execStartPre,
      execStart: integrationManifest.systemd.execStart,
      execReload: integrationManifest.systemd.execReload,
      execStop: integrationManifest.systemd.execStop,
      execStopPost: [...integrationManifest.systemd.execStopPost],
      hooksCommand: integrationManifest.systemd.hooksCommand,
      healthCommand: integrationManifest.systemd.healthCommand,
      readyCommand: integrationManifest.systemd.readyCommand,
      logLevel: {
        get: integrationManifest.systemd.logLevel.get,
        set: integrationManifest.systemd.logLevel.set
      }
    }
  };
}

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
  const metricsSnapshot = context.metrics ?? metrics.snapshot();
  const metricsCapturedAt = metricsSnapshot.createdAt;
  const enrichedContext: HealthIndicatorContext = {
    ...context,
    metrics: metricsSnapshot,
    metricsCreatedAt: metricsCapturedAt
  };
  for (const entry of healthIndicators) {
    try {
      const result = await entry.indicator(enrichedContext);
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

  const loadedConfig = config.util.toObject(config) as unknown;
  validateConfig(loadedConfig);
  const guardianConfig = loadedConfig as GuardianConfig;

  eventBus.emitEvent({
    source: 'system',
    detector: 'bootstrap',
    severity: 'info',
    message: 'system up',
    meta: {
      thresholds: guardianConfig.events.thresholds
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
