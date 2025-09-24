import config from 'config';
import logger from '../logger.js';
import { persistFrame } from './debugSave.js';
import { ensureSampleVideo } from './sampleVideo.js';
import { VideoSource } from './source.js';

const videoConfig = config.get<{ testFile: string; framesPerSecond: number }>('video');

const videoFile = ensureSampleVideo(videoConfig.testFile);

const source = new VideoSource({
  file: videoFile,
  framesPerSecond: videoConfig.framesPerSecond,
  channel: 'video:sample'
});

logger.info({ file: videoFile, fps: videoConfig.framesPerSecond }, 'Starting video source');

source.on('frame', frame => {
  const stored = persistFrame(frame);
  logger.debug({ stored }, 'Frame persisted to disk');
});

source.on('error', error => {
  logger.error({ err: error }, 'Video source error');
});

source.on('end', () => {
  logger.warn('Video source ended');
});

source.start();
