import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { ConfigManager, loadConfigFromFile } from '../src/config/index.js';
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
