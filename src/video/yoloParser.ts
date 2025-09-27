import type * as ort from 'onnxruntime-node';

type ProjectionMeta = {
  padX: number;
  padY: number;
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  normalized?: boolean;
};

export type PreprocessMeta = ProjectionMeta & {
  scale: number;
  scaleX: number;
  scaleY: number;
  variants?: ProjectionMeta[];
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
  combinedLogit: number;
  appliedThreshold: number;
  projectionIndex?: number;
  normalizedProjection?: boolean;
  priorityScore?: number;
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
  tensor: ort.OnnxValue | ort.OnnxValue[],
  meta: PreprocessMeta,
  options: ParseYoloDetectionsOptions
): YoloDetection[] {
  const tensors = Array.isArray(tensor) ? tensor : [tensor];
  const accessors = tensors
    .map(value => createTensorAccessor(value))
    .filter((candidate): candidate is TensorAccessor => candidate !== null);

  if (accessors.length === 0) {
    return [];
  }

  const classIndices = resolveClassIndices(options, accessors[0]!.attributes);

  const classPriority = buildClassPriority(options, classIndices);

  if (classIndices.length === 0) {
    return [];
  }

  const detections: YoloDetection[] = [];

  const resolveThreshold = createThresholdResolver(options);

  for (const accessor of accessors) {
    for (let detectionIndex = 0; detectionIndex < accessor.detections; detectionIndex += 1) {
      const objectnessLogit = accessor.get(detectionIndex, OBJECTNESS_INDEX);
      if (!isFiniteNumber(objectnessLogit)) {
        continue;
      }

      const objectness = sigmoid(objectnessLogit);

      if (!Number.isFinite(objectness) || objectness <= 0) {
        continue;
      }

      const cx = accessor.get(detectionIndex, 0);
      const cy = accessor.get(detectionIndex, 1);
      const width = accessor.get(detectionIndex, 2);
      const height = accessor.get(detectionIndex, 3);

      if (!isFiniteNumber(cx) || !isFiniteNumber(cy) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
        continue;
      }

      if (width <= 0 || height <= 0) {
        continue;
      }

      const projected = projectBoundingBox(cx, cy, width, height, meta);
      const bbox = clampBoundingBoxToFrame(projected.box, meta.originalWidth, meta.originalHeight);

      if (
        !isFiniteNumber(bbox.left) ||
        !isFiniteNumber(bbox.top) ||
        !isFiniteNumber(bbox.width) ||
        !isFiniteNumber(bbox.height) ||
        bbox.width <= 0 ||
        bbox.height <= 0
      ) {
        continue;
      }

      const areaRatio = clamp(projected.areaRatio, 0, 1);

      if (!Number.isFinite(areaRatio) || areaRatio <= 0) {
        continue;
      }

      for (const classId of classIndices) {
        const attributeIndex = CLASS_START_INDEX + classId;
        if (attributeIndex >= accessor.attributes) {
          continue;
        }

        const classLogit = accessor.get(detectionIndex, attributeIndex);
        if (!isFiniteNumber(classLogit)) {
          continue;
        }

        const classProbability = sigmoid(classLogit);

        if (!Number.isFinite(classProbability) || classProbability <= 0) {
          continue;
        }

        const combinedLogit = objectnessLogit + classLogit;
        const score = clamp(sigmoid(combinedLogit), 0, 1);

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
          areaRatio,
          combinedLogit,
          appliedThreshold: threshold,
          projectionIndex: projected.projectionIndex,
          normalizedProjection: projected.normalized
        });
      }
    }
  }

  if (detections.length === 0) {
    return [];
  }

  const nmsThreshold = options.nmsThreshold ?? DEFAULT_NMS_IOU_THRESHOLD;
  const perProjection = new Map<number, Map<number, YoloDetection[]>>();

  for (const detection of detections) {
    const projectionKey = detection.projectionIndex ?? -1;
    let projectionGroup = perProjection.get(projectionKey);
    if (!projectionGroup) {
      projectionGroup = new Map();
      perProjection.set(projectionKey, projectionGroup);
    }
    const classGroup = projectionGroup.get(detection.classId);
    if (classGroup) {
      classGroup.push(detection);
    } else {
      projectionGroup.set(detection.classId, [detection]);
    }
  }

  const filtered: YoloDetection[] = [];
  const primaryClassId = resolvePrimaryClassId(options, classIndices, classPriority);
  const prioritized: YoloDetection[] = [];

  for (const projectionGroup of perProjection.values()) {
    for (const [classId, candidates] of projectionGroup.entries()) {
      if (primaryClassId !== null && classId === primaryClassId) {
        for (const detection of candidates) {
          detection.priorityScore = computeProjectionPriority(detection);
          prioritized.push(detection);
        }
        continue;
      }
      filtered.push(...nonMaxSuppression(candidates, nmsThreshold));
    }
  }

  if (prioritized.length > 0) {
    const suppressed = nonMaxSuppression(prioritized, nmsThreshold);
    for (const detection of suppressed) {
      if ('priorityScore' in detection) {
        delete detection.priorityScore;
      }
    }
    filtered.push(...suppressed);
  }

  filtered.sort((a, b) => {
    const priorityA = classPriority.get(a.classId) ?? Number.POSITIVE_INFINITY;
    const priorityB = classPriority.get(b.classId) ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    return b.score - a.score;
  });

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

function buildClassPriority(
  options: ParseYoloDetectionsOptions,
  indices: number[]
) {
  const priority = new Map<number, number>();
  const baseOrder = [...indices];
  if (typeof options.classIndex === 'number' && Number.isFinite(options.classIndex)) {
    const normalized = Math.trunc(options.classIndex);
    const existingIndex = baseOrder.indexOf(normalized);
    if (existingIndex >= 0) {
      baseOrder.splice(existingIndex, 1);
    }
    baseOrder.unshift(normalized);
  } else if (Array.isArray(options.classIndices) && options.classIndices.length > 0) {
    const explicitOrder = options.classIndices
      .map(value => Math.trunc(value))
      .filter(value => Number.isFinite(value));
    if (explicitOrder.length > 0) {
      const seen = new Set<number>();
      const ordered = [...explicitOrder, ...baseOrder];
      baseOrder.length = 0;
      for (const candidate of ordered) {
        if (!seen.has(candidate)) {
          baseOrder.push(candidate);
          seen.add(candidate);
        }
      }
    }
  }

  baseOrder.forEach((classId, index) => {
    priority.set(classId, index);
  });

  return priority;
}

function resolvePrimaryClassId(
  options: ParseYoloDetectionsOptions,
  indices: number[],
  classPriority: Map<number, number>
) {
  if (typeof options.classIndex === 'number' && Number.isFinite(options.classIndex)) {
    const normalized = Math.trunc(options.classIndex);
    if (indices.includes(normalized)) {
      return normalized;
    }
  }

  let bestClass: number | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const classId of indices) {
    const priority = classPriority.get(classId) ?? Number.POSITIVE_INFINITY;
    if (priority < bestPriority) {
      bestPriority = priority;
      bestClass = classId;
    }
  }
  return bestClass;
}

function computeProjectionPriority(detection: YoloDetection) {
  const base = detection.score;
  const normalizedBonus = detection.normalizedProjection ? 0.05 : 0;
  const areaWeight = clamp(detection.areaRatio, 0, 1) * 0.05;
  const projectionBias = typeof detection.projectionIndex === 'number'
    ? Math.max(0, 1 - Math.min(detection.projectionIndex, 4) * 0.05)
    : 0;
  return clamp(base + normalizedBonus + areaWeight + projectionBias, 0, 1.5);
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

type ProjectedBoundingBox = {
  box: BoundingBox;
  areaRatio: number;
  projectionIndex: number;
  normalized: boolean;
  score: number;
};

function projectBoundingBox(
  cx: number,
  cy: number,
  width: number,
  height: number,
  meta: PreprocessMeta
): ProjectedBoundingBox {
  const projections = buildProjectionCandidates(meta);

  const candidates: ProjectedBoundingBox[] = [];

  projections.forEach((projection, projectionIndex) => {
    const likelihoodNormalized = isLikelyNormalized(cx, cy, width, height, projection.resizedWidth, projection.resizedHeight);
      const assumptions = projection.normalized === true
        ? [true]
        : projection.normalized === false
          ? [false]
          : likelihoodNormalized
            ? [true, false]
            : [false, true];

    for (const assumeNormalized of assumptions) {
      const box = projectWithProjection(cx, cy, width, height, projection, assumeNormalized);
      const areaRatio = computeAreaRatio(box, projection.originalWidth, projection.originalHeight);

      if (areaRatio <= 0) {
        continue;
      }

      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const exceedsWidth = centerX < -projection.originalWidth * 0.15 || centerX > projection.originalWidth * 1.15;
      const exceedsHeight = centerY < -projection.originalHeight * 0.15 || centerY > projection.originalHeight * 1.15;
      if (exceedsWidth || exceedsHeight) {
        continue;
      }

      const maxWidth = projection.originalWidth * 1.1;
      const maxHeight = projection.originalHeight * 1.1;
      if (box.width <= 0 || box.height <= 0 || box.width > maxWidth || box.height > maxHeight) {
        continue;
      }

      const normalizedPenalty = assumeNormalized && projection.normalized !== true ? 0.02 : 0;
      const score = (areaRatio <= 1 ? areaRatio : 1 / Math.max(areaRatio, 1e-6)) - normalizedPenalty;
      if (score <= 0) {
        continue;
      }

      candidates.push({
        box,
        areaRatio,
        projectionIndex,
        normalized: assumeNormalized,
        score
      });
    }
  });

  if (candidates.length === 0) {
    const fallback = projectWithProjection(cx, cy, width, height, projections[0], projections[0].normalized ?? false);
    return {
      box: fallback,
      areaRatio: computeAreaRatio(fallback, projections[0].originalWidth, projections[0].originalHeight),
      projectionIndex: 0,
      normalized: projections[0].normalized ?? false,
      score: 0
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function buildProjectionCandidates(meta: PreprocessMeta): ProjectionMeta[] {
  const variants: ProjectionMeta[] = Array.isArray(meta.variants) ? meta.variants.map(variant => ({ ...variant })) : [];
  return [meta, ...variants];
}

function projectWithProjection(
  cx: number,
  cy: number,
  width: number,
  height: number,
  projection: ProjectionMeta,
  assumeNormalized: boolean
): BoundingBox {
  const scaleX = resolveScale(projection.scaleX, projection.scale);
  const scaleY = resolveScale(projection.scaleY, projection.scale);

  const resizedWidth = projection.resizedWidth || projection.originalWidth * scaleX;
  const resizedHeight = projection.resizedHeight || projection.originalHeight * scaleY;

  const normalized = assumeNormalized;
  const normalizedCx = normalized ? cx * resizedWidth : cx;
  const normalizedCy = normalized ? cy * resizedHeight : cy;
  const normalizedWidth = normalized ? width * resizedWidth : width;
  const normalizedHeight = normalized ? height * resizedHeight : height;

  const left = normalizedCx - normalizedWidth / 2;
  const top = normalizedCy - normalizedHeight / 2;
  const right = normalizedCx + normalizedWidth / 2;
  const bottom = normalizedCy + normalizedHeight / 2;

  const mappedLeft = (left - projection.padX) / scaleX;
  const mappedTop = (top - projection.padY) / scaleY;
  const mappedRight = (right - projection.padX) / scaleX;
  const mappedBottom = (bottom - projection.padY) / scaleY;

  const clampedLeft = clamp(mappedLeft, 0, projection.originalWidth);
  const clampedTop = clamp(mappedTop, 0, projection.originalHeight);
  const clampedRight = clamp(mappedRight, 0, projection.originalWidth);
  const clampedBottom = clamp(mappedBottom, 0, projection.originalHeight);

  return {
    left: clampedLeft,
    top: clampedTop,
    width: Math.max(0, clampedRight - clampedLeft),
    height: Math.max(0, clampedBottom - clampedTop)
  };
}

function isLikelyNormalized(
  cx: number,
  cy: number,
  width: number,
  height: number,
  resizedWidth: number,
  resizedHeight: number
) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return false;
  }
  const withinUnit = Math.abs(cx) <= 1.2 && Math.abs(cy) <= 1.2 && width <= 1.2 && height <= 1.2;
  if (withinUnit) {
    return true;
  }
  const maxDimension = Math.max(resizedWidth, resizedHeight, 1);
  return Math.max(width, height) <= maxDimension * 0.1;
}

function computeAreaRatio(bbox: BoundingBox, originalWidth: number, originalHeight: number) {
  const totalArea = originalWidth * originalHeight;

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
  const scoreOf = (detection: YoloDetection) => {
    if (typeof detection.priorityScore === 'number' && Number.isFinite(detection.priorityScore)) {
      return detection.priorityScore;
    }
    return detection.score;
  };

  const sorted = [...detections].sort((a, b) => scoreOf(b) - scoreOf(a));
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

function clampBoundingBoxToFrame(box: BoundingBox, frameWidth: number, frameHeight: number): BoundingBox {
  const maxWidth = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : null;
  const maxHeight = Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : null;

  if (maxWidth === null || maxHeight === null) {
    return { ...box };
  }

  const right = clamp(box.left + box.width, 0, maxWidth);
  const bottom = clamp(box.top + box.height, 0, maxHeight);
  const left = clamp(box.left, 0, maxWidth);
  const top = clamp(box.top, 0, maxHeight);

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
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
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function isFiniteNumber(value: number) {
  return typeof value === 'number' && Number.isFinite(value);
}

export { DEFAULT_NMS_IOU_THRESHOLD };
export { CLASS_START_INDEX as YOLO_CLASS_START_INDEX };
