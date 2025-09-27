import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import ObjectClassifier from '../src/video/objectClassifier.js';
import PersonDetector from '../src/video/personDetector.js';
import { YOLO_CLASS_START_INDEX } from '../src/video/yoloParser.js';

const runMocks = new Map<string, ReturnType<typeof vi.fn>>();

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

describe('ObjectThreatProbabilityFusion', () => {
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

  it('ObjectThreatProbabilityFusion annotates person events with fused threat scores', async () => {
    const detectionRun = vi.fn(async () => {
      const classCount = 3;
      const attributes = YOLO_CLASS_START_INDEX + classCount;
      const detections = 2;
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

      return {
        output0: { data, dims: [1, attributes, detections] }
      };
    });

    const classifierRun = vi.fn(async () => {
      const logits = new Float32Array([0.2, 0.4, 2.1]);
      return {
        logits: new Tensor('float32', logits, [1, 3])
      };
    });

    setRunMock('models/yolov8n.onnx', detectionRun);
    setRunMock('models/object.onnx', classifierRun);

    const objectClassifier = await ObjectClassifier.create({
      modelPath: 'models/object.onnx',
      labels: ['pet', 'delivery', 'threat'],
      threatLabels: ['threat'],
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
    const threatObject = objects.find(object => object.label === 'threat');
    expect(threatObject).toBeDefined();
    expect(threatObject?.threat).toBe(true);
    expect(threatObject?.threatScore ?? 0).toBeGreaterThan(0.6);
    expect(threatObject?.confidence ?? 0).toBeGreaterThan(0);
    expect(threatObject?.confidence ?? 0).toBeLessThanOrEqual(1);
    const detectionScore = (threatObject?.detection as Record<string, number>).score;
    const threatProbability = (threatObject?.probabilities as Record<string, number>).threat ?? 0;
    const expectedFusedScore = detectionScore * threatProbability;
    expect(threatObject?.threatScore ?? 0).toBeCloseTo(expectedFusedScore, 5);
    const thresholds = meta.thresholds as { classScoreThresholds?: Record<string, number>; classIndices?: number[] };
    expect(thresholds.classIndices).toContain(0);
    expect(meta.detections[0].appliedThreshold).toBeDefined();
    expect((meta.threat as Record<string, unknown>).label).toBe('threat');
    expect((meta.threat as Record<string, unknown>).confidence).toBe(threatObject?.confidence);
  });

  it('ObjectClassifierThreatBlend respects detection confidence bounds', async () => {
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
      threatLabels: ['threat'],
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
