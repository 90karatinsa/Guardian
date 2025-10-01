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

  it('YoloClassPriorityTieBreak prioritizes person class and projection priority', () => {
    const classCount = 2;
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
      values.classLogits.forEach((logitValue, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        data[attributeIndex * detections + index] = logitValue;
      });
    };

    assignDetection(0, {
      cx: 320,
      cy: 240,
      width: 400,
      height: 300,
      objectnessLogit: logit(0.9),
      classLogits: [logit(0.9), logit(0.9)]
    });

    assignDetection(1, {
      cx: 120,
      cy: 120,
      width: 120,
      height: 100,
      objectnessLogit: logit(0.9),
      classLogits: [logit(0.9), logit(0.05)]
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
      classIndices: [0, 1],
      scoreThreshold: 0.5,
      nmsThreshold: 0.1
    });

    expect(results).toHaveLength(3);
    expect(results[0]?.classId).toBe(0);
    expect(results[1]?.classId).toBe(0);
    expect(results[2]?.classId).toBe(1);
    expect(results[0]?.score ?? 0).toBeCloseTo(results[2]?.score ?? 0, 5);
    expect(results[0]?.areaRatio ?? 0).toBeGreaterThan(results[1]?.areaRatio ?? 0);
  });

  it('YoloProjectionFallbacksToResizedDimensions', () => {
    const classCount = 2;
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
      cx: 0.52,
      cy: 0.48,
      width: 0.38,
      height: 0.34,
      objectnessLogit: 2.4,
      classLogits: [-4, 1.3]
    });

    assignDetection(1, {
      cx: 330,
      cy: 300,
      width: 180,
      height: 190,
      objectnessLogit: 2.1,
      classLogits: [-5, 1.1]
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      padX: 0,
      padY: 0,
      originalWidth: 0,
      originalHeight: 0,
      resizedWidth: 640,
      resizedHeight: 640,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      normalized: false,
      variants: [
        {
          padX: 48,
          padY: 24,
          originalWidth: 0,
          originalHeight: 0,
          resizedWidth: 640,
          resizedHeight: 640,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
          normalized: false
        },
        {
          padX: 0,
          padY: 0,
          originalWidth: 0,
          originalHeight: 0,
          resizedWidth: 640,
          resizedHeight: 640,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
          normalized: true
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [1],
      scoreThreshold: 0.4,
      classScoreThresholds: { 1: 0.6 },
      nmsThreshold: 0.5
    });

    expect(results).toHaveLength(1);
    const [detection] = results;
    expect(detection.bbox.left).toBeGreaterThanOrEqual(0);
    expect(detection.bbox.top).toBeGreaterThanOrEqual(0);
    expect(detection.bbox.left + detection.bbox.width).toBeLessThanOrEqual(640.0001);
    expect(detection.bbox.top + detection.bbox.height).toBeLessThanOrEqual(640.0001);
    expect(detection.areaRatio).toBeGreaterThan(0);
    expect(detection.appliedThreshold).toBeCloseTo(0.6, 5);
    expect(detection.fusion).toBeDefined();
    expect(detection.fusion?.contributors.length).toBe(2);
    const projectionSet = new Set(
      (detection.fusion?.contributors ?? []).map(contributor => contributor.projectionIndex)
    );
    expect(projectionSet.size).toBeGreaterThan(1);
    expect(detection.fusion?.confidence ?? 0).toBeGreaterThanOrEqual(detection.appliedThreshold);
  });

  it('YoloParserFiltersNonFiniteDetections', () => {
    const classCount = 3;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 3;
    const data = new Float32Array(attributes * detections).fill(0);

    const setDetection = (
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

    setDetection(0, {
      cx: 300,
      cy: 280,
      width: 180,
      height: 160,
      objectnessLogit: 2.2,
      classLogits: [-3, 2.4, -4]
    });

    setDetection(1, {
      cx: 120,
      cy: 160,
      width: Number.NaN,
      height: 140,
      objectnessLogit: 2.5,
      classLogits: [3, 3, 3]
    });

    setDetection(2, {
      cx: 400,
      cy: Number.POSITIVE_INFINITY,
      width: 120,
      height: 130,
      objectnessLogit: 1.8,
      classLogits: [2.2, 2.2, 2.2]
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 480,
      resizedWidth: 640,
      resizedHeight: 480,
      scale: 1,
      scaleX: 1,
      scaleY: 1
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [1, 0, 1, 2, 1],
      scoreThreshold: 0.5,
      classScoreThresholds: { 1: 0.6 }
    });

    expect(results).toHaveLength(1);
    const detection = results[0]!;
    expect(detection.classId).toBe(1);
    expect(detection.appliedThreshold).toBe(0.6);
    expect(Number.isFinite(detection.bbox.left)).toBe(true);
    expect(Number.isFinite(detection.bbox.top)).toBe(true);
    expect(Number.isFinite(detection.bbox.width)).toBe(true);
    expect(Number.isFinite(detection.bbox.height)).toBe(true);
    expect(detection.score).toBeGreaterThan(0.6);
    expect('priorityScore' in detection).toBe(false);
  });

  it('PersonDetectorMaxDetectionsBounds respects zero and fractional limits', () => {
    const classCount = 1;
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
        classLogit: number;
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = values.objectnessLogit;
      data[(YOLO_CLASS_START_INDEX + 0) * detections + index] = values.classLogit;
    };

    assignDetection(0, {
      cx: 160,
      cy: 160,
      width: 120,
      height: 140,
      objectnessLogit: 3,
      classLogit: 3.2
    });

    assignDetection(1, {
      cx: 200,
      cy: 220,
      width: 140,
      height: 160,
      objectnessLogit: 2.8,
      classLogit: 2.6
    });

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      padX: 0,
      padY: 0,
      originalWidth: 320,
      originalHeight: 320,
      resizedWidth: 320,
      resizedHeight: 320,
      scale: 1,
      scaleX: 1,
      scaleY: 1
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const unlimited = parseYoloDetections(tensor, meta, {
      classIndex: 0,
      scoreThreshold: 0.1
    });
    expect(unlimited).toHaveLength(2);

    const zeroLimited = parseYoloDetections(tensor, meta, {
      classIndex: 0,
      scoreThreshold: 0.1,
      maxDetections: 0
    });
    expect(zeroLimited).toHaveLength(0);

    const fractionalLimit = parseYoloDetections(tensor, meta, {
      classIndex: 0,
      scoreThreshold: 0.1,
      maxDetections: 1.4
    });
    expect(fractionalLimit).toHaveLength(1);
    expect(fractionalLimit[0]?.bbox.width).toBeCloseTo(120, 5);
  });

  it('YoloParserClampsOutOfFrame ensures bounding boxes stay within frame bounds', () => {
    const classCount = 1;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 1;
    const data = new Float32Array(attributes * detections).fill(0);

    data[0 * detections + 0] = 1000;
    data[1 * detections + 0] = -200;
    data[2 * detections + 0] = 900;
    data[3 * detections + 0] = 800;
    data[OBJECTNESS_INDEX * detections + 0] = logit(0.95);
    data[YOLO_CLASS_START_INDEX * detections + 0] = logit(0.92);

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 480,
      resizedWidth: 640,
      resizedHeight: 480,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      variants: [
        {
          padX: 0,
          padY: 0,
          originalWidth: 1280,
          originalHeight: 720,
          resizedWidth: 1280,
          resizedHeight: 720,
          scale: 1,
          scaleX: 1,
          scaleY: 1
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const [detection] = parseYoloDetections(tensor, meta, {
      classIndices: [0],
      scoreThreshold: 0.5
    });

    expect(detection).toBeDefined();
    const bbox = detection.bbox;
    expect(bbox.left).toBeGreaterThanOrEqual(0);
    expect(bbox.top).toBeGreaterThanOrEqual(0);
    expect(bbox.left + bbox.width).toBeLessThanOrEqual(meta.originalWidth);
    expect(bbox.top + bbox.height).toBeLessThanOrEqual(meta.originalHeight);
    expect(bbox.width).toBeLessThanOrEqual(meta.originalWidth);
    expect(bbox.height).toBeLessThanOrEqual(meta.originalHeight);
    expect(bbox.left).toBeLessThan(meta.originalWidth);
    expect(bbox.width).toBeGreaterThan(0);
    expect(bbox.height).toBeGreaterThan(0);
  });

  it('YoloProjectionClampUsesVariant', () => {
    const attributes = YOLO_CLASS_START_INDEX + 1;
    const detections = 1;
    const data = new Float32Array(attributes * detections).fill(0);

    data[0 * detections + 0] = 0.5;
    data[1 * detections + 0] = 0.5;
    data[2 * detections + 0] = 1.4;
    data[3 * detections + 0] = 1.4;
    data[OBJECTNESS_INDEX * detections + 0] = 4.2;
    data[(YOLO_CLASS_START_INDEX + 0) * detections + 0] = 4.1;

    const tensor = new ort.Tensor('float32', data, [1, attributes, detections]);

    const meta = {
      padX: 0,
      padY: 0,
      originalWidth: 1280,
      originalHeight: 720,
      resizedWidth: 640,
      resizedHeight: 360,
      scale: 0.5,
      scaleX: 0.5,
      scaleY: 0.5,
      variants: [
        {
          padX: 0,
          padY: 0,
          originalWidth: 640,
          originalHeight: 360,
          resizedWidth: 640,
          resizedHeight: 360,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
          normalized: true
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndices: [0],
      scoreThreshold: 0.1
    });

    expect(results).toHaveLength(1);
    const detection = results[0]!;
    expect(detection.projectionIndex).toBe(1);
    expect(detection.normalizedProjection).toBe(true);
    expect(detection.bbox.left).toBeCloseTo(0, 5);
    expect(detection.bbox.top).toBeCloseTo(0, 5);
    expect(detection.bbox.width).toBeCloseTo(640, 5);
    expect(detection.bbox.height).toBeCloseTo(360, 5);
    expect(detection.areaRatio).toBeCloseTo(1, 5);
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

  it('YoloParserPersonNms suppresses overlapping boxes in channel-last tensors', () => {
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
      nmsThreshold: 0.4,
      maxDetections: 2
    });

    expect(results).toHaveLength(2);
    const person = results.find(result => result.classId === 0);
    const packageDetection = results.find(result => result.classId === 1);

    expect(person).toBeDefined();
    expect(person?.score ?? 0).toBeCloseTo(sigmoid(logit(0.95) + logit(0.9)), 5);
    expect(person?.appliedThreshold ?? 0).toBeCloseTo(0.6, 5);
    expect(packageDetection).toBeDefined();
    expect(packageDetection?.score ?? 0).toBeGreaterThan(0.7);
    expect(packageDetection?.appliedThreshold ?? 0).toBeCloseTo(0.75, 5);

    const duplicate = results.filter(result => result.classId === 0);
    expect(duplicate).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(results[1].score ?? 0);
  });

  it('YoloParserProjectionPriority suppresses duplicate person detections across projections', () => {
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
      cx: 0.5,
      cy: 0.5,
      width: 0.32,
      height: 0.45,
      objectness: 0.82,
      classProbabilities: [0.78, 0.28]
    });

    assign(1, {
      cx: 381,
      cy: 357,
      width: 226,
      height: 316,
      objectness: 0.8,
      classProbabilities: [0.75, 0.25]
    });

    assign(2, {
      cx: 0.8,
      cy: 0.4,
      width: 0.1,
      height: 0.12,
      objectness: 0.7,
      classProbabilities: [0.05, 0.82]
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
      normalized: true,
      variants: [
        {
          padX: 64,
          padY: 32,
          originalWidth: 1280,
          originalHeight: 720,
          resizedWidth: 704,
          resizedHeight: 704,
          scaleX: 704 / 1280,
          scaleY: 704 / 720,
          normalized: false
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndex: 0,
      classIndices: [0, 1],
      scoreThreshold: 0.2,
      nmsThreshold: 0.4,
      maxDetections: 3
    });

    const personDetections = results.filter(result => result.classId === 0);
    const packageDetections = results.filter(result => result.classId === 1);

    expect(personDetections).toHaveLength(1);
    expect(packageDetections.length).toBeGreaterThanOrEqual(1);
    const person = personDetections[0]!;
    expect(person.projectionIndex).toBe(0);
    expect(person.normalizedProjection).toBe(true);
    expect(person.bbox.width).toBeGreaterThan(300);
    expect(person.bbox.width).toBeLessThan(500);
    expect(person.priorityScore).toBeUndefined();
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

  it('YoloParserMultiOutputPerson merges tensors and prioritizes person detections', () => {
    const classCount = 2;
    const attributes = YOLO_CLASS_START_INDEX + classCount;

    const scaleTensor = new Float32Array(attributes * 1).fill(0);
    const assignScale = (
      buffer: Float32Array,
      detectionIndex: number,
      values: {
        cx: number;
        cy: number;
        width: number;
        height: number;
        objectness: number;
        classProbabilities: number[];
      }
    ) => {
      const detectionsCount = buffer.length / attributes;
      buffer[0 * detectionsCount + detectionIndex] = values.cx;
      buffer[1 * detectionsCount + detectionIndex] = values.cy;
      buffer[2 * detectionsCount + detectionIndex] = values.width;
      buffer[3 * detectionsCount + detectionIndex] = values.height;
      buffer[OBJECTNESS_INDEX * detectionsCount + detectionIndex] = logit(values.objectness);
      values.classProbabilities.forEach((probability, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        buffer[attributeIndex * detectionsCount + detectionIndex] = logit(probability);
      });
    };

    assignScale(scaleTensor, 0, {
      cx: 320,
      cy: 320,
      width: 150,
      height: 260,
      objectness: 0.92,
      classProbabilities: [0.9, 0.15]
    });

    const headTensor = new Float32Array(2 * attributes).fill(0);
    const assignHead = (
      buffer: Float32Array,
      detectionIndex: number,
      values: {
        cx: number;
        cy: number;
        width: number;
        height: number;
        objectness: number;
        classProbabilities: number[];
      }
    ) => {
      const base = detectionIndex * attributes;
      buffer[base + 0] = values.cx;
      buffer[base + 1] = values.cy;
      buffer[base + 2] = values.width;
      buffer[base + 3] = values.height;
      buffer[base + OBJECTNESS_INDEX] = logit(values.objectness);
      values.classProbabilities.forEach((prob, offset) => {
        const attributeIndex = YOLO_CLASS_START_INDEX + offset;
        buffer[base + attributeIndex] = logit(prob);
      });
    };

    assignHead(headTensor, 0, {
      cx: 0.52,
      cy: 0.5,
      width: 0.26,
      height: 0.44,
      objectness: 0.85,
      classProbabilities: [0.78, 0.2]
    });

    assignHead(headTensor, 1, {
      cx: 0.58,
      cy: 0.52,
      width: 0.3,
      height: 0.5,
      objectness: 0.72,
      classProbabilities: [0.22, 0.81]
    });

    const tensorA = new ort.Tensor('float32', scaleTensor, [1, attributes, 1]);
    const tensorB = new ort.Tensor('float32', headTensor, [1, 2, attributes]);

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
          resizedWidth: 704,
          resizedHeight: 704,
          scaleX: 704 / 640,
          scaleY: 704 / 480,
          normalized: true
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections([tensorA, tensorB], meta, {
      classIndices: [0, 1],
      classIndex: 0,
      scoreThreshold: 0.35,
      nmsThreshold: 0.45,
      maxDetections: 3
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.classId).toBe(0);
    expect(results[0]?.score ?? 0).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.areaRatio ?? 0).toBeGreaterThan(0);
    const classes = results.map(result => result.classId);
    expect(classes).toContain(0);
    expect(classes).toContain(1);
    const projectionIndices = new Set(results.map(result => result.projectionIndex));
    expect(projectionIndices.size).toBeGreaterThanOrEqual(1);
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
  it('YoloParserNormalizedProjection rescales normalized candidates with padding', () => {
    const attributes = YOLO_CLASS_START_INDEX + 1;
    const detections = 1;
    const data = new Float32Array(attributes * detections).fill(0);

    const assignNormalized = (
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

    assignNormalized(0, {
      cx: 0.52,
      cy: 0.46,
      width: 0.28,
      height: 0.48,
      objectness: 0.82,
      classProbability: 0.88
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
      scaleX: 640 / 1280,
      scaleY: 640 / 720,
      variants: [
        {
          scale: 0.5,
          padX: 0,
          padY: 140,
          originalWidth: 1280,
          originalHeight: 720,
          resizedWidth: 640,
          resizedHeight: 640,
          scaleX: 640 / 1280,
          scaleY: 640 / 720,
          normalized: true
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const [detection] = parseYoloDetections(tensor, meta, { scoreThreshold: 0.3, classIndex: 0 });
    expect(detection).toBeDefined();
    expect(detection.normalizedProjection).toBe(true);
    expect(detection.projectionIndex).toBe(1);
    expect(detection.bbox.left).toBeCloseTo(486.4, 1);
    expect(detection.bbox.top).toBeCloseTo(0.9, 1);
    expect(detection.bbox.width).toBeCloseTo(358.4, 1);
    expect(detection.bbox.height).toBeCloseTo(345.6, 1);
    expect(detection.areaRatio).toBeCloseTo((358.4 * 345.6) / (1280 * 720), 5);
    expect(detection.score).toBeGreaterThan(0.6);
  });

  it('YoloParserPriorityScoreOrdering', () => {
    const classCount = 1;
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
        objectness: number;
        classProbability: number;
      }
    ) => {
      data[0 * detections + index] = values.cx;
      data[1 * detections + index] = values.cy;
      data[2 * detections + index] = values.width;
      data[3 * detections + index] = values.height;
      data[OBJECTNESS_INDEX * detections + index] = logit(values.objectness);
      data[(YOLO_CLASS_START_INDEX + 0) * detections + index] = logit(values.classProbability);
    };

    assignDetection(0, {
      cx: 0.5,
      cy: 0.5,
      width: 0.32,
      height: 0.45,
      objectness: 0.72,
      classProbability: 0.82
    });

    assignDetection(1, {
      cx: 381,
      cy: 357,
      width: 226,
      height: 316,
      objectness: 0.88,
      classProbability: 0.9
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
      normalized: true,
      variants: [
        {
          padX: 64,
          padY: 32,
          originalWidth: 1280,
          originalHeight: 720,
          resizedWidth: 704,
          resizedHeight: 704,
          scaleX: 704 / 1280,
          scaleY: 704 / 720,
          normalized: false
        }
      ]
    } satisfies Parameters<typeof parseYoloDetections>[1];

    const results = parseYoloDetections(tensor, meta, {
      classIndex: 0,
      scoreThreshold: 0.4,
      nmsThreshold: 0.4,
      maxDetections: 2
    });

    expect(results).toHaveLength(1);
    const [first] = results;
    expect(first?.classId).toBe(0);

    const contributors = first?.fusion?.contributors ?? [];
    expect(contributors.length).toBeGreaterThanOrEqual(2);
    expect(contributors[0]?.normalizedProjection).toBe(true);
    expect(contributors[0]?.score ?? 0).toBeLessThan(contributors[1]?.score ?? 0);
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
    const expectedScore = sigmoid(2.2 + 2.1);
    const areaRatio = (400 * 400) / (1280 * 720);
    const harmonic = expectedObjectness + expectedClassProbability === 0
      ? 0
      : (2 * expectedObjectness * expectedClassProbability) /
        (expectedObjectness + expectedClassProbability);
    const synergy = 1 / (1 + Math.exp(-(logit(expectedScore) + logit(Math.max(harmonic, 1e-6)))));
    let expectedConfidence = Math.max(0, Math.min(1, expectedScore * 0.55 + harmonic * 0.2 + synergy * 0.15 + Math.sqrt(areaRatio) * 0.1));
    const minimum = Math.min(expectedObjectness, expectedClassProbability);
    const geometric = Math.sqrt(expectedObjectness * expectedClassProbability);
    expectedConfidence = Math.max(0, Math.min(1, expectedConfidence * 0.6 + minimum * 0.2 + geometric * 0.15 + areaRatio * 0.05));
    expect(meta?.score).toBeCloseTo(expectedObjectness * expectedClassProbability, 5);
    expect(meta?.score).toBeGreaterThan(0);
    expect(meta?.score).toBeLessThanOrEqual(1);
    expect(meta?.classId).toBe(0);
    expect(meta?.objectness).toBeCloseTo(expectedObjectness, 5);
    expect(meta?.classProbability).toBeCloseTo(expectedClassProbability, 5);
    expect(meta?.confidence).toBeCloseTo(expectedConfidence, 5);
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

  it('PersonDetectorCustomNmsThreshold surfaces metadata value', async () => {
    const detections = 1;
    const attributes = 6;
    const detectionData = new Float32Array(attributes * detections);

    setChannelFirstDetection(detectionData, detections, 0, {
      cx: 320,
      cy: 320,
      width: 220,
      height: 200,
      objectnessLogit: 2.3,
      classLogit: 2.2
    });

    runMock.mockResolvedValueOnce({
      output0: {
        data: detectionData,
        dims: [1, attributes, detections]
      }
    });

    const detector = await PersonDetector.create(
      {
        source: 'video:custom-nms',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.5,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        nmsThreshold: 0.33
      },
      bus
    );

    const frame = createUniformFrame(1280, 720, 30);
    await detector.handleFrame(frame, 1234);

    expect(events).toHaveLength(1);
    const meta = events[0]?.meta as Record<string, unknown>;
    expect(meta?.thresholds?.nms).toBeCloseTo(0.33, 5);
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

  it('PersonDetectorClassThresholds enforces per-class limits across multi outputs', async () => {
    const attributes = 6;
    const detectionsFirst = 1;
    const detectionsSecond = 1;

    const firstHead = new Float32Array(attributes * detectionsFirst);
    setChannelFirstDetection(firstHead, detectionsFirst, 0, {
      cx: 320,
      cy: 320,
      width: 200,
      height: 200,
      objectnessLogit: Math.log(0.85 / 0.15),
      classLogit: Math.log(0.2 / 0.8)
    });

    const secondHead = new Float32Array(detectionsSecond * attributes);
    setChannelLastDetection(secondHead, attributes, 0, {
      cx: 315,
      cy: 318,
      width: 198,
      height: 202,
      objectnessLogit: Math.log(0.88 / 0.12),
      classLogit: Math.log(0.2 / 0.8)
    });

    const frame = createUniformFrame(1280, 720, 45);

    runMock.mockResolvedValueOnce({
      output0: { data: firstHead, dims: [1, attributes, detectionsFirst] },
      output1: { data: secondHead, dims: [1, detectionsSecond, attributes] }
    });

    const highThresholdDetector = await PersonDetector.create(
      {
        source: 'video:threshold-high',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.4,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        classScoreThresholds: { 0: 0.7 }
      },
      bus
    );

    await highThresholdDetector.handleFrame(frame, 10);
    expect(events).toHaveLength(0);

    events = [];
    runMock.mockReset();
    runMock.mockResolvedValueOnce({
      output0: { data: firstHead, dims: [1, attributes, detectionsFirst] },
      output1: { data: secondHead, dims: [1, detectionsSecond, attributes] }
    });

    const lowThresholdDetector = await PersonDetector.create(
      {
        source: 'video:threshold-low',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.4,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        classScoreThresholds: { 0: 0.5 }
      },
      bus
    );

    await lowThresholdDetector.handleFrame(frame, 20);
    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta?.score).toBeGreaterThan(0);
    expect(meta?.thresholds?.classScoreThresholds).toMatchObject({ 0: 0.5 });
    expect((meta?.detections as Array<Record<string, unknown>>)?.length).toBe(1);
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

  it('PersonDetectorFusionThresholds annotates fusion confidence and applied overrides', async () => {
    const logit = (probability: number) => Math.log(probability / (1 - probability));
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
        classProbabilities: [number, number];
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
      cx: 0.49,
      cy: 0.51,
      width: 0.3,
      height: 0.45,
      objectness: 0.88,
      classProbabilities: [0.82, 0.1]
    });

    assign(1, {
      cx: 0.51,
      cy: 0.5,
      width: 0.28,
      height: 0.43,
      objectness: 0.86,
      classProbabilities: [0.79, 0.18]
    });

    assign(2, {
      cx: 420,
      cy: 320,
      width: 190,
      height: 210,
      objectness: 0.83,
      classProbabilities: [0.24, 0.76]
    });

    runMock.mockResolvedValueOnce({
      output0: { data, dims: [1, attributes, detections] }
    });

    const detector = await PersonDetector.create(
      {
        source: 'video:fusion-thresholds',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.45,
        snapshotDir: 'snapshots',
        minIntervalMs: 0,
        classIndices: [0, 1],
        classScoreThresholds: { 1: 0.75 },
        maxDetections: 3
      },
      bus
    );

    const frame = createUniformFrame(1280, 720, 72);
    await detector.handleFrame(frame, 4242);

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, any>;
    expect(meta?.fusion).toBeDefined();
    const fusion = meta!.fusion as { confidence: number; contributors: unknown[] };
    expect(typeof fusion.confidence).toBe('number');
    expect(fusion.contributors.length).toBeGreaterThanOrEqual(2);

    const thresholds = meta!.thresholds as { applied?: Record<string, number>; classScoreThresholds?: Record<string, number> };
    expect(thresholds.applied?.['0']).toBeCloseTo(0.45, 5);
    expect(thresholds.classScoreThresholds?.['1']).toBeCloseTo(0.75, 5);

    const detectionsMeta = Array.isArray(meta?.detections) ? (meta!.detections as Array<Record<string, any>>) : [];
    expect(detectionsMeta.length).toBeGreaterThanOrEqual(1);
    const person = detectionsMeta.find(entry => entry.classId === 0);
    expect(person).toBeDefined();
    expect(person?.fusion?.confidence).toBeCloseTo(fusion.confidence, 5);
    expect(person?.appliedThreshold).toBeCloseTo(thresholds.applied?.['0'] ?? 0, 5);
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
