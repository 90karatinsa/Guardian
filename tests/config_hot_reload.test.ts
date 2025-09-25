import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { ConfigManager, loadConfigFromFile } from '../src/config/index.js';
import type { CameraConfig, GuardianConfig } from '../src/config/index.js';
import { EventBus } from '../src/eventBus.js';

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

class InMemoryConfigManager extends EventEmitter {
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
  normalizeClassScoreThresholds: (thresholds: Record<number, number>) => thresholds
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
    retentionMock.configure.mockReset();
    retentionMock.stop.mockReset();
  });

  it('ConfigSchemaValidationErrors enforces channel, fallback, and rate limit rules', () => {
    const config = createConfig({ diffThreshold: 20 });
    config.video.channels = { 'video:present': {} };
    config.video.cameras[0].channel = 'video:missing';
    config.audio = {
      micFallbacks: {
        linux: [{ device: '   ' }]
      }
    };
    config.events.suppression.rules[0] = {
      ...config.events.suppression.rules[0],
      id: 'rate-limit',
      reason: 'rl-test',
      rateLimit: { count: 5, perMs: 1 }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    try {
      loadConfigFromFile(configPath);
      throw new Error('expected validation to fail');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('references undefined channel');
      expect(message).toContain('device must be a non-empty string');
      expect(message).toContain('rateLimit.perMs must be greater than or equal to count');
    }
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

  it('ConfigHotReload reloads suppression rules and resets state', async () => {
    const initialConfig = createConfig({
      diffThreshold: 25,
      suppressionRules: [
        {
          id: 'initial',
          detector: 'motion',
          source: 'video:cam-1',
          suppressForMs: 1000,
          reason: 'initial suppression'
        }
      ]
    });
    fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

    const manager = new ConfigManager(configPath);
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const busLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const metricsMock = { recordEvent: vi.fn(), recordSuppressedEvent: vi.fn() };
    const bus = new EventBus({ store: vi.fn(), log: busLogger as any, metrics: metricsMock as any });

    const runtime = await startGuard({ bus, logger, configManager: manager });

    try {
      const firstAllowed = bus.emitEvent({
        source: 'video:cam-1',
        detector: 'motion',
        severity: 'warning',
        message: 'motion detected',
        ts: 0
      });
      expect(firstAllowed).toBe(true);

      const suppressed = bus.emitEvent({
        source: 'video:cam-1',
        detector: 'motion',
        severity: 'warning',
        message: 'motion detected',
        ts: 500
      });
      expect(suppressed).toBe(false);

      const initialSuppression = busLogger.info.mock.calls.find(([, message]) => message === 'Event suppressed');
      expect(initialSuppression?.[0]?.meta).toMatchObject({ suppressionRuleId: 'initial' });

      busLogger.info.mockClear();

      const updatedConfig = createConfig({
        diffThreshold: 30,
        suppressionRules: [
          {
            id: 'updated',
            detector: 'motion',
            source: 'video:cam-1',
            suppressForMs: 1500,
            reason: 'updated suppression'
          }
        ]
      });

      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

      await waitFor(() => logger.info.mock.calls.some(([, message]) => message === 'configuration reloaded'));

      const reloadCall = logger.info.mock.calls.find(([, message]) => message === 'configuration reloaded');
      expect(reloadCall?.[0]).toMatchObject({ cameras: 1, channels: 0, audioFallbacks: 0 });

      const allowedAfterReload = bus.emitEvent({
        source: 'video:cam-1',
        detector: 'motion',
        severity: 'warning',
        message: 'motion detected',
        ts: 600
      });
      expect(allowedAfterReload).toBe(true);

      const suppressedWithNewRule = bus.emitEvent({
        source: 'video:cam-1',
        detector: 'motion',
        severity: 'warning',
        message: 'motion detected',
        ts: 700
      });
      expect(suppressedWithNewRule).toBe(false);

      const updatedSuppression = busLogger.info.mock.calls.find(([, message]) => message === 'Event suppressed');
      expect(updatedSuppression?.[0]?.meta).toMatchObject({ suppressionRuleId: 'updated' });
    } finally {
      runtime.stop();
    }
  });

  it('ConfigReloadRestartsPipelines stops removed cameras', async () => {
    const initialConfig = createConfig({
      diffThreshold: 20,
      cameras: [
        {
          id: 'cam-1',
          channel: 'video:cam-1',
          input: 'sample-a.mp4',
          person: { score: 0.5 }
        },
        {
          id: 'cam-2',
          channel: 'video:cam-2',
          input: 'sample-b.mp4',
          person: { score: 0.6 }
        }
      ]
    });

    const manager = new InMemoryConfigManager(initialConfig);
    const { startGuard } = await import('../src/run-guard.ts');

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
      expect(runtime.pipelines.size).toBe(2);
      const cam2Runtime = runtime.pipelines.get('video:cam-2');
      expect(cam2Runtime).toBeDefined();

      const stopSpy = vi.spyOn(cam2Runtime!.source as MockVideoSource, 'stop');

      const updatedConfig = createConfig({
        diffThreshold: 22,
        cameras: [
          {
            id: 'cam-1',
            channel: 'video:cam-1',
            input: 'sample-a.mp4',
            person: { score: 0.55 }
          }
        ]
      });

      manager.setConfig(updatedConfig);

      await waitFor(() => runtime.pipelines.size === 1);

      expect(runtime.pipelines.has('video:cam-2')).toBe(false);
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stop();
    }
  });

  it('ConfigHotReloadRecovery reverts to last known good config on invalid JSON', async () => {
    const initialConfig = createConfig({ diffThreshold: 20 });
    const serialized = JSON.stringify(initialConfig, null, 2);
    fs.writeFileSync(configPath, serialized);

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
      fs.writeFileSync(configPath, '{ invalid json');

      await waitFor(() => {
        const contents = fs.readFileSync(configPath, 'utf-8');
        return contents.trim() === serialized.trim();
      });

      const current = manager.getConfig();
      expect(current.motion.diffThreshold).toBe(20);
      expect(logger.error).not.toHaveBeenCalled();
      const warnCall = logger.warn.mock.calls.find(([, message]) => message === 'configuration reload failed');
      expect(warnCall).toBeDefined();
      expect(warnCall?.[0]).toMatchObject({ configPath, action: 'reload', restored: true });
      expect(warnCall?.[0]?.err).toBeInstanceOf(Error);
    } finally {
      runtime.stop();
    }
  });
});

function createConfig(overrides: {
  diffThreshold: number;
  suppressionRules?: Record<string, unknown>[];
  cameras?: CameraConfig[];
}): GuardianConfig {
  const base = {
    app: { name: 'Guardian Test' },
    logging: { level: 'silent' },
    database: { path: path.join(os.tmpdir(), 'guardian-test.sqlite') },
    events: {
      thresholds: {
        info: 0,
        warning: 5,
        critical: 10
      },
      retention: {
        retentionDays: 30,
        intervalMinutes: 60,
        archiveDir: path.join(os.tmpdir(), 'guardian-archive'),
        enabled: false,
        maxArchivesPerCamera: 2,
        snapshot: { mode: 'archive', retentionDays: 20 },
        vacuum: { mode: 'auto', analyze: true }
      },
      suppression: {
        rules:
          overrides.suppressionRules ?? [
            {
              id: 'default-cooldown',
              detector: 'motion',
              source: 'video:cam-1',
              suppressForMs: 1000,
              reason: 'default cooldown'
            }
          ]
      }
    },
    video: {
      framesPerSecond: 1,
      cameras:
        overrides.cameras ?? [
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

  return base as GuardianConfig;
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
