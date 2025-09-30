import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  ExecFileCallback,
  ExecFileException
} from 'node:child_process';
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
    await vi.runOnlyPendingTimersAsync();
    expect(spawnMock).toHaveBeenCalledTimes(4);

    source.stop();
  });

  it('AudioFfmpegInputValidation emits recoverable stream error when input missing', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const source = new AudioSource({
      type: 'ffmpeg',
      input: '   ',
      retryDelayMs: 250,
      restartJitterFactor: 0,
      random: () => 0
    });

    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    source.start();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reportedError = errorSpy.mock.calls[0]?.[0] as Error | undefined;
    expect(reportedError?.message).toContain('Audio ffmpeg input is required');
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    const event = recoverSpy.mock.calls[0]?.[0];
    expect(event.reason).toBe('stream-error');

    vi.advanceTimersByTime(250);
    expect(spawnMock).not.toHaveBeenCalled();

    source.stop();
  });

  it('AudioCircuitBreakerFfmpegMissing halts retries after repeated missing binaries', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    spawnMock.mockImplementation(() => {
      const error = new Error('ffmpeg missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      channel: 'audio:missing-ffmpeg',
      restartDelayMs: 20,
      restartMaxDelayMs: 20,
      restartJitterFactor: 0,
      silenceCircuitBreakerThreshold: 3,
      random: () => 0
    });

    const fatalSpy = vi.fn();
    const recoverReasons: string[] = [];
    source.on('fatal', fatalSpy);
    source.on('recover', event => recoverReasons.push(event.reason));
    source.on('error', () => {});

    try {
      source.start();
      expect(spawnMock).toHaveBeenCalled();

      await flushTimers(20);
      await flushTimers(20);

      expect(fatalSpy).toHaveBeenCalledTimes(1);
      const fatalEvent = fatalSpy.mock.calls[0][0] as AudioFatalEvent;
      expect(fatalEvent.reason).toBe('circuit-breaker');
      expect(fatalEvent.lastFailure.reason).toBe('ffmpeg-missing');
      expect(fatalEvent.channel).toBe('audio:missing-ffmpeg');
      expect(fatalEvent.attempts).toBe(3);
      expect(recoverReasons.filter(reason => reason === 'ffmpeg-missing')).toHaveLength(2);
      expect(source.isCircuitBroken()).toBe(true);

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.audio.byReason['ffmpeg-missing']).toBeGreaterThanOrEqual(3);
      expect(snapshot.pipelines.audio.byReason['circuit-breaker']).toBe(1);
      const channelStats = snapshot.pipelines.audio.byChannel['audio:missing-ffmpeg'];
      expect(channelStats).toBeDefined();
      expect(channelStats.byReason['ffmpeg-missing']).toBeGreaterThanOrEqual(3);
      expect(channelStats.byReason['circuit-breaker']).toBe(1);
      expect(snapshot.pipelines.audio.lastRestart?.reason).toBe('circuit-breaker');
      expect(snapshot.pipelines.audio.lastRestart?.attempt).toBe(3);
    } finally {
      source.stop();
    }
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
    const expectedWindows = Math.ceil(
      (framesEmitted * frameSizeSamples) / hopSizeSamples
    );
    expect(meydaExtractMock).toHaveBeenCalledTimes(expectedWindows);
    expect(meydaExtractMock.mock.calls[0]?.[1]).toBeInstanceOf(Float32Array);
    source.stop();
  });

  it('AudioAnalysisMetrics reports RMS and spectral centroid gauges', async () => {
    const { AudioSource } = await import('../src/audio/source.js');
    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      sampleRate: 16000,
      channels: 1,
      frameDurationMs: 50
    });

    const samples = new Int16Array([0, 1000, -500, 200, -300, 50, -75, 0]);
    (source as any).analyzeFrame(samples, 16000, 1, 50, 0.05);

    const analysis = source.getAnalysisSnapshot();
    expect(analysis.ffmpeg).toBeDefined();
    expect(analysis.ffmpeg.frames).toBe(1);

    const snapshot = metrics.snapshot();
    const gauges = snapshot.detectors['audio-anomaly'].gauges;
    expect(gauges['analysis.ffmpeg.rms']).toBeCloseTo(analysis.ffmpeg.rms, 6);
    expect(gauges['analysis.ffmpeg.spectral-centroid']).toBeCloseTo(
      analysis.ffmpeg.spectralCentroid,
      6
    );
    expect(gauges['analysis.ffmpeg.windows']).toBe(analysis.ffmpeg.frames);
    expect(gauges['analysis.ffmpeg.rms-window-ms']).toBeCloseTo(50, 6);
    expect(gauges['analysis.ffmpeg.rms-window-frames']).toBe(1);

    source.stop();
  });

  it('AudioAnalysisWithoutMeyda falls back to internal calculations', async () => {
    const { AudioSource } = await import('../src/audio/source.js');
    const meydaModule = await import('meyda');
    const originalExtract = meydaModule.default.extract;

    try {
      (meydaModule.default as Record<string, unknown>).extract = undefined;

      const source = new AudioSource({
        type: 'ffmpeg',
        input: 'pipe:0',
        sampleRate: 8000,
        channels: 1,
        frameDurationMs: 40
      });

      const samples = new Int16Array([0, 5000, -2500, 1250, -625, 312, -150, 75, -30, 15]);
      (source as any).analyzeFrame(samples, 8000, 1, 40, 0.03);

      const analysis = source.getAnalysisSnapshot();
      expect(analysis.ffmpeg).toBeDefined();
      expect(analysis.ffmpeg.frames).toBe(1);
      expect(Number.isFinite(analysis.ffmpeg.rms)).toBe(true);
      expect(Number.isFinite(analysis.ffmpeg.spectralCentroid)).toBe(true);

      const snapshot = metrics.snapshot();
      const detector = snapshot.detectors['audio-anomaly'];
      const ffmpegAnalysis = detector.analysis.ffmpeg;
      expect(ffmpegAnalysis).toBeDefined();
      expect(ffmpegAnalysis.rms).toBeCloseTo(analysis.ffmpeg.rms, 6);
      expect(ffmpegAnalysis.spectralCentroid).toBeCloseTo(
        analysis.ffmpeg.spectralCentroid,
        6
      );
      expect(ffmpegAnalysis.windows).toBe(analysis.ffmpeg.frames);
      expect(ffmpegAnalysis.rmsWindowMs).toBeCloseTo(analysis.ffmpeg.rmsWindowMs, 6);
      expect(ffmpegAnalysis.rmsWindowFrames).toBe(analysis.ffmpeg.rmsWindowFrames);

      expect(meydaExtractMock).not.toHaveBeenCalled();

      source.stop();
    } finally {
      (meydaModule.default as Record<string, unknown>).extract = originalExtract;
    }
  });

  it('AudioCircuitResetManualMetric records manual circuit resets in metrics', async () => {
    vi.useRealTimers();
    metrics.reset();

    const { AudioSource } = await import('../src/audio/source.js');
    const startSpy = vi.spyOn(AudioSource.prototype, 'start').mockImplementation(function () {
      (this as unknown as { circuitBroken?: boolean }).circuitBroken = true;
    });
    const stopSpy = vi.spyOn(AudioSource.prototype, 'stop').mockImplementation(() => {});
    const resetSpy = vi
      .spyOn(AudioSource.prototype, 'resetCircuitBreaker')
      .mockImplementation(function (this: unknown) {
        const context = this as { circuitBroken?: boolean };
        const wasBroken = Boolean(context.circuitBroken);
        context.circuitBroken = false;
        return wasBroken;
      });
    const isBrokenSpy = vi
      .spyOn(AudioSource.prototype, 'isCircuitBroken')
      .mockImplementation(function (this: unknown) {
        return Boolean((this as { circuitBroken?: boolean }).circuitBroken);
      });

    vi.doMock('../src/video/source.js', () => {
      class MockVideoSource extends EventEmitter {
        start() {}
        stop() {}
        updateOptions() {}
        resetCircuitBreaker() {
          return false;
        }
        isCircuitBroken() {
          return false;
        }
      }

      return { VideoSource: MockVideoSource };
    });

    vi.doMock('../src/video/motionDetector.js', () => ({
      default: vi.fn().mockImplementation(() => ({
        handleFrame: vi.fn(),
        updateOptions: vi.fn()
      }))
    }));

    vi.doMock('../src/video/personDetector.js', () => ({
      default: {
        create: vi.fn().mockResolvedValue({
          handleFrame: vi.fn(),
          updateOptions: vi.fn()
        })
      },
      normalizeClassScoreThresholds: vi.fn(() => ({}))
    }));

    vi.doMock('../src/video/sampleVideo.js', () => ({
      ensureSampleVideo: vi.fn((input: string) => input)
    }));

    vi.doMock('../src/tasks/retention.js', () => ({
      startRetentionTask: vi.fn(() => ({
        configure: vi.fn(),
        stop: vi.fn()
      }))
    }));

    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    const { startGuard } = await import('../src/run-guard.js');

    const runtime = await startGuard({
      logger: { info, warn, error },
      config: {
        video: {
          framesPerSecond: 1,
          cameras: [
            {
              id: 'camera-1',
              channel: 'video:camera-1',
              input: 'test-source'
            }
          ]
        },
        person: {
          modelPath: 'noop',
          score: 0.5
        },
        motion: {
          diffThreshold: 1,
          areaThreshold: 0.01
        },
        audio: {
          channel: 'audio:test-reset'
        }
      }
    });

    metrics.reset();

    const triggered = runtime.resetCircuitBreaker('audio:test-reset');
    expect(triggered).toBe(true);

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.audio.byReason['manual-circuit-reset']).toBe(1);
    const channelStats = snapshot.pipelines.audio.byChannel['audio:test-reset'];
    expect(channelStats?.byReason['manual-circuit-reset']).toBe(1);

    await runtime.stop();

    startSpy.mockRestore();
    stopSpy.mockRestore();
    resetSpy.mockRestore();
    isBrokenSpy.mockRestore();

    vi.resetModules();
    vi.doUnmock('../src/video/source.js');
    vi.doUnmock('../src/video/motionDetector.js');
    vi.doUnmock('../src/video/personDetector.js');
    vi.doUnmock('../src/video/sampleVideo.js');
    vi.doUnmock('../src/tasks/retention.js');
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

  it('AudioPulseFallbackChain prefers pulse and pipewire while recalibrating RMS windows', async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    const outputs: Record<string, string> = {
      pulse: `"default"\n"monitor"`,
      pipewire: `"default"`,
      alsa: `[0] hw:1,0`
    };

    execFileMock.mockImplementation((_cmd: string, args: string[], callback: ExecFileCallback) => {
      const child = createExecFileChild();
      const formatIndex = args.indexOf('-f');
      const format = formatIndex >= 0 ? args[formatIndex + 1] : 'alsa';
      const output = outputs[format] ?? '';
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
      if (seen.has(key) === false) {
        seen.add(key);
        encountered.push({ format, device });
      }
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:pulse',
      sampleRate: 16000,
      channels: 1,
      frameDurationMs: 40,
      restartDelayMs: 25,
      restartMaxDelayMs: 25,
      restartJitterFactor: 0,
      analysisRmsWindowMs: 120,
      random: () => 0.5
    });

    const recoverSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', () => {});
    source.start();

    await waitForCondition(() => recoverSpy.mock.calls.length > 0, 1000);

    expect(encountered).toEqual([
      { format: 'pulse', device: 'default' },
      { format: 'pulse', device: 'monitor' },
      { format: 'pipewire', device: 'default' },
      { format: 'alsa', device: 'default' },
      { format: 'alsa', device: 'hw:0' },
      { format: 'alsa', device: 'plughw:0' }
    ]);

    const discoverySnapshot = metrics.snapshot();
    expect(discoverySnapshot.pipelines.audio.deviceDiscovery.byFormat.pulse).toBe(2);

    source.stop();
    await vi.runOnlyPendingTimersAsync();

    const smoothingSource = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      frameDurationMs: 40,
      sampleRate: 16000,
      channels: 1,
      analysisRmsWindowMs: 120
    });

    const makeSamples = (rate: number, durationMs: number) =>
      new Int16Array(Math.round((rate * durationMs) / 1000)).fill(500);

    for (let i = 0; i < 3; i += 1) {
      (smoothingSource as any).analyzeFrame(makeSamples(16000, 40), 16000, 1, 40, 0.02);
    }

    let snapshot = metrics.snapshot();
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-ms']).toBeCloseTo(120, 6);
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-frames']).toBe(3);

    for (let i = 0; i < 6; i += 1) {
      (smoothingSource as any).analyzeFrame(makeSamples(48000, 20), 48000, 1, 20, 0.02);
    }

    snapshot = metrics.snapshot();
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-ms']).toBeCloseTo(120, 6);
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-frames']).toBe(6);

    smoothingSource.stop();
    platformSpy.mockRestore();
  });

  it('AudioAnalysisWindowReconfigures updates device discovery timeouts and RMS metrics', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      frameDurationMs: 40,
      sampleRate: 16000,
      channels: 1,
      analysisRmsWindowMs: 120
    });

    const makeSamples = (rate: number, durationMs: number) =>
      new Int16Array(Math.round((rate * durationMs) / 1000)).fill(600);

    for (let i = 0; i < 3; i += 1) {
      (source as any).analyzeFrame(makeSamples(16000, 40), 16000, 1, 40, 0.02);
    }

    let snapshot = metrics.snapshot();
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-ms']).toBeCloseTo(120, 6);
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-frames']).toBe(3);

    source.updateOptions({ analysisRmsWindowMs: 360, deviceDiscoveryTimeoutMs: 450 });
    expect((source as any).options.analysisRmsWindowMs).toBe(360);
    expect((source as any).options.deviceDiscoveryTimeoutMs).toBe(450);

    for (let i = 0; i < 6; i += 1) {
      (source as any).analyzeFrame(makeSamples(16000, 40), 16000, 1, 40, 0.02);
    }

    snapshot = metrics.snapshot();
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-ms']).toBeCloseTo(360, 6);
    expect(snapshot.detectors['audio-anomaly'].gauges['analysis.ffmpeg.rms-window-frames']).toBe(9);

    source.stop();
  });

  it('AudioAnalysisWindowAdaptsToConfig updates analysis snapshots after reconfiguration', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      frameDurationMs: 50,
      sampleRate: 16000,
      channels: 1,
      analysisRmsWindowMs: 100
    });

    const makeSamples = () =>
      new Int16Array(Math.round((16000 * 50) / 1000)).fill(7500);

    for (let i = 0; i < 4; i += 1) {
      (source as any).analyzeFrame(makeSamples(), 16000, 1, 50, 0.05);
    }

    let snapshot = source.getAnalysisSnapshot();
    expect(snapshot.ffmpeg?.rmsWindowFrames).toBe(2);
    expect(snapshot.ffmpeg?.rmsWindowMs).toBeCloseTo(100, 6);

    source.updateOptions({ analysisRmsWindowMs: 450 });

    snapshot = source.getAnalysisSnapshot();
    expect(snapshot.ffmpeg?.rmsWindowFrames).toBe(9);
    expect(snapshot.ffmpeg?.rmsWindowMs).toBeCloseTo(100, 6);

    for (let i = 0; i < 10; i += 1) {
      (source as any).analyzeFrame(makeSamples(), 16000, 1, 50, 0.05);
    }

    snapshot = source.getAnalysisSnapshot();
    expect(snapshot.ffmpeg?.rmsWindowFrames).toBe(9);
    expect(snapshot.ffmpeg?.rmsWindowMs).toBeCloseTo(450, 6);

    const detectorSnapshot = metrics.snapshot().detectors['audio-anomaly'];
    expect(detectorSnapshot.gauges['analysis.ffmpeg.rms-window-frames']).toBe(9);
    expect(detectorSnapshot.gauges['analysis.ffmpeg.rms-window-ms']).toBeCloseTo(450, 6);

    source.stop();
  });

  it('AudioSourceDeviceDiscoveryTimeout recovers and records metrics', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const clearSpy = vi.spyOn(AudioSource, 'clearDeviceCache');
    execFileMock.mockImplementation((_cmd: string, _args: string[], callback: ExecFileCallback) => {
      const child = createExecFileChild();
      const error = new Error('timed out') as ExecFileException;
      (error as NodeJS.ErrnoException).code = 'ETIME';
      callback(error, '', '');
      return child;
    });

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:discovery-timeout',
      sampleRate: 16000,
      channels: 1,
      frameDurationMs: 50,
      restartDelayMs: 120,
      restartMaxDelayMs: 120,
      restartJitterFactor: 0,
      deviceDiscoveryTimeoutMs: 200,
      random: () => 0.5
    });

    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    source.start();

    await waitForCondition(() => recoverSpy.mock.calls.length > 0, 1000);
    const event = recoverSpy.mock.calls[0]?.[0];
    expect(event?.reason).toBe('device-discovery-timeout');
    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(clearSpy).toHaveBeenCalled();

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.audio.byReason['device-discovery-timeout']).toBeGreaterThanOrEqual(1);

    const sampleFrame = new Int16Array([0, 1200, -600, 400, -200, 50, -75, 25]);
    (source as any).analyzeFrame(sampleFrame, 16000, 1, 50, 0.05);
    (source as any).analyzeFrame(sampleFrame, 16000, 1, 50, 0.05);

    const analysis = source.getAnalysisSnapshot();
    expect(analysis.alsa).toBeDefined();
    expect(analysis.alsa.frames).toBe(2);

    const analysisSnapshot = metrics.snapshot();
    const detectorSnapshot = analysisSnapshot.detectors['audio-anomaly'];
    expect(detectorSnapshot).toBeDefined();
    expect(detectorSnapshot.gauges['analysis.alsa.windows']).toBe(2);
    expect(detectorSnapshot.gauges['analysis.alsa.rms-window-ms']).toBeCloseTo(100, 6);
    expect(detectorSnapshot.gauges['analysis.alsa.rms-window-frames']).toBe(2);

    source.stop();
    clearSpy.mockRestore();
  });

  it('AudioDeviceDiscoveryTimeoutResetsFallbacks rotates candidates and clears cache', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const timeoutError = new Error('device discovery timed out') as NodeJS.ErrnoException;
    timeoutError.code = 'ETIME';

    const listSpy = vi
      .spyOn(AudioSource, 'listDevices')
      .mockRejectedValue(timeoutError);
    const clearSpy = vi.spyOn(AudioSource, 'clearDeviceCache');

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:rotate-discovery',
      sampleRate: 16000,
      channels: 1,
      frameDurationMs: 40,
      restartDelayMs: 60,
      restartMaxDelayMs: 60,
      restartJitterFactor: 0,
      deviceDiscoveryTimeoutMs: 200,
      micFallbacks: {
        default: [
          { format: 'alsa', device: 'hw:1' },
          { format: 'alsa', device: 'hw:2' }
        ]
      },
      random: () => 0
    });

    const recoverSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('recover', recoverSpy);
    source.on('error', errorSpy);

    source.start();

    await waitForCondition(() => recoverSpy.mock.calls.length > 0, 1000);

    expect(recoverSpy.mock.calls[0]?.[0]?.reason).toBe('device-discovery-timeout');
    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith('auto');

    expect((source as any).micCandidateIndex).toBe(1);
    expect((source as any).currentBinaryIndex).toBe(1);

    const snapshot = metrics.snapshot();
    expect(
      snapshot.pipelines.audio.deviceDiscovery.byReason['device-discovery-timeout']
    ).toBeGreaterThanOrEqual(1);
    expect(
      snapshot.pipelines.audio.deviceDiscoveryByChannel['audio:rotate-discovery']['device-discovery-timeout']
    ).toBeGreaterThanOrEqual(1);

    source.stop();
    await vi.runOnlyPendingTimersAsync();

    clearSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('AudioDeviceCircuitBreakerReset rotates ffmpeg candidates after silence', async () => {
    vi.useFakeTimers();
    const { AudioSource } = await import('../src/audio/source.js');

    let activeProcess: (ChildProcessWithoutNullStreams & EventEmitter) | null = null;
    const createProcess = () => {
      const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(proc, {
        stdout,
        stderr,
        stdin: new PassThrough(),
        kill: vi.fn(() => true)
      });
      return proc;
    };

    spawnMock.mockImplementation(() => {
      activeProcess = createProcess();
      return activeProcess as ChildProcessWithoutNullStreams;
    });

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      channel: 'audio:test',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 50,
      silenceDurationMs: 50,
      silenceCircuitBreakerThreshold: 1,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      random: () => 0.5
    });

    const fatalSpy = vi.fn();
    source.on('fatal', fatalSpy);
    source.on('error', () => {});
    source.on('recover', () => {});

    source.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(activeProcess).not.toBeNull();

    const frameBytes = (8000 * 50) / 1000 * 2;
    activeProcess!.stdout.emit('data', Buffer.alloc(frameBytes));

    await Promise.resolve();
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(source.isCircuitBroken()).toBe(true);

    const snapshotAfterSilence = metrics.snapshot();
    const audioChannel = snapshotAfterSilence.pipelines.audio.byChannel['audio:test'];
    expect(audioChannel.byReason['stream-silence']).toBe(1);

    const resetResult = source.resetCircuitBreaker();
    expect(resetResult).toBe(true);
    expect(source.isCircuitBroken()).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    source.stop();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('AudioSilenceCircuitBreakerDisabled retries without fatal events when threshold is zero', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    let activeProcess: (ChildProcessWithoutNullStreams & EventEmitter) | null = null;
    const createProcess = () => {
      const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(proc, {
        stdout,
        stderr,
        stdin: new PassThrough(),
        kill: vi.fn(() => true)
      });
      return proc;
    };

    spawnMock.mockImplementation(() => {
      activeProcess = createProcess();
      return activeProcess as ChildProcessWithoutNullStreams;
    });

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'pipe:0',
      channel: 'audio:test',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 50,
      silenceDurationMs: 50,
      silenceCircuitBreakerThreshold: 0,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      random: () => 0.5
    });

    const fatalSpy = vi.fn();
    const recoverSpy = vi.fn();
    source.on('fatal', fatalSpy);
    source.on('recover', recoverSpy);
    source.on('error', () => {});

    source.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(activeProcess).not.toBeNull();

    const frameBytes = (8000 * 50) / 1000 * 2;
    activeProcess!.stdout.emit('data', Buffer.alloc(frameBytes));

    await waitForCondition(() => recoverSpy.mock.calls.length > 0, 1000);
    expect(fatalSpy).not.toHaveBeenCalled();
    expect(recoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stream-silence' })
    );

    source.stop();
    await vi.runOnlyPendingTimersAsync();
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

  it('AudioMicFallbackRetryCycle rotates fallbacks and records jitter metrics', async () => {
    vi.useFakeTimers();
    metrics.reset();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: ExecFileCallback) => {
      const child = createExecFileChild();
      const error = new Error('ffprobe missing') as ExecFileException;
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      cb(error, '', '');
      return child;
    });

    const jitterValues = [0.9, 0.2, 0.6];
    let jitterIndex = 0;
    const random = () => {
      const value = jitterValues[jitterIndex % jitterValues.length];
      jitterIndex += 1;
      return value;
    };

    const devices: string[] = [];
    let activeProcess: ReturnType<typeof createFakeProcess> | null = null;
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const deviceIndex = args.indexOf('-i');
      devices.push(deviceIndex >= 0 ? args[deviceIndex + 1] : 'unknown');
      if (devices.length < 3) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      activeProcess = createFakeProcess();
      const frameBytes = Math.round((16000 * 50) / 1000) * 2;
      setTimeout(() => {
        activeProcess?.stdout.emit('data', Buffer.alloc(frameBytes));
      }, 0);
      return activeProcess as unknown as ChildProcessWithoutNullStreams;
    });

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:mic',
      device: 'default',
      sampleRate: 16000,
      frameDurationMs: 50,
      restartDelayMs: 40,
      restartMaxDelayMs: 120,
      restartJitterFactor: 0.5,
      silenceDurationMs: 200,
      random
    });

    source.on('error', () => {});
    source.start();

    await flushTimers();
    await vi.runOnlyPendingTimersAsync();
    await flushTimers();

    vi.advanceTimersByTime(80);
    await vi.runOnlyPendingTimersAsync();
    await flushTimers();

    vi.advanceTimersByTime(80);
    await vi.runOnlyPendingTimersAsync();
    await flushTimers();

    expect(devices[0]).toBe('default');
    expect(new Set(devices.slice(0, 3))).toEqual(new Set(['default', 'hw:0']));
    expect(activeProcess).not.toBeNull();

    await flushTimers();

    expect((source as any).idleTimer).not.toBeNull();
    expect((source as any).watchdogTimer).not.toBeNull();

    const snapshot = metrics.snapshot();
    const channelSnapshot = snapshot.pipelines.audio.byChannel['audio:mic'];
    expect(channelSnapshot).toBeDefined();
    expect(Object.keys(channelSnapshot.jitterHistogram)).not.toHaveLength(0);

    source.stop();
    await vi.runOnlyPendingTimersAsync();
    platformSpy.mockRestore();
  });

  it('AudioSourceMicFallbackIndexReset resets candidate order and analysis after discovery timeout', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const discoverySequence = [true, false, true];
    const listDevicesSpy = vi
      .spyOn(AudioSource, 'listDevices')
      .mockImplementation(async () => {
        const next = discoverySequence.shift();
        if (next === false) {
          const error = new Error('timeout') as ExecFileException & {
            code?: string;
            timedOut?: boolean;
          };
          error.code = 'ETIME';
          error.timedOut = true;
          throw error;
        }
        return [
          { format: 'pulse', device: 'hw:primary' },
          { format: 'pulse', device: 'hw:fallback' }
        ];
      });

    const processes: ReturnType<typeof createFakeProcess>[] = [];
    spawnMock.mockImplementation((_cmd: string) => {
      const proc = createFakeProcess();
      (proc as any).stdin = new PassThrough();
      processes.push(proc);
      return proc as unknown as ChildProcessWithoutNullStreams;
    });

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:mic',
      device: 'hw:primary',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 50,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      analysisRmsWindowMs: 100,
      random: () => 0.5
    });

    const recoverReasons: string[] = [];
    source.on('recover', event => recoverReasons.push(event.reason));
    source.on('error', () => {});

    try {
      source.start();
      await waitForCondition(() => spawnMock.mock.calls.length >= 1, 200);

      const firstProc = processes[0];
      const frameBytes = (8000 * 50) / 1000 * 2;
      firstProc.stdout.emit('data', Buffer.alloc(frameBytes, 4));
      await Promise.resolve();

      const snapshotBefore = source.getAnalysisSnapshot();
      expect(Object.keys(snapshotBefore)).not.toHaveLength(0);

      firstProc.emit('close', 1);
      await Promise.resolve();

      expect((source as any).micCandidateIndex).toBe(1);

      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(recoverReasons).toContain('device-discovery-timeout');
      expect((source as any).micCandidateIndex).toBe(0);

      expect(source.getAnalysisSnapshot()).toEqual({});

      await vi.advanceTimersByTimeAsync(10);
      await waitForCondition(() => spawnMock.mock.calls.length >= 2, 200);

      const secondArgs = spawnMock.mock.calls[1][1] as string[];
      expect(secondArgs).toContain('hw:primary');

      const secondProc = processes[1];
      secondProc.stdout.emit('data', Buffer.alloc(frameBytes, 6));
      await Promise.resolve();

      const snapshotAfter = source.getAnalysisSnapshot();
      const formats = Object.keys(snapshotAfter);
      expect(formats).toHaveLength(1);
      expect(snapshotAfter[formats[0]].frames).toBe(1);
    } finally {
      source.stop();
      await vi.runOnlyPendingTimersAsync();
      listDevicesSpy.mockRestore();
    }
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

  it('AudioCircuitBreakerReuseLastMic retries using last successful mic before advancing', async () => {
    vi.useFakeTimers();
    metrics.reset();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    const attemptedDevices: string[] = [];
    const processes: ReturnType<typeof createFakeProcess>[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const deviceIndex = args.indexOf('-i');
      attemptedDevices.push(deviceIndex >= 0 ? args[deviceIndex + 1] : 'unknown');
      const proc = createFakeProcess();
      processes.push(proc);
      return proc as unknown as ChildProcessWithoutNullStreams;
    });

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:circuit',
      sampleRate: 8000,
      frameDurationMs: 20,
      silenceCircuitBreakerThreshold: 2,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      deviceDiscoveryTimeoutMs: 0,
      micFallbacks: {
        linux: [{ format: 'alsa', device: 'hw:1' }]
      },
      random: () => 0.5
    });

    source.on('error', () => {});
    source.start();

    await flushTimers();
    await Promise.resolve();

    const frameBytes = Math.round((8000 * 20) / 1000) * 2;
    expect(processes.length).toBeGreaterThanOrEqual(1);
    const firstProc = processes[0];
    expect(firstProc).toBeDefined();

    const noisyFrame = Buffer.alloc(frameBytes);
    for (let offset = 0; offset < frameBytes; offset += 2) {
      noisyFrame.writeInt16LE(2000, offset);
    }
    firstProc.stdout.emit('data', noisyFrame);

    await Promise.resolve();

    source.stop();
    await vi.runOnlyPendingTimersAsync();

    (source as any).micCandidateIndex = 1;
    (source as any).activeMicCandidateIndex = 1;
    (source as any).circuitBroken = true;
    (source as any).shouldStop = true;
    (source as any).circuitBreakerFailures = 2;
    (source as any).lastCircuitCandidateReason = 'stream-silence';

    const wasBroken = source.resetCircuitBreaker({ restart: false });
    expect(wasBroken).toBe(true);
    expect(source.isCircuitBroken()).toBe(false);
    expect((source as any).micCandidateIndex).toBe((source as any).lastSuccessfulMicIndex);

    (source as any).startPipeline();
    await Promise.resolve();
    await flushTimers();
    expect(processes.length).toBeGreaterThanOrEqual(2);
    expect(attemptedDevices[1]).toContain('default');

    source.stop();
    await vi.runOnlyPendingTimersAsync();

    (source as any).shouldStop = false;
    (source as any).circuitBroken = false;
    (source as any).micCandidateIndex = 1;
    (source as any).activeMicCandidateIndex = null;

    (source as any).startPipeline();
    await Promise.resolve();
    await flushTimers();
    expect(processes.length).toBeGreaterThanOrEqual(3);
    expect(attemptedDevices[2]).toContain('hw:1');

    source.stop();
    await vi.runOnlyPendingTimersAsync();
    platformSpy.mockRestore();
    vi.useRealTimers();
  });

  it('AudioCircuitResetNoRestartStopsRestart', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const source = new AudioSource({
      type: 'ffmpeg',
      input: 'noop',
      channel: 'audio:reset-no-restart'
    });

    const startPipelineSpy = vi.spyOn(source as any, 'startPipeline');

    (source as any).circuitBroken = true;
    (source as any).shouldStop = true;
    (source as any).restartTimer = setTimeout(() => {}, 5000);

    const result = source.resetCircuitBreaker({ restart: false });

    expect(result).toBe(true);
    expect(startPipelineSpy).not.toHaveBeenCalled();
    expect((source as any).restartTimer).toBeNull();
    expect((source as any).shouldStop).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    startPipelineSpy.mockRestore();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('AudioDeviceDiscoveryCircuitBreaker emits fatal event after repeated timeouts', async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    spawnMock.mockImplementation(() => createFakeProcess());

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:lobby',
      restartDelayMs: 20,
      restartMaxDelayMs: 20,
      restartJitterFactor: 0,
      silenceCircuitBreakerThreshold: 2,
      deviceDiscoveryTimeoutMs: 0,
      micFallbacks: {
        linux: [{ format: 'alsa', device: 'default' }]
      }
    });

    const fatalSpy = vi.fn();
    const errorSpy = vi.fn();
    source.on('fatal', fatalSpy);
    source.on('error', errorSpy);

    try {
      source.start();
      await flushTimers();

      expect(spawnMock).toHaveBeenCalledTimes(1);

      source.triggerDeviceDiscoveryTimeout(new Error('device discovery timed out (1)'));
      expect(errorSpy).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();

      source.triggerDeviceDiscoveryTimeout(new Error('device discovery timed out (2)'));
      await Promise.resolve();

      expect(fatalSpy).toHaveBeenCalledTimes(1);
      const fatalEvent = fatalSpy.mock.calls[0][0] as AudioFatalEvent;
      expect(fatalEvent.reason).toBe('circuit-breaker');
      expect(fatalEvent.lastFailure.reason).toBe('device-discovery-timeout');
      expect(fatalEvent.channel).toBe('audio:lobby');

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.audio.byReason['device-discovery-timeout']).toBeGreaterThanOrEqual(2);
      expect(snapshot.pipelines.audio.lastRestart?.reason).toBe('circuit-breaker');
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
      deviceDiscoveryTimeoutMs: 0,
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
      await flushTimers();
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

  it('AudioSourceDeviceFallback rotates binaries, caches discovery, and records analysis windows', async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { AudioSource } = await import('../src/audio/source.js');

    AudioSource.clearDeviceCache();

    const deviceOutput = `
      [alsa] "default"
      [alsa] "hw:0"
      [dshow] "Microphone"
    `;

    execFileMock.mockImplementation((_command: string, _args: string[], callback: ExecFileCallback) => {
      const child = createExecFileChild();
      callback(null, deviceOutput, '');
      return child;
    });

    const firstDevices = await AudioSource.listDevices('auto', { timeoutMs: 0 });
    expect(firstDevices.length).toBeGreaterThan(0);
    execFileMock.mockClear();
    const cachedDevices = await AudioSource.listDevices('auto', { timeoutMs: 0 });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(cachedDevices).toHaveLength(firstDevices.length);

    const processes: ReturnType<typeof createFakeProcess>[] = [];
    let spawnAttempts = 0;
    spawnMock.mockImplementation((command: string, args: string[]) => {
      spawnAttempts += 1;
      if (spawnAttempts === 1) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const proc = createFakeProcess();
      processes.push(proc);
      return proc;
    });

    const source = new AudioSource({
      type: 'mic',
      channel: 'audio:fallback',
      sampleRate: 8000,
      channels: 1,
      frameDurationMs: 40,
      silenceDurationMs: 80,
      silenceThreshold: 0.0001,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      deviceDiscoveryTimeoutMs: 0,
      micFallbacks: { linux: [{ format: 'alsa', device: 'hw:1' }] }
    });

    const recoverReasons: string[] = [];
    source.on('recover', event => recoverReasons.push(event.reason));
    source.on('error', () => {});

    try {
      source.start();

      await Promise.resolve();
      await Promise.resolve();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock.mock.calls[0]?.[0]).toBe('ffmpeg');
      expect(spawnMock.mock.calls[1]?.[0]).toBe('avconv');

      const proc = processes[0];
      const frameBytes = ((8000 * 40) / 1000) * 2;
      const silenceFrames = Math.ceil(80 / 40);
      for (let i = 0; i < silenceFrames; i += 1) {
        proc.stdout.emit('data', Buffer.alloc(frameBytes));
        await Promise.resolve();
      }

      expect(recoverReasons).toContain('stream-silence');

      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      expect(spawnMock).toHaveBeenCalledTimes(3);
      const restartCommand = spawnMock.mock.calls[2]?.[0];
      expect(restartCommand).toBe('ffmpeg');
      const restartArgs = spawnMock.mock.calls[2]?.[1] ?? [];
      const deviceIndex = restartArgs.indexOf('-i');
      expect(deviceIndex).toBeGreaterThan(-1);
      expect(restartArgs[deviceIndex + 1]).toBe('hw:1');

      const analysis = source.getAnalysisSnapshot();
      expect(analysis.alsa?.frames ?? 0).toBeGreaterThan(0);
      expect(typeof analysis.alsa?.rms).toBe('number');
      expect(typeof analysis.alsa?.spectralCentroid).toBe('number');
    } finally {
      source.stop();
      platformSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('AudioSourceFallback parses device list output with fallback chain', async () => {
    const { AudioSource } = await import('../src/audio/source.js');

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

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

    AudioSource.clearDeviceCache();

    try {
      const devices = await AudioSource.listDevices('auto');

      expect(execFileMock).toHaveBeenCalled();
      expect(devices).toEqual([
        { format: 'dshow', device: 'Line In (High Definition)' },
        { format: 'dshow', device: 'Microphone (USB)' }
      ]);

      execFileMock.mockClear();
      const cachedDevices = await AudioSource.listDevices('auto');
      expect(execFileMock).not.toHaveBeenCalled();
      expect(cachedDevices).toEqual(devices);
    } finally {
      platformSpy.mockRestore();
    }
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
    expect(
      snapshot.pipelines.audio.deviceDiscovery.byReason['device-discovery-timeout']
    ).toBe(1);
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
