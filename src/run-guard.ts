import config from 'config';
import { EventEmitter } from 'node:events';
import loggerModule from './logger.js';
import defaultBus from './eventBus.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import MotionDetector from './video/motionDetector.js';
import PersonDetector from './video/personDetector.js';

type CameraPersonConfig = {
  score?: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
};

type CameraConfig = {
  id: string;
  channel?: string;
  input?: string;
  framesPerSecond?: number;
  person?: CameraPersonConfig;
};

type VideoConfig = {
  framesPerSecond: number;
  cameras?: CameraConfig[];
  testFile?: string;
};

type PersonConfig = {
  modelPath: string;
  score: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
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
};

type GuardConfig = {
  video: VideoConfig;
  person: PersonConfig;
};

type GuardLogger = Pick<typeof loggerModule, 'info' | 'warn' | 'error'>;

export interface GuardStartOptions {
  config?: GuardConfig;
  bus?: EventEmitter;
  logger?: GuardLogger;
}

export type GuardRuntime = {
  stop: () => void;
  pipelines: Map<string, CameraRuntime>;
};

const DEFAULT_CHECK_EVERY = 3;
const DEFAULT_MAX_DETECTIONS = 5;

export async function startGuard(options: GuardStartOptions = {}): Promise<GuardRuntime> {
  const bus = options.bus ?? defaultBus;
  const logger = options.logger ?? loggerModule;

  const configSource = options.config ?? {
    video: config.get<VideoConfig>('video'),
    person: config.get<PersonConfig>('person')
  };

  const videoConfig = configSource.video;
  const personConfig = configSource.person;

  const cameras = buildCameraList(videoConfig);

  if (cameras.length === 0) {
    throw new Error('No cameras configured');
  }

  const pipelines = new Map<string, CameraRuntime>();

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

    const source = new VideoSource({
      file: input,
      framesPerSecond: fps
    });

    const motionDetector = new MotionDetector({
      source: channel,
      diffThreshold: 25,
      areaThreshold: 0.015,
      minIntervalMs: 1500
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
    for (const runtime of pipelines.values()) {
      runtime.source.stop();
    }
    pipelines.clear();
  };

  return { stop, pipelines };
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

function hasScheme(input: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input);
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
      { camera: runtime.id, attempt: event.attempt, reason: event.reason },
      'Video source reconnecting'
    );
  });

  source.on('end', () => {
    logger.warn({ camera: runtime.id }, 'Video source ended');
  });
}

if (process.env.NODE_ENV !== 'test' || process.env.GUARDIAN_FORCE_GUARD === '1') {
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
