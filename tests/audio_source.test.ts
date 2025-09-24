import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess, ExecFileCallback } from 'node:child_process';

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

  it('AudioSourceFallback parses device list output', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const output = `
[dshow @ 000002] DirectShow audio devices
[dshow @ 000002]  "Microphone (USB)"
[dshow @ 000002]  "Line In (High Definition)"
`;

    execFileMock.mockImplementation((command: string, args: string[], callback: ExecFileCallback) => {
      callback(null, '', output);
      return {} as ChildProcess;
    });

    const devices = await AudioSource.listDevices('dshow');

    expect(execFileMock).toHaveBeenCalled();
    expect(devices).toEqual(['Microphone (USB)', 'Line In (High Definition)']);
  });
});
