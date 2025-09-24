import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const ffmpegPath = ffmpegStatic as string | null;
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_IDLE_TIMEOUT_MS = 5000;
const DEFAULT_RESTART_DELAY_MS = 500;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

export type VideoSourceOptions = {
  file: string;
  framesPerSecond: number;
  idleTimeoutMs?: number;
  restartDelayMs?: number;
  maxBufferBytes?: number;
  forceKillTimeoutMs?: number;
  commandFactory?: (options: { file: string; framesPerSecond: number }) => ffmpeg.FfmpegCommand;
};

export type RecoverEvent = {
  reason: string;
  attempt: number;
};

export class VideoSource extends EventEmitter {
  private command: ffmpeg.FfmpegCommand | null = null;
  private commandCleanup: (() => void) | null = null;
  private stream: Readable | null = null;
  private streamCleanup: (() => void) | null = null;
  private buffer = Buffer.alloc(0);
  private idleTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private shouldStop = false;
  private recovering = false;
  private restartCount = 0;

  constructor(private readonly options: VideoSourceOptions) {
    super();
  }

  start() {
    this.shouldStop = false;
    this.restartCount = 0;
    this.startCommand();
  }

  stop() {
    this.shouldStop = true;
    this.clearRestartTimer();
    this.clearIdleTimer();
    this.cleanupStream();
    this.terminateCommand(true);
  }

  consume(stream: Readable) {
    this.cleanupStream();
    this.stream = stream;
    this.buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      this.resetIdleTimer();
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { frames, remainder, corrupted } = this.extractFrames(this.buffer);
      this.buffer = remainder;

      for (const frame of frames) {
        this.emit('frame', frame);
      }

      if (corrupted) {
        this.emit('error', new Error('Corrupted frame encountered'));
        this.scheduleRecovery('Corrupted frame encountered');
      }
    };

    const onError = (err: Error) => {
      this.emit('error', err);
      this.scheduleRecovery('Stream error');
    };

    const onClose = () => {
      if (this.shouldStop) {
        return;
      }
      this.scheduleRecovery('Stream closed');
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

    this.resetIdleTimer();
  }

  private startCommand() {
    if (this.shouldStop) {
      return;
    }

    this.recovering = false;
    const command = this.createCommand();
    this.command = command;

    const onError = (err: Error) => {
      this.clearKillTimer();
      if (this.shouldStop || this.recovering) {
        return;
      }
      this.emit('error', err);
      this.scheduleRecovery('ffmpeg error');
    };

    const onEnd = () => {
      this.clearKillTimer();
      if (this.shouldStop || this.recovering) {
        return;
      }
      this.emit('end');
      this.scheduleRecovery('ffmpeg ended');
    };

    command.once('error', onError);
    command.once('end', onEnd);

    this.commandCleanup = () => {
      command.off('error', onError);
      command.off('end', onEnd);
    };

    try {
      const stream = command.pipe();
      this.consume(stream);
    } catch (error) {
      this.emit('error', error as Error);
      this.scheduleRecovery('Unable to start ffmpeg');
    }
  }

  private createCommand() {
    if (this.options.commandFactory) {
      return this.options.commandFactory({
        file: this.options.file,
        framesPerSecond: this.options.framesPerSecond
      });
    }

    return ffmpeg(this.options.file)
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
    this.emit('recover', { reason, attempt: this.restartCount } as RecoverEvent);

    this.clearIdleTimer();
    this.cleanupStream();
    this.terminateCommand(true);

    const delay = this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startCommand();
    }, delay);
  }

  private terminateCommand(force = false) {
    if (!this.command) {
      return;
    }

    const command = this.command;
    this.command = null;

    this.commandCleanup?.();
    this.commandCleanup = null;

    if (!force) {
      return;
    }

    try {
      command.kill('SIGTERM');
    } catch (error) {
      // Swallow errors from already terminated processes
    }

    this.clearKillTimer();
    const delay = this.options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;

    const cleanup = () => {
      this.clearKillTimer();
      command.off('end', cleanup);
      command.off('error', cleanup);
    };

    command.once('end', cleanup);
    command.once('error', cleanup);

    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      cleanup();
      try {
        command.kill('SIGKILL');
      } catch (error) {
        // Ignore
      }
    }, delay);
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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

  private resetIdleTimer() {
    this.clearIdleTimer();
    if (this.shouldStop) {
      return;
    }

    const idleTimeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.shouldStop) {
        return;
      }
      this.scheduleRecovery('Stream stalled');
    }, idleTimeout);
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
