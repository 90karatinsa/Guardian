import { EventEmitter } from 'node:events';
import {
  spawn,
  execFile,
  ChildProcessWithoutNullStreams,
  ExecFileException
} from 'node:child_process';
import { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import type { AudioMicFallbackCandidate } from '../config/index.js';
import metrics from '../metrics/index.js';

type MicCandidate = AudioMicFallbackCandidate;

type AudioTimingOptions = {
  channel?: string;
  idleTimeoutMs?: number;
  startTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  restartDelayMs?: number;
  restartMaxDelayMs?: number;
  restartJitterFactor?: number;
  forceKillTimeoutMs?: number;
  retryDelayMs?: number;
  silenceThreshold?: number;
  silenceDurationMs?: number;
  micFallbacks?: Record<string, MicCandidate[]>;
  random?: () => number;
  silenceCircuitBreakerThreshold?: number;
  deviceDiscoveryTimeoutMs?: number;
};

export type AudioSourceOptions =
  | (AudioTimingOptions & {
      type: 'mic';
      device?: string;
      inputFormat?: 'alsa' | 'avfoundation' | 'dshow';
      sampleRate?: number;
      channels?: number;
      frameDurationMs?: number;
    })
  | (AudioTimingOptions & {
      type: 'ffmpeg';
      input: string;
      sampleRate?: number;
      channels?: number;
      frameDurationMs?: number;
      extraInputArgs?: string[];
    });

export type AudioRecoverMeta = {
  minDelayMs: number;
  maxDelayMs: number;
  baseDelayMs: number;
  appliedJitterMs: number;
};

export type AudioRecoverEvent = {
  reason:
    | 'ffmpeg-missing'
    | 'spawn-error'
    | 'process-exit'
    | 'stream-idle'
    | 'stream-silence'
    | 'stream-error'
    | 'watchdog-timeout'
    | 'start-timeout'
    | 'device-discovery-timeout';
  attempt: number;
  delayMs: number;
  meta: AudioRecoverMeta;
  error?: Error;
};

export type AudioFatalEvent = {
  reason: 'circuit-breaker';
  channel: string | null;
  attempts: number;
  lastFailure: { reason: AudioRecoverEvent['reason'] };
};

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FRAME_DURATION_MS = 100;
const DEFAULT_RESTART_DELAY_MS = 3000;
const DEFAULT_RESTART_MAX_DELAY_MS = 6000;
const DEFAULT_RESTART_JITTER_FACTOR = 0.25;
const DEFAULT_IDLE_TIMEOUT_MS = 5000;
const DEFAULT_START_TIMEOUT_MS = 4000;
const DEFAULT_WATCHDOG_TIMEOUT_MS = 6000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;
const DEFAULT_SILENCE_THRESHOLD = 0.0025;
const DEFAULT_SILENCE_DURATION_MS = 2000;
const DEFAULT_DEVICE_DISCOVERY_TIMEOUT_MS = 2000;
const DEFAULT_SILENCE_CIRCUIT_BREAKER_THRESHOLD = 4;

const FFMPEG_CANDIDATES = buildFfmpegCandidates();
const FFPROBE_CANDIDATES = buildFfprobeCandidates();
const DEVICE_DISCOVERY_CACHE = new Map<string, Promise<string[]>>();

export class AudioSource extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private processCleanup: (() => void) | null = null;
  private buffer = Buffer.alloc(0);
  private restartTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private processExitPromise: Promise<void> | null = null;
  private processExitResolve: (() => void) | null = null;
  private retryCount = 0;
  private shouldStop = false;
  private currentBinaryIndex = 0;
  private lastSuccessfulIndex = 0;
  private micInputArgs: string[][] = [];
  private micCandidateIndex = 0;
  private expectedSampleBytes = 0;
  private alignChunks = false;
  private hasReceivedChunk = false;
  private randomFn: () => number;
  private activeMicCandidateIndex: number | null = null;
  private lastSuccessfulMicIndex: number | null = null;
  private silenceAccumulatedMs = 0;
  private silenceRestartPending = false;
  private circuitBreakerFailures = 0;
  private circuitBroken = false;
  private lastCircuitCandidateReason: AudioRecoverEvent['reason'] | null = null;
  private startSequencePromise: Promise<void> | null = null;

  constructor(private options: AudioSourceOptions) {
    super();
    this.randomFn = options.random ?? Math.random;
  }

  start() {
    if (this.process || this.restartTimer || this.startSequencePromise) {
      return;
    }

    this.shouldStop = false;
    this.retryCount = 0;
    this.hasReceivedChunk = false;
    this.activeMicCandidateIndex = null;
    this.currentBinaryIndex = this.lastSuccessfulIndex;
    this.clearAllTimers();
    this.resetSilenceState();
    this.circuitBreakerFailures = 0;
    this.circuitBroken = false;
    this.lastCircuitCandidateReason = null;
    if (this.options.type === 'mic') {
      this.micInputArgs = buildMicInputArgs(
        process.platform,
        this.options,
        this.options.micFallbacks
      );
      this.micCandidateIndex =
        this.lastSuccessfulMicIndex !== null ? this.lastSuccessfulMicIndex : 0;
    } else {
      this.micInputArgs = [];
      this.micCandidateIndex = 0;
    }
    this.alignChunks = this.options.type === 'ffmpeg' && this.options.input === 'pipe:0';
    this.startPipeline();
  }

  private startPipeline() {
    if (this.startSequencePromise) {
      return;
    }

    const sequence = this.runStartSequence();
    const guarded = sequence.finally(() => {
      if (this.startSequencePromise === guarded) {
        this.startSequencePromise = null;
      }
    });
    this.startSequencePromise = guarded;
  }

  private async runStartSequence() {
    if (this.shouldStop || this.circuitBroken) {
      return;
    }

    if (this.options.type === 'mic') {
      const proceed = await this.prepareMicCandidates();
      if (!proceed) {
        return;
      }
    }

    if (this.shouldStop || this.circuitBroken) {
      return;
    }

    this.startProcess();
  }

  updateOptions(
    options: Partial<Omit<AudioTimingOptions, 'micFallbacks'>> & {
      micFallbacks?: Record<string, MicCandidate[]>;
      random?: () => number;
    }
  ) {
    const next: AudioSourceOptions = {
      ...(this.options as AudioSourceOptions),
      ...options,
      micFallbacks: options.micFallbacks ?? this.options.micFallbacks
    } as AudioSourceOptions;

    this.options = next;

    if (typeof options.random === 'function') {
      this.randomFn = options.random;
    }

    if (options.micFallbacks !== undefined) {
      if (next.type === 'mic') {
        this.micInputArgs = buildMicInputArgs(process.platform, next, next.micFallbacks);
      } else {
        this.micInputArgs = [];
      }
      this.micCandidateIndex = 0;
      this.activeMicCandidateIndex = null;
      this.lastSuccessfulMicIndex = null;
      this.silenceRestartPending = false;
    }

    if (this.process) {
      if (!this.hasReceivedChunk) {
        this.resetStartTimer();
      }
      this.resetIdleTimer();
      this.resetWatchdogTimer();
    }
  }

  stop() {
    this.shouldStop = true;
    this.hasReceivedChunk = false;
    this.activeMicCandidateIndex = null;
    this.clearAllTimers();
    this.resetSilenceState();
    this.circuitBreakerFailures = 0;
    this.circuitBroken = false;
    this.lastCircuitCandidateReason = null;
    this.startSequencePromise = null;
    this.terminateProcess(true, { skipForceDelay: true });
  }

  triggerDeviceDiscoveryTimeout(error?: Error) {
    if (this.shouldStop || this.circuitBroken) {
      return;
    }

    const err = error ?? new Error('Audio device discovery timed out');
    metrics.recordAudioDeviceDiscovery('device-discovery-timeout', {
      channel: this.options.channel
    });
    this.emit('error', err);
    this.scheduleRetry('device-discovery-timeout', err);
  }

  consume(stream: Readable, sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS) {
    stream.on('data', chunk => {
      if (this.process) {
        if (!this.hasReceivedChunk) {
          this.hasReceivedChunk = true;
          this.retryCount = 0;
          this.clearStartTimer();
        }
        this.resetIdleTimer();
        this.resetWatchdogTimer();
      }
      this.consumeChunk(chunk, sampleRate, channels);
    });
  }

  static async listDevices(
    format: 'alsa' | 'avfoundation' | 'dshow' | 'auto' = 'auto',
    options: { timeoutMs?: number; channel?: string } = {}
  ) {
    const cacheKey = `${process.platform}:${format}`;
    const cached = DEVICE_DISCOVERY_CACHE.get(cacheKey);
    if (cached) {
      const devices = await cached;
      return [...devices];
    }

    const discovery = (async () => {
      const formats = resolveDeviceFormats(format, process.platform);
      let lastError: Error | null = null;
      const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_DEVICE_DISCOVERY_TIMEOUT_MS);

      for (const fmt of formats) {
        const args = [
          '-hide_banner',
          '-loglevel',
          'info',
          '-f',
          fmt,
          '-list_devices',
          'true',
          '-i',
          'dummy'
        ];

        for (const command of FFPROBE_CANDIDATES) {
          try {
            const { stdout, stderr } = await execFileAsync(command, args, { timeoutMs });
            const parsed = parseDeviceList(`${stdout}\n${stderr}`);
            if (parsed.length > 0) {
              return [...parsed];
            }
          } catch (error) {
            lastError = error as Error;
            if (isTimeoutError(lastError)) {
              metrics.recordAudioDeviceDiscovery('device-discovery-timeout', {
                channel: options.channel
              });
              continue;
            }
          }
        }
      }

      throw lastError ?? new Error('Unable to list audio devices');
    })();

    DEVICE_DISCOVERY_CACHE.set(cacheKey, discovery);

    try {
      const devices = await discovery;
      DEVICE_DISCOVERY_CACHE.set(cacheKey, Promise.resolve([...devices]));
      return [...devices];
    } catch (error) {
      DEVICE_DISCOVERY_CACHE.delete(cacheKey);
      throw error;
    }
  }

  static clearDeviceCache() {
    DEVICE_DISCOVERY_CACHE.clear();
  }

  private async prepareMicCandidates(): Promise<boolean> {
    if (this.shouldStop || this.circuitBroken) {
      return false;
    }

    if (this.options.type !== 'mic') {
      return true;
    }

    const timeoutConfig = this.options.deviceDiscoveryTimeoutMs;
    if (timeoutConfig === 0) {
      return true;
    }

    const timeoutMs = Math.max(
      0,
      timeoutConfig ?? DEFAULT_DEVICE_DISCOVERY_TIMEOUT_MS
    );

    if (timeoutMs === 0) {
      return true;
    }

    const format = this.options.inputFormat ?? 'auto';

    try {
      await AudioSource.listDevices(format, {
        timeoutMs,
        channel: this.options.channel
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        const err = error instanceof Error ? error : new Error('Audio device discovery timed out');
        this.triggerDeviceDiscoveryTimeout(err);
        return false;
      }

      this.emit('error', error as Error);
    }

    if (this.shouldStop || this.circuitBroken) {
      return false;
    }

    return true;
  }

  private startProcess() {
    if (this.shouldStop || this.circuitBroken) {
      return;
    }

    this.hasReceivedChunk = false;
    this.activeMicCandidateIndex = null;
    this.resetSilenceState();
    this.clearStartTimer();
    this.clearIdleTimer();
    this.clearWatchdogTimer();
    this.clearKillTimer();

    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const channels = this.options.channels ?? DEFAULT_CHANNELS;
    this.expectedSampleBytes = channels * 2;

    const argSets = this.buildArgSets(sampleRate, channels);
    if (argSets.length === 0) {
      const error = new Error('No audio input candidates available');
      this.emit('error', error);
      this.scheduleRetry('spawn-error', error);
      return;
    }

    if (this.options.type === 'mic' && this.micInputArgs.length === 0) {
      this.micInputArgs = argSets;
    }

    let candidateIndex = this.options.type === 'mic' ? this.micCandidateIndex % argSets.length : 0;
    const attemptedCandidates = new Set<number>();
    let spawnError: Error | null = null;

    while (attemptedCandidates.size < argSets.length) {
      attemptedCandidates.add(candidateIndex);
      const args = argSets[candidateIndex];
      let attemptIndex = this.currentBinaryIndex;

      while (attemptIndex < FFMPEG_CANDIDATES.length) {
        const binary = FFMPEG_CANDIDATES[attemptIndex];
        try {
          const stdio = this.alignChunks ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
          const proc = spawn(binary, args, { stdio });
          this.attachProcess(proc, sampleRate, channels, attemptIndex, candidateIndex, argSets.length);
          return;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            attemptIndex += 1;
            continue;
          }

          spawnError = err;
          break;
        }
      }

      this.currentBinaryIndex = 0;

      if (this.options.type !== 'mic') {
        break;
      }

      candidateIndex = (candidateIndex + 1) % argSets.length;
    }

    if (this.options.type === 'mic' && argSets.length > 1) {
      this.micCandidateIndex = (candidateIndex + 1) % argSets.length;
    }

    if (spawnError) {
      this.emit('error', spawnError);
      this.scheduleRetry('spawn-error', spawnError);
      return;
    }

    this.currentBinaryIndex = 0;
    const missingError = new Error('ffmpeg not found');
    this.emit('error', missingError);
    this.scheduleRetry('ffmpeg-missing', missingError);
  }

  private attachProcess(
    proc: ChildProcessWithoutNullStreams,
    sampleRate: number,
    channels: number,
    binaryIndex: number,
    candidateIndex: number,
    totalCandidates: number
  ) {
    this.process = proc;
    this.currentBinaryIndex = binaryIndex;
    this.lastSuccessfulIndex = binaryIndex;
    this.buffer = Buffer.alloc(0);
    this.hasReceivedChunk = false;
    this.resetSilenceState();
    this.activeMicCandidateIndex =
      this.options.type === 'mic' ? candidateIndex : null;

    this.processExitPromise = new Promise<void>(resolve => {
      this.processExitResolve = () => {
        if (!this.processExitResolve) {
          return;
        }
        this.processExitResolve = null;
        resolve();
        this.processExitPromise = null;
      };
    });

    const onStdout = (chunk: Buffer) => {
      if (!this.hasReceivedChunk) {
        this.hasReceivedChunk = true;
        this.retryCount = 0;
        this.clearStartTimer();
      }

      this.resetIdleTimer();
      this.resetWatchdogTimer();
      this.consumeChunk(chunk, sampleRate, channels);
    };

    const onStderr = (chunk: Buffer) => {
      this.emit('stderr', chunk.toString());
    };

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);

    const onError = (error: NodeJS.ErrnoException) => {
      this.emit('error', error);

      if (this.shouldStop) {
        return;
      }

      if (error.code === 'ENOENT') {
        this.currentBinaryIndex = binaryIndex + 1;
        if (this.currentBinaryIndex >= FFMPEG_CANDIDATES.length) {
          this.currentBinaryIndex = 0;
        }
        this.scheduleRetry('ffmpeg-missing', error);
        return;
      }

      this.scheduleRetry('spawn-error', error);
    };

    const onClose = (code: number | null) => {
      this.emit('close', code);
      this.clearKillTimer();
      this.clearStartTimer();
      this.clearIdleTimer();
      this.clearWatchdogTimer();
      this.hasReceivedChunk = false;
      this.activeMicCandidateIndex = null;
      this.resetSilenceState();
      this.resolveProcessExit();

      if (this.shouldStop) {
        return;
      }

      if (this.options.type === 'mic' && totalCandidates > 1) {
        this.micCandidateIndex = (candidateIndex + 1) % totalCandidates;
      }

      this.currentBinaryIndex = this.lastSuccessfulIndex;
      this.scheduleRetry('process-exit');
    };

    proc.once('error', onError);
    proc.once('close', onClose);

    this.processCleanup = () => {
      proc.stdout.off('data', onStdout);
      proc.stderr.off('data', onStderr);
      proc.off('error', onError);
    };

    this.resetStartTimer();
    this.resetIdleTimer();
    this.resetWatchdogTimer();
    this.emit('stream', proc.stdout);
  }

  private scheduleRetry(reason: AudioRecoverEvent['reason'], error?: Error) {
    if (this.shouldStop || this.circuitBroken) {
      return;
    }

    if (this.restartTimer) {
      return;
    }

    this.retryCount += 1;
    const attempt = this.retryCount;
    const isCircuitCandidate = reason === 'stream-silence' || reason === 'watchdog-timeout';
    if (isCircuitCandidate) {
      this.circuitBreakerFailures += 1;
      this.lastCircuitCandidateReason = reason;
    } else if (reason === 'process-exit' && this.lastCircuitCandidateReason) {
      this.lastCircuitCandidateReason = null;
    } else {
      this.circuitBreakerFailures = 0;
      this.lastCircuitCandidateReason = null;
    }

    const threshold =
      this.options.silenceCircuitBreakerThreshold ?? DEFAULT_SILENCE_CIRCUIT_BREAKER_THRESHOLD;

    if (isCircuitCandidate && threshold > 0 && this.circuitBreakerFailures >= threshold) {
      this.circuitBroken = true;
      this.shouldStop = true;
      this.clearAllTimers();
      this.resetSilenceState();
      this.lastCircuitCandidateReason = null;
      const termination = this.terminateProcess(true, { skipForceDelay: true });
      metrics.recordPipelineRestart('audio', 'circuit-breaker', {
        attempt,
        channel: this.options.channel,
        at: Date.now()
      });
      this.emit(
        'fatal',
        {
          reason: 'circuit-breaker',
          channel: this.options.channel ?? null,
          attempts: attempt,
          lastFailure: { reason }
        } satisfies AudioFatalEvent
      );
      termination?.catch(() => {});
      return;
    }

    const timing = this.computeRestartDelay(attempt);

    metrics.recordPipelineRestart('audio', reason, {
      attempt,
      delayMs: timing.delayMs,
      baseDelayMs: timing.meta.baseDelayMs,
      minDelayMs: timing.meta.minDelayMs,
      maxDelayMs: timing.meta.maxDelayMs,
      jitterMs: timing.meta.appliedJitterMs,
      channel: this.options.channel,
      at: Date.now()
    });

    this.rotateMicFallback(reason);

    this.emit(
      'recover',
      {
        reason,
        attempt,
        delayMs: timing.delayMs,
        meta: timing.meta,
        error
      } satisfies AudioRecoverEvent
    );

    this.clearAllTimers();
    this.hasReceivedChunk = false;
    this.resetSilenceState();
    const termination = this.terminateProcess(true);
    const waitForTermination = termination ?? Promise.resolve();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      waitForTermination
        .catch(() => {})
        .then(() => {
          if (this.shouldStop || this.circuitBroken) {
            return;
          }
          this.startPipeline();
        });
    }, Math.max(0, timing.delayMs));
  }

  private detachProcess() {
    if (!this.process) {
      return null;
    }

    const proc = this.process;
    this.process = null;
    this.processCleanup?.();
    this.processCleanup = null;
    this.buffer = Buffer.alloc(0);
    return proc;
  }

  private terminateProcess(
    force = false,
    options: { skipForceDelay?: boolean } = {}
  ): Promise<void> | null {
    const proc = this.detachProcess();
    if (!proc) {
      return this.processExitPromise;
    }

    try {
      proc.stdout.destroy();
    } catch (error) {
      // Ignore destruction errors
    }

    try {
      proc.stderr.destroy();
    } catch (error) {
      // Ignore destruction errors
    }

    const exitPromise = this.processExitPromise ?? Promise.resolve();

    if (!force) {
      return exitPromise;
    }

    try {
      proc.kill('SIGTERM');
    } catch (error) {
      // Ignore termination errors
    }

    this.clearKillTimer();
    const delay = this.options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
    if (options.skipForceDelay || delay <= 0) {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch (error) {
          // Ignore forced kill errors
        }
      }
      this.resolveProcessExit();
      return exitPromise;
    }

    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch (error) {
          // Ignore forced kill errors
        }
      }
      this.resolveProcessExit();
    }, delay);

    return exitPromise;
  }

  private clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearStartTimer() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private resetStartTimer() {
    this.clearStartTimer();
    const timeout = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    if (timeout <= 0) {
      return;
    }

    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.shouldStop || this.hasReceivedChunk) {
        return;
      }
      this.emit('error', new Error('Audio source start timeout'));
      this.scheduleRetry('start-timeout');
    }, timeout);
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer() {
    this.clearIdleTimer();
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (timeout <= 0) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.shouldStop) {
        return;
      }
      this.emit('error', new Error('Audio source idle timeout'));
      this.scheduleRetry('stream-idle');
    }, timeout);
  }

  private clearWatchdogTimer() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private resetWatchdogTimer() {
    this.clearWatchdogTimer();
    const timeout =
      this.options.watchdogTimeoutMs ??
      this.options.idleTimeoutMs ??
      DEFAULT_WATCHDOG_TIMEOUT_MS;

    if (timeout <= 0) {
      return;
    }

    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.shouldStop) {
        return;
      }
      this.emit('error', new Error('Audio source watchdog timeout'));
      this.scheduleRetry('watchdog-timeout');
    }, timeout);
  }

  private clearKillTimer() {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private clearAllTimers() {
    this.clearRestartTimer();
    this.clearStartTimer();
    this.clearIdleTimer();
    this.clearWatchdogTimer();
    this.clearKillTimer();
  }

  private resolveProcessExit() {
    if (this.processExitResolve) {
      const resolve = this.processExitResolve;
      this.processExitResolve = null;
      resolve();
      this.processExitPromise = null;
    } else if (this.processExitPromise) {
      this.processExitPromise = null;
    }
  }

  private resetSilenceState() {
    this.silenceAccumulatedMs = 0;
    this.silenceRestartPending = false;
  }

  private rotateMicFallback(reason: AudioRecoverEvent['reason']) {
    if (
      this.options.type !== 'mic' ||
      this.micInputArgs.length <= 1 ||
      (reason !== 'stream-silence' &&
        reason !== 'watchdog-timeout' &&
        reason !== 'device-discovery-timeout')
    ) {
      return;
    }

    const currentIndex =
      this.activeMicCandidateIndex !== null
        ? this.activeMicCandidateIndex
        : this.micCandidateIndex;
    this.micCandidateIndex = (currentIndex + 1) % this.micInputArgs.length;
  }

  private computeRestartDelay(attempt: number) {
    const minDelayMs = Math.max(
      0,
      this.options.restartDelayMs ??
        this.options.retryDelayMs ??
        DEFAULT_RESTART_DELAY_MS
    );

    const maxDelayMs = Math.max(
      minDelayMs,
      this.options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS
    );

    let baseDelayMs = minDelayMs;
    if (attempt > 1) {
      const exponential = minDelayMs * 2 ** (attempt - 1);
      baseDelayMs = Math.min(maxDelayMs, Math.max(minDelayMs, Math.round(exponential)));
    }

    const factor = Math.max(0, this.options.restartJitterFactor ?? DEFAULT_RESTART_JITTER_FACTOR);
    const jitterRange = Math.round(baseDelayMs * factor);
    let appliedJitterMs = 0;

    if (jitterRange > 0) {
      const centered = this.randomFn() * 2 - 1;
      appliedJitterMs = Math.round(centered * jitterRange);
    }

    let delayMs = baseDelayMs + appliedJitterMs;
    if (delayMs > maxDelayMs) {
      delayMs = maxDelayMs;
    } else if (delayMs < minDelayMs) {
      delayMs = minDelayMs;
    }

    appliedJitterMs = delayMs - baseDelayMs;

    return {
      delayMs,
      meta: {
        minDelayMs,
        maxDelayMs,
        baseDelayMs,
        appliedJitterMs
      }
    } as const;
  }

  private consumeChunk(chunk: Buffer, sampleRate: number, channels: number) {
    if (this.alignChunks && this.expectedSampleBytes > 0) {
      if (chunk.length % this.expectedSampleBytes !== 0) {
        this.emit('error', new Error('Audio chunk misaligned with sample alignment'));
        this.buffer = Buffer.alloc(0);
        this.scheduleRetry('stream-error');
        return;
      }
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frameSizeSamples = this.calculateFrameSize(sampleRate, channels);
    const frameSizeBytes = frameSizeSamples * 2;
    const frameDurationMs = calculateFrameDurationMs(frameSizeSamples, sampleRate, channels);
    const silenceThreshold = this.options.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD;
    const silenceDurationTarget = this.options.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS;
    const monitorSilence =
      frameDurationMs > 0 && silenceDurationTarget > 0 && !Number.isNaN(frameDurationMs);

    while (this.buffer.length >= frameSizeBytes) {
      const frame = this.buffer.subarray(0, frameSizeBytes);
      this.buffer = this.buffer.subarray(frameSizeBytes);
      const { samples, rms, peak } = bufferToSamples(frame);

      if (monitorSilence) {
        const silent = rms <= silenceThreshold && peak <= silenceThreshold * 2;
        if (!silent) {
          this.silenceAccumulatedMs = 0;
          this.silenceRestartPending = false;
          if (this.options.type === 'mic' && this.activeMicCandidateIndex !== null) {
            this.lastSuccessfulMicIndex = this.activeMicCandidateIndex;
            this.micCandidateIndex = this.activeMicCandidateIndex;
          }
        } else if (!this.silenceRestartPending) {
          this.silenceAccumulatedMs += frameDurationMs;
          if (this.silenceAccumulatedMs >= silenceDurationTarget) {
            this.silenceRestartPending = true;
            this.emit('error', new Error('Audio source silence detected'));
            this.scheduleRetry('stream-silence');
            continue;
          }
        }
      }

      this.emit('data', samples);
    }
  }

  private calculateFrameSize(sampleRate: number, channels: number) {
    const frameDuration = this.options.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS;
    return Math.max(1, Math.floor((sampleRate * frameDuration) / 1000)) * channels;
  }

  private buildArgSets(sampleRate: number, channels: number) {
    const outputArgs = [
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1'
    ];

    if (this.options.type === 'mic') {
      const candidates = this.micInputArgs.length
        ? this.micInputArgs
        : buildMicInputArgs(process.platform, this.options, this.options.micFallbacks);
      return candidates.map(candidate => [...candidate, ...outputArgs]);
    }

    const inputArgs = [...(this.options.extraInputArgs ?? []), '-i', this.options.input];
    return [[...inputArgs, ...outputArgs]];
  }
}

function bufferToSamples(buffer: Buffer): { samples: Int16Array; rms: number; peak: number } {
  const length = buffer.length / 2;
  const samples = new Int16Array(length);

  if (length === 0) {
    return { samples, rms: 0, peak: 0 };
  }

  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < length; i += 1) {
    const value = buffer.readInt16LE(i * 2);
    samples[i] = value;
    sumSquares += value * value;
    const abs = Math.abs(value);
    if (abs > peak) {
      peak = abs;
    }
  }

  const rms = Math.sqrt(sumSquares / length) / 32768;
  const normalizedPeak = peak / 32768;

  return { samples, rms, peak: normalizedPeak };
}

function calculateFrameDurationMs(totalSamples: number, sampleRate: number, channels: number) {
  if (sampleRate <= 0 || channels <= 0) {
    return 0;
  }

  const perChannelSamples = totalSamples / Math.max(1, channels);
  if (!Number.isFinite(perChannelSamples) || perChannelSamples <= 0) {
    return 0;
  }

  return (perChannelSamples / sampleRate) * 1000;
}

function defaultMicFormat(platform: NodeJS.Platform): AudioSourceOptions['inputFormat'] {
  switch (platform) {
    case 'darwin':
      return 'avfoundation';
    case 'win32':
      return 'dshow';
    default:
      return 'alsa';
  }
}

function defaultMicDevice(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return ':0';
    case 'win32':
      return 'audio="default"';
    default:
      return 'default';
  }
}

function buildMicInputArgs(
  platform: NodeJS.Platform,
  options: Extract<AudioSourceOptions, { type: 'mic' }>,
  overrides?: Record<string, MicCandidate[]>
) {
  const candidates: string[][] = [];
  const seen = new Set<string>();

  const addCandidate = (entry: MicCandidate | null) => {
    if (!entry) {
      return;
    }

    const format = entry.format ?? undefined;
    const device = entry.device;

    if (!device) {
      return;
    }

    const key = `${format ?? 'none'}|${device}`;
    if (seen.has(key)) {
      return;
    }

    const args: string[] = [];
    if (format) {
      args.push('-f', format);
    }
    args.push('-i', device);
    candidates.push(args);
    seen.add(key);
  };

  addCandidate({
    format: options.inputFormat ?? defaultMicFormat(platform) ?? undefined,
    device: options.device ?? defaultMicDevice(platform)
  });

  for (const fallback of resolveMicFallbacks(platform, overrides)) {
    addCandidate(fallback);
  }

  return candidates;
}

function resolveMicFallbacks(platform: NodeJS.Platform, overrides?: Record<string, MicCandidate[]>) {
  if (overrides) {
    const specific = overrides[platform];
    const wildcard = overrides.default ?? overrides['*'];

    if (specific && wildcard) {
      return [...specific, ...wildcard];
    }

    if (specific) {
      return [...specific];
    }

    if (wildcard) {
      return [...wildcard];
    }
  }

  return getMicFallbacks(platform);
}

function getMicFallbacks(platform: NodeJS.Platform): MicCandidate[] {
  switch (platform) {
    case 'darwin':
      return [
        { format: 'avfoundation', device: ':0' },
        { format: 'avfoundation', device: '0:0' }
      ];
    case 'win32':
      return [
        { format: 'dshow', device: 'audio="default"' },
        { format: 'dshow', device: 'audio="Microphone"' }
      ];
    default:
      return [
        { format: 'alsa', device: 'default' },
        { format: 'alsa', device: 'hw:0' },
        { format: 'alsa', device: 'plughw:0' }
      ];
  }
}

function buildFfmpegCandidates() {
  const candidates = new Set<string>();
  if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) {
    candidates.add(ffmpegStatic);
  }
  candidates.add('ffmpeg');
  candidates.add('avconv');
  return Array.from(candidates);
}

function buildFfprobeCandidates() {
  const candidates = new Set<string>();
  if (process.env.FFPROBE_PATH) {
    candidates.add(process.env.FFPROBE_PATH);
  }
  candidates.add('ffprobe');
  candidates.add('ffmpeg');
  return Array.from(candidates);
}

function execFileAsync(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {}
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof execFile> | null = null;

    const onComplete = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string
    ) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }

      if (error) {
        const err = error as ExecFileException & { stdout?: string; stderr?: string };
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve({ stdout, stderr });
    };

    try {
      child = execFile(command, args, onComplete);
    } catch (error) {
      finished = true;
      reject(error as ExecFileException);
      return;
    }

    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (finished) {
          return;
        }
        finished = true;
        try {
          child?.kill('SIGKILL');
        } catch (error) {
          // Ignore kill errors
        }
        const err = new Error(
          `Command "${command}" timed out after ${timeoutMs}ms`
        ) as ExecFileException & { code?: string; stdout?: string; stderr?: string; timedOut?: boolean };
        err.code = 'ETIME';
        err.stdout = '';
        err.stderr = '';
        err.timedOut = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        reject(err);
      }, timeoutMs);
    }
  });
}

function isTimeoutError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: string | number; timedOut?: boolean };
  return err.code === 'ETIME' || err.timedOut === true;
}

function parseDeviceList(output: string) {
  const devices = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.endsWith(':')) {
      continue;
    }

    const quoted = trimmed.match(/"([^"]+)"/);
    if (quoted) {
      devices.add(quoted[1]);
      continue;
    }

    const indexed = trimmed.match(/\[[0-9]+\]\s+(.+)/);
    if (indexed) {
      devices.add(indexed[1]);
    }
  }

  return Array.from(devices);
}

function resolveDeviceFormats(
  format: 'alsa' | 'avfoundation' | 'dshow' | 'auto',
  platform: NodeJS.Platform
) {
  if (format !== 'auto') {
    return [format];
  }

  switch (platform) {
    case 'win32':
      return ['dshow', 'alsa', 'avfoundation'];
    case 'darwin':
      return ['avfoundation', 'dshow', 'alsa'];
    default:
      return ['alsa', 'dshow', 'avfoundation'];
  }
}

export default AudioSource;
