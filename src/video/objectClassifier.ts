import * as ort from 'onnxruntime-node';
import logger from '../logger.js';
import metrics from '../metrics/index.js';
import { YoloDetection } from './yoloParser.js';

export interface ObjectClassifierOptions {
  modelPath: string;
  labels: string[];
  threatLabels?: string[];
  threatThreshold?: number;
  labelMap?: Record<string, string>;
}

type InferenceSessionLike = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
};

export interface ClassifiedObject {
  detection: YoloDetection;
  label: string;
  rawLabel: string;
  score: number;
  probabilities: Record<string, number>;
  rawProbabilities: Record<string, number>;
  threatScore: number;
  fusedThreatScore: number;
  detectionConfidence: number;
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
  private readonly labelMap: Map<string, string>;

  private constructor(private readonly options: ObjectClassifierOptions) {
    const labelEntries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(options.labelMap ?? {})) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        continue;
      }
      const trimmedKey = key.trim();
      const trimmedValue = value.trim();
      if (!trimmedKey || !trimmedValue) {
        continue;
      }
      labelEntries.push([trimmedKey, trimmedValue]);
    }
    this.labelMap = new Map(labelEntries);
    const threatLabels = options.threatLabels ?? ['threat'];
    this.threatLabels = new Set<string>();
    for (const label of threatLabels) {
      if (typeof label !== 'string') {
        continue;
      }
      const trimmed = label.trim();
      if (!trimmed) {
        continue;
      }
      this.threatLabels.add(trimmed);
      this.threatLabels.add(this.mapLabel(trimmed));
    }
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
      const rawProbabilities: Record<string, number> = {};
      const probabilityBuckets = new Map<
        string,
        { total: number; raw: Map<string, number>; leader: { label: string; probability: number } }
      >();

      for (let i = 0; i < labels.length; i += 1) {
        const rawLabel = labels[i] ?? `class-${i}`;
        const probability = probabilities[i] ?? 0;
        rawProbabilities[rawLabel] = probability;
        const resolved = this.mapLabel(rawLabel);
        const existing = probabilityBuckets.get(resolved);
        if (existing) {
          existing.total += probability;
          existing.raw.set(rawLabel, probability);
          if (probability >= existing.leader.probability) {
            existing.leader = { label: rawLabel, probability };
          }
        } else {
          probabilityBuckets.set(resolved, {
            total: probability,
            raw: new Map([[rawLabel, probability]]),
            leader: { label: rawLabel, probability }
          });
        }
      }

      const aggregatedProbabilities: Record<string, number> = {};
      let bestLabel = labels[0] ? this.mapLabel(labels[0]) : 'class-0';
      let bestRawLabel = labels[0] ?? 'class-0';
      let bestScore = -Infinity;

      for (const [resolved, bucket] of probabilityBuckets.entries()) {
        aggregatedProbabilities[resolved] = bucket.total;
        if (bucket.total > bestScore) {
          bestScore = bucket.total;
          bestLabel = resolved;
          bestRawLabel = bucket.leader.label;
        }
      }

      if (!Number.isFinite(bestScore)) {
        bestScore = aggregatedProbabilities[bestLabel] ?? probabilities[0] ?? 0;
      }

      const probabilityLookup: Record<string, number> = { ...aggregatedProbabilities };
      for (const bucket of probabilityBuckets.values()) {
        for (const [rawLabel, probability] of bucket.raw.entries()) {
          probabilityLookup[rawLabel] = probability;
        }
      }

      const baseScore = clamp(Number(detection.score), 0, 1);
      const fusionConfidenceValue = Number.isFinite(Number(detection.fusion?.confidence))
        ? clamp(Number(detection.fusion?.confidence), 0, 1)
        : 0;
      const objectnessConfidence = Number.isFinite(Number(detection.objectness))
        ? clamp(Number(detection.objectness), 0, 1)
        : 0;
      const classConfidence = Number.isFinite(Number(detection.classProbability))
        ? clamp(Number(detection.classProbability), 0, 1)
        : 0;
      const detectionConfidence = clamp(
        Math.max(baseScore, fusionConfidenceValue, objectnessConfidence, classConfidence),
        0,
        1
      );
      const threatProbability = this.resolveThreatProbability(bestLabel, probabilityLookup, rawProbabilities);
      const fusedThreatScore = clamp(threatProbability * detectionConfidence, 0, 1);
      const baseThreatScore = clamp(threatProbability * baseScore, 0, 1);
      const isThreat = threatProbability >= this.threatThreshold;

      objects.push({
        detection: detections[index],
        label: bestLabel,
        rawLabel: bestRawLabel,
        score: bestScore,
        probabilities: aggregatedProbabilities,
        rawProbabilities,
        threatScore: baseThreatScore,
        fusedThreatScore,
        detectionConfidence,
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

  private resolveThreatProbability(
    label: string,
    probabilities: Record<string, number>,
    rawProbabilities: Record<string, number>
  ) {
    let maxThreat = 0;
    const resolved = this.mapLabel(label);
    if (this.threatLabels.has(resolved) || this.threatLabels.has(label)) {
      maxThreat = Math.max(maxThreat, probabilities[resolved] ?? probabilities[label] ?? 0);
    }

    for (const threat of this.threatLabels) {
      const threatLabel = this.mapLabel(threat);
      const score = probabilities[threatLabel];
      if (typeof score === 'number' && score > maxThreat) {
        maxThreat = score;
      }
      const rawScore = rawProbabilities[threat];
      if (typeof rawScore === 'number' && rawScore > maxThreat) {
        maxThreat = rawScore;
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

  private mapLabel(label: string) {
    const normalized = label.trim();
    return this.labelMap.get(normalized) ?? normalized;
  }

  getThreatThreshold() {
    return this.threatThreshold;
  }
}

function buildFeatureTensor(detections: YoloDetection[]) {
  const featureCount = 5;
  const data = new Float32Array(detections.length * featureCount);

  for (let i = 0; i < detections.length; i += 1) {
    const detection = detections[i];
    const base = i * featureCount;
    const featureScore =
      typeof detection.fusion?.confidence === 'number' ? detection.fusion.confidence : detection.score;
    data[base] = featureScore;
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

export interface ThreatSummaryOptions {
  threshold?: number;
  clampToThreshold?: boolean;
}

export function summarizeThreatMetadata(
  meta: Record<string, unknown> | undefined,
  options: ThreatSummaryOptions = {}
): ThreatSummary | null {
  if (!meta || typeof meta !== 'object') {
    return null;
  }

  const objectsRaw = Array.isArray((meta as { objects?: unknown }).objects)
    ? ((meta as { objects?: unknown }).objects as unknown[])
    : [];
  const normalized: ThreatSummaryEntry[] = [];

  for (const entry of objectsRaw) {
    const normalizedEntry = normalizeThreatEntry(entry, options);
    if (normalizedEntry) {
      normalized.push(normalizedEntry);
    }
  }

  const explicitThreat = normalizeThreatEntry((meta as { threat?: unknown }).threat, options);
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

function normalizeThreatEntry(value: unknown, options: ThreatSummaryOptions): ThreatSummaryEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const threatScoreCandidate = record.threatScore ?? record.score ?? record.confidence;
  let threatScore = typeof threatScoreCandidate === 'number' ? clamp(threatScoreCandidate, 0, 1) : null;
  if (threatScore === null) {
    return null;
  }
  const label = resolveThreatEntryLabel(record);
  const threshold =
    typeof options.threshold === 'number' && Number.isFinite(options.threshold) ? options.threshold : null;
  const isThreat =
    typeof record.threat === 'boolean'
      ? record.threat
      : threshold !== null
      ? threatScore >= threshold
      : threatScore >= 0.5;
  if (isThreat && threshold !== null && options.clampToThreshold) {
    threatScore = Math.max(threatScore, threshold);
  }
  return { label, threatScore, isThreat };
}

function resolveThreatEntryLabel(record: Record<string, unknown>) {
  const candidates: unknown[] = [
    record.label,
    (record as { alias?: unknown }).alias,
    (record as { mappedLabel?: unknown }).mappedLabel,
    (record as { resolvedLabel?: unknown }).resolvedLabel,
    (record as { rawLabel?: unknown }).rawLabel
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }

    return trimmed;
  }

  return null;
}

export default ObjectClassifier;
