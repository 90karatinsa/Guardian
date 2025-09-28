import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { ConfigManager, loadConfigFromFile, validateConfig } from '../src/config/index.js';
import type { CameraConfig, GuardianConfig, MotionTuningConfig } from '../src/config/index.js';
import { EventBus } from '../src/eventBus.js';
import AudioAnomalyDetector from '../src/audio/anomaly.js';

vi.mock('meyda', () => ({
  default: {
    extract: vi.fn(() => ({
      rms: 0,
      spectralCentroid: 0
    }))
  }
}));

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

class MockAudioSource extends EventEmitter {
  static instances: MockAudioSource[] = [];
  public updateOptions = vi.fn();
  public start = vi.fn();
  public stop = vi.fn();
  constructor(public readonly options: Record<string, unknown>) {
    super();
    MockAudioSource.instances.push(this);
  }
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

vi.mock('../src/audio/source.js', () => ({
  AudioSource: MockAudioSource
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
    MockAudioSource.instances = [];
    MockVideoSource.instances = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
    retentionMock.configure.mockReset();
    retentionMock.stop.mockReset();
  });

  it('ConfigHotReloadChannelThresholds validates thresholds and restarts pipelines after rollback', async () => {
    const base = createConfig({ diffThreshold: 28 });
    base.video.channels = {
      'video:cam-1': {
        motion: { diffThreshold: 22, areaThreshold: 0.025 },
        person: { score: 0.55 }
      }
    };

    const invalid = JSON.parse(JSON.stringify(base)) as GuardianConfig;
    invalid.video.channels!['video:cam-1']!.person = { score: 1.4 };
    if (invalid.video.cameras) {
      invalid.video.cameras[0].motion = {
        ...(invalid.video.cameras[0].motion ?? {}),
        areaThreshold: 1.2
      } as CameraConfig['motion'];
    }

    fs.writeFileSync(configPath, JSON.stringify(invalid, null, 2));
    expect(() => loadConfigFromFile(configPath)).toThrowErrorMatchingInlineSnapshot(
      "[Error: config.video.channels.video:cam-1.person.score must be between 0 and 1; config.video.cameras[cam-1].motion.areaThreshold must be between 0 and 1]"
    );

    fs.writeFileSync(configPath, JSON.stringify(base, null, 2));

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
      await waitFor(() => runtime.pipelines.size === 1);
      await waitFor(() => MockVideoSource.instances.length === 1);

      const initialInstance = MockVideoSource.instances[0];
      const initialCount = MockVideoSource.instances.length;

      const broken = JSON.parse(JSON.stringify(base)) as GuardianConfig;
      broken.video.channels!['video:cam-1']!.person = { score: 2 };
      if (broken.video.cameras) {
        broken.video.cameras[0].motion = {
          ...(broken.video.cameras[0].motion ?? {}),
          areaThreshold: 1.5
        } as CameraConfig['motion'];
      }

      fs.writeFileSync(configPath, JSON.stringify(broken, null, 2));

      await waitFor(
        () => logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed'),
        4000
      );
      await waitFor(
        () => logger.info.mock.calls.some(([, message]) => message === 'Configuration rollback applied'),
        4000
      );

      await waitFor(() => MockVideoSource.instances.length > initialCount, 4000);

      const latestInstance = MockVideoSource.instances.at(-1);
      expect(latestInstance).not.toBe(initialInstance);
      expect(latestInstance?.options.channel).toBe('video:cam-1');

      await waitFor(() => runtime.pipelines.get('video:cam-1')?.pipelineState.person.score === 0.5, 4000);
    } finally {
      runtime.stop();
    }
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

  it('ConfigDuplicateChannelGuard handles duplicate camera channels and ids on reload', async () => {
    const base = createConfig({
      diffThreshold: 30,
      cameras: [
        { id: 'cam-1', channel: 'video:cam-1', input: 'rtsp://cam-1' },
        { id: 'cam-2', channel: 'video:cam-2', input: 'rtsp://cam-2' }
      ]
    });
    base.video.channels = {
      'video:cam-1': {},
      'video:cam-2': {}
    };

    const baseRaw = JSON.stringify(base, null, 2);
    fs.writeFileSync(configPath, baseRaw);

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
      await waitFor(() => runtime.pipelines.size === 2);

      expect(runtime.pipelines.has('video:cam-1')).toBe(true);
      expect(runtime.pipelines.has('video:cam-2')).toBe(true);
      const initialSources = MockVideoSource.instances.length;
      const warnCallsBefore = logger.warn.mock.calls.length;

      const invalid = JSON.parse(JSON.stringify(base)) as GuardianConfig;
      if (invalid.video.cameras) {
        invalid.video.cameras[1].channel = 'video:cam-1';
        invalid.video.cameras[1].id = 'cam-1';
      }
      fs.writeFileSync(configPath, JSON.stringify(invalid, null, 2));

      await waitFor(() => logger.warn.mock.calls.length > warnCallsBefore);

      await waitFor(() => fs.readFileSync(configPath, 'utf-8') === baseRaw);
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(runtime.pipelines.has('video:cam-1')).toBe(true);
      expect(runtime.pipelines.has('video:cam-2')).toBe(true);

      const repaired = JSON.parse(JSON.stringify(base)) as GuardianConfig;
      repaired.video.channels = {
        'video:cam-1': {},
        'video:cam-3': {}
      };
      if (repaired.video.cameras) {
        repaired.video.cameras[1].channel = 'video:cam-3';
        repaired.video.cameras[1].id = 'cam-3';
        repaired.video.cameras[1].input = 'rtsp://cam-3';
      }
      fs.writeFileSync(configPath, JSON.stringify(repaired, null, 2));
      await waitFor(
        () => manager.getConfig().video.cameras?.some(camera => camera.id === 'cam-3') ?? false,
        4000
      );

      await waitFor(() => MockVideoSource.instances.length > initialSources, 4000);
      await waitFor(() => runtime.pipelines.has('video:cam-3'), 4000);

      expect(runtime.pipelines.has('video:cam-2')).toBe(false);
      expect(runtime.pipelines.size).toBe(2);
      expect(MockVideoSource.instances.length).toBeGreaterThan(initialSources);
      expect(
        MockVideoSource.instances.some(instance => instance.options.channel === 'video:cam-3')
      ).toBe(true);
    } finally {
      runtime.stop();
    }
  });

  it('MotionHotReloadTuning applies motion tuning updates to active detectors', async () => {
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

      const configWithMotion = createConfig({
        diffThreshold: 25,
        motionOverrides: {
          areaThreshold: 0.02,
          minIntervalMs: 1750,
          debounceFrames: 2,
          backoffFrames: 4,
          noiseMultiplier: 2.5,
          noiseSmoothing: 0.2,
          areaSmoothing: 0.3,
          areaInflation: 1.6,
          areaDeltaThreshold: 0.05
        }
      });
      fs.writeFileSync(configPath, JSON.stringify(configWithMotion, null, 2));

      await waitFor(() => detector.updateOptions.mock.calls.length > 0);

      expect(detector.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          diffThreshold: 25,
          areaThreshold: 0.02,
          minIntervalMs: 1750,
          debounceFrames: 2,
          backoffFrames: 4,
          noiseMultiplier: 2.5,
          noiseSmoothing: 0.2,
          areaSmoothing: 0.3,
          areaInflation: 1.6,
          areaDeltaThreshold: 0.05
        })
      );

      detector.updateOptions.mockClear();

      const updatedConfig = createConfig({
        diffThreshold: 40,
        motionOverrides: {
          areaThreshold: 0.03,
          minIntervalMs: 1900,
          debounceFrames: 5,
          backoffFrames: 8,
          noiseMultiplier: 3.1,
          noiseSmoothing: 0.25,
          areaSmoothing: 0.35,
          areaInflation: 2.1,
          areaDeltaThreshold: 0.08
        }
      });
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

      await waitFor(() => detector.updateOptions.mock.calls.length > 0);

      expect(detector.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          diffThreshold: 40,
          areaThreshold: 0.03,
          minIntervalMs: 1900,
          debounceFrames: 5,
          backoffFrames: 8,
          noiseMultiplier: 3.1,
          noiseSmoothing: 0.25,
          areaSmoothing: 0.35,
          areaInflation: 2.1,
          areaDeltaThreshold: 0.08
        })
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

  it('ConfigChannelCollisionValidation rejects channel conflicts on reload', async () => {
    const baseConfig = createConfig({ diffThreshold: 25 });
    baseConfig.audio = { channel: 'audio:primary' } as GuardianConfig['audio'];
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

    const manager = new ConfigManager(configPath);
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({ logger, configManager: manager });

    try {
      await waitFor(() => MockVideoSource.instances.length === 1);

      const invalidConfig = createConfig({ diffThreshold: 30 });
      invalidConfig.audio = { channel: 'video:cam-1' } as GuardianConfig['audio'];
      fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2));

      await waitFor(() =>
        logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed')
      );

      expect(
        logger.info.mock.calls.some(([, message]) => message === 'configuration reloaded')
      ).toBe(false);
      expect(MockVideoSource.instances).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });

  it('ConfigHotReloadValidation enforces channel and threshold constraints with rollback', async () => {
    const baseConfig = createConfig({ diffThreshold: 28 });
    baseConfig.video.channels = { 'video:cam-1': {} };
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

    const manager = new ConfigManager(configPath);
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({ logger, configManager: manager });

    const originalRaw = fs.readFileSync(configPath, 'utf-8');

    try {
      await waitFor(() => MockVideoSource.instances.length === 1);

      const invalidChannel = JSON.parse(JSON.stringify(baseConfig)) as GuardianConfig;
      if (invalidChannel.video.cameras) {
        invalidChannel.video.cameras[0].channel = '   ';
      }
      invalidChannel.audio = {
        channel: '   ',
        micFallbacks: {
          linux: [{ device: '   ' }]
        }
      } as GuardianConfig['audio'];

      fs.writeFileSync(configPath, JSON.stringify(invalidChannel, null, 2));

      await waitFor(() =>
        logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed')
      );
      await waitFor(() =>
        logger.info.mock.calls.some(([, message]) => message === 'Configuration rollback applied')
      );

      const channelWarn = logger.warn.mock.calls.find(([, message]) => message === 'configuration reload failed');
      expect(channelWarn?.[0]?.err).toBeInstanceOf(Error);
      const channelMessage = channelWarn?.[0]?.err?.message ?? '';
      expect(channelMessage).toContain('must specify a non-empty channel');
      expect(channelMessage).toContain('must be a non-empty string');

      await waitFor(() => fs.readFileSync(configPath, 'utf-8') === originalRaw);
      expect(manager.getConfig().motion.diffThreshold).toBe(baseConfig.motion.diffThreshold);

      await new Promise(resolve => setTimeout(resolve, 250));

      logger.warn.mockClear();
      logger.info.mockClear();

      const invalidThreshold = JSON.parse(JSON.stringify(baseConfig)) as GuardianConfig;
      invalidThreshold.motion.diffThreshold = -5;

      fs.writeFileSync(configPath, JSON.stringify(invalidThreshold, null, 2));

      await waitFor(() =>
        logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed')
      );
      await waitFor(() =>
        logger.info.mock.calls.some(([, message]) => message === 'Configuration rollback applied')
      );

      const thresholdWarn = logger.warn.mock.calls.find(([, message]) => message === 'configuration reload failed');
      expect(thresholdWarn?.[0]?.err).toBeInstanceOf(Error);
      const thresholdMessage = thresholdWarn?.[0]?.err?.message ?? '';
      expect(thresholdMessage).toContain('config.motion.diffThreshold must be >= 0');

      await waitFor(() => fs.readFileSync(configPath, 'utf-8') === originalRaw);
      expect(manager.getConfig().motion.diffThreshold).toBe(baseConfig.motion.diffThreshold);
      expect(MockVideoSource.instances.length).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 250));
    } finally {
      runtime.stop();
    }
  });

  it('ConfigHotReloadPipelineUpdates logs motion warmup adjustments without restart', async () => {
    const baseConfig = createConfig({ diffThreshold: 30 });
    baseConfig.video.channels = { 'video:cam-1': {} };
    baseConfig.motion.noiseWarmupFrames = 0;
    baseConfig.motion.noiseBackoffPadding = 0;
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

    const manager = new ConfigManager(configPath);
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({ logger, configManager: manager });

    try {
      await waitFor(() => MockVideoSource.instances.length === 1);

      logger.info.mockClear();

      const updated = JSON.parse(JSON.stringify(baseConfig)) as GuardianConfig;
      updated.motion.noiseWarmupFrames = 4;
      updated.motion.noiseBackoffPadding = 2;

      fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));

      await waitFor(() =>
        logger.info.mock.calls.some(([, message]) => message === 'Updated guard pipeline configuration')
      );

      const updateCall = logger.info.mock.calls.find(([, message]) => message === 'Updated guard pipeline configuration');
      expect(updateCall?.[0]?.updates?.motion?.noiseWarmupFrames).toEqual({ previous: 0, next: 4 });
      expect(updateCall?.[0]?.updates?.motion?.noiseBackoffPadding).toEqual({ previous: 0, next: 2 });
    } finally {
      runtime.stop();
    }
  });

  it('ConfigHotReloadChannelOverrides logs layered diff summaries for overrides', async () => {
    const baseConfig = createConfig({ diffThreshold: 30 });
    baseConfig.video.channels = {
      'video:cam-1': {
        person: { score: 0.55 }
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

    const manager = new ConfigManager(configPath);
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runtime = await startGuard({ logger, configManager: manager });

    try {
      await waitFor(() => MockVideoSource.instances.length === 1);

      logger.info.mockClear();

      const updatedConfig = JSON.parse(JSON.stringify(baseConfig)) as GuardianConfig;
      updatedConfig.video.channels = {
        'video:cam-1': {
          person: { score: 0.6, maxDetections: 3 },
          motion: { diffThreshold: 42 },
          pose: { minMovement: 0.2 }
        },
        'video:cam-2': {
          person: { score: 0.5 },
          ffmpeg: { restartDelayMs: 750 }
        }
      };
      if (updatedConfig.video.cameras) {
        updatedConfig.video.cameras[0].person = { score: 0.45 } as CameraConfig['person'];
        updatedConfig.video.cameras[0].input = 'rtsp://cam-1-updated';
        updatedConfig.video.cameras.push({
          id: 'cam-2',
          channel: 'video:cam-2',
          input: 'rtsp://cam-2',
          person: { score: 0.35 }
        });
      }

      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

      await waitFor(
        () => logger.info.mock.calls.some(([, message]) => message === 'configuration overrides diff'),
        8000
      );

      expect(
        logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed')
      ).toBe(false);

      const diffCall = logger.info.mock.calls.find(([, message]) => message === 'configuration overrides diff');
      expect(diffCall).toBeTruthy();

      const diffMeta = diffCall?.[0] as Record<string, any>;
      expect(diffMeta.channels?.added?.['video:cam-2']).toMatchObject({
        person: { score: 0.5 },
        ffmpeg: { restartDelayMs: 750 }
      });
      expect(diffMeta.channels?.changed?.['video:cam-1']).toMatchObject({
        next: expect.objectContaining({
          motion: expect.objectContaining({ diffThreshold: 42 }),
          pose: expect.objectContaining({ minMovement: 0.2 }),
          person: expect.objectContaining({ score: 0.6, maxDetections: 3 })
        })
      });

      expect(diffMeta.cameras?.added?.['cam-2']).toMatchObject({
        channel: 'video:cam-2',
        input: 'rtsp://cam-2',
        person: { score: 0.35 }
      });
      expect(diffMeta.cameras?.changed?.['cam-1']).toMatchObject({
        previous: expect.objectContaining({
          person: expect.objectContaining({ score: 0.5 })
        }),
        next: expect.objectContaining({
          input: 'rtsp://cam-1-updated',
          person: expect.objectContaining({ score: 0.45 })
        })
      });

      expect(
        logger.info.mock.calls.some(([, message]) => message === 'configuration reloaded')
      ).toBe(true);
    } finally {
      runtime.stop();
    }
  }, 10000);

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

  it('ConfigAudioChannelCollision rejects reloads when audio channel conflicts with video definitions', async () => {
    const baseConfig = createConfig({ diffThreshold: 24 });
    baseConfig.video.channels = {
      'video:lobby': {}
    };
    if (baseConfig.video.cameras) {
      baseConfig.video.cameras[0].channel = 'video:lobby';
    }
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

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
      await waitFor(() => MockVideoSource.instances.length === 1);

      const conflicting = JSON.parse(JSON.stringify(baseConfig)) as GuardianConfig;
      conflicting.audio = { channel: 'video:lobby' };

      fs.writeFileSync(configPath, JSON.stringify(conflicting, null, 2));

      await waitFor(
        () => logger.warn.mock.calls.some(([, message]) => message === 'configuration reload failed'),
        4000
      );
      await waitFor(
        () => logger.info.mock.calls.some(([, message]) => message === 'Configuration rollback applied'),
        4000
      );

      const warnCall = logger.warn.mock.calls.find(([, message]) => message === 'configuration reload failed');
      expect(warnCall?.[0]?.err).toBeInstanceOf(Error);
      expect(warnCall?.[0]?.err?.message ?? '').toContain(
        'config.audio.channel "video:lobby" conflicts with video channel definition "video:lobby"'
      );

      const restored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as GuardianConfig;
      expect(restored.audio).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it('ConfigAudioChannelConflict rejects case-insensitive audio channel collisions', () => {
    const config = createConfig({ diffThreshold: 20 });
    config.video.channels = { 'video:lobby': {} };
    if (config.video.cameras) {
      config.video.cameras[0].channel = 'video:lobby';
    }
    config.audio = { channel: 'VIDEO:LOBBY' } as GuardianConfig['audio'];

    const candidate = JSON.parse(JSON.stringify(config)) as GuardianConfig;

    expect(() => validateConfig(candidate)).toThrowErrorMatchingInlineSnapshot(
      "[Error: config.audio.channel \"VIDEO:LOBBY\" conflicts with video channel definition \"video:lobby\"; config.audio.channel \"VIDEO:LOBBY\" conflicts with camera \"cam-1\" channel]"
    );
  });

  it('ConfigSuppressionMaxEventsRequiresWindow enforces suppressForMs when maxEvents is set', () => {
    const config = createConfig({
      diffThreshold: 20,
      suppressionRules: [
        {
          id: 'burst-limit',
          detector: 'motion',
          source: 'video:cam-1',
          maxEvents: 3,
          reason: 'burst protection'
        }
      ]
    });

    const candidate = JSON.parse(JSON.stringify(config)) as GuardianConfig;

    expect(() => validateConfig(candidate)).toThrowErrorMatchingInlineSnapshot(
      "[Error: config.events.suppression.rules[0].suppressForMs must be set when maxEvents is defined]"
    );
  });

  it('AudioHotReloadThresholds refreshes audio fallbacks and anomaly windows', async () => {
    const initialConfig = createConfig({ diffThreshold: 20 });
    initialConfig.audio = {
      channel: 'audio:test',
      idleTimeoutMs: 800,
      micFallbacks: {
        linux: [{ device: 'hw:0,0' }]
      },
      anomaly: {
        sampleRate: 16000,
        rmsThreshold: 0.3,
        centroidJumpThreshold: 180,
        minIntervalMs: 400,
        minTriggerDurationMs: 180,
        rmsWindowMs: 240,
        centroidWindowMs: 260,
        thresholds: {
          day: { rms: 0.3, centroidJump: 200 }
        }
      }
    };

    const manager = new InMemoryConfigManager(initialConfig);
    const { startGuard } = await import('../src/run-guard.ts');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const anomalySpy = vi.spyOn(AudioAnomalyDetector.prototype, 'updateOptions');

    const runtime = await startGuard({
      bus: new EventEmitter(),
      logger,
      configManager: manager as unknown as ConfigManager
    });

    try {
      expect(MockAudioSource.instances).toHaveLength(1);
      const audioSource = MockAudioSource.instances[0];
      expect(audioSource.start).toHaveBeenCalledTimes(1);
      expect(audioSource.options.channel).toBe('audio:test');

      (audioSource.updateOptions as vi.Mock).mockClear();
      anomalySpy.mockClear();

      const updatedConfig = JSON.parse(JSON.stringify(initialConfig)) as GuardianConfig;
      updatedConfig.audio = {
        channel: 'audio:test',
        idleTimeoutMs: 1500,
        micFallbacks: {
          linux: [
            { device: 'hw:1,0' },
            { device: 'hw:2,0' }
          ]
        },
        anomaly: {
          sampleRate: 22050,
          rmsThreshold: 0.18,
          centroidJumpThreshold: 140,
          minIntervalMs: 420,
          minTriggerDurationMs: 320,
          rmsWindowMs: 480,
          centroidWindowMs: 520,
          thresholds: {
            day: { rms: 0.18, centroidJump: 150 },
            night: { rms: 0.12, centroidJump: 120, rmsWindowMs: 520 }
          }
        }
      };

      manager.setConfig(updatedConfig);

      await waitFor(() => logger.info.mock.calls.some(([, message]) => message === 'configuration reloaded'));

      const updateCalls = (audioSource.updateOptions as vi.Mock).mock.calls;
      expect(updateCalls.length).toBeGreaterThan(0);
      const latestUpdate = updateCalls[updateCalls.length - 1]?.[0] as Record<string, any>;
      expect(latestUpdate?.micFallbacks?.linux).toHaveLength(2);
      expect(latestUpdate?.idleTimeoutMs).toBe(1500);

      expect(anomalySpy).toHaveBeenCalled();
      const anomalyArgs = anomalySpy.mock.calls[anomalySpy.mock.calls.length - 1]?.[0] as Record<string, any>;
      expect(anomalyArgs?.rmsWindowMs).toBe(480);
      expect(anomalyArgs?.centroidWindowMs).toBe(520);
      expect(anomalyArgs?.thresholds).toMatchObject({
        day: { rms: 0.18, centroidJump: 150 },
        night: { rms: 0.12, centroidJump: 120, rmsWindowMs: 520 }
      });
    } finally {
      anomalySpy.mockRestore();
      runtime.stop();
    }
  });
});

type MotionOverrides =
  | undefined
  | ({
      areaThreshold?: number;
      minIntervalMs?: number;
    } & MotionTuningConfig);

function createConfig(overrides: {
  diffThreshold: number;
  suppressionRules?: Record<string, unknown>[];
  cameras?: CameraConfig[];
  motionOverrides?: MotionOverrides;
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
      areaThreshold: overrides.motionOverrides?.areaThreshold ?? 0.02,
      minIntervalMs: overrides.motionOverrides?.minIntervalMs ?? 1500,
      debounceFrames: overrides.motionOverrides?.debounceFrames,
      backoffFrames: overrides.motionOverrides?.backoffFrames,
      noiseMultiplier: overrides.motionOverrides?.noiseMultiplier,
      noiseSmoothing: overrides.motionOverrides?.noiseSmoothing,
      areaSmoothing: overrides.motionOverrides?.areaSmoothing,
      areaInflation: overrides.motionOverrides?.areaInflation,
      areaDeltaThreshold: overrides.motionOverrides?.areaDeltaThreshold
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
