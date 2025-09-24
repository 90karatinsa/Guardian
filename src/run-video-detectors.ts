import config from 'config';
import ffmpeg from 'fluent-ffmpeg';
import type { Readable } from 'node:stream';
import logger from './logger.js';
import eventBus from './eventBus.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import LightDetector from './video/lightDetector.js';
import MotionDetector from './video/motionDetector.js';
import PersonDetector from './video/personDetector.js';
import type { CameraFfmpegConfig, PersonConfig, VideoConfig } from './config/index.js';

const videoConfig = config.get<VideoConfig>('video');
const personConfig = config.get<PersonConfig>('person');
const sampleSource = videoConfig.testFile ?? 'assets/test-video.mp4';
const videoFile = ensureSampleVideo(sampleSource);
const ffmpegConfig: CameraFfmpegConfig | undefined = videoConfig.ffmpeg;

const source = new VideoSource({
  file: videoFile,
  framesPerSecond: videoConfig.framesPerSecond,
  startTimeoutMs: ffmpegConfig?.startTimeoutMs,
  watchdogTimeoutMs: ffmpegConfig?.watchdogTimeoutMs,
  forceKillTimeoutMs: ffmpegConfig?.forceKillTimeoutMs,
  restartDelayMs: ffmpegConfig?.restartDelayMs,
  restartMaxDelayMs: ffmpegConfig?.restartMaxDelayMs,
  restartJitterFactor: ffmpegConfig?.restartJitterFactor,
  commandFactory: ({ file, framesPerSecond }) =>
    ffmpeg(file)
      .inputOptions('-stream_loop', '-1')
      .outputOptions('-vf', `fps=${framesPerSecond}`)
      .outputOptions('-f', 'image2pipe')
      .outputOptions('-vcodec', 'png')
});

const simulateWatchdog = process.env.GUARDIAN_SIMULATE_VIDEO_WATCHDOG ?? '1';

const parseMs = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stallDelayMs = parseMs(process.env.GUARDIAN_SIMULATE_VIDEO_WATCHDOG_DELAY_MS, 2000);
const stallDurationMs = parseMs(process.env.GUARDIAN_SIMULATE_VIDEO_WATCHDOG_DURATION_MS, 7000);

async function main() {
  const personDetector = await PersonDetector.create({
    source: 'video:test-camera',
    modelPath: personConfig.modelPath,
    scoreThreshold: personConfig.score,
    snapshotDir: personConfig.snapshotDir,
    minIntervalMs: personConfig.minIntervalMs
  });

  if (simulateWatchdog !== '0') {
    source.once('stream', (stream: Readable) => {
      setTimeout(() => {
        if (stream.destroyed) {
          return;
        }

        logger.warn(
          { stallDurationMs },
          'Pausing video stream to simulate watchdog timeout'
        );
        stream.pause();

        if (stallDurationMs > 0) {
          setTimeout(() => {
            if (stream.destroyed) {
              return;
            }

            logger.info('Resuming video stream after stall simulation');
            stream.resume();
          }, stallDurationMs);
        }
      }, Math.max(0, stallDelayMs));
    });
  }

  const motionDetector = new MotionDetector({
    source: 'video:test-camera',
    diffThreshold: 25,
    areaThreshold: 0.015,
    minIntervalMs: 1500
  });

  const lightDetector = new LightDetector({
    source: 'video:test-camera',
    deltaThreshold: 40,
    normalHours: [
      { start: 7, end: 22 }
    ],
    smoothingFactor: 0.1,
    minIntervalMs: 30000
  });

  logger.info({ file: videoFile }, 'Starting video detectors');

  eventBus.on('event', payload => {
    logger.info({ detector: payload.detector, meta: payload.meta }, 'Detector event');
  });

  source.on('frame', frame => {
    motionDetector.handleFrame(frame);
    lightDetector.handleFrame(frame);
    personDetector.handleFrame(frame).catch(error => {
      logger.error({ err: error }, 'Person detector failed');
    });
  });

  source.on('error', error => {
    logger.error({ err: error }, 'Video source error');
  });

  source.on('end', () => {
    logger.warn('Video source ended');
  });

  source.on('recover', info => {
    logger.warn(
      { reason: info.reason, attempt: info.attempt, delayMs: info.delayMs },
      `Video source reconnecting (reason=${info.reason})`
    );
  });

  source.start();

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'Stopping video detectors');
    source.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  logger.error({ err: error }, 'Failed to run video detectors demo');
  process.exit(1);
});
