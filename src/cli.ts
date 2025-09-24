import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './logger.js';
import metrics, { type MetricsSnapshot } from './metrics/index.js';
import packageJson from '../package.json' assert { type: 'json' };

type ServiceStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

type HealthStatus = 'ok' | 'starting' | 'stopping' | 'degraded';

type CliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type GuardRuntime = {
  stop: () => void;
};

type HealthPayload = {
  status: HealthStatus;
  state: ServiceStatus;
  uptimeSeconds: number;
  startedAt: string | null;
  timestamp: string;
  checks: Array<{
    name: string;
    status: HealthStatus;
    details?: Record<string, unknown>;
  }>;
  metrics: MetricsSnapshot;
  application: {
    name: string;
    version: string;
  };
};

const DEFAULT_IO: CliIo = { stdout: process.stdout, stderr: process.stderr };

const state: {
  status: ServiceStatus;
  startedAt: number | null;
  runtime: GuardRuntime | null;
  stopResolver: (() => void) | null;
  shuttingDown: boolean;
} = {
  status: 'idle',
  startedAt: null,
  runtime: null,
  stopResolver: null,
  shuttingDown: false
};

export function getServiceState() {
  return { status: state.status, startedAt: state.startedAt };
}

export function buildHealthPayload(): HealthPayload {
  const snapshot = metrics.snapshot();
  const errorCount = snapshot.logs.byLevel.error ?? 0;
  const fatalCount = snapshot.logs.byLevel.fatal ?? 0;
  const degraded = errorCount > 0 || fatalCount > 0;

  let status: HealthStatus = 'ok';
  if (state.status === 'starting') {
    status = 'starting';
  } else if (state.status === 'stopping') {
    status = 'stopping';
  } else if (degraded) {
    status = 'degraded';
  }

  const uptimeSeconds = state.startedAt ? (Date.now() - state.startedAt) / 1000 : process.uptime();

  return {
    status,
    state: state.status,
    uptimeSeconds,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    timestamp: new Date().toISOString(),
    application: {
      name: packageJson.name ?? 'guardian',
      version: packageJson.version ?? '0.0.0'
    },
    checks: [
      {
        name: 'eventBus',
        status: snapshot.events.total === 0 && state.status !== 'running' ? 'degraded' : 'ok',
        details: {
          totalEvents: snapshot.events.total,
          lastEventAt: snapshot.events.lastEventAt
        }
      },
      {
        name: 'logger',
        status: degraded ? 'degraded' : 'ok',
        details: {
          levels: snapshot.logs.byLevel
        }
      }
    ],
    metrics: snapshot
  };
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = DEFAULT_IO): Promise<number> {
  if (argv.includes('--health')) {
    const payload = buildHealthPayload();
    io.stdout.write(`${JSON.stringify(payload)}\n`);
    return payload.status === 'ok' ? 0 : 1;
  }

  const command = argv[0] ?? 'start';

  switch (command) {
    case 'start': {
      return startDaemon(io);
    }
    case 'help':
    case '--help':
    case '-h': {
      io.stdout.write(
        ['Guardian CLI', '', 'Usage:', '  guardian start       Start the detector daemon', '  guardian --health    Print health JSON'].join(
          '\n'
        ) + '\n'
      );
      return 0;
    }
    default: {
      io.stderr.write(`Unknown command: ${command}\n`);
      return 1;
    }
  }
}

async function startDaemon(io: CliIo): Promise<number> {
  if (state.status === 'running') {
    io.stdout.write('Guardian daemon is already running\n');
    return 0;
  }

  process.env.GUARDIAN_DISABLE_AUTO_START = '1';

  const module = await import('./run-guard.js');
  const startGuard: () => Promise<GuardRuntime> = module.startGuard;

  state.status = 'starting';
  state.shuttingDown = false;

  try {
    state.runtime = await metrics.time('guard.startup.ms', () => startGuard());
  } catch (error) {
    state.status = 'stopped';
    state.runtime = null;
    logger.error({ err: error }, 'Guardian daemon failed to start');
    io.stderr.write('Guardian daemon failed to start. Check logs for details.\n');
    return 1;
  }

  state.status = 'running';
  state.startedAt = Date.now();
  logger.info({ startedAt: state.startedAt }, 'Guardian daemon started');
  io.stdout.write('Guardian daemon started\n');

  await new Promise<void>(resolve => {
    state.stopResolver = resolve;
    registerSignalHandlers();
  });

  return 0;
}

function registerSignalHandlers() {
  const handleSignal = async (signal: NodeJS.Signals) => {
    if (state.shuttingDown) {
      return;
    }
    state.shuttingDown = true;
    state.status = 'stopping';
    logger.info({ signal }, 'Shutdown signal received');

    try {
      await metrics.time('guard.shutdown.ms', async () => {
        state.runtime?.stop();
      });
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
    } finally {
      state.runtime = null;
      state.status = 'stopped';
      state.startedAt = null;
      state.stopResolver?.();
      state.stopResolver = null;
    }
  };

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.once(signal, handleSignal);
  }
}

const resolvedPath = path.resolve(process.argv[1] ?? '');
const modulePath = fileURLToPath(import.meta.url);

if (resolvedPath === modulePath) {
  runCli().then(
    code => {
      process.exit(code);
    },
    error => {
      logger.error({ err: error }, 'Guardian CLI failed');
      process.exit(1);
    }
  );
}
