import config from 'config';
import logger from './logger.js';
import eventBus from './eventBus.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import MotionDetector from './video/motionDetector.js';
import PersonDetector from './video/personDetector.js';

const videoConfig = config.get<{ testFile: string; framesPerSecond: number }>('video');
const personConfig = config.get<{
  modelPath: string;
  score: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
}>('person');

const videoFile = ensureSampleVideo(videoConfig.testFile);

const source = new VideoSource({
  file: videoFile,
  framesPerSecond: videoConfig.framesPerSecond
});

const motionDetector = new MotionDetector({
  source: 'video:test-camera',
  diffThreshold: 25,
  areaThreshold: 0.015,
  minIntervalMs: 1500
});

const personDetector = await PersonDetector.create({
  source: 'video:test-camera',
  modelPath: personConfig.modelPath,
  scoreThreshold: personConfig.score,
  snapshotDir: personConfig.snapshotDir,
  minIntervalMs: 2000
});

const checkEvery = Math.max(1, personConfig.checkEveryNFrames ?? 3);
const maxDetections = Math.max(1, personConfig.maxDetections ?? 5);

let framesSinceMotion: number | null = null;
let detectionAttempts = 0;

logger.info({ file: videoFile }, 'Starting guard pipeline');

eventBus.on('event', payload => {
  if (payload.detector === 'motion') {
    framesSinceMotion = 0;
    detectionAttempts = 0;
  }
});

source.on('frame', async frame => {
  const ts = Date.now();

  try {
    motionDetector.handleFrame(frame, ts);
  } catch (error) {
    logger.error({ err: error }, 'Motion detector failed');
  }

  if (framesSinceMotion !== null) {
    framesSinceMotion += 1;
    const shouldDetect = framesSinceMotion === 1 || framesSinceMotion % checkEvery === 0;

    if (shouldDetect && detectionAttempts < maxDetections) {
      detectionAttempts += 1;
      try {
        await personDetector.handleFrame(frame, ts);
      } catch (error) {
        logger.error({ err: error }, 'Person detector failed');
      }
    }

    if (detectionAttempts >= maxDetections) {
      framesSinceMotion = null;
    }
  }
});

source.on('error', error => {
  logger.error({ err: error }, 'Video source error');
});

source.on('end', () => {
  logger.warn('Video source ended');
});

source.start();

process.on('SIGINT', () => {
  logger.info('Stopping guard pipeline');
  source.stop();
  process.exit(0);
});
