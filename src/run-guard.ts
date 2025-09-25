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
  VideoChannelConfig,
  RetentionConfig,
  PoseConfig,
  FaceConfig,
  ObjectsConfig
} from './config/index.js';
import PoseEstimator from './video/poseEstimator.js';
import ObjectClassifier from './video/objectClassifier.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import MotionDetector from './video/motionDetector.js';
import PersonDetector from './video/personDetector.js';
import { RetentionTask, RetentionTaskOptions, startRetentionTask } from './tasks/retention.js';

type CameraPipelineState = {
  channel: string;
  input: string;
  framesPerSecond: number;
  ffmpeg: CameraFfmpegConfig;
  person: {
    score: number;
    snapshotDir?: string;
    minIntervalMs?: number;
    classIndices?: number[];
  };
  pose?: PoseConfig;
  objects?: ObjectsConfig;
};

type CameraRestartEvent = {
  reason: string;
  attempt: number;
  delayMs: number;
  at: number;
};

type CameraRestartStats = {
  total: number;
  byReason: Map<string, number>;
  last: CameraRestartEvent | null;
  history: CameraRestartEvent[];
};

type CameraRuntime = {
  id: string;
  channel: string;
  source: VideoSource;
  motionDetector: MotionDetector;
  personDetector: PersonDetector;
  poseEstimator?: PoseEstimator | null;
  objectClassifier?: ObjectClassifier | null;
  framesSinceMotion: number | null;
  detectionAttempts: number;
  checkEvery: number;
  maxDetections: number;
  pipelineState: CameraPipelineState;
  restartStats: CameraRestartStats;
  cleanup: Array<() => void>;
};

type GuardConfig = {
  video: VideoConfig;
  person: PersonConfig;
  motion?: MotionConfig;
  events?: EventsConfig;
  pose?: PoseConfig;
  face?: FaceConfig;
  objects?: ObjectsConfig;
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
  let handleConfigError: ((error: unknown) => void) | null = null;

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

    const objectClassifier = context.pipelineState.objects
      ? await ObjectClassifier.create({
          modelPath: context.pipelineState.objects.modelPath,
          labels: context.pipelineState.objects.labels,
          threatLabels: context.pipelineState.objects.threatLabels,
          threatThreshold: context.pipelineState.objects.threatThreshold
        })
      : null;

    const personDetector = await PersonDetector.create(
      {
        source: context.pipelineState.channel,
        modelPath: config.person.modelPath,
        scoreThreshold: context.pipelineState.person.score,
        snapshotDir: context.pipelineState.person.snapshotDir,
        minIntervalMs:
          context.pipelineState.person.minIntervalMs ?? config.person.minIntervalMs ?? 2000,
        classIndices: context.pipelineState.person.classIndices,
        objectClassifier: objectClassifier ?? undefined
      },
      bus
    );

    const poseEstimator = context.pipelineState.pose
      ? await PoseEstimator.create({
          source: context.pipelineState.channel,
          modelPath: context.pipelineState.pose.modelPath,
          forecastHorizonMs: context.pipelineState.pose.forecastHorizonMs,
          smoothingWindow: context.pipelineState.pose.smoothingWindow,
          minMovement: context.pipelineState.pose.minMovement,
          historySize: context.pipelineState.pose.historySize,
          bus
        })
      : null;

    const cleanup: Array<() => void> = [];

    const runtime: CameraRuntime = {
      id: camera.id,
      channel: context.pipelineState.channel,
      source,
      motionDetector,
      personDetector,
      poseEstimator,
      objectClassifier,
      framesSinceMotion: null,
      detectionAttempts: 0,
      checkEvery: context.checkEvery,
      maxDetections: context.maxDetections,
      pipelineState: context.pipelineState,
      restartStats: {
        total: 0,
        byReason: new Map(),
        last: null,
        history: []
      },
      cleanup
    };

    if (poseEstimator) {
      const motionListener = async (payload: { detector?: string; source?: string; meta?: Record<string, unknown>; ts?: number }) => {
        if (payload.detector !== 'motion' || payload.source !== runtime.channel) {
          return;
        }

        try {
          await poseEstimator.forecast(payload.meta, typeof payload.ts === 'number' ? payload.ts : Date.now());
          payload.meta = poseEstimator.mergeIntoMotionMeta(payload.meta);
        } catch (error) {
          logger.warn({ err: error, camera: runtime.id }, 'Pose forecast failed');
        }
      };

      bus.on('event', motionListener);
      cleanup.push(() => bus.off('event', motionListener));
    }

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
        runtime.cleanup.forEach(fn => {
          try {
            fn();
          } catch (error) {
            logger.warn({ err: error, camera: runtime.id }, 'Pipeline cleanup failed');
          }
        });
        runtime.cleanup.length = 0;
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
        existing.cleanup.forEach(fn => {
          try {
            fn();
          } catch (error) {
            logger.warn({ err: error, camera: existing.id }, 'Pipeline cleanup failed');
          }
        });
        existing.cleanup.length = 0;
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
    handleConfigError = error => {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn({ err }, 'configuration reload failed');
    };
    manager.on('error', handleConfigError);
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
      if (handleConfigError) {
        manager.off('error', handleConfigError);
      }
      stopWatching?.();
    }
    for (const runtime of pipelinesById.values()) {
      runtime.cleanup.forEach(fn => {
        try {
          fn();
        } catch (error) {
          logger.warn({ err: error, camera: runtime.id }, 'Pipeline cleanup failed');
        }
      });
      runtime.cleanup.length = 0;
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

function resolveVideoChannel(videoConfig: VideoConfig, channel: string): VideoChannelConfig | undefined {
  return videoConfig.channels?.[channel];
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
  const channelConfig = resolveVideoChannel(config.video, channel);
  const input = resolveCameraInput(camera, config.video);
  const framesPerSecond =
    camera.framesPerSecond ?? channelConfig?.framesPerSecond ?? config.video.framesPerSecond;
  const channelFfmpeg = resolveCameraFfmpeg(channelConfig?.ffmpeg, config.video.ffmpeg);
  const ffmpeg = resolveCameraFfmpeg(camera.ffmpeg, channelFfmpeg);
  const minIntervalMs =
    camera.person?.minIntervalMs ??
    channelConfig?.person?.minIntervalMs ??
    config.person.minIntervalMs ??
    2000;

  const pipelineState: CameraPipelineState = {
    channel,
    input,
    framesPerSecond,
    ffmpeg,
    person: {
      score: camera.person?.score ?? channelConfig?.person?.score ?? config.person.score,
      snapshotDir:
        camera.person?.snapshotDir ??
        channelConfig?.person?.snapshotDir ??
        config.person.snapshotDir,
      minIntervalMs,
      classIndices:
        camera.person?.classIndices ??
        channelConfig?.person?.classIndices ??
        config.person.classIndices
    },
    pose: config.pose,
    objects: config.objects
  };

  const motionDefaults = channelConfig?.motion
    ? resolveCameraMotion(channelConfig.motion, config.motion)
    : config.motion;
  const motion = resolveCameraMotion(camera.motion, motionDefaults);

  const checkEvery = Math.max(
    1,
    camera.person?.checkEveryNFrames ??
      channelConfig?.person?.checkEveryNFrames ??
      config.person.checkEveryNFrames ??
      DEFAULT_CHECK_EVERY
  );

  const maxDetections = Math.max(
    1,
    camera.person?.maxDetections ??
      channelConfig?.person?.maxDetections ??
      config.person.maxDetections ??
      DEFAULT_MAX_DETECTIONS
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

  if (!arrayEqual(previous.person.classIndices, next.person.classIndices)) {
    return true;
  }

  if (!poseConfigsEqual(previous.pose, next.pose)) {
    return true;
  }

  if (!objectConfigsEqual(previous.objects, next.objects)) {
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

function poseConfigsEqual(a?: PoseConfig, b?: PoseConfig) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.modelPath === b.modelPath &&
    a.forecastHorizonMs === b.forecastHorizonMs &&
    a.smoothingWindow === b.smoothingWindow &&
    a.minMovement === b.minMovement &&
    a.historySize === b.historySize
  );
}

function objectConfigsEqual(a?: ObjectsConfig, b?: ObjectsConfig) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  return (
    a.modelPath === b.modelPath &&
    a.threatThreshold === b.threatThreshold &&
    arrayEqual(a.labels, b.labels) &&
    arrayEqual(a.threatLabels, b.threatLabels) &&
    arrayEqual(a.classIndices, b.classIndices)
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
    events: config.events,
    pose: config.pose,
    face: config.face,
    objects: config.objects
  };
}

function mergeGuardConfig(injected: GuardConfig, fallback: GuardianConfig): GuardConfig {
  return {
    video: injected.video,
    person: injected.person,
    motion: injected.motion ?? fallback.motion,
    events: injected.events ?? fallback.events,
    pose: injected.pose ?? fallback.pose,
    face: injected.face ?? fallback.face,
    objects: injected.objects ?? fallback.objects
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
  const vacuum = retention.vacuum ?? 'auto';
  const snapshot = retention.snapshot;
  const maxArchives =
    typeof retention.maxArchivesPerCamera === 'number'
      ? retention.maxArchivesPerCamera
      : snapshot?.maxArchivesPerCamera;

  return {
    enabled: retention.enabled !== false,
    retentionDays: retention.retentionDays,
    intervalMs: intervalMinutes * 60 * 1000,
    archiveDir,
    snapshotDirs,
    maxArchivesPerCamera: typeof maxArchives === 'number' ? maxArchives : undefined,
    vacuum: typeof vacuum === 'string'
      ? vacuum
      : {
          mode: vacuum.mode,
          target: vacuum.target,
          analyze: vacuum.analyze,
          reindex: vacuum.reindex,
          optimize: vacuum.optimize,
          pragmas: vacuum.pragmas
        },
    snapshot: snapshot
      ? {
          mode: snapshot.mode,
          retentionDays: snapshot.retentionDays
        }
      : undefined,
    logger: options.logger
  } satisfies RetentionTaskOptions;
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
    const now = Date.now();
    const stats = runtime.restartStats;
    stats.total += 1;
    stats.byReason.set(event.reason, (stats.byReason.get(event.reason) ?? 0) + 1);
    const record = { reason: event.reason, attempt: event.attempt, delayMs: event.delayMs, at: now };
    stats.last = record;
    stats.history.push(record);
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
