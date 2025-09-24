import config from 'config';
import logger from './logger.js';
import eventBus from './eventBus.js';
import { ensureSampleVideo } from './video/sampleVideo.js';
import { VideoSource } from './video/source.js';
import LightDetector from './video/lightDetector.js';
import MotionDetector from './video/motionDetector.js';

const videoConfig = config.get<{ testFile: string; framesPerSecond: number }>('video');
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
});

source.on('error', error => {
  logger.error({ err: error }, 'Video source error');
});

source.on('end', () => {
  logger.warn('Video source ended');
});

source.start();

process.on('SIGINT', () => {
  logger.info('Stopping video detectors');
  source.stop();
  process.exit(0);
});
