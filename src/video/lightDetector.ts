import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import eventBus from '../eventBus.js';
import metrics from '../metrics/index.js';
import { EventPayload } from '../types.js';
import {
  averageLuminance,
  readFrameAsGrayscale,
  gaussianBlur,
  medianFilter
} from './utils.js';

export interface LightDetectorOptions {
  source: string;
  deltaThreshold?: number;
  normalHours?: Array<{ start: number; end: number }>;
  smoothingFactor?: number;
  minIntervalMs?: number;
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
  idleRebaselineMs?: number;
  noiseWarmupFrames?: number;
  noiseBackoffPadding?: number;
  temporalMedianWindow?: number;
  temporalMedianBackoffSmoothing?: number;
}

const DEFAULT_DELTA_THRESHOLD = 30;
const DEFAULT_SMOOTHING = 0.2;
const DEFAULT_MIN_INTERVAL_MS = 60000;
const DEFAULT_DEBOUNCE_FRAMES = 2;
const DEFAULT_BACKOFF_FRAMES = 3;
const DEFAULT_NOISE_MULTIPLIER = 2.5;
const DEFAULT_NOISE_SMOOTHING = 0.1;
const DEFAULT_IDLE_REBASELINE_MS = 120_000;
const NOISE_WINDOW_SIZE = 40;
const DELTA_WINDOW_SIZE = 24;
const SUSTAINED_NOISE_THRESHOLD = 1.1;
const DEFAULT_TEMPORAL_WINDOW = 6;
const DEFAULT_TEMPORAL_BACKOFF_SMOOTHING = 0.35;

export class LightDetector {
  private options: LightDetectorOptions;
  private baseline: number | null = null;
  private lastEventTs = 0;
  private noiseLevel = 0;
  private pendingFrames = 0;
  private backoffFrames = 0;
  private suppressedFrames = 0;
  private deltaTrend = 0;
  private pendingSuppressedFramesBeforeTrigger = 0;
  private lastFrameTs: number | null = null;
  private readonly noiseWindow: number[] = [];
  private readonly deltaWindow: number[] = [];
  private sustainedNoiseBoost = 1;
  private lastDenoiseStrategy = 'gaussian-median';
  private noiseWarmupRemaining: number;
  private baseNoiseBackoffPadding: number;
  private noiseBackoffPadding: number;
  private rebaselineFramesRemaining = 0;
  private readonly temporalWindow: number[] = [];
  private temporalSuppression = 0;

  constructor(options: LightDetectorOptions, private readonly bus: EventEmitter = eventBus) {
    this.options = {
      ...options,
      normalHours: options.normalHours?.map(range => ({ ...range }))
    };
    this.noiseWarmupRemaining = Math.max(0, this.options.noiseWarmupFrames ?? 0);
    this.baseNoiseBackoffPadding = Math.max(0, this.options.noiseBackoffPadding ?? 0);
    this.noiseBackoffPadding = this.baseNoiseBackoffPadding;
    this.resetTemporalGate();
  }

  updateOptions(options: Partial<Omit<LightDetectorOptions, 'source'>>) {
    const previous = this.options;
    const next: LightDetectorOptions = {
      ...previous,
      ...options,
      normalHours: options.normalHours
        ? options.normalHours.map(range => ({ ...range }))
        : previous.normalHours
    };

    const hasOptionChanged = <K extends keyof Omit<LightDetectorOptions, 'source'>>(key: K) => {
      if (!Object.prototype.hasOwnProperty.call(options, key)) {
        return false;
      }
      return next[key] !== previous[key];
    };

    const normalHoursChanged =
      Object.prototype.hasOwnProperty.call(options, 'normalHours') &&
      !lightHoursEqual(previous.normalHours, options.normalHours);

    const baselineResetNeeded =
      hasOptionChanged('deltaThreshold') ||
      hasOptionChanged('smoothingFactor') ||
      hasOptionChanged('noiseMultiplier') ||
      hasOptionChanged('noiseSmoothing') ||
      normalHoursChanged;

    const warmupChanged = hasOptionChanged('noiseWarmupFrames');
    const backoffPaddingChanged = hasOptionChanged('noiseBackoffPadding');
    const temporalOptionsChanged =
      hasOptionChanged('temporalMedianWindow') ||
      hasOptionChanged('temporalMedianBackoffSmoothing');

    const countersResetNeeded =
      baselineResetNeeded ||
      hasOptionChanged('debounceFrames') ||
      hasOptionChanged('backoffFrames') ||
      warmupChanged ||
      backoffPaddingChanged ||
      temporalOptionsChanged;

    this.options = next;

    if (warmupChanged) {
      this.noiseWarmupRemaining = Math.max(0, next.noiseWarmupFrames ?? 0);
    }

    if (backoffPaddingChanged) {
      this.baseNoiseBackoffPadding = Math.max(0, next.noiseBackoffPadding ?? 0);
      this.noiseBackoffPadding = Math.max(this.noiseBackoffPadding, this.baseNoiseBackoffPadding);
      const baseBackoff = next.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
      const padding = Math.max(0, Math.round(this.noiseBackoffPadding));
      const paddedBackoff = baseBackoff + padding;
      this.backoffFrames = Math.min(this.backoffFrames, paddedBackoff);
      this.updatePendingSuppressedGauge();
    }

    if (temporalOptionsChanged) {
      this.resetTemporalGate();
    }

    if (baselineResetNeeded) {
      this.resetAdaptiveState({ preserveBaseline: false, preserveWarmup: !warmupChanged });
    } else if (countersResetNeeded) {
      this.resetAdaptiveState({
        preserveBaseline: true,
        preserveSuppression: true,
        preserveWarmup: !warmupChanged
      });
    }
  }

  handleFrame(frame: Buffer, ts = Date.now()) {
    const start = performance.now();
    try {
      const previousFrameTs = this.lastFrameTs;
      const idleRebaselineMs = this.options.idleRebaselineMs ?? DEFAULT_IDLE_REBASELINE_MS;
      const withinNormalHours = this.isWithinNormalHours(ts);
      metrics.setDetectorGauge('light', 'normalHoursActive', withinNormalHours ? 1 : 0);
      metrics.setDetectorGauge('light', 'noiseWindowBoost', this.sustainedNoiseBoost);
      if (
        previousFrameTs !== null &&
        idleRebaselineMs > 0 &&
        ts - previousFrameTs >= idleRebaselineMs
      ) {
        this.resetAdaptiveState({ preserveBaseline: false });
        metrics.resetDetectorCounters('light', [
          'suppressedFrames',
          'suppressedFramesBeforeTrigger',
          'backoffFrames',
          'backoffSuppressedFrames',
          'backoffActivations'
        ]);
        metrics.incrementDetectorCounter('light', 'idleResets', 1);
      }

      this.lastFrameTs = ts;

      const grayscale = readFrameAsGrayscale(frame);
      const baseGaussian = gaussianBlur(grayscale);
      const baseMedian = medianFilter(baseGaussian);
      let smoothed = baseMedian;
      let denoiseStrategy = 'gaussian-median';
      let luminance = averageLuminance(smoothed);

      if (this.baseline === null) {
        this.baseline = luminance;
        this.noiseLevel = 0;
        this.pendingFrames = 0;
        this.backoffFrames = 0;
        this.suppressedFrames = 0;
        this.deltaTrend = 0;
        this.lastDenoiseStrategy = denoiseStrategy;
        this.updatePendingSuppressedGauge();
        return;
      }

      const smoothing = this.options.smoothingFactor ?? DEFAULT_SMOOTHING;
      const baseDebounce = this.options.debounceFrames ?? DEFAULT_DEBOUNCE_FRAMES;
      const baseBackoff = this.options.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
      const noiseMultiplier = this.options.noiseMultiplier ?? DEFAULT_NOISE_MULTIPLIER;
      const baseNoiseSmoothing = this.options.noiseSmoothing ?? DEFAULT_NOISE_SMOOTHING;

      const deltaThreshold = this.options.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD;
      const evaluateCandidate = (frameCandidate: ReturnType<typeof medianFilter>) => {
        const candidateLuminance = averageLuminance(frameCandidate);
        const deltaValue = Math.abs(candidateLuminance - this.baseline!);
        const floor = this.noiseLevel === 0 ? deltaValue : this.noiseLevel;
        const ratio = floor === 0 ? 1 : deltaValue / Math.max(floor, 1);
        return {
          frame: frameCandidate,
          luminance: candidateLuminance,
          delta: deltaValue,
          noiseFloor: floor,
          noiseRatio: ratio
        } as const;
      };

      let candidate = evaluateCandidate(smoothed);

      if (
        candidate.noiseRatio > 1.6 ||
        (candidate.delta < deltaThreshold * 0.5 && candidate.noiseRatio > 1.2)
      ) {
        const heavyCandidate = evaluateCandidate(medianFilter(gaussianBlur(baseMedian)));
        if (
          heavyCandidate.delta <= candidate.delta &&
          heavyCandidate.noiseRatio <= candidate.noiseRatio * 0.95
        ) {
          candidate = heavyCandidate;
          denoiseStrategy = 'gaussian-median-gaussian-median';
        }
      } else if (candidate.noiseRatio > 1.3) {
        const medianFirst = medianFilter(grayscale);
        const hybridCandidate = evaluateCandidate(medianFilter(gaussianBlur(medianFirst)));
        if (hybridCandidate.noiseRatio <= candidate.noiseRatio * 0.95) {
          candidate = hybridCandidate;
          denoiseStrategy = 'median-gaussian-median';
        }
      }

      smoothed = candidate.frame;
      luminance = candidate.luminance;
      const delta = candidate.delta;
      const noiseFloor = candidate.noiseFloor;
      let noiseRatio = candidate.noiseRatio;

      const deltaTrendSmoothing = clamp(baseNoiseSmoothing * 1.2, 0.05, 0.35);
      this.deltaTrend =
        this.deltaTrend === 0
          ? delta
          : this.deltaTrend * (1 - deltaTrendSmoothing) + delta * deltaTrendSmoothing;
      recordWindowSample(this.deltaWindow, delta, DELTA_WINDOW_SIZE);
      const deltaWindowMedian = median(this.deltaWindow);
      const stabilizedDelta = Math.max(delta, this.deltaTrend, deltaWindowMedian ?? delta);
      metrics.setDetectorGauge('light', 'deltaWindowMedian', deltaWindowMedian ?? delta);

      const temporalWindowSize = Math.min(
        60,
        Math.max(3, Math.round(this.options.temporalMedianWindow ?? DEFAULT_TEMPORAL_WINDOW))
      );
      recordWindowSample(this.temporalWindow, stabilizedDelta, temporalWindowSize);
      const temporalMedianValue = median(this.temporalWindow);
      const temporalBackoffSmoothing = clamp(
        this.options.temporalMedianBackoffSmoothing ?? DEFAULT_TEMPORAL_BACKOFF_SMOOTHING,
        0.05,
        0.95
      );
      const temporalSuppression = this.updateTemporalSuppression(
        stabilizedDelta,
        temporalMedianValue,
        temporalWindowSize,
        temporalBackoffSmoothing
      );
      metrics.setDetectorGauge('light', 'temporalWindow', temporalMedianValue ?? stabilizedDelta);
      metrics.setDetectorGauge('light', 'temporalWindowSize', temporalWindowSize);
      metrics.setDetectorGauge('light', 'temporalSuppression', temporalSuppression);
      const temporalSuppressionRatio =
        temporalWindowSize === 0 ? 0 : temporalSuppression / Math.max(1, temporalWindowSize);
      const temporalGateMultiplier =
        this.temporalSuppression > 0 ? 1 + Math.min(1.5, temporalSuppressionRatio) * 0.85 : 1;
      metrics.setDetectorGauge('light', 'temporalGateMultiplier', temporalGateMultiplier);

      const effectiveNoiseSmoothing = clamp(
        baseNoiseSmoothing * (noiseRatio > 1 ? 1 + Math.min(noiseRatio - 1, 1) * 0.6 : 0.65),
        0.05,
        0.5
      );

      const updatedNoiseFloor =
        noiseFloor === 0
          ? delta
          : noiseFloor * (1 - effectiveNoiseSmoothing) + delta * effectiveNoiseSmoothing;

      const baseAdaptiveThreshold = Math.max(deltaThreshold, noiseFloor * noiseMultiplier);
      const noiseSuppressionFactor = clamp(
        noiseRatio > 1 ? 1 + (noiseRatio - 1) * 0.7 : 1 - Math.min(0.35, (1 - noiseRatio) * 0.5),
        0.6,
        3
      );
      const adaptiveThreshold = baseAdaptiveThreshold * noiseSuppressionFactor;
      const temporalAdaptiveThreshold = adaptiveThreshold * temporalGateMultiplier;
      const intensityRatio =
        temporalAdaptiveThreshold === 0 ? 0 : stabilizedDelta / temporalAdaptiveThreshold;
      metrics.setDetectorGauge('light', 'temporalAdaptiveThreshold', temporalAdaptiveThreshold);

      recordWindowSample(this.noiseWindow, noiseRatio, NOISE_WINDOW_SIZE);
      const noiseWindowMedian = median(this.noiseWindow);
      const noiseWindowPressure = computePressure(this.noiseWindow, SUSTAINED_NOISE_THRESHOLD);
      const targetBoost = clamp(
        1 + Math.max((noiseWindowMedian ?? noiseRatio) - 1, 0) * 0.8 + noiseWindowPressure * 1.6,
        1,
        4
      );
      const boostSmoothing = noiseWindowPressure > 0.2 ? 0.35 : 0.2;
      this.sustainedNoiseBoost = clamp(
        this.sustainedNoiseBoost * (1 - boostSmoothing) + targetBoost * boostSmoothing,
        1,
        4
      );
      metrics.setDetectorGauge('light', 'noiseWindowMedian', noiseWindowMedian ?? noiseRatio);
      metrics.setDetectorGauge('light', 'noiseWindowPressure', noiseWindowPressure);
      metrics.setDetectorGauge('light', 'noiseWindowBoost', this.sustainedNoiseBoost);

      const effectiveSmoothing = clamp(
        delta < temporalAdaptiveThreshold
          ? smoothing * 0.75
          : smoothing * (1 + Math.min(noiseRatio - 1, 1) * 0.25),
        0.01,
        0.5
      );

      const debounceMultiplier = clamp(noiseSuppressionFactor, 1, 1.5);
      const sustainedDebounceMultiplier = Math.max(1, this.sustainedNoiseBoost);
      const baseEffectiveDebounce = Math.max(
        baseDebounce,
        Math.round(baseDebounce * debounceMultiplier * sustainedDebounceMultiplier)
      );
      const backoffMultiplier = clamp(
        noiseSuppressionFactor > 1 ? 1 + (noiseSuppressionFactor - 1) * 0.5 : 1.2,
        1,
        3
      );
      const dynamicBackoff = Math.max(
        baseBackoff,
        Math.round(baseBackoff * backoffMultiplier * Math.max(1, this.sustainedNoiseBoost * 1.05))
      );
      const { backoffPadding, debouncePadding } = this.adjustNoiseBackoffPadding(
        noiseWindowPressure,
        dynamicBackoff,
        baseEffectiveDebounce
      );
      const noiseAdjustedDebounce = baseEffectiveDebounce + debouncePadding;
      const noiseAdjustedBackoff = dynamicBackoff + backoffPadding;
      const temporalDebouncePadding = this.computeTemporalDebouncePadding(
        noiseAdjustedDebounce,
        temporalWindowSize,
        temporalBackoffSmoothing
      );
      const temporalBackoffPadding = this.computeTemporalBackoffPadding(
        noiseAdjustedBackoff,
        temporalWindowSize,
        temporalBackoffSmoothing
      );
      const effectiveDebounce = noiseAdjustedDebounce + temporalDebouncePadding;
      const effectiveBackoff = noiseAdjustedBackoff + temporalBackoffPadding;
      metrics.setDetectorGauge('light', 'temporalDebouncePadding', temporalDebouncePadding);
      metrics.setDetectorGauge('light', 'temporalBackoffPadding', temporalBackoffPadding);

      metrics.setDetectorGauge('light', 'effectiveDebounceFrames', effectiveDebounce);
      metrics.setDetectorGauge('light', 'effectiveBackoffFrames', effectiveBackoff);
      metrics.setDetectorGauge('light', 'noiseBackoffPadding', this.noiseBackoffPadding);

      const shouldScheduleRebaseline =
        this.noiseWarmupRemaining === 0 &&
        (noiseWindowPressure > 0.5 || this.sustainedNoiseBoost >= 1.6);

      if (shouldScheduleRebaseline && this.rebaselineFramesRemaining === 0) {
        const baseWindow = Math.max(
          effectiveDebounce + effectiveBackoff,
          Math.round(DELTA_WINDOW_SIZE * 0.5)
        );
        this.rebaselineFramesRemaining = baseWindow;
      }

      if (this.rebaselineFramesRemaining > 0) {
        const decay = shouldScheduleRebaseline ? 1 : 2;
        this.rebaselineFramesRemaining = Math.max(0, this.rebaselineFramesRemaining - decay);
        metrics.setDetectorGauge('light', 'rebaselineCountdown', this.rebaselineFramesRemaining);
        if (this.rebaselineFramesRemaining === 0 && shouldScheduleRebaseline) {
          this.resetAdaptiveState({ preserveBaseline: false, preserveWarmup: true });
          metrics.incrementDetectorCounter('light', 'adaptiveRebaselines', 1);
          metrics.setDetectorGauge('light', 'rebaselineCountdown', 0);
          metrics.setDetectorGauge('light', 'noiseWarmupRemaining', this.noiseWarmupRemaining);
          return;
        }
      } else {
        metrics.setDetectorGauge('light', 'rebaselineCountdown', 0);
      }

      this.lastDenoiseStrategy = denoiseStrategy;

      if (this.noiseWarmupRemaining > 0) {
        this.noiseWarmupRemaining -= 1;
        metrics.setDetectorGauge('light', 'noiseWarmupRemaining', this.noiseWarmupRemaining);
        this.updateBaseline(luminance, effectiveSmoothing);
        if (this.backoffFrames > 0) {
          this.backoffFrames = Math.max(0, this.backoffFrames - 1);
        }
        this.noiseLevel = updatedNoiseFloor;
        this.pendingFrames = 0;
        this.suppressedFrames += 1;
        this.updatePendingSuppressedGauge();
        metrics.incrementDetectorCounter('light', 'suppressedFrames', 1);
        return;
      }

      metrics.setDetectorGauge('light', 'noiseWarmupRemaining', this.noiseWarmupRemaining);

      if (withinNormalHours) {
        this.updateBaseline(luminance, effectiveSmoothing);
        this.pendingFrames = 0;
        this.backoffFrames = 0;
        this.suppressedFrames = 0;
        this.pendingSuppressedFramesBeforeTrigger = 0;
        this.noiseLevel = updatedNoiseFloor;
        this.updatePendingSuppressedGauge();
        metrics.resetDetectorCounters('light', ['suppressedFrames', 'suppressedFramesBeforeTrigger']);
        return;
      }

      if (stabilizedDelta < temporalAdaptiveThreshold) {
        this.updateBaseline(luminance, effectiveSmoothing);
        if (this.pendingFrames > 0) {
          this.pendingFrames = Math.max(0, this.pendingFrames - 1);
        }
        if (this.backoffFrames > 0) {
          metrics.incrementDetectorCounter('light', 'backoffFrames', 1);
          metrics.incrementDetectorCounter('light', 'backoffSuppressedFrames', 1);
          this.backoffFrames -= 1;
        }
        this.noiseLevel = updatedNoiseFloor;
        this.suppressedFrames += 1;
        this.updatePendingSuppressedGauge();
        metrics.incrementDetectorCounter('light', 'suppressedFrames', 1);
        return;
      }

      const suppressedFramesSnapshot = this.suppressedFrames;
      this.suppressedFrames = 0;
      if (suppressedFramesSnapshot > 0) {
        this.pendingSuppressedFramesBeforeTrigger += suppressedFramesSnapshot;
        metrics.incrementDetectorCounter(
          'light',
          'suppressedFramesBeforeTrigger',
          suppressedFramesSnapshot
        );
        this.updatePendingSuppressedGauge();
      }

      this.noiseLevel = Math.max(
        this.noiseLevel * (1 - effectiveNoiseSmoothing),
        Math.min(deltaThreshold, stabilizedDelta)
      );

      if (this.backoffFrames > 0) {
        metrics.incrementDetectorCounter('light', 'backoffFrames', 1);
        metrics.incrementDetectorCounter('light', 'backoffSuppressedFrames', 1);
        this.backoffFrames -= 1;
        this.pendingFrames = 0;
        return;
      }

      this.pendingFrames += 1;
      if (this.pendingFrames < effectiveDebounce) {
        return;
      }

      const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
      if (ts - this.lastEventTs < minInterval) {
        this.pendingFrames = 0;
        this.backoffFrames = Math.max(this.backoffFrames, Math.ceil(effectiveBackoff / 2));
        this.pendingSuppressedFramesBeforeTrigger = 0;
        this.updatePendingSuppressedGauge();
        return;
      }

      this.lastEventTs = ts;
      this.pendingFrames = 0;
      this.backoffFrames = effectiveBackoff;
      metrics.incrementDetectorCounter('light', 'backoffActivations', 1);
      metrics.incrementDetectorCounter('light', 'backoffFrameBudget', effectiveBackoff);
      const previousBaseline = this.baseline;
      this.baseline = this.baseline * (1 - effectiveSmoothing) + luminance * effectiveSmoothing;
      const updatedBaseline = this.baseline;

      const suppressedFramesBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
      this.pendingSuppressedFramesBeforeTrigger = 0;
      this.updatePendingSuppressedGauge();

      const payload: EventPayload = {
        ts,
        detector: 'light',
        source: this.options.source,
        severity: 'warning',
        message: 'Unexpected light level change detected',
        meta: {
          baseline: updatedBaseline,
          previousBaseline,
          luminance,
          delta,
          stabilizedDelta,
          deltaThreshold,
          adaptiveThreshold,
          temporalAdaptiveThreshold,
          rawAdaptiveThreshold: baseAdaptiveThreshold,
          intensityRatio,
          noiseLevel: this.noiseLevel,
          noiseFloor: updatedNoiseFloor,
          noiseRatio,
          noiseSuppressionFactor,
          noiseWindowMedian: noiseWindowMedian ?? noiseRatio,
          noiseWindowPressure,
          sustainedNoiseBoost: this.sustainedNoiseBoost,
          effectiveDebounceFrames: effectiveDebounce,
          effectiveBackoffFrames: effectiveBackoff,
          noiseSmoothing: effectiveNoiseSmoothing,
          smoothingFactor: effectiveSmoothing,
          noiseMultiplier,
          deltaWindowMedian: deltaWindowMedian ?? stabilizedDelta,
          debounceMultiplier,
          backoffMultiplier,
          suppressedFramesBeforeTrigger,
          denoiseStrategy: this.lastDenoiseStrategy,
          noiseWarmupRemaining: this.noiseWarmupRemaining,
          noiseBackoffPadding: this.noiseBackoffPadding,
          temporalMedian: temporalMedianValue ?? stabilizedDelta,
          temporalSuppression: this.temporalSuppression,
          temporalDebouncePadding,
          temporalBackoffPadding,
          temporalWindowSize,
          temporalGateMultiplier,
          normalHoursActive: withinNormalHours,
          normalHours: this.options.normalHours?.map(range => ({ ...range })) ?? []
        }
      };

      this.bus.emit('event', payload);
    } finally {
      metrics.observeDetectorLatency('light', performance.now() - start);
    }
  }

  private adjustNoiseBackoffPadding(
    noiseWindowPressure: number,
    dynamicBackoff: number,
    baseEffectiveDebounce: number
  ) {
    const basePadding = this.baseNoiseBackoffPadding;
    const suppressedBudget = this.suppressedFrames + this.pendingSuppressedFramesBeforeTrigger;
    const pressureInfluence = Math.max(0, noiseWindowPressure - 0.25);
    const pressureTarget = pressureInfluence * (dynamicBackoff + baseEffectiveDebounce);
    const suppressionTarget = suppressedBudget > 0
      ? Math.min(suppressedBudget, dynamicBackoff + Math.floor(baseEffectiveDebounce / 2))
      : 0;
    const targetPadding = Math.max(
      basePadding,
      Math.min(
        basePadding + Math.round(pressureTarget * 0.6) + Math.round(suppressionTarget * 0.3),
        basePadding + Math.round((dynamicBackoff + baseEffectiveDebounce) * 0.5)
      )
    );
    const smoothing = noiseWindowPressure > 0.5 ? 0.45 : noiseWindowPressure > 0.3 ? 0.3 : 0.2;
    const blended = Math.max(
      basePadding,
      Math.round(this.noiseBackoffPadding * (1 - smoothing) + targetPadding * smoothing)
    );
    const shouldDecay = noiseWindowPressure < 0.15 && suppressedBudget === 0;
    this.noiseBackoffPadding = shouldDecay
      ? Math.max(basePadding, Math.round(blended * 0.85))
      : blended;

    const backoffPadding = Math.max(0, Math.round(this.noiseBackoffPadding));
    const debouncePadding = Math.max(
      0,
      Math.min(
        backoffPadding,
        Math.round(backoffPadding * (noiseWindowPressure >= 0.45 ? 0.7 : noiseWindowPressure * 0.85))
      )
    );

    return { backoffPadding, debouncePadding } as const;
  }

  private updateTemporalSuppression(
    value: number,
    medianValue: number | null,
    windowSize: number,
    smoothing: number
  ) {
    const clampedSmoothing = clamp(smoothing, 0.05, 0.95);
    const safeWindow = Math.max(1, windowSize);
    const baseline = medianValue ?? value;
    if (!Number.isFinite(value) || !Number.isFinite(baseline)) {
      this.temporalSuppression *= 1 - clampedSmoothing;
      return this.temporalSuppression;
    }
    const normalizedBaseline = baseline <= 0 ? Math.max(value, 0) : baseline;
    const ratio = normalizedBaseline === 0 ? (value > 0 ? 2 : 1) : value / normalizedBaseline;
    const gatingMargin = 0.12;
    let target = 0;
    if (ratio >= 1 + gatingMargin) {
      target = 0;
    } else if (ratio >= 1) {
      const shortfall = (1 + gatingMargin - ratio) / gatingMargin;
      target = shortfall * safeWindow * 0.5;
    } else {
      const deficit = Math.min(1.5, Math.max(0, 1 - ratio));
      target = deficit * safeWindow;
    }
    const blended = this.temporalSuppression * (1 - clampedSmoothing) + target * clampedSmoothing;
    this.temporalSuppression = clamp(blended, 0, safeWindow);
    return this.temporalSuppression;
  }

  private computeTemporalDebouncePadding(
    baseDebounce: number,
    windowSize: number,
    smoothing: number
  ) {
    if (this.temporalSuppression <= 0) {
      return 0;
    }
    const windowLimit = Math.max(
      1,
      Math.round(windowSize * Math.min(0.85, 0.4 + smoothing))
    );
    const baseLimit = Math.max(
      1,
      Math.round(baseDebounce * Math.min(1.3, 0.8 + smoothing))
    );
    const limit = Math.max(1, Math.min(windowLimit, Math.max(baseLimit, Math.round(windowSize * 0.5))));
    const target = Math.round(
      this.temporalSuppression * Math.min(2, 1 + smoothing * 0.8)
    );
    return Math.min(limit, Math.max(1, target));
  }

  private computeTemporalBackoffPadding(
    baseBackoff: number,
    windowSize: number,
    smoothing: number
  ) {
    if (this.temporalSuppression <= 0) {
      return 0;
    }
    const windowLimit = Math.max(
      1,
      Math.round(Math.max(baseBackoff, windowSize) * Math.min(1, 0.55 + smoothing))
    );
    const target = Math.round(
      this.temporalSuppression * Math.min(1.6, 0.7 + smoothing)
    );
    return Math.min(windowLimit, Math.max(1, target));
  }

  private updateBaseline(luminance: number, smoothing: number) {
    if (this.baseline === null) {
      this.baseline = luminance;
      return;
    }
    this.baseline = this.baseline * (1 - smoothing) + luminance * smoothing;
  }

  private resetAdaptiveState(
    options: { preserveBaseline?: boolean; preserveSuppression?: boolean; preserveWarmup?: boolean } = {}
  ) {
    const preserveBaseline = options.preserveBaseline ?? false;
    const preserveSuppression = options.preserveSuppression ?? false;
    const preserveWarmup = options.preserveWarmup ?? false;

    if (!preserveBaseline) {
      this.baseline = null;
      this.lastFrameTs = null;
    }
    this.noiseLevel = 0;
    this.pendingFrames = 0;
    this.backoffFrames = 0;
    this.noiseWindow.length = 0;
    this.deltaWindow.length = 0;
    this.resetTemporalGate();
    this.sustainedNoiseBoost = 1;
    if (!preserveSuppression) {
      this.suppressedFrames = 0;
      this.pendingSuppressedFramesBeforeTrigger = 0;
      this.updatePendingSuppressedGauge();
    }
    this.deltaTrend = 0;
    this.lastDenoiseStrategy = 'gaussian-median';
    if (!preserveWarmup) {
      this.noiseWarmupRemaining = Math.max(0, this.options.noiseWarmupFrames ?? 0);
    }
    this.baseNoiseBackoffPadding = Math.max(0, this.options.noiseBackoffPadding ?? 0);
    this.noiseBackoffPadding = this.baseNoiseBackoffPadding;
    this.rebaselineFramesRemaining = 0;
    metrics.setDetectorGauge('light', 'noiseWindowBoost', this.sustainedNoiseBoost);
    metrics.setDetectorGauge('light', 'rebaselineCountdown', 0);
  }

  private updatePendingSuppressedGauge() {
    metrics.setDetectorGauge(
      'light',
      'pendingSuppressedFramesBeforeTrigger',
      this.pendingSuppressedFramesBeforeTrigger + this.suppressedFrames
    );
  }

  private resetTemporalGate() {
    this.temporalWindow.length = 0;
    this.temporalSuppression = 0;
    const windowSize = Math.min(
      60,
      Math.max(3, Math.round(this.options.temporalMedianWindow ?? DEFAULT_TEMPORAL_WINDOW))
    );
    metrics.setDetectorGauge('light', 'temporalWindow', 0);
    metrics.setDetectorGauge('light', 'temporalWindowSize', windowSize);
    metrics.setDetectorGauge('light', 'temporalSuppression', 0);
    metrics.setDetectorGauge('light', 'temporalDebouncePadding', 0);
    metrics.setDetectorGauge('light', 'temporalBackoffPadding', 0);
    metrics.setDetectorGauge('light', 'temporalGateMultiplier', 1);
    metrics.setDetectorGauge('light', 'temporalAdaptiveThreshold', 0);
  }

  private isWithinNormalHours(ts: number) {
    const hours = this.options.normalHours;
    if (!hours || hours.length === 0) {
      return false;
    }

    const currentHour = new Date(ts).getHours();

    return hours.some(range => isHourWithinRange(currentHour, range.start, range.end));
  }
}

function isHourWithinRange(hour: number, start: number, end: number): boolean {
  const normalizedStart = normalizeHour(start);
  const normalizedEnd = normalizeHour(end);
  const normalizedHour = normalizeHour(hour);

  if (normalizedStart <= normalizedEnd) {
    return normalizedHour >= normalizedStart && normalizedHour < normalizedEnd;
  }

  // Overnight window (e.g. 22-6)
  return normalizedHour >= normalizedStart || normalizedHour < normalizedEnd;
}

function normalizeHour(hour: number) {
  return ((Math.floor(hour) % 24) + 24) % 24;
}

function recordWindowSample(buffer: number[], sample: number, size: number) {
  if (!Number.isFinite(sample)) {
    return;
  }
  buffer.push(sample);
  if (buffer.length > size) {
    buffer.splice(0, buffer.length - size);
  }
}

function median(buffer: number[]): number | null {
  if (buffer.length === 0) {
    return null;
  }
  const sorted = [...buffer].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function computePressure(buffer: number[], threshold: number) {
  if (buffer.length === 0) {
    return 0;
  }
  const hits = buffer.filter(value => value >= threshold).length;
  return hits / buffer.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lightHoursEqual(
  a?: Array<{ start: number; end: number }> | null,
  b?: Array<{ start: number; end: number }> | null
) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    const lhs = a[i];
    const rhs = b[i];
    if (lhs.start !== rhs.start || lhs.end !== rhs.end) {
      return false;
    }
  }

  return true;
}

export default LightDetector;
