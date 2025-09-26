import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import PersonDetector from '../src/video/personDetector.js';
import { YOLO_CLASS_START_INDEX, parseYoloDetections } from '../src/video/yoloParser.js';

const runMock = vi.fn();
const OBJECTNESS_INDEX = 4;

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
        const image = new FakePNG({ width: entry.width, height: entry.height });
        image.data.set(entry.data);
        return image;
      }
    };
  }

  return { PNG: FakePNG };
});

vi.mock('onnxruntime-node', () => {
  class Tensor<T> {
    constructor(
      public readonly type: string,
      public readonly data: T,
      public readonly dims: number[]
    ) {}
  }

  return {
    InferenceSession: {
      create: vi.fn(async () => ({
        inputNames: ['images'],
        outputNames: ['output0'],
        run: runMock
      }))
    },
    Tensor
  };
});

const ort = await import('onnxruntime-node');

import { PNG } from 'pngjs';

describe('YoloParser utilities', () => {
  const logit = (probability: number) => {
    return Math.log(probability / (1 - probability));
  };

  const sigmoid = (value: number) => {
    const clamped = Math.max(-20, Math.min(20, value));
    return 1 / (1 + Math.exp(-clamped));
  };

  it('YoloParserMultiClass applies class thresholds and rescales boxes', () => {
    const classCount = 3;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 2;
    const data = new Float32Array(attributes * detections).fill(0);

    const assignDetection = (
      index: number,
      values: {
        cx: number;
        cy: number;
        width: number;
        height: number;
        objectnessLogit: number;
        classLogits: number[];
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = values.objectnessLogit;
      values.classLogits.forEach((logit, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        data[attributeIndex * detections + index] = logit;
      });
    };

    assignDetection(0, {
      cx: 320,
      cy: 320,
      width: 200,
      height: 220,
      objectnessLogit: 2.4,
      classLogits: [2.1, -4, -4]
    });

    assignDetection(1, {
      cx: 480,
      cy: 400,
      width: 160,
      height: 200,
      objectnessLogit: 1.9,
      classLogits: [-5, 1.8, 1.2]
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      scale: 0.8,
      padX: 0,
      padY: 80,
      originalWidth: 800,
      originalHeight: 600,
      resizedWidth: 640,
      resizedHeight: 480,
      scaleX: 640 / 800,
      scaleY: 480 / 600
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [0, 1, 2],
      scoreThreshold: 0.4,
      classScoreThresholds: { 1: 0.6, 2: 0.8 }
    });

    expect(results).toHaveLength(2);
    expect(results.some(result => result.classId === 2)).toBe(false);

    const person = results.find(result => result.classId === 0);
    expect(person?.score ?? 0).toBeCloseTo(sigmoid(2.4 + 2.1), 5);

    const packageDetection = results.find(result => result.classId === 1);
    expect(packageDetection).toBeDefined();
    expect(packageDetection?.score ?? 0).toBeCloseTo(sigmoid(1.9 + 1.8), 5);
    expect(packageDetection?.bbox.left ?? 0).toBeCloseTo(500, 1);
    expect(packageDetection?.bbox.top ?? 0).toBeCloseTo(275, 1);
    expect(packageDetection?.bbox.width ?? 0).toBeCloseTo(200, 1);
    expect(packageDetection?.bbox.height ?? 0).toBeCloseTo(250, 1);
    expect(packageDetection?.areaRatio ?? 0).toBeCloseTo((200 * 250) / (800 * 600), 5);
  });

  it('YoloParserPersonConfidence prioritizes person detections across projections', () => {
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
        classProbabilities: number[];
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = logit(values.objectness);
      values.classProbabilities.forEach((prob, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        data[attributeIndex * detections + index] = logit(prob);
      });
    };

    assign(0, {
      cx: 0.55,
      cy: 0.45,
      width: 0.18,
      height: 0.36,
      objectness: 0.78,
      classProbabilities: [0.74, 0.82]
    });

    assign(1, {
      cx: 0.52,
      cy: 0.48,
      width: 0.22,
      height: 0.4,
      objectness: 0.81,
      classProbabilities: [0.69, 0.9]
    });

    assign(2, {
      cx: 0.4,
      cy: 0.5,
      width: 0.12,
      height: 0.3,
      objectness: 0.6,
      classProbabilities: [0.55, 0.6]
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      scale: 1,
      padX: 32,
      padY: 24,
      originalWidth: 1280,
      originalHeight: 720,
      resizedWidth: 640,
      resizedHeight: 640,
      scaleX: 640 / 1280,
      scaleY: 640 / 720,
      variants: [
        {
          padX: 0,
          padY: 0,
          originalWidth: 1280,
          originalHeight: 720,
          resizedWidth: 704,
          resizedHeight: 704,
          scaleX: 704 / 1280,
          scaleY: 704 / 720
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndex: 0,
      classIndices: [0, 1],
      scoreThreshold: 0.2,
      maxDetections: 2
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.classId).toBe(0);
    const person = results[0]!;
    const packageCandidate = results[1]!;

    expect(person.score).toBeCloseTo(sigmoid(logit(0.78) + logit(0.74)), 5);
    expect(person.projectionIndex).toBe(0);
    expect(person.normalizedProjection).toBe(true);
    expect(person.bbox.width).toBeGreaterThan(150);
    expect(person.bbox.width).toBeLessThan(400);
    expect(person.areaRatio).toBeGreaterThan(0.02);
    expect(person.areaRatio).toBeLessThan(0.2);
    expect(packageCandidate.score).toBeLessThan(person.score + 0.05);
    expect(packageCandidate.projectionIndex).toBeGreaterThanOrEqual(0);
  });

  it('YoloParserNmsChannelLast suppresses overlapping boxes in channel-last tensors', () => {
    const classCount = 2;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 3;
    const data = new Float32Array(detections * attributes).fill(0);

    const assign = (
      index: number,
      values: {
        cx: number;
        cy: number;
        width: number;
        height: number;
        objectness: number;
        classProbabilities: number[];
      }
    ) => {
      data[index * attributes + 0] = values.cx;
      data[index * attributes + 1] = values.cy;
      data[index * attributes + 2] = values.width;
      data[index * attributes + 3] = values.height;
      data[index * attributes + OBJECTNESS_INDEX] = logit(values.objectness);
      values.classProbabilities.forEach((prob, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        data[index * attributes + attributeIndex] = logit(prob);
      });
    };

    assign(0, {
      cx: 320,
      cy: 260,
      width: 180,
      height: 200,
      objectness: 0.95,
      classProbabilities: [0.9, 0.25]
    });

    assign(1, {
      cx: 330,
      cy: 270,
      width: 170,
      height: 210,
      objectness: 0.9,
      classProbabilities: [0.85, 0.3]
    });

    assign(2, {
      cx: 520,
      cy: 300,
      width: 150,
      height: 180,
      objectness: 0.88,
      classProbabilities: [0.1, 0.9]
    });

    const tensor = new ort.Tensor('float32', data, [1, detections, attributes]);
    const meta = {
      scale: 1,
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 480,
      resizedWidth: 640,
      resizedHeight: 480,
      scaleX: 1,
      scaleY: 1
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [0, 1],
      scoreThreshold: 0.3,
      classScoreThresholds: { 0: 0.6, 1: 0.75 },
      nmsThreshold: 0.4
    });

    expect(results).toHaveLength(2);
    const person = results.find(result => result.classId === 0);
    const packageDetection = results.find(result => result.classId === 1);

    expect(person).toBeDefined();
    expect(person?.score ?? 0).toBeCloseTo(0.95 * 0.9, 5);
    expect(packageDetection).toBeDefined();
    expect(packageDetection?.score ?? 0).toBeGreaterThan(0.7);

    const duplicate = results.filter(result => result.classId === 0);
    expect(duplicate).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(results[1].score ?? 0);
  });

  it('YoloParserClampedBoxes clamps coordinates and applies class-specific thresholds', () => {
    const classCount = 2;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 2;
    const data = new Float32Array(attributes * detections).fill(0);

    const assign = (
      index: number,
      values: {
        cx: number;
        cy: number;
        width: number;
        height: number;
        objectness: number;
        classProbabilities: number[];
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = logit(values.objectness);
      values.classProbabilities.forEach((probability, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        data[attributeIndex * detections + index] = logit(probability);
      });
    };

    assign(0, {
      cx: 20,
      cy: 200,
      width: 400,
      height: 500,
      objectness: 0.9,
      classProbabilities: [0.75, 0.55]
    });

    assign(1, {
      cx: 620,
      cy: 620,
      width: 400,
      height: 500,
      objectness: 0.82,
      classProbabilities: [0.15, 0.82]
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      scale: 0.5,
      padX: 0,
      padY: 140,
      originalWidth: 1280,
      originalHeight: 720,
      resizedWidth: 640,
      resizedHeight: 640,
      scaleX: 0.5,
      scaleY: 0.5
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [0, 1],
      scoreThreshold: 0.5,
      classScoreThresholds: { 1: 0.6 },
      maxDetections: 5
    });

    expect(results).toHaveLength(2);
    const first = results.find(result => result.classId === 0);
    const second = results.find(result => result.classId === 1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    expect(first?.score ?? 0).toBeCloseTo(0.9 * 0.75, 5);
    expect(second?.score ?? 0).toBeCloseTo(0.82 * 0.82, 5);

    const bounds = { width: meta.originalWidth, height: meta.originalHeight };

    for (const detection of results) {
      const { left, top, width, height } = detection.bbox;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(left + width).toBeLessThanOrEqual(bounds.width);
      expect(top + height).toBeLessThanOrEqual(bounds.height);
    }

    expect(first?.bbox.left ?? 0).toBe(0);
    expect(first?.bbox.top ?? 0).toBe(0);
    expect(first?.bbox.width ?? 0).toBeCloseTo(440, 5);
    expect(first?.bbox.height ?? 0).toBeCloseTo(620, 5);

    expect(second?.bbox.left ?? 0).toBeCloseTo(840, 5);
    expect(second?.bbox.top ?? 0).toBeCloseTo(460, 5);
    expect(second?.bbox.width ?? 0).toBeCloseTo(440, 5);
    expect(second?.bbox.height ?? 0).toBeCloseTo(260, 5);

    expect(first?.areaRatio ?? 0).toBeCloseTo((440 * 620) / (1280 * 720), 5);
    expect(second?.areaRatio ?? 0).toBeCloseTo((440 * 260) / (1280 * 720), 5);
  });

  it('YoloParserNaNResilience filters invalid numeric detections safely', () => {
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
        classProbabilities: number[];
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = logit(values.objectness);
      values.classProbabilities.forEach((prob, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        data[attributeIndex * detections + index] = logit(prob);
      });
    };

    assign(0, {
      cx: 300,
      cy: 200,
      width: 140,
      height: 160,
      objectness: 0.92,
      classProbabilities: [0.85, 0.2]
    });

    assign(1, {
      cx: Number.NaN,
      cy: 120,
      width: Number.POSITIVE_INFINITY,
      height: 180,
      objectness: 0.9,
      classProbabilities: [0.95, 0.4]
    });

    assign(2, {
      cx: 350,
      cy: 260,
      width: 8000,
      height: 6000,
      objectness: 0.88,
      classProbabilities: [0.6, Number.NaN]
    });

    const tensor = new ort.Tensor('float32', data, [attributes, detections]);

    const meta = {
      scale: 0.5,
      padX: 10,
      padY: 20,
      originalWidth: 1280,
      originalHeight: 720,
      resizedWidth: 640,
      resizedHeight: 360,
      scaleX: 0.5,
      scaleY: 0.5
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [0, 1],
      scoreThreshold: 0.5
    });

    expect(results).toHaveLength(2);
    results.forEach(result => {
      expect(Number.isFinite(result.score)).toBe(true);
      expect(result.score).toBeGreaterThan(0);
      expect(Number.isFinite(result.bbox.left)).toBe(true);
      expect(Number.isFinite(result.bbox.top)).toBe(true);
      expect(Number.isFinite(result.bbox.width)).toBe(true);
      expect(Number.isFinite(result.bbox.height)).toBe(true);
      expect(result.bbox.width).toBeGreaterThan(0);
      expect(result.bbox.height).toBeGreaterThan(0);
      expect(Number.isFinite(result.areaRatio)).toBe(true);
      expect(result.areaRatio).toBeGreaterThan(0);
      expect(result.areaRatio).toBeLessThanOrEqual(1);
    });

    const classIds = results.map(result => result.classId).sort();
    expect(classIds).toEqual([0, 0]);
  });
});

describe('PersonDetector', () => {
  const snapshotsDir = path.resolve('snapshots');
  let bus: EventEmitter;
  let events: { detector: string; meta?: Record<string, unknown> }[];

  beforeEach(() => {
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }

    bus = new EventEmitter();
    events = [];
    bus.on('event', payload => {
      events.push({ detector: payload.detector, meta: payload.meta });
    });

    runMock.mockReset();
    ort.InferenceSession.create.mockClear();
  });

  afterEach(() => {
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
  });

  it('PersonDetectorSnapshotMetadata captures preprocess context', async () => {
    const detections = 2;
    const attributes = 6;
    const detectionData = new Float32Array(attributes * detections);

    setChannelFirstDetection(detectionData, detections, 0, {
      cx: 320,
      cy: 320,
      width: 200,
      height: 200,
      objectnessLogit: 2.2,
      classLogit: 2.1
    });

    setChannelFirstDetection(detectionData, detections, 1, {
      cx: 330,
      cy: 330,
      width: 210,
      height: 210,
      objectnessLogit: 1.4,
      classLogit: 1.3
    });

    runMock.mockResolvedValue({
      output0: {
        data: detectionData,
        dims: [1, attributes, detections]
      }
    });

    const detector = await PersonDetector.create(
      {
        source: 'video:test-camera',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.5,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        maxDetections: 1,
        classScoreThresholds: { 0: 0.5 }
      },
      bus
    );

    const frame = createUniformFrame(1280, 720, 25);
    const ts = 1234567890;

    await detector.handleFrame(frame, ts);

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    const expectedObjectness = sigmoid(2.2);
    const expectedClassProbability = sigmoid(2.1);
    expect(meta?.score).toBeCloseTo(expectedObjectness * expectedClassProbability, 5);
    expect(meta?.score).toBeGreaterThan(0);
    expect(meta?.score).toBeLessThanOrEqual(1);
    expect(meta?.classId).toBe(0);
    expect(meta?.objectness).toBeCloseTo(expectedObjectness, 5);
    expect(meta?.classProbability).toBeCloseTo(expectedClassProbability, 5);
    expect(meta?.thresholds).toMatchObject({ score: 0.5, nms: 0.45 });
    expect(meta?.thresholds?.classScoreThresholds).toMatchObject({ 0: 0.5 });

    const bbox = meta?.bbox as { left: number; top: number; width: number; height: number };
    expect(bbox.left).toBeCloseTo(440, 5);
    expect(bbox.top).toBeCloseTo(160, 5);
    expect(bbox.width).toBeCloseTo(400, 5);
    expect(bbox.height).toBeCloseTo(400, 5);

    expect(meta?.areaRatio).toBeCloseTo((400 * 400) / (1280 * 720), 5);
    expect(meta?.preprocess).toMatchObject({
      scale: 0.5,
      padX: 0,
      padY: 140,
      resizedWidth: 640,
      resizedHeight: 360,
      originalWidth: 1280,
      originalHeight: 720,
      scaleX: 0.5,
      scaleY: 0.5
    });

    const candidates = meta?.detections as Array<Record<string, unknown>>;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).toHaveLength(1);
    expect(candidates?.[0]?.score).toBe(meta?.score);
    expect((candidates?.[0]?.bbox as any)?.width).toBeCloseTo(400, 5);

    const snapshotPath = path.resolve('snapshots', `${ts}-person.png`);
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });

  it('PersonTensorShapes handles layout variations and retains candidates', async () => {
    const attributes = 6;
    const detections = 1;

    const channelFirst = new Float32Array(attributes * detections);
    setChannelFirstDetection(channelFirst, detections, 0, {
      cx: 320,
      cy: 320,
      width: 200,
      height: 200,
      objectnessLogit: 1.6,
      classLogit: 1.4
    });

    runMock.mockResolvedValueOnce({
      output0: {
        data: channelFirst,
        dims: [1, attributes, detections]
      }
    });

    const detectorA = await PersonDetector.create(
      {
        source: 'video:test-camera-a',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.4,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        maxDetections: 3
      },
      bus
    );

    const frame = createUniformFrame(1280, 720, 50);

    await detectorA.handleFrame(frame, 1);

    expect(events).toHaveLength(1);
    let meta = events[0].meta as Record<string, unknown>;
    const bboxFirst = meta?.bbox as { width: number; height: number };
    expect(bboxFirst.width).toBeCloseTo(400, 5);
    expect(bboxFirst.height).toBeCloseTo(400, 5);
    expect(meta?.score).toBeGreaterThan(0);

    events = [];
    runMock.mockReset();

    const channelLast = new Float32Array(detections * attributes);
    setChannelLastDetection(channelLast, attributes, 0, {
      cx: 300,
      cy: 280,
      width: 180,
      height: 160,
      objectnessLogit: 1.2,
      classLogit: 1.1
    });

    runMock.mockResolvedValueOnce({
      output0: {
        data: channelLast,
        dims: [1, detections, attributes]
      }
    });

    const detectorB = await PersonDetector.create(
      {
        source: 'video:test-camera-b',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.3,
        snapshotDir: 'snapshots',
        minIntervalMs: 0
      },
      bus
    );

    await detectorB.handleFrame(frame, 2);

    expect(events).toHaveLength(1);
    meta = events[0].meta as Record<string, unknown>;
    expect(meta?.score).toBeGreaterThan(0);
    expect(meta?.score).toBeLessThanOrEqual(1);
    const bbox = meta?.bbox as { left: number; top: number; width: number; height: number };
    expect(bbox.width).toBeCloseTo(360, 5);
    expect(bbox.height).toBeCloseTo(320, 5);
    expect(bbox.left).toBeGreaterThanOrEqual(0);
    expect(bbox.top).toBeGreaterThanOrEqual(0);
    const candidates = meta?.detections as Array<Record<string, unknown>>;
    expect(candidates?.length).toBeGreaterThanOrEqual(1);
    expect(candidates?.[0]?.score).toBe(meta?.score);
  });

  it('PersonMissingModel falls back to mock detections when ONNX model is absent', async () => {
    ort.InferenceSession.create.mockRejectedValueOnce(
      new Error("Load model from models/yolov8n.onnx failed:Load model models/yolov8n.onnx failed. File doesn't exist")
    );

    const detector = await PersonDetector.create(
      {
        source: 'video:test-camera',
        modelPath: 'missing-model.onnx',
        scoreThreshold: 0.4,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        maxDetections: 2
      },
      bus
    );

    const frame = createUniformFrame(640, 480, 80);
    const ts = 987654321;

    await detector.handleFrame(frame, ts);

    expect(runMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);

    const meta = events[0]?.meta as Record<string, unknown>;
    expect(meta?.score).toBeGreaterThan(0);
    expect(meta?.score).toBeLessThanOrEqual(1);
    expect(meta?.classId).toBe(0);
    expect(meta?.objectness).toBeGreaterThan(0);
    expect(meta?.classProbability).toBeGreaterThan(0);

    const bbox = meta?.bbox as { left: number; top: number; width: number; height: number };
    expect(bbox.left).toBeGreaterThanOrEqual(0);
    expect(bbox.top).toBeGreaterThanOrEqual(0);
    expect(bbox.width).toBeGreaterThan(0);
    expect(bbox.height).toBeGreaterThan(0);

    const candidates = meta?.detections as Array<Record<string, unknown>>;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates?.length).toBeGreaterThanOrEqual(1);

    const snapshotPath = path.resolve('snapshots', `${ts}-person.png`);
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });
});

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

function setChannelFirstDetection(
  data: Float32Array,
  detections: number,
  index: number,
  values: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    objectnessLogit: number;
    classLogit: number;
  }
) {
  data[0 * detections + index] = values.cx;
  data[1 * detections + index] = values.cy;
  data[2 * detections + index] = values.width;
  data[3 * detections + index] = values.height;
  data[4 * detections + index] = values.objectnessLogit;
  data[5 * detections + index] = values.classLogit;
}

function setChannelLastDetection(
  data: Float32Array,
  attributes: number,
  index: number,
  values: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    objectnessLogit: number;
    classLogit: number;
  }
) {
  const offset = index * attributes;
  data[offset + 0] = values.cx;
  data[offset + 1] = values.cy;
  data[offset + 2] = values.width;
  data[offset + 3] = values.height;
  data[offset + 4] = values.objectnessLogit;
  data[offset + 5] = values.classLogit;
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}
