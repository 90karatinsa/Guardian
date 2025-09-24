import { PNG } from 'pngjs';

export type GrayscaleFrame = {
  width: number;
  height: number;
  data: Uint8Array;
};

export function readFrameAsGrayscale(pngBuffer: Buffer): GrayscaleFrame {
  const image = PNG.sync.read(pngBuffer);
  const { width, height, data } = image;
  const grayscale = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    // Rec. 709 luma coefficients
    grayscale[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }

  return { width, height, data: grayscale };
}

export function gaussianBlur(frame: GrayscaleFrame): GrayscaleFrame {
  const { width, height, data } = frame;
  const output = new Uint8Array(width * height);
  const kernel = [
    [1, 2, 1],
    [2, 4, 2],
    [1, 2, 1]
  ];
  const kernelSum = 16;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;

      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const weight = kernel[ky + 1][kx + 1];
          if (weight === 0) {
            continue;
          }

          const sampleX = clamp(x + kx, 0, width - 1);
          const sampleY = clamp(y + ky, 0, height - 1);
          total += data[sampleY * width + sampleX] * weight;
        }
      }

      output[y * width + x] = Math.round(total / kernelSum);
    }
  }

  return {
    width,
    height,
    data: output
  };
}

export function medianFilter(frame: GrayscaleFrame): GrayscaleFrame {
  const { width, height, data } = frame;
  const output = new Uint8Array(width * height);
  const window: number[] = new Array(9);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let idx = 0;

      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const sampleX = clamp(x + kx, 0, width - 1);
          const sampleY = clamp(y + ky, 0, height - 1);
          window[idx] = data[sampleY * width + sampleX];
          idx += 1;
        }
      }

      window.sort((a, b) => a - b);
      output[y * width + x] = window[4];
    }
  }

  return {
    width,
    height,
    data: output
  };
}

export function averageLuminance(frame: GrayscaleFrame): number {
  let total = 0;
  const { data } = frame;

  for (let i = 0; i < data.length; i += 1) {
    total += data[i];
  }

  return total / data.length;
}

export type DiffStats = {
  deltas: Uint8Array;
  totalPixels: number;
  meanDelta: number;
  maxDelta: number;
};

export function frameDiffStats(
  previous: GrayscaleFrame,
  current: GrayscaleFrame
): DiffStats {
  if (previous.width !== current.width || previous.height !== current.height) {
    throw new Error('Frame dimensions must match for diff comparison');
  }

  const totalPixels = current.data.length;
  const deltas = new Uint8Array(totalPixels);
  let sum = 0;
  let maxDelta = 0;

  for (let i = 0; i < totalPixels; i += 1) {
    const delta = Math.abs(current.data[i] - previous.data[i]);
    deltas[i] = delta;
    sum += delta;
    if (delta > maxDelta) {
      maxDelta = delta;
    }
  }

  return {
    deltas,
    totalPixels,
    meanDelta: sum / totalPixels,
    maxDelta
  };
}

export function diffAreaPercentage(
  previous: GrayscaleFrame,
  current: GrayscaleFrame,
  threshold: number
): number {
  const stats = frameDiffStats(previous, current);
  let changedPixels = 0;

  for (let i = 0; i < stats.totalPixels; i += 1) {
    if (stats.deltas[i] >= threshold) {
      changedPixels += 1;
    }
  }

  return changedPixels / stats.totalPixels;
}

function clamp(value: number, min: number, max: number) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
