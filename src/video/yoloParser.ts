import type * as ort from 'onnxruntime-node';

export type PreprocessMeta = {
  scale: number;
  padX: number;
  padY: number;
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
  scaleX: number;
  scaleY: number;
};

export type BoundingBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type YoloDetection = {
  score: number;
  classId: number;
  bbox: BoundingBox;
  objectness: number;
  classProbability: number;
  areaRatio: number;
};

export interface ParseYoloDetectionsOptions {
  classIndex?: number;
  classIndices?: number[];
  scoreThreshold?: number;
  classScoreThresholds?: Record<number, number>;
  nmsThreshold?: number;
  maxDetections?: number;
}

const OBJECTNESS_INDEX = 4;
const CLASS_START_INDEX = 5;
const DEFAULT_NMS_IOU_THRESHOLD = 0.45;

export function parseYoloDetections(
  tensor: ort.OnnxValue,
  meta: PreprocessMeta,
  options: ParseYoloDetectionsOptions
): YoloDetection[] {
  const accessor = createTensorAccessor(tensor);

  if (!accessor) {
    return [];
  }

  const classIndices = resolveClassIndices(options, accessor.attributes);

  if (classIndices.length === 0) {
    return [];
  }

  const detections: YoloDetection[] = [];

  const resolveThreshold = createThresholdResolver(options);

  for (let detectionIndex = 0; detectionIndex < accessor.detections; detectionIndex += 1) {
    const objectnessLogit = accessor.get(detectionIndex, OBJECTNESS_INDEX);
    const objectness = sigmoid(objectnessLogit);

    if (!Number.isFinite(objectness) || objectness <= 0) {
      continue;
    }

    const cx = accessor.get(detectionIndex, 0);
    const cy = accessor.get(detectionIndex, 1);
    const width = accessor.get(detectionIndex, 2);
    const height = accessor.get(detectionIndex, 3);

    const bbox = projectBoundingBox(cx, cy, width, height, meta);

    if (bbox.width <= 0 || bbox.height <= 0) {
      continue;
    }

    const areaRatio = computeAreaRatio(bbox, meta);

    for (const classId of classIndices) {
      const attributeIndex = CLASS_START_INDEX + classId;
      if (attributeIndex >= accessor.attributes) {
        continue;
      }

      const classLogit = accessor.get(detectionIndex, attributeIndex);
      const classProbability = sigmoid(classLogit);

      if (!Number.isFinite(classProbability) || classProbability <= 0) {
        continue;
      }

      const score = clamp(objectness * classProbability, 0, 1);

      const threshold = resolveThreshold(classId);
      if (score < threshold) {
        continue;
      }

      detections.push({
        score,
        classId,
        bbox,
        objectness,
        classProbability,
        areaRatio
      });
    }
  }

  if (detections.length === 0) {
    return [];
  }

  const perClass = new Map<number, YoloDetection[]>();
  for (const detection of detections) {
    const existing = perClass.get(detection.classId);
    if (existing) {
      existing.push(detection);
    } else {
      perClass.set(detection.classId, [detection]);
    }
  }

  const nmsThreshold = options.nmsThreshold ?? DEFAULT_NMS_IOU_THRESHOLD;
  const filtered: YoloDetection[] = [];
  for (const [, candidates] of perClass) {
    filtered.push(...nonMaxSuppression(candidates, nmsThreshold));
  }

  filtered.sort((a, b) => b.score - a.score);

  const maxDetections = options.maxDetections ?? filtered.length;

  return filtered.slice(0, Math.max(1, maxDetections));
}

function resolveClassIndices(options: ParseYoloDetectionsOptions, attributeCount: number): number[] {
  const indices = options.classIndices ??
    (typeof options.classIndex === 'number' ? [options.classIndex] : [0]);

  const upperBound = Math.max(0, attributeCount - CLASS_START_INDEX);
  const sanitized = indices
    .map(value => Math.trunc(value))
    .filter(value => Number.isFinite(value) && value >= 0 && value < upperBound);

  if (sanitized.length > 0) {
    return Array.from(new Set(sanitized)).sort((a, b) => a - b);
  }

  const fallback = Math.min(upperBound - 1, 0);
  if (upperBound <= 0) {
    return [];
  }
  return [fallback];
}

function createTensorAccessor(tensor: ort.OnnxValue): TensorAccessor | null {
  const data = tensor.data as Float32Array | undefined;

  if (!data || data.length === 0) {
    return null;
  }

  const dims = tensor.dims ?? [];
  const dimsNoBatch = dims.length > 0 && dims[0] === 1 ? dims.slice(1) : dims;
  const totalSize = data.length;
  const candidates: TensorAccessor[] = [];

  if (dimsNoBatch.length >= 1) {
    const attributesFirst = dimsNoBatch[0];
    const detectionsFirst =
      dimsNoBatch.length > 1
        ? dimsNoBatch.slice(1).reduce((acc, value) => acc * value, 1)
        : 1;

    if (attributesFirst > 0 && detectionsFirst > 0 && attributesFirst * detectionsFirst === totalSize) {
      candidates.push({
        attributes: attributesFirst,
        detections: detectionsFirst,
        get: (detectionIndex, attributeIndex) => {
          if (attributeIndex >= attributesFirst || detectionIndex >= detectionsFirst) {
            return 0;
          }

          return data[attributeIndex * detectionsFirst + detectionIndex];
        }
      });
    }
  }

  if (dimsNoBatch.length >= 1) {
    const attributesLast = dimsNoBatch[dimsNoBatch.length - 1];
    const detectionsLast =
      dimsNoBatch.length > 1
        ? dimsNoBatch.slice(0, -1).reduce((acc, value) => acc * value, 1)
        : 1;

    if (attributesLast > 0 && detectionsLast > 0 && attributesLast * detectionsLast === totalSize) {
      candidates.push({
        attributes: attributesLast,
        detections: detectionsLast,
        get: (detectionIndex, attributeIndex) => {
          if (attributeIndex >= attributesLast || detectionIndex >= detectionsLast) {
            return 0;
          }

          return data[detectionIndex * attributesLast + attributeIndex];
        }
      });
    }
  }

  if (candidates.length === 0 && dimsNoBatch.length === 0) {
    const attributes = totalSize;
    if (attributes > CLASS_START_INDEX) {
      return {
        attributes,
        detections: 1,
        get: (_detectionIndex, attributeIndex) => data[attributeIndex] ?? 0
      };
    }
  }

  const valid = candidates.filter(candidate => candidate.attributes > CLASS_START_INDEX && candidate.detections > 0);

  if (valid.length === 0) {
    return null;
  }

  valid.sort((a, b) => a.attributes - b.attributes);

  return valid[0];
}

type TensorAccessor = {
  detections: number;
  attributes: number;
  get: (detectionIndex: number, attributeIndex: number) => number;
};

function projectBoundingBox(
  cx: number,
  cy: number,
  width: number,
  height: number,
  meta: PreprocessMeta
): BoundingBox {
  const left = cx - width / 2;
  const top = cy - height / 2;
  const right = cx + width / 2;
  const bottom = cy + height / 2;

  const scaleX = resolveScale(meta.scaleX, meta.scale);
  const scaleY = resolveScale(meta.scaleY, meta.scale);

  const mappedLeft = (left - meta.padX) / scaleX;
  const mappedTop = (top - meta.padY) / scaleY;
  const mappedRight = (right - meta.padX) / scaleX;
  const mappedBottom = (bottom - meta.padY) / scaleY;

  const clampedLeft = clamp(mappedLeft, 0, meta.originalWidth);
  const clampedTop = clamp(mappedTop, 0, meta.originalHeight);
  const clampedRight = clamp(mappedRight, 0, meta.originalWidth);
  const clampedBottom = clamp(mappedBottom, 0, meta.originalHeight);

  return {
    left: clampedLeft,
    top: clampedTop,
    width: Math.max(0, clampedRight - clampedLeft),
    height: Math.max(0, clampedBottom - clampedTop)
  };
}

function computeAreaRatio(bbox: BoundingBox, meta: PreprocessMeta) {
  const totalArea = meta.originalWidth * meta.originalHeight;

  if (totalArea <= 0) {
    return 0;
  }

  const area = Math.max(0, bbox.width) * Math.max(0, bbox.height);
  return clamp(area / totalArea, 0, 1);
}

function createThresholdResolver(options: ParseYoloDetectionsOptions) {
  const defaultThreshold = Math.max(0, Math.min(1, options.scoreThreshold ?? 0));
  const classThresholds = new Map<number, number>();
  if (options.classScoreThresholds) {
    for (const [key, value] of Object.entries(options.classScoreThresholds)) {
      const classId = Number(key);
      const threshold = Number(value);
      if (!Number.isFinite(classId) || classId < 0) {
        continue;
      }
      if (!Number.isFinite(threshold)) {
        continue;
      }
      classThresholds.set(classId, Math.max(0, Math.min(1, threshold)));
    }
  }

  return (classId: number) => classThresholds.get(classId) ?? defaultThreshold;
}

function resolveScale(primary?: number, fallback?: number) {
  const scale = typeof primary === 'number' && Number.isFinite(primary) ? primary : fallback;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale === 0) {
    return 1;
  }
  return scale;
}

function nonMaxSuppression(detections: YoloDetection[], threshold: number) {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const results: YoloDetection[] = [];

  for (const detection of sorted) {
    let keep = true;

    for (const existing of results) {
      const iou = intersectionOverUnion(detection.bbox, existing.bbox);
      if (iou > threshold) {
        keep = false;
        break;
      }
    }

    if (keep) {
      results.push(detection);
    }
  }

  return results;
}

function intersectionOverUnion(a: BoundingBox, b: BoundingBox) {
  const aRight = a.left + a.width;
  const aBottom = a.top + a.height;
  const bRight = b.left + b.width;
  const bBottom = b.top + b.height;

  const interLeft = Math.max(a.left, b.left);
  const interTop = Math.max(a.top, b.top);
  const interRight = Math.min(aRight, bRight);
  const interBottom = Math.min(aBottom, bBottom);

  const interWidth = Math.max(0, interRight - interLeft);
  const interHeight = Math.max(0, interBottom - interTop);
  const interArea = interWidth * interHeight;

  if (interArea === 0) {
    return 0;
  }

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;

  const union = areaA + areaB - interArea;

  if (union <= 0) {
    return 0;
  }

  return interArea / union;
}

export function computeIoU(a: BoundingBox, b: BoundingBox) {
  return intersectionOverUnion(a, b);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

export { DEFAULT_NMS_IOU_THRESHOLD };
export { CLASS_START_INDEX as YOLO_CLASS_START_INDEX };
