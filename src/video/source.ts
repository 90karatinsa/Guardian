import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import metrics from '../metrics/index.js';

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
};

export type RecoverEventMeta = {
  minDelayMs: number;
  maxDelayMs: number;
  baseDelayMs: number;
  appliedJitterMs: number;
};

export type RecoverEvent = {
  reason: string;
  attempt: number;
  delayMs: number;
  meta: RecoverEventMeta;
};

type RestartDelayResult = {
  delayMs: number;
  meta: RecoverEventMeta;
};

export class VideoSource extends EventEmitter {
  private command: ffmpeg.FfmpegCommand | null = null;
  private commandCleanup: (() => void) | null = null;
  private stream: Readable | null = null;
  private streamCleanup: (() => void) | null = null;
  private buffer = Buffer.alloc(0);
  private startTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private commandExitPromise: Promise<void> | null = null;
  private commandExitResolve: (() => void) | null = null;
  private terminatingCommand: ffmpeg.FfmpegCommand | null = null;
  private shouldStop = false;
  private recovering = false;
  private restartCount = 0;
  private hasReceivedFrame = false;

  constructor(private readonly options: VideoSourceOptions) {
    super();
  }

  start() {
    this.shouldStop = false;
    this.recovering = false;
    this.restartCount = 0;
    this.hasReceivedFrame = false;
    this.clearAllTimers();
    this.startCommand();
  }

  stop() {
    this.shouldStop = true;
    this.recovering = false;
    this.restartCount = 0;
    this.hasReceivedFrame = false;
    this.clearAllTimers();
    this.cleanupStream();
    this.terminateCommand(true, { skipForceDelay: true });
  }

  consume(stream: Readable) {
    this.cleanupStream();
    this.stream = stream;
    this.buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      if (!this.hasReceivedFrame) {
        this.hasReceivedFrame = true;
        this.restartCount = 0;
        this.clearStartTimer();
      }

      this.resetWatchdogTimer();
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { frames, remainder, corrupted } = this.extractFrames(this.buffer);
      this.buffer = remainder;

      for (const frame of frames) {
        this.emit('frame', frame);
      }

      if (corrupted) {
        this.emit('error', new Error('Corrupted frame encountered'));
        this.scheduleRecovery('corrupted-frame');
      }
    };

    const onError = (err: Error) => {
      this.emit('error', err);
      this.scheduleRecovery('stream-error');
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
    const command = this.createCommand();
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
      this.emit('error', err);
      this.scheduleRecovery('ffmpeg-error');
    };

    const onEnd = () => {
      this.finalizeCommandLifecycle();
      if (this.shouldStop || this.recovering) {
        return;
      }
      this.emit('end');
      this.scheduleRecovery('ffmpeg-ended');
    };

    const onClose = () => {
      this.finalizeCommandLifecycle();
    };

    command.once('error', onError);
    command.once('end', onEnd);
    command.once('close', onClose);
    const onStart = () => {
      this.clearStartTimer();
    };
    command.once('start', onStart);

    this.commandCleanup = () => {
      command.off('error', onError);
      command.off('end', onEnd);
      command.off('close', onClose);
      command.off('start', onStart);
    };

    try {
      const stream = command.pipe();
      this.consume(stream);
    } catch (error) {
      this.finalizeCommandLifecycle();
      this.emit('error', error as Error);
      this.scheduleRecovery('start-error');
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
  }

  private scheduleRecovery(reason: string) {
    if (this.shouldStop) {
      return;
    }

    if (this.restartTimer) {
      return;
    }

    this.recovering = true;
    this.restartCount += 1;
    const attempt = this.restartCount;
    const timing = this.computeRestartDelay(attempt);

    metrics.recordPipelineRestart('ffmpeg', reason, {
      attempt,
      delayMs: timing.delayMs,
      baseDelayMs: timing.meta.baseDelayMs,
      minDelayMs: timing.meta.minDelayMs,
      maxDelayMs: timing.meta.maxDelayMs,
      jitterMs: timing.meta.appliedJitterMs,
      channel: this.options.channel
    });
    this.emit(
      'recover',
      { reason, attempt, delayMs: timing.delayMs, meta: timing.meta } satisfies RecoverEvent
    );

    this.clearStartTimer();
    this.clearWatchdogTimer();
    this.cleanupStream();
    const termination = this.terminateCommand(true);
    const waitForTermination = termination ?? Promise.resolve();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      waitForTermination
        .catch(() => {})
        .then(() => {
          if (this.shouldStop) {
            return;
          }
          this.startCommand();
        });
    }, Math.max(0, timing.delayMs));
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
    this.clearKillTimer();
  }

  private terminateCommand(
    force = false,
    options: { skipForceDelay?: boolean } = {}
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
      this.finalizeCommandLifecycle();
    }, delay);

    return exitPromise;
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

  private resetWatchdogTimer() {
    this.clearWatchdogTimer();
    if (this.shouldStop) {
      return;
    }

    const idleTimeout =
      this.options.watchdogTimeoutMs ?? this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

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
    };
  }
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
