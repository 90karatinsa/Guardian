import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager, GuardianConfig } from '../src/config/index.js';

let metrics: typeof import('../src/metrics/index.js').default;

class MockVideoSource extends EventEmitter {
  static instances: MockVideoSource[] = [];
  static startCounts: number[] = [];
  constructor(
    public readonly options: {
      file: string;
      framesPerSecond: number;
      channel?: string;
      rtspTransport?: string;
      inputArgs?: string[];
      idleTimeoutMs?: number;
      startTimeoutMs?: number;
      watchdogTimeoutMs?: number;
      forceKillTimeoutMs?: number;
      restartDelayMs?: number;
      restartMaxDelayMs?: number;
      restartJitterFactor?: number;
    }
  ) {
    super();
    MockVideoSource.instances.push(this);
    MockVideoSource.startCounts.push(0);
  }
  public circuitBroken = false;
  start() {
    const index = MockVideoSource.instances.indexOf(this);
    if (index >= 0) {
      MockVideoSource.startCounts[index] = (MockVideoSource.startCounts[index] ?? 0) + 1;
    }
  }
  stop() {
    this.emit('stopped');
    this.circuitBroken = false;
  }
  resetCircuitBreaker = vi.fn(() => {
    const wasBroken = this.circuitBroken;
    this.circuitBroken = false;
    if (wasBroken) {
      this.start();
    }
    return wasBroken;
  });
  isCircuitBroken = vi.fn(() => this.circuitBroken);
}

class MockPersonDetector {
  static instances: MockPersonDetector[] = [];
  static calls: string[] = [];
  constructor(public readonly options: Record<string, unknown>) {
    MockPersonDetector.instances.push(this);
  }
  static async create(options: Record<string, unknown>) {
    return new MockPersonDetector(options);
  }
  async handleFrame() {
    MockPersonDetector.calls.push(this.options.source as string);
  }
}

class MockMotionDetector {
  static instances: MockMotionDetector[] = [];
  public updateOptions = vi.fn();
  constructor(public readonly options: Record<string, unknown>) {
    MockMotionDetector.instances.push(this);
  }
  handleFrame() {}
}

class MockLightDetector {
  static instances: MockLightDetector[] = [];
  public updateOptions = vi.fn();
  public handleFrame = vi.fn();
  constructor(public readonly options: Record<string, unknown>) {
    MockLightDetector.instances.push(this);
  }
}

class MockPoseEstimator {
  static instances: MockPoseEstimator[] = [];
  public ingest = vi.fn();
  public forecast = vi.fn(async () => ({}));
  public mergeIntoMotionMeta = vi.fn(meta => meta ?? {});
  constructor(public readonly options: Record<string, unknown>) {
    MockPoseEstimator.instances.push(this);
  }
  static async create(options: Record<string, unknown>) {
    return new MockPoseEstimator(options);
  }
}

class MockObjectClassifier {
  static instances: MockObjectClassifier[] = [];
  constructor(public readonly options: Record<string, unknown>) {
    MockObjectClassifier.instances.push(this);
  }
  static async create(options: Record<string, unknown>) {
    return new MockObjectClassifier(options);
  }
  async classify(detections: unknown[]) {
    return detections.map(detection => ({
      label: 'object',
      rawLabel: 'object',
      score: 0.5,
      detection,
      isThreat: false,
      threatScore: 0,
      probabilities: { object: 0.5 },
      rawProbabilities: { object: 0.5 }
    }));
  }
}

class MockConfigManager extends EventEmitter {
  constructor(private current: GuardianConfig) {
    super();
  }

  getConfig() {
    return this.current;
  }

  setConfig(next: GuardianConfig) {
    const previous = this.current;
    this.current = next;
    this.emit('reload', { previous, next });
  }

  getPath() {
    return '/mock/config.json';
  }

  watch() {
    return () => {};
  }
}

vi.mock('../src/video/source.js', () => ({
  VideoSource: MockVideoSource
}));

vi.mock('../src/video/personDetector.js', () => ({
  default: MockPersonDetector,
  normalizeClassScoreThresholds: (thresholds?: Record<number, number>) => thresholds
}));

vi.mock('../src/video/motionDetector.js', () => ({
  default: MockMotionDetector
}));

vi.mock('../src/video/lightDetector.js', () => ({
  default: MockLightDetector
}));

vi.mock('../src/video/poseEstimator.js', () => ({
  default: MockPoseEstimator
}));

vi.mock('../src/video/objectClassifier.js', () => ({
  default: MockObjectClassifier
}));

vi.mock('../src/video/sampleVideo.js', () => ({
  ensureSampleVideo: (input: string) => input
}));

const retentionMock = {
  configure: vi.fn(),
  stop: vi.fn()
};

vi.mock('../src/tasks/retention.js', () => ({
  startRetentionTask: vi.fn(() => retentionMock),
  RetentionTask: class {}
}));

class MockAudioSource extends EventEmitter {
  static instances: MockAudioSource[] = [];
  constructor() {
    super();
    MockAudioSource.instances.push(this);
  }
  start() {
    this.emit('ready');
  }
  stop() {
    this.emit('stopped');
  }
  updateOptions() {}
}

vi.mock('../src/audio/source.js', () => ({
  AudioSource: MockAudioSource,
  default: MockAudioSource
}));

describe('run-guard multi camera orchestration', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ default: metrics } = await import('../src/metrics/index.js'));
    MockVideoSource.instances = [];
    MockVideoSource.startCounts = [];
    MockPersonDetector.instances = [];
    MockPersonDetector.calls = [];
    MockMotionDetector.instances = [];
    MockLightDetector.instances = [];
    MockPoseEstimator.instances = [];
    MockObjectClassifier.instances = [];
    MockAudioSource.instances = [];
    metrics.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    retentionMock.configure.mockReset();
    retentionMock.stop.mockReset();
  });

  it('RunGuardReloadsPipelines restarts pipelines after config errors', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const initialConfig: GuardianConfig = {
      video: {
        framesPerSecond: 5,
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'rtsp://camera-1/stream',
            person: { score: 0.5 },
            motion: { diffThreshold: 20, areaThreshold: 0.02 }
          }
        ]
      },
      person: { modelPath: 'person.onnx', score: 0.5 },
      motion: { diffThreshold: 20, areaThreshold: 0.02 }
    } as GuardianConfig;

    const manager = new MockConfigManager(initialConfig);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager as unknown as ConfigManager
    });

    try {
      await waitFor(() => MockVideoSource.instances.length === 1);
      const initialInstance = MockVideoSource.instances[0];

      manager.emit('error', new Error('synthetic failure'));

      await waitFor(() => MockVideoSource.instances.length > 1, 4000);
      const restarted = MockVideoSource.instances.at(-1);
      expect(restarted).not.toBe(initialInstance);
      expect(restarted?.options.channel).toBe('video:cam-1');

      await waitFor(
        () => logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed'),
        4000
      );
      await waitFor(
        () => logger.info.mock.calls.some(([, message]) => message === 'Configuration rollback applied'),
        4000
      );
    } finally {
      runtime.stop();
    }
  });

  it('RunGuardRtspPerChannelConfig applies layered ffmpeg watchdog settings per camera', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const bus = new EventEmitter();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus,
      logger,
      config: {
        video: {
          framesPerSecond: 2,
          ffmpeg: {
            inputArgs: ['-re'],
            startTimeoutMs: 4100,
            idleTimeoutMs: 6500,
            watchdogTimeoutMs: 9000,
            restartDelayMs: 225,
            restartMaxDelayMs: 3200,
            restartJitterFactor: 0.2,
            forceKillTimeoutMs: 3600
          },
          channels: {
            'video:cam-1': {
              ffmpeg: {
                idleTimeoutMs: 7800,
                watchdogTimeoutMs: 12500,
                restartDelayMs: 330
              }
            },
            'video:cam-2': {
              ffmpeg: {
                startTimeoutMs: 4800,
                restartMaxDelayMs: 4500
              }
            }
          },
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'rtsp://camera-1/stream',
              framesPerSecond: 5,
              ffmpeg: {
                rtspTransport: 'tcp',
                inputArgs: ['-stimeout', '5000000'],
                watchdogTimeoutMs: 15000,
                restartMaxDelayMs: 6400
              },
              person: {
                score: 0.6,
                checkEveryNFrames: 1,
                maxDetections: 1
              },
              motion: {
                diffThreshold: 40,
                areaThreshold: 0.03
              }
            },
            {
              id: 'cam-2',
              channel: 'video:cam-2',
              input: 'http://camera-2/playlist.m3u8',
              ffmpeg: {
                inputArgs: ['-re'],
                idleTimeoutMs: 7200,
                watchdogTimeoutMs: 11200,
                restartDelayMs: 400
              },
              person: {
                score: 0.7,
                checkEveryNFrames: 1,
                maxDetections: 1
              },
              motion: {
                diffThreshold: 22,
                areaThreshold: 0.018
              }
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.5,
          checkEveryNFrames: 3,
          maxDetections: 2,
          snapshotDir: 'snapshots',
          minIntervalMs: 1000
        },
        motion: {
          diffThreshold: 25,
          areaThreshold: 0.02,
          minIntervalMs: 1200
        },
        events: {
          thresholds: { info: 0, warning: 5, critical: 10 },
          suppression: {
            rules: [
              {
                id: 'cooldown',
                detector: 'motion',
                source: 'video:cam-1',
                suppressForMs: 1000,
                reason: 'cooldown'
              }
            ]
          }
        }
      }
    });

    await Promise.resolve();

    expect(logger.error).not.toHaveBeenCalled();
    const startLogs = logger.info.mock.calls.filter(([, message]) => message === 'Starting video pipeline');
    expect(startLogs).toHaveLength(2);
    expect(startLogs[0]?.[0]).toMatchObject({
      camera: 'cam-1',
      channel: 'video:cam-1',
      detectors: {
        motion: { diffThreshold: 40, areaThreshold: 0.03 },
        person: { score: 0.6 }
      }
    });
    expect(startLogs[1]?.[0]).toMatchObject({
      camera: 'cam-2',
      channel: 'video:cam-2',
      detectors: {
        motion: { diffThreshold: 22, areaThreshold: 0.018 },
        person: { score: 0.7 }
      }
    });
    expect(runtime.pipelines.size).toBe(2);
    expect(MockVideoSource.instances).toHaveLength(2);
    const [rtspSource, httpSource] = MockVideoSource.instances;
    expect(rtspSource.options).toMatchObject({
      channel: 'video:cam-1',
      file: 'rtsp://camera-1/stream',
      framesPerSecond: 5,
      rtspTransport: 'tcp',
      inputArgs: ['-stimeout', '5000000'],
      startTimeoutMs: 4100,
      idleTimeoutMs: 7800,
      watchdogTimeoutMs: 15000,
      restartDelayMs: 330,
      restartMaxDelayMs: 6400,
      restartJitterFactor: 0.2,
      forceKillTimeoutMs: 3600
    });
    expect(httpSource.options).toMatchObject({
      channel: 'video:cam-2',
      file: 'http://camera-2/playlist.m3u8',
      framesPerSecond: 2,
      inputArgs: ['-re'],
      startTimeoutMs: 4800,
      idleTimeoutMs: 7200,
      watchdogTimeoutMs: 11200,
      restartDelayMs: 400,
      restartMaxDelayMs: 4500,
      restartJitterFactor: 0.2,
      forceKillTimeoutMs: 3600
    });

    expect(MockVideoSource.instances.map(instance => instance.options.channel)).toEqual([
      'video:cam-1',
      'video:cam-2'
    ]);

    expect(MockMotionDetector.instances).toHaveLength(2);
    expect(MockMotionDetector.instances[0].options).toMatchObject({
      diffThreshold: 40,
      areaThreshold: 0.03
    });
    expect(MockMotionDetector.instances[1].options).toMatchObject({
      diffThreshold: 22,
      areaThreshold: 0.018
    });

    runtime.stop();
  });

  it('RunGuardChannelOverrides tracks per-channel restart metrics', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const bus = new EventEmitter();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus,
      logger,
      config: {
        video: {
          framesPerSecond: 4,
          ffmpeg: {
            restartDelayMs: 250,
            restartMaxDelayMs: 2000,
            restartJitterFactor: 0.1,
            watchdogTimeoutMs: 5000
          },
          channels: {},
          cameras: [
            {
              id: 'cam-a',
              channel: 'video:cam-a',
              input: 'rtsp://cam-a',
              ffmpeg: { watchdogTimeoutMs: 6000 },
              person: { score: 0.5 },
              motion: { diffThreshold: 15, areaThreshold: 0.02 }
            },
            {
              id: 'cam-b',
              channel: 'video:cam-b',
              input: 'rtsp://cam-b',
              person: { score: 0.55 },
              motion: { diffThreshold: 18, areaThreshold: 0.018 }
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.5,
          maxDetections: 1
        },
        motion: {
          diffThreshold: 20,
          areaThreshold: 0.02
        },
        events: {
          thresholds: { info: 0, warning: 5, critical: 10 }
        }
      }
    });

    const [camA, camB] = MockVideoSource.instances;

    camA.emit('recover', {
      reason: 'watchdog-timeout',
      attempt: 1,
      delayMs: 420,
      meta: {
        minDelayMs: 250,
        maxDelayMs: 2000,
        baseDelayMs: 250,
        appliedJitterMs: 170
      },
      channel: camA.options.channel,
      errorCode: null,
      exitCode: null,
      signal: null
    });

    camB.emit('recover', {
      reason: 'stream-error',
      attempt: 2,
      delayMs: 600,
      meta: {
        minDelayMs: 250,
        maxDelayMs: 2000,
        baseDelayMs: 250,
        appliedJitterMs: 350
      },
      channel: camB.options.channel,
      errorCode: 'EPIPE',
      exitCode: 1,
      signal: null
    });

    await Promise.resolve();

    const snapshot = metrics.snapshot();
    const camASnapshot = snapshot.pipelines.ffmpeg.byChannel[camA.options.channel!];
    const camBSnapshot = snapshot.pipelines.ffmpeg.byChannel[camB.options.channel!];

    expect(camASnapshot.restarts).toBe(1);
    expect(camASnapshot.byReason['watchdog-timeout']).toBe(1);
    expect(camASnapshot.watchdogBackoffMs).toBe(420);

    expect(camBSnapshot.restarts).toBe(1);
    expect(camBSnapshot.byReason['stream-error']).toBe(1);
    expect(camBSnapshot.totalRestartDelayMs).toBe(600);

    runtime.stop();
  });

  it('RunGuardMultiCameraChannels normalizes channels and isolates restart stats', async () => {
    const recordSpy = vi.spyOn(metrics, 'recordPipelineRestart');
    const { startGuard } = await import('../src/run-guard.ts');

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: {
        video: {
          framesPerSecond: 5,
          channels: {
            'cam-1': {
              motion: { diffThreshold: 32, areaThreshold: 0.025 },
              ffmpeg: { restartDelayMs: 175 }
            },
            'video:cam-2': {
              motion: { diffThreshold: 24, areaThreshold: 0.02 }
            }
          },
          cameras: [
            {
              id: 'cam-1',
              channel: 'cam-1',
              input: 'rtsp://cam-1',
              person: { score: 0.55 },
              motion: { diffThreshold: 40, areaThreshold: 0.03 }
            },
            {
              id: 'cam-2',
              channel: 'video:cam-2',
              input: 'rtsp://cam-2',
              person: { score: 0.6 },
              motion: { diffThreshold: 22, areaThreshold: 0.018 }
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.5
        },
        motion: { diffThreshold: 20, areaThreshold: 0.02 },
        events: { thresholds: { info: 0, warning: 5, critical: 10 } }
      } as GuardianConfig
    });

    try {
      const pipelineCam1 = runtime.pipelines.get('video:cam-1');
      const pipelineCam2 = runtime.pipelines.get('video:cam-2');
      expect(pipelineCam1).toBeDefined();
      expect(pipelineCam2).toBeDefined();
      expect(MockVideoSource.instances[0]?.options.channel).toBe('video:cam-1');
      expect(MockVideoSource.instances[1]?.options.channel).toBe('video:cam-2');
      expect(MockMotionDetector.instances[0]?.options).toMatchObject({ diffThreshold: 32 });
      expect(MockMotionDetector.instances[1]?.options).toMatchObject({ diffThreshold: 22 });

      const [sourceCam1, sourceCam2] = MockVideoSource.instances;
      sourceCam1.emit('recover', {
        reason: 'watchdog-timeout',
        attempt: 2,
        delayMs: 420,
        meta: {
          baseDelayMs: 200,
          minDelayMs: 200,
          maxDelayMs: 600,
          appliedJitterMs: 40,
          minJitterMs: 0,
          maxJitterMs: 40
        },
        channel: sourceCam1.options.channel,
        errorCode: null,
        exitCode: null,
        signal: null
      });

      sourceCam2.emit('recover', {
        reason: 'stream-idle',
        attempt: 1,
        delayMs: 150,
        meta: {
          baseDelayMs: 120,
          minDelayMs: 120,
          maxDelayMs: 300,
          appliedJitterMs: 10,
          minJitterMs: 0,
          maxJitterMs: 10
        },
        channel: sourceCam2.options.channel,
        errorCode: null,
        exitCode: null,
        signal: null
      });

      expect(pipelineCam1?.restartStats.total).toBeGreaterThanOrEqual(1);
      expect(pipelineCam1?.restartStats.watchdogBackoffMs).toBe(420);
      expect(pipelineCam1?.restartStats.totalDelayMs).toBeGreaterThanOrEqual(420);
      expect(pipelineCam1?.restartStats.history.at(-1)?.channel).toBe('video:cam-1');

      expect(pipelineCam2?.restartStats.total).toBeGreaterThanOrEqual(1);
      expect(pipelineCam2?.restartStats.watchdogBackoffMs).toBe(0);
      expect(pipelineCam2?.restartStats.totalDelayMs).toBeGreaterThanOrEqual(150);
      expect(pipelineCam2?.restartStats.history.at(-1)?.channel).toBe('video:cam-2');

      const snapshot = metrics.snapshot();
      const ffmpegChannels = snapshot.pipelines.ffmpeg.byChannel ?? {};
      expect(ffmpegChannels['video:cam-1']?.lastRestart?.reason).toBe('watchdog-timeout');
      expect(ffmpegChannels['video:cam-2']?.lastRestart?.reason).toBe('stream-idle');

      sourceCam1.circuitBroken = true;
      const beforeStarts = MockVideoSource.startCounts[0];
      const resetResult = runtime.resetCircuitBreaker('cam-1');
      expect(resetResult).toBe(true);
      expect(MockVideoSource.startCounts[0]).toBeGreaterThan(beforeStarts);
      expect(recordSpy).toHaveBeenCalledWith(
        'ffmpeg',
        'manual-circuit-reset',
        expect.objectContaining({ channel: 'video:cam-1' })
      );
    } finally {
      recordSpy.mockRestore();
      runtime.stop();
    }
  });

  it('RunGuardCircuitBreakerRecovery restarts a circuit-broken pipeline', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const bus = new EventEmitter();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus,
      logger,
      config: {
        video: {
          framesPerSecond: 2,
          cameras: [
            {
              id: 'cam-reset',
              channel: 'video:cam-reset',
              input: 'rtsp://reset',
              ffmpeg: { circuitBreakerThreshold: 2 },
              person: { score: 0.5 },
              motion: { diffThreshold: 20, areaThreshold: 0.02 }
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.5
        },
        motion: {
          diffThreshold: 20,
          areaThreshold: 0.02
        },
        events: {
          thresholds: { info: 0, warning: 5, critical: 10 }
        }
      }
    });

    const source = MockVideoSource.instances[0];
    const channel = source.options.channel!;

    expect(MockVideoSource.startCounts[0]).toBeGreaterThanOrEqual(1);

    source.circuitBroken = true;

    const resetResult = runtime.resetCircuitBreaker(channel);
    expect(resetResult).toBe(true);
    expect(source.resetCircuitBreaker).toHaveBeenCalledTimes(1);
    expect(MockVideoSource.startCounts[0]).toBeGreaterThan(1);

    const snapshot = metrics.snapshot();
    const channelSnapshot = snapshot.pipelines.ffmpeg.byChannel[channel];
    expect(channelSnapshot.byReason['manual-circuit-reset']).toBe(1);

    const secondReset = runtime.resetCircuitBreaker(channel);
    expect(secondReset).toBe(false);

    runtime.stop();
  });

  it('RunGuardChannelPoseOverrides applies layered pose config and restarts on updates', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const initialConfig: GuardianConfig = {
      video: {
        framesPerSecond: 6,
        channels: {
          'video:cam-1': {
            pose: {
              forecastHorizonMs: 650,
              minMovement: 0.32
            }
          }
        },
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'rtsp://camera-1/stream',
            pose: { minMovement: 0.28 }
          }
        ]
      },
      person: { modelPath: 'person.onnx', score: 0.55 },
      motion: { diffThreshold: 12, areaThreshold: 0.025 },
      pose: { modelPath: 'pose.onnx', forecastHorizonMs: 800, minMovement: 0.4 }
    } as GuardianConfig;

    const manager = new MockConfigManager(initialConfig);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager as unknown as ConfigManager
    });

    try {
      expect(MockPoseEstimator.instances).toHaveLength(1);
      const initialPoseOptions = MockPoseEstimator.instances[0]?.options as Record<string, unknown>;
      expect(initialPoseOptions?.forecastHorizonMs).toBe(650);
      expect(initialPoseOptions?.minMovement).toBe(0.28);

      const updatedConfig: GuardianConfig = {
        ...initialConfig,
        pose: { modelPath: 'pose.onnx', forecastHorizonMs: 900, minMovement: 0.35 },
        video: {
          ...initialConfig.video,
          channels: {
            'video:cam-1': {
              pose: {
                forecastHorizonMs: 950,
                minMovement: 0.3
              }
            }
          },
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'rtsp://camera-1/stream',
              pose: { minMovement: 0.3 }
            }
          ]
        }
      } as GuardianConfig;

      manager.setConfig(updatedConfig);

      for (let attempt = 0; attempt < 5 && MockPoseEstimator.instances.length < 2; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      expect(MockPoseEstimator.instances).toHaveLength(2);
      expect(MockVideoSource.instances.length).toBeGreaterThanOrEqual(2);

      const latestPose = MockPoseEstimator.instances[1]?.options as Record<string, unknown>;
      expect(latestPose?.forecastHorizonMs).toBe(950);
      expect(latestPose?.minMovement).toBe(0.3);
    } finally {
      runtime.stop();
    }
  });

  it('RunGuardObjectThreatThresholds layers object config per channel and restarts on change', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const initialConfig: GuardianConfig = {
      video: {
        framesPerSecond: 8,
        channels: {
          'video:cam-1': {
            objects: {
              threatThreshold: 0.6,
              labelMap: { vehicle: 'vehicle' }
            }
          }
        },
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'rtsp://camera-1/stream'
          }
        ]
      },
      person: { modelPath: 'person.onnx', score: 0.5 },
      motion: { diffThreshold: 10, areaThreshold: 0.02 },
      objects: {
        modelPath: 'objects.onnx',
        labels: ['person', 'vehicle'],
        threatLabels: ['vehicle'],
        threatThreshold: 0.5,
        labelMap: { vehicle: 'vehicle', package: 'delivery' }
      }
    } as GuardianConfig;

    const manager = new MockConfigManager(initialConfig);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager as unknown as ConfigManager
    });

    try {
      expect(MockObjectClassifier.instances).toHaveLength(1);
      const initialOptions = MockObjectClassifier.instances[0]?.options as Record<string, unknown>;
      expect(initialOptions?.threatThreshold).toBe(0.6);
      expect(initialOptions?.labels).toEqual(['person', 'vehicle']);
      expect(initialOptions?.labelMap).toEqual({ vehicle: 'vehicle' });

      const updatedConfig: GuardianConfig = {
        ...initialConfig,
        video: {
          ...initialConfig.video,
          channels: {
            'video:cam-1': {
              objects: {
                threatThreshold: 0.75,
                labelMap: { vehicle: 'threat', package: 'delivery' }
              }
            }
          },
          cameras: [...initialConfig.video.cameras!]
        },
        objects: {
          modelPath: 'objects.onnx',
          labels: ['person', 'vehicle', 'package'],
          threatLabels: ['vehicle', 'package'],
          threatThreshold: 0.55,
          labelMap: { vehicle: 'vehicle', package: 'parcel' }
        }
      } as GuardianConfig;

      manager.setConfig(updatedConfig);
      for (let attempt = 0; attempt < 5 && MockObjectClassifier.instances.length < 2; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      expect(MockObjectClassifier.instances).toHaveLength(2);
      const latest = MockObjectClassifier.instances[1]?.options as Record<string, unknown>;
      expect(latest?.threatThreshold).toBe(0.75);
      expect(latest?.labels).toEqual(['person', 'vehicle', 'package']);
      expect(latest?.labelMap).toEqual({ vehicle: 'threat', package: 'delivery' });
    } finally {
      runtime.stop();
    }
  });

  it('MultiCameraChannelOverrides applies per-channel person thresholds and restart metrics', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const bus = new EventEmitter();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const restartSpy = vi.spyOn(metrics, 'recordPipelineRestart');

    const runtime = await startGuard({
      bus,
      logger,
      config: {
        video: {
          framesPerSecond: 6,
          ffmpeg: { restartDelayMs: 100, restartMaxDelayMs: 100, restartJitterFactor: 0 },
          channels: {
            'video:cam-1': {
              person: {
                classScoreThresholds: { 0: 0.6, 1: 0.7 }
              }
            },
            'video:cam-2': {
              person: {
                classScoreThresholds: { 0: 0.4 }
              }
            }
          },
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'rtsp://camera-1/stream',
              person: {
                classScoreThresholds: { 0: 0.75 }
              }
            },
            {
              id: 'cam-2',
              channel: 'video:cam-2',
              input: 'rtsp://camera-2/stream'
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.5,
          classScoreThresholds: { 0: 0.3, 2: 0.9 }
        },
        motion: {
          diffThreshold: 20,
          areaThreshold: 0.02
        },
        events: {
          thresholds: { info: 0, warning: 1, critical: 2 }
        }
      }
    });

    try {
      await Promise.resolve();

      expect(MockPersonDetector.instances).toHaveLength(2);
      const [cam1Detector, cam2Detector] = MockPersonDetector.instances;
      expect(cam1Detector.options.classScoreThresholds).toEqual({ 0: 0.75, 1: 0.7, 2: 0.9 });
      expect(cam2Detector.options.classScoreThresholds).toEqual({ 0: 0.4, 2: 0.9 });

      expect(MockVideoSource.instances).toHaveLength(2);
      const [cam1Source, cam2Source] = MockVideoSource.instances;
      expect(cam1Source.listenerCount('recover')).toBeGreaterThan(0);
      expect(cam2Source.listenerCount('recover')).toBeGreaterThan(0);
      cam1Source.emit('recover', {
        reason: 'stream-idle',
        attempt: 1,
        delayMs: 100,
        meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
      });
      cam2Source.emit('recover', {
        reason: 'corrupted-frame',
        attempt: 2,
        delayMs: 150,
        meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
      });

      await Promise.resolve();

      const cam1Runtime = runtime.pipelines.get('video:cam-1');
      const cam2Runtime = runtime.pipelines.get('video:cam-2');
      expect(cam1Runtime?.restartStats.total).toBe(1);
      expect(cam2Runtime?.restartStats.total).toBe(1);
      expect(restartSpy).toHaveBeenCalledWith(
        'ffmpeg',
        'stream-idle',
        expect.objectContaining({ channel: 'video:cam-1' })
      );
      expect(restartSpy).toHaveBeenCalledWith(
        'ffmpeg',
        'corrupted-frame',
        expect.objectContaining({ channel: 'video:cam-2' })
      );

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.byChannel['video:cam-1']?.restarts).toBe(1);
      expect(snapshot.pipelines.ffmpeg.byChannel['video:cam-2']?.restarts).toBe(1);
      expect(snapshot.pipelines.ffmpeg.byChannel['video:cam-1']?.byReason?.['stream-idle']).toBe(1);
      expect(snapshot.pipelines.ffmpeg.byChannel['video:cam-2']?.byReason?.['corrupted-frame']).toBe(1);
    } finally {
      restartSpy.mockRestore();
      runtime.stop();
    }
  });

  it('RunGuardRestartHistoryCap limits restart history and tracks totals', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      logger,
      config: {
        video: {
          framesPerSecond: 5,
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'rtsp://camera-1/stream'
            }
          ]
        },
        person: { modelPath: 'model.onnx', score: 0.5 },
        motion: { diffThreshold: 20, areaThreshold: 0.02 },
        events: { thresholds: { info: 0, warning: 1, critical: 2 } }
      }
    });

    try {
      expect(MockVideoSource.instances).toHaveLength(1);
      const source = MockVideoSource.instances[0];
      const stats = runtime.pipelines.get('video:cam-1')?.restartStats;
      const limit = stats?.historyLimit ?? 0;
      expect(limit).toBeGreaterThan(0);

      const iterations = limit + 25;
      let totalDelay = 0;
      let totalWatchdog = 0;
      for (let i = 0; i < iterations; i += 1) {
        const delayMs = i + 1;
        totalDelay += delayMs;
        const reason = i % 2 === 0 ? 'watchdog-timeout' : 'stream-idle';
        if (reason === 'watchdog-timeout') {
          totalWatchdog += delayMs;
        }
        source.emit('recover', {
          reason,
          attempt: i + 1,
          delayMs,
          meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
        });
      }

      const updatedStats = runtime.pipelines.get('video:cam-1')?.restartStats;
      expect(updatedStats?.history.length ?? 0).toBeLessThanOrEqual(limit);
      expect(updatedStats?.totalDelayMs).toBe(totalDelay);
      expect(updatedStats?.watchdogBackoffMs).toBe(totalWatchdog);

      const snapshot = metrics.snapshot();
      const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:cam-1'];
      expect(channelStats?.restartHistory.length ?? 0).toBeLessThanOrEqual(limit);
      expect(channelStats?.historyLimit).toBe(limit);
      expect(channelStats?.droppedHistory).toBeGreaterThan(0);
      expect(channelStats?.totalRestartDelayMs).toBe(totalDelay);
      expect(channelStats?.totalWatchdogBackoffMs).toBe(totalWatchdog);
      expect(snapshot.pipelines.ffmpeg.restartHistory.length ?? 0).toBeLessThanOrEqual(
        snapshot.pipelines.ffmpeg.historyLimit
      );
    } finally {
      runtime.stop();
    }
  });

  it('CameraChannelOverrideValidation rejects cameras without channels', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    await expect(
      startGuard({
        config: {
          video: {
            framesPerSecond: 5,
            cameras: [
              {
                id: 'cam-missing',
                input: 'rtsp://camera-missing/stream'
              }
            ]
          },
          person: { modelPath: 'model.onnx', score: 0.5 },
          motion: { diffThreshold: 10, areaThreshold: 0.02 },
          events: { thresholds: { info: 0, warning: 1, critical: 2 } }
        }
      })
    ).rejects.toThrow(/channel/i);
  });

  it('CameraFfmpegTimeoutConfig applies restart timing overrides and logs recoveries', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const bus = new EventEmitter();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus,
      logger,
      config: {
        video: {
          framesPerSecond: 5,
          ffmpeg: {
            startTimeoutMs: 111,
            idleTimeoutMs: 222,
            watchdogTimeoutMs: 222,
            forceKillTimeoutMs: 333,
            restartDelayMs: 444,
            restartMaxDelayMs: 555,
            restartJitterFactor: 0
          },
          cameras: [
            {
              id: 'cam-default',
              channel: 'video:cam-default',
              input: 'rtsp://camera-default/stream'
            },
            {
              id: 'cam-override',
              channel: 'video:cam-override',
              input: 'rtsp://camera-override/stream',
              ffmpeg: {
                watchdogTimeoutMs: 777,
                restartDelayMs: 1000,
                restartMaxDelayMs: 1000,
                restartJitterFactor: 0
              }
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.4
        },
        motion: {
          diffThreshold: 10,
          areaThreshold: 0.01
        },
        events: {
          thresholds: { info: 0, warning: 1, critical: 2 }
        }
      }
    });

    expect(MockVideoSource.instances).toHaveLength(2);
    const [defaultSource, overrideSource] = MockVideoSource.instances;

    expect(defaultSource.options).toMatchObject({
      idleTimeoutMs: 222,
      startTimeoutMs: 111,
      watchdogTimeoutMs: 222,
      forceKillTimeoutMs: 333,
      restartDelayMs: 444,
      restartMaxDelayMs: 555,
      restartJitterFactor: 0
    });

    expect(overrideSource.options).toMatchObject({
      idleTimeoutMs: 222,
      startTimeoutMs: 111,
      watchdogTimeoutMs: 777,
      restartDelayMs: 1000,
      restartMaxDelayMs: 1000,
      restartJitterFactor: 0
    });

    defaultSource.emit('recover', {
      reason: 'watchdog-timeout',
      attempt: 2,
      delayMs: 444,
      meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
    });
    overrideSource.emit('recover', {
      reason: 'start-timeout',
      attempt: 1,
      delayMs: 1000,
      meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        camera: 'cam-default',
        attempt: 2,
        reason: 'watchdog-timeout',
        delayMs: 444,
        channel: 'video:cam-default',
        errorCode: null,
        exitCode: null
      }),
      'Video source reconnecting (reason=watchdog-timeout)'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        camera: 'cam-override',
        attempt: 1,
        reason: 'start-timeout',
        delayMs: 1000,
        channel: 'video:cam-override',
        errorCode: null,
        exitCode: null
      }),
      'Video source reconnecting (reason=start-timeout)'
    );

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.ffmpeg.restarts).toBe(2);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:cam-default']?.restarts).toBe(1);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:cam-override']?.restarts).toBe(1);

    runtime.stop();
  });

  it('GuardRtspPerCamera applies channel overrides and tracks recoveries independently', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const initialConfig: GuardianConfig = {
      app: { name: 'Guardian Test' },
      logging: { level: 'silent' },
      database: { path: 'guardian-test.sqlite' },
      events: {
        thresholds: { info: 0, warning: 1, critical: 2 },
        suppression: { rules: [] }
      },
      video: {
        framesPerSecond: 4,
        ffmpeg: {
          idleTimeoutMs: 750,
          startTimeoutMs: 500,
          watchdogTimeoutMs: 900,
          restartDelayMs: 150,
          restartMaxDelayMs: 600,
          restartJitterFactor: 0
        },
        channels: {
          'video:cam-1': {
            framesPerSecond: 12,
            ffmpeg: {
              watchdogTimeoutMs: 1500,
              restartDelayMs: 300,
              restartMaxDelayMs: 800
            },
            motion: {
              diffThreshold: 35,
              areaThreshold: 0.05
            },
            person: {
              checkEveryNFrames: 2,
              maxDetections: 3,
              minIntervalMs: 1700
            }
          },
          'video:cam-2': {
            framesPerSecond: 6,
            ffmpeg: {
              restartDelayMs: 600,
              restartMaxDelayMs: 1200
            },
            person: {
              score: 0.65,
              maxDetections: 2
            }
          }
        },
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'rtsp://camera-1/stream',
            ffmpeg: {
              startTimeoutMs: 1200
            },
            person: {
              score: 0.6
            }
          },
          {
            id: 'cam-2',
            channel: 'video:cam-2',
            input: 'rtsp://camera-2/stream',
            motion: {
              areaThreshold: 0.025
            },
            person: {
              checkEveryNFrames: 5
            }
          }
        ]
      },
      person: {
        modelPath: 'model.onnx',
        score: 0.55,
        checkEveryNFrames: 4,
        maxDetections: 4,
        snapshotDir: 'snapshots',
        minIntervalMs: 2100
      },
      motion: {
        diffThreshold: 22,
        areaThreshold: 0.03,
        minIntervalMs: 1800
      }
    };

    const manager = new MockConfigManager(initialConfig);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager as unknown as ConfigManager
    });

    try {
      expect(MockVideoSource.instances).toHaveLength(2);
      const [cam1Source, cam2Source] = MockVideoSource.instances;

      expect(cam1Source.options).toMatchObject({
        file: 'rtsp://camera-1/stream',
        channel: 'video:cam-1',
        framesPerSecond: 12,
        startTimeoutMs: 1200,
        watchdogTimeoutMs: 1500,
        restartDelayMs: 300,
        restartMaxDelayMs: 800
      });

      expect(cam2Source.options).toMatchObject({
        file: 'rtsp://camera-2/stream',
        channel: 'video:cam-2',
        framesPerSecond: 6,
        restartDelayMs: 600,
        restartMaxDelayMs: 1200
      });

      const cam1Runtime = runtime.pipelines.get('video:cam-1');
      const cam2Runtime = runtime.pipelines.get('video:cam-2');

      expect(cam1Runtime).toBeDefined();
      expect(cam2Runtime).toBeDefined();

      expect((cam1Runtime?.motionDetector as MockMotionDetector).options).toMatchObject({
        diffThreshold: 35,
        areaThreshold: 0.05
      });
      expect(cam1Runtime?.checkEvery).toBe(2);
      expect(cam1Runtime?.maxDetections).toBe(3);
      expect(cam1Runtime?.pipelineState.person.minIntervalMs).toBe(1700);

      expect((cam2Runtime?.motionDetector as MockMotionDetector).options).toMatchObject({
        areaThreshold: 0.025
      });
      expect(cam2Runtime?.checkEvery).toBe(5);
      expect(cam2Runtime?.maxDetections).toBe(2);
      expect(cam2Runtime?.pipelineState.person.score).toBeCloseTo(0.65);

      expect(cam1Runtime?.restartStats.total).toBe(0);
      expect(cam2Runtime?.restartStats.total).toBe(0);

      cam1Source.emit('recover', {
        reason: 'watchdog-timeout',
        attempt: 1,
        delayMs: 300,
        meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
      });
      cam2Source.emit('recover', {
        reason: 'start-timeout',
        attempt: 2,
        delayMs: 600,
        meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
      });

      await Promise.resolve();

      expect(cam1Runtime?.restartStats.total).toBe(1);
      expect(cam1Runtime?.restartStats.byReason.get('watchdog-timeout')).toBe(1);
      expect(cam1Runtime?.restartStats.last?.reason).toBe('watchdog-timeout');
      expect(cam1Runtime?.restartStats.watchdogBackoffMs).toBe(300);
      expect(cam2Runtime?.restartStats.total).toBe(1);
      expect(cam2Runtime?.restartStats.byReason.get('start-timeout')).toBe(1);
      expect(cam2Runtime?.restartStats.watchdogBackoffMs).toBe(0);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          camera: 'cam-1',
          attempt: 1,
          reason: 'watchdog-timeout',
          delayMs: 300,
          channel: 'video:cam-1',
          errorCode: null,
          exitCode: null
        }),
        'Video source reconnecting (reason=watchdog-timeout)'
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          camera: 'cam-2',
          attempt: 2,
          reason: 'start-timeout',
          delayMs: 600,
          channel: 'video:cam-2',
          errorCode: null,
          exitCode: null
        }),
        'Video source reconnecting (reason=start-timeout)'
      );

      const updatedConfig: GuardianConfig = {
        ...initialConfig,
        video: {
          ...initialConfig.video,
          channels: {
            ...initialConfig.video.channels,
            'video:cam-1': {
              ...initialConfig.video.channels?.['video:cam-1'],
              framesPerSecond: 10,
              ffmpeg: {
                ...(initialConfig.video.channels?.['video:cam-1']?.ffmpeg ?? {}),
                restartDelayMs: 450,
                restartMaxDelayMs: 900
              },
              person: {
                ...(initialConfig.video.channels?.['video:cam-1']?.person ?? {}),
                maxDetections: 4
              }
            }
          }
        }
      };

      manager.setConfig(updatedConfig);

      await waitFor(
        () => runtime.pipelines.get('video:cam-1')?.pipelineState.framesPerSecond === 10
      );

      expect(MockVideoSource.instances).toHaveLength(3);
      const newCam1Source = MockVideoSource.instances[2];
      expect(newCam1Source.options).toMatchObject({
        framesPerSecond: 10,
        restartDelayMs: 450,
        restartMaxDelayMs: 900
      });

      const reloadedCam1 = runtime.pipelines.get('video:cam-1');
      expect(reloadedCam1).toBeDefined();
      expect(reloadedCam1).not.toBe(cam1Runtime);
      expect(reloadedCam1?.restartStats.total).toBe(0);
      expect(runtime.pipelines.get('video:cam-2')).toBe(cam2Runtime);
      expect(cam2Runtime?.restartStats.total).toBe(1);

      const metricsSnapshot = metrics.snapshot();
      expect(metricsSnapshot.pipelines.ffmpeg.byChannel['video:cam-1']?.restarts).toBe(1);
      expect(
        metricsSnapshot.pipelines.ffmpeg.byChannel['video:cam-1']?.byReason['watchdog-timeout']
      ).toBe(1);
      expect(metricsSnapshot.pipelines.ffmpeg.byChannel['video:cam-2']?.restarts).toBe(1);
    } finally {
      runtime.stop();
    }
  });

  it('GuardCameraHotReload orchestrates dynamic camera pipelines', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const initialConfig: GuardianConfig = {
      app: { name: 'Guardian Test' },
      logging: { level: 'silent' },
      database: { path: 'guardian-test.sqlite' },
      events: {
        thresholds: { info: 0, warning: 1, critical: 2 },
        suppression: { rules: [] }
      },
      video: {
        framesPerSecond: 5,
        ffmpeg: { inputArgs: ['-re'] },
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'rtsp://camera-1/stream',
            person: {
              score: 0.5,
              checkEveryNFrames: 1,
              maxDetections: 1,
              minIntervalMs: 1000
            },
            motion: {
              diffThreshold: 25,
              areaThreshold: 0.02
            }
          }
        ]
      },
      person: {
        modelPath: 'model.onnx',
        score: 0.5,
        checkEveryNFrames: 2,
        maxDetections: 2,
        snapshotDir: 'snapshots',
        minIntervalMs: 1200
      },
      motion: {
        diffThreshold: 25,
        areaThreshold: 0.02,
        minIntervalMs: 1500
      }
    };

    const manager = new MockConfigManager(initialConfig);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager as unknown as ConfigManager
    });

    try {
      expect(MockVideoSource.instances).toHaveLength(1);
      const initialSource = MockVideoSource.instances[0];
      const stopSpy = vi.spyOn(initialSource, 'stop');

      const updatedConfig: GuardianConfig = {
        ...initialConfig,
        video: {
          ...initialConfig.video,
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'rtsp://camera-1/stream2',
              ffmpeg: {
                rtspTransport: 'tcp',
                inputArgs: ['-stimeout', '5000000']
              },
              person: {
                score: 0.6,
                checkEveryNFrames: 2,
                maxDetections: 2,
                minIntervalMs: 900
              },
              motion: {
                diffThreshold: 30,
                areaThreshold: 0.018
              }
            },
            {
              id: 'cam-2',
              channel: 'video:cam-2',
              input: 'rtsp://camera-2/stream',
              person: {
                score: 0.55,
                checkEveryNFrames: 1,
                maxDetections: 1,
                minIntervalMs: 1000
              },
              motion: {
                diffThreshold: 28,
                areaThreshold: 0.02
              }
            }
          ]
        },
        events: {
          ...initialConfig.events,
          suppression: {
            rules: [
              {
                id: 'cam-2-cooldown',
                detector: 'motion',
                source: 'video:cam-2',
                suppressForMs: 750,
                reason: 'cooldown'
              }
            ]
          }
        }
      };

      manager.setConfig(updatedConfig);

      await waitFor(() => runtime.pipelines.size === 2);
      await waitFor(() => stopSpy.mock.calls.length > 0);

      expect(stopSpy).toHaveBeenCalledTimes(1);

      const cam1Runtime = runtime.pipelines.get('video:cam-1');
      const cam2Runtime = runtime.pipelines.get('video:cam-2');

      expect(cam1Runtime).toBeDefined();
      expect(cam2Runtime).toBeDefined();

      const cam1Source = cam1Runtime?.source as MockVideoSource;
      const cam2Source = cam2Runtime?.source as MockVideoSource;

      expect(cam1Source).not.toBe(initialSource);
      expect(cam1Source.options).toMatchObject({
        file: 'rtsp://camera-1/stream2',
        rtspTransport: 'tcp',
        inputArgs: ['-stimeout', '5000000']
      });

      expect(cam2Source.options).toMatchObject({
        file: 'rtsp://camera-2/stream',
        framesPerSecond: 5
      });

      expect(cam1Runtime?.checkEvery).toBe(2);
      expect(cam1Runtime?.maxDetections).toBe(2);

      await waitFor(() =>
        logger.info.mock.calls.some(([, message]) => message === 'configuration reloaded')
      );
    } finally {
      runtime.stop();
    }
  });

  it('run-guard multi camera testi triggers detectors per source', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const bus = new EventEmitter();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus,
      logger,
      config: {
        video: {
          framesPerSecond: 2,
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'cam-1.mp4',
              person: {
                score: 0.6,
                checkEveryNFrames: 1,
                maxDetections: 1
              }
            },
            {
              id: 'cam-2',
              channel: 'video:cam-2',
              input: 'cam-2.mp4',
              person: {
                score: 0.7,
                checkEveryNFrames: 1,
                maxDetections: 1
              }
            }
          ]
        },
        person: {
          modelPath: 'model.onnx',
          score: 0.5,
          checkEveryNFrames: 3,
          maxDetections: 2,
          snapshotDir: 'snapshots',
          minIntervalMs: 1000
        },
        motion: {
          diffThreshold: 25,
          areaThreshold: 0.02,
          minIntervalMs: 1200
        }
      }
    });

    expect(MockVideoSource.instances).toHaveLength(2);
    expect(MockPersonDetector.instances.map(instance => instance.options.source)).toEqual([
      'video:cam-1',
      'video:cam-2'
    ]);

    bus.emit('event', { detector: 'motion', source: 'video:cam-1' });
    bus.emit('event', { detector: 'motion', source: 'video:cam-2' });

    MockVideoSource.instances[0].emit('frame', Buffer.alloc(0));
    MockVideoSource.instances[1].emit('frame', Buffer.alloc(0));

    await Promise.resolve();
    await Promise.resolve();

    expect(MockPersonDetector.calls).toEqual(['video:cam-1', 'video:cam-2']);

    runtime.stop();
  });

  it('LightPipelineActivation enables light detectors per camera and applies hot reload updates', async () => {
    const { startGuard } = await import('../src/run-guard.ts');

    const initialConfig: GuardianConfig = {
      app: { name: 'Guardian Test' },
      logging: { level: 'silent' },
      database: { path: 'guardian-test.sqlite' },
      events: {
        thresholds: { info: 0, warning: 1, critical: 2 },
        suppression: { rules: [] }
      },
      video: {
        framesPerSecond: 6,
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'rtsp://camera-1/stream'
          },
          {
            id: 'cam-2',
            channel: 'video:cam-2',
            input: 'rtsp://camera-2/stream',
            light: { deltaThreshold: 45, debounceFrames: 4 }
          }
        ]
      },
      person: { modelPath: 'model.onnx', score: 0.4 },
      motion: { diffThreshold: 10, areaThreshold: 0.01 },
      light: { deltaThreshold: 30, debounceFrames: 3, backoffFrames: 4, smoothingFactor: 0.25 }
    };

    const manager = new MockConfigManager(initialConfig);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager
    });

    try {
      expect(MockLightDetector.instances).toHaveLength(2);
      expect(MockLightDetector.instances[0].options).toMatchObject({
        source: 'video:cam-1',
        deltaThreshold: 30,
        debounceFrames: 3,
        backoffFrames: 4
      });
      expect(MockLightDetector.instances[1].options).toMatchObject({
        source: 'video:cam-2',
        deltaThreshold: 45,
        debounceFrames: 4
      });

      const [sourceOne, sourceTwo] = MockVideoSource.instances;
      sourceOne.emit('frame', Buffer.alloc(0));
      sourceTwo.emit('frame', Buffer.alloc(0));
      expect(MockLightDetector.instances[0].handleFrame).toHaveBeenCalled();
      expect(MockLightDetector.instances[1].handleFrame).toHaveBeenCalled();

      const updatedConfig: GuardianConfig = {
        ...initialConfig,
        light: {
          ...initialConfig.light!,
          deltaThreshold: 28,
          debounceFrames: 6
        },
        video: {
          ...initialConfig.video,
          cameras: [
            initialConfig.video.cameras![0],
            {
              ...initialConfig.video.cameras![1],
              light: { deltaThreshold: 35, debounceFrames: 5, noiseMultiplier: 3 }
            }
          ]
        }
      };

      manager.setConfig(updatedConfig);

      await waitFor(
        () =>
          MockLightDetector.instances.every(instance => instance.updateOptions.mock.calls.length > 0)
      );

      expect(MockLightDetector.instances[0].updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ deltaThreshold: 28, debounceFrames: 6 })
      );
      expect(MockLightDetector.instances[1].updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ deltaThreshold: 35, debounceFrames: 5, noiseMultiplier: 3 })
      );
    } finally {
      runtime.stop();
    }
  });
});

async function waitFor(predicate: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}
