import { describe, expect, it, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import AudioAnomalyDetector from '../src/audio/anomaly.js';

interface CapturedEvent {
  detector: string;
  meta?: Record<string, unknown>;
}

describe('AudioAnomalyDetector', () => {
  const sampleRate = 16000;
  let bus: EventEmitter;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new EventEmitter();
    events = [];
    bus.on('event', payload => {
      events.push({ detector: payload.detector, meta: payload.meta });
    });
  });

  it('emits event when RMS exceeds threshold', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        rmsThreshold: 0.1,
        centroidJumpThreshold: 2000,
        minIntervalMs: 0
      },
      bus
    );

    const silence = new Int16Array(1024);
    const loud = new Int16Array(1024).map((_, i) => (i % 2 === 0 ? 16000 : -16000));

    detector.handleChunk(silence, 0);
    detector.handleChunk(loud, 1);

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('audio-anomaly');
    expect(events[0].meta?.triggeredBy).toBe('rms');
  });

  it('emits event on sharp spectral centroid change', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        rmsThreshold: 0.5,
        centroidJumpThreshold: 50,
        minIntervalMs: 0
      },
      bus
    );

    const toneLow = generateSineWave(sampleRate, 200, 0.2, 1024);
    const toneHigh = generateSineWave(sampleRate, 3000, 0.2, 1024);

    detector.handleChunk(toneLow, 0);
    detector.handleChunk(toneHigh, 1);

    expect(events).toHaveLength(1);
    expect(events[0].meta?.triggeredBy).toBe('centroid');
  });
});

function generateSineWave(sampleRate: number, frequency: number, amplitude: number, length: number) {
  const result = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    result[i] = Math.round(value * 32767);
  }
  return result;
}
