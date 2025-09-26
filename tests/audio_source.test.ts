import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess, ExecFileCallback, ExecFileException } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import metrics from '../src/metrics/index.js';

type AudioFatalEvent = import('../src/audio/source.js').AudioFatalEvent;

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
    metrics.reset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { AudioSource } = await import('../src/audio/source.js');
    AudioSource.clearDeviceCache();
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

  it('AudioDeviceFallbackDiscovery preserves discovered device ordering', async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    const output = `
[alsa @ 0x7f] ALSA audio devices
[0] hw:1,0
[1] plughw:2,0
`;

    execFileMock.mockImplementation((_command: string, _args: string[], callback: ExecFileCallback) => {
      const child = createExecFileChild();
      callback(null, output, '');
      return child;
    });

    const encountered: Array<{ format?: string; device?: string }> = [];
    const seen = new Set<string>();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const formatIndex = args.indexOf('-f');
      const deviceIndex = args.indexOf('-i');
      const format = formatIndex >= 0 ? args[formatIndex + 1] : undefined;
      const device = deviceIndex >= 0 ? args[deviceIndex + 1] : undefined;
      const key = `${format ?? 'none'}|${device ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        encountered.push({ format, device });
      }
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const source = new AudioSource({
      type: 'mic',
      sampleRate: 16000,
      channels: 1,
      frameDurationMs: 50,
      device: 'default',
      restartDelayMs: 25,
      restartMaxDelayMs: 25,
      restartJitterFactor: 0,
      random: () => 0.5
    });

    const recoverSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', () => {});
    source.start();

    await waitForCondition(() => recoverSpy.mock.calls.length > 0, 1000);

    expect(encountered).toEqual([
      { format: 'alsa', device: 'default' },
      { format: 'alsa', device: 'hw:1,0' },
      { format: 'alsa', device: 'plughw:2,0' },
      { format: 'alsa', device: 'hw:0' },
      { format: 'alsa', device: 'plughw:0' }
    ]);

    source.stop();
    await vi.runOnlyPendingTimersAsync();
    platformSpy.mockRestore();
  });

  it('AudioPipeMisalignTriggersRecovery restarts pipe streams on misaligned chunks', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      sampleRate: 16000,
      channels: 1,
      frameDurationMs: 20,
      restartDelayMs: 100,
      restartMaxDelayMs: 100,
      restartJitterFactor: 0,
      random: () => 0.5
    });

    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    const stream = new PassThrough();
    (source as any).alignChunks = true;
    (source as any).expectedSampleBytes = 2;

    source.consume(stream, 16000, 1);

    stream.write(Buffer.alloc(3));

    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalled();
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    const event = recoverSpy.mock.calls[0][0];
    expect(event.reason).toBe('stream-error');

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.audio.byReason['stream-error']).toBe(1);

    await vi.runOnlyPendingTimersAsync();
    source.stop();
  });

  it('AudioWatchdogSilenceReset recovers from silence and restarts on watchdog timeout', async () => {
    vi.useFakeTimers();
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
      silenceDurationMs: 150,
      silenceThreshold: 0.0005,
      restartDelayMs: 100,
      restartMaxDelayMs: 100,
      restartJitterFactor: 0,
      watchdogTimeoutMs: 120,
      micFallbacks: {
        linux: [{ format: 'alsa', device: 'hw:1' }]
      },
      random: () => 0.5
    });

    const recoverReasons: string[] = [];
    source.on('recover', event => recoverReasons.push(event.reason));
    source.on('error', () => {});

    try {
      source.start();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      const proc = processes[0];
      const frameBytes = (8000 * 50) / 1000 * 2;
      const silentFrame = Buffer.alloc(frameBytes);
      for (let i = 0; i < 5; i += 1) {
        proc.stdout.emit('data', silentFrame);
      }

      expect(recoverReasons).toContain('stream-silence');

      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(attemptedArgs.some(args => args.includes('hw:1'))).toBe(true);

      const nextProc = processes[1];
      expect(nextProc).toBeDefined();

      await vi.advanceTimersByTimeAsync(121);
      await Promise.resolve();

      expect(recoverReasons.filter(reason => reason === 'watchdog-timeout')).not.toHaveLength(0);
    } finally {
      source.stop();
      platformSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('AudioSilenceCircuitBreaker stops retries and records fatal restart', async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      return createFakeProcess();
    });

    const source = new AudioSource({
      type: 'mic',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 40,
      silenceDurationMs: 40,
      silenceThreshold: 0.0001,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      watchdogTimeoutMs: 60,
      silenceCircuitBreakerThreshold: 3,
      micFallbacks: {
        linux: [
          { format: 'alsa', device: 'hw:1' },
          { format: 'alsa', device: 'hw:2' }
        ]
      }
    });

    const fatalSpy = vi.fn();
    source.on('fatal', fatalSpy);
    source.on('error', () => {});

    try {
      expect((source as any).options.silenceCircuitBreakerThreshold).toBe(3);
      source.start();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const firstArgs = spawnMock.mock.calls[0][1];
      const firstDevice = firstArgs[firstArgs.indexOf('-i') + 1];
      expect(firstDevice).toBe('default');

      (source as any).scheduleRetry('stream-silence');
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const secondArgs = spawnMock.mock.calls[1][1];
      const secondDevice = secondArgs[secondArgs.indexOf('-i') + 1];
      expect(secondDevice).toBe('hw:1');

      (source as any).scheduleRetry('watchdog-timeout');
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(3);
      const thirdArgs = spawnMock.mock.calls[2][1];
      const thirdDevice = thirdArgs[thirdArgs.indexOf('-i') + 1];
      expect(thirdDevice).toBe('hw:2');

      (source as any).scheduleRetry('stream-silence');
      await Promise.resolve();

      expect(fatalSpy).toHaveBeenCalledTimes(1);
      expect(fatalSpy.mock.calls[0][0]).toMatchObject({ reason: 'circuit-breaker', attempts: 5 });
      expect((source as any).circuitBreakerFailures).toBe(3);
      expect((source as any).circuitBroken).toBe(true);

      await vi.advanceTimersByTimeAsync(10);
      expect(spawnMock).toHaveBeenCalledTimes(3);

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.audio.lastRestart?.reason).toBe('circuit-breaker');
      expect(snapshot.pipelines.audio.lastRestart?.attempt).toBe(5);
    } finally {
      source.stop();
      platformSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('AudioDeviceFallbackRotation rotates microphone inputs across platforms', async () => {
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

  it('AudioSourceDeviceFallback handles discovery timeouts across platforms', async () => {
    const { AudioSource } = await import('../src/audio/source.js');
    const scenarios: Array<{
      platform: NodeJS.Platform;
      format: 'alsa' | 'avfoundation' | 'dshow';
      device: string;
      fallbacks: string[];
    }> = [
      { platform: 'linux', format: 'alsa', device: 'default', fallbacks: ['hw:1', 'plughw:1'] },
      { platform: 'darwin', format: 'avfoundation', device: ':0', fallbacks: ['0:0', '1:0'] },
      {
        platform: 'win32',
        format: 'dshow',
        device: 'audio="default"',
        fallbacks: ['audio="Mic0"', 'audio="Mic1"']
      }
    ];

    let currentPlatform = scenarios[0].platform;
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockImplementation(
      () => currentPlatform
    );

    try {
      for (const scenario of scenarios) {
        currentPlatform = scenario.platform;
        metrics.reset();
        spawnMock.mockReset();
        execFileMock.mockReset();
        const processes: ReturnType<typeof createFakeProcess>[] = [];
        spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
          const proc = createFakeProcess();
          processes.push(proc);
          return proc;
        });

        const source = new AudioSource({
          type: 'mic',
          channel: `audio:${scenario.platform}`,
          sampleRate: 8000,
          channels: 1,
          frameDurationMs: 50,
          silenceDurationMs: 100,
          silenceThreshold: 0.0001,
          restartDelayMs: 10,
          restartMaxDelayMs: 10,
          restartJitterFactor: 0,
          forceKillTimeoutMs: 0,
          watchdogTimeoutMs: 0,
          silenceCircuitBreakerThreshold: 3,
          deviceDiscoveryTimeoutMs: 0,
          inputFormat: scenario.format,
          device: scenario.device,
          micFallbacks: {
            [scenario.platform]: scenario.fallbacks.map(device => ({
              format: scenario.format,
              device
            }))
          },
          random: () => 0.5
        });

        const recoverReasons: string[] = [];
        const fatalEvents: AudioFatalEvent[] = [];
        source.on('recover', event => recoverReasons.push(event.reason));
        source.on('fatal', event => fatalEvents.push(event));
        source.on('error', () => {});

        try {
          source.start();
          await Promise.resolve();
          expect(spawnMock).toHaveBeenCalledTimes(1);
          await waitForCondition(() => !(source as any).startSequencePromise);

          const attemptedDevices = () =>
          spawnMock.mock.calls.map(call => {
            const args = call[1] as string[];
            const index = args.indexOf('-i');
            return index >= 0 ? args[index + 1] : '';
          });
          expect(attemptedDevices()[0]).toBe(scenario.device);

          source.triggerDeviceDiscoveryTimeout(new Error('test discovery timeout'));
          await waitForCondition(() => recoverReasons.includes('device-discovery-timeout'));
          await waitForCondition(() => spawnMock.mock.calls.length === 2);
          const frameBytes = ((8000 * 50) / 1000) * 2;
          const silentFrame = Buffer.alloc(frameBytes);

          const secondProc = processes[1];
          secondProc.stdout.emit('data', silentFrame);
          secondProc.stdout.emit('data', silentFrame);

          await waitForCondition(() => spawnMock.mock.calls.length === 3);
          const thirdProc = processes[2];
          thirdProc.stdout.emit('data', silentFrame);
          thirdProc.stdout.emit('data', silentFrame);

          await waitForCondition(() => spawnMock.mock.calls.length === 4);
          const fourthProc = processes[3];
          fourthProc.stdout.emit('data', silentFrame);
          fourthProc.stdout.emit('data', silentFrame);

          await waitForCondition(() => fatalEvents.length === 1);
          expect(fatalEvents[0].lastFailure.reason).toBe('stream-silence');

          const devices = attemptedDevices();
          expect(devices.slice(0, 3)).toEqual([
            scenario.device,
            scenario.fallbacks[0],
            scenario.fallbacks[1]
          ]);

          const snapshot = metrics.snapshot();
          const channelStats =
            snapshot.pipelines.audio.byChannel[`audio:${scenario.platform}`];
          expect(channelStats.byReason['device-discovery-timeout']).toBeGreaterThanOrEqual(1);
          expect(channelStats.byReason['stream-silence']).toBeGreaterThanOrEqual(2);
          expect(channelStats.byReason['circuit-breaker']).toBe(1);
        } finally {
          source.stop();
        }
      }
    } finally {
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
    expect(devices).toEqual([
      { format: 'dshow', device: 'Microphone (USB)' },
      { format: 'dshow', device: 'Line In (High Definition)' }
    ]);

    execFileMock.mockClear();
    const cachedDevices = await AudioSource.listDevices('auto');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(cachedDevices).toEqual(devices);
  });

  it('AudioDeviceDiscoveryTimeout records timeouts and falls back to alternate probes', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const output = `
[dshow @ 000002] DirectShow audio devices
[dshow @ 000002]  "Microphone (USB)"
[dshow @ 000002]  "Line In (High Definition)"
`;

    const hangingChild = createExecFileChild();
    execFileMock.mockImplementation((command: string, args: string[], callback: ExecFileCallback) => {
      if (command === 'ffprobe') {
        // Simulate a hung ffprobe invocation that requires a timeout
        return hangingChild;
      }

      const child = createExecFileChild();
      setTimeout(() => callback(null, '', output), 10);
      return child;
    });

    const promise = AudioSource.listDevices('auto', { timeoutMs: 500, channel: 'audio:mic' });

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toEqual([
      { format: 'dshow', device: 'Microphone (USB)' },
      { format: 'dshow', device: 'Line In (High Definition)' }
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(hangingChild.kill).toHaveBeenCalled();

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.audio.deviceDiscovery['device-discovery-timeout']).toBe(1);
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

function createExecFileChild() {
  const child = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  (child as any).kill = vi.fn(() => true);
  return child;
}

async function flushTimers(step = 20) {
  await vi.advanceTimersByTimeAsync(step);
  await Promise.resolve();
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await flushTimers();
  }
}
