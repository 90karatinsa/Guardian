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
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_RMS_THRESHOLD = 0.2;
const DEFAULT_CENTROID_JUMP = 150;
const DEFAULT_MIN_INTERVAL_MS = 1500;

export class AudioAnomalyDetector {
  private previousCentroid: number | null = null;
  private lastEventTs = 0;

  constructor(
    private readonly options: AudioAnomalyOptions,
    private readonly bus: EventEmitter = eventBus
  ) {}

  handleChunk(samples: Int16Array, ts = Date.now()) {
    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const normalized = normalizeSamples(samples);
    const features = Meyda.extract(['rms', 'spectralCentroid'], normalized, {
      sampleRate,
      bufferSize: normalized.length
    });

    if (!features) {
      return;
    }

    const rmsThreshold = this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    const centroidJump = this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP;
    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

    const rms = features.rms ?? 0;
    const centroid = features.spectralCentroid ?? 0;

    const triggeredByRms = rms > rmsThreshold;
    const triggeredByCentroid =
      this.previousCentroid !== null && Math.abs(centroid - this.previousCentroid) >= centroidJump;

    this.previousCentroid = centroid;

    if (!triggeredByRms && !triggeredByCentroid) {
      return;
    }

    if (ts - this.lastEventTs < minInterval) {
      return;
    }

    this.lastEventTs = ts;

    const payload: EventPayload = {
      ts,
      detector: 'audio-anomaly',
      source: this.options.source,
      severity: triggeredByRms ? 'critical' : 'warning',
      message: triggeredByRms ? 'High audio level detected' : 'Abrupt spectral change detected',
      meta: {
        rms,
        centroid,
        rmsThreshold,
        centroidJump,
        triggeredBy: triggeredByRms ? 'rms' : 'centroid'
      }
    };

    this.bus.emit('event', payload);
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

export default AudioAnomalyDetector;
