import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-node';
import eventBus from '../eventBus.js';
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
};

const TARGET_SIZE = 640;
const PERSON_CLASS_INDEX = 0;
const OBJECTNESS_INDEX = 4;
const CLASS_START_INDEX = 5;
const DEFAULT_SCORE_THRESHOLD = 0.5;
const DEFAULT_NMS_IOU_THRESHOLD = 0.45;
const DEFAULT_MIN_INTERVAL_MS = 5000;

export class PersonDetector {
  private session: ort.InferenceSession | null = null;
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
        snapshot: snapshotPath
      }
    };

    this.bus.emit('event', payload);
  }

  private async ensureSession() {
    if (this.session) {
      return;
    }

    const session = await ort.InferenceSession.create(this.options.modelPath);
    this.session = session;
    this.inputName = session.inputNames[0] ?? null;
    this.outputName = session.outputNames[0] ?? null;
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
  const data = tensor.data as Float32Array | undefined;
  const dims = tensor.dims ?? [];

  if (!data || dims.length < 3) {
    return null;
  }

  const numDetections = dims[dims.length - 1];
  const numChannels = dims[dims.length - 2];

  if (numChannels <= CLASS_START_INDEX) {
    return null;
  }

  const classIndex = CLASS_START_INDEX + PERSON_CLASS_INDEX;

  if (classIndex >= numChannels) {
    return null;
  }

  const stride = numDetections;
  const candidates: Detection[] = [];

  for (let i = 0; i < numDetections; i += 1) {
    const objectness = data[OBJECTNESS_INDEX * stride + i];

    if (objectness <= 0) {
      continue;
    }

    const classScore = data[classIndex * stride + i] ?? 0;
    const score = objectness * classScore;

    if (score < threshold) {
      continue;
    }

    const cx = data[0 * stride + i];
    const cy = data[1 * stride + i];
    const w = data[2 * stride + i];
    const h = data[3 * stride + i];

    const bbox = projectBoundingBox(cx, cy, w, h, meta);

    if (bbox.width <= 0 || bbox.height <= 0) {
      continue;
    }

    candidates.push({
      score,
      classId: PERSON_CLASS_INDEX,
      bbox
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

function saveSnapshot(frame: Buffer, ts: number, dir?: string) {
  const folder = path.resolve(dir ?? 'snapshots');
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, `${ts}-person.png`);
  fs.writeFileSync(filePath, frame);
  return filePath;
}

export default PersonDetector;
