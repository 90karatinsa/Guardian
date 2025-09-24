import logger from './logger.js';
import eventBus from './eventBus.js';
import { AudioSource } from './audio/source.js';
import AudioAnomalyDetector from './audio/anomaly.js';

const source = new AudioSource({
  type: 'mic',
  frameDurationMs: 200,
  sampleRate: 16000
});

const detector = new AudioAnomalyDetector({
  source: 'audio:microphone',
  sampleRate: 16000,
  rmsThreshold: 0.25,
  centroidJumpThreshold: 200,
  minIntervalMs: 2000
});

logger.info('Starting audio anomaly detector');

eventBus.on('event', payload => {
  if (payload.detector === 'audio-anomaly') {
    logger.info({ meta: payload.meta }, 'Audio anomaly detected');
  }
});

source.on('data', samples => {
  detector.handleChunk(samples);
});

source.on('error', error => {
  logger.error({ err: error }, 'Audio source error');
});

source.on('stderr', data => {
  logger.debug({ ffmpeg: data });
});

source.on('close', code => {
  logger.warn({ code }, 'Audio source closed');
});

source.start();

process.on('SIGINT', () => {
  logger.info('Stopping audio detector');
  source.stop();
  process.exit(0);
});
