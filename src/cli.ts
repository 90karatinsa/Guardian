import process from 'node:process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import logger, { getAvailableLogLevels, getLogLevel, setLogLevel } from './logger.js';
import metrics, { type MetricsSnapshot } from './metrics/index.js';
import { canonicalChannel } from './utils/channel.js';
import {
  collectHealthChecks,
  runShutdownHooks,
  getIntegrationManifest,
  type IntegrationManifest
} from './app.js';
import configManager, { loadConfigFromFile, type GuardianConfig } from './config/index.js';
import { runRetentionOnce, type RetentionTaskOptions } from './tasks/retention.js';
import packageJson from '../package.json' assert { type: 'json' };
import type { RestartSeverityLevel } from './pipeline/channelHealth.js';

type ServiceStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

type HealthStatus = 'ok' | 'starting' | 'stopping' | 'degraded';

type CliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type GuardRuntime = {
  stop: () => void | Promise<void>;
  resetCircuitBreaker: (identifier: string) => boolean;
  resetChannelHealth: (identifier: string) => boolean;
  resetTransportFallback?: (identifier: string) => boolean;
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
  pipelines: {
    ffmpeg: PipelineHealthSummary;
    audio: PipelineHealthSummary;
  };
  metricsSummary: {
    pipelines: {
      restarts: {
        video: number;
        audio: number;
      };
      watchdogRestarts: {
        video: number;
        audio: number;
      };
      watchdogBackoffMs: {
        video: number;
        audio: number;
      };
      lastWatchdogJitterMs: {
        video: number | null;
        audio: number | null;
      };
      channels: {
        video: number;
        audio: number;
      };
      lastRestartAt: {
        video: string | null;
        audio: string | null;
      };
      transportFallbacks: {
        video: {
          total: number;
          last: MetricsSnapshot['pipelines']['ffmpeg']['transportFallbacks']['last'];
          byChannel: TransportFallbackChannelSummary[];
        };
        audio: {
          total: number;
          last: MetricsSnapshot['pipelines']['audio']['transportFallbacks']['last'];
          byChannel: TransportFallbackChannelSummary[];
        };
      };
    };
    retention: RetentionSummary;
  };
  runtime: {
    pipelines: {
      videoChannels: number;
      audioChannels: number;
      videoRestarts: number;
      audioRestarts: number;
      videoWatchdogRestarts: number;
      audioWatchdogRestarts: number;
      videoWatchdogBackoffMs: number;
      audioWatchdogBackoffMs: number;
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

type PipelineChannelStatus = {
  degraded: boolean;
  severity: RestartSeverityLevel;
  reason: string | null;
  degradedSince: string | null;
  restarts: number;
  backoffMs: number;
  watchdogRestarts: number;
  watchdogBackoffMs: number;
};

type PipelineHealthSummary = {
  channels: Record<string, PipelineChannelStatus>;
  degraded: string[];
  totalDegraded: number;
};

type TransportFallbackChannelSummary = {
  channel: string;
  total: number;
  lastReason: string | null;
  lastAt: string | null;
};

type RetentionSummary = {
  runs: number;
  warnings: number;
  totals: MetricsSnapshot['retention']['totals'];
  totalsByCamera: MetricsSnapshot['retention']['totalsByCamera'];
};

type TransportFallbackChannelSnapshots =
  MetricsSnapshot['pipelines']['ffmpeg']['transportFallbacks']['byChannel'];

function buildPipelineHealthSummary(
  channels: Record<
    string,
    MetricsSnapshot['pipelines']['ffmpeg']['byChannel'][string]
  >
): PipelineHealthSummary {
  const result: PipelineHealthSummary = {
    channels: {},
    degraded: [],
    totalDegraded: 0
  };

  const entries = Object.entries(channels).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, snapshot] of entries) {
    const health = snapshot.health;
    const degraded = health.severity !== 'none';
    const status: PipelineChannelStatus = {
      degraded,
      severity: health.severity,
      reason: health.reason ?? null,
      degradedSince: health.degradedSince ?? null,
      restarts: typeof health.restarts === 'number' ? health.restarts : snapshot.watchdogRestarts,
      backoffMs:
        typeof health.backoffMs === 'number' ? health.backoffMs : snapshot.totalWatchdogBackoffMs,
      watchdogRestarts: snapshot.watchdogRestarts,
      watchdogBackoffMs: snapshot.totalWatchdogBackoffMs
    };
    result.channels[channel] = status;
    if (degraded) {
      result.degraded.push(channel);
    }
  }

  if (result.degraded.length > 1) {
    const priority: Record<RestartSeverityLevel, number> = {
      none: 2,
      warning: 1,
      critical: 0
    };
    result.degraded.sort((left, right) => {
      const leftSeverity = result.channels[left]?.severity ?? 'none';
      const rightSeverity = result.channels[right]?.severity ?? 'none';
      const delta = priority[leftSeverity] - priority[rightSeverity];
      if (delta !== 0) {
        return delta;
      }
      return left.localeCompare(right);
    });
  }

  result.totalDegraded = result.degraded.length;
  return result;
}

function summarizeTransportFallbackChannels(
  channels: TransportFallbackChannelSnapshots | undefined
): TransportFallbackChannelSummary[] {
  if (!channels) {
    return [];
  }

  return Object.entries(channels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, snapshot]) => ({
      channel,
      total: snapshot.total,
      lastReason: snapshot.last?.reason ?? null,
      lastAt: snapshot.last?.at ?? null
    }));
}

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
  '  guardian daemon pipelines <command>  Inspect or reset pipeline health state',
  '  guardian daemon hooks [options]  Run shutdown hooks without stopping the daemon',
  '  guardian daemon restart [--channel id] [--transport id]  Reset pipeline circuit breakers or transport fallbacks',
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
  '  guardian daemon restart [--channel id] [--transport id]',
  '',
  'Options:',
  '  -c, --channel <id>  Reset the circuit breaker for the specified channel (video or audio)',
  '  -t, --transport <id>  Reset the RTSP transport fallback ladder for the specified video channel',
  '  -h, --help          Show this help message',
  '',
  'Examples:',
  '  guardian daemon restart --channel video:front-door',
  '  guardian daemon restart --channel audio:microphone',
  '  guardian daemon restart --transport video:back-lot'
].join('\n');

const DAEMON_PIPELINES_USAGE = [
  'Guardian daemon pipelines commands',
  '',
  'Usage:',
  '  guardian daemon pipelines list [--json]  List pipeline channel health state',
  '  guardian daemon pipelines reset --channel <id>  Reset video watchdog health counters',
  '',
  'Options for "list":',
  '  -j, --json           Output JSON',
  '  -h, --help           Show this help message',
  '',
  'Options for "reset":',
  '  -c, --channel <id>   Video channel identifier (e.g., video:front)',
  '  -h, --help           Show this help message'
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
  transport?: string;
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

function resetServiceState() {
  state.status = 'idle';
  state.startedAt = null;
  state.runtime = null;
  state.stopResolver = null;
  state.shuttingDown = false;
  state.shutdownPromise = null;
  state.lastShutdownError = null;
  state.lastShutdownHooks = [];
  state.lastShutdownAt = null;
  state.lastShutdownReason = null;
  state.lastShutdownSignal = null;
}

export function getServiceState() {
  return { status: state.status, startedAt: state.startedAt };
}

export async function buildHealthPayload(): Promise<HealthPayload> {
  const snapshot = metrics.snapshot();
  const errorCount = snapshot.logs.byLevel.error ?? 0;
  const fatalCount = snapshot.logs.byLevel.fatal ?? 0;
  const ffmpegHealth = buildPipelineHealthSummary(snapshot.pipelines.ffmpeg.byChannel ?? {});
  const audioHealth = buildPipelineHealthSummary(snapshot.pipelines.audio.byChannel ?? {});
  const ffmpegFallbackChannels = summarizeTransportFallbackChannels(
    snapshot.pipelines.ffmpeg.transportFallbacks.byChannel
  );
  const audioFallbackChannels = summarizeTransportFallbackChannels(
    snapshot.pipelines.audio.transportFallbacks.byChannel
  );
  const pipelinesDegraded =
    ffmpegHealth.totalDegraded > 0 || audioHealth.totalDegraded > 0;
  const degraded = errorCount > 0 || fatalCount > 0 || pipelinesDegraded;

  const videoChannels = Object.keys(snapshot.pipelines.ffmpeg.byChannel ?? {}).length;
  const audioChannels = Object.keys(snapshot.pipelines.audio.byChannel ?? {}).length;
  const videoRestarts = snapshot.pipelines.ffmpeg.restarts;
  const audioRestarts = snapshot.pipelines.audio.restarts;
  const videoWatchdogRestarts = snapshot.pipelines.ffmpeg.watchdogRestarts;
  const audioWatchdogRestarts = snapshot.pipelines.audio.watchdogRestarts;
  const videoWatchdogBackoffMs = snapshot.pipelines.ffmpeg.watchdogBackoffMs;
  const audioWatchdogBackoffMs = snapshot.pipelines.audio.watchdogBackoffMs;
  const lastVideoWatchdogJitter = snapshot.pipelines.ffmpeg.lastWatchdogJitterMs ?? null;
  const lastAudioWatchdogJitter = snapshot.pipelines.audio.lastWatchdogJitterMs ?? null;
  const metricsCapturedAt = snapshot.createdAt;

  const retentionTotals = { ...snapshot.retention.totals };
  const retentionTotalsByCamera = Object.fromEntries(
    Object.entries(snapshot.retention.totalsByCamera ?? {}).map(([camera, totals]) => [
      camera,
      { ...totals }
    ])
  ) as MetricsSnapshot['retention']['totalsByCamera'];
  const retentionSummary: RetentionSummary = {
    runs: snapshot.retention.runs,
    warnings: snapshot.retention.warnings,
    totals: retentionTotals,
    totalsByCamera: retentionTotalsByCamera
  };

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
    pipelines: {
      ffmpeg: ffmpegHealth,
      audio: audioHealth
    },
    metricsSummary: {
      pipelines: {
        restarts: {
          video: videoRestarts,
          audio: audioRestarts
        },
        watchdogRestarts: {
          video: videoWatchdogRestarts,
          audio: audioWatchdogRestarts
        },
        watchdogBackoffMs: {
          video: videoWatchdogBackoffMs,
          audio: audioWatchdogBackoffMs
        },
        lastWatchdogJitterMs: {
          video: lastVideoWatchdogJitter,
          audio: lastAudioWatchdogJitter
        },
        channels: {
          video: videoChannels,
          audio: audioChannels
        },
        lastRestartAt: {
          video: snapshot.pipelines.ffmpeg.lastRestartAt,
          audio: snapshot.pipelines.audio.lastRestartAt
        },
        transportFallbacks: {
          video: {
            total: snapshot.pipelines.ffmpeg.transportFallbacks.total,
            last: snapshot.pipelines.ffmpeg.transportFallbacks.last,
            byChannel: ffmpegFallbackChannels
          },
          audio: {
            total: snapshot.pipelines.audio.transportFallbacks.total,
            last: snapshot.pipelines.audio.transportFallbacks.last,
            byChannel: audioFallbackChannels
          }
        }
      },
      retention: retentionSummary
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
        audioRestarts,
        videoWatchdogRestarts,
        audioWatchdogRestarts,
        videoWatchdogBackoffMs,
        audioWatchdogBackoffMs
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

  if (first === 'pipelines') {
    return runDaemonPipelinesCommand(rest, io);
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
    if (token === '--transport' || token === '-t') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        result.errors.push('Missing value for --transport');
      } else {
        result.transport = value;
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

type DaemonPipelineListArgs = {
  json: boolean;
  help: boolean;
  errors: string[];
};

type DaemonPipelineResetArgs = {
  channel?: string;
  help: boolean;
  errors: string[];
};

function parseDaemonPipelineListArgs(args: string[]): DaemonPipelineListArgs {
  const result: DaemonPipelineListArgs = { json: false, help: false, errors: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === '--json' || token === '-j') {
      result.json = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    result.errors.push(`Unknown option: ${token}`);
  }
  return result;
}

function parseDaemonPipelineResetArgs(args: string[]): DaemonPipelineResetArgs {
  const result: DaemonPipelineResetArgs = { errors: [], help: false };
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
  const transport = parsed.transport?.trim();

  if (channel && transport) {
    io.stderr.write('Specify either --channel or --transport, not both\n');
    io.stderr.write(`${DAEMON_RESTART_USAGE}\n`);
    return 1;
  }

  if (!channel && !transport) {
    io.stderr.write('Missing required --channel or --transport option\n');
    io.stderr.write(`${DAEMON_RESTART_USAGE}\n`);
    return 1;
  }

  if (state.status !== 'running' || !state.runtime) {
    io.stderr.write('Guardian daemon is not running\n');
    return 1;
  }

  if (transport) {
    const canonicalVideo = canonicalChannel(transport);
    if (!canonicalVideo || !canonicalVideo.toLowerCase().startsWith('video:')) {
      io.stderr.write('Transport resets require a video channel identifier\n');
      return 1;
    }

    const resetTransport = state.runtime.resetTransportFallback;
    if (typeof resetTransport !== 'function') {
      io.stderr.write('Daemon runtime does not support transport fallback resets\n');
      return 1;
    }

    const triggered = resetTransport(transport);
    if (!triggered) {
      const snapshot = metrics.snapshot();
      const ffmpegChannels = snapshot.pipelines.ffmpeg.byChannel ?? {};
      const knownChannels = new Set<string>();

      const registerChannel = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return;
        }
        knownChannels.add(trimmed.toLowerCase());
        if (trimmed.toLowerCase().startsWith('video:')) {
          knownChannels.add(trimmed.slice('video:'.length).trim().toLowerCase());
        }
        const canonicalKey = canonicalChannel(trimmed);
        if (canonicalKey) {
          knownChannels.add(canonicalKey.toLowerCase());
        }
      };

      for (const key of Object.keys(ffmpegChannels)) {
        registerChannel(key);
      }

      const lookup = canonicalVideo.toLowerCase();
      if (!knownChannels.has(lookup)) {
        io.stderr.write(`channel not found: ${canonicalVideo}\n`);
        return 1;
      }

      io.stderr.write(`No transport fallback reset performed for video channel ${canonicalVideo}\n`);
      return 1;
    }

    io.stdout.write(`Requested transport fallback reset for video channel ${canonicalVideo}\n`);
    return 0;
  }

  const canonicalVideo = canonicalChannel(channel!);
  const canonicalAudio = canonicalChannel(channel!, { defaultType: 'audio' });
  const normalizedInput = channel!.toLowerCase();
  const isAudioChannel = normalizedInput.startsWith('audio:') || canonicalVideo.startsWith('audio:');
  const canonicalTarget = (isAudioChannel ? canonicalAudio : canonicalVideo) || channel!;
  const typeLabel = isAudioChannel ? 'audio' : 'video';

  const reset = state.runtime.resetCircuitBreaker;
  if (typeof reset !== 'function') {
    io.stderr.write('Daemon runtime does not support circuit breaker resets\n');
    return 1;
  }

  const triggered = reset(channel!);
  if (!triggered) {
    const snapshot = metrics.snapshot();
    const ffmpegChannels = snapshot.pipelines.ffmpeg.byChannel ?? {};
    const audioChannels = snapshot.pipelines.audio.byChannel ?? {};
    const knownChannels = new Set<string>();

    const registerChannel = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      const lower = trimmed.toLowerCase();
      knownChannels.add(lower);
      if (trimmed.toLowerCase().startsWith('video:')) {
        knownChannels.add(trimmed.slice('video:'.length).trim().toLowerCase());
      }
      if (trimmed.toLowerCase().startsWith('audio:')) {
        knownChannels.add(trimmed.slice('audio:'.length).trim().toLowerCase());
      }
      const canonicalVideoKey = canonicalChannel(trimmed);
      if (canonicalVideoKey) {
        knownChannels.add(canonicalVideoKey.toLowerCase());
      }
      const canonicalAudioKey = canonicalChannel(trimmed, { defaultType: 'audio' });
      if (canonicalAudioKey) {
        knownChannels.add(canonicalAudioKey.toLowerCase());
      }
    };

    for (const key of Object.keys(ffmpegChannels)) {
      registerChannel(key);
    }
    for (const key of Object.keys(audioChannels)) {
      registerChannel(key);
    }

    const videoLookup = canonicalVideo.toLowerCase();
    const audioLookup = canonicalAudio.toLowerCase();
    if (!knownChannels.has(videoLookup) && !knownChannels.has(audioLookup)) {
      io.stderr.write(`channel not found: ${canonicalTarget}\n`);
      return 1;
    }

    io.stderr.write(`No circuit breaker reset performed for ${typeLabel} channel ${canonicalTarget}\n`);
    return 1;
  }

  io.stdout.write(`Requested circuit breaker reset for ${typeLabel} channel ${canonicalTarget}\n`);
  return 0;
}

async function runDaemonPipelinesCommand(args: string[], io: CliIo): Promise<number> {
  const [first, ...rest] = args;
  let subcommand = first;
  let options = rest;

  if (!subcommand || subcommand.startsWith('-')) {
    options = args;
    subcommand = 'list';
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    io.stdout.write(`${DAEMON_PIPELINES_USAGE}\n`);
    return 0;
  }

  if (subcommand === 'list') {
    const parsed = parseDaemonPipelineListArgs(options);
    if (parsed.help) {
      io.stdout.write(`${DAEMON_PIPELINES_USAGE}\n`);
      return 0;
    }
    if (parsed.errors.length > 0) {
      parsed.errors.forEach(error => io.stderr.write(`${error}\n`));
      io.stderr.write(`${DAEMON_PIPELINES_USAGE}\n`);
      return 1;
    }

    const snapshot = metrics.snapshot();
    const ffmpeg = buildPipelineHealthSummary(snapshot.pipelines.ffmpeg.byChannel ?? {});
    const audio = buildPipelineHealthSummary(snapshot.pipelines.audio.byChannel ?? {});
    const payload = { pipelines: { ffmpeg, audio } };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(payload)}\n`);
      return 0;
    }

    io.stdout.write('Pipeline health summary:\n');
    const sections: Array<{ label: string; summary: PipelineHealthSummary }> = [
      { label: 'video', summary: ffmpeg },
      { label: 'audio', summary: audio }
    ];
    for (const section of sections) {
      const entries = Object.entries(section.summary.channels);
      if (entries.length === 0) {
        io.stdout.write(`  ${section.label}: no channels\n`);
        continue;
      }
      for (const [channel, status] of entries) {
        const stateLabel = status.degraded
          ? `${status.severity} (restarts=${status.watchdogRestarts}, backoffMs=${status.watchdogBackoffMs})`
          : 'ok';
        io.stdout.write(`  ${channel} [${section.label}]: ${stateLabel}\n`);
      }
    }
    return 0;
  }

  if (subcommand === 'reset') {
    const parsed = parseDaemonPipelineResetArgs(options);
    if (parsed.help) {
      io.stdout.write(`${DAEMON_PIPELINES_USAGE}\n`);
      return 0;
    }
    if (parsed.errors.length > 0) {
      parsed.errors.forEach(error => io.stderr.write(`${error}\n`));
      io.stderr.write(`${DAEMON_PIPELINES_USAGE}\n`);
      return 1;
    }

    const channel = parsed.channel?.trim();
    if (!channel) {
      io.stderr.write('Missing required --channel option\n');
      io.stderr.write(`${DAEMON_PIPELINES_USAGE}\n`);
      return 1;
    }

    const snapshot = metrics.snapshot();
    const ffmpegChannels = snapshot.pipelines.ffmpeg.byChannel ?? {};
    const known = new Map<string, string>();

    const registerChannel = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      const lower = trimmed.toLowerCase();
      known.set(lower, trimmed);
      if (lower.startsWith('video:')) {
        const withoutPrefix = lower.slice('video:'.length);
        known.set(withoutPrefix, trimmed);
      }
      const canonical = canonicalChannel(trimmed);
      if (canonical) {
        known.set(canonical.toLowerCase(), trimmed);
        if (canonical.toLowerCase().startsWith('video:')) {
          known.set(canonical.toLowerCase().slice('video:'.length), trimmed);
        }
      }
    };

    for (const key of Object.keys(ffmpegChannels)) {
      registerChannel(key);
    }

    const candidateKeys = new Set<string>();
    candidateKeys.add(channel.toLowerCase());
    const canonicalVideo = canonicalChannel(channel);
    if (canonicalVideo) {
      candidateKeys.add(canonicalVideo.toLowerCase());
      if (canonicalVideo.toLowerCase().startsWith('video:')) {
        candidateKeys.add(canonicalVideo.toLowerCase().slice('video:'.length));
      }
    }
    if (channel.toLowerCase().startsWith('video:')) {
      candidateKeys.add(channel.toLowerCase().slice('video:'.length));
    }

    let targetChannel: string | null = null;
    for (const key of candidateKeys) {
      const resolved = known.get(key);
      if (resolved) {
        targetChannel = resolved;
        break;
      }
    }

    if (!targetChannel) {
      io.stderr.write(`channel not found: ${channel}\n`);
      return 1;
    }

    metrics.setPipelineChannelHealth('ffmpeg', targetChannel, {
      severity: 'none',
      restarts: 0,
      backoffMs: 0
    });

    let runtimeReset = false;
    if (state.status === 'running' && state.runtime && typeof state.runtime.resetChannelHealth === 'function') {
      runtimeReset = state.runtime.resetChannelHealth(targetChannel);
    }

    const actionLabel = runtimeReset
      ? 'Reset pipeline health counters for video channel'
      : 'Cleared recorded pipeline health for video channel';
    io.stdout.write(`${actionLabel} ${targetChannel}\n`);
    return 0;
  }

  io.stderr.write(`Unknown pipelines subcommand: ${subcommand}\n`);
  io.stderr.write(`${DAEMON_PIPELINES_USAGE}\n`);
  return 1;
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

export const __test__ = {
  getState: () => ({ ...state }),
  setRuntime(
    runtime: GuardRuntime | null,
    options: { status?: ServiceStatus; startedAt?: number | null } = {}
  ) {
    resetServiceState();
    if (runtime) {
      state.runtime = runtime;
      state.status = options.status ?? 'running';
      state.startedAt =
        typeof options.startedAt === 'number' ? options.startedAt : Date.now();
    }
  },
  reset: resetServiceState,
  runDaemonRestartCommand
};

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
