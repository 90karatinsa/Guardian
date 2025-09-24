import { EventEmitter } from 'node:events';
import eventBus from '../eventBus.js';
import { EventPayload } from '../types.js';
import { averageLuminance, readFrameAsGrayscale } from './utils.js';

export interface LightDetectorOptions {
  source: string;
  deltaThreshold?: number;
  normalHours?: Array<{ start: number; end: number }>;
  smoothingFactor?: number;
  minIntervalMs?: number;
}

const DEFAULT_DELTA_THRESHOLD = 30;
const DEFAULT_SMOOTHING = 0.2;
const DEFAULT_MIN_INTERVAL_MS = 60000;

export class LightDetector {
  private baseline: number | null = null;
  private lastEventTs = 0;

  constructor(
    private readonly options: LightDetectorOptions,
    private readonly bus: EventEmitter = eventBus
  ) {}

  handleFrame(frame: Buffer, ts = Date.now()) {
    const grayscale = readFrameAsGrayscale(frame);
    const luminance = averageLuminance(grayscale);

    if (this.baseline === null) {
      this.baseline = luminance;
      return;
    }

    const smoothing = this.options.smoothingFactor ?? DEFAULT_SMOOTHING;
    this.baseline = this.baseline * (1 - smoothing) + luminance * smoothing;

    if (this.isWithinNormalHours(ts)) {
      return;
    }

    const deltaThreshold = this.options.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD;
    const delta = Math.abs(luminance - this.baseline);

    if (delta < deltaThreshold) {
      return;
    }

    if (ts - this.lastEventTs < (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) {
      return;
    }

    this.lastEventTs = ts;

    const payload: EventPayload = {
      ts,
      detector: 'light',
      source: this.options.source,
      severity: 'warning',
      message: 'Unexpected light level change detected',
      meta: {
        baseline: this.baseline,
        luminance,
        delta,
        deltaThreshold
      }
    };

    this.bus.emit('event', payload);
  }

  private isWithinNormalHours(ts: number) {
    const hours = this.options.normalHours;
    if (!hours || hours.length === 0) {
      return false;
    }

    const currentHour = new Date(ts).getHours();

    return hours.some(range => isHourWithinRange(currentHour, range.start, range.end));
  }
}

function isHourWithinRange(hour: number, start: number, end: number): boolean {
  const normalizedStart = normalizeHour(start);
  const normalizedEnd = normalizeHour(end);
  const normalizedHour = normalizeHour(hour);

  if (normalizedStart <= normalizedEnd) {
    return normalizedHour >= normalizedStart && normalizedHour < normalizedEnd;
  }

  // Overnight window (e.g. 22-6)
  return normalizedHour >= normalizedStart || normalizedHour < normalizedEnd;
}

function normalizeHour(hour: number) {
  return ((Math.floor(hour) % 24) + 24) % 24;
}

export default LightDetector;
