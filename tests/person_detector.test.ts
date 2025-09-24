import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import PersonDetector from '../src/video/personDetector.js';

const runMock = vi.fn();

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

  it('emits event and saves snapshot when person score passes threshold', async () => {
    const detectionData = new Float32Array(84);
    detectionData[0] = 320;
    detectionData[1] = 320;
    detectionData[2] = 200;
    detectionData[3] = 200;
    detectionData[4] = 0.9;

    runMock.mockResolvedValue({
      output0: {
        data: detectionData,
        dims: [1, 84, 1]
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

    const frame = createUniformFrame(640, 640, 25);
    const ts = 1234567890;

    await detector.handleFrame(frame, ts);

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('person');
    expect(events[0].meta?.score).toBeCloseTo(0.9, 5);

    const bbox = events[0].meta?.bbox as { left: number; top: number; width: number; height: number };
    expect(bbox.left).toBeCloseTo(220, 0);
    expect(bbox.top).toBeCloseTo(220, 0);
    expect(bbox.width).toBeCloseTo(200, 0);
    expect(bbox.height).toBeCloseTo(200, 0);

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
