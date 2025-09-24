import { EventEmitter } from 'node:events';
import path from 'node:path';
import loggerModule from './logger.js';
import defaultBus, { EventBus } from './eventBus.js';
import configManager, {
  CameraConfig,
  ConfigManager,
  ConfigReloadEvent,
  GuardianConfig,
  MotionConfig,
  PersonConfig,
  VideoConfig,
  EventsConfig,
  CameraFfmpegConfig,
  CameraMotionConfig,
  RetentionConfig
} from './config/index.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import MotionDetector from './video/motionDetector.js';
import PersonDetector from './video/personDetector.js';
import { RetentionTask, startRetentionTask } from './tasks/retention.js';

type CameraRuntime = {
  id: string;
  channel: string;
  source: VideoSource;
  motionDetector: MotionDetector;
  personDetector: PersonDetector;
  framesSinceMotion: number | null;
  detectionAttempts: number;
  checkEvery: number;
  maxDetections: number;
};

type GuardConfig = {
  video: VideoConfig;
  person: PersonConfig;
  motion?: MotionConfig;
  events?: EventsConfig;
};

type GuardLogger = Pick<typeof loggerModule, 'info' | 'warn' | 'error'>;

export interface GuardStartOptions {
  config?: GuardConfig;
  bus?: EventEmitter;
  logger?: GuardLogger;
  configManager?: ConfigManager;
}

export type GuardRuntime = {
  stop: () => void;
  pipelines: Map<string, CameraRuntime>;
  retention?: RetentionTask | null;
};

const DEFAULT_CHECK_EVERY = 3;
const DEFAULT_MAX_DETECTIONS = 5;

export async function startGuard(options: GuardStartOptions = {}): Promise<GuardRuntime> {
  const bus = options.bus ?? defaultBus;
  const logger = options.logger ?? loggerModule;
  const manager = options.configManager ?? configManager;
  const injectedConfig = options.config;
  const baseConfig = injectedConfig
    ? mergeGuardConfig(injectedConfig, manager.getConfig())
    : pickGuardConfig(manager.getConfig());

  let activeConfig = baseConfig;
  const videoConfig = activeConfig.video;
  const personConfig = activeConfig.person;
  const motionConfig = activeConfig.motion;
  const eventsConfig = activeConfig.events;
  if (!motionConfig) {
    throw new Error('Motion configuration is required');
  }

  if (bus instanceof EventBus) {
    const suppressionRules = eventsConfig?.suppression?.rules ?? [];
    bus.configureSuppression(suppressionRules);
  }

  const cameras = buildCameraList(videoConfig);

  if (cameras.length === 0) {
    throw new Error('No cameras configured');
  }

  const pipelines = new Map<string, CameraRuntime>();
  let stopWatching: (() => void) | null = null;
  let retentionTask: RetentionTask | null = null;

  const configureRetention = (config: GuardConfig) => {
    const retentionOptions = buildRetentionOptions({
      retention: config.events?.retention,
      video: config.video,
      person: config.person,
      logger
    });

    if (!retentionOptions) {
      if (retentionTask) {
        retentionTask.stop();
        retentionTask = null;
      }
      return;
    }

    if (!retentionTask) {
      retentionTask = startRetentionTask(retentionOptions);
    } else {
      retentionTask.configure(retentionOptions);
    }
  };

  configureRetention(activeConfig);

  const handleReload = ({ next }: ConfigReloadEvent) => {
    activeConfig = pickGuardConfig(next);
    for (const runtime of pipelines.values()) {
      const cameraConfig = findCameraConfig(activeConfig.video, runtime.id);
      const resolvedMotion = resolveCameraMotion(cameraConfig?.motion, activeConfig.motion);
      runtime.motionDetector.updateOptions({
        diffThreshold: resolvedMotion.diffThreshold,
        areaThreshold: resolvedMotion.areaThreshold,
        minIntervalMs: resolvedMotion.minIntervalMs
      });
    }

    if (bus instanceof EventBus) {
      const suppressionRules = activeConfig.events?.suppression?.rules ?? [];
      bus.configureSuppression(suppressionRules);
    }

    configureRetention(activeConfig);

    logger.info(
      {
        diffThreshold: activeConfig.motion?.diffThreshold,
        areaThreshold: activeConfig.motion?.areaThreshold,
        minIntervalMs: activeConfig.motion?.minIntervalMs,
        suppressionRules: activeConfig.events?.suppression?.rules?.length ?? 0
      },
      'configuration reloaded'
    );
  };

  if (!injectedConfig) {
    stopWatching = manager.watch();
    manager.on('reload', handleReload);
  }

  const eventHandler = (payload: { detector?: string; source?: string }) => {
    if (payload.detector !== 'motion' || !payload.source) {
      return;
    }

    const runtime = pipelines.get(payload.source);
    if (!runtime) {
      return;
    }

    runtime.framesSinceMotion = 0;
    runtime.detectionAttempts = 0;
  };

  bus.on('event', eventHandler);

  for (const camera of cameras) {
    const channel = camera.channel ?? `video:${camera.id}`;
    const input = resolveCameraInput(camera, videoConfig);
    const fps = camera.framesPerSecond ?? videoConfig.framesPerSecond;

    const cameraFfmpeg = resolveCameraFfmpeg(camera.ffmpeg, videoConfig.ffmpeg);

    const source = new VideoSource({
      file: input,
      framesPerSecond: fps,
      rtspTransport: cameraFfmpeg.rtspTransport,
      inputArgs: cameraFfmpeg.inputArgs,
      startTimeoutMs: cameraFfmpeg.startTimeoutMs,
      watchdogTimeoutMs: cameraFfmpeg.watchdogTimeoutMs,
      forceKillTimeoutMs: cameraFfmpeg.forceKillTimeoutMs,
      restartDelayMs: cameraFfmpeg.restartDelayMs,
      restartMaxDelayMs: cameraFfmpeg.restartMaxDelayMs,
      restartJitterFactor: cameraFfmpeg.restartJitterFactor
    });

    const motionOverrides = resolveCameraMotion(camera.motion, motionConfig);

    const motionDetector = new MotionDetector({
      source: channel,
      diffThreshold: motionOverrides.diffThreshold,
      areaThreshold: motionOverrides.areaThreshold,
      minIntervalMs: motionOverrides.minIntervalMs
    });

    const detector = await PersonDetector.create({
      source: channel,
      modelPath: personConfig.modelPath,
      scoreThreshold: camera.person?.score ?? personConfig.score,
      snapshotDir: camera.person?.snapshotDir ?? personConfig.snapshotDir,
      minIntervalMs: camera.person?.minIntervalMs ?? personConfig.minIntervalMs ?? 2000
    });

    const checkEvery = Math.max(
      1,
      camera.person?.checkEveryNFrames ?? personConfig.checkEveryNFrames ?? DEFAULT_CHECK_EVERY
    );

    const maxDetections = Math.max(
      1,
      camera.person?.maxDetections ?? personConfig.maxDetections ?? DEFAULT_MAX_DETECTIONS
    );

    const runtime: CameraRuntime = {
      id: camera.id,
      channel,
      source,
      motionDetector,
      personDetector: detector,
      framesSinceMotion: null,
      detectionAttempts: 0,
      checkEvery,
      maxDetections
    };

    pipelines.set(channel, runtime);

    setupSourceHandlers(logger, runtime);

    source.start();

    logger.info({ camera: camera.id, input, channel }, 'Starting guard pipeline');
  }

  const stop = () => {
    bus.off('event', eventHandler);
    if (!injectedConfig) {
      manager.off('reload', handleReload);
      stopWatching?.();
    }
    for (const runtime of pipelines.values()) {
      runtime.source.stop();
    }
    pipelines.clear();
    retentionTask?.stop();
  };

  return { stop, pipelines, retention: retentionTask };
}

function buildCameraList(videoConfig: VideoConfig) {
  if (Array.isArray(videoConfig.cameras) && videoConfig.cameras.length > 0) {
    return videoConfig.cameras;
  }

  if (videoConfig.testFile) {
    return [
      {
        id: 'default',
        channel: 'video:default',
        input: videoConfig.testFile
      }
    ];
  }

  return [];
}

function resolveCameraInput(camera: CameraConfig, videoConfig: VideoConfig) {
  const input = camera.input ?? videoConfig.testFile;

  if (!input) {
    throw new Error(`Camera "${camera.id}" is missing an input`);
  }

  if (hasScheme(input)) {
    return input;
  }

  return ensureSampleVideo(input);
}

function resolveCameraFfmpeg(
  camera: CameraFfmpegConfig | undefined,
  defaults: CameraFfmpegConfig | undefined
): CameraFfmpegConfig {
  return {
    inputArgs: camera?.inputArgs ?? defaults?.inputArgs,
    rtspTransport: camera?.rtspTransport ?? defaults?.rtspTransport,
    startTimeoutMs: camera?.startTimeoutMs ?? defaults?.startTimeoutMs,
    watchdogTimeoutMs: camera?.watchdogTimeoutMs ?? defaults?.watchdogTimeoutMs,
    forceKillTimeoutMs: camera?.forceKillTimeoutMs ?? defaults?.forceKillTimeoutMs,
    restartDelayMs: camera?.restartDelayMs ?? defaults?.restartDelayMs,
    restartMaxDelayMs: camera?.restartMaxDelayMs ?? defaults?.restartMaxDelayMs,
    restartJitterFactor: camera?.restartJitterFactor ?? defaults?.restartJitterFactor
  };
}

function resolveCameraMotion(
  cameraMotion: CameraMotionConfig | undefined,
  defaults: MotionConfig
): Pick<MotionConfig, 'diffThreshold' | 'areaThreshold' | 'minIntervalMs'> {
  return {
    diffThreshold: cameraMotion?.diffThreshold ?? defaults.diffThreshold,
    areaThreshold: cameraMotion?.areaThreshold ?? defaults.areaThreshold,
    minIntervalMs: cameraMotion?.minIntervalMs ?? defaults.minIntervalMs
  };
}

function findCameraConfig(videoConfig: VideoConfig, id: string): CameraConfig | undefined {
  return videoConfig.cameras?.find(camera => camera.id === id);
}

function pickGuardConfig(config: GuardianConfig): GuardConfig {
  return {
    video: config.video,
    person: config.person,
    motion: config.motion,
    events: config.events
  };
}

function mergeGuardConfig(injected: GuardConfig, fallback: GuardianConfig): GuardConfig {
  return {
    video: injected.video,
    person: injected.person,
    motion: injected.motion ?? fallback.motion,
    events: injected.events ?? fallback.events
  };
}

function hasScheme(input: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input);
}

function buildRetentionOptions(options: {
  retention?: RetentionConfig;
  video: VideoConfig;
  person: PersonConfig;
  logger: GuardLogger;
}) {
  const retention = options.retention;
  if (!retention) {
    return null;
  }

  const snapshotDirs = collectSnapshotDirectories(options.video, options.person);
  const archiveDir = retention.archiveDir ?? path.join(process.cwd(), 'archive');
  const intervalMinutes = retention.intervalMinutes ?? 60;

  return {
    enabled: retention.enabled !== false,
    retentionDays: retention.retentionDays,
    intervalMs: intervalMinutes * 60 * 1000,
    archiveDir,
    snapshotDirs,
    vacuumMode: retention.vacuum ?? 'auto',
    logger: options.logger
  } as const;
}

function collectSnapshotDirectories(video: VideoConfig, person: PersonConfig): string[] {
  const directories = new Set<string>();
  if (person.snapshotDir) {
    directories.add(path.resolve(person.snapshotDir));
  }

  for (const camera of video.cameras ?? []) {
    const snapshotDir = camera.person?.snapshotDir;
    if (snapshotDir) {
      directories.add(path.resolve(snapshotDir));
    }
  }

  return [...directories];
}

function setupSourceHandlers(logger: GuardLogger, runtime: CameraRuntime) {
  const { source, motionDetector, personDetector } = runtime;

  source.on('frame', async frame => {
    const ts = Date.now();

    try {
      motionDetector.handleFrame(frame, ts);
    } catch (error) {
      logger.error({ err: error, camera: runtime.id }, 'Motion detector failed');
    }

    if (runtime.framesSinceMotion !== null) {
      runtime.framesSinceMotion += 1;
      const shouldDetect =
        runtime.framesSinceMotion === 1 || runtime.framesSinceMotion % runtime.checkEvery === 0;

      if (shouldDetect && runtime.detectionAttempts < runtime.maxDetections) {
        runtime.detectionAttempts += 1;
        try {
          await personDetector.handleFrame(frame, ts);
        } catch (error) {
          logger.error({ err: error, camera: runtime.id }, 'Person detector failed');
        }
      }

      if (runtime.detectionAttempts >= runtime.maxDetections) {
        runtime.framesSinceMotion = null;
      }
    }
  });

  source.on('error', error => {
    logger.error({ err: error, camera: runtime.id }, 'Video source error');
  });

  source.on('recover', event => {
    logger.warn(
      { camera: runtime.id, attempt: event.attempt, reason: event.reason, delayMs: event.delayMs },
      `Video source reconnecting (reason=${event.reason})`
    );
  });

  source.on('end', () => {
    logger.warn({ camera: runtime.id }, 'Video source ended');
  });
}

if (
  (process.env.NODE_ENV !== 'test' || process.env.GUARDIAN_FORCE_GUARD === '1') &&
  process.env.GUARDIAN_DISABLE_AUTO_START !== '1'
) {
  const runtimePromise = startGuard().catch(error => {
    loggerModule.error({ err: error }, 'Failed to start guard pipeline');
    process.exitCode = 1;
    return null;
  });

  process.on('SIGINT', () => {
    loggerModule.info('Stopping guard pipeline');
    runtimePromise
      .then(runtime => {
        runtime?.stop();
      })
      .finally(() => {
        process.exit(0);
      });
  });
}
