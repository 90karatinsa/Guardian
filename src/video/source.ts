import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import metrics from '../metrics/index.js';
import { normalizeChannelId } from '../utils/channel.js';

type Errno = NodeJS.ErrnoException & { errno?: number };

const ffmpegPath = ffmpegStatic as string | null;
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_START_TIMEOUT_MS = 4000;
const DEFAULT_IDLE_TIMEOUT_MS = 5000;
const DEFAULT_RESTART_DELAY_MS = 500;
const DEFAULT_RESTART_MAX_DELAY_MS = 5000;
const DEFAULT_RESTART_JITTER_FACTOR = 0.2;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

export type VideoSourceOptions = {
  file: string;
  framesPerSecond: number;
  channel?: string;
  idleTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  startTimeoutMs?: number;
  restartDelayMs?: number;
  restartMaxDelayMs?: number;
  restartJitterFactor?: number;
  maxBufferBytes?: number;
  forceKillTimeoutMs?: number;
  inputArgs?: string[];
  rtspTransport?: string;
  commandFactory?: (options: {
    file: string;
    framesPerSecond: number;
    inputArgs?: string[];
    rtspTransport?: string;
  }) => ffmpeg.FfmpegCommand;
  random?: () => number;
  circuitBreakerThreshold?: number;
  rtspTransportSequence?: string[];
};

export type RecoverEventMeta = {
  minDelayMs: number;
  maxDelayMs: number;
  baseDelayMs: number;
  appliedJitterMs: number;
  minJitterMs: number;
  maxJitterMs: number;
};

export type RecoverEvent = {
  reason: string;
  attempt: number;
  delayMs: number;
  meta: RecoverEventMeta;
  channel: string | null;
  errorCode: string | number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type FatalEvent = {
  reason: string;
  channel: string | null;
  attempts: number;
  lastFailure: {
    reason: string;
    errorCode: string | number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  };
};

export type TransportFallbackEvent = {
  channel: string | null;
  from: string | null;
  to: string | null;
  reason: string;
  attempt: number;
  stage: number | null;
  resetsBackoff: boolean;
  resetsCircuitBreaker: boolean;
  at: number;
  metricsRecorded: boolean;
};

type RecoveryContext = {
  errorCode?: string | number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

type RestartDelayResult = {
  delayMs: number;
  meta: RecoverEventMeta;
};

type PendingRestartContext = {
  attempt: number;
  delayMs: number;
  meta: RecoverEventMeta;
  channel: string | null;
  errorCode: string | number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reportedReasons: Set<string>;
};

type RtspFallbackState = {
  base: string;
  sequence: string[];
  index: number;
  current: string;
  lastReason: string | null;
  lastChangeAt: number | null;
  totalChanges: number;
};

export class VideoSource extends EventEmitter {
  private command: ffmpeg.FfmpegCommand | null = null;
  private commandCleanup: (() => void) | null = null;
  private stream: Readable | null = null;
  private streamCleanup: (() => void) | null = null;
  private buffer = Buffer.alloc(0);
  private startTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private streamIdleTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private commandExitPromise: Promise<void> | null = null;
  private commandExitResolve: (() => void) | null = null;
  private terminatingCommand: ffmpeg.FfmpegCommand | null = null;
  private stopPromise: Promise<void> | null = null;
  private shouldStop = false;
  private recovering = false;
  private restartCount = 0;
  private hasReceivedFrame = false;
  private circuitBreakerFailures = 0;
  private circuitBroken = false;
  private lastCircuitCandidateReason: RecoverEvent['reason'] | null = null;
  private readonly commandClassifications = new Set<string>();
  private commandGeneration = 0;
  private readonly channel: string | null;
  private pendingRestartContext: PendingRestartContext | null = null;
  private readonly isRtspInput: boolean;
  private rtspFallbackState: RtspFallbackState | null = null;

  constructor(private options: VideoSourceOptions) {
    super();
    const normalizedChannel = normalizeChannelId(options.channel);
    this.channel = normalizedChannel || null;
    this.isRtspInput = isRtspInputSource(options.file);
    if (this.isRtspInput) {
      this.initializeRtspFallbackState();
    }
  }

  updateOptions(
    options: Partial<
      Pick<
        VideoSourceOptions,
        |
          'idleTimeoutMs'
        | 'watchdogTimeoutMs'
        | 'startTimeoutMs'
        | 'restartDelayMs'
        | 'restartMaxDelayMs'
        | 'restartJitterFactor'
        | 'forceKillTimeoutMs'
        | 'circuitBreakerThreshold'
        | 'rtspTransportSequence'
      >
    >
  ) {
    const previous = this.options;
    const next: VideoSourceOptions = { ...previous, ...options };
    const idleChanged =
      Object.prototype.hasOwnProperty.call(options, 'idleTimeoutMs') &&
      next.idleTimeoutMs !== previous.idleTimeoutMs;
    const watchdogChanged =
      Object.prototype.hasOwnProperty.call(options, 'watchdogTimeoutMs') &&
      next.watchdogTimeoutMs !== previous.watchdogTimeoutMs;
    const startTimeoutChanged =
      Object.prototype.hasOwnProperty.call(options, 'startTimeoutMs') &&
      next.startTimeoutMs !== previous.startTimeoutMs;
    const fallbackChanged = Object.prototype.hasOwnProperty.call(
      options,
      'rtspTransportSequence'
    );

    this.options = next;

    if (fallbackChanged && this.rtspFallbackState) {
      const normalizedCurrent = normalizeRtspTransport(this.rtspFallbackState.current);
      const sequence = buildRtspFallbackSequence(
        this.options.rtspTransport ?? this.rtspFallbackState.base,
        this.options.rtspTransportSequence
      );
      this.rtspFallbackState.base = sequence[0] ?? DEFAULT_RTSP_TRANSPORT;
      this.rtspFallbackState.sequence = sequence;
      const index = normalizedCurrent ? sequence.indexOf(normalizedCurrent) : -1;
      if (index >= 0) {
        this.rtspFallbackState.index = index;
        this.rtspFallbackState.current = sequence[index];
      } else {
        this.rtspFallbackState.index = 0;
        this.rtspFallbackState.current = sequence[0];
      }
      this.options.rtspTransport = this.rtspFallbackState.current;
    }

    if (idleChanged && this.streamIdleTimer) {
      this.resetStreamIdleTimer();
    }
    if (watchdogChanged && this.watchdogTimer) {
      this.resetWatchdogTimer();
    }
    if (startTimeoutChanged && this.startTimer) {
      this.resetStartTimer();
    }
  }

  start() {
    if (
      this.command ||
      this.terminatingCommand ||
      this.commandExitPromise ||
      this.recovering ||
      this.restartTimer
    ) {
      return;
    }

    this.shouldStop = false;
    this.recovering = false;
    this.restartCount = 0;
    this.hasReceivedFrame = false;
    this.circuitBreakerFailures = 0;
    this.circuitBroken = false;
    this.commandGeneration = 0;
    this.resetCommandClassifications();
    this.lastCircuitCandidateReason = null;
    this.pendingRestartContext = null;
    this.syncRtspFallbackState();
    this.clearAllTimers();
    this.startCommand();
  }

  isCircuitBroken() {
    return this.circuitBroken;
  }

  resetCircuitBreaker(options: { restart?: boolean } = {}) {
    const wasBroken = this.circuitBroken;
    this.circuitBroken = false;
    this.circuitBreakerFailures = 0;
    this.lastCircuitCandidateReason = null;
    const restartRequested = options.restart !== false;

    if (!restartRequested) {
      this.clearAllTimers();
      this.recovering = false;
      this.pendingRestartContext = null;
      if (wasBroken) {
        this.shouldStop = true;
      }
    } else {
      this.shouldStop = false;
    }
    if (this.rtspFallbackState) {
      if (wasBroken) {
        this.resetRtspFallbackState({
          reason: 'rtsp-transport-reset',
          record: true,
          resetsCircuitBreaker: true
        });
      } else {
        this.syncRtspFallbackState();
      }
    }
    if (restartRequested && wasBroken) {
      this.start();
    }
    return wasBroken;
  }

  resetTransportFallback(options: {
    reason?: string;
    record?: boolean;
    resetsCircuitBreaker?: boolean;
  } = {}) {
    if (!this.rtspFallbackState) {
      return false;
    }

    this.resetRtspFallbackState({
      reason: options.reason ?? 'rtsp-transport-reset',
      record: options.record,
      resetsCircuitBreaker: options.resetsCircuitBreaker
    });

    return true;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.stopPromise = this.performStop().finally(() => {
      this.stopPromise = null;
    });

    await this.stopPromise;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.removeAllListeners();
  }

  private async performStop(): Promise<void> {
    this.shouldStop = true;
    this.recovering = false;
    this.restartCount = 0;
    this.hasReceivedFrame = false;
    this.circuitBreakerFailures = 0;
    this.circuitBroken = false;
    this.lastCircuitCandidateReason = null;
    this.resetCommandClassifications();
    this.pendingRestartContext = null;
    this.clearRestartTimer();
    this.clearStartTimer();
    this.clearWatchdogTimer();
    this.clearStreamIdleTimer();
    this.cleanupStream();
    this.clearKillTimer();

    const termination = this.terminateCommand(true, { skipForceDelay: true }) ?? Promise.resolve();

    try {
      await termination;
    } finally {
      this.clearRestartTimer();
      this.clearStartTimer();
      this.clearWatchdogTimer();
      this.clearStreamIdleTimer();
      this.clearKillTimer();
      this.cleanupStream();
    }
  }

  consume(stream: Readable) {
    this.cleanupStream();
    this.stream = stream;
    this.buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      if (!this.hasReceivedFrame) {
        this.hasReceivedFrame = true;
        this.clearPersistentCommandClassifications();
        this.clearStartTimer();
        this.restartCount = 0;
        this.markRtspFallbackSuccess();
      }

      this.resetStreamIdleTimer();
      this.resetWatchdogTimer();
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { frames, remainder, corrupted } = this.extractFrames(this.buffer);
      this.buffer = remainder;

      for (const frame of frames) {
        this.emit('frame', frame);
      }

      if (corrupted) {
        this.buffer = Buffer.alloc(0);
        this.emit('error', new Error('Corrupted frame encountered'));
        this.scheduleRecovery('corrupted-frame');
      }
    };

    const onError = (err: Error) => {
      this.emit('error', err);
      this.scheduleRecovery('stream-error', this.normalizeErrno(err));
    };

    const onClose = () => {
      if (this.shouldStop) {
        return;
      }
      this.scheduleRecovery('stream-closed');
    };

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onClose);
    stream.once('close', onClose);

    this.streamCleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onClose);
      stream.off('close', onClose);
    };

    this.emit('stream', stream);
    this.resetWatchdogTimer();
  }

  private startCommand() {
    if (this.shouldStop) {
      return;
    }

    this.recovering = false;
    this.hasReceivedFrame = false;
    this.resetStartTimer();
    this.clearWatchdogTimer();
    this.clearStreamIdleTimer();
    this.commandGeneration += 1;
    this.resetCommandClassifications({ preservePersistent: true });

    let command: ffmpeg.FfmpegCommand;
    try {
      command = this.createCommand();
    } catch (error) {
      const err =
        error instanceof Error ? (error as Errno) : (new Error(String(error)) as Errno);
      const reason = err?.code === 'ENOENT' ? 'ffmpeg-missing' : 'start-error';
      const normalized = this.normalizeErrno(err);
      this.emit('error', err);
      this.scheduleRecovery(reason, normalized);
      return;
    }

    this.command = command;

    this.commandExitPromise = new Promise<void>(resolve => {
      let resolved = false;
      this.commandExitResolve = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve();
        this.commandExitPromise = null;
      };
    });

    const onError = (err: Error) => {
      this.finalizeCommandLifecycle();
      if (this.shouldStop || this.recovering) {
        return;
      }

      const details = this.normalizeErrno(err);
      this.emit('error', err);
      const reason = details.errorCode === 'ENOENT' ? 'ffmpeg-missing' : 'ffmpeg-error';
      this.scheduleRecovery(reason, details);
    };

    const onEnd = () => {
      this.finalizeCommandLifecycle();
      if (this.shouldStop || this.recovering) {
        return;
      }
      this.emit('end');
      this.scheduleRecovery('ffmpeg-ended');
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      this.finalizeCommandLifecycle();
      if (this.shouldStop || this.recovering) {
        return;
      }

      const exitCode = typeof code === 'number' ? code : null;
      const context: RecoveryContext = {
        exitCode,
        signal: signal ?? null
      };

      const reason = exitCode === 0 ? 'ffmpeg-ended' : 'ffmpeg-exit';
      this.scheduleRecovery(reason, context);
    };

    command.once('error', onError);
    command.once('end', onEnd);
    command.once('close', onClose);
    const onStderr = (line: string) => {
      this.handleCommandStderr(line);
    };
    const onStart = () => {
      this.clearStartTimer();
    };
    command.once('start', onStart);

    this.commandCleanup = () => {
      command.off('error', onError);
      command.off('end', onEnd);
      command.off('close', onClose);
      command.off('start', onStart);
      command.off('stderr', onStderr);
    };

    command.on('stderr', onStderr);

    try {
      const stream = command.pipe();
      this.consume(stream);
    } catch (error) {
      this.finalizeCommandLifecycle();
      const err =
        error instanceof Error ? (error as Errno) : (new Error(String(error)) as Errno);
      this.emit('error', err);
      const reason = err?.code === 'ENOENT' ? 'ffmpeg-missing' : 'start-error';
      this.scheduleRecovery(reason, this.normalizeErrno(err));
    }
  }

  private createCommand() {
    if (this.options.commandFactory) {
      return this.options.commandFactory({
        file: this.options.file,
        framesPerSecond: this.options.framesPerSecond,
        inputArgs: this.options.inputArgs,
        rtspTransport: this.options.rtspTransport
      });
    }

    const command = ffmpeg(this.options.file);

    const inputOptions: string[] = [];
    if (this.options.rtspTransport) {
      inputOptions.push('-rtsp_transport', this.options.rtspTransport);
    }

    if (this.options.inputArgs?.length) {
      inputOptions.push(...this.options.inputArgs);
    }

    if (inputOptions.length > 0) {
      command.inputOptions(inputOptions);
    }

    return command
      .outputOptions('-vf', `fps=${this.options.framesPerSecond}`)
      .outputOptions('-f', 'image2pipe')
      .outputOptions('-vcodec', 'png');
  }

  private extractFrames(buffer: Buffer) {
    let working = buffer;
    const frames: Buffer[] = [];
    let corrupted = false;
    const maxBuffer = this.options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    while (true) {
      const pngStart = working.indexOf(PNG_SIGNATURE);

      if (pngStart === -1) {
        if (working.length > maxBuffer) {
          corrupted = true;
          working = Buffer.alloc(0);
        }
        break;
      }

      if (pngStart > 0) {
        working = working.subarray(pngStart);
      }

      const frame = slicePng(working);
      if (!frame) {
        if (working.length > maxBuffer) {
          corrupted = true;
          working = Buffer.alloc(0);
        }
        break;
      }

      frames.push(frame.png);
      working = frame.remainder;
    }

    return { frames, remainder: working, corrupted };
  }

  private cleanupStream() {
    if (!this.stream) {
      return;
    }

    this.streamCleanup?.();
    this.streamCleanup = null;

    if (!this.stream.destroyed) {
      this.stream.destroy();
    }

    this.stream = null;
    this.buffer = Buffer.alloc(0);
    this.clearStreamIdleTimer();
  }

  private scheduleRecovery(reason: string, context: RecoveryContext = {}) {
    if (this.shouldStop || this.circuitBroken || this.recovering) {
      return;
    }

    if (this.restartTimer) {
      return;
    }

    const attemptPreview = this.restartCount + 1;
    const resolvedContext: RecoveryContext = {
      errorCode:
        typeof context.errorCode === 'string' || typeof context.errorCode === 'number'
          ? context.errorCode
          : reason === 'watchdog-timeout' || reason === 'stream-idle'
            ? reason
            : null,
      exitCode: typeof context.exitCode === 'number' ? context.exitCode : null,
      signal: context.signal ?? null
    };
    this.maybeApplyRtspTransportFallback(reason, resolvedContext, attemptPreview);

    this.recovering = true;
    this.restartCount += 1;
    const attempt = this.restartCount;

    const channel = this.channel;
    const errorCode =
      typeof resolvedContext.errorCode === 'string' || typeof resolvedContext.errorCode === 'number'
        ? resolvedContext.errorCode
        : typeof resolvedContext.exitCode === 'number'
          ? resolvedContext.exitCode
          : null;
    const exitCode = resolvedContext.exitCode;
    const signal = resolvedContext.signal ?? null;

    const isCircuitCandidate =
      reason === 'start-timeout' ||
      reason === 'watchdog-timeout' ||
      reason === 'stream-idle' ||
      reason === 'rtsp-timeout' ||
      reason === 'rtsp-connection-failure' ||
      reason === 'rtsp-auth-failure' ||
      reason === 'rtsp-not-found' ||
      reason === 'ffmpeg-missing';
    if (isCircuitCandidate) {
      this.circuitBreakerFailures += 1;
      this.lastCircuitCandidateReason = reason;
    } else if (reason === 'ffmpeg-exit' && this.lastCircuitCandidateReason) {
      this.lastCircuitCandidateReason = null;
    } else {
      this.circuitBreakerFailures = 0;
      this.lastCircuitCandidateReason = null;
    }

    const threshold = this.options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    const shouldTripCircuit = isCircuitCandidate && threshold > 0 && this.circuitBreakerFailures >= threshold;

    this.clearStartTimer();
    this.clearWatchdogTimer();
    this.clearStreamIdleTimer();
    this.cleanupStream();

    const shouldForceImmediateKill =
      shouldTripCircuit ||
      reason === 'rtsp-timeout' ||
      reason === 'watchdog-timeout' ||
      reason === 'stream-idle';
    let restartContext: PendingRestartContext | null = null;
    const termination = this.terminateCommand(true, {
      skipForceDelay: shouldForceImmediateKill,
      onForceKill: () => {
        if (restartContext) {
          this.reportRecovery(restartContext, 'force-kill');
        }
      }
    });
    const waitForTermination = termination ?? Promise.resolve();

    const timing = this.computeRestartDelay(attempt);

    const sanitizedDelay = Math.max(0, timing.delayMs);

    const restartContextDetails: PendingRestartContext = {
      attempt,
      delayMs: sanitizedDelay,
      meta: timing.meta,
      channel,
      errorCode: errorCode ?? null,
      exitCode,
      signal,
      reportedReasons: new Set<string>()
    };
    restartContext = restartContextDetails;

    if (shouldTripCircuit) {
      this.shouldStop = true;
      this.recovering = false;
      this.circuitBroken = true;
      this.lastCircuitCandidateReason = null;
      this.clearRestartTimer();
      this.reportRecovery(restartContextDetails, reason);
      metrics.recordPipelineRestart('ffmpeg', 'circuit-breaker', {
        attempt,
        channel: channel ?? undefined,
        errorCode: errorCode ?? undefined,
        exitCode: exitCode ?? undefined,
        signal: signal ?? undefined,
        at: Date.now()
      });
      this.emit(
        'fatal',
        {
          reason: 'circuit-breaker',
          channel,
          attempts: attempt,
          lastFailure: {
            reason,
            errorCode: errorCode ?? null,
            exitCode,
            signal
          }
        } satisfies FatalEvent
      );
      waitForTermination.catch(() => {});
      return;
    }

    this.pendingRestartContext = restartContextDetails;

    this.reportRecovery(restartContextDetails, reason);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.pendingRestartContext === restartContextDetails) {
        this.pendingRestartContext = null;
      }
      waitForTermination
        .catch(() => {})
        .then(() => {
          if (this.shouldStop) {
            return;
          }
          this.startCommand();
        });
    }, sanitizedDelay);
  }

  private finalizeCommandLifecycle() {
    this.commandCleanup?.();
    this.commandCleanup = null;
    this.clearKillTimer();
    this.terminatingCommand = null;
    this.resolveCommandExit();
  }

  private resolveCommandExit() {
    if (this.commandExitResolve) {
      const resolve = this.commandExitResolve;
      this.commandExitResolve = null;
      resolve();
      this.commandExitPromise = null;
    } else if (this.commandExitPromise) {
      this.commandExitPromise = null;
    }
  }

  private clearAllTimers() {
    this.clearRestartTimer();
    this.clearStartTimer();
    this.clearWatchdogTimer();
    this.clearStreamIdleTimer();
    this.clearKillTimer();
  }

  private terminateCommand(
    force = false,
    options: { skipForceDelay?: boolean; onForceKill?: () => void } = {}
  ): Promise<void> | null {
    const command = this.command ?? this.terminatingCommand;
    if (!command) {
      return this.commandExitPromise;
    }

    const wasActive = command === this.command;
    if (wasActive) {
      this.command = null;
      this.terminatingCommand = command;
    }

    const exitPromise = this.commandExitPromise ?? Promise.resolve();

    if (!force) {
      return exitPromise;
    }

    try {
      command.kill('SIGTERM');
    } catch (error) {
      // Swallow errors from already terminated processes
    }

    const delay = this.options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
    if (options.skipForceDelay || delay <= 0) {
      this.clearKillTimer();
      try {
        command.kill('SIGKILL');
      } catch (error) {
        // Ignore
      }
      options.onForceKill?.();
      this.finalizeCommandLifecycle();
      return exitPromise;
    }

    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      try {
        command.kill('SIGKILL');
      } catch (error) {
        // Ignore forced kill errors
      }
      options.onForceKill?.();
      this.finalizeCommandLifecycle();
    }, delay);

    return exitPromise;
  }

  private reportRecovery(context: PendingRestartContext, reason: string) {
    if (context.reportedReasons.has(reason)) {
      return;
    }

    context.reportedReasons.add(reason);

    metrics.recordPipelineRestart('ffmpeg', reason, {
      attempt: context.attempt,
      delayMs: context.delayMs,
      baseDelayMs: context.meta.baseDelayMs,
      minDelayMs: context.meta.minDelayMs,
      maxDelayMs: context.meta.maxDelayMs,
      jitterMs: context.meta.appliedJitterMs,
      minJitterMs: context.meta.minJitterMs,
      maxJitterMs: context.meta.maxJitterMs,
      channel: context.channel ?? undefined,
      errorCode: context.errorCode ?? undefined,
      exitCode: context.exitCode ?? undefined,
      signal: context.signal ?? undefined,
      at: Date.now()
    });

    this.emit(
      'recover',
      {
        reason,
        attempt: context.attempt,
        delayMs: context.delayMs,
        meta: context.meta,
        channel: context.channel,
        errorCode: context.errorCode,
        exitCode: context.exitCode,
        signal: context.signal
      } satisfies RecoverEvent
    );
  }

  private clearStartTimer() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private resetStartTimer() {
    this.clearStartTimer();
    if (this.shouldStop) {
      return;
    }

    const timeout = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    if (timeout <= 0) {
      return;
    }

    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.shouldStop || this.hasReceivedFrame) {
        return;
      }
      this.emit('error', new Error('Video source failed to start before timeout'));
      this.scheduleRecovery('start-timeout');
    }, timeout);
  }

  private clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.pendingRestartContext = null;
  }

  private clearKillTimer() {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private clearWatchdogTimer() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearStreamIdleTimer() {
    if (this.streamIdleTimer) {
      clearTimeout(this.streamIdleTimer);
      this.streamIdleTimer = null;
    }
  }

  private resetWatchdogTimer() {
    this.clearWatchdogTimer();
    if (this.shouldStop) {
      return;
    }

    const idleTimeout = this.options.watchdogTimeoutMs ?? 0;

    if (idleTimeout <= 0) {
      return;
    }

    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.shouldStop) {
        return;
      }
      this.emit('error', new Error('Video source watchdog timeout'));
      this.scheduleRecovery('watchdog-timeout');
    }, idleTimeout);
  }

  private resetStreamIdleTimer() {
    this.clearStreamIdleTimer();
    if (this.shouldStop) {
      return;
    }

    if (!this.hasReceivedFrame) {
      return;
    }

    const idleTimeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    if (idleTimeout <= 0) {
      return;
    }

    this.streamIdleTimer = setTimeout(() => {
      this.streamIdleTimer = null;
      if (this.shouldStop) {
        return;
      }
      this.emit('error', new Error('Video source stream idle timeout'));
      this.scheduleRecovery('stream-idle');
    }, idleTimeout);
  }

  private computeRestartDelay(attempt: number): RestartDelayResult {
    const minDelayMs = Math.max(0, this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS);
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
    const random = this.options.random?.() ?? Math.random();
    const jitterRange = Math.round(baseDelayMs * factor);
    let appliedJitterMs = 0;

    if (jitterRange > 0) {
      const centered = random * 2 - 1;
      appliedJitterMs = Math.round(centered * jitterRange);
    }

    const jitterLowerBound = Math.max(minDelayMs, baseDelayMs - jitterRange) - baseDelayMs;
    const jitterUpperBound = Math.min(maxDelayMs, baseDelayMs + jitterRange) - baseDelayMs;

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
        appliedJitterMs,
        minJitterMs: jitterLowerBound,
        maxJitterMs: jitterUpperBound
      }
    };
  }

  private initializeRtspFallbackState() {
    const state = createRtspFallbackState(
      normalizeRtspTransport(this.options.rtspTransport),
      this.options.rtspTransportSequence
    );
    this.rtspFallbackState = state;
    this.options.rtspTransport = state.current;
  }

  private syncRtspFallbackState() {
    const state = this.rtspFallbackState;
    if (!state) {
      return;
    }

    const sequence = buildRtspFallbackSequence(
      this.options.rtspTransport ?? state.base,
      this.options.rtspTransportSequence
    );
    state.sequence = sequence;
    state.base = sequence[0] ?? DEFAULT_RTSP_TRANSPORT;
    const normalized = normalizeRtspTransport(this.options.rtspTransport) ?? state.sequence[0];
    const index = state.sequence.indexOf(normalized);
    if (index >= 0) {
      state.index = index;
      state.current = state.sequence[index];
      this.options.rtspTransport = state.current;
      return;
    }

    state.index = 0;
    state.current = state.sequence[0];
    this.options.rtspTransport = state.current;
  }

  private maybeApplyRtspTransportFallback(
    reason: string,
    context: RecoveryContext,
    attempt: number
  ) {
    const state = this.rtspFallbackState;
    if (!state || !isRtspFallbackReason(reason)) {
      return;
    }

    const current = state.current;
    let nextIndex = state.index;
    let nextTransport = current;

    for (let i = state.index + 1; i < state.sequence.length; i += 1) {
      const candidate = state.sequence[i];
      if (candidate !== current) {
        nextIndex = i;
        nextTransport = candidate;
        break;
      }
    }

    if (nextIndex === state.index || nextTransport === current) {
      return;
    }

    const now = Date.now();
    const previousTransport = current;
    state.index = nextIndex;
    state.current = nextTransport;
    state.lastReason = reason;
    state.lastChangeAt = now;
    state.totalChanges += 1;

    this.options.rtspTransport = nextTransport;
    this.clearPersistentCommandClassifications();
    this.resetRestartBackoffForFallback();
    this.resetCircuitBreakerForFallback();

    const channel = this.channel ?? null;

    metrics.recordTransportFallback('ffmpeg', reason, {
      channel: channel ?? undefined,
      from: previousTransport,
      to: nextTransport,
      attempt,
      stage: nextIndex,
      resetsBackoff: true,
      resetsCircuitBreaker: true,
      sequence: [...state.sequence],
      errorCode: context.errorCode ?? null,
      exitCode: context.exitCode ?? null,
      signal: context.signal ?? null,
      at: now
    });

    this.emit(
      'transport-change',
      {
        channel,
        from: previousTransport,
        to: nextTransport,
        reason,
        attempt,
        stage: nextIndex,
        resetsBackoff: true,
        resetsCircuitBreaker: true,
        at: now,
        metricsRecorded: true
      } satisfies TransportFallbackEvent
    );
  }

  private resetRtspFallbackState(options: {
    reason: string;
    record?: boolean;
    resetsCircuitBreaker?: boolean;
  }) {
    const state = this.rtspFallbackState;
    if (!state) {
      return;
    }

    const target = state.sequence[0];
    const previous = state.current;
    state.index = 0;
    state.current = target;
    state.lastReason = options.reason;
    state.lastChangeAt = Date.now();
    this.options.rtspTransport = target;
    this.clearPersistentCommandClassifications();
    this.resetRestartBackoffForFallback();
    this.resetCircuitBreakerForFallback();

    if (previous === target) {
      return;
    }

    const channel = this.channel ?? null;
    const shouldRecord = options.record ?? false;

    if (shouldRecord) {
      metrics.recordTransportFallback('ffmpeg', options.reason, {
        channel: channel ?? undefined,
        from: previous,
        to: target,
        attempt: 0,
        stage: state.index,
        resetsBackoff: true,
        resetsCircuitBreaker: options.resetsCircuitBreaker ?? false,
        sequence: [...state.sequence],
        at: state.lastChangeAt
      });
    }

    this.emit(
      'transport-change',
      {
        channel,
        from: previous,
        to: target,
        reason: options.reason,
        attempt: 0,
        stage: state.index,
        resetsBackoff: true,
        resetsCircuitBreaker: options.resetsCircuitBreaker ?? false,
        at: state.lastChangeAt,
        metricsRecorded: shouldRecord
      } satisfies TransportFallbackEvent
    );
  }

  private resetRestartBackoffForFallback() {
    this.restartCount = 0;
    this.pendingRestartContext = null;
  }

  private resetCircuitBreakerForFallback() {
    this.circuitBreakerFailures = 0;
    this.lastCircuitCandidateReason = null;
  }

  private markRtspFallbackSuccess() {
    if (!this.rtspFallbackState) {
      return;
    }

    this.rtspFallbackState.lastReason = null;
  }

  getCurrentRtspTransport() {
    if (!this.rtspFallbackState) {
      return this.options.rtspTransport ?? null;
    }
    return this.rtspFallbackState.current ?? null;
  }

  private normalizeErrno(error: unknown): RecoveryContext {
    if (!error || typeof error !== 'object') {
      return { errorCode: null, exitCode: null, signal: null };
    }

    const err = error as Errno;
    const code = err.code;
    const errno = err.errno;
    const errorCode = typeof code === 'string' ? code : typeof errno === 'number' ? errno : null;
    const exitCode = typeof code === 'number' ? code : null;
    return {
      errorCode: errorCode ?? null,
      exitCode,
      signal: null
    };
  }

  private resetCommandClassifications(options: { preservePersistent?: boolean } = {}) {
    const preservePersistent = options.preservePersistent ?? false;
    if (!preservePersistent) {
      this.commandClassifications.clear();
      return;
    }

    for (const key of Array.from(this.commandClassifications)) {
      if (!key.startsWith('persistent:')) {
        this.commandClassifications.delete(key);
      }
    }
  }

  private clearPersistentCommandClassifications() {
    for (const key of Array.from(this.commandClassifications)) {
      if (key.startsWith('persistent:')) {
        this.commandClassifications.delete(key);
      }
    }
  }

  private buildClassificationKey(classification: FfmpegClassification) {
    const reason = classification.reason;
    const prefix = isPersistentClassification(reason)
      ? 'persistent'
      : `transient:${this.commandGeneration}`;
    return `${prefix}:${reason}`;
  }

  private handleCommandStderr(message: string) {
    if (!message) {
      return;
    }

    const lines = String(message)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const classification = classifyFfmpegStderr(line);
      if (!classification) {
        continue;
      }

      const key = this.buildClassificationKey(classification);
      if (this.commandClassifications.has(key)) {
        continue;
      }

      this.commandClassifications.add(key);

      const context: RecoveryContext = {
        errorCode: classification.errorCode ?? classification.reason,
        exitCode: classification.exitCode ?? null,
        signal: classification.signal ?? null
      };

      this.scheduleRecovery(classification.reason, context);
      if (classification.breakAfter) {
        break;
      }
    }
  }
}

type FfmpegClassification = {
  reason: string;
  errorCode?: string | number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  breakAfter?: boolean;
};

const DEFAULT_RTSP_TRANSPORT = 'tcp';
const DEFAULT_RTSP_SEQUENCE = ['tcp', 'udp', 'tcp'];

function createRtspFallbackState(
  initial: string | null,
  override?: string[]
): RtspFallbackState {
  const base = initial ?? DEFAULT_RTSP_TRANSPORT;
  const sequence = buildRtspFallbackSequence(base, override);
  const index = Math.max(0, sequence.indexOf(base));
  const current = sequence[index] ?? sequence[0] ?? DEFAULT_RTSP_TRANSPORT;
  return {
    base: sequence[0] ?? DEFAULT_RTSP_TRANSPORT,
    sequence,
    index,
    current,
    lastReason: null,
    lastChangeAt: null,
    totalChanges: 0
  };
}

function buildRtspFallbackSequence(initial: string, override?: string[]): string[] {
  const normalizedInitial = normalizeRtspTransport(initial) ?? DEFAULT_RTSP_TRANSPORT;
  const sequence: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null) => {
    if (!value) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    sequence.push(value);
    seen.add(value);
  };

  const normalizedOverride = Array.isArray(override)
    ? override
        .map(value => normalizeRtspTransport(value))
        .filter((value): value is string => typeof value === 'string')
    : [];

  if (normalizedOverride.length > 0) {
    push(normalizedOverride[0]);
    if (normalizedOverride[0] !== normalizedInitial) {
      push(normalizedInitial);
    }
    for (let i = 1; i < normalizedOverride.length; i += 1) {
      push(normalizedOverride[i]);
    }
  } else {
    push(normalizedInitial);
  }

  for (const transport of DEFAULT_RTSP_SEQUENCE) {
    push(transport);
  }

  return sequence;
}

function normalizeRtspTransport(value?: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isRtspInputSource(file: string): boolean {
  return /^rtsps?:\/\//i.test(file);
}

function isRtspFallbackReason(reason: string) {
  return reason === 'rtsp-timeout' || reason === 'rtsp-connection-failure';
}

function isPersistentClassification(reason: string) {
  return reason.startsWith('rtsp-');
}

const RTSP_TIMEOUT_PATTERNS = [
  /method\s+DESCRIBE\s+failed:.*timed out/i,
  /RTSP\s+response\s+timeout/i,
  /Connection\s+timed\s*out/i,
  /Read\s+timeout\s+after\s+[0-9]+\s+ms/i
];

const RTSP_AUTH_PATTERNS = [
  /method\s+DESCRIBE\s+failed:.*401/i,
  /RTSP\/1\.0\s+401\s+unauthorized/i,
  /401\s+unauthorized/i,
  /authorization\s+failed/i,
  /authentication\s+failed/i,
  /unauthorized\s+access/i
];

const RTSP_NOT_FOUND_PATTERNS = [
  /method\s+DESCRIBE\s+failed:.*(404|5\d\d)/i,
  /RTSP\/1\.0\s+404/i,
  /RTSP\/1\.0\s+5\d\d/i,
  /404\s+not\s+found/i,
  /server\s+returned\s+5\d\d/i,
  /5\d\d\s+(internal|server)\s+error/i
];

const RTSP_CONNECTION_PATTERNS = [
  /connection\s+refused/i,
  /connection\s+reset/i,
  /no\s+route\s+to\s+host/i,
  /network\s+is\s+unreachable/i,
  /unable\s+to\s+connect/i
];

function classifyFfmpegStderr(message: string): FfmpegClassification | null {
  if (!message) {
    return null;
  }

  for (const pattern of RTSP_TIMEOUT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        reason: 'rtsp-timeout',
        errorCode: 'rtsp-timeout',
        breakAfter: true
      };
    }
  }

  for (const pattern of RTSP_AUTH_PATTERNS) {
    if (pattern.test(message)) {
      return {
        reason: 'rtsp-auth-failure',
        errorCode: 'rtsp-auth-failure',
        breakAfter: true
      };
    }
  }

  for (const pattern of RTSP_NOT_FOUND_PATTERNS) {
    if (pattern.test(message)) {
      return {
        reason: 'rtsp-not-found',
        errorCode: 'rtsp-not-found',
        breakAfter: true
      };
    }
  }

  for (const pattern of RTSP_CONNECTION_PATTERNS) {
    if (pattern.test(message)) {
      return {
        reason: 'rtsp-connection-failure',
        errorCode: 'rtsp-connection-failure',
        breakAfter: true
      };
    }
  }

  return null;
}

export type SliceResult = {
  png: Buffer;
  remainder: Buffer;
};

export function slicePng(buffer: Buffer): SliceResult | null {
  if (buffer.length < PNG_SIGNATURE.length) {
    return null;
  }

  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 8 + length + 4;

    if (chunkEnd > buffer.length) {
      return null;
    }

    offset = chunkEnd;

    if (chunkType === 'IEND') {
      return {
        png: buffer.subarray(0, offset),
        remainder: buffer.subarray(offset)
      };
    }
  }

  return null;
}

export function slicePngStream(stream: Readable, handler: (frame: Buffer) => void) {
  let buffer = Buffer.alloc(0);

  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const frame = slicePng(buffer);
      if (!frame) {
        break;
      }

      handler(frame.png);
      buffer = frame.remainder;
    }
  });
}
