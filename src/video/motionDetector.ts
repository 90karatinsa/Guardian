import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import eventBus from '../eventBus.js';
import metrics from '../metrics/index.js';
import { EventPayload } from '../types.js';
import {
  GrayscaleFrame,
  readFrameAsGrayscale,
  gaussianBlur,
  medianFilter,
  frameDiffStats
} from './utils.js';

export interface MotionDetectorOptions {
  source: string;
  diffThreshold?: number;
  areaThreshold?: number;
  minIntervalMs?: number;
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
  areaSmoothing?: number;
  areaInflation?: number;
  areaDeltaThreshold?: number;
  idleRebaselineMs?: number;
  noiseWarmupFrames?: number;
  noiseBackoffPadding?: number;
  temporalMedianWindow?: number;
  temporalMedianBackoffSmoothing?: number;
}

type MotionHistoryEntry = {
  ts: number;
  areaPct: number;
  areaBaseline: number;
  adaptiveAreaThreshold: number;
  adaptiveDiffThreshold: number;
  noiseLevel: number;
  noiseRatio: number;
  suppressed: boolean;
  backoff: boolean;
  triggered: boolean;
  pendingBeforeTrigger: number;
  denoiseStrategy: string;
  reason: string;
  temporalMedian: number;
  temporalSuppression: number;
  temporalDebouncePadding: number;
  temporalBackoffPadding: number;
  temporalGateMultiplier: number;
  temporalAreaThreshold: number;
  temporalDeltaThreshold: number;
};

const DEFAULT_DIFF_THRESHOLD = 25;
const DEFAULT_AREA_THRESHOLD = 0.02;
const DEFAULT_MIN_INTERVAL_MS = 2000;
const DEFAULT_DEBOUNCE_FRAMES = 2;
const DEFAULT_BACKOFF_FRAMES = 3;
const DEFAULT_NOISE_MULTIPLIER = 3;
const DEFAULT_NOISE_SMOOTHING = 0.2;
const DEFAULT_AREA_SMOOTHING = 0.2;
const DEFAULT_AREA_INFLATION = 1.5;
const DEFAULT_AREA_DELTA_THRESHOLD = 0.02;
const DEFAULT_IDLE_REBASELINE_MS = 30_000;
const MAX_HISTORY_SIZE = 120;
const NOISE_WINDOW_SIZE = 30;
const AREA_WINDOW_SIZE = 20;
const SUSTAINED_NOISE_THRESHOLD = 1.15;
const DEFAULT_TEMPORAL_WINDOW = 5;
const DEFAULT_TEMPORAL_BACKOFF_SMOOTHING = 0.35;

export class MotionDetector {
  private previousFrame: GrayscaleFrame | null = null;
  private baselineFrame: GrayscaleFrame | null = null;
  private lastEventTs = 0;
  private noiseLevel = 0;
  private areaBaseline = 0;
  private areaTrendMomentum = 0;
  private activationFrames = 0;
  private backoffFrames = 0;
  private suppressedFrames = 0;
  private pendingSuppressedFramesBeforeTrigger = 0;
  private lastFrameTs: number | null = null;
  private lastDenoiseStrategy = 'gaussian-median';
  private readonly motionHistory: MotionHistoryEntry[] = [];
  private readonly noiseWindow: number[] = [];
  private readonly areaWindow: number[] = [];
  private sustainedNoiseBoost = 1;
  private noiseWarmupRemaining: number;
  private baseNoiseBackoffPadding: number;
  private noiseBackoffPadding: number;
  private rebaselineFramesRemaining = 0;
  private readonly temporalWindow: number[] = [];
  private temporalSuppression = 0;

  constructor(
    private options: MotionDetectorOptions,
    private readonly bus: EventEmitter = eventBus
  ) {
    this.noiseWarmupRemaining = Math.max(0, this.options.noiseWarmupFrames ?? 0);
    this.baseNoiseBackoffPadding = Math.max(0, this.options.noiseBackoffPadding ?? 0);
    this.noiseBackoffPadding = this.baseNoiseBackoffPadding;
    this.updateSuppressedGauge();
    this.resetTemporalGate();
  }

  updateOptions(options: Partial<Omit<MotionDetectorOptions, 'source'>>) {
    const previous = this.options;
    const next: MotionDetectorOptions = { ...previous, ...options };

    const hasOptionChanged = <K extends keyof Omit<MotionDetectorOptions, 'source'>>(key: K) => {
      if (!Object.prototype.hasOwnProperty.call(options, key)) {
        return false;
      }
      return next[key] !== previous[key];
    };

    const referenceResetNeeded =
      hasOptionChanged('diffThreshold') ||
      hasOptionChanged('areaThreshold') ||
      hasOptionChanged('noiseMultiplier') ||
      hasOptionChanged('noiseSmoothing') ||
      hasOptionChanged('areaSmoothing') ||
      hasOptionChanged('areaInflation') ||
      hasOptionChanged('areaDeltaThreshold');

    const warmupChanged = hasOptionChanged('noiseWarmupFrames');
    const backoffPaddingChanged = hasOptionChanged('noiseBackoffPadding');
    const temporalOptionsChanged =
      hasOptionChanged('temporalMedianWindow') ||
      hasOptionChanged('temporalMedianBackoffSmoothing');

    const countersResetNeeded =
      referenceResetNeeded ||
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
      if (this.pendingSuppressedFramesBeforeTrigger > 0) {
        this.pendingSuppressedFramesBeforeTrigger = Math.min(
          this.pendingSuppressedFramesBeforeTrigger,
          paddedBackoff
        );
      }
      this.updateSuppressedGauge();
    }

    if (temporalOptionsChanged) {
      this.resetTemporalGate();
    }

    if (referenceResetNeeded) {
      this.resetAdaptiveState({ preserveWarmup: !warmupChanged });
    } else if (countersResetNeeded) {
      this.resetAdaptiveState({
        preserveReference: true,
        preserveSuppressionCounters: true,
        preserveWarmup: !warmupChanged
      });
    }
  }

  handleFrame(frame: Buffer, ts = Date.now()) {
    const start = performance.now();
    try {
      const previousFrameTs = this.lastFrameTs;
      const idleRebaselineMs = this.options.idleRebaselineMs ?? DEFAULT_IDLE_REBASELINE_MS;
      if (
        previousFrameTs !== null &&
        idleRebaselineMs > 0 &&
        ts - previousFrameTs >= idleRebaselineMs
      ) {
        this.resetAdaptiveState();
        metrics.resetDetectorCounters('motion', [
          'suppressedFrames',
          'suppressedFramesBeforeTrigger',
          'backoffSuppressedFrames',
          'backoffActivations'
        ]);
        metrics.incrementDetectorCounter('motion', 'idleResets', 1);
      }

      this.lastFrameTs = ts;

      const grayscale = readFrameAsGrayscale(frame);
      const baseGaussian = gaussianBlur(grayscale);
      const baseMedian = medianFilter(baseGaussian);
      let smoothed = baseMedian;
      let denoiseStrategy = 'gaussian-median';

      if (!this.previousFrame) {
        this.previousFrame = smoothed;
        this.baselineFrame = smoothed;
        this.resetAdaptiveState({ preserveReference: true });
        return;
      }

      const diffThreshold = this.options.diffThreshold ?? DEFAULT_DIFF_THRESHOLD;
      const areaThreshold = this.options.areaThreshold ?? DEFAULT_AREA_THRESHOLD;
      const baseDebounce = this.options.debounceFrames ?? DEFAULT_DEBOUNCE_FRAMES;
      const baseBackoff = this.options.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
      const noiseMultiplier = this.options.noiseMultiplier ?? DEFAULT_NOISE_MULTIPLIER;
      const baseNoiseSmoothing = this.options.noiseSmoothing ?? DEFAULT_NOISE_SMOOTHING;
      const baseAreaSmoothing = this.options.areaSmoothing ?? DEFAULT_AREA_SMOOTHING;
      const areaInflation = this.options.areaInflation ?? DEFAULT_AREA_INFLATION;
      const areaDeltaThreshold =
        this.options.areaDeltaThreshold ?? DEFAULT_AREA_DELTA_THRESHOLD;

      const referenceFrame = this.baselineFrame ?? this.previousFrame;
      const dimensionChanged =
        this.previousFrame.width !== smoothed.width ||
        this.previousFrame.height !== smoothed.height ||
        (this.baselineFrame !== null &&
          (this.baselineFrame.width !== smoothed.width ||
            this.baselineFrame.height !== smoothed.height));

      if (dimensionChanged) {
        this.handleFrameResize(smoothed, ts);
        return;
      }

      let stats = frameDiffStats(referenceFrame, smoothed);
      const evaluateNoise = (candidate: typeof stats) => {
        const prior = this.noiseLevel === 0 ? candidate.meanDelta : this.noiseLevel;
        const ratio = prior === 0 ? 1 : candidate.meanDelta / Math.max(prior, 1);
        return { prior, ratio } as const;
      };

      let { prior: priorNoiseFloor, ratio: noiseRatio } = evaluateNoise(stats);

      if (noiseRatio > 1.6 || stats.maxDelta > diffThreshold * 2) {
        const heavyCandidate = medianFilter(gaussianBlur(baseMedian));
        const heavyStats = frameDiffStats(referenceFrame, heavyCandidate);
        const heavyNoise = evaluateNoise(heavyStats);
        if (heavyStats.meanDelta < stats.meanDelta * 0.9) {
          smoothed = heavyCandidate;
          stats = heavyStats;
          priorNoiseFloor = heavyNoise.prior;
          noiseRatio = heavyNoise.ratio;
          denoiseStrategy = 'gaussian-median-gaussian-median';
        }
      } else if (noiseRatio > 1.25 || stats.maxDelta > diffThreshold * 1.5) {
        const medianFirst = medianFilter(grayscale);
        const hybridCandidate = medianFilter(gaussianBlur(medianFirst));
        const hybridStats = frameDiffStats(referenceFrame, hybridCandidate);
        const hybridNoise = evaluateNoise(hybridStats);
        if (hybridStats.meanDelta <= stats.meanDelta * 0.95) {
          smoothed = hybridCandidate;
          stats = hybridStats;
          priorNoiseFloor = hybridNoise.prior;
          noiseRatio = hybridNoise.ratio;
          denoiseStrategy = 'median-gaussian-median';
        }
      }

      this.previousFrame = smoothed;
      this.lastDenoiseStrategy = denoiseStrategy;

      const noiseDelta = stats.meanDelta - priorNoiseFloor;

      const effectiveNoiseSmoothing = clamp(
        baseNoiseSmoothing * (noiseDelta > 0
          ? 1 + Math.min(Math.max(noiseRatio - 1, 0), 1) * 0.6
          : 0.6),
        0.05,
        0.5
      );

      const updatedNoiseFloor =
        priorNoiseFloor === 0
          ? stats.meanDelta
          : priorNoiseFloor * (1 - effectiveNoiseSmoothing) + stats.meanDelta * effectiveNoiseSmoothing;
      this.noiseLevel = updatedNoiseFloor;

      const noiseSuppressionFactor = clamp(
        noiseRatio > 1 ? 1 + (noiseRatio - 1) * 0.8 : 1 - Math.min(0.3, (1 - noiseRatio) * 0.5),
        0.6,
        3
      );

      recordWindowSample(this.noiseWindow, noiseRatio, NOISE_WINDOW_SIZE);
      const noiseWindowMedian = median(this.noiseWindow);
      const noiseWindowPressure = computePressure(this.noiseWindow, SUSTAINED_NOISE_THRESHOLD);
      const targetNoiseBoost = clamp(
        1 + Math.max((noiseWindowMedian ?? noiseRatio) - 1, 0) * 0.9 + noiseWindowPressure * 1.4,
        1,
        4
      );
      const boostSmoothing = noiseWindowPressure > 0.25 ? 0.4 : 0.25;
      this.sustainedNoiseBoost = clamp(
        this.sustainedNoiseBoost * (1 - boostSmoothing) + targetNoiseBoost * boostSmoothing,
        1,
        4
      );

      metrics.setDetectorGauge('motion', 'noiseWindowMedian', noiseWindowMedian ?? noiseRatio);
      metrics.setDetectorGauge('motion', 'noiseWindowPressure', noiseWindowPressure);
      metrics.setDetectorGauge('motion', 'noiseWindowBoost', this.sustainedNoiseBoost);

      const dynamicDiffThreshold = Math.max(diffThreshold, updatedNoiseFloor * noiseMultiplier);
      const adaptiveDiffThreshold = clamp(
        dynamicDiffThreshold * noiseSuppressionFactor,
        diffThreshold,
        diffThreshold * noiseMultiplier * 2.5
      );

      let changedPixels = 0;
      for (let i = 0; i < stats.totalPixels; i += 1) {
        if (stats.deltas[i] >= adaptiveDiffThreshold) {
          changedPixels += 1;
        }
      }

      const areaPct = changedPixels / stats.totalPixels;
      const temporalWindowSize = Math.min(
        60,
        Math.max(3, Math.round(this.options.temporalMedianWindow ?? DEFAULT_TEMPORAL_WINDOW))
      );
      recordWindowSample(this.temporalWindow, areaPct, temporalWindowSize);
      const temporalMedianValue = median(this.temporalWindow);
      const temporalBackoffSmoothing = clamp(
        this.options.temporalMedianBackoffSmoothing ?? DEFAULT_TEMPORAL_BACKOFF_SMOOTHING,
        0.05,
        0.95
      );
      const temporalSuppression = this.updateTemporalSuppression(
        areaPct,
        temporalMedianValue,
        temporalWindowSize,
        temporalBackoffSmoothing
      );
      metrics.setDetectorGauge('motion', 'temporalWindow', temporalMedianValue ?? areaPct);
      metrics.setDetectorGauge('motion', 'temporalWindowSize', temporalWindowSize);
      metrics.setDetectorGauge('motion', 'temporalSuppression', temporalSuppression);
      const temporalSuppressionRatio =
        temporalWindowSize === 0 ? 0 : temporalSuppression / Math.max(1, temporalWindowSize);
      const temporalGateMultiplier =
        this.temporalSuppression > 0 ? 1 + Math.min(1.5, temporalSuppressionRatio) * 0.9 : 1;
      metrics.setDetectorGauge('motion', 'temporalGateMultiplier', temporalGateMultiplier);
      const previousBaseline = this.areaBaseline;
      const areaTrend = previousBaseline === 0 ? areaPct : areaPct - previousBaseline;
      const trendSmoothing = clamp(
        (this.options.areaSmoothing ?? DEFAULT_AREA_SMOOTHING) * 0.65,
        0.05,
        0.35
      );
      this.areaTrendMomentum =
        previousBaseline === 0
          ? areaTrend
          : this.areaTrendMomentum * (1 - trendSmoothing) + areaTrend * trendSmoothing;

      recordWindowSample(this.areaWindow, areaPct, AREA_WINDOW_SIZE);
      const areaWindowMedian = median(this.areaWindow);
      const windowTrend =
        areaWindowMedian === null ? areaTrend : clamp(areaPct - areaWindowMedian, -1, 1);
      const stabilizedAreaTrend =
        previousBaseline === 0
          ? areaTrend
          : this.areaTrendMomentum * 0.6 + windowTrend * 0.4;
      metrics.setDetectorGauge('motion', 'areaWindowMedian', areaWindowMedian ?? areaPct);
      metrics.setDetectorGauge('motion', 'areaWindowTrend', stabilizedAreaTrend);
      const normalizedAreaTrend = clamp(
        previousBaseline === 0
          ? areaPct / Math.max(areaThreshold, 0.01)
          : stabilizedAreaTrend / Math.max(areaThreshold, 0.01),
        -2,
        2
      );

      const effectiveAreaSmoothing = clamp(
        baseAreaSmoothing * (areaTrend > 0 ? 1 + Math.min(normalizedAreaTrend, 1) * 0.3 : 0.7),
        0.05,
        0.5
      );

      const nextBaseline =
        previousBaseline === 0
          ? areaPct * effectiveAreaSmoothing
          : previousBaseline * (1 - effectiveAreaSmoothing) + areaPct * effectiveAreaSmoothing;

      const baselineForThreshold = previousBaseline === 0 ? nextBaseline : previousBaseline;
      const adaptiveAreaThreshold = Math.max(areaThreshold, baselineForThreshold * areaInflation);

      const adjustedAreaDeltaThreshold =
        areaDeltaThreshold *
        (noiseSuppressionFactor > 1.5 ? Math.min(noiseSuppressionFactor, 2.5) : 1);

      const temporalAreaThreshold = adaptiveAreaThreshold * temporalGateMultiplier;
      const temporalDeltaThreshold = adjustedAreaDeltaThreshold * temporalGateMultiplier;
      metrics.setDetectorGauge('motion', 'temporalAreaThreshold', temporalAreaThreshold);
      metrics.setDetectorGauge('motion', 'temporalDeltaThreshold', temporalDeltaThreshold);

      const hasSignificantArea =
        areaPct >= temporalAreaThreshold || stabilizedAreaTrend >= temporalDeltaThreshold;

      const debounceMultiplier = clamp(
        noiseSuppressionFactor > 1 ? 1 + (noiseSuppressionFactor - 1) * 0.7 : 1,
        1,
        3
      );
      const relaxationMultiplier = normalizedAreaTrend < 0 ? 1.15 : 1;
      const sustainedDebounceMultiplier = Math.max(1, this.sustainedNoiseBoost);
      const baseEffectiveDebounce = Math.max(
        baseDebounce,
        Math.round(
          baseDebounce * debounceMultiplier * relaxationMultiplier * sustainedDebounceMultiplier
        )
      );

      const backoffMultiplier = clamp(
        noiseSuppressionFactor > 1
          ? 1 + (noiseSuppressionFactor - 1)
          : 1 + Math.max(0, -normalizedAreaTrend) * 0.5,
        1,
        4
      );
      const sustainedBackoffMultiplier = Math.max(1, Math.min(this.sustainedNoiseBoost * 1.1, 5));
      const dynamicBackoffFrames = Math.max(
        baseBackoff,
        Math.round(baseBackoff * backoffMultiplier * sustainedBackoffMultiplier)
      );
      const { backoffPadding, debouncePadding } = this.adjustNoiseBackoffPadding(
        noiseWindowPressure,
        dynamicBackoffFrames,
        baseEffectiveDebounce
      );
      const noiseAdjustedDebounce = Math.max(0, baseEffectiveDebounce + debouncePadding);
      const noiseAdjustedBackoff = Math.max(0, dynamicBackoffFrames + backoffPadding);
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
      const effectiveDebounceFrames = Math.max(
        0,
        noiseAdjustedDebounce + temporalDebouncePadding
      );
      const effectiveBackoffFrames = Math.max(
        0,
        noiseAdjustedBackoff + temporalBackoffPadding
      );
      metrics.setDetectorGauge('motion', 'temporalDebouncePadding', temporalDebouncePadding);
      metrics.setDetectorGauge('motion', 'temporalBackoffPadding', temporalBackoffPadding);

      const shouldScheduleRebaseline =
        this.noiseWarmupRemaining === 0 &&
        (noiseWindowPressure > 0.55 || this.sustainedNoiseBoost >= 1.8);

      if (shouldScheduleRebaseline && this.rebaselineFramesRemaining === 0) {
        const baseWindow = Math.max(
          effectiveDebounceFrames + effectiveBackoffFrames,
          Math.round(NOISE_WINDOW_SIZE * 0.6)
        );
        this.rebaselineFramesRemaining = baseWindow;
      }

      if (this.rebaselineFramesRemaining > 0) {
        const decay = shouldScheduleRebaseline ? 1 : 2;
        this.rebaselineFramesRemaining = Math.max(0, this.rebaselineFramesRemaining - decay);
        metrics.setDetectorGauge('motion', 'rebaselineCountdown', this.rebaselineFramesRemaining);
        if (this.rebaselineFramesRemaining === 0 && shouldScheduleRebaseline) {
          this.resetAdaptiveState({ preserveWarmup: true });
          metrics.incrementDetectorCounter('motion', 'adaptiveRebaselines', 1);
          metrics.setDetectorGauge('motion', 'rebaselineCountdown', 0);
          metrics.setDetectorGauge('motion', 'noiseWarmupRemaining', this.noiseWarmupRemaining);
          return;
        }
      } else {
        metrics.setDetectorGauge('motion', 'rebaselineCountdown', 0);
      }

      metrics.setDetectorGauge('motion', 'effectiveDebounceFrames', effectiveDebounceFrames);
      metrics.setDetectorGauge('motion', 'effectiveBackoffFrames', effectiveBackoffFrames);
      metrics.setDetectorGauge(
        'motion',
        'noiseBackoffPadding',
        Math.max(0, this.noiseBackoffPadding)
      );

      this.areaBaseline = nextBaseline;
      this.baselineFrame = smoothed;

      const historyEntry: MotionHistoryEntry = {
        ts,
        areaPct,
        areaBaseline: this.areaBaseline,
        adaptiveAreaThreshold,
        adaptiveDiffThreshold,
        noiseLevel: this.noiseLevel,
        noiseRatio,
        suppressed: !hasSignificantArea,
        backoff: false,
        triggered: false,
        pendingBeforeTrigger: this.pendingSuppressedFramesBeforeTrigger,
        denoiseStrategy,
        reason: hasSignificantArea ? 'candidate' : 'suppressed',
        temporalMedian: temporalMedianValue ?? areaPct,
        temporalSuppression: this.temporalSuppression,
        temporalDebouncePadding,
        temporalBackoffPadding,
        temporalGateMultiplier,
        temporalAreaThreshold,
        temporalDeltaThreshold
      };

      if (this.noiseWarmupRemaining > 0) {
        this.noiseWarmupRemaining -= 1;
        metrics.setDetectorGauge('motion', 'noiseWarmupRemaining', this.noiseWarmupRemaining);
        this.activationFrames = 0;
        if (this.backoffFrames > 0) {
          this.backoffFrames = Math.max(0, this.backoffFrames - 1);
        }
        this.suppressedFrames += 1;
        metrics.incrementDetectorCounter('motion', 'suppressedFrames', 1);
        this.updateSuppressedGauge();
        historyEntry.suppressed = true;
        historyEntry.reason = 'warmup';
        historyEntry.pendingBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
        this.recordHistory(historyEntry);
        return;
      }

      metrics.setDetectorGauge('motion', 'noiseWarmupRemaining', this.noiseWarmupRemaining);

      if (!hasSignificantArea) {
        this.activationFrames = 0;
        if (this.backoffFrames > 0) {
          this.backoffFrames -= 1;
        }
        this.suppressedFrames += 1;
        metrics.incrementDetectorCounter('motion', 'suppressedFrames', 1);
        this.updateSuppressedGauge();
        historyEntry.suppressed = true;
        historyEntry.reason = 'insufficient-area';
        historyEntry.pendingBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
        this.recordHistory(historyEntry);
        return;
      }

      const temporalGateActive =
        temporalGateMultiplier > 1.15 && temporalSuppressionRatio > 0.3;

      if (temporalGateActive) {
        this.activationFrames = 0;
        this.suppressedFrames += 1;
        metrics.incrementDetectorCounter('motion', 'suppressedFrames', 1);
        this.updateSuppressedGauge();
        historyEntry.suppressed = true;
        historyEntry.reason = 'temporal-gate';
        historyEntry.pendingBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
        this.recordHistory(historyEntry);
        return;
      }

      const suppressedFramesSnapshot = this.suppressedFrames;
      this.suppressedFrames = 0;
      if (suppressedFramesSnapshot > 0) {
        this.pendingSuppressedFramesBeforeTrigger += suppressedFramesSnapshot;
        metrics.incrementDetectorCounter(
          'motion',
          'suppressedFramesBeforeTrigger',
          suppressedFramesSnapshot
        );
        this.updateSuppressedGauge();
        historyEntry.pendingBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
      }

      if (this.backoffFrames > 0) {
        metrics.incrementDetectorCounter('motion', 'backoffSuppressedFrames', 1);
        this.backoffFrames -= 1;
        this.activationFrames = 0;
        historyEntry.backoff = true;
        historyEntry.suppressed = true;
        historyEntry.reason = 'backoff';
        historyEntry.pendingBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
        this.recordHistory(historyEntry);
        return;
      }

      this.activationFrames += 1;
      if (this.activationFrames < effectiveDebounceFrames) {
        historyEntry.suppressed = true;
        historyEntry.reason = temporalDebouncePadding > 0 ? 'temporal-gate' : 'debouncing';
        historyEntry.pendingBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
        this.recordHistory(historyEntry);
        return;
      }

      this.activationFrames = 0;

      if (ts - this.lastEventTs < (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) {
        const cooldownPending = this.pendingSuppressedFramesBeforeTrigger;
        this.pendingSuppressedFramesBeforeTrigger = 0;
        this.updateSuppressedGauge();
        historyEntry.suppressed = true;
        historyEntry.reason = 'cooldown';
        historyEntry.pendingBeforeTrigger = cooldownPending;
        this.recordHistory(historyEntry);
        return;
      }

      this.lastEventTs = ts;
      this.backoffFrames = effectiveBackoffFrames;
      metrics.incrementDetectorCounter('motion', 'backoffActivations', 1);

      const suppressedFramesBeforeTrigger = this.pendingSuppressedFramesBeforeTrigger;
      this.pendingSuppressedFramesBeforeTrigger = 0;
      this.updateSuppressedGauge();

      historyEntry.triggered = true;
      historyEntry.suppressed = false;
      historyEntry.reason = 'trigger';
      historyEntry.pendingBeforeTrigger = suppressedFramesBeforeTrigger;
      this.recordHistory(historyEntry);

      const historySnapshot = this.getHistorySnapshot(
        Math.max(10, effectiveDebounceFrames + effectiveBackoffFrames)
      );
      const historyWindowMs =
        historySnapshot.length > 1
          ? historySnapshot[historySnapshot.length - 1]!.ts - historySnapshot[0]!.ts
          : 0;

      const payload: EventPayload = {
        ts,
        detector: 'motion',
        source: this.options.source,
        severity: 'warning',
        message: 'Motion detected',
        meta: {
          areaPct,
          areaThreshold,
          diffThreshold,
          adaptiveDiffThreshold,
          adaptiveAreaThreshold,
          areaBaseline: this.areaBaseline,
          noiseLevel: this.noiseLevel,
          noiseFloor: updatedNoiseFloor,
          noiseRatio,
          noiseSuppressionFactor,
          noiseWindowMedian: noiseWindowMedian ?? noiseRatio,
          noiseWindowPressure,
          sustainedNoiseBoost: this.sustainedNoiseBoost,
          areaTrend,
          stabilizedAreaTrend,
          areaWindowMedian: areaWindowMedian ?? areaPct,
          areaDeltaThreshold: adjustedAreaDeltaThreshold,
          normalizedAreaTrend,
          effectiveDebounceFrames,
          effectiveBackoffFrames,
          noiseSmoothing: effectiveNoiseSmoothing,
          areaSmoothing: effectiveAreaSmoothing,
          noiseMultiplier,
          areaInflation,
          debounceMultiplier,
          backoffMultiplier,
          suppressedFramesBeforeTrigger,
          denoiseStrategy,
          noiseWarmupRemaining: this.noiseWarmupRemaining,
          noiseBackoffPadding: this.noiseBackoffPadding,
          temporalMedian: temporalMedianValue ?? areaPct,
          temporalSuppression: this.temporalSuppression,
          temporalDebouncePadding,
          temporalBackoffPadding,
          temporalWindowSize,
          temporalGateMultiplier,
          temporalAreaThreshold,
          temporalDeltaThreshold,
          history: historySnapshot,
          historyWindowMs
        }
      };

      this.bus.emit('event', payload);
    } catch (error) {
      this.handleFrameProcessingError(error);
    } finally {
      metrics.observeDetectorLatency('motion', performance.now() - start);
    }
  }

  private handleFrameProcessingError(error: unknown) {
    void error; // Swallow frame processing errors while resetting state
    this.resetAdaptiveState();
    metrics.resetDetectorCounters('motion', [
      'suppressedFrames',
      'suppressedFramesBeforeTrigger',
      'backoffSuppressedFrames',
      'backoffActivations'
    ]);
    metrics.incrementDetectorCounter('motion', 'errors', 1);
    metrics.setDetectorGauge('motion', 'noiseWarmupRemaining', this.noiseWarmupRemaining);
    metrics.setDetectorGauge('motion', 'noiseBackoffPadding', Math.max(0, this.noiseBackoffPadding));
    metrics.setDetectorGauge('motion', 'noiseWindowBoost', this.sustainedNoiseBoost);
  }

  private adjustNoiseBackoffPadding(
    noiseWindowPressure: number,
    dynamicBackoffFrames: number,
    baseEffectiveDebounce: number
  ) {
    const basePadding = this.baseNoiseBackoffPadding;
    const suppressedBudget = this.suppressedFrames + this.pendingSuppressedFramesBeforeTrigger;
    const pressureInfluence = Math.max(0, noiseWindowPressure - 0.2);
    const pressureTarget = pressureInfluence * (dynamicBackoffFrames + baseEffectiveDebounce);
    const suppressionTarget = suppressedBudget > 0
      ? Math.min(suppressedBudget, dynamicBackoffFrames + baseEffectiveDebounce)
      : 0;
    const pressureContribution = Math.round(pressureTarget * 0.6);
    const suppressionContribution = Math.round(suppressionTarget * 0.25);
    const minimumBoost = pressureInfluence > 0 ? 1 : 0;
    const targetPadding = Math.max(
      basePadding,
      Math.min(
        basePadding + Math.max(pressureContribution + suppressionContribution, minimumBoost),
        basePadding + Math.round((dynamicBackoffFrames + baseEffectiveDebounce) * 0.6)
      )
    );
    const smoothing = noiseWindowPressure > 0.6 ? 0.5 : noiseWindowPressure > 0.45 ? 0.35 : 0.2;
    const blended = Math.max(
      basePadding,
      Math.round(this.noiseBackoffPadding * (1 - smoothing) + targetPadding * smoothing)
    );
    const shouldDecay = noiseWindowPressure < 0.2 && suppressedBudget === 0;
    this.noiseBackoffPadding = shouldDecay
      ? Math.max(basePadding, Math.round(blended * 0.85))
      : blended;

    const backoffPadding = Math.max(0, Math.round(this.noiseBackoffPadding));
    const debouncePadding = Math.max(
      0,
      Math.min(
        backoffPadding,
        Math.round(backoffPadding * (noiseWindowPressure >= 0.5 ? 0.75 : noiseWindowPressure * 0.9))
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
    if (this.temporalSuppression <= 0 || baseDebounce <= 0) {
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
    if (this.temporalSuppression <= 0 || baseBackoff <= 0) {
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

  private handleFrameResize(frame: GrayscaleFrame, ts: number) {
    this.resetAdaptiveState({ preserveWarmup: true });
    this.previousFrame = frame;
    this.baselineFrame = frame;
    this.lastFrameTs = ts;
  }

  private resetAdaptiveState(
    options: {
      preserveReference?: boolean;
      preserveSuppressionCounters?: boolean;
      preserveWarmup?: boolean;
    } = {}
  ) {
    const preserveReference = options.preserveReference ?? false;
    const preserveSuppression = options.preserveSuppressionCounters ?? false;
    const preserveWarmup = options.preserveWarmup ?? false;

    if (!preserveReference) {
      this.previousFrame = null;
      this.baselineFrame = null;
      this.lastFrameTs = null;
      this.motionHistory.length = 0;
    }

    this.areaBaseline = 0;
    this.noiseLevel = 0;
    this.areaTrendMomentum = 0;
    this.activationFrames = 0;
    this.backoffFrames = 0;
    this.noiseWindow.length = 0;
    this.areaWindow.length = 0;
    this.resetTemporalGate();
    this.sustainedNoiseBoost = 1;
    if (!preserveSuppression) {
      this.suppressedFrames = 0;
      this.pendingSuppressedFramesBeforeTrigger = 0;
      this.updateSuppressedGauge();
    }
    if (!preserveWarmup) {
      this.noiseWarmupRemaining = Math.max(0, this.options.noiseWarmupFrames ?? 0);
    }
    this.baseNoiseBackoffPadding = Math.max(0, this.options.noiseBackoffPadding ?? 0);
    this.noiseBackoffPadding = this.baseNoiseBackoffPadding;
    this.lastDenoiseStrategy = 'gaussian-median';
    this.rebaselineFramesRemaining = 0;
    metrics.setDetectorGauge('motion', 'rebaselineCountdown', 0);
  }

  private recordHistory(entry: MotionHistoryEntry) {
    this.motionHistory.push(entry);
    if (this.motionHistory.length > MAX_HISTORY_SIZE) {
      this.motionHistory.splice(0, this.motionHistory.length - MAX_HISTORY_SIZE);
    }
  }

  private updateSuppressedGauge() {
    metrics.setDetectorGauge(
      'motion',
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
    metrics.setDetectorGauge('motion', 'temporalWindow', 0);
    metrics.setDetectorGauge('motion', 'temporalWindowSize', windowSize);
    metrics.setDetectorGauge('motion', 'temporalSuppression', 0);
    metrics.setDetectorGauge('motion', 'temporalDebouncePadding', 0);
    metrics.setDetectorGauge('motion', 'temporalBackoffPadding', 0);
    metrics.setDetectorGauge('motion', 'temporalGateMultiplier', 1);
    metrics.setDetectorGauge('motion', 'temporalAreaThreshold', 0);
    metrics.setDetectorGauge('motion', 'temporalDeltaThreshold', 0);
  }

  private getHistorySnapshot(limit: number) {
    const count = Math.max(1, Math.min(limit, MAX_HISTORY_SIZE));
    const entries = this.motionHistory.slice(-count);
    return entries.map(entry => ({ ...entry }));
  }
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

function computePressure(buffer: number[], threshold: number): number {
  if (buffer.length === 0) {
    return 0;
  }
  const hits = buffer.filter(value => value >= threshold).length;
  return hits / buffer.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default MotionDetector;
