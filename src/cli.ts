import process from 'node:process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import logger, { getAvailableLogLevels, getLogLevel, setLogLevel } from './logger.js';
import metrics, { type MetricsSnapshot } from './metrics/index.js';
import {
  collectHealthChecks,
  runShutdownHooks,
  getIntegrationManifest,
  type IntegrationManifest
} from './app.js';
import configManager, { loadConfigFromFile, type GuardianConfig } from './config/index.js';
import { runRetentionOnce, type RetentionTaskOptions } from './tasks/retention.js';
import packageJson from '../package.json' assert { type: 'json' };

type ServiceStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

type HealthStatus = 'ok' | 'starting' | 'stopping' | 'degraded';

type CliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type GuardRuntime = {
  stop: () => void | Promise<void>;
  resetCircuitBreaker: (identifier: string) => boolean;
};

type ShutdownHookSummary = {
  name: string;
  status: 'ok' | 'error';
  error?: string;
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
  metricsCapturedAt: string;
  metricsSummary: {
    pipelines: {
      restarts: {
        video: number;
        audio: number;
      };
      channels: {
        video: number;
        audio: number;
      };
      lastRestartAt: {
        video: string | null;
        audio: string | null;
      };
    };
  };
  runtime: {
    pipelines: {
      videoChannels: number;
      audioChannels: number;
      videoRestarts: number;
      audioRestarts: number;
    };
  };
  integration: IntegrationManifest;
  application: {
    name: string;
    version: string;
    shutdown: {
      lastAt: string | null;
      lastReason: string | null;
      lastSignal: NodeJS.Signals | null;
      lastError: string | null;
      hooks: ShutdownHookSummary[];
    };
  };
};

type ReadinessPayload = {
  ready: boolean;
  status: HealthStatus;
  state: ServiceStatus;
  timestamp: string;
  startedAt: string | null;
  reason: string | null;
  metrics: {
    restarts: {
      video: number;
      audio: number;
    };
    channels: {
      video: number;
      audio: number;
    };
    snapshotCapturedAt: string;
  };
};

const DEFAULT_IO: CliIo = { stdout: process.stdout, stderr: process.stderr };

const HEALTH_EXIT_CODES: Record<HealthStatus, number> = {
  ok: 0,
  degraded: 1,
  starting: 2,
  stopping: 3
};

const USAGE_LINES = [
  'Guardian CLI',
  '',
  'Usage:',
  '  guardian start        Start the detector daemon (alias of "guardian daemon start")',
  '  guardian stop         Stop the running daemon (alias of "guardian daemon stop")',
  '  guardian status       Print service status summary',
  '  guardian health       Print health JSON',
  '  guardian ready        Print readiness JSON',
  '  guardian daemon <command>  Run daemon lifecycle commands',
  '  guardian audio <command>   Manage audio capture helpers',
  '  guardian log-level    Get or set the active log level',
  '  guardian retention run [--config path]  Run retention once with current config'
];

const DAEMON_USAGE = [
  'Guardian daemon commands',
  '',
  'Usage:',
  '  guardian daemon start            Start the detector daemon',
  '  guardian daemon stop             Stop the running daemon',
  '  guardian daemon status [--json]  Print service status summary',
  '  guardian daemon health           Print health JSON',
  '  guardian daemon ready            Print readiness JSON',
  '  guardian daemon hooks [options]  Run shutdown hooks without stopping the daemon',
  '  guardian daemon restart [--channel id]  Reset video circuit breakers for a channel',
  '',
  'Options for "hooks":',
  '  -r, --reason <reason>  Override shutdown reason (default: daemon-hooks)',
  '  -s, --signal <signal>  Report the originating signal when recording hooks',
  '  -h, --help             Show this help message'
].join('\n');

const DAEMON_RESTART_USAGE = [
  'Guardian daemon restart command',
  '',
  'Usage:',
  '  guardian daemon restart [--channel id]',
  '',
  'Options:',
  '  -c, --channel <id>  Reset the video circuit breaker for the specified channel',
  '  -h, --help          Show this help message'
].join('\n');

const RETENTION_USAGE = [
  'Guardian retention commands',
  '',
  'Usage:',
  '  guardian retention run [--config path]  Run retention once with current config',
  '',
  'Options:',
  '  -c, --config <path>   Use an alternate configuration file',
  '  -h, --help            Show this help message'
].join('\n');

const AUDIO_USAGE = [
  'Guardian audio commands',
  '',
  'Usage:',
  '  guardian audio devices [options]  List detected audio capture devices',
  '',
  'Options:',
  '  -f, --format <format>  Force ffmpeg format (alsa, avfoundation, dshow, auto)',
  '  -j, --json             Pretty-print JSON output',
  '  -h, --help             Show this help message'
].join('\n');

const LOG_LEVEL_USAGE = [
  'Guardian log level commands',
  '',
  'Usage:',
  '  guardian log-level            Show the current log level',
  '  guardian log-level get        Show the current log level',
  '  guardian log-level set <level>  Change the active log level',
  '  guardian log-level <level>      Shortcut for set',
  '',
  `Available levels: ${getAvailableLogLevels().join(', ')}`
].join('\n');

const VALID_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  'SIGTERM',
  'SIGINT',
  'SIGQUIT',
  'SIGHUP',
  'SIGUSR1',
  'SIGUSR2'
]);

let audioSourceModule: typeof import('./audio/source.js') | null = null;

type DaemonRestartArgs = {
  channel?: string;
  help?: boolean;
  errors: string[];
};

type AudioDevicesArgs = {
  format: 'alsa' | 'avfoundation' | 'dshow' | 'auto';
  json: boolean;
  help: boolean;
  errors: string[];
};

const state: {
  status: ServiceStatus;
  startedAt: number | null;
  runtime: GuardRuntime | null;
  stopResolver: (() => void) | null;
  shuttingDown: boolean;
  shutdownPromise: Promise<void> | null;
  lastShutdownError: Error | null;
  lastShutdownHooks: ShutdownHookSummary[];
  lastShutdownAt: number | null;
  lastShutdownReason: string | null;
  lastShutdownSignal: NodeJS.Signals | null;
} = {
  status: 'idle',
  startedAt: null,
  runtime: null,
  stopResolver: null,
  shuttingDown: false,
  shutdownPromise: null,
  lastShutdownError: null,
  lastShutdownHooks: [],
  lastShutdownAt: null,
  lastShutdownReason: null,
  lastShutdownSignal: null
};

export function getServiceState() {
  return { status: state.status, startedAt: state.startedAt };
}

export async function buildHealthPayload(): Promise<HealthPayload> {
  const snapshot = metrics.snapshot();
  const errorCount = snapshot.logs.byLevel.error ?? 0;
  const fatalCount = snapshot.logs.byLevel.fatal ?? 0;
  const degraded = errorCount > 0 || fatalCount > 0;

  const videoChannels = Object.keys(snapshot.pipelines.ffmpeg.byChannel ?? {}).length;
  const audioChannels = Object.keys(snapshot.pipelines.audio.byChannel ?? {}).length;
  const videoRestarts = snapshot.pipelines.ffmpeg.restarts;
  const audioRestarts = snapshot.pipelines.audio.restarts;
  const metricsCapturedAt = snapshot.createdAt;

  let status: HealthStatus = 'ok';
  if (state.status === 'starting') {
    status = 'starting';
  } else if (state.status === 'stopping') {
    status = 'stopping';
  } else if (degraded) {
    status = 'degraded';
  }

  const uptimeSeconds = state.startedAt ? (Date.now() - state.startedAt) / 1000 : process.uptime();

  const additionalChecks = await collectHealthChecks({
    service: {
      status: state.status,
      startedAt: state.startedAt
    }
  });

  const shutdownSummary = {
    lastAt: state.lastShutdownAt ? new Date(state.lastShutdownAt).toISOString() : null,
    lastReason: state.lastShutdownReason,
    lastSignal: state.lastShutdownSignal,
    lastError: state.lastShutdownError ? state.lastShutdownError.message : null,
    hooks: state.lastShutdownHooks.map(hook => ({ ...hook }))
  } satisfies HealthPayload['application']['shutdown'];

  const integration = getIntegrationManifest();

  return {
    status,
    state: state.status,
    uptimeSeconds,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    timestamp: new Date().toISOString(),
    metricsCapturedAt,
    metricsSummary: {
      pipelines: {
        restarts: {
          video: videoRestarts,
          audio: audioRestarts
        },
        channels: {
          video: videoChannels,
          audio: audioChannels
        },
        lastRestartAt: {
          video: snapshot.pipelines.ffmpeg.lastRestartAt,
          audio: snapshot.pipelines.audio.lastRestartAt
        }
      }
    },
    application: {
      name: packageJson.name ?? 'guardian',
      version: packageJson.version ?? '0.0.0',
      shutdown: shutdownSummary
    },
    integration,
    runtime: {
      pipelines: {
        videoChannels,
        audioChannels,
        videoRestarts,
        audioRestarts
      }
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
      },
      ...additionalChecks
    ],
    metrics: snapshot
  };
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = DEFAULT_IO): Promise<number> {
  if (argv.includes('--health')) {
    return outputHealth(io);
  }

  if (argv.includes('--ready')) {
    return outputReadiness(io);
  }

  const command = argv[0] ?? 'start';

  if (command === 'daemon') {
    return runDaemonCommand(argv.slice(1), io);
  }

  if (command === 'audio') {
    return runAudioCommand(argv.slice(1), io);
  }

  switch (command) {
    case 'start': {
      return startDaemon(io);
    }
    case 'stop': {
      return stopDaemon(io);
    }
    case 'status': {
      const json = argv.includes('--json') || argv.includes('-j');
      return printStatus(io, { json });
    }
    case 'health': {
      return outputHealth(io);
    }
    case 'ready': {
      return outputReadiness(io);
    }
    case 'log-level': {
      return runLogLevelCommand(argv.slice(1), io);
    }
    case 'retention': {
      return runRetentionCommand(argv.slice(1), io);
    }
    case 'help':
    case '--help':
    case '-h': {
      io.stdout.write(`${USAGE_LINES.join('\n')}\n`);
      return 0;
    }
    default: {
      io.stderr.write(`Unknown command: ${command}\n`);
      return 1;
    }
  }
}

async function runDaemonCommand(args: string[], io: CliIo): Promise<number> {
  const [first, ...rest] = args;

  if (!first || first === 'start') {
    return startDaemon(io);
  }

  if (first === 'stop') {
    return stopDaemon(io);
  }

  if (first === 'status') {
    const json = rest.includes('--json') || rest.includes('-j');
    return printStatus(io, { json });
  }

  if (first === 'health') {
    return outputHealth(io);
  }

  if (first === 'ready') {
    return outputReadiness(io);
  }

  if (first === 'hooks') {
    return runDaemonHooksCommand(rest, io);
  }

  if (first === 'restart') {
    return runDaemonRestartCommand(rest, io);
  }

  if (first === 'help' || first === '--help' || first === '-h') {
    io.stdout.write(`${DAEMON_USAGE}\n`);
    return 0;
  }

  if (first.startsWith('-')) {
    io.stderr.write(`Unknown option: ${first}\n`);
    io.stderr.write(`${DAEMON_USAGE}\n`);
    return 1;
  }

  io.stderr.write(`Unknown daemon subcommand: ${first}\n`);
  io.stderr.write(`${DAEMON_USAGE}\n`);
  return 1;
}

async function runAudioCommand(args: string[], io: CliIo): Promise<number> {
  const [first, ...rest] = args;

  if (!first || first === 'devices') {
    return runAudioDevicesCommand(rest, io);
  }

  if (first === 'help' || first === '--help' || first === '-h') {
    io.stdout.write(`${AUDIO_USAGE}\n`);
    return 0;
  }

  if (first.startsWith('-')) {
    io.stderr.write(`Unknown option: ${first}\n`);
    io.stderr.write(`${AUDIO_USAGE}\n`);
    return 1;
  }

  io.stderr.write(`Unknown audio subcommand: ${first}\n`);
  io.stderr.write(`${AUDIO_USAGE}\n`);
  return 1;
}

function parseDaemonRestartArgs(args: string[]): DaemonRestartArgs {
  const result: DaemonRestartArgs = { errors: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--channel' || token === '-c') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        result.errors.push('Missing value for --channel');
      } else {
        result.channel = value;
        index += 1;
      }
      continue;
    }
    result.errors.push(`Unknown option: ${token}`);
  }
  return result;
}

function parseAudioDevicesArgs(args: string[]): AudioDevicesArgs {
  const allowedFormats = new Set(['alsa', 'avfoundation', 'dshow', 'auto']);
  const result: AudioDevicesArgs = {
    format: 'auto',
    json: false,
    help: false,
    errors: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }

    if (token === '--format' || token === '-f') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        result.errors.push('Missing value for --format');
      } else {
        const normalized = value.toLowerCase();
        if (!allowedFormats.has(normalized)) {
          result.errors.push(
            `Invalid format "${value}" (expected: ${Array.from(allowedFormats).join(', ')})`
          );
        } else {
          result.format = normalized as AudioDevicesArgs['format'];
        }
        index += 1;
      }
      continue;
    }

    if (token === '--json' || token === '-j') {
      result.json = true;
      continue;
    }

    result.errors.push(`Unknown option: ${token}`);
  }

  return result;
}

async function runDaemonRestartCommand(args: string[], io: CliIo): Promise<number> {
  const parsed = parseDaemonRestartArgs(args);
  if (parsed.help) {
    io.stdout.write(`${DAEMON_RESTART_USAGE}\n`);
    return 0;
  }

  if (parsed.errors.length > 0) {
    parsed.errors.forEach(error => {
      io.stderr.write(`${error}\n`);
    });
    io.stderr.write(`${DAEMON_RESTART_USAGE}\n`);
    return 1;
  }

  const channel = parsed.channel?.trim();
  if (!channel) {
    io.stderr.write('Missing required --channel option\n');
    io.stderr.write(`${DAEMON_RESTART_USAGE}\n`);
    return 1;
  }

  if (state.status !== 'running' || !state.runtime) {
    io.stderr.write('Guardian daemon is not running\n');
    return 1;
  }

  const reset = state.runtime.resetCircuitBreaker;
  if (typeof reset !== 'function') {
    io.stderr.write('Daemon runtime does not support circuit breaker resets\n');
    return 1;
  }

  const triggered = reset(channel);
  if (!triggered) {
    const snapshot = metrics.snapshot();
    const byChannel = snapshot.pipelines.ffmpeg.byChannel ?? {};
    const normalized = channel.trim().toLowerCase();
    const knownChannels = new Set<string>();

    for (const key of Object.keys(byChannel)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      const normalizedKey = trimmed.toLowerCase();
      knownChannels.add(normalizedKey);
      if (trimmed.startsWith('video:')) {
        knownChannels.add(trimmed.slice('video:'.length).trim().toLowerCase());
      }
    }

    if (!knownChannels.has(normalized)) {
      io.stderr.write(`Channel not found: ${channel}\n`);
      return 1;
    }

    io.stderr.write(`No circuit breaker reset performed for channel ${channel}\n`);
    return 1;
  }

  io.stdout.write(`Requested circuit breaker reset for channel ${channel}\n`);
  return 0;
}

async function runAudioDevicesCommand(args: string[], io: CliIo): Promise<number> {
  const parsed = parseAudioDevicesArgs(args);

  if (parsed.help) {
    io.stdout.write(`${AUDIO_USAGE}\n`);
    return 0;
  }

  if (parsed.errors.length > 0) {
    parsed.errors.forEach(error => {
      io.stderr.write(`${error}\n`);
    });
    io.stderr.write(`${AUDIO_USAGE}\n`);
    return 1;
  }

  try {
    if (!audioSourceModule) {
      audioSourceModule = await import('./audio/source.js');
    }

    const AudioSource = audioSourceModule.default;

    const devices = await AudioSource.listDevices(parsed.format, {
      channel: 'cli:audio-devices'
    });

    const payload = {
      format: parsed.format,
      devices
    };

    const indent = parsed.json ? 2 : 0;
    const json = JSON.stringify(payload, null, indent);
    io.stdout.write(`${json}\n`);
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'Audio device discovery failed via CLI');
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to list audio devices: ${message}\n`);
    return 1;
  }
}

type DaemonHooksArgs = {
  help: boolean;
  errors: string[];
  reason: string;
  signal?: NodeJS.Signals;
};

function parseDaemonHooksArgs(args: string[]): DaemonHooksArgs {
  const result: DaemonHooksArgs = {
    help: false,
    errors: [],
    reason: 'daemon-hooks'
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--reason' || token === '-r') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        result.errors.push('Missing value for --reason');
      } else {
        result.reason = value;
        index += 1;
      }
      continue;
    }
    if (token === '--signal' || token === '-s') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        result.errors.push('Missing value for --signal');
      } else {
        const upper = value.toUpperCase();
        if (VALID_SIGNALS.has(upper as NodeJS.Signals)) {
          result.signal = upper as NodeJS.Signals;
        } else {
          result.errors.push(`Unknown signal: ${value}`);
        }
        index += 1;
      }
      continue;
    }
    result.errors.push(`Unknown option: ${token}`);
  }

  return result;
}

type ShutdownHookExecution = {
  summaries: ShutdownHookSummary[];
  summary: { ok: number; failed: number };
  error: Error | null;
};

async function executeShutdownHooks(context: { reason: string; signal?: NodeJS.Signals }): Promise<ShutdownHookExecution> {
  const results = await runShutdownHooks(context);
  const summaries: ShutdownHookSummary[] = [];
  let ok = 0;
  let failed = 0;
  let firstError: Error | null = null;

  for (const result of results) {
    if (result.status === 'error') {
      const error = result.error ?? new Error('shutdown hook failed');
      if (!firstError) {
        firstError = error;
      }
      failed += 1;
      summaries.push({
        name: result.name,
        status: 'error',
        error: error.message ?? String(error)
      });
      logger.error({ err: error, hook: result.name }, 'Shutdown hook failed');
    } else {
      ok += 1;
      summaries.push({ name: result.name, status: 'ok' });
      logger.debug({ hook: result.name }, 'Shutdown hook executed');
    }
  }

  const summary = { ok, failed };
  logger.info({ hooks: summaries, summary }, 'Shutdown hooks completed');

  return { summaries, summary, error: firstError };
}

async function runDaemonHooksCommand(args: string[], io: CliIo): Promise<number> {
  const parsed = parseDaemonHooksArgs(args);

  if (parsed.help) {
    io.stdout.write(`${DAEMON_USAGE}\n`);
    return 0;
  }

  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) {
      io.stderr.write(`${message}\n`);
    }
    return 1;
  }

  try {
    const { summaries, summary, error } = await executeShutdownHooks({
      reason: parsed.reason,
      signal: parsed.signal
    });
    state.lastShutdownHooks = summaries;
    state.lastShutdownAt = Date.now();
    state.lastShutdownReason = parsed.reason;
    state.lastShutdownSignal = parsed.signal ?? null;
    state.lastShutdownError = error;

    io.stdout.write(`Shutdown hooks executed: ${summary.ok} ok, ${summary.failed} failed\n`);
    if (summary.failed > 0) {
      for (const hook of summaries) {
        if (hook.status === 'error') {
          const message = hook.error ?? 'unknown error';
          io.stderr.write(`Hook ${hook.name} failed: ${message}\n`);
        }
      }
    }

    return summary.failed > 0 ? 1 : 0;
  } catch (error) {
    const err = error as Error;
    const message = err.message ?? String(err);
    io.stderr.write(`Failed to execute shutdown hooks: ${message}\n`);
    return 1;
  }
}

async function runRetentionCommand(args: string[], io: CliIo): Promise<number> {
  if (args.length === 0) {
    return runRetentionRun(args, io);
  }

  const [first, ...rest] = args;
  if (first === 'help' || first === '--help' || first === '-h') {
    io.stdout.write(`${RETENTION_USAGE}\n`);
    return 0;
  }

  if (first === 'run') {
    return runRetentionRun(rest, io);
  }

  if (first.startsWith('-')) {
    return runRetentionRun(args, io);
  }

  io.stderr.write(`Unknown retention subcommand: ${first}\n`);
  return 1;
}

async function runLogLevelCommand(args: string[], io: CliIo): Promise<number> {
  const [first, second] = args;
  const available = getAvailableLogLevels();

  if (!first || first === 'get') {
    io.stdout.write(`${getLogLevel()}\n`);
    return 0;
  }

  if (first === 'help' || first === '--help' || first === '-h') {
    io.stdout.write(`${LOG_LEVEL_USAGE}\n`);
    return 0;
  }

  if (first === 'set') {
    if (!second) {
      io.stderr.write('Missing value for log level\n');
      io.stderr.write(`${LOG_LEVEL_USAGE}\n`);
      return 1;
    }
    return applyLogLevel(second, io);
  }

  if (first.startsWith('-')) {
    io.stderr.write(`Unknown option: ${first}\n`);
    io.stderr.write(`${LOG_LEVEL_USAGE}\n`);
    return 1;
  }

  if (!available.includes(first.toLowerCase())) {
    io.stderr.write(
      `Unknown log level "${first}" (available: ${available.join(', ')})\n`
    );
    return 1;
  }

  return applyLogLevel(first, io);
}

function applyLogLevel(level: string, io: CliIo): number {
  try {
    const normalized = setLogLevel(level);
    io.stdout.write(`Log level set to ${normalized}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

async function runRetentionRun(args: string[], io: CliIo): Promise<number> {
  const parsed = parseRetentionRunArgs(args);
  if (parsed.help) {
    io.stdout.write(`${RETENTION_USAGE}\n`);
    return 0;
  }

  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) {
      io.stderr.write(`${message}\n`);
    }
    return 1;
  }

  let config: GuardianConfig;
  try {
    config = parsed.configPath ? loadConfigFromFile(parsed.configPath) : configManager.getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to load configuration: ${message}\n`);
    logger.error({ err: error }, 'Retention CLI failed to load configuration');
    return 1;
  }

  let retentionOptions: RetentionTaskOptions | null;
  try {
    const module = await import('./run-guard.js');
    const buildRetentionOptions = module.buildRetentionOptions as typeof import('./run-guard.js')['buildRetentionOptions'];
    retentionOptions = buildRetentionOptions({
      retention: config.events?.retention,
      video: config.video,
      person: config.person,
      logger
    });
  } catch (error) {
    logger.error({ err: error }, 'Retention CLI failed to prepare options');
    io.stderr.write('Failed to prepare retention options. Check logs for details.\n');
    return 1;
  }

  if (!retentionOptions) {
    io.stdout.write('Retention task skipped (retention disabled or not configured)\n');
    return 0;
  }

  const runOptions: RetentionTaskOptions = { ...retentionOptions, metrics };

  try {
    const result = await runRetentionOnce(runOptions);
    if (result.skipped) {
      io.stdout.write('Retention task skipped (retention disabled or not configured)\n');
      return 0;
    }

    const totals = result.outcome ?? {
      removedEvents: 0,
      archivedSnapshots: 0,
      prunedArchives: 0,
      warnings: [],
      perCamera: {}
    };
    const warningCount = result.warnings.length;
    const vacuumLabel = result.vacuum.ran
      ? `${result.vacuum.mode} (run=${result.vacuum.runMode})`
      : `skipped (run=${result.vacuum.runMode})`;

    io.stdout.write(
      `Retention task completed: removed=${totals.removedEvents}, archived=${totals.archivedSnapshots}, ` +
        `pruned=${totals.prunedArchives}, warnings=${warningCount}, vacuum=${vacuumLabel}\n`
    );
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'Retention CLI execution failed');
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Retention task failed: ${message}\n`);
    return 1;
  }
}

type RetentionCliArgs = {
  configPath?: string;
  help?: boolean;
  errors: string[];
};

function parseRetentionRunArgs(args: string[]): RetentionCliArgs {
  const result: RetentionCliArgs = { errors: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--config' || token === '-c') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        result.errors.push('Missing value for --config');
      } else {
        result.configPath = value;
        index += 1;
      }
      continue;
    }
    result.errors.push(`Unknown option: ${token}`);
  }
  return result;
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

  let runtime: GuardRuntime;
  try {
    runtime = await metrics.time('guard.startup.ms', () => startGuard());
  } catch (error) {
    state.status = 'stopped';
    state.runtime = null;
    logger.error({ err: error }, 'Guardian daemon failed to start');
    io.stderr.write('Guardian daemon failed to start. Check logs for details.\n');
    return 1;
  }

  if (state.status !== 'starting') {
    try {
      await Promise.resolve(runtime.stop());
    } catch (error) {
      logger.warn({ err: error }, 'Guardian runtime stop failed after aborted start');
    }
    const abortedMessage = state.lastShutdownError
      ? 'Guardian daemon start aborted due to shutdown error\n'
      : 'Guardian daemon start aborted by shutdown request\n';
    io.stderr.write(abortedMessage);
    return state.lastShutdownError ? 1 : 0;
  }

  state.runtime = runtime;
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

async function stopDaemon(io: CliIo): Promise<number> {
  if ((state.status === 'idle' || state.status === 'stopped') && !state.runtime) {
    state.lastShutdownAt = null;
    state.lastShutdownError = null;
    state.lastShutdownHooks = [];
    state.lastShutdownReason = null;
    state.lastShutdownSignal = null;
    io.stdout.write('Guardian daemon is not running\n');
    return 0;
  }

  const error = await performShutdown('cli-stop');
  if (error) {
    io.stderr.write('Guardian daemon encountered an error while stopping. Check logs for details.\n');
    return 1;
  }

  const payload = await buildHealthPayload();
  if (state.lastShutdownHooks.length > 0) {
    const failures = state.lastShutdownHooks.filter(hook => hook.status === 'error');
    const successes = state.lastShutdownHooks.length - failures.length;
    io.stdout.write(`Shutdown hooks executed: ${successes} ok, ${failures.length} failed\n`);
    for (const hook of failures) {
      const message = hook.error ?? 'unknown error';
      io.stderr.write(`Hook ${hook.name} failed: ${message}\n`);
    }
  }
  io.stdout.write(`Guardian daemon stopped (status: ${payload.status})\n`);
  return resolveHealthExitCode(payload.status);
}

async function printStatus(io: CliIo, options: { json?: boolean } = {}): Promise<number> {
  const payload = await buildHealthPayload();
  if (options.json) {
    io.stdout.write(`${JSON.stringify(payload)}\n`);
    return resolveHealthExitCode(payload.status);
  }
  const summary = [`Guardian status: ${payload.state}`, `Health: ${payload.status}`];

  const lastError = payload.metrics.logs.lastErrorMessage;
  if (lastError) {
    summary.push(`Last error: ${lastError}`);
  }

  if (payload.metrics.pipelines.ffmpeg.restarts > 0 || payload.metrics.pipelines.audio.restarts > 0) {
    summary.push(
      `Restarts - video: ${payload.metrics.pipelines.ffmpeg.restarts}, audio: ${payload.metrics.pipelines.audio.restarts}`
    );
  }

  io.stdout.write(summary.join('\n') + '\n');
  return resolveHealthExitCode(payload.status);
}

function registerSignalHandlers() {
  const handleSignal = (signal: NodeJS.Signals) => {
    void performShutdown('signal', signal);
  };

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT'];
  for (const signal of signals) {
    process.once(signal, handleSignal);
  }
}

function resolveHealthExitCode(status: HealthStatus) {
  return HEALTH_EXIT_CODES[status] ?? 1;
}

export { resolveHealthExitCode };

async function performShutdown(reason: string, signal?: NodeJS.Signals): Promise<Error | null> {
  if (state.status === 'idle' || state.status === 'stopped') {
    return null;
  }

  if (state.shuttingDown && state.shutdownPromise) {
    await state.shutdownPromise;
    return state.lastShutdownError;
  }

  state.shuttingDown = true;
  state.status = 'stopping';
  state.lastShutdownError = null;
  state.lastShutdownHooks = [];
  state.lastShutdownReason = reason;
  state.lastShutdownSignal = signal ?? null;
  state.lastShutdownAt = Date.now();
  logger.info({ reason, signal }, 'Guardian daemon shutting down');

  const shutdownTask = (async () => {
    const runtime = state.runtime;
    let shutdownDurationMs: number | null = null;
    try {
      const startedAt = performance.now();
      await metrics.time('guard.shutdown.ms', async () => {
        if (runtime) {
          await Promise.resolve(runtime.stop());
        }
      });
      shutdownDurationMs = performance.now() - startedAt;
    } catch (error) {
      const err = error as Error;
      state.lastShutdownError = err;
      logger.error({ err }, 'Error during shutdown');
    } finally {
      try {
        const { summaries, error: hookError } = await executeShutdownHooks({ reason, signal });
        state.lastShutdownHooks = summaries;
        if (hookError && !state.lastShutdownError) {
          state.lastShutdownError = hookError;
        }
      } catch (hookError) {
        const err = hookError as Error;
        logger.error({ err }, 'Shutdown hooks threw unexpectedly');
        if (!state.lastShutdownError) {
          state.lastShutdownError = err;
        }
        state.lastShutdownHooks = [
          {
            name: 'shutdown-hooks',
            status: 'error',
            error: err.message ?? String(err)
          }
        ];
      }

      state.runtime = null;
      state.status = 'stopped';
      state.startedAt = null;
      state.stopResolver?.();
      state.stopResolver = null;
      state.shuttingDown = false;
      state.shutdownPromise = null;
      if (shutdownDurationMs !== null) {
        logger.info({ reason, signal, shutdownDurationMs }, 'Guardian daemon stopped gracefully');
      }
    }
  })();

  state.shutdownPromise = shutdownTask;
  await shutdownTask;
  return state.lastShutdownError;
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

async function outputHealth(io: CliIo): Promise<number> {
  const payload = await buildHealthPayload();
  io.stdout.write(`${JSON.stringify(payload)}\n`);
  return resolveHealthExitCode(payload.status);
}

function buildReadinessPayload(health: HealthPayload): ReadinessPayload {
  const ready = health.status === 'ok' && health.state === 'running';
  let reason: string | null = null;

  if (!ready) {
    if (health.state !== 'running') {
      reason = `service-${health.state}`;
    } else if (health.status !== 'ok') {
      reason = `health-${health.status}`;
    }
  }

  return {
    ready,
    status: health.status,
    state: health.state,
    timestamp: health.timestamp,
    startedAt: health.startedAt,
    reason,
    metrics: {
      restarts: {
        video: health.runtime.pipelines.videoRestarts,
        audio: health.runtime.pipelines.audioRestarts
      },
      channels: {
        video: health.runtime.pipelines.videoChannels,
        audio: health.runtime.pipelines.audioChannels
      },
      snapshotCapturedAt: health.metricsCapturedAt
    }
  } satisfies ReadinessPayload;
}

async function outputReadiness(io: CliIo): Promise<number> {
  const health = await buildHealthPayload();
  const readiness = buildReadinessPayload(health);
  io.stdout.write(`${JSON.stringify(readiness)}\n`);
  return readiness.ready ? 0 : 1;
}

export { buildReadinessPayload };
