import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

class MockVideoSource extends EventEmitter {
  static instances: MockVideoSource[] = [];
  constructor(
    public readonly options: {
      file: string;
      framesPerSecond: number;
      rtspTransport?: string;
      inputArgs?: string[];
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

vi.mock('../src/video/source.js', () => ({
  VideoSource: MockVideoSource
}));

vi.mock('../src/video/personDetector.js', () => ({
  default: MockPersonDetector
}));

vi.mock('../src/video/motionDetector.js', () => ({
  default: MockMotionDetector
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    retentionMock.configure.mockReset();
    retentionMock.stop.mockReset();
  });

  it('MultiCameraRtspConfig applies camera-specific ffmpeg and motion options', async () => {
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
            watchdogTimeoutMs: 222,
            forceKillTimeoutMs: 333,
            restartDelayMs: 444,
            restartMaxDelayMs: 555,
            restartJitterFactor: 0
          },
          cameras: [
            {
              id: 'cam-default',
              input: 'rtsp://camera-default/stream'
            },
            {
              id: 'cam-override',
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
      startTimeoutMs: 111,
      watchdogTimeoutMs: 222,
      forceKillTimeoutMs: 333,
      restartDelayMs: 444,
      restartMaxDelayMs: 555,
      restartJitterFactor: 0
    });

    expect(overrideSource.options).toMatchObject({
      startTimeoutMs: 111,
      watchdogTimeoutMs: 777,
      restartDelayMs: 1000,
      restartMaxDelayMs: 1000,
      restartJitterFactor: 0
    });

    defaultSource.emit('recover', { reason: 'watchdog-timeout', attempt: 2, delayMs: 444 });
    overrideSource.emit('recover', { reason: 'start-timeout', attempt: 1, delayMs: 1000 });

    expect(logger.warn).toHaveBeenCalledWith(
      { camera: 'cam-default', attempt: 2, reason: 'watchdog-timeout', delayMs: 444 },
      'Video source reconnecting (reason=watchdog-timeout)'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { camera: 'cam-override', attempt: 1, reason: 'start-timeout', delayMs: 1000 },
      'Video source reconnecting (reason=start-timeout)'
    );

    runtime.stop();
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
});
