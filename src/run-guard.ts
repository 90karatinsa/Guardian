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

type CameraPipelineState = {
  channel: string;
  input: string;
  framesPerSecond: number;
  ffmpeg: CameraFfmpegConfig;
  person: {
    score: number;
    snapshotDir?: string;
    minIntervalMs?: number;
  };
};

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
  pipelineState: CameraPipelineState;
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
  const eventsConfig = activeConfig.events;
  if (!activeConfig.motion) {
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
  const pipelinesById = new Map<string, CameraRuntime>();
  let stopWatching: (() => void) | null = null;
  let retentionTask: RetentionTask | null = null;
  let syncPromise: Promise<void> = Promise.resolve();

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

  const createPipeline = async (camera: CameraConfig, config: GuardConfig) => {
    const context = buildCameraContext(camera, config);

    const source = new VideoSource({
      file: context.pipelineState.input,
      framesPerSecond: context.pipelineState.framesPerSecond,
      channel: context.pipelineState.channel,
      rtspTransport: context.pipelineState.ffmpeg.rtspTransport,
      inputArgs: context.pipelineState.ffmpeg.inputArgs,
      idleTimeoutMs: context.pipelineState.ffmpeg.idleTimeoutMs,
      startTimeoutMs: context.pipelineState.ffmpeg.startTimeoutMs,
      watchdogTimeoutMs: context.pipelineState.ffmpeg.watchdogTimeoutMs,
      forceKillTimeoutMs: context.pipelineState.ffmpeg.forceKillTimeoutMs,
      restartDelayMs: context.pipelineState.ffmpeg.restartDelayMs,
      restartMaxDelayMs: context.pipelineState.ffmpeg.restartMaxDelayMs,
      restartJitterFactor: context.pipelineState.ffmpeg.restartJitterFactor
    });

    const motionDetector = new MotionDetector({
      source: context.pipelineState.channel,
      diffThreshold: context.motion.diffThreshold,
      areaThreshold: context.motion.areaThreshold,
      minIntervalMs: context.motion.minIntervalMs,
      debounceFrames: context.motion.debounceFrames,
      backoffFrames: context.motion.backoffFrames,
      noiseMultiplier: context.motion.noiseMultiplier,
      noiseSmoothing: context.motion.noiseSmoothing,
      areaSmoothing: context.motion.areaSmoothing,
      areaInflation: context.motion.areaInflation,
      areaDeltaThreshold: context.motion.areaDeltaThreshold
    });

    const personDetector = await PersonDetector.create({
      source: context.pipelineState.channel,
      modelPath: config.person.modelPath,
      scoreThreshold: context.pipelineState.person.score,
      snapshotDir: context.pipelineState.person.snapshotDir,
      minIntervalMs:
        context.pipelineState.person.minIntervalMs ?? config.person.minIntervalMs ?? 2000
    });

    const runtime: CameraRuntime = {
      id: camera.id,
      channel: context.pipelineState.channel,
      source,
      motionDetector,
      personDetector,
      framesSinceMotion: null,
      detectionAttempts: 0,
      checkEvery: context.checkEvery,
      maxDetections: context.maxDetections,
      pipelineState: context.pipelineState
    };

    pipelines.set(context.pipelineState.channel, runtime);
    pipelinesById.set(camera.id, runtime);

    setupSourceHandlers(logger, runtime);
    source.start();

    logger.info(
      { camera: camera.id, input: context.pipelineState.input, channel: context.pipelineState.channel },
      'Starting guard pipeline'
    );

    return runtime;
  };

  const syncPipelines = async (config: GuardConfig) => {
    const camerasForConfig = buildCameraList(config.video);
    const desiredIds = new Set(camerasForConfig.map(camera => camera.id));

    for (const runtime of [...pipelinesById.values()]) {
      if (!desiredIds.has(runtime.id)) {
        pipelines.delete(runtime.channel);
        pipelinesById.delete(runtime.id);
        runtime.source.stop();
        logger.info({ camera: runtime.id }, 'Stopping guard pipeline');
      }
    }

    for (const camera of camerasForConfig) {
      const existing = pipelinesById.get(camera.id);
      const context = buildCameraContext(camera, config);

      if (!existing) {
        await createPipeline(camera, config);
        continue;
      }

      if (needsPipelineRestart(existing.pipelineState, context.pipelineState)) {
        pipelines.delete(existing.channel);
        pipelinesById.delete(existing.id);
        existing.source.stop();
        logger.info({ camera: existing.id }, 'Restarting guard pipeline');
        await createPipeline(camera, config);
        continue;
      }

      existing.pipelineState = context.pipelineState;
      existing.checkEvery = context.checkEvery;
      existing.maxDetections = context.maxDetections;
      existing.motionDetector.updateOptions({
        diffThreshold: context.motion.diffThreshold,
        areaThreshold: context.motion.areaThreshold,
        minIntervalMs: context.motion.minIntervalMs
      });
    }
  };

  const runSync = (config: GuardConfig) => {
    syncPromise = syncPromise
      .then(() => syncPipelines(config))
      .catch(error => {
        logger.error({ err: error }, 'Failed to apply camera configuration');
      });

    return syncPromise;
  };

  const handleReload = ({ next }: ConfigReloadEvent) => {
    activeConfig = pickGuardConfig(next);
    runSync(activeConfig);

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

  await runSync(activeConfig);

  const stop = () => {
    bus.off('event', eventHandler);
    if (!injectedConfig) {
      manager.off('reload', handleReload);
      stopWatching?.();
    }
    for (const runtime of pipelinesById.values()) {
      runtime.source.stop();
    }
    pipelines.clear();
    pipelinesById.clear();
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
    idleTimeoutMs: camera?.idleTimeoutMs ?? defaults?.idleTimeoutMs,
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
): MotionConfig {
  return {
    diffThreshold: cameraMotion?.diffThreshold ?? defaults.diffThreshold,
    areaThreshold: cameraMotion?.areaThreshold ?? defaults.areaThreshold,
    minIntervalMs: cameraMotion?.minIntervalMs ?? defaults.minIntervalMs,
    debounceFrames: cameraMotion?.debounceFrames ?? defaults.debounceFrames,
    backoffFrames: cameraMotion?.backoffFrames ?? defaults.backoffFrames,
    noiseMultiplier: cameraMotion?.noiseMultiplier ?? defaults.noiseMultiplier,
    noiseSmoothing: cameraMotion?.noiseSmoothing ?? defaults.noiseSmoothing,
    areaSmoothing: cameraMotion?.areaSmoothing ?? defaults.areaSmoothing,
    areaInflation: cameraMotion?.areaInflation ?? defaults.areaInflation,
    areaDeltaThreshold: cameraMotion?.areaDeltaThreshold ?? defaults.areaDeltaThreshold
  };
}

function buildCameraContext(camera: CameraConfig, config: GuardConfig) {
  if (!config.motion) {
    throw new Error('Motion configuration is required');
  }

  const channel = camera.channel ?? `video:${camera.id}`;
  const input = resolveCameraInput(camera, config.video);
  const framesPerSecond = camera.framesPerSecond ?? config.video.framesPerSecond;
  const ffmpeg = resolveCameraFfmpeg(camera.ffmpeg, config.video.ffmpeg);
  const minIntervalMs = camera.person?.minIntervalMs ?? config.person.minIntervalMs ?? 2000;

  const pipelineState: CameraPipelineState = {
    channel,
    input,
    framesPerSecond,
    ffmpeg,
    person: {
      score: camera.person?.score ?? config.person.score,
      snapshotDir: camera.person?.snapshotDir ?? config.person.snapshotDir,
      minIntervalMs
    }
  };

  const motion = resolveCameraMotion(camera.motion, config.motion);

  const checkEvery = Math.max(
    1,
    camera.person?.checkEveryNFrames ?? config.person.checkEveryNFrames ?? DEFAULT_CHECK_EVERY
  );

  const maxDetections = Math.max(
    1,
    camera.person?.maxDetections ?? config.person.maxDetections ?? DEFAULT_MAX_DETECTIONS
  );

  return { pipelineState, motion, checkEvery, maxDetections } as const;
}

function needsPipelineRestart(previous: CameraPipelineState, next: CameraPipelineState) {
  if (previous.channel !== next.channel) {
    return true;
  }

  if (previous.input !== next.input) {
    return true;
  }

  if (previous.framesPerSecond !== next.framesPerSecond) {
    return true;
  }

  if (!ffmpegOptionsEqual(previous.ffmpeg, next.ffmpeg)) {
    return true;
  }

  if (previous.person.score !== next.person.score) {
    return true;
  }

  if (previous.person.snapshotDir !== next.person.snapshotDir) {
    return true;
  }

  if (previous.person.minIntervalMs !== next.person.minIntervalMs) {
    return true;
  }

  return false;
}

function ffmpegOptionsEqual(a: CameraFfmpegConfig, b: CameraFfmpegConfig) {
  return (
    arrayEqual(a.inputArgs, b.inputArgs) &&
    a.rtspTransport === b.rtspTransport &&
    a.idleTimeoutMs === b.idleTimeoutMs &&
    a.startTimeoutMs === b.startTimeoutMs &&
    a.watchdogTimeoutMs === b.watchdogTimeoutMs &&
    a.forceKillTimeoutMs === b.forceKillTimeoutMs &&
    a.restartDelayMs === b.restartDelayMs &&
    a.restartMaxDelayMs === b.restartMaxDelayMs &&
    a.restartJitterFactor === b.restartJitterFactor
  );
}

function arrayEqual<T>(a: T[] | undefined, b: T[] | undefined) {
  if (!a && !b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => value === b[index]);
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
