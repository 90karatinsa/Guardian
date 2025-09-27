import { EventEmitter } from 'node:events';
import path from 'node:path';
import loggerModule, { setLogLevel } from './logger.js';
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
  PoseOverrideConfig,
  FaceConfig,
  ObjectsConfig,
  ObjectsOverrideConfig,
  LightConfig,
  CameraLightConfig,
  AudioConfig
} from './config/index.js';
import PoseEstimator from './video/poseEstimator.js';
import ObjectClassifier from './video/objectClassifier.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import type { FatalEvent, RecoverEventMeta } from './video/source.js';
import MotionDetector from './video/motionDetector.js';
import PersonDetector, { normalizeClassScoreThresholds } from './video/personDetector.js';
import LightDetector from './video/lightDetector.js';
import { RetentionTask, RetentionTaskOptions, startRetentionTask } from './tasks/retention.js';
import metrics from './metrics/index.js';
import { AudioSource, type AudioFatalEvent } from './audio/source.js';
import AudioAnomalyDetector from './audio/anomaly.js';

type CameraPipelineState = {
  channel: string;
  input: string;
  framesPerSecond: number;
  ffmpeg: CameraFfmpegConfig;
  motion: {
    diffThreshold: number;
    areaThreshold: number;
    minIntervalMs?: number;
    debounceFrames?: number;
    backoffFrames?: number;
    noiseMultiplier?: number;
    noiseSmoothing?: number;
    areaSmoothing?: number;
    areaInflation?: number;
    areaDeltaThreshold?: number;
    idleRebaselineMs?: number;
  };
  person: {
    score: number;
    snapshotDir?: string;
    minIntervalMs?: number;
    classIndices?: number[];
    classScoreThresholds?: Record<number, number>;
  };
  pose: PoseConfig | null;
  objects: ObjectsConfig | null;
  light?: LightConfig | null;
};

type CameraRestartEvent = {
  reason: string;
  attempt: number;
  delayMs: number;
  at: number;
  meta: RecoverEventMeta;
  channel: string | null;
  errorCode: string | number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type CameraRestartStats = {
  total: number;
  byReason: Map<string, number>;
  last: CameraRestartEvent | null;
  history: CameraRestartEvent[];
  watchdogBackoffMs: number;
  totalDelayMs: number;
  historyLimit: number;
  droppedHistory: number;
  lastFatal: (FatalEvent & { at: number }) | null;
};

type CameraRuntime = {
  id: string;
  channel: string;
  source: VideoSource;
  motionDetector: MotionDetector;
  lightDetector: LightDetector | null;
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

type AudioRuntime = {
  source: AudioSource;
  detector: AudioAnomalyDetector | null;
  channel: string;
  cleanup: Array<() => void>;
  dataListener: ((samples: Int16Array) => void) | null;
  applyConfig: (config: AudioConfig) => void;
};

type GuardConfig = {
  video: VideoConfig;
  person: PersonConfig;
  motion?: MotionConfig;
  events?: EventsConfig;
  pose?: PoseConfig;
  face?: FaceConfig;
  objects?: ObjectsConfig;
  light?: LightConfig;
  audio?: AudioConfig;
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
  resetCircuitBreaker: (identifier: string) => boolean;
};

const DEFAULT_CHECK_EVERY = 3;
const DEFAULT_MAX_DETECTIONS = 5;
const CAMERA_RESTART_HISTORY_LIMIT = 50;

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
  let handleManagerError: ((error: unknown) => void) | null = null;
  let audioRuntime: AudioRuntime | null = null;

  const applyConfiguredLogLevel = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }
    try {
      setLogLevel(value);
    } catch (error) {
      logger.warn(
        { err: error, level: value },
        'Failed to apply configured log level'
      );
    }
  };

  applyConfiguredLogLevel(manager.getConfig().logging?.level);

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

  const stopAudioRuntime = (runtime: AudioRuntime | null) => {
    if (!runtime) {
      return;
    }

    for (const fn of runtime.cleanup) {
      try {
        fn();
      } catch (error) {
        logger.warn({ err: error, channel: runtime.channel }, 'Audio cleanup failed');
      }
    }
    runtime.cleanup.length = 0;
    runtime.source.stop();
  };

  const createAudioPipeline = (audioConfig: AudioConfig): AudioRuntime => {
    const channel =
      typeof audioConfig.channel === 'string' && audioConfig.channel.trim().length > 0
        ? audioConfig.channel
        : 'audio:microphone';

    const source = new AudioSource({
      type: 'mic',
      channel,
      idleTimeoutMs: audioConfig.idleTimeoutMs,
      startTimeoutMs: audioConfig.startTimeoutMs,
      watchdogTimeoutMs: audioConfig.watchdogTimeoutMs,
      restartDelayMs: audioConfig.restartDelayMs,
      restartMaxDelayMs: audioConfig.restartMaxDelayMs,
      restartJitterFactor: audioConfig.restartJitterFactor,
      forceKillTimeoutMs: audioConfig.forceKillTimeoutMs,
      micFallbacks: audioConfig.micFallbacks
    });

    const runtime: AudioRuntime = {
      source,
      detector: null,
      channel,
      cleanup: [],
      dataListener: null,
      applyConfig: () => {}
    };

    const handleError = (error: Error) => {
      logger.error({ err: error, channel }, 'Audio source error');
    };
    source.on('error', handleError);
    runtime.cleanup.push(() => source.off('error', handleError));

    const handleRecover = (event: { reason: string; attempt: number; delayMs: number }) => {
      logger.warn({ channel, reason: event.reason, attempt: event.attempt, delayMs: event.delayMs }, 'Audio source recovering');
    };
    source.on('recover', handleRecover);
    runtime.cleanup.push(() => source.off('recover', handleRecover));

    const handleFatal = (event: AudioFatalEvent) => {
      logger.error(
        { channel, attempts: event.attempts, reason: event.reason, lastFailure: event.lastFailure },
        'Audio source fatal error'
      );
    };
    source.on('fatal', handleFatal);
    runtime.cleanup.push(() => source.off('fatal', handleFatal));

    runtime.cleanup.push(() => {
      if (runtime.dataListener) {
        source.off('data', runtime.dataListener);
      }
    });

    const configureAnomaly = (anomalyConfig?: AudioConfig['anomaly']) => {
      if (!anomalyConfig) {
        if (runtime.dataListener) {
          source.off('data', runtime.dataListener);
          runtime.dataListener = null;
        }
        runtime.detector = null;
        return;
      }

      if (runtime.detector) {
        runtime.detector.updateOptions({
          sampleRate: anomalyConfig.sampleRate,
          frameDurationMs: anomalyConfig.frameDurationMs,
          hopDurationMs: anomalyConfig.hopDurationMs,
          frameSize: anomalyConfig.frameSize,
          hopSize: anomalyConfig.hopSize,
          rmsThreshold: anomalyConfig.rmsThreshold,
          centroidJumpThreshold: anomalyConfig.centroidJumpThreshold,
          minIntervalMs: anomalyConfig.minIntervalMs,
          minTriggerDurationMs: anomalyConfig.minTriggerDurationMs,
          rmsWindowMs: anomalyConfig.rmsWindowMs,
          centroidWindowMs: anomalyConfig.centroidWindowMs,
          thresholds: anomalyConfig.thresholds,
          nightHours: anomalyConfig.nightHours
        });
        return;
      }

      const detector = new AudioAnomalyDetector(
        {
          source: channel,
          sampleRate: anomalyConfig.sampleRate,
          frameDurationMs: anomalyConfig.frameDurationMs,
          hopDurationMs: anomalyConfig.hopDurationMs,
          frameSize: anomalyConfig.frameSize,
          hopSize: anomalyConfig.hopSize,
          rmsThreshold: anomalyConfig.rmsThreshold,
          centroidJumpThreshold: anomalyConfig.centroidJumpThreshold,
          minIntervalMs: anomalyConfig.minIntervalMs,
          minTriggerDurationMs: anomalyConfig.minTriggerDurationMs,
          rmsWindowMs: anomalyConfig.rmsWindowMs,
          centroidWindowMs: anomalyConfig.centroidWindowMs,
          thresholds: anomalyConfig.thresholds,
          nightHours: anomalyConfig.nightHours
        },
        bus
      );
      runtime.detector = detector;
      const handleData = (samples: Int16Array) => {
        detector.handleChunk(samples);
      };
      runtime.dataListener = handleData;
      source.on('data', handleData);
    };

    runtime.applyConfig = config => {
      source.updateOptions({
        idleTimeoutMs: config.idleTimeoutMs,
        startTimeoutMs: config.startTimeoutMs,
        watchdogTimeoutMs: config.watchdogTimeoutMs,
        restartDelayMs: config.restartDelayMs,
        restartMaxDelayMs: config.restartMaxDelayMs,
        restartJitterFactor: config.restartJitterFactor,
        forceKillTimeoutMs: config.forceKillTimeoutMs,
        micFallbacks: config.micFallbacks
      });
      configureAnomaly(config.anomaly);
    };

    runtime.applyConfig(audioConfig);
    source.start();
    logger.info({ channel }, 'Starting audio pipeline');
    return runtime;
  };

  const syncAudioRuntime = (config: GuardConfig) => {
    const audioConfig = config.audio;
    if (!audioConfig) {
      if (audioRuntime) {
        logger.info({ channel: audioRuntime.channel }, 'Stopping audio pipeline');
        stopAudioRuntime(audioRuntime);
        audioRuntime = null;
      }
      return;
    }

    const desiredChannel =
      typeof audioConfig.channel === 'string' && audioConfig.channel.trim().length > 0
        ? audioConfig.channel
        : 'audio:microphone';

    if (!audioRuntime) {
      audioRuntime = createAudioPipeline(audioConfig);
      return;
    }

    if (audioRuntime.channel !== desiredChannel) {
      logger.info({ previous: audioRuntime.channel, next: desiredChannel }, 'Restarting audio pipeline after channel change');
      stopAudioRuntime(audioRuntime);
      audioRuntime = createAudioPipeline(audioConfig);
      return;
    }

    audioRuntime.applyConfig(audioConfig);
  };

  configureRetention(activeConfig);
  syncAudioRuntime(activeConfig);

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
      restartJitterFactor: context.pipelineState.ffmpeg.restartJitterFactor,
      circuitBreakerThreshold: context.pipelineState.ffmpeg.circuitBreakerThreshold
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
      areaDeltaThreshold: context.motion.areaDeltaThreshold,
      idleRebaselineMs: context.motion.idleRebaselineMs
    });

    const lightDetector = context.pipelineState.light
      ? new LightDetector({
          source: context.pipelineState.channel,
          deltaThreshold: context.pipelineState.light.deltaThreshold,
          normalHours: context.pipelineState.light.normalHours,
          smoothingFactor: context.pipelineState.light.smoothingFactor,
          minIntervalMs: context.pipelineState.light.minIntervalMs,
          debounceFrames: context.pipelineState.light.debounceFrames,
          backoffFrames: context.pipelineState.light.backoffFrames,
          noiseMultiplier: context.pipelineState.light.noiseMultiplier,
          noiseSmoothing: context.pipelineState.light.noiseSmoothing,
          idleRebaselineMs: context.pipelineState.light.idleRebaselineMs
        })
      : null;

    const objectClassifier = context.pipelineState.objects
      ? await ObjectClassifier.create({
          modelPath: context.pipelineState.objects.modelPath,
          labels: context.pipelineState.objects.labels,
          threatLabels: context.pipelineState.objects.threatLabels,
          threatThreshold: context.pipelineState.objects.threatThreshold,
          labelMap: context.pipelineState.objects.labelMap
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
        classScoreThresholds: context.pipelineState.person.classScoreThresholds,
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
      lightDetector,
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
        history: [],
        watchdogBackoffMs: 0,
        totalDelayMs: 0,
        historyLimit: CAMERA_RESTART_HISTORY_LIMIT,
        droppedHistory: 0,
        lastFatal: null
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
      {
        camera: camera.id,
        channel: context.pipelineState.channel,
        input: context.pipelineState.input,
        ffmpeg: {
          framesPerSecond: context.pipelineState.framesPerSecond,
          rtspTransport: context.pipelineState.ffmpeg.rtspTransport,
          idleTimeoutMs: context.pipelineState.ffmpeg.idleTimeoutMs,
          watchdogTimeoutMs: context.pipelineState.ffmpeg.watchdogTimeoutMs,
          restartDelayMs: context.pipelineState.ffmpeg.restartDelayMs,
          restartMaxDelayMs: context.pipelineState.ffmpeg.restartMaxDelayMs
        },
        detectors: {
          motion: {
            diffThreshold: context.motion.diffThreshold,
            areaThreshold: context.motion.areaThreshold,
            minIntervalMs: context.motion.minIntervalMs,
            debounceFrames: context.motion.debounceFrames,
            backoffFrames: context.motion.backoffFrames
          },
          person: {
            score: context.pipelineState.person.score,
            minIntervalMs: context.pipelineState.person.minIntervalMs,
            classScoreThresholds: context.pipelineState.person.classScoreThresholds
          }
        }
      },
      'Starting video pipeline'
    );

    return runtime;
  };

  const syncPipelines = async (config: GuardConfig, options: { forceRestart?: boolean } = {}) => {
    const forceRestart = options.forceRestart === true;
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

      const restartRequested = forceRestart || needsPipelineRestart(existing.pipelineState, context.pipelineState);

      if (restartRequested) {
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

      const updates = summarizePipelineUpdates(existing, context);
      if (updates) {
        logger.info(
          { camera: existing.id, channel: existing.channel, updates },
          'Updated guard pipeline configuration'
        );
      }

      existing.pipelineState = context.pipelineState;
      existing.checkEvery = context.checkEvery;
      existing.maxDetections = context.maxDetections;
      existing.motionDetector.updateOptions({
        diffThreshold: context.motion.diffThreshold,
        areaThreshold: context.motion.areaThreshold,
        minIntervalMs: context.motion.minIntervalMs,
        debounceFrames: context.motion.debounceFrames,
        backoffFrames: context.motion.backoffFrames,
        noiseMultiplier: context.motion.noiseMultiplier,
        noiseSmoothing: context.motion.noiseSmoothing,
        areaSmoothing: context.motion.areaSmoothing,
        areaInflation: context.motion.areaInflation,
        areaDeltaThreshold: context.motion.areaDeltaThreshold,
        idleRebaselineMs: context.motion.idleRebaselineMs,
        noiseWarmupFrames: context.motion.noiseWarmupFrames,
        noiseBackoffPadding: context.motion.noiseBackoffPadding
      });
      if (context.pipelineState.light) {
        if (existing.lightDetector) {
          existing.lightDetector.updateOptions({
            deltaThreshold: context.pipelineState.light.deltaThreshold,
            normalHours: context.pipelineState.light.normalHours,
            smoothingFactor: context.pipelineState.light.smoothingFactor,
            minIntervalMs: context.pipelineState.light.minIntervalMs,
            debounceFrames: context.pipelineState.light.debounceFrames,
            backoffFrames: context.pipelineState.light.backoffFrames,
            noiseMultiplier: context.pipelineState.light.noiseMultiplier,
            noiseSmoothing: context.pipelineState.light.noiseSmoothing,
            idleRebaselineMs: context.pipelineState.light.idleRebaselineMs,
            noiseWarmupFrames: context.pipelineState.light.noiseWarmupFrames,
            noiseBackoffPadding: context.pipelineState.light.noiseBackoffPadding
          });
        } else {
          existing.lightDetector = new LightDetector({
            source: existing.channel,
            deltaThreshold: context.pipelineState.light.deltaThreshold,
            normalHours: context.pipelineState.light.normalHours,
            smoothingFactor: context.pipelineState.light.smoothingFactor,
            minIntervalMs: context.pipelineState.light.minIntervalMs,
            debounceFrames: context.pipelineState.light.debounceFrames,
            backoffFrames: context.pipelineState.light.backoffFrames,
            noiseMultiplier: context.pipelineState.light.noiseMultiplier,
            noiseSmoothing: context.pipelineState.light.noiseSmoothing,
            idleRebaselineMs: context.pipelineState.light.idleRebaselineMs,
            noiseWarmupFrames: context.pipelineState.light.noiseWarmupFrames,
            noiseBackoffPadding: context.pipelineState.light.noiseBackoffPadding
          });
        }
      } else if (existing.lightDetector) {
        existing.lightDetector = null;
      }
    }
  };

  const runSync = (config: GuardConfig, options: { forceRestart?: boolean } = {}) => {
    syncPromise = syncPromise
      .then(() => syncPipelines(config, options))
      .catch(error => {
        logger.error({ err: error }, 'Failed to apply camera configuration');
      });

    return syncPromise;
  };

  const handleReload = ({ previous, next }: ConfigReloadEvent) => {
    const overrideDiff = diffGuardOverrides(previous, next);
    activeConfig = pickGuardConfig(next);
    runSync(activeConfig);

    if (bus instanceof EventBus) {
      const suppressionRules = activeConfig.events?.suppression?.rules ?? [];
      bus.configureSuppression(suppressionRules);
    }

    configureRetention(activeConfig);
    syncAudioRuntime(activeConfig);

    applyConfiguredLogLevel(next.logging?.level);

    if (overrideDiff) {
      logger.info(overrideDiff, 'configuration overrides diff');
    }

    const reloadMeta: Record<string, unknown> = {
      diffThreshold: activeConfig.motion?.diffThreshold,
      areaThreshold: activeConfig.motion?.areaThreshold,
      minIntervalMs: activeConfig.motion?.minIntervalMs,
      suppressionRules: activeConfig.events?.suppression?.rules?.length ?? 0,
      cameras: Array.isArray(next.video.cameras) ? next.video.cameras.length : 0,
      channels: next.video.channels ? Object.keys(next.video.channels).length : 0,
      audioFallbacks: next.audio?.micFallbacks
        ? Object.values(next.audio.micFallbacks).reduce((total, devices) => {
            return total + (Array.isArray(devices) ? devices.length : 0);
          }, 0)
        : 0
    };

    if (overrideDiff) {
      reloadMeta.overrides = overrideDiff;
    }

    logger.info(reloadMeta, 'configuration reloaded');
  };

  if (!injectedConfig) {
    stopWatching = manager.watch();
    manager.on('reload', handleReload);
    handleConfigError = error => {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        { err, configPath: manager.getPath(), action: 'reload', restored: true },
        'configuration reload failed'
      );
      logger.info(
        { configPath: manager.getPath(), action: 'reload', restored: true },
        'Configuration rollback applied'
      );
    };
    handleManagerError = error => {
      handleConfigError?.(error);
      runSync(activeConfig, { forceRestart: true });
    };
    manager.on('error', handleManagerError);
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

  const resetPipelineCircuitBreaker = (identifier: string) => {
    const runtime =
      pipelines.get(identifier) ??
      pipelinesById.get(identifier) ??
      pipelinesById.get(identifier.replace(/^video:/, '')) ??
      null;

    const target = runtime ?? Array.from(pipelines.values()).find(candidate => {
      return candidate.channel === identifier || candidate.id === identifier;
    });

    if (!target) {
      return false;
    }

    if (!target.source.isCircuitBroken()) {
      return false;
    }

    const wasBroken = target.source.resetCircuitBreaker();
    if (!wasBroken) {
      return false;
    }

    const channel = target.channel;
    logger.info({ camera: target.id, channel }, 'Resetting video circuit breaker');
    metrics.recordPipelineRestart('ffmpeg', 'manual-circuit-reset', {
      channel,
      at: Date.now(),
      attempt: 0,
      delayMs: 0
    });
    return true;
  };

  const stop = () => {
    bus.off('event', eventHandler);
    if (!injectedConfig) {
      manager.off('reload', handleReload);
      if (handleManagerError) {
        manager.off('error', handleManagerError);
      }
      stopWatching?.();
    }
    stopAudioRuntime(audioRuntime);
    audioRuntime = null;
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

  return { stop, pipelines, retention: retentionTask, resetCircuitBreaker: resetPipelineCircuitBreaker };
}

function buildCameraList(videoConfig: VideoConfig) {
  if (Array.isArray(videoConfig.cameras) && videoConfig.cameras.length > 0) {
    for (const camera of videoConfig.cameras) {
      if (!camera.channel) {
        throw new Error(`Camera "${camera.id}" is missing a channel`);
      }
    }
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
  const channels = videoConfig.channels;
  if (!channels) {
    return undefined;
  }
  if (channel in channels) {
    return channels[channel];
  }
  const withoutPrefix = channel.startsWith('video:') ? channel.slice('video:'.length) : channel;
  if (withoutPrefix in channels) {
    return channels[withoutPrefix];
  }
  const normalized = normalizeChannelId(channel);
  if (normalized !== channel && normalized in channels) {
    return channels[normalized];
  }
  return undefined;
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
    restartJitterFactor: camera?.restartJitterFactor ?? defaults?.restartJitterFactor,
    circuitBreakerThreshold:
      camera?.circuitBreakerThreshold ?? defaults?.circuitBreakerThreshold
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
    areaDeltaThreshold: cameraMotion?.areaDeltaThreshold ?? defaults.areaDeltaThreshold,
    idleRebaselineMs: cameraMotion?.idleRebaselineMs ?? defaults.idleRebaselineMs,
    noiseWarmupFrames: cameraMotion?.noiseWarmupFrames ?? defaults.noiseWarmupFrames,
    noiseBackoffPadding: cameraMotion?.noiseBackoffPadding ?? defaults.noiseBackoffPadding
  };
}

function resolveLightConfig(
  globalLight: LightConfig | undefined,
  channelLight: CameraLightConfig | undefined,
  cameraLight: CameraLightConfig | undefined
): LightConfig | null {
  const layers: Array<LightConfig | CameraLightConfig | undefined> = [
    globalLight,
    channelLight,
    cameraLight
  ];

  let deltaThreshold: number | undefined;
  let normalHours: LightConfig['normalHours'];
  let smoothingFactor: number | undefined;
  let minIntervalMs: number | undefined;
  let debounceFrames: number | undefined;
  let backoffFrames: number | undefined;
  let noiseMultiplier: number | undefined;
  let noiseSmoothing: number | undefined;
  let idleRebaselineMs: number | undefined;
  let noiseWarmupFrames: number | undefined;
  let noiseBackoffPadding: number | undefined;

  for (const layer of layers) {
    if (!layer) {
      continue;
    }

    if (typeof layer.deltaThreshold === 'number') {
      deltaThreshold = layer.deltaThreshold;
    }
    if (Array.isArray(layer.normalHours)) {
      normalHours = layer.normalHours;
    }
    if (typeof layer.smoothingFactor === 'number') {
      smoothingFactor = layer.smoothingFactor;
    }
    if (typeof layer.minIntervalMs === 'number') {
      minIntervalMs = layer.minIntervalMs;
    }
    if (typeof layer.debounceFrames === 'number') {
      debounceFrames = layer.debounceFrames;
    }
    if (typeof layer.backoffFrames === 'number') {
      backoffFrames = layer.backoffFrames;
    }
    if (typeof layer.noiseMultiplier === 'number') {
      noiseMultiplier = layer.noiseMultiplier;
    }
    if (typeof layer.noiseSmoothing === 'number') {
      noiseSmoothing = layer.noiseSmoothing;
    }
    if (typeof layer.idleRebaselineMs === 'number') {
      idleRebaselineMs = layer.idleRebaselineMs;
    }
    if (typeof layer.noiseWarmupFrames === 'number') {
      noiseWarmupFrames = layer.noiseWarmupFrames;
    }
    if (typeof layer.noiseBackoffPadding === 'number') {
      noiseBackoffPadding = layer.noiseBackoffPadding;
    }
  }

  if (typeof deltaThreshold !== 'number') {
    return null;
  }

  return {
    deltaThreshold,
    normalHours,
    smoothingFactor,
    minIntervalMs,
    debounceFrames,
    backoffFrames,
    noiseMultiplier,
    noiseSmoothing,
    idleRebaselineMs,
    noiseWarmupFrames,
    noiseBackoffPadding
  };
}

function resolvePoseConfig(
  globalPose: PoseConfig | undefined,
  channelPose: PoseOverrideConfig | undefined,
  cameraPose: PoseOverrideConfig | undefined
): PoseConfig | null {
  const modelPath = cameraPose?.modelPath ?? channelPose?.modelPath ?? globalPose?.modelPath;
  if (!modelPath) {
    return null;
  }

  return {
    modelPath,
    forecastHorizonMs:
      cameraPose?.forecastHorizonMs ??
      channelPose?.forecastHorizonMs ??
      globalPose?.forecastHorizonMs,
    smoothingWindow:
      cameraPose?.smoothingWindow ?? channelPose?.smoothingWindow ?? globalPose?.smoothingWindow,
    minMovement: cameraPose?.minMovement ?? channelPose?.minMovement ?? globalPose?.minMovement,
    historySize: cameraPose?.historySize ?? channelPose?.historySize ?? globalPose?.historySize
  };
}

function resolveObjectsConfig(
  globalObjects: ObjectsConfig | undefined,
  channelObjects: ObjectsOverrideConfig | undefined,
  cameraObjects: ObjectsOverrideConfig | undefined
): ObjectsConfig | null {
  const modelPath = cameraObjects?.modelPath ?? channelObjects?.modelPath ?? globalObjects?.modelPath;
  const labels = cameraObjects?.labels ?? channelObjects?.labels ?? globalObjects?.labels;

  if (!modelPath || !labels || labels.length === 0) {
    return null;
  }

  const threatLabels = cameraObjects?.threatLabels ?? channelObjects?.threatLabels ?? globalObjects?.threatLabels;
  const classIndices = cameraObjects?.classIndices ?? channelObjects?.classIndices ?? globalObjects?.classIndices;
  const labelMap = cameraObjects?.labelMap ?? channelObjects?.labelMap ?? globalObjects?.labelMap;

  return {
    modelPath,
    labels: [...labels],
    threatLabels: threatLabels ? [...threatLabels] : undefined,
    threatThreshold:
      cameraObjects?.threatThreshold ?? channelObjects?.threatThreshold ?? globalObjects?.threatThreshold,
    classIndices: classIndices ? [...classIndices] : undefined,
    labelMap: labelMap ? { ...labelMap } : undefined
  };
}

function buildCameraContext(camera: CameraConfig, config: GuardConfig) {
  if (!config.motion) {
    throw new Error('Motion configuration is required');
  }

  if (!camera.channel) {
    throw new Error(`Camera "${camera.id}" is missing a channel`);
  }
  const channel = normalizeChannelId(camera.channel);
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
  const classScoreThresholds = normalizeClassScoreThresholds(
    mergeClassScoreThresholds(
      config.person.classScoreThresholds,
      channelConfig?.person?.classScoreThresholds,
      camera.person?.classScoreThresholds
    )
  );
  const light = resolveLightConfig(config.light, channelConfig?.light, camera.light);
  const pose = resolvePoseConfig(config.pose, channelConfig?.pose, camera.pose);
  const objects = resolveObjectsConfig(config.objects, channelConfig?.objects, camera.objects);

  const channelMotionDefaults = channelConfig?.motion
    ? resolveCameraMotion(channelConfig.motion, config.motion)
    : null;
  const motionDefaults = channelMotionDefaults ?? config.motion;
  const motion = resolveCameraMotion(camera.motion, motionDefaults);

  if (channelMotionDefaults) {
    if (Number.isFinite(channelMotionDefaults.diffThreshold)) {
      motion.diffThreshold = Math.min(
        motion.diffThreshold,
        channelMotionDefaults.diffThreshold
      );
    }
    if (Number.isFinite(channelMotionDefaults.areaThreshold)) {
      motion.areaThreshold = Math.min(
        motion.areaThreshold,
        channelMotionDefaults.areaThreshold
      );
    }
  }

  const pipelineState: CameraPipelineState = {
    channel,
    input,
    framesPerSecond,
    ffmpeg,
    motion: {
      diffThreshold: motion.diffThreshold,
      areaThreshold: motion.areaThreshold,
      minIntervalMs: motion.minIntervalMs,
      debounceFrames: motion.debounceFrames,
      backoffFrames: motion.backoffFrames,
      noiseMultiplier: motion.noiseMultiplier,
      noiseSmoothing: motion.noiseSmoothing,
      areaSmoothing: motion.areaSmoothing,
      areaInflation: motion.areaInflation,
      areaDeltaThreshold: motion.areaDeltaThreshold,
      idleRebaselineMs: motion.idleRebaselineMs,
      noiseWarmupFrames: motion.noiseWarmupFrames,
      noiseBackoffPadding: motion.noiseBackoffPadding
    },
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
        config.person.classIndices,
      classScoreThresholds
    },
    pose: pose
      ? {
          modelPath: pose.modelPath,
          forecastHorizonMs: pose.forecastHorizonMs,
          smoothingWindow: pose.smoothingWindow,
          minMovement: pose.minMovement,
          historySize: pose.historySize
        }
      : null,
    objects: objects
      ? {
          modelPath: objects.modelPath,
          labels: [...objects.labels],
          threatLabels: objects.threatLabels ? [...objects.threatLabels] : undefined,
          threatThreshold: objects.threatThreshold,
          classIndices: objects.classIndices ? [...objects.classIndices] : undefined,
          labelMap: objects.labelMap ? { ...objects.labelMap } : undefined
        }
      : null,
    light
  };

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

  if (!classScoreThresholdsEqual(previous.person.classScoreThresholds, next.person.classScoreThresholds)) {
    return true;
  }

  if (!poseConfigsEqual(previous.pose, next.pose)) {
    return true;
  }

  if (!objectConfigsEqual(previous.objects, next.objects)) {
    return true;
  }

  if (!motionConfigsEqual(previous.motion, next.motion)) {
    return true;
  }

  return false;
}

function mergeClassScoreThresholds(
  ...maps: Array<Record<number, number> | undefined>
): Record<number, number> | undefined {
  let hasValue = false;
  const result: Record<number, number> = {};

  for (const map of maps) {
    if (!map) {
      continue;
    }

    for (const [key, value] of Object.entries(map)) {
      const classId = Number(key);
      const threshold = Number(value);
      if (!Number.isFinite(classId) || classId < 0 || !Number.isFinite(threshold)) {
        continue;
      }
      result[classId] = threshold;
      hasValue = true;
    }
  }

  return hasValue ? result : undefined;
}

function classScoreThresholdsEqual(
  a?: Record<number, number>,
  b?: Record<number, number>
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  const aEntries = Object.entries(a).sort(([aKey], [bKey]) => Number(aKey) - Number(bKey));
  const bEntries = Object.entries(b).sort(([aKey], [bKey]) => Number(aKey) - Number(bKey));

  if (aEntries.length !== bEntries.length) {
    return false;
  }

  for (let i = 0; i < aEntries.length; i += 1) {
    const [aKey, aValue] = aEntries[i];
    const [bKey, bValue] = bEntries[i];
    if (Number(aKey) !== Number(bKey)) {
      return false;
    }
    if (Math.abs(Number(aValue) - Number(bValue)) > 1e-6) {
      return false;
    }
  }

  return true;
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

function poseConfigsEqual(a?: PoseConfig | null, b?: PoseConfig | null) {
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

function objectConfigsEqual(a?: ObjectsConfig | null, b?: ObjectsConfig | null) {
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
    arrayEqual(a.classIndices, b.classIndices) &&
    recordsEqual(a.labelMap, b.labelMap)
  );
}

function motionConfigsEqual(
  a: CameraPipelineState['motion'],
  b: CameraPipelineState['motion']
) {
  return (
    Math.abs(a.diffThreshold - b.diffThreshold) < 1e-6 &&
    Math.abs(a.areaThreshold - b.areaThreshold) < 1e-6 &&
    (a.minIntervalMs ?? null) === (b.minIntervalMs ?? null) &&
    (a.debounceFrames ?? null) === (b.debounceFrames ?? null) &&
    (a.backoffFrames ?? null) === (b.backoffFrames ?? null) &&
    (a.noiseMultiplier ?? null) === (b.noiseMultiplier ?? null) &&
    (a.noiseSmoothing ?? null) === (b.noiseSmoothing ?? null) &&
    (a.areaSmoothing ?? null) === (b.areaSmoothing ?? null) &&
    (a.areaInflation ?? null) === (b.areaInflation ?? null) &&
    (a.areaDeltaThreshold ?? null) === (b.areaDeltaThreshold ?? null) &&
    (a.idleRebaselineMs ?? null) === (b.idleRebaselineMs ?? null)
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

function recordsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const aEntries = Object.entries(a).sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  const bEntries = Object.entries(b).sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([key, value], index) => {
    const [bKey, bValue] = bEntries[index];
    return key === bKey && value === bValue;
  });
}

function normalizeChannelId(channel: string) {
  const trimmed = typeof channel === 'string' ? channel.trim() : '';
  if (!trimmed) {
    throw new Error('Camera channel is required');
  }
  if (/^[a-z0-9_-]+:/i.test(trimmed)) {
    return trimmed;
  }
  return `video:${trimmed}`;
}

function summarizePipelineUpdates(
  runtime: CameraRuntime,
  next: ReturnType<typeof buildCameraContext>
) {
  const updates: Record<string, unknown> = {};

  const motionChanges = collectNumericChanges(
    runtime.pipelineState.motion,
    next.pipelineState.motion,
    ['noiseWarmupFrames', 'noiseBackoffPadding']
  );
  if (Object.keys(motionChanges).length > 0) {
    updates.motion = motionChanges;
  }

  const detectionChanges = collectNumericChanges(
    { checkEvery: runtime.checkEvery, maxDetections: runtime.maxDetections },
    { checkEvery: next.checkEvery, maxDetections: next.maxDetections },
    ['checkEvery', 'maxDetections']
  );
  if (Object.keys(detectionChanges).length > 0) {
    updates.person = detectionChanges;
  }

  if (!lightConfigsEqual(runtime.pipelineState.light, next.pipelineState.light)) {
    updates.light = {
      previous: snapshotLightConfig(runtime.pipelineState.light),
      next: snapshotLightConfig(next.pipelineState.light)
    };
  }

  if (!objectConfigsEqual(runtime.pipelineState.objects, next.pipelineState.objects)) {
    updates.objects = {
      previous: snapshotObjectsConfig(runtime.pipelineState.objects),
      next: snapshotObjectsConfig(next.pipelineState.objects)
    };
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

function collectNumericChanges<
  T extends Record<string, number | null | undefined>,
  K extends keyof T
>(
  previous: T,
  next: T,
  fields: K[]
) {
  const changes: Record<string, { previous: number | null; next: number | null }> = {};

  for (const field of fields) {
    const prevValue = normalizeNumber(previous[field]);
    const nextValue = normalizeNumber(next[field]);
    if (prevValue !== nextValue) {
      changes[field as string] = { previous: prevValue, next: nextValue };
    }
  }

  return changes;
}

function normalizeNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function snapshotLightConfig(config: LightConfig | null | undefined) {
  if (!config) {
    return null;
  }

  return {
    deltaThreshold: normalizeNumber(config.deltaThreshold),
    smoothingFactor: normalizeNumber(config.smoothingFactor),
    minIntervalMs: normalizeNumber(config.minIntervalMs),
    debounceFrames: normalizeNumber(config.debounceFrames),
    backoffFrames: normalizeNumber(config.backoffFrames),
    noiseMultiplier: normalizeNumber(config.noiseMultiplier),
    noiseSmoothing: normalizeNumber(config.noiseSmoothing),
    idleRebaselineMs: normalizeNumber(config.idleRebaselineMs),
    noiseWarmupFrames: normalizeNumber(config.noiseWarmupFrames),
    noiseBackoffPadding: normalizeNumber(config.noiseBackoffPadding),
    normalHours: config.normalHours?.map(range => ({ ...range })) ?? null
  };
}

function snapshotObjectsConfig(config: ObjectsConfig | null | undefined) {
  if (!config) {
    return null;
  }

  return {
    modelPath: config.modelPath,
    labels: [...config.labels],
    threatLabels: config.threatLabels ? [...config.threatLabels] : null,
    threatThreshold: normalizeNumber(config.threatThreshold),
    classIndices: config.classIndices ? [...config.classIndices] : null,
    labelMap: config.labelMap ? { ...config.labelMap } : null
  };
}

function lightConfigsEqual(a: LightConfig | null | undefined, b: LightConfig | null | undefined) {
  if (!a && !b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  if (normalizeNumber(a.deltaThreshold) !== normalizeNumber(b.deltaThreshold)) {
    return false;
  }
  if (normalizeNumber(a.smoothingFactor) !== normalizeNumber(b.smoothingFactor)) {
    return false;
  }
  if (normalizeNumber(a.minIntervalMs) !== normalizeNumber(b.minIntervalMs)) {
    return false;
  }
  if (normalizeNumber(a.debounceFrames) !== normalizeNumber(b.debounceFrames)) {
    return false;
  }
  if (normalizeNumber(a.backoffFrames) !== normalizeNumber(b.backoffFrames)) {
    return false;
  }
  if (normalizeNumber(a.noiseMultiplier) !== normalizeNumber(b.noiseMultiplier)) {
    return false;
  }
  if (normalizeNumber(a.noiseSmoothing) !== normalizeNumber(b.noiseSmoothing)) {
    return false;
  }
  if (normalizeNumber(a.idleRebaselineMs) !== normalizeNumber(b.idleRebaselineMs)) {
    return false;
  }
  if (normalizeNumber(a.noiseWarmupFrames) !== normalizeNumber(b.noiseWarmupFrames)) {
    return false;
  }
  if (normalizeNumber(a.noiseBackoffPadding) !== normalizeNumber(b.noiseBackoffPadding)) {
    return false;
  }

  return lightHoursEqual(a.normalHours, b.normalHours);
}

function lightHoursEqual(
  a?: Array<{ start: number; end: number }> | null,
  b?: Array<{ start: number; end: number }> | null
) {
  if (!a && !b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  return a.every((range, index) => {
    const other = b[index];
    return range.start === other.start && range.end === other.end;
  });
}

function pickGuardConfig(config: GuardianConfig): GuardConfig {
  return {
    video: config.video,
    person: config.person,
    motion: config.motion,
    events: config.events,
    pose: config.pose,
    face: config.face,
    objects: config.objects,
    light: config.light,
    audio: config.audio
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
    objects: injected.objects ?? fallback.objects,
    light: injected.light ?? fallback.light,
    audio: injected.audio ?? fallback.audio
  };
}

type OverrideSummary = Record<string, unknown>;

type OverrideDiff<T> = {
  added?: Record<string, T>;
  removed?: string[];
  changed?: Record<string, { previous: T; next: T }>;
};

type OverridesDiffSummary = {
  channels?: OverrideDiff<OverrideSummary>;
  cameras?: OverrideDiff<OverrideSummary>;
};

function diffGuardOverrides(previous: GuardianConfig, next: GuardianConfig): OverridesDiffSummary | null {
  const previousChannels = summarizeChannelOverrides(previous);
  const nextChannels = summarizeChannelOverrides(next);
  const previousCameras = summarizeCameraOverrides(previous);
  const nextCameras = summarizeCameraOverrides(next);

  const channelDiff = diffOverrideMap(previousChannels, nextChannels);
  const cameraDiff = diffOverrideMap(previousCameras, nextCameras);

  if (!channelDiff && !cameraDiff) {
    return null;
  }

  const summary: OverridesDiffSummary = {};
  if (channelDiff) {
    summary.channels = channelDiff;
  }
  if (cameraDiff) {
    summary.cameras = cameraDiff;
  }

  return summary;
}

function diffOverrideMap<T>(previous: Record<string, T>, next: Record<string, T>): OverrideDiff<T> | null {
  const added: Record<string, T> = {};
  const removed: string[] = [];
  const changed: Record<string, { previous: T; next: T }> = {};

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (!(key in next)) {
      removed.push(key);
      continue;
    }
    if (!(key in previous)) {
      added[key] = next[key];
      continue;
    }
    if (!isDeepEqual(previous[key], next[key])) {
      changed[key] = { previous: previous[key], next: next[key] };
    }
  }

  const diff: OverrideDiff<T> = {};
  if (Object.keys(added).length > 0) {
    diff.added = added;
  }
  if (removed.length > 0) {
    diff.removed = removed;
  }
  if (Object.keys(changed).length > 0) {
    diff.changed = changed;
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

function summarizeChannelOverrides(config: GuardianConfig): Record<string, OverrideSummary> {
  const summaries: Record<string, OverrideSummary> = {};
  const channels = config.video.channels ?? {};
  for (const [channelId, channel] of Object.entries(channels)) {
    const summary = buildOverrideSummary({
      framesPerSecond: channel.framesPerSecond,
      ffmpeg: channel.ffmpeg,
      motion: channel.motion,
      person: channel.person,
      pose: channel.pose,
      objects: channel.objects,
      light: channel.light
    });
    if (summary) {
      summaries[channelId] = summary;
    }
  }
  return summaries;
}

function summarizeCameraOverrides(config: GuardianConfig): Record<string, OverrideSummary> {
  const summaries: Record<string, OverrideSummary> = {};
  const cameras = config.video.cameras ?? [];
  cameras.forEach((camera, index) => {
    const summary = buildOverrideSummary({
      channel: camera.channel,
      input: camera.input,
      framesPerSecond: camera.framesPerSecond,
      ffmpeg: camera.ffmpeg,
      motion: camera.motion,
      person: camera.person,
      pose: camera.pose,
      objects: camera.objects,
      light: camera.light
    });
    if (summary) {
      const key = camera.id ?? `#${index}`;
      summaries[key] = summary;
    }
  });
  return summaries;
}

function buildOverrideSummary(candidate: Record<string, unknown> | undefined): OverrideSummary | undefined {
  if (!candidate) {
    return undefined;
  }
  const normalized = pruneSerializable(candidate);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return undefined;
  }
  return normalized as OverrideSummary;
}

function pruneSerializable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value
      .map(entry => pruneSerializable(entry))
      .filter(entry => typeof entry !== 'undefined');
    return normalized.length > 0 ? normalized : undefined;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, pruneSerializable(child)] as const)
      .filter(([, child]) => typeof child !== 'undefined');
    if (entries.length === 0) {
      return undefined;
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      result[key] = child;
    }
    return result;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  return value;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }

  return JSON.stringify(value);
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
  const vacuum = retention.vacuum !== undefined ? retention.vacuum : 'auto';
  const snapshot = retention.snapshot;
  const snapshotAliasLimit = resolveSnapshotGlobalLimit(snapshot);
  const maxArchives =
    typeof retention.maxArchivesPerCamera === 'number' &&
    Number.isFinite(retention.maxArchivesPerCamera) &&
    retention.maxArchivesPerCamera >= 0
      ? retention.maxArchivesPerCamera
      : snapshotAliasLimit;
  const perCameraMax = resolveSnapshotPerCameraMax(snapshot);

  return {
    enabled: retention.enabled !== false,
    retentionDays: retention.retentionDays,
    intervalMs: intervalMinutes * 60 * 1000,
    archiveDir,
    snapshotDirs,
    maxArchivesPerCamera: typeof maxArchives === 'number' ? maxArchives : undefined,
    vacuum:
      typeof vacuum === 'string' || typeof vacuum === 'boolean'
        ? vacuum
        : {
            mode: vacuum.mode,
            target: vacuum.target,
            analyze: vacuum.analyze,
            reindex: vacuum.reindex,
            optimize: vacuum.optimize,
            pragmas: vacuum.pragmas,
            run: vacuum.run
          },
    snapshot: snapshot
      ? {
          mode: snapshot.mode,
          retentionDays: snapshot.retentionDays,
          perCameraMax,
          maxArchivesPerCamera:
            typeof snapshot?.maxArchivesPerCamera !== 'number' ? snapshot?.maxArchivesPerCamera : undefined
        }
      : undefined,
    logger: options.logger
  } satisfies RetentionTaskOptions;
}

function resolveSnapshotPerCameraMax(
  snapshot?: RetentionConfig['snapshot']
): Record<string, number> | undefined {
  const candidate =
    snapshot?.perCameraMax && typeof snapshot.perCameraMax === 'object'
      ? snapshot.perCameraMax
      : snapshot?.maxArchivesPerCamera && typeof snapshot.maxArchivesPerCamera === 'object'
        ? snapshot.maxArchivesPerCamera
        : undefined;

  if (!candidate || Array.isArray(candidate)) {
    return undefined;
  }

  const entries = Object.entries(candidate)
    .filter(([camera, value]) => typeof camera === 'string' && camera.trim().length > 0)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .map(([camera, value]) => [camera, Math.floor(value)] as const);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveSnapshotGlobalLimit(
  snapshot?: RetentionConfig['snapshot']
): number | undefined {
  const alias = snapshot?.maxArchivesPerCamera;
  if (typeof alias === 'number' && Number.isFinite(alias) && alias >= 0) {
    return Math.floor(alias);
  }
  return undefined;
}

function collectSnapshotDirectories(video: VideoConfig, person: PersonConfig): string[] {
  const directories = new Set<string>();
  if (person.snapshotDir) {
    directories.add(path.resolve(person.snapshotDir));
  }

  for (const channelConfig of Object.values(video.channels ?? {})) {
    const snapshotDir = channelConfig.person?.snapshotDir;
    if (snapshotDir) {
      directories.add(path.resolve(snapshotDir));
    }
  }

  for (const camera of video.cameras ?? []) {
    const snapshotDir = camera.person?.snapshotDir;
    if (snapshotDir) {
      directories.add(path.resolve(snapshotDir));
    }
  }

  return [...directories];
}

export const __test__ = {
  collectSnapshotDirectories,
  buildRetentionOptions
};

export { buildRetentionOptions };

function setupSourceHandlers(logger: GuardLogger, runtime: CameraRuntime) {
  const { source } = runtime;
  const personDetector = runtime.personDetector;

  source.on('frame', async frame => {
    const ts = Date.now();

    try {
      runtime.motionDetector.handleFrame(frame, ts);
    } catch (error) {
      logger.error({ err: error, camera: runtime.id }, 'Motion detector failed');
    }

    const activeLightDetector = runtime.lightDetector;
    if (activeLightDetector) {
      try {
        activeLightDetector.handleFrame(frame, ts);
      } catch (error) {
        logger.error({ err: error, camera: runtime.id }, 'Light detector failed');
      }
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
    const record: CameraRestartEvent = {
      reason: event.reason,
      attempt: event.attempt,
      delayMs: event.delayMs,
      at: now,
      meta: event.meta,
      channel: event.channel ?? runtime.channel ?? null,
      errorCode: event.errorCode ?? null,
      exitCode: event.exitCode ?? null,
      signal: event.signal ?? null
    };
    stats.last = record;
    stats.history.push(record);
    if (stats.history.length > stats.historyLimit) {
      const overflow = stats.history.length - stats.historyLimit;
      stats.history.splice(0, overflow);
      stats.droppedHistory += overflow;
    }
    if (typeof event.delayMs === 'number') {
      stats.totalDelayMs += event.delayMs;
      if (event.reason === 'watchdog-timeout') {
        stats.watchdogBackoffMs += event.delayMs;
        metrics.observeLatency('pipeline.ffmpeg.watchdog.delay', event.delayMs);
        metrics.observeHistogram('pipeline.ffmpeg.watchdog.delay', event.delayMs);
      }
    }
    const restartChannel = record.channel ?? runtime.channel;
    metrics.recordPipelineRestart('ffmpeg', event.reason, {
      attempt: event.attempt,
      delayMs: event.delayMs,
      baseDelayMs: event.meta?.baseDelayMs,
      minDelayMs: event.meta?.minDelayMs,
      maxDelayMs: event.meta?.maxDelayMs,
      jitterMs: event.meta?.appliedJitterMs,
      channel: restartChannel,
      errorCode: record.errorCode ?? undefined,
      exitCode: record.exitCode ?? undefined,
      signal: record.signal ?? undefined,
      at: now
    });
    logger.warn(
      {
        camera: runtime.id,
        attempt: event.attempt,
        reason: event.reason,
        delayMs: event.delayMs,
        channel: restartChannel,
        errorCode: record.errorCode,
        exitCode: record.exitCode,
        signal: record.signal ?? undefined,
        meta: event.meta
      },
      `Video source reconnecting (reason=${event.reason})`
    );
  });

  source.on('fatal', (event: FatalEvent) => {
    const now = Date.now();
    runtime.restartStats.lastFatal = { ...event, at: now };
    const channel = event.channel ?? runtime.channel;
    logger.error(
      {
        camera: runtime.id,
        attempts: event.attempts,
        reason: event.reason,
        channel,
        lastFailure: event.lastFailure
      },
      'Video source fatal error'
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
