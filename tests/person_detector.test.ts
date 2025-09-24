import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import PersonDetector from '../src/video/personDetector.js';

const runMock = vi.fn();

vi.mock('pngjs', () => {
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
        return Buffer.from(png.data);
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
  });

  afterEach(() => {
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
    }
  });

  it('PersonNmsParsing suppresses overlaps and rescales bounding boxes', async () => {
    const stride = 2;
    const channels = 6;
    const detectionData = new Float32Array(channels * stride);

    setDetection(detectionData, stride, 0, {
      cx: 320,
      cy: 320,
      width: 200,
      height: 200,
      objectness: 0.9,
      classScore: 0.95
    });

    setDetection(detectionData, stride, 1, {
      cx: 330,
      cy: 330,
      width: 210,
      height: 210,
      objectness: 0.85,
      classScore: 0.9
    });

    runMock.mockResolvedValue({
      output0: {
        data: detectionData,
        dims: [1, channels, stride]
      }
    });

    const detector = await PersonDetector.create(
      {
        source: 'video:test-camera',
        modelPath: 'models/yolov8n.onnx',
        scoreThreshold: 0.5,
        snapshotDir: 'snapshots',
        minIntervalMs: 0
      },
      bus
    );

    const frame = createUniformFrame(1280, 720, 25);
    const ts = 1234567890;

    await detector.handleFrame(frame, ts);

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta?.score).toBeCloseTo(0.855, 3);
    expect(meta?.classId).toBe(0);

    const bbox = meta?.bbox as { left: number; top: number; width: number; height: number };
    expect(bbox.left).toBeCloseTo(440, 5);
    expect(bbox.top).toBeCloseTo(160, 5);
    expect(bbox.width).toBeCloseTo(400, 5);
    expect(bbox.height).toBeCloseTo(400, 5);

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

function setDetection(
  data: Float32Array,
  stride: number,
  index: number,
  values: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    objectness: number;
    classScore: number;
  }
) {
  data[0 * stride + index] = values.cx;
  data[1 * stride + index] = values.cy;
  data[2 * stride + index] = values.width;
  data[3 * stride + index] = values.height;
  data[4 * stride + index] = values.objectness;
  data[5 * stride + index] = values.classScore;
}
