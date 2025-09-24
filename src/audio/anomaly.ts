import { EventEmitter } from 'node:events';
import Meyda from 'meyda';
import eventBus from '../eventBus.js';
import { EventPayload } from '../types.js';

export interface AudioAnomalyOptions {
  source: string;
  sampleRate?: number;
  rmsThreshold?: number;
  centroidJumpThreshold?: number;
  minIntervalMs?: number;
  frameSize?: number;
  hopSize?: number;
  minTriggerDurationMs?: number;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_RMS_THRESHOLD = 0.2;
const DEFAULT_CENTROID_JUMP = 150;
const DEFAULT_MIN_INTERVAL_MS = 1500;
const DEFAULT_FRAME_SIZE = 1024;
const DEFAULT_MIN_TRIGGER_DURATION_MS = 100;

export class AudioAnomalyDetector {
  private previousCentroid: number | null = null;
  private centroidReference: number | null = null;
  private lastEventTs = 0;
  private buffer: number[] = [];
  private readonly frameSize: number;
  private readonly hopSize: number;
  private readonly window: Float32Array;
  private rmsDurationMs = 0;
  private centroidDurationMs = 0;

  constructor(
    private readonly options: AudioAnomalyOptions,
    private readonly bus: EventEmitter = eventBus
  ) {
    this.frameSize = Math.max(1, options.frameSize ?? DEFAULT_FRAME_SIZE);
    const configuredHop = options.hopSize ?? Math.floor(this.frameSize / 2);
    this.hopSize = Math.min(this.frameSize, Math.max(1, configuredHop));
    this.window = createHanningWindow(this.frameSize);
  }

  handleChunk(samples: Int16Array, ts = Date.now()) {
    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const normalized = normalizeSamples(samples);
    for (let i = 0; i < normalized.length; i += 1) {
      this.buffer.push(normalized[i]);
    }

    const rmsThreshold = this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    const centroidJump = this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP;
    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const minTriggerDuration =
      this.options.minTriggerDurationMs ?? DEFAULT_MIN_TRIGGER_DURATION_MS;
    const frameDurationMs = (this.frameSize / sampleRate) * 1000;

    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.slice(0, this.frameSize);
      const windowed = applyWindow(frame, this.window);
      const features = Meyda.extract(['rms', 'spectralCentroid'], windowed, {
        sampleRate,
        bufferSize: this.frameSize
      });

      if (!features) {
        this.buffer.splice(0, this.hopSize);
        continue;
      }

      const rms = features.rms ?? 0;
      const centroid = features.spectralCentroid ?? 0;

      const triggeredByRms = rms > rmsThreshold;
      let triggeredByCentroid = false;
      if (this.previousCentroid !== null) {
        const diffPrev = Math.abs(centroid - this.previousCentroid);
        if (diffPrev >= centroidJump) {
          triggeredByCentroid = true;
          if (this.centroidReference === null) {
            this.centroidReference = this.previousCentroid;
          }
        } else if (this.centroidReference !== null) {
          const diffRef = Math.abs(centroid - this.centroidReference);
          if (diffRef >= centroidJump) {
            triggeredByCentroid = true;
          }
        }
      }

      this.previousCentroid = centroid;

      if (triggeredByRms) {
        this.rmsDurationMs += frameDurationMs;
      } else {
        this.rmsDurationMs = 0;
      }

      if (triggeredByCentroid) {
        this.centroidDurationMs += frameDurationMs;
      } else {
        this.centroidDurationMs = 0;
        this.centroidReference = centroid;
      }

      this.buffer.splice(0, this.hopSize);

      const rmsExceeded = this.rmsDurationMs >= minTriggerDuration;
      const centroidExceeded = this.centroidDurationMs >= minTriggerDuration;

      if (!rmsExceeded && !centroidExceeded) {
        continue;
      }

      if (ts - this.lastEventTs < minInterval) {
        continue;
      }

      const triggeredBy = rmsExceeded ? 'rms' : 'centroid';
      const triggeredDurationMs = rmsExceeded ? this.rmsDurationMs : this.centroidDurationMs;

      this.lastEventTs = ts;
      this.rmsDurationMs = 0;
      this.centroidDurationMs = 0;
      this.centroidReference = null;

      const payload: EventPayload = {
        ts,
        detector: 'audio-anomaly',
        source: this.options.source,
        severity: triggeredBy === 'rms' ? 'critical' : 'warning',
        message: triggeredBy === 'rms' ? 'High audio level detected' : 'Abrupt spectral change detected',
        meta: {
          rms,
          centroid,
          rmsThreshold,
          centroidJump,
          triggeredBy,
          window: {
            frameSize: this.frameSize,
            hopSize: this.hopSize
          },
          durationAboveThresholdMs: triggeredDurationMs
        }
      };

      this.bus.emit('event', payload);
      break;
    }
  }
}

function normalizeSamples(samples: Int16Array): Float32Array {
  const normalized = new Float32Array(samples.length);
  const scale = 1 / 32768;
  for (let i = 0; i < samples.length; i += 1) {
    normalized[i] = samples[i] * scale;
  }
  return normalized;
}

function createHanningWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1 || 1)));
  }
  return window;
}

function applyWindow(frame: number[], window: Float32Array): Float32Array {
  const result = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    result[i] = frame[i] * window[i];
  }
  return result;
}

export default AudioAnomalyDetector;
