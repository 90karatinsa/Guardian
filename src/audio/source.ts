import { EventEmitter } from 'node:events';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
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
    }
  | {
      type: 'ffmpeg';
      input: string;
      sampleRate?: number;
      channels?: number;
      frameDurationMs?: number;
      extraInputArgs?: string[];
    };

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FRAME_DURATION_MS = 100;

export class AudioSource extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);

  constructor(private readonly options: AudioSourceOptions) {
    super();
  }

  start() {
    if (this.process) {
      return;
    }

    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const channels = this.options.channels ?? DEFAULT_CHANNELS;
    const ffmpegPath = (ffmpegStatic as string | null) ?? 'ffmpeg';

    const args = this.buildFfmpegArgs(sampleRate, channels);

    this.process = spawn(ffmpegPath, args, {
      stdio: this.options.type === 'ffmpeg' && this.options.input === 'pipe:0' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', chunk => {
      this.consumeChunk(chunk, sampleRate, channels);
    });

    this.process.stderr.on('data', chunk => {
      this.emit('stderr', chunk.toString());
    });

    this.process.on('error', error => {
      this.emit('error', error);
    });

    this.process.on('close', code => {
      this.emit('close', code);
      this.process = null;
    });
  }

  stop() {
    if (this.process) {
      this.process.kill('SIGINT');
      this.process = null;
    }
  }

  consume(stream: Readable, sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS) {
    stream.on('data', chunk => {
      this.consumeChunk(chunk, sampleRate, channels);
    });
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
