import * as ort from 'onnxruntime-node';
import logger from '../logger.js';
import metrics from '../metrics/index.js';
import { YoloDetection } from './yoloParser.js';

export interface ObjectClassifierOptions {
  modelPath: string;
  labels: string[];
  threatLabels?: string[];
  threatThreshold?: number;
}

type InferenceSessionLike = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
};

export interface ClassifiedObject {
  detection: YoloDetection;
  label: string;
  score: number;
  probabilities: Record<string, number>;
  threatScore: number;
  isThreat: boolean;
}

export type ThreatSummaryEntry = {
  label: string | null;
  threatScore: number;
  isThreat: boolean;
};

export type ThreatSummary = {
  objects: ThreatSummaryEntry[];
  maxThreatScore: number;
  maxThreatLabel: string | null;
  averageThreatScore: number;
  totalDetections: number;
};

const DEFAULT_THREAT_THRESHOLD = 0.6;

export class ObjectClassifier {
  private session: InferenceSessionLike | null = null;
  private inputName: string | null = null;
  private outputName: string | null = null;
  private readonly threatLabels: Set<string>;
  private readonly threatThreshold: number;

  private constructor(private readonly options: ObjectClassifierOptions) {
    this.threatLabels = new Set(options.threatLabels ?? ['threat']);
    this.threatThreshold = options.threatThreshold ?? DEFAULT_THREAT_THRESHOLD;
  }

  static async create(options: ObjectClassifierOptions) {
    const classifier = new ObjectClassifier(options);
    await classifier.ensureSession();
    return classifier;
  }

  async classify(detections: YoloDetection[]): Promise<ClassifiedObject[]> {
    if (detections.length === 0) {
      return [];
    }

    metrics.incrementDetectorCounter('object', 'invocations');
    metrics.incrementDetectorCounter('object', 'detections', detections.length);

    await this.ensureSession();
    if (!this.session || !this.inputName || !this.outputName) {
      metrics.recordDetectorError('object', 'session-unavailable');
      return [];
    }

    const features = buildFeatureTensor(detections);
    const feeds: Record<string, ort.Tensor> = {
      [this.inputName]: features
    };

    let results: Record<string, ort.Tensor>;
    try {
      results = await this.session.run(feeds);
    } catch (error) {
      metrics.recordDetectorError('object', (error as Error).message ?? 'inference-failed');
      logger.error({ err: error }, 'Object classifier inference failed');
      return [];
    }

    const output = results[this.outputName];
    if (!output) {
      metrics.recordDetectorError('object', 'missing-output');
      return [];
    }

    const data = output.data as Float32Array | number[] | undefined;
    if (!data) {
      metrics.recordDetectorError('object', 'empty-output');
      return [];
    }

    const labels = this.options.labels;
    const labelCount = labels.length;
    const scores = Array.from(data, value => Number(value));
    const objects: ClassifiedObject[] = [];

    for (let index = 0; index < detections.length; index += 1) {
      const detection = detections[index];
      const start = index * labelCount;
      const end = start + labelCount;
      const logits = scores.slice(start, end);
      const probabilities = softmax(logits);
      let bestIndex = 0;
      let bestScore = probabilities[0] ?? 0;
      for (let i = 1; i < probabilities.length; i += 1) {
        if (probabilities[i] > bestScore) {
          bestScore = probabilities[i];
          bestIndex = i;
        }
      }

      const probabilityMap: Record<string, number> = {};
      for (let i = 0; i < labels.length; i += 1) {
        probabilityMap[labels[i]] = probabilities[i] ?? 0;
      }

      const label = labels[bestIndex] ?? `class-${bestIndex}`;
      const detectionConfidence = clamp(
        Math.max(0, Math.min(1, detection.score), Math.min(1, detection.objectness ?? 0), Math.min(1, detection.classProbability)),
        0,
        1
      );
      const threatProbability = this.resolveThreatProbability(label, probabilityMap);
      const threatScore = clamp(threatProbability * detectionConfidence, 0, 1);
      const isThreat = threatScore >= this.threatThreshold;

      objects.push({
        detection: detections[index],
        label,
        score: bestScore,
        probabilities: probabilityMap,
        threatScore,
        isThreat
      });
    }

    metrics.incrementDetectorCounter('object', 'classifications', objects.length);
    const threatCount = objects.filter(object => object.isThreat).length;
    if (threatCount > 0) {
      metrics.incrementDetectorCounter('object', 'threats', threatCount);
    }

    return objects;
  }

  private resolveThreatProbability(label: string, probabilities: Record<string, number>) {
    let maxThreat = 0;
    if (this.threatLabels.has(label)) {
      maxThreat = Math.max(maxThreat, probabilities[label] ?? 0);
    }

    for (const threat of this.threatLabels) {
      const score = probabilities[threat];
      if (typeof score === 'number' && score > maxThreat) {
        maxThreat = score;
      }
    }

    return clamp(maxThreat, 0, 1);
  }

  private async ensureSession() {
    if (this.session) {
      return;
    }

    try {
      const session = await ort.InferenceSession.create(this.options.modelPath);
      this.session = session as InferenceSessionLike;
    } catch (error) {
      logger.warn({ err: error, modelPath: this.options.modelPath }, 'Falling back to mock object classifier');
      this.session = createMockSession(this.options.labels.length);
    }

    this.inputName = this.session.inputNames[0] ?? null;
    this.outputName = this.session.outputNames[0] ?? null;
  }
}

function buildFeatureTensor(detections: YoloDetection[]) {
  const featureCount = 5;
  const data = new Float32Array(detections.length * featureCount);

  for (let i = 0; i < detections.length; i += 1) {
    const detection = detections[i];
    const base = i * featureCount;
    data[base] = detection.score;
    data[base + 1] = detection.areaRatio;
    data[base + 2] = detection.bbox.width;
    data[base + 3] = detection.bbox.height;
    data[base + 4] = detection.classId;
  }

  return new ort.Tensor('float32', data, [detections.length, featureCount]);
}

function softmax(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  const max = Math.max(...values);
  const expValues = values.map(value => Math.exp(value - max));
  const sum = expValues.reduce((acc, value) => acc + value, 0);
  if (sum === 0) {
    return values.map(() => 0);
  }
  return expValues.map(value => value / sum);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function createMockSession(labelCount: number): InferenceSessionLike {
  return {
    inputNames: ['features'],
    outputNames: ['logits'],
    async run(feeds) {
      const input = Object.values(feeds)[0];
      const detections = input ? input.dims?.[0] ?? 1 : 1;
      const total = Math.max(1, detections * Math.max(1, labelCount));
      const data = new Float32Array(total);
      for (let i = 0; i < total; i += 1) {
        data[i] = i % labelCount === labelCount - 1 ? 2 : 0.2;
      }
      return {
        logits: new ort.Tensor('float32', data, [detections, Math.max(1, labelCount)])
      };
    }
  };
}

export function summarizeThreatMetadata(meta: Record<string, unknown> | undefined): ThreatSummary | null {
  if (!meta || typeof meta !== 'object') {
    return null;
  }

  const objectsRaw = Array.isArray((meta as { objects?: unknown }).objects)
    ? ((meta as { objects?: unknown }).objects as unknown[])
    : [];
  const normalized: ThreatSummaryEntry[] = [];

  for (const entry of objectsRaw) {
    const normalizedEntry = normalizeThreatEntry(entry);
    if (normalizedEntry) {
      normalized.push(normalizedEntry);
    }
  }

  const explicitThreat = normalizeThreatEntry((meta as { threat?: unknown }).threat);
  if (explicitThreat) {
    normalized.push(explicitThreat);
  }

  if (normalized.length === 0) {
    return null;
  }

  let total = 0;
  let max = normalized[0];
  for (const entry of normalized) {
    total += entry.threatScore;
    if (entry.threatScore > max.threatScore) {
      max = entry;
    }
  }

  return {
    objects: normalized,
    maxThreatScore: max.threatScore,
    maxThreatLabel: max.label,
    averageThreatScore: total / normalized.length,
    totalDetections: normalized.length
  };
}

function normalizeThreatEntry(value: unknown): ThreatSummaryEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const threatScoreCandidate = record.threatScore ?? record.score ?? record.confidence;
  const threatScore = typeof threatScoreCandidate === 'number' ? threatScoreCandidate : null;
  if (threatScore === null) {
    return null;
  }
  const label = typeof record.label === 'string' ? record.label : null;
  const isThreat = typeof record.threat === 'boolean' ? record.threat : threatScore >= 0.5;
  return { label, threatScore, isThreat };
}

export default ObjectClassifier;
