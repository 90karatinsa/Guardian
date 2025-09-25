import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess, ExecFileCallback, ExecFileException } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
const execFileMock = vi.fn();
const meydaExtractMock = vi.fn();

vi.mock('ffmpeg-static', () => ({
  default: null
}));

vi.mock('meyda', () => ({
  default: {
    extract: (...args: unknown[]) => {
      meydaExtractMock(...args);
      return { rms: 0.001, spectralCentroid: 0 };
    }
  }
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
    execFile: execFileMock
  };
});

describe('AudioSource resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    execFileMock.mockReset();
    meydaExtractMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AudioSourceFallback retries when ffmpeg is missing', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    spawnMock.mockImplementation(() => {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      retryDelayMs: 500,
      restartJitterFactor: 0,
      random: () => 0.5
    });
    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    source.start();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    const event = recoverSpy.mock.calls[0][0];
    expect(event.reason).toBe('ffmpeg-missing');
    expect(event.meta.baseDelayMs).toBe(500);
    expect(event.meta.minDelayMs).toBe(500);
    expect(errorSpy).toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(spawnMock).toHaveBeenCalledTimes(4);

    source.stop();
  });

  it('AudioSourceFallback feeds anomaly detector with aligned windows', async () => {
    const { AudioSource } = await import('../src/audio/source.js');
    const { default: AudioAnomalyDetector } = await import('../src/audio/anomaly.js');
    const stream = new PassThrough();
    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 50
    });

    (source as any).alignChunks = true;
    (source as any).expectedSampleBytes = 2;
    source.consume(stream, 8000, 1);

    const bus = new EventEmitter();
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate: 8000,
        frameDurationMs: 50,
        hopDurationMs: 25,
        rmsThreshold: 0.4,
        centroidJumpThreshold: 5000,
        minIntervalMs: 0,
        minTriggerDurationMs: 150
      },
      bus
    );

    source.on('data', samples => detector.handleChunk(samples, Date.now()));

    const frameBytes = (8000 * 50) / 1000 * 2;
    const framesEmitted = 5;
    for (let i = 0; i < framesEmitted; i += 1) {
      stream.write(Buffer.alloc(frameBytes));
    }

    const frameSizeSamples = (8000 * 50) / 1000;
    const hopSizeSamples = (8000 * 25) / 1000;
    const expectedWindows = 1 + (framesEmitted - 1) * (frameSizeSamples / hopSizeSamples);
    expect(meydaExtractMock).toHaveBeenCalledTimes(expectedWindows);
    expect(meydaExtractMock.mock.calls[0]?.[1]).toBeInstanceOf(Float32Array);
    source.stop();
  });

  it('AudioSourceFallback rotates microphone after sustained silence', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    const processes: ReturnType<typeof createFakeProcess>[] = [];
    const attemptedArgs: string[][] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      attemptedArgs.push(args);
      const proc = createFakeProcess();
      processes.push(proc);
      return proc;
    });

    const source = new AudioSource({
      type: 'mic',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 50,
      silenceDurationMs: 200,
      silenceThreshold: 0.0005,
      restartDelayMs: 100,
      restartMaxDelayMs: 100,
      restartJitterFactor: 0,
      micFallbacks: {
        linux: [{ format: 'alsa', device: 'hw:1' }]
      },
      random: () => 0.5
    });

    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    try {
      source.start();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const proc = processes[0];
      expect(proc).toBeDefined();

      const frameBytes = (8000 * 50) / 1000 * 2;
      const silentFrame = Buffer.alloc(frameBytes);
      for (let i = 0; i < 5; i += 1) {
        proc.stdout.emit('data', silentFrame);
      }

      expect(recoverSpy).toHaveBeenCalledTimes(1);
      const event = recoverSpy.mock.calls[0][0];
      expect(event.reason).toBe('stream-silence');
      expect(event.meta.baseDelayMs).toBe(100);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));

      vi.advanceTimersByTime(100);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(attemptedArgs.length).toBeGreaterThanOrEqual(2);
      expect(attemptedArgs.some(args => args.includes('hw:1'))).toBe(true);
    } finally {
      source.stop();
      platformSpy.mockRestore();
    }
  });

  it('AudioDeviceFallback rotates microphone inputs across platforms', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    const attempted: string[][] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      attempted.push(args);
      if (attempted.length === 1) {
        const err = new Error('device busy') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }

      return createFakeProcess();
    });

    const source = new AudioSource({
      type: 'mic',
      retryDelayMs: 10,
      micFallbacks: {
        linux: [
          { format: 'alsa', device: 'custom0' },
          { format: 'alsa', device: 'custom1' }
        ]
      }
    });

    try {
      source.start();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(attempted[0]).toContain('default');
      expect(attempted[1]).toContain('custom0');
    } finally {
      source.stop();
      platformSpy.mockRestore();
    }
  });

  it('AudioSourceFallback parses device list output with fallback chain', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const output = `
[dshow @ 000002] DirectShow audio devices
[dshow @ 000002]  "Microphone (USB)"
[dshow @ 000002]  "Line In (High Definition)"
`;

    execFileMock.mockImplementation((command: string, args: string[], callback: ExecFileCallback) => {
      const formatIndex = args.indexOf('-f');
      const format = formatIndex >= 0 ? args[formatIndex + 1] : '';
      if (format === 'alsa') {
        const error = new Error('alsa not available') as ExecFileException;
        callback(error, '', '');
        return {} as ChildProcess;
      }
      callback(null, '', output);
      return {} as ChildProcess;
    });

    const devices = await AudioSource.listDevices('auto');

    expect(execFileMock).toHaveBeenCalled();
    expect(devices).toEqual(['Microphone (USB)', 'Line In (High Definition)']);
  });

  it('AudioWindowing enforces alignment for pipe inputs', async () => {
    const { AudioSource } = await import('../src/audio/source.js');
    const source = new AudioSource({ type: 'ffmpeg', input: 'pipe:0', sampleRate: 8000, channels: 1 });
    const errorSpy = vi.fn();
    source.on('error', errorSpy);

    const stream = new PassThrough();
    (source as any).alignChunks = true;
    (source as any).expectedSampleBytes = 2;

    source.consume(stream, 8000, 1);
    stream.emit('data', Buffer.alloc(3));

    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
  });
});

function createFakeProcess() {
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  (proc as any).kill = vi.fn(() => {
    proc.killed = true;
    proc.emit('close', 0);
    return true;
  });
  return proc;
}
