import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

class MockVideoSource extends EventEmitter {
  static instances: MockVideoSource[] = [];
  constructor(public readonly options: { file: string; framesPerSecond: number }) {
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
  constructor(public readonly options: Record<string, unknown>) {}
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

describe('run-guard multi camera orchestration', () => {
  beforeEach(() => {
    vi.resetModules();
    MockVideoSource.instances = [];
    MockPersonDetector.instances = [];
    MockPersonDetector.calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('MultiCameraConfig triggers detectors per source', async () => {
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
