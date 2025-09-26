import config from 'config';
import logger from './logger.js';
import eventBus from './eventBus.js';
import { AudioSource } from './audio/source.js';
import AudioAnomalyDetector from './audio/anomaly.js';
import type { AudioConfig } from './config/index.js';

const audioConfig: AudioConfig | undefined = config.has('audio')
  ? config.get<AudioConfig>('audio')
  : undefined;

const parseEnvInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const simulateDiscoveryTimeout = process.env.GUARDIAN_SIMULATE_AUDIO_DEVICE_TIMEOUT ?? '1';
const discoveryDelayMs = parseEnvInt(
  process.env.GUARDIAN_SIMULATE_AUDIO_DEVICE_TIMEOUT_DELAY_MS,
  1500
);

const source = new AudioSource({
  type: 'mic',
  channel: 'audio:microphone',
  frameDurationMs: 200,
  sampleRate: 16000,
  idleTimeoutMs: audioConfig?.idleTimeoutMs,
  startTimeoutMs: audioConfig?.startTimeoutMs,
  watchdogTimeoutMs: audioConfig?.watchdogTimeoutMs,
  restartDelayMs: audioConfig?.restartDelayMs,
  restartMaxDelayMs: audioConfig?.restartMaxDelayMs,
  restartJitterFactor: audioConfig?.restartJitterFactor,
  forceKillTimeoutMs: audioConfig?.forceKillTimeoutMs,
  deviceDiscoveryTimeoutMs: audioConfig?.deviceDiscoveryTimeoutMs,
  micFallbacks: audioConfig?.micFallbacks
});

const anomalyConfig = audioConfig?.anomaly;

const detector = new AudioAnomalyDetector({
  source: 'audio:microphone',
  sampleRate: anomalyConfig?.sampleRate ?? 16000,
  frameDurationMs: anomalyConfig?.frameDurationMs,
  hopDurationMs: anomalyConfig?.hopDurationMs,
  frameSize: anomalyConfig?.frameSize,
  hopSize: anomalyConfig?.hopSize,
  rmsThreshold: anomalyConfig?.rmsThreshold ?? 0.25,
  centroidJumpThreshold: anomalyConfig?.centroidJumpThreshold ?? 200,
  minIntervalMs: anomalyConfig?.minIntervalMs ?? 2000,
  minTriggerDurationMs: anomalyConfig?.minTriggerDurationMs,
  rmsWindowMs: anomalyConfig?.rmsWindowMs,
  centroidWindowMs: anomalyConfig?.centroidWindowMs,
  thresholds: anomalyConfig?.thresholds,
  nightHours: anomalyConfig?.nightHours
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

source.on('recover', event => {
  if (event.reason === 'ffmpeg-missing') {
    logger.warn(
      { attempt: event.attempt, delayMs: event.delayMs },
      `ffmpeg missing, retrying in ${event.delayMs}ms`
    );
  } else {
    logger.warn(
      { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason },
      `Audio source recovering, retrying in ${event.delayMs}ms`
    );
  }
});

source.on('stderr', data => {
  logger.debug({ ffmpeg: data });
});

source.on('close', code => {
  logger.warn({ code }, 'Audio source closed');
});

const mockIdleMs = Number.parseInt(process.env.MOCK_IDLE_MS ?? '', 10);
if (Number.isFinite(mockIdleMs) && mockIdleMs > 0) {
  source.once('stream', stream => {
    setTimeout(() => {
      if (stream.destroyed) {
        return;
      }
      logger.warn({ idleMs: mockIdleMs }, 'Pausing audio stream to simulate idle timeout');
      stream.pause();
    }, mockIdleMs);
  });
}

source.start();

if (simulateDiscoveryTimeout !== '0') {
  setTimeout(() => {
    source.triggerDeviceDiscoveryTimeout(
      new Error('Simulated audio device discovery timeout')
    );
  }, Math.max(0, discoveryDelayMs));
}

process.on('SIGINT', () => {
  logger.info('Stopping audio detector');
  source.stop();
  process.exit(0);
});
