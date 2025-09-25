import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-node';
import eventBus from '../eventBus.js';
import logger from '../logger.js';
import metrics from '../metrics/index.js';
import { EventPayload } from '../types.js';
import {
  DEFAULT_NMS_IOU_THRESHOLD,
  YOLO_CLASS_START_INDEX,
  parseYoloDetections
} from './yoloParser.js';
import type { PreprocessMeta, YoloDetection } from './yoloParser.js';
import ObjectClassifier, { ClassifiedObject } from './objectClassifier.js';

export interface PersonDetectorOptions {
  source: string;
  modelPath: string;
  scoreThreshold?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
  maxDetections?: number;
  classIndices?: number[];
  objectClassifier?: ObjectClassifier;
}

const TARGET_SIZE = 640;
const PERSON_CLASS_INDEX = 0;
const DEFAULT_SCORE_THRESHOLD = 0.5;
const DEFAULT_MIN_INTERVAL_MS = 5000;

type InferenceSessionLike = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
};

export class PersonDetector {
  private session: InferenceSessionLike | null = null;
  private inputName: string | null = null;
  private outputName: string | null = null;
  private lastEventTs = 0;
  private readonly classIndices: number[];
  private readonly objectClassifier?: ObjectClassifier;

  private constructor(
    private readonly options: PersonDetectorOptions,
    private readonly bus: EventEmitter
  ) {
    const indices = Array.isArray(options.classIndices) ? options.classIndices : [PERSON_CLASS_INDEX];
    const sanitized = indices
      .map(value => Math.max(0, Math.trunc(value)))
      .filter(value => Number.isFinite(value));
    this.classIndices = Array.from(new Set(sanitized.length > 0 ? sanitized : [PERSON_CLASS_INDEX]));
    this.objectClassifier = options.objectClassifier;
  }

  static async create(options: PersonDetectorOptions, bus: EventEmitter = eventBus) {
    const detector = new PersonDetector(options, bus);
    await detector.ensureSession();
    return detector;
  }

  async handleFrame(frame: Buffer, ts = Date.now()) {
    const start = performance.now();
    try {
      await this.ensureSession();

      if (!this.session || !this.inputName || !this.outputName) {
        return;
      }

      if (ts - this.lastEventTs < (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) {
        return;
      }

      const { tensor, meta } = preprocessFrame(frame);
      const feeds: Record<string, ort.Tensor> = {
        [this.inputName]: tensor
      };

      const results = await this.session.run(feeds);
      const output = results[this.outputName];

      if (!output) {
        return;
      }

      const detections = parseYoloDetections(output, meta, {
        classIndices: this.classIndices,
        scoreThreshold: this.options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
        nmsThreshold: DEFAULT_NMS_IOU_THRESHOLD,
        maxDetections: this.options.maxDetections
      });

      const personDetections = detections.filter(candidate => candidate.classId === PERSON_CLASS_INDEX);
      const nonPersonDetections = detections.filter(candidate => candidate.classId !== PERSON_CLASS_INDEX);

      if (personDetections.length === 0) {
        return;
      }

      const primaryDetection = personDetections[0];
      const snapshotPath = saveSnapshot(frame, ts, this.options.snapshotDir);
      this.lastEventTs = ts;

      let classifiedObjects: ClassifiedObject[] = [];
      if (this.objectClassifier && nonPersonDetections.length > 0) {
        classifiedObjects = await this.objectClassifier.classify(nonPersonDetections);
      }

      const payload: EventPayload = {
        ts,
        source: this.options.source,
        detector: 'person',
        severity: 'critical',
        message: 'Person detected',
        meta: {
          score: primaryDetection.score,
          classId: primaryDetection.classId,
          bbox: primaryDetection.bbox,
          snapshot: snapshotPath,
          objectness: primaryDetection.objectness,
          classProbability: primaryDetection.classProbability,
          areaRatio: primaryDetection.areaRatio,
          thresholds: {
            score: this.options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
            nms: DEFAULT_NMS_IOU_THRESHOLD
          },
          detections: personDetections.map(serializeDetection)
        }
      };

      if (classifiedObjects.length > 0) {
        const objects = classifiedObjects.map(object => ({
          label: object.label,
          score: object.score,
          threat: object.isThreat,
          threatScore: object.threatScore,
          detection: serializeDetection(object.detection),
          probabilities: object.probabilities
        }));
        const threat = classifiedObjects.find(object => object.isThreat);
        payload.meta!.objects = objects;
        if (threat) {
          payload.meta!.threat = {
            label: threat.label,
            score: threat.threatScore
          };
        }
      }

      this.bus.emit('event', payload);
    } finally {
      metrics.observeDetectorLatency('person', performance.now() - start);
    }
  }

  private async ensureSession() {
    if (this.session) {
      return;
    }

    try {
      const session = await ort.InferenceSession.create(this.options.modelPath);
      this.session = session as InferenceSessionLike;
    } catch (error) {
      if (!isMissingModelError(error)) {
        throw error;
      }

      this.session = createMockSession(this.options.modelPath);
    }

    this.inputName = this.session.inputNames[0] ?? null;
    this.outputName = this.session.outputNames[0] ?? null;
  }
}

function serializeDetection(detection: YoloDetection) {
  return {
    score: detection.score,
    classId: detection.classId,
    bbox: detection.bbox,
    objectness: detection.objectness,
    classProbability: detection.classProbability,
    areaRatio: detection.areaRatio
  };
}

function preprocessFrame(frame: Buffer): { tensor: ort.Tensor; meta: PreprocessMeta } {
  const image = PNG.sync.read(frame);
  const { width, height, data } = image;

  const scale = Math.min(TARGET_SIZE / width, TARGET_SIZE / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  const padX = Math.floor((TARGET_SIZE - resizedWidth) / 2);
  const padY = Math.floor((TARGET_SIZE - resizedHeight) / 2);

  const pixels = TARGET_SIZE * TARGET_SIZE;
  const chw = new Float32Array(3 * pixels).fill(0);

  for (let y = 0; y < resizedHeight; y += 1) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < resizedWidth; x += 1) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const destX = x + padX;
      const destY = y + padY;
      const destIndex = destY * TARGET_SIZE + destX;
      const srcIndex = (srcY * width + srcX) * 4;

      const r = data[srcIndex] / 255;
      const g = data[srcIndex + 1] / 255;
      const b = data[srcIndex + 2] / 255;

      chw[destIndex] = r;
      chw[pixels + destIndex] = g;
      chw[2 * pixels + destIndex] = b;
    }
  }

  const tensor = new ort.Tensor('float32', chw, [1, 3, TARGET_SIZE, TARGET_SIZE]);

  return {
    tensor,
    meta: {
      scale,
      padX,
      padY,
      originalWidth: width,
      originalHeight: height
    }
  };
}

function probabilityToLogit(probability: number) {
  const clamped = clamp(probability, 1e-6, 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

function isMissingModelError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const nodeError = error as NodeJS.ErrnoException;
  if (typeof nodeError.code === 'string' && nodeError.code.toLowerCase() === 'enoent') {
    return true;
  }

  const message = typeof nodeError.message === 'string' ? nodeError.message.toLowerCase() : '';
  return message.includes("file doesn't exist") || message.includes('no such file');
}

let mockWarningLogged = false;

function createMockSession(modelPath: string): InferenceSessionLike {
  if (!mockWarningLogged) {
    logger.warn({ modelPath }, 'Falling back to mock person detector session');
    mockWarningLogged = true;
  }

  const attributes = YOLO_CLASS_START_INDEX + 1;
  const detections = 1;

  return {
    inputNames: ['images'],
    outputNames: ['output0'],
    async run() {
      const data = new Float32Array(attributes * detections);
      const cx = TARGET_SIZE / 2;
      const cy = TARGET_SIZE / 2;
      const width = TARGET_SIZE * 0.5;
      const height = TARGET_SIZE * 0.6;

      data[0] = cx;
      data[1] = cy;
      data[2] = width;
      data[3] = height;
      data[4] = probabilityToLogit(0.95);
      data[YOLO_CLASS_START_INDEX] = probabilityToLogit(0.9);

      return {
        output0: new ort.Tensor('float32', data, [1, attributes, detections])
      };
    }
  };
}

function saveSnapshot(frame: Buffer, ts: number, dir?: string) {
  const folder = path.resolve(dir ?? 'snapshots');
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, `${ts}-person.png`);
  fs.writeFileSync(filePath, frame);
  return filePath;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default PersonDetector;
