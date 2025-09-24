import { EventEmitter } from 'node:events';
import {
  spawn,
  execFile,
  ChildProcessWithoutNullStreams,
  ExecFileException
} from 'node:child_process';
import { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';

export type AudioSourceOptions =
  | {
      type: 'mic';
      device?: string;
      inputFormat?: 'alsa' | 'avfoundation' | 'dshow';
      sampleRate?: number;
      channels?: number;
      frameDurationMs?: number;
      retryDelayMs?: number;
    }
  | {
      type: 'ffmpeg';
      input: string;
      sampleRate?: number;
      channels?: number;
      frameDurationMs?: number;
      extraInputArgs?: string[];
      retryDelayMs?: number;
    };

export type AudioRecoverEvent = {
  reason: 'ffmpeg-missing' | 'spawn-error' | 'process-exit';
  attempt: number;
  delayMs: number;
  error?: Error;
};

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FRAME_DURATION_MS = 100;
const DEFAULT_RETRY_DELAY_MS = 3000;

const FFMPEG_CANDIDATES = buildFfmpegCandidates();
const FFPROBE_CANDIDATES = buildFfprobeCandidates();

export class AudioSource extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private processCleanup: (() => void) | null = null;
  private buffer = Buffer.alloc(0);
  private retryTimer: NodeJS.Timeout | null = null;
  private retryCount = 0;
  private shouldStop = false;
  private currentBinaryIndex = 0;
  private lastSuccessfulIndex = 0;

  constructor(private readonly options: AudioSourceOptions) {
    super();
  }

  start() {
    if (this.process || this.retryTimer) {
      return;
    }

    this.shouldStop = false;
    this.retryCount = 0;
    this.currentBinaryIndex = this.lastSuccessfulIndex;
    this.startProcess();
  }

  stop() {
    this.shouldStop = true;
    this.clearRetryTimer();
    this.tearDownProcess();
  }

  consume(stream: Readable, sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS) {
    stream.on('data', chunk => {
      this.consumeChunk(chunk, sampleRate, channels);
    });
  }

  static async listDevices(format: 'alsa' | 'avfoundation' | 'dshow') {
    const args = ['-hide_banner', '-loglevel', 'info', '-f', format, '-list_devices', 'true', '-i', 'dummy'];

    let lastError: Error | null = null;

    for (const command of FFPROBE_CANDIDATES) {
      try {
        const { stdout, stderr } = await execFileAsync(command, args);
        const parsed = parseDeviceList(`${stdout}\n${stderr}`);
        return parsed;
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError ?? new Error('Unable to list audio devices');
  }

  private startProcess() {
    if (this.shouldStop) {
      return;
    }

    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const channels = this.options.channels ?? DEFAULT_CHANNELS;
    const args = this.buildFfmpegArgs(sampleRate, channels);

    let attemptIndex = this.currentBinaryIndex;

    while (attemptIndex < FFMPEG_CANDIDATES.length) {
      const binary = FFMPEG_CANDIDATES[attemptIndex];
      try {
        const stdio =
          this.options.type === 'ffmpeg' && this.options.input === 'pipe:0'
            ? ['pipe', 'pipe', 'pipe']
            : ['ignore', 'pipe', 'pipe'];

        const proc = spawn(binary, args, { stdio });

        this.attachProcess(proc, sampleRate, channels, attemptIndex);
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          attemptIndex += 1;
          continue;
        }

        this.emit('error', err);
        this.scheduleRetry('spawn-error', err);
        return;
      }
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
    binaryIndex: number
  ) {
    this.teardownListeners();
    this.process = proc;
    this.currentBinaryIndex = binaryIndex;
    this.lastSuccessfulIndex = binaryIndex;

    const onStdout = (chunk: Buffer) => {
      this.consumeChunk(chunk, sampleRate, channels);
    };

    const onStderr = (chunk: Buffer) => {
      this.emit('stderr', chunk.toString());
    };

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);

    const onError = (error: NodeJS.ErrnoException) => {
      this.emit('error', error);
      this.teardownListeners();

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
      this.teardownListeners();

      if (this.shouldStop) {
        return;
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
      proc.off('close', onClose);
      if (!proc.killed) {
        try {
          proc.kill('SIGINT');
        } catch (error) {
          // Ignore termination errors
        }
      }
      proc.stdout.destroy();
      proc.stderr.destroy();
    };
  }

  private scheduleRetry(reason: AudioRecoverEvent['reason'], error?: Error) {
    if (this.shouldStop) {
      return;
    }

    this.clearRetryTimer();
    this.retryCount += 1;
    const delay = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startProcess();
    }, delay);

    this.emit('recover', {
      reason,
      attempt: this.retryCount,
      delayMs: delay,
      error
    } as AudioRecoverEvent);
  }

  private teardownListeners() {
    if (!this.process) {
      return;
    }

    this.processCleanup?.();
    this.processCleanup = null;
    this.process = null;
    this.buffer = Buffer.alloc(0);
  }

  private tearDownProcess() {
    this.teardownListeners();
  }

  private clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private consumeChunk(chunk: Buffer, sampleRate: number, channels: number) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frameSizeSamples = this.calculateFrameSize(sampleRate, channels);
    const frameSizeBytes = frameSizeSamples * 2;

    while (this.buffer.length >= frameSizeBytes) {
      const frame = this.buffer.subarray(0, frameSizeBytes);
      this.buffer = this.buffer.subarray(frameSizeBytes);
      const samples = bufferToInt16(frame);
      this.emit('data', samples);
    }
  }

  private calculateFrameSize(sampleRate: number, channels: number) {
    const frameDuration = this.options.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS;
    return Math.max(1, Math.floor((sampleRate * frameDuration) / 1000)) * channels;
  }

  private buildFfmpegArgs(sampleRate: number, channels: number) {
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
      const platform = process.platform;
      const format = this.options.inputFormat ?? defaultMicFormat(platform);
      const device = this.options.device ?? defaultMicDevice(platform);
      const inputArgs: string[] = [];
      if (format) {
        inputArgs.push('-f', format);
      }
      inputArgs.push('-i', device);
      return [...inputArgs, ...outputArgs];
    }

    const inputArgs = [...(this.options.extraInputArgs ?? []), '-i', this.options.input];
    return [...inputArgs, ...outputArgs];
  }
}

function bufferToInt16(buffer: Buffer): Int16Array {
  const samples = new Int16Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(i * 2);
  }
  return samples;
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

function execFileAsync(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (error) {
        const err = error as ExecFileException & { stdout?: string; stderr?: string };
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
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

export default AudioSource;
