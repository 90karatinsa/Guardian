import * as ort from 'onnxruntime-node';
import { PNG } from 'pngjs';
import logger from '../logger.js';
import metrics from '../metrics/index.js';
import {
  FaceMatchResult,
  FaceRecord,
  deleteFace as deleteFaceRecord,
  findNearestFace,
  listFaces as listFaceRecords,
  storeFace
} from '../db.js';

export interface FaceRegistryOptions {
  modelPath: string;
  embeddingSize?: number;
}

type InferenceSessionLike = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
};

const DEFAULT_EMBEDDING_SIZE = 128;

export interface IdentifyResult {
  embedding: number[];
  match: FaceMatchResult | null;
  threshold: number;
  distance: number | null;
  unknown: boolean;
}

export class FaceRegistry {
  private session: InferenceSessionLike | null = null;
  private inputName: string | null = null;
  private outputName: string | null = null;
  private readonly embeddingSize: number;

  private constructor(private readonly options: FaceRegistryOptions) {
    this.embeddingSize = options.embeddingSize ?? DEFAULT_EMBEDDING_SIZE;
  }

  static async create(options: FaceRegistryOptions) {
    const registry = new FaceRegistry(options);
    await registry.ensureSession();
    return registry;
  }

  async enroll(image: Buffer, label: string, metadata?: Record<string, unknown>): Promise<FaceRecord> {
    metrics.incrementDetectorCounter('face', 'enrollments');
    const embedding = await this.extractEmbedding(image);
    if (embedding.length === 0) {
      metrics.recordDetectorError('face', 'empty-embedding');
    }
    const normalized = normalizeVector(embedding, this.embeddingSize);
    return storeFace({ label, embedding: normalized, metadata });
  }

  async identify(image: Buffer, threshold: number): Promise<IdentifyResult> {
    metrics.incrementDetectorCounter('face', 'identifications');
    const embedding = await this.extractEmbedding(image);
    if (embedding.length === 0) {
      metrics.recordDetectorError('face', 'empty-embedding');
    }
    const normalized = normalizeVector(embedding, this.embeddingSize);
    const normalizedThreshold = normalizeThreshold(threshold);
    const match = findNearestFace(normalized, normalizedThreshold);
    if (match) {
      metrics.incrementDetectorCounter('face', 'matches');
    } else {
      metrics.incrementDetectorCounter('face', 'misses');
    }
    return {
      embedding: normalized,
      match,
      threshold: normalizedThreshold,
      distance: match?.distance ?? null,
      unknown: !match
    };
  }

  list(): FaceRecord[] {
    return listFaceRecords();
  }

  remove(id: number): boolean {
    const removed = deleteFaceRecord(id);
    if (removed) {
      metrics.incrementDetectorCounter('face', 'removals');
    }
    return removed;
  }

  private async extractEmbedding(image: Buffer): Promise<number[]> {
    await this.ensureSession();
    metrics.incrementDetectorCounter('face', 'embeddingRuns');
    if (!this.session || !this.inputName || !this.outputName) {
      metrics.recordDetectorError('face', 'session-unavailable');
      return [];
    }

    const tensor = preprocessImage(image);
    const feeds: Record<string, ort.Tensor> = {
      [this.inputName]: tensor
    };

    let result: Record<string, ort.Tensor>;
    try {
      result = await this.session.run(feeds);
    } catch (error) {
      metrics.recordDetectorError('face', (error as Error).message ?? 'embedding-failed');
      throw error;
    }
    const output = result[this.outputName];

    if (!output) {
      metrics.recordDetectorError('face', 'missing-output');
      return [];
    }

    const data = output.data as Float32Array | number[] | undefined;
    if (!data) {
      metrics.recordDetectorError('face', 'empty-output');
      return [];
    }

    return Array.from(data).map(value => Number(value));
  }

  private async ensureSession() {
    if (this.session) {
      return;
    }

    try {
      const session = await ort.InferenceSession.create(this.options.modelPath);
      this.session = session as InferenceSessionLike;
    } catch (error) {
      logger.warn({ err: error, modelPath: this.options.modelPath }, 'Falling back to mock face embedding session');
      this.session = createMockSession(this.embeddingSize);
    }

    this.inputName = this.session.inputNames[0] ?? null;
    this.outputName = this.session.outputNames[0] ?? null;
  }
}

function preprocessImage(image: Buffer) {
  const png = PNG.sync.read(image);
  const { width, height, data } = png;
  const size = width * height;
  const channels = 3;
  const chw = new Float32Array(size * channels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcIndex = (y * width + x) * 4;
      const destIndex = y * width + x;
      const r = data[srcIndex] / 255;
      const g = data[srcIndex + 1] / 255;
      const b = data[srcIndex + 2] / 255;
      chw[destIndex] = r;
      chw[size + destIndex] = g;
      chw[2 * size + destIndex] = b;
    }
  }

  return new ort.Tensor('float32', chw, [1, channels, height, width]);
}

function normalizeVector(values: number[], size: number) {
  if (values.length < size) {
    const padded = new Array(size).fill(0);
    values.forEach((value, index) => {
      padded[index] = value;
    });
    values = padded;
  } else if (values.length > size) {
    values = values.slice(0, size);
  }

  const length = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0));
  if (!Number.isFinite(length) || length === 0) {
    return values.map(() => 0);
  }

  return values.map(value => value / length);
}

function normalizeThreshold(value: number) {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, value);
}

function createMockSession(embeddingSize: number): InferenceSessionLike {
  return {
    inputNames: ['image'],
    outputNames: ['embedding'],
    async run() {
      const data = new Float32Array(embeddingSize);
      for (let i = 0; i < embeddingSize; i += 1) {
        data[i] = (i + 1) / embeddingSize;
      }
      return {
        embedding: new ort.Tensor('float32', data, [1, embeddingSize])
      };
    }
  };
}

export default FaceRegistry;
