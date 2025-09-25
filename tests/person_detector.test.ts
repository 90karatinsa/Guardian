import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import PersonDetector from '../src/video/personDetector.js';
import {
  DEFAULT_NMS_IOU_THRESHOLD,
  YOLO_CLASS_START_INDEX,
  computeIoU,
  parseYoloDetections
} from '../src/video/yoloParser.js';

const runMock = vi.fn();

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

  it('PersonDetectionsNms suppresses overlaps and emits capped candidates', async () => {
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
        maxDetections: 1
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

    const bbox = meta?.bbox as { left: number; top: number; width: number; height: number };
    expect(bbox.left).toBeCloseTo(440, 5);
    expect(bbox.top).toBeCloseTo(160, 5);
    expect(bbox.width).toBeCloseTo(400, 5);
    expect(bbox.height).toBeCloseTo(400, 5);

    expect(meta?.areaRatio).toBeCloseTo((400 * 400) / (1280 * 720), 5);

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

describe('YoloParser', () => {
  it('YoloParserMultiClass orders detections per class with IoU suppression', () => {
    const classCount = 3;
    const attributes = YOLO_CLASS_START_INDEX + classCount;
    const detections = 2;
    const data = new Float32Array(attributes * detections).fill(0);

    setChannelFirstDetection(data, detections, 0, {
      cx: 300,
      cy: 260,
      width: 180,
      height: 220,
      objectnessLogit: 2.4,
      classLogit: 2.1
    });
    // additional classes for detection 0
    data[(YOLO_CLASS_START_INDEX + 1) * detections + 0] = 1.6;
    data[(YOLO_CLASS_START_INDEX + 2) * detections + 0] = -4;

    setChannelFirstDetection(data, detections, 1, {
      cx: 310,
      cy: 270,
      width: 175,
      height: 210,
      objectnessLogit: 1.7,
      classLogit: 1.5
    });
    data[(YOLO_CLASS_START_INDEX + 1) * detections + 1] = 1.4;
    data[(YOLO_CLASS_START_INDEX + 2) * detections + 1] = -2.5;

    const meta = {
      scale: 1,
      padX: 0,
      padY: 0,
      originalWidth: 640,
      originalHeight: 480
    };

    const tensor = { data, dims: [1, attributes, detections] } as any;
    const result = parseYoloDetections(tensor, meta, {
      classIndices: [0, 1, 2],
      scoreThreshold: 0.2,
      nmsThreshold: DEFAULT_NMS_IOU_THRESHOLD,
      maxDetections: 5
    });

    // Expect detections for class 0 and 1 but class 2 scores fall below threshold
    const classIds = result.map(candidate => candidate.classId);
    expect(classIds.every(id => id === 0 || id === 1)).toBe(true);
    expect(classIds.filter(id => id === 0)).toHaveLength(1);
    expect(classIds.filter(id => id === 1)).toHaveLength(1);

    const [personDetection] = result.filter(candidate => candidate.classId === 0);
    const [catDetection] = result.filter(candidate => candidate.classId === 1);
    expect(personDetection).toBeDefined();
    expect(catDetection).toBeDefined();
    const person = personDetection!;
    const cat = catDetection!;
    expect(person.score).toBeGreaterThan(cat.score);
    expect(person.score).toBeGreaterThan(0.5);
    expect(cat.score).toBeGreaterThan(0.4);

    const iou = computeIoU(person.bbox, {
      left: 310 - 175 / 2,
      top: 270 - 210 / 2,
      width: 175,
      height: 210
    });
    expect(iou).toBeGreaterThan(0.4);
    expect(iou).toBeCloseTo(0.82, 2);
    expect(result.length).toBe(2);
    expect(person.areaRatio).toBeGreaterThan(0);
    expect(cat.areaRatio).toBeGreaterThan(0);
    expect(person.bbox.width).toBeCloseTo(180, 5);
    expect(cat.bbox.height).toBeCloseTo(220, 5);
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
