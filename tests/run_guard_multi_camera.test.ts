import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager, GuardianConfig } from '../src/config/index.js';
import metrics from '../src/metrics/index.js';

class MockVideoSource extends EventEmitter {
  static instances: MockVideoSource[] = [];
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
  }
  start() {}
  stop() {
    this.emit('stopped');
  }
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

describe('run-guard multi camera orchestration', () => {
  beforeEach(() => {
    vi.resetModules();
    MockVideoSource.instances = [];
    MockPersonDetector.instances = [];
    MockPersonDetector.calls = [];
    MockMotionDetector.instances = [];
    MockLightDetector.instances = [];
    metrics.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    retentionMock.configure.mockReset();
    retentionMock.stop.mockReset();
  });

  it('MultiCameraRtspWatchdog applies camera-specific ffmpeg and motion options', async () => {
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
            inputArgs: ['-re']
          },
          cameras: [
            {
              id: 'cam-1',
              channel: 'video:cam-1',
              input: 'rtsp://camera-1/stream',
              framesPerSecond: 5,
              ffmpeg: {
                rtspTransport: 'tcp',
                inputArgs: ['-stimeout', '5000000']
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
    expect(runtime.pipelines.size).toBe(2);
    expect(MockVideoSource.instances).toHaveLength(2);
    const [rtspSource, httpSource] = MockVideoSource.instances;
    expect(rtspSource.options).toMatchObject({
      file: 'rtsp://camera-1/stream',
      framesPerSecond: 5,
      rtspTransport: 'tcp',
      inputArgs: ['-stimeout', '5000000']
    });
    expect(httpSource.options).toMatchObject({
      file: 'http://camera-2/playlist.m3u8',
      framesPerSecond: 2,
      inputArgs: ['-re']
    });

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
