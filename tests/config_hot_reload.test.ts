import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { ConfigManager, loadConfigFromFile } from '../src/config/index.js';

class MockVideoSource extends EventEmitter {
  static instances: MockVideoSource[] = [];
  constructor(public readonly options: Record<string, unknown>) {
    super();
    MockVideoSource.instances.push(this);
  }
  start() {}
  stop() {}
}

class MockPersonDetector {
  static async create(options: Record<string, unknown>) {
    return new MockPersonDetector(options);
  }
  constructor(public readonly options: Record<string, unknown>) {}
  async handleFrame() {}
}

class MockMotionDetector {
  static instances: MockMotionDetector[] = [];
  public updateOptions = vi.fn();
  constructor(public options: Record<string, unknown>) {
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

describe('ConfigHotReload', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-config-'));
    configPath = path.join(tempDir, 'config.json');
    MockMotionDetector.instances = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('throws when configuration is invalid', () => {
    fs.writeFileSync(configPath, JSON.stringify({ app: { name: 'test' } }));

    expect(() => loadConfigFromFile(configPath)).toThrow();
  });

  it('applies motion threshold updates to active detectors', async () => {
    const config = createConfig({ diffThreshold: 25 });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const manager = new ConfigManager(configPath);

    const { startGuard } = await import('../src/run-guard.ts');

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
      expect(MockMotionDetector.instances).toHaveLength(1);
      const detector = MockMotionDetector.instances[0];
      expect(detector.options.diffThreshold).toBe(25);

      const updatedConfig = createConfig({ diffThreshold: 40 });
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

      await waitFor(() => detector.updateOptions.mock.calls.length > 0);

      expect(detector.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ diffThreshold: 40 })
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ diffThreshold: 40 }),
        'configuration reloaded'
      );
    } finally {
      runtime.stop();
    }
  });
});

function createConfig(overrides: { diffThreshold: number }) {
  const base = {
    app: { name: 'Guardian Test' },
    logging: { level: 'silent' },
    database: { path: path.join(os.tmpdir(), 'guardian-test.sqlite') },
    events: {
      thresholds: {
        info: 0,
        warning: 5,
        critical: 10
      }
    },
    video: {
      framesPerSecond: 1,
      cameras: [
        {
          id: 'cam-1',
          channel: 'video:cam-1',
          input: 'sample.mp4',
          person: {
            score: 0.5
          }
        }
      ]
    },
    person: {
      modelPath: 'model.onnx',
      score: 0.5,
      checkEveryNFrames: 1,
      maxDetections: 1,
      snapshotDir: 'snapshots',
      minIntervalMs: 1000
    },
    motion: {
      diffThreshold: overrides.diffThreshold,
      areaThreshold: 0.02,
      minIntervalMs: 1500
    }
  };

  return base;
}

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
