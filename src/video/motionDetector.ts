import { EventEmitter } from 'node:events';
import eventBus from '../eventBus.js';
import { EventPayload } from '../types.js';
import { diffAreaPercentage, readFrameAsGrayscale, GrayscaleFrame } from './utils.js';

export interface MotionDetectorOptions {
  source: string;
  diffThreshold?: number;
  areaThreshold?: number;
  minIntervalMs?: number;
}

const DEFAULT_DIFF_THRESHOLD = 25;
const DEFAULT_AREA_THRESHOLD = 0.02;
const DEFAULT_MIN_INTERVAL_MS = 2000;

export class MotionDetector {
  private previousFrame: GrayscaleFrame | null = null;
  private lastEventTs = 0;

  constructor(
    private readonly options: MotionDetectorOptions,
    private readonly bus: EventEmitter = eventBus
  ) {}

  handleFrame(frame: Buffer, ts = Date.now()) {
    const grayscale = readFrameAsGrayscale(frame);

    if (!this.previousFrame) {
      this.previousFrame = grayscale;
      return;
    }

    const diffThreshold = this.options.diffThreshold ?? DEFAULT_DIFF_THRESHOLD;
    const areaThreshold = this.options.areaThreshold ?? DEFAULT_AREA_THRESHOLD;

    const areaPct = diffAreaPercentage(this.previousFrame, grayscale, diffThreshold);

    this.previousFrame = grayscale;

    if (areaPct < areaThreshold) {
      return;
    }

    if (ts - this.lastEventTs < (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) {
      return;
    }

    this.lastEventTs = ts;

    const payload: EventPayload = {
      ts,
      detector: 'motion',
      source: this.options.source,
      severity: 'warning',
      message: 'Motion detected',
      meta: {
        areaPct,
        areaThreshold,
        diffThreshold
      }
    };

    this.bus.emit('event', payload);
  }
}

export default MotionDetector;
