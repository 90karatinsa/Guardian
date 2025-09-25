import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PNG } from 'pngjs';
import FaceRegistry from '../src/video/faceRegistry.js';
import { clearFaces } from '../src/db.js';

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
        inputNames: ['image'],
        outputNames: ['embedding'],
        run: runMock
      }))
    },
    Tensor
  };
});

const ort = await import('onnxruntime-node');

describe('FaceRegistryEnrollment', () => {
  beforeEach(() => {
    clearFaces();
    runMock.mockReset();
  });

  afterEach(() => {
    clearFaces();
  });

  it('enrolls faces, matches by distance, and rejects distant embeddings', async () => {
    const registry = await FaceRegistry.create({ modelPath: 'models/face.onnx', embeddingSize: 4 });

    const faceImageA = createSolidFace([220, 190, 180]);
    const faceImageB = createSolidFace([80, 120, 160]);

    runMock.mockResolvedValueOnce({
      embedding: new ort.Tensor('float32', new Float32Array([0.3, 0.4, 0.5, 0.6]), [1, 4])
    });
    const alice = await registry.enroll(faceImageA, 'Alice', { group: 'staff' });
    expect(alice.label).toBe('Alice');
    expect(alice.metadata?.group).toBe('staff');

    runMock.mockResolvedValueOnce({
      embedding: new ort.Tensor('float32', new Float32Array([0.9, 0.1, 0.05, 0.02]), [1, 4])
    });
    const bob = await registry.enroll(faceImageB, 'Bob');
    expect(bob.id).not.toBe(alice.id);

    expect(registry.list()).toHaveLength(2);

    runMock.mockResolvedValueOnce({
      embedding: new ort.Tensor('float32', new Float32Array([0.31, 0.41, 0.52, 0.61]), [1, 4])
    });
    const match = await registry.identify(faceImageA, 0.25);
    expect(match.match?.face.label).toBe('Alice');
    expect(match.match?.distance).toBeLessThan(0.25);

    runMock.mockResolvedValueOnce({
      embedding: new ort.Tensor('float32', new Float32Array([0.1, 0.8, 0.1, 0.5]), [1, 4])
    });
    const miss = await registry.identify(faceImageA, 0.15);
    expect(miss.match).toBeNull();

    const removed = registry.remove(alice.id);
    expect(removed).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });
});

function createSolidFace(color: [number, number, number]) {
  const png = new PNG({ width: 4, height: 4 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
