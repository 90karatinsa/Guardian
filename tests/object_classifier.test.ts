import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import ObjectClassifier, { summarizeThreatMetadata } from '../src/video/objectClassifier.js';
import PersonDetector from '../src/video/personDetector.js';
import { YOLO_CLASS_START_INDEX, parseYoloDetections } from '../src/video/yoloParser.js';

const runMocks = new Map<string, ReturnType<typeof vi.fn>>();
const OBJECTNESS_INDEX = 4;

vi.mock('onnxruntime-node', () => {
  class Tensor<T> {
    constructor(
      public readonly type: string,
      public readonly data: T,
      public readonly dims: number[]
    ) {}
  }

  const create = vi.fn(async (modelPath: string) => {
    const run = runMocks.get(modelPath) ?? vi.fn(async () => ({}));
    const inputNames = modelPath.includes('object') ? ['features'] : ['images'];
    const outputNames = modelPath.includes('object') ? ['logits'] : ['output0'];
    return {
      inputNames,
      outputNames,
      run
    };
  });

  return {
    InferenceSession: { create },
    Tensor,
    __setRunMock(modelPath: string, run: ReturnType<typeof vi.fn>) {
      runMocks.set(modelPath, run);
    }
  };
});

vi.mock('pngjs', () => {
  const store = new WeakMap<Buffer, { width: number; height: number; data: Uint8Array }>();

  class FakePNG {
    width: number;
    height: number;
    data: Uint8Array;

    constructor({ width, height }: { width: number; height: number }) {
      this.width = width;
      this.height = height;
      this.data = new Uint8Array(width * height * 4);
    }

    static sync = {
      write(png: FakePNG) {
        const buffer = Buffer.from(png.data);
        store.set(buffer, {
          width: png.width,
          height: png.height,
          data: Uint8Array.from(png.data)
        });
        return buffer;
      },
      read(buffer: Buffer) {
        const entry = store.get(buffer);
        if (!entry) {
          throw new Error('Unknown buffer');
        }
        const png = new FakePNG({ width: entry.width, height: entry.height });
        png.data.set(entry.data);
        return png;
      }
    };
  }

  return { PNG: FakePNG };
});

const ort = await import('onnxruntime-node');
const setRunMock = (ort as unknown as { __setRunMock: (modelPath: string, run: ReturnType<typeof vi.fn>) => void }).__setRunMock;
const Tensor = ort.Tensor as typeof import('onnxruntime-node').Tensor;
const { PNG } = await import('pngjs');

describe('YoloFusionHeuristics', () => {
  const logit = (probability: number) => Math.log(probability / (1 - probability));

  it('YoloProjectionWeightedFusion merges overlapping projections with fusion metrics', () => {
    const classCount = 1;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 3;
    const data = new Float32Array(attributes * detections).fill(0);

    const assign = (
      index: number,
      values: { cx: number; cy: number; width: number; height: number; objectness: number; classProbability: number }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = logit(values.objectness);
      data[YOLO_CLASS_START_INDEX * detections + index] = logit(values.classProbability);
    };

    assign(0, { cx: 0.5, cy: 0.5, width: 0.32, height: 0.46, objectness: 0.9, classProbability: 0.86 });
    assign(1, { cx: 0.52, cy: 0.48, width: 0.34, height: 0.44, objectness: 0.88, classProbability: 0.83 });
    assign(2, { cx: 320, cy: 236, width: 176, height: 208, objectness: 0.87, classProbability: 0.81 });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      scale: 1,
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 480,
      resizedWidth: 640,
      resizedHeight: 640,
      scaleX: 1,
      scaleY: 640 / 480,
      variants: [
        {
          padX: 16,
          padY: 8,
          originalWidth: 640,
          originalHeight: 480,
          resizedWidth: 672,
          resizedHeight: 672,
          scaleX: 672 / 640,
          scaleY: 672 / 480,
          normalized: true
        },
        {
          padX: 0,
          padY: 0,
          originalWidth: 640,
          originalHeight: 480,
          resizedWidth: 640,
          resizedHeight: 480,
          scaleX: 1,
          scaleY: 1,
          normalized: false
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const [fused] = parseYoloDetections(tensor, meta, {
      classIndices: [0],
      scoreThreshold: 0.3,
      nmsThreshold: 0.6
    });

    expect(fused).toBeDefined();
    expect(fused.fusion).toBeDefined();
    const fusion = fused.fusion!;
    expect(fusion.contributors.length).toBe(3);
    expect(fusion.confidence).toBeGreaterThan(fused.score * 0.9);
    expect(fusion.weight).toBeGreaterThan(0);
    const totalWeight = fusion.contributors.reduce((sum, contributor) => sum + contributor.weight, 0);
    expect(totalWeight).toBeGreaterThan(0);
    expect(fusion.weight).toBeCloseTo(totalWeight, 6);

    const weightedLeft = fusion.contributors.reduce((sum, contributor) => sum + contributor.weight * contributor.bbox.left, 0) /
      totalWeight;
    const weightedTop = fusion.contributors.reduce((sum, contributor) => sum + contributor.weight * contributor.bbox.top, 0) /
      totalWeight;
    const weightedRight = fusion.contributors.reduce(
      (sum, contributor) => sum + contributor.weight * (contributor.bbox.left + contributor.bbox.width),
      0
    ) / totalWeight;
    const weightedBottom = fusion.contributors.reduce(
      (sum, contributor) => sum + contributor.weight * (contributor.bbox.top + contributor.bbox.height),
      0
    ) / totalWeight;

    expect(fused.bbox.left).toBeCloseTo(weightedLeft, 3);
    expect(fused.bbox.top).toBeCloseTo(weightedTop, 3);
    expect(fused.bbox.width).toBeCloseTo(weightedRight - weightedLeft, 3);
    expect(fused.bbox.height).toBeCloseTo(weightedBottom - weightedTop, 3);
    expect(fused.areaRatio).toBeCloseTo(fusion.areaRatio, 5);
    expect(fusion.contributors.some(contributor => contributor.projectionIndex !== fusion.contributors[0]?.projectionIndex)).toBe(
      true
    );
    expect(fusion.contributors.every(contributor => contributor.iou > 0)).toBe(true);
  });

  it('YoloMaxDetectionsPrioritizesPrimaryClass retains fusion metrics for preferred classes', () => {
    const classCount = 2;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 3;
    const data = new Float32Array(attributes * detections).fill(0);

    const assign = (
      index: number,
      values: {
        cx: number;
        cy: number;
        width: number;
        height: number;
        objectness: number;
        class0: number;
        class1: number;
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = logit(values.objectness);
      data[(YOLO_CLASS_START_INDEX + 0) * detections + index] = logit(values.class0);
      data[(YOLO_CLASS_START_INDEX + 1) * detections + index] = logit(values.class1);
    };

    assign(0, {
      cx: 0.52,
      cy: 0.48,
      width: 0.42,
      height: 0.36,
      objectness: 0.9,
      class0: 0.1,
      class1: 0.84
    });
    assign(1, {
      cx: 0.5,
      cy: 0.5,
      width: 0.4,
      height: 0.34,
      objectness: 0.88,
      class0: 0.12,
      class1: 0.82
    });
    assign(2, {
      cx: 0.28,
      cy: 0.3,
      width: 0.36,
      height: 0.42,
      objectness: 0.97,
      class0: 0.92,
      class1: 0.05
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      scale: 1,
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 480,
      resizedWidth: 640,
      resizedHeight: 640,
      scaleX: 1,
      scaleY: 1
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const unlimited = parseYoloDetections(tensor, meta, {
      classIndices: [1, 0],
      classIndex: 1,
      scoreThreshold: 0.25,
      nmsThreshold: 0.5
    });

    const limited = parseYoloDetections(tensor, meta, {
      classIndices: [1, 0],
      classIndex: 1,
      scoreThreshold: 0.25,
      nmsThreshold: 0.5,
      maxDetections: 1
    });

    expect(limited).toHaveLength(1);
    const primary = unlimited.find(result => result.classId === 1);
    const secondary = unlimited.find(result => result.classId === 0);
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(secondary!.score).toBeGreaterThan(primary!.score);
    expect(limited[0]?.classId).toBe(1);
    expect(limited[0]?.fusion).toBeDefined();
    expect(limited[0]?.fusion?.confidence ?? 0).toBeCloseTo(primary!.fusion?.confidence ?? 0, 6);
    expect(limited[0]?.combinedLogit).toBeCloseTo(primary!.combinedLogit, 6);
    expect(limited[0]?.score).toBeCloseTo(primary!.score, 6);
  });

  it('YoloParserResolvesMissingDimensions retains detections when original size is unavailable', () => {
    const classCount = 1;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 1;
    const data = new Float32Array(attributes * detections).fill(0);

    data[0 * detections + 0] = 0.5; // cx
    data[1 * detections + 0] = 0.5; // cy
    data[2 * detections + 0] = 0.25; // width
    data[3 * detections + 0] = 0.25; // height
    data[OBJECTNESS_INDEX * detections + 0] = logit(0.92);
    data[YOLO_CLASS_START_INDEX * detections + 0] = logit(0.88);

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      scale: 1,
      padX: 0,
      padY: 0,
      originalWidth: 0,
      originalHeight: 0,
      resizedWidth: 640,
      resizedHeight: 640,
      scaleX: 1,
      scaleY: 1
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const [detection] = parseYoloDetections(tensor, meta, {
      classIndices: [0],
      scoreThreshold: 0.2
    });

    expect(detection).toBeDefined();
    expect(detection.bbox.width).toBeGreaterThan(0);
    expect(detection.bbox.height).toBeGreaterThan(0);
    expect(detection.areaRatio).toBeCloseTo(0.0625, 5);
    expect(detection.bbox.left).toBeCloseTo(240, 3);
    expect(detection.bbox.top).toBeCloseTo(240, 3);
  });
});

describe('ObjectClassifierThreatScoring', () => {
  const snapshotsDir = path.resolve('snapshots');
  beforeEach(() => {
    runMocks.clear();
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
  });

  it('ObjectClassifierThreatScoring merges mapped labels and threat summaries into person events', async () => {
    const detectionRun = vi.fn(async () => {
      const classCount = 3;
      const attributes = YOLO_CLASS_START_INDEX + classCount;
      const detections = 3;
      const data = new Float32Array(attributes * detections).fill(0);

      setDetection(data, detections, 0, {
        cx: 320,
        cy: 240,
        width: 220,
        height: 260,
        objectnessLogit: 2.5,
        personLogit: 2.3,
        class1Logit: -4,
        class2Logit: -3
      });

      setDetection(data, detections, 1, {
        cx: 400,
        cy: 250,
        width: 180,
        height: 210,
        objectnessLogit: 1.9,
        personLogit: -4,
        class1Logit: 2.4,
        class2Logit: -3
      });

      setDetection(data, detections, 2, {
        cx: 280,
        cy: 220,
        width: 160,
        height: 200,
        objectnessLogit: 1.6,
        personLogit: -3.8,
        class1Logit: 1.2,
        class2Logit: 2.6
      });

      return {
        output0: { data, dims: [1, attributes, detections] }
      };
    });

    const classifierRun = vi.fn(async () => {
      const logits = new Float32Array([0.2, 0.4, 2.1, 1.5, 1.2, -1.3]);
      return {
        logits: new Tensor('float32', logits, [2, 3])
      };
    });

    setRunMock('models/yolov8n.onnx', detectionRun);
    setRunMock('models/object.onnx', classifierRun);

    const objectClassifier = await ObjectClassifier.create({
      modelPath: 'models/object.onnx',
      labels: ['cat', 'dog', 'threat'],
      labelMap: {
        cat: 'pet',
        dog: 'pet',
        threat: 'intruder'
      },
      threatLabels: ['threat', 'intruder'],
      threatThreshold: 0.6
    });

    const bus = new EventEmitter();
    const events: any[] = [];
    bus.on('event', payload => events.push(payload));

    const detector = await PersonDetector.create(
      {
        source: 'video:test-object',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.3,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        classIndices: [0, 1, 2],
        objectClassifier
      },
      bus
    );

    const frame = createUniformFrame(640, 480, 120);
    await detector.handleFrame(frame, 10);

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    const objects = meta.objects as Array<Record<string, unknown>>;
    expect(Array.isArray(objects)).toBe(true);
    expect(objects.length).toBeGreaterThanOrEqual(1);
    const threatObject = objects.find(object => object.label === 'intruder');
    expect(threatObject).toBeDefined();
    expect(threatObject?.rawLabel).toBe('threat');
    expect(threatObject?.threat).toBe(true);
    expect(threatObject?.threatScore ?? 0).toBeGreaterThan(0.6);
    expect(threatObject?.confidence ?? 0).toBeGreaterThan(0);
    expect(threatObject?.confidence ?? 0).toBeLessThanOrEqual(1);
    const detectionScore = (threatObject?.detection as Record<string, number>).score;
    const threatProbability = (threatObject?.probabilities as Record<string, number>).intruder ?? 0;
    const expectedFusedScore = detectionScore * threatProbability;
    expect(threatObject?.threatScore ?? 0).toBeCloseTo(expectedFusedScore, 5);
    const thresholds = meta.thresholds as { classScoreThresholds?: Record<string, number>; classIndices?: number[] };
    expect(thresholds.classIndices).toContain(0);
    expect(meta.detections[0].appliedThreshold).toBeDefined();
    expect((meta.threat as Record<string, unknown>).label).toBe('intruder');
    expect((meta.threat as Record<string, unknown>).confidence).toBe(threatObject?.confidence);
    const threatSummary = meta.threatSummary as Record<string, unknown>;
    expect(threatSummary?.maxThreatLabel).toBe('intruder');
    expect(threatSummary?.totalDetections).toBeGreaterThan(0);
    const intruderEntry = (meta.objects as Array<Record<string, unknown>>).find(
      object => object.label === 'intruder'
    );
    const intruderRawProbabilities = intruderEntry?.rawProbabilities as Record<string, number> | undefined;
    expect(intruderRawProbabilities?.threat).toBeDefined();
    const petEntry = (meta.objects as Array<Record<string, unknown>>).find(
      object => object.label === 'pet'
    );
    const petProbabilities = petEntry?.probabilities as Record<string, number> | undefined;
    expect(petProbabilities?.pet).toBeGreaterThan(0);
    const petRawProbabilities = petEntry?.rawProbabilities as Record<string, number> | undefined;
    expect(petRawProbabilities?.dog ?? 0).toBeGreaterThan(0);
  });

  it('ObjectClassifierResolvesLabelAliases maps threat summaries to alias labels', async () => {
    const classifierRun = vi.fn(async () => ({
      logits: new Tensor('float32', new Float32Array([0.1, 2.6, -0.4]), [1, 3])
    }));

    setRunMock('models/object-alias.onnx', classifierRun);

    const classifier = await ObjectClassifier.create({
      modelPath: 'models/object-alias.onnx',
      labels: ['box', 'car', 'drone'],
      labelMap: { box: 'package', car: 'vehicle' },
      threatLabels: ['vehicle'],
      threatThreshold: 0.3
    });

    const objectnessLogit = Math.log(0.9 / (1 - 0.9));
    const classLogit = Math.log(0.88 / (1 - 0.88));

    const detection = {
      score: 0.82,
      classId: 1,
      bbox: { left: 120, top: 140, width: 180, height: 140 },
      objectness: 0.9,
      classProbability: 0.88,
      areaRatio: 0.045,
      combinedLogit: objectnessLogit + classLogit,
      appliedThreshold: 0.2
    } satisfies import('../src/video/yoloParser.js').YoloDetection;

    const results = await classifier.classify([detection]);
    expect(results).toHaveLength(1);
    const [object] = results;
    expect(object.label).toBe('vehicle');
    expect(object.rawLabel).toBe('car');

    const summary = summarizeThreatMetadata({
      objects: [
        {
          alias: object.label,
          rawLabel: object.rawLabel,
          threatScore: object.threatScore,
          threat: object.isThreat
        }
      ],
      threat: {
        alias: object.label,
        rawLabel: object.rawLabel,
        threatScore: object.threatScore,
        threat: object.isThreat
      }
    });

    expect(summary).not.toBeNull();
    expect(summary?.maxThreatLabel).toBe('vehicle');
    expect(summary?.objects[0]?.label).toBe('vehicle');
  });

  it('ObjectClassifierThreatScoring clamps fused threat score within detection confidence', async () => {
    const logits = new Float32Array([0.5, 1.2, 2.8]);
    const detectionRun = vi.fn(async () => ({
      output0: {
        data: new Float32Array(),
        dims: [1, YOLO_CLASS_START_INDEX + 1, 1]
      }
    }));
    const classifierRun = vi.fn(async () => ({
      logits: new Tensor('float32', logits, [1, 3])
    }));

    setRunMock('models/yolov8n.onnx', detectionRun);
    setRunMock('models/object.onnx', classifierRun);

    const classifier = await ObjectClassifier.create({
      modelPath: 'models/object.onnx',
      labels: ['package', 'pet', 'threat'],
      labelMap: {
        package: 'delivery',
        pet: 'pet',
        threat: 'intruder'
      },
      threatLabels: ['threat', 'intruder'],
      threatThreshold: 0.4
    });

    const detection = {
      score: 0.55,
      classId: 0,
      bbox: { left: 100, top: 120, width: 200, height: 260 },
      objectness: 0.94,
      classProbability: 0.9,
      areaRatio: 0.08,
      combinedLogit: 0,
      appliedThreshold: 0.3
    } satisfies import('../src/video/yoloParser.js').YoloDetection;

    const results = await classifier.classify([detection]);
    expect(results).toHaveLength(1);
    const object = results[0];

    const max = Math.max(...logits);
    const expValues = logits.map(value => Math.exp(value - max));
    const sum = expValues.reduce((acc, value) => acc + value, 0);
    const probabilities = expValues.map(value => value / sum);
    const threatProbability = probabilities[2];
    const expected = detection.score * threatProbability;

    expect(object.threatScore).toBeCloseTo(expected, 5);
    expect(object.threatScore).toBeLessThanOrEqual(detection.score);
    expect(object.rawLabel).toBe('threat');
    expect(object.probabilities.intruder).toBeCloseTo(object.score, 5);
    expect(object.rawProbabilities.threat).toBeGreaterThan(0);
  });

  it('YoloParserAppliesClassThresholds filters detections below class-specific thresholds', () => {
    const classCount = 3;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 2;
    const data = new Float32Array(attributes * detections).fill(0);

    setDetection(data, detections, 0, {
      cx: 0.52,
      cy: 0.5,
      width: 0.46,
      height: 0.68,
      objectnessLogit: 2.3,
      personLogit: -0.2,
      class1Logit: -1.8,
      class2Logit: -2.2
    });

    setDetection(data, detections, 1, {
      cx: 0.48,
      cy: 0.46,
      width: 0.52,
      height: 0.7,
      objectnessLogit: 2.6,
      personLogit: 2.1,
      class1Logit: -2.4,
      class2Logit: -2.1
    });

    const tensor = { data, dims: [1, attributes, detections] } as unknown as import('onnxruntime-node').OnnxValue;

    const meta = {
      originalWidth: 640,
      originalHeight: 480,
      resizedWidth: 640,
      resizedHeight: 640,
      padX: 0,
      padY: 0,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      variants: [
        {
          originalWidth: 640,
          originalHeight: 480,
          resizedWidth: 640,
          resizedHeight: 640,
          padX: 18,
          padY: 32,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
          normalized: true
        }
      ]
    } satisfies import('../src/video/yoloParser.js').PreprocessMeta;

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [0],
      classScoreThresholds: { 0: 0.6 },
      nmsThreshold: 0.45,
      maxDetections: 5
    });

    expect(results).toHaveLength(1);
    const detection = results[0];
    expect(detection.classId).toBe(0);
    expect(detection.score).toBeGreaterThanOrEqual(0.6);
    expect(detection.appliedThreshold).toBeCloseTo(0.6, 3);
    expect(detection.bbox.width).toBeGreaterThan(0);
    expect(detection.bbox.height).toBeGreaterThan(0);
    expect(detection.bbox.left).toBeGreaterThanOrEqual(0);
    expect(detection.bbox.top).toBeGreaterThanOrEqual(0);
    expect(detection.bbox.left + detection.bbox.width).toBeLessThanOrEqual(640);
    expect(detection.bbox.top + detection.bbox.height).toBeLessThanOrEqual(480);
    expect(detection.projectionIndex).not.toBeUndefined();
    expect(detection.normalizedProjection).toBe(true);
  });
});

function setDetection(
  data: Float32Array,
  detections: number,
  index: number,
  values: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    objectnessLogit: number;
    personLogit: number;
    class1Logit: number;
    class2Logit: number;
  }
) {
  data[0 * detections + index] = values.cx;
  data[1 * detections + index] = values.cy;
  data[2 * detections + index] = values.width;
  data[3 * detections + index] = values.height;
  data[4 * detections + index] = values.objectnessLogit;
  data[5 * detections + index] = values.personLogit;
  data[6 * detections + index] = values.class1Logit;
  data[7 * detections + index] = values.class2Logit;
}

function createUniformFrame(width: number, height: number, value: number) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      png.data[idx] = value;
      png.data[idx + 1] = value;
      png.data[idx + 2] = value;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
