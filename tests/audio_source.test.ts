import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess, ExecFileCallback, ExecFileException } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
const execFileMock = vi.fn();

vi.mock('ffmpeg-static', () => ({
  default: null
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

    const source = new AudioSource({ type: 'ffmpeg', input: 'pipe:0', retryDelayMs: 500 });
    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    source.start();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(recoverSpy.mock.calls[0][0].reason).toBe('ffmpeg-missing');
    expect(errorSpy).toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(spawnMock).toHaveBeenCalledTimes(4);

    source.stop();
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

    const source = new AudioSource({ type: 'mic', retryDelayMs: 10 });

    try {
      source.start();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(attempted[0]).toContain('default');
      expect(attempted[1]).toContain('hw:0');
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
    proc.stdout.emit('close');
    return true;
  });
  return proc;
}
