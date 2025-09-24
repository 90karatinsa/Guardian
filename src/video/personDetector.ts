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

export interface PersonDetectorOptions {
  source: string;
  modelPath: string;
  scoreThreshold?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
}

type PreprocessMeta = {
  scale: number;
  padX: number;
  padY: number;
  originalWidth: number;
  originalHeight: number;
};

type BoundingBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type Detection = {
  score: number;
  classId: number;
  bbox: BoundingBox;
  objectness: number;
  classProbability: number;
  areaRatio: number;
};

type TensorAccessor = {
  detections: number;
  attributes: number;
  get: (detectionIndex: number, attributeIndex: number) => number;
};

const TARGET_SIZE = 640;
const PERSON_CLASS_INDEX = 0;
const OBJECTNESS_INDEX = 4;
const CLASS_START_INDEX = 5;
const DEFAULT_SCORE_THRESHOLD = 0.5;
const DEFAULT_NMS_IOU_THRESHOLD = 0.45;
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

  private constructor(
    private readonly options: PersonDetectorOptions,
    private readonly bus: EventEmitter
  ) {}

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

      const detection = pickBestPerson(
        output,
        this.options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
        meta
      );

      if (!detection) {
        return;
      }

      const snapshotPath = saveSnapshot(frame, ts, this.options.snapshotDir);
      this.lastEventTs = ts;

      const payload: EventPayload = {
        ts,
        source: this.options.source,
        detector: 'person',
        severity: 'critical',
        message: 'Person detected',
        meta: {
          score: detection.score,
          classId: detection.classId,
          bbox: detection.bbox,
          snapshot: snapshotPath,
          objectness: detection.objectness,
          classProbability: detection.classProbability,
          areaRatio: detection.areaRatio,
          thresholds: {
            score: this.options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD
          }
        }
      };

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

function pickBestPerson(
  tensor: ort.OnnxValue,
  threshold: number,
  meta: PreprocessMeta
): Detection | null {
  const accessor = createTensorAccessor(tensor);

  if (!accessor) {
    return null;
  }

  const classIndex = CLASS_START_INDEX + PERSON_CLASS_INDEX;

  if (classIndex >= accessor.attributes) {
    return null;
  }

  const candidates: Detection[] = [];

  for (let i = 0; i < accessor.detections; i += 1) {
    const objectnessLogit = accessor.get(i, OBJECTNESS_INDEX);
    const classLogit = accessor.get(i, classIndex);
    const objectness = sigmoid(objectnessLogit);
    const classProbability = sigmoid(classLogit);
    const score = clamp(objectness * classProbability, 0, 1);

    if (score < threshold) {
      continue;
    }

    const cx = accessor.get(i, 0);
    const cy = accessor.get(i, 1);
    const w = accessor.get(i, 2);
    const h = accessor.get(i, 3);

    const bbox = projectBoundingBox(cx, cy, w, h, meta);

    if (bbox.width <= 0 || bbox.height <= 0) {
      continue;
    }

    const areaRatio = computeAreaRatio(bbox, meta);

    candidates.push({
      score,
      classId: PERSON_CLASS_INDEX,
      bbox,
      objectness,
      classProbability,
      areaRatio
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const selected = nonMaxSuppression(
    candidates,
    DEFAULT_NMS_IOU_THRESHOLD
  );

  return selected[0] ?? null;
}

function createTensorAccessor(tensor: ort.OnnxValue): TensorAccessor | null {
  const data = tensor.data as Float32Array | undefined;

  if (!data || data.length === 0) {
    return null;
  }

  const dims = tensor.dims ?? [];
  const dimsNoBatch = dims.length > 0 && dims[0] === 1 ? dims.slice(1) : dims;
  const totalSize = data.length;
  const candidates: TensorAccessor[] = [];

  if (dimsNoBatch.length >= 1) {
    const attributesFirst = dimsNoBatch[0];
    const detectionsFirst =
      dimsNoBatch.length > 1
        ? dimsNoBatch.slice(1).reduce((acc, value) => acc * value, 1)
        : 1;

    if (attributesFirst > 0 && detectionsFirst > 0 && attributesFirst * detectionsFirst === totalSize) {
      candidates.push({
        attributes: attributesFirst,
        detections: detectionsFirst,
        get: (detectionIndex, attributeIndex) => {
          if (attributeIndex >= attributesFirst || detectionIndex >= detectionsFirst) {
            return 0;
          }

          return data[attributeIndex * detectionsFirst + detectionIndex];
        }
      });
    }
  }

  if (dimsNoBatch.length >= 1) {
    const attributesLast = dimsNoBatch[dimsNoBatch.length - 1];
    const detectionsLast =
      dimsNoBatch.length > 1
        ? dimsNoBatch.slice(0, -1).reduce((acc, value) => acc * value, 1)
        : 1;

    if (attributesLast > 0 && detectionsLast > 0 && attributesLast * detectionsLast === totalSize) {
      candidates.push({
        attributes: attributesLast,
        detections: detectionsLast,
        get: (detectionIndex, attributeIndex) => {
          if (attributeIndex >= attributesLast || detectionIndex >= detectionsLast) {
            return 0;
          }

          return data[detectionIndex * attributesLast + attributeIndex];
        }
      });
    }
  }

  if (candidates.length === 0 && dimsNoBatch.length === 0) {
    const attributes = totalSize;
    if (attributes > CLASS_START_INDEX) {
      return {
        attributes,
        detections: 1,
        get: (_detectionIndex, attributeIndex) => data[attributeIndex] ?? 0
      };
    }
  }

  const valid = candidates.filter(candidate => candidate.attributes > CLASS_START_INDEX && candidate.detections > 0);

  if (valid.length === 0) {
    return null;
  }

  valid.sort((a, b) => a.attributes - b.attributes);

  return valid[0];
}

function projectBoundingBox(
  cx: number,
  cy: number,
  width: number,
  height: number,
  meta: PreprocessMeta
) {
  const left = cx - width / 2;
  const top = cy - height / 2;
  const right = cx + width / 2;
  const bottom = cy + height / 2;

  const scale = meta.scale || 1;

  const mappedLeft = (left - meta.padX) / scale;
  const mappedTop = (top - meta.padY) / scale;
  const mappedRight = (right - meta.padX) / scale;
  const mappedBottom = (bottom - meta.padY) / scale;

  const clampedLeft = clamp(mappedLeft, 0, meta.originalWidth);
  const clampedTop = clamp(mappedTop, 0, meta.originalHeight);
  const clampedRight = clamp(mappedRight, 0, meta.originalWidth);
  const clampedBottom = clamp(mappedBottom, 0, meta.originalHeight);

  return {
    left: clampedLeft,
    top: clampedTop,
    width: Math.max(0, clampedRight - clampedLeft),
    height: Math.max(0, clampedBottom - clampedTop)
  };
}

function nonMaxSuppression(detections: Detection[], threshold: number) {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const results: Detection[] = [];

  for (const detection of sorted) {
    let keep = true;

    for (const existing of results) {
      const iou = intersectionOverUnion(detection.bbox, existing.bbox);
      if (iou > threshold) {
        keep = false;
        break;
      }
    }

    if (keep) {
      results.push(detection);
    }
  }

  return results;
}

function computeAreaRatio(bbox: BoundingBox, meta: PreprocessMeta) {
  const totalArea = meta.originalWidth * meta.originalHeight;

  if (totalArea <= 0) {
    return 0;
  }

  const area = Math.max(0, bbox.width) * Math.max(0, bbox.height);
  return clamp(area / totalArea, 0, 1);
}

function intersectionOverUnion(a: BoundingBox, b: BoundingBox) {
  const aRight = a.left + a.width;
  const aBottom = a.top + a.height;
  const bRight = b.left + b.width;
  const bBottom = b.top + b.height;

  const interLeft = Math.max(a.left, b.left);
  const interTop = Math.max(a.top, b.top);
  const interRight = Math.min(aRight, bRight);
  const interBottom = Math.min(aBottom, bBottom);

  const interWidth = Math.max(0, interRight - interLeft);
  const interHeight = Math.max(0, interBottom - interTop);
  const interArea = interWidth * interHeight;

  if (interArea === 0) {
    return 0;
  }

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;

  const union = areaA + areaB - interArea;

  if (union <= 0) {
    return 0;
  }

  return interArea / union;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
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

  const attributes = CLASS_START_INDEX + 1;
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
      data[OBJECTNESS_INDEX] = probabilityToLogit(0.95);
      data[CLASS_START_INDEX + PERSON_CLASS_INDEX] = probabilityToLogit(0.9);

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

export default PersonDetector;
