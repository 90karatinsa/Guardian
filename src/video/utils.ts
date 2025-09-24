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

export function averageLuminance(frame: GrayscaleFrame): number {
  let total = 0;
  const { data } = frame;

  for (let i = 0; i < data.length; i += 1) {
    total += data[i];
  }

  return total / data.length;
}

export function diffAreaPercentage(
  previous: GrayscaleFrame,
  current: GrayscaleFrame,
  threshold: number
): number {
  if (previous.width !== current.width || previous.height !== current.height) {
    throw new Error('Frame dimensions must match for diff comparison');
  }

  const totalPixels = current.data.length;
  let changedPixels = 0;

  for (let i = 0; i < totalPixels; i += 1) {
    const delta = Math.abs(current.data[i] - previous.data[i]);
    if (delta >= threshold) {
      changedPixels += 1;
    }
  }

  return changedPixels / totalPixels;
}
