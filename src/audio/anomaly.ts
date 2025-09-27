import { EventEmitter } from 'node:events';
import Meyda from 'meyda';
import eventBus from '../eventBus.js';
import { EventPayload } from '../types.js';

export interface AudioAnomalyOptions {
  source: string;
  sampleRate?: number;
  rmsThreshold?: number;
  centroidJumpThreshold?: number;
  minIntervalMs?: number;
  frameSize?: number;
  hopSize?: number;
  frameDurationMs?: number;
  hopDurationMs?: number;
  minTriggerDurationMs?: number;
  rmsWindowMs?: number;
  centroidWindowMs?: number;
  thresholds?: AudioAnomalyThresholdSchedule;
  nightHours?: NightHoursConfig;
}

export interface AudioAnomalyThresholds {
  rms?: number;
  centroidJump?: number;
  rmsWindowMs?: number;
  centroidWindowMs?: number;
  minTriggerDurationMs?: number;
}

export interface AudioAnomalyThresholdSchedule {
  default?: AudioAnomalyThresholds;
  day?: AudioAnomalyThresholds;
  night?: AudioAnomalyThresholds;
  blendMinutes?: number;
}

export interface NightHoursConfig {
  start: number;
  end: number;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_RMS_THRESHOLD = 0.2;
const DEFAULT_CENTROID_JUMP = 150;
const DEFAULT_MIN_INTERVAL_MS = 1500;
const DEFAULT_FRAME_SIZE = 1024;
const DEFAULT_MIN_TRIGGER_DURATION_MS = 100;
const DEFAULT_RMS_WINDOW_MS = 200;
const DEFAULT_CENTROID_WINDOW_MS = 300;

type ThresholdBlendWeights = {
  default?: number;
  day?: number;
  night?: number;
};

type ResolvedThresholds = {
  profile: 'default' | 'day' | 'night' | 'transition';
  rms: number;
  centroidJump: number;
  rmsWindowMs: number;
  centroidWindowMs: number;
  minTriggerDurationMs: number;
  weights?: ThresholdBlendWeights;
};

export class AudioAnomalyDetector {
  private lastEventTs = 0;
  private buffer: number[] = [];
  private frameSize: number;
  private hopSize: number;
  private window: Float32Array;
  private frameDurationMs: number;
  private hopDurationMs: number;
  private rmsDurationMs = 0;
  private centroidDurationMs = 0;
  private rmsRecoveryMs = 0;
  private centroidRecoveryMs = 0;
  private rmsSustainFrames = 0;
  private centroidSustainFrames = 0;
  private rmsRecoveryFrames = 0;
  private centroidRecoveryFrames = 0;
  private rmsRecoveredSinceEvent = true;
  private centroidRecoveredSinceEvent = true;
  private rmsWindowFrames: number;
  private centroidWindowFrames: number;
  private readonly rmsValues: number[] = [];
  private readonly centroidValues: number[] = [];
  private processedFrames = 0;
  private defaultRmsWindowMs: number;
  private defaultCentroidWindowMs: number;
  private defaultMinTriggerDurationMs: number;
  private currentThresholds: ResolvedThresholds | null = null;

  constructor(
    private options: AudioAnomalyOptions,
    private readonly bus: EventEmitter = eventBus
  ) {
    this.options = {
      ...options,
      thresholds: cloneThresholdSchedule(options.thresholds),
      nightHours: options.nightHours ? { ...options.nightHours } : undefined
    };

    this.defaultRmsWindowMs = this.options.rmsWindowMs ?? DEFAULT_RMS_WINDOW_MS;
    this.defaultCentroidWindowMs =
      this.options.centroidWindowMs ?? DEFAULT_CENTROID_WINDOW_MS;
    this.defaultMinTriggerDurationMs =
      this.options.minTriggerDurationMs ?? DEFAULT_MIN_TRIGGER_DURATION_MS;

    this.updateWindowGeometry(this.options);
    this.rmsWindowFrames = Math.max(
      1,
      Math.round(this.defaultRmsWindowMs / this.hopDurationMs)
    );
    this.centroidWindowFrames = Math.max(
      1,
      Math.round(this.defaultCentroidWindowMs / this.hopDurationMs)
    );
    this.currentThresholds = {
      profile: 'default',
      rms: this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD,
      centroidJump: this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP,
      rmsWindowMs: this.defaultRmsWindowMs,
      centroidWindowMs: this.defaultCentroidWindowMs,
      minTriggerDurationMs: this.defaultMinTriggerDurationMs
    };
  }

  updateOptions(options: Partial<Omit<AudioAnomalyOptions, 'source'>>) {
    const hasChanges =
      options.sampleRate !== undefined ||
      options.frameSize !== undefined ||
      options.hopSize !== undefined ||
      options.frameDurationMs !== undefined ||
      options.hopDurationMs !== undefined ||
      options.rmsThreshold !== undefined ||
      options.centroidJumpThreshold !== undefined ||
      options.minIntervalMs !== undefined ||
      options.thresholds !== undefined ||
      options.nightHours !== undefined ||
      options.minTriggerDurationMs !== undefined ||
      options.rmsWindowMs !== undefined ||
      options.centroidWindowMs !== undefined;

    if (!hasChanges) {
      return;
    }

    const thresholds = options.thresholds ? cloneThresholdSchedule(options.thresholds) : undefined;
    const nightHours = options.nightHours ? { ...options.nightHours } : undefined;
    const next: AudioAnomalyOptions = {
      ...this.options,
      ...options,
      thresholds: thresholds ?? this.options.thresholds,
      nightHours: nightHours ?? this.options.nightHours
    };

    if (options.rmsWindowMs !== undefined) {
      this.defaultRmsWindowMs = options.rmsWindowMs ?? this.defaultRmsWindowMs;
    }

    if (options.centroidWindowMs !== undefined) {
      this.defaultCentroidWindowMs = options.centroidWindowMs ?? this.defaultCentroidWindowMs;
    }

    if (options.minTriggerDurationMs !== undefined) {
      this.defaultMinTriggerDurationMs =
        options.minTriggerDurationMs ?? this.defaultMinTriggerDurationMs;
    }

    this.options = next;

    const geometryChanged =
      options.sampleRate !== undefined ||
      options.frameSize !== undefined ||
      options.hopSize !== undefined ||
      options.frameDurationMs !== undefined ||
      options.hopDurationMs !== undefined;

    if (geometryChanged) {
      this.updateWindowGeometry(next);
      this.resetWindows();
    } else {
      const nextRmsFrames = Math.max(
        1,
        Math.round(this.defaultRmsWindowMs / this.hopDurationMs)
      );
      const nextCentroidFrames = Math.max(
        1,
        Math.round(this.defaultCentroidWindowMs / this.hopDurationMs)
      );
      this.resampleWindows(nextRmsFrames, nextCentroidFrames, false);
    }

    this.currentThresholds = null;
  }

  handleChunk(samples: Int16Array, ts = Date.now()) {
    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const normalized = normalizeSamples(samples);
    for (let i = 0; i < normalized.length; i += 1) {
      this.buffer.push(normalized[i]);
    }

    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const frameDurationMs = this.frameDurationMs;
    const hopDurationMs = this.hopDurationMs;

    while (this.buffer.length >= this.frameSize) {
      const frameStart = Math.max(0, this.buffer.length - this.frameSize);
      const frame = this.buffer.slice(frameStart, frameStart + this.frameSize);
      const frameRms = computeRms(frame);
      const windowed = applyWindow(frame, this.window);
      const features = Meyda.extract(['rms', 'spectralCentroid'], windowed, {
        sampleRate,
        bufferSize: this.frameSize
      });

      if (!features) {
        this.buffer.splice(0, this.hopSize);
        continue;
      }

      const rms = frameRms;
      const centroid = features.spectralCentroid ?? 0;

      this.processedFrames += 1;

      const thresholds = this.resolveThresholds(ts);
      const minTriggerDuration = thresholds.minTriggerDurationMs;
      const minTriggerFrames = Math.max(
        1,
        Math.round(minTriggerDuration / this.hopDurationMs)
      );
      const baselineRms = computeAverage(this.rmsValues);
      const baselineCentroid = computeAverage(this.centroidValues);
      const rmsDelta = Math.max(0, rms - baselineRms);
      const centroidDelta = Math.abs(centroid - baselineCentroid);
      const triggeredByRms = rmsDelta >= thresholds.rms;
      const triggeredByCentroid = centroidDelta >= thresholds.centroidJump;

      if (triggeredByRms) {
        this.rmsSustainFrames += 1;
        this.rmsRecoveryFrames = 0;
      } else {
        this.rmsSustainFrames = 0;
        this.rmsRecoveryFrames += 1;
        if (this.rmsRecoveryFrames >= minTriggerFrames) {
          this.rmsRecoveredSinceEvent = true;
        }
      }

      if (triggeredByCentroid) {
        this.centroidSustainFrames += 1;
        this.centroidRecoveryFrames = 0;
      } else {
        this.centroidSustainFrames = 0;
        this.centroidRecoveryFrames += 1;
        if (this.centroidRecoveryFrames >= minTriggerFrames) {
          this.centroidRecoveredSinceEvent = true;
        }
      }

      this.rmsDurationMs = this.rmsSustainFrames * hopDurationMs;
      this.centroidDurationMs = this.centroidSustainFrames * hopDurationMs;
      this.rmsRecoveryMs = this.rmsRecoveryFrames * hopDurationMs;
      this.centroidRecoveryMs = this.centroidRecoveryFrames * hopDurationMs;

      this.buffer.splice(0, this.hopSize);
      const rmsBaselineUpdate = triggeredByRms
        ? baselineRms + (rms - baselineRms) * 0.1
        : rms;
      const centroidBaselineUpdate = triggeredByCentroid
        ? baselineCentroid + (centroid - baselineCentroid) * 0.1
        : centroid;
      this.pushValue(this.rmsValues, rmsBaselineUpdate, this.rmsWindowFrames);
      this.pushValue(this.centroidValues, centroidBaselineUpdate, this.centroidWindowFrames);

      const rmsExceeded = this.rmsSustainFrames >= minTriggerFrames;
      const centroidExceeded = this.centroidSustainFrames >= minTriggerFrames;

      if (!rmsExceeded && !centroidExceeded) {
        break;
      }

      const recoveryBlocked =
        this.lastEventTs !== 0 &&
        ((rmsExceeded && !this.rmsRecoveredSinceEvent) ||
          (centroidExceeded && !this.centroidRecoveredSinceEvent));

      if (recoveryBlocked) {
        break;
      }

      if (ts - this.lastEventTs < minInterval) {
        break;
      }

      const triggeredBy = rmsExceeded ? 'rms' : 'centroid';
      const triggeredDurationMs = rmsExceeded ? this.rmsDurationMs : this.centroidDurationMs;
      const accumulationSnapshot = {
        rmsMs: this.rmsDurationMs,
        rmsFrames: this.rmsSustainFrames,
        centroidMs: this.centroidDurationMs,
        centroidFrames: this.centroidSustainFrames
      };
      const recoverySnapshot = {
        rmsMs: this.rmsRecoveryMs,
        rmsFrames: this.rmsRecoveryFrames,
        centroidMs: this.centroidRecoveryMs,
        centroidFrames: this.centroidRecoveryFrames
      };

      const stateSnapshot = {
        rms: {
          durationMs: this.rmsDurationMs,
          recoveryMs: this.rmsRecoveryMs,
          sustainFrames: this.rmsSustainFrames,
          recoveryFrames: this.rmsRecoveryFrames,
          windowMs: this.rmsWindowFrames * this.hopDurationMs
        },
        centroid: {
          durationMs: this.centroidDurationMs,
          recoveryMs: this.centroidRecoveryMs,
          sustainFrames: this.centroidSustainFrames,
          recoveryFrames: this.centroidRecoveryFrames,
          windowMs: this.centroidWindowFrames * this.hopDurationMs
        }
      };

      this.lastEventTs = ts;
      if (rmsExceeded) {
        this.rmsRecoveredSinceEvent = false;
      }
      if (centroidExceeded) {
        this.centroidRecoveredSinceEvent = false;
      }

      this.rmsDurationMs = 0;
      this.centroidDurationMs = 0;
      this.rmsRecoveryMs = 0;
      this.centroidRecoveryMs = 0;
      this.rmsSustainFrames = 0;
      this.centroidSustainFrames = 0;
      this.rmsRecoveryFrames = 0;
      this.centroidRecoveryFrames = 0;

      const payload: EventPayload = {
        ts,
        detector: 'audio-anomaly',
        source: this.options.source,
        severity: triggeredBy === 'rms' ? 'critical' : 'warning',
        message: triggeredBy === 'rms' ? 'High audio level detected' : 'Abrupt spectral change detected',
        meta: {
          rms,
          centroid,
          baselines: {
            rms: baselineRms,
            centroid: baselineCentroid
          },
          thresholds: {
            rms: thresholds.rms,
            centroidJump: thresholds.centroidJump,
            minTriggerDurationMs: thresholds.minTriggerDurationMs,
            rmsWindowMs: thresholds.rmsWindowMs,
            centroidWindowMs: thresholds.centroidWindowMs,
            profile: thresholds.profile,
            weights: thresholds.weights
          },
          triggeredBy,
          window: {
            frameSize: this.frameSize,
            hopSize: this.hopSize,
            frameDurationMs: this.frameDurationMs,
            hopDurationMs: this.hopDurationMs,
            processedFrames: this.processedFrames
          },
          durationAboveThresholdMs: triggeredDurationMs,
          accumulationMs: accumulationSnapshot,
          recoveryMs: recoverySnapshot,
          state: stateSnapshot
        }
      };

      this.bus.emit('event', payload);
      break;
    }
  }

  private updateWindowGeometry(options: AudioAnomalyOptions) {
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    if (options.frameSize && options.frameSize > 0) {
      this.frameSize = Math.max(1, Math.floor(options.frameSize));
    } else if (options.frameDurationMs && options.frameDurationMs > 0) {
      this.frameSize = Math.max(1, Math.round((sampleRate * options.frameDurationMs) / 1000));
    } else {
      this.frameSize = DEFAULT_FRAME_SIZE;
    }

    const configuredHopDuration = options.hopDurationMs ?? null;
    let configuredHop = options.hopSize;
    if ((!configuredHop || configuredHop <= 0) && configuredHopDuration && configuredHopDuration > 0) {
      configuredHop = Math.round((sampleRate * configuredHopDuration) / 1000);
    }

    if (!configuredHop || configuredHop <= 0) {
      configuredHop = Math.floor(this.frameSize / 2);
    }

    this.hopSize = Math.min(this.frameSize, Math.max(1, configuredHop));
    this.window = createHanningWindow(this.frameSize);
    this.frameDurationMs = (this.frameSize / sampleRate) * 1000;
    this.hopDurationMs = (this.hopSize / sampleRate) * 1000;
    this.rmsWindowFrames = Math.max(
      1,
      Math.round(this.defaultRmsWindowMs / this.hopDurationMs)
    );
    this.centroidWindowFrames = Math.max(
      1,
      Math.round(this.defaultCentroidWindowMs / this.hopDurationMs)
    );
    this.resetAccumulation();
    this.processedFrames = 0;
  }

  private resetWindows() {
    this.buffer.length = 0;
    this.rmsValues.length = 0;
    this.centroidValues.length = 0;
    this.resetAccumulation();
    this.lastEventTs = 0;
    this.processedFrames = 0;
  }

  private resetAccumulation() {
    this.rmsDurationMs = 0;
    this.centroidDurationMs = 0;
    this.rmsRecoveryMs = 0;
    this.centroidRecoveryMs = 0;
    this.rmsSustainFrames = 0;
    this.centroidSustainFrames = 0;
    this.rmsRecoveryFrames = 0;
    this.centroidRecoveryFrames = 0;
    this.rmsRecoveredSinceEvent = true;
    this.centroidRecoveredSinceEvent = true;
  }

  private resampleWindows(rmsFrames: number, centroidFrames: number, resetHistory: boolean) {
    const nextRmsFrames = Math.max(1, Math.floor(rmsFrames));
    const nextCentroidFrames = Math.max(1, Math.floor(centroidFrames));

    if (resetHistory) {
      this.resizeWindowStore(this.rmsValues, nextRmsFrames);
      this.resizeWindowStore(this.centroidValues, nextCentroidFrames);
      this.rmsWindowFrames = nextRmsFrames;
      this.centroidWindowFrames = nextCentroidFrames;
      this.resetAccumulation();
      return;
    }

    const rmsChanged = nextRmsFrames !== this.rmsWindowFrames;
    const centroidChanged = nextCentroidFrames !== this.centroidWindowFrames;

    if (rmsChanged) {
      this.resizeWindowStore(this.rmsValues, nextRmsFrames);
    }
    if (centroidChanged) {
      this.resizeWindowStore(this.centroidValues, nextCentroidFrames);
    }

    this.rmsWindowFrames = nextRmsFrames;
    this.centroidWindowFrames = nextCentroidFrames;

    if (rmsChanged || centroidChanged) {
      this.rmsSustainFrames = Math.min(this.rmsSustainFrames, nextRmsFrames);
      this.centroidSustainFrames = Math.min(this.centroidSustainFrames, nextCentroidFrames);
      this.rmsRecoveryFrames = Math.min(this.rmsRecoveryFrames, nextRmsFrames);
      this.centroidRecoveryFrames = Math.min(this.centroidRecoveryFrames, nextCentroidFrames);
      this.rmsDurationMs = Math.min(this.rmsDurationMs, nextRmsFrames * this.hopDurationMs);
      this.centroidDurationMs = Math.min(
        this.centroidDurationMs,
        nextCentroidFrames * this.hopDurationMs
      );
      this.rmsRecoveryMs = this.rmsRecoveryFrames * this.hopDurationMs;
      this.centroidRecoveryMs = this.centroidRecoveryFrames * this.hopDurationMs;
    }
  }

  private resizeWindowStore(store: number[], length: number) {
    const target = Math.max(0, Math.floor(length));
    if (target <= 0) {
      store.length = 0;
      return;
    }

    if (store.length > target) {
      store.splice(0, store.length - target);
      return;
    }

    if (store.length === target) {
      return;
    }

    const fillValue = store.length > 0 ? computeAverage(store) : 0;
    while (store.length < target) {
      store.unshift(fillValue);
    }
  }

  private resolveThresholds(ts: number): ResolvedThresholds {
    const baseRms = this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    const baseCentroid = this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP;
    const schedule = this.options.thresholds;
    const baseRmsWindowMs = this.defaultRmsWindowMs;
    const baseCentroidWindowMs = this.defaultCentroidWindowMs;
    const baseMinTrigger = this.defaultMinTriggerDurationMs;

    if (!schedule) {
      return this.applyThresholdProfile({
        profile: 'default',
        rms: baseRms,
        centroidJump: baseCentroid,
        rmsWindowMs: baseRmsWindowMs,
        centroidWindowMs: baseCentroidWindowMs,
        minTriggerDurationMs: baseMinTrigger
      });
    }

    const isNight = this.isNight(ts);
    const hasNight = Boolean(schedule.night);
    const hasDay = Boolean(schedule.day);
    const resolvedDefault = this.mergeThresholdEntry(schedule.default, {
      rms: baseRms,
      centroidJump: baseCentroid,
      rmsWindowMs: baseRmsWindowMs,
      centroidWindowMs: baseCentroidWindowMs,
      minTriggerDurationMs: baseMinTrigger
    });
    const resolvedDay = this.mergeThresholdEntry(schedule.day, resolvedDefault);
    const resolvedNight = this.mergeThresholdEntry(schedule.night, resolvedDefault);

    const blendWeights = this.resolveBlendWeights(ts, schedule, Boolean(schedule.day), Boolean(schedule.night));
    if (blendWeights) {
      const entries: Array<{ weight: number; values: typeof resolvedDefault; profile: keyof ThresholdBlendWeights }>
        = [];
      if (blendWeights.day && blendWeights.day > 0) {
        entries.push({ weight: blendWeights.day, values: resolvedDay, profile: 'day' });
      }
      if (blendWeights.night && blendWeights.night > 0) {
        entries.push({ weight: blendWeights.night, values: resolvedNight, profile: 'night' });
      }
      const defaultWeight = blendWeights.default && blendWeights.default > 0 ? blendWeights.default : 0;
      if (defaultWeight > 0) {
        entries.push({ weight: defaultWeight, values: resolvedDefault, profile: 'default' });
      }

      const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
      if (total > 0) {
        let rms = 0;
        let centroid = 0;
        let rmsWindow = 0;
        let centroidWindow = 0;
        let minTrigger = 0;
        for (const entry of entries) {
          const ratio = entry.weight / total;
          rms += entry.values.rms * ratio;
          centroid += entry.values.centroidJump * ratio;
          rmsWindow += entry.values.rmsWindowMs * ratio;
          centroidWindow += entry.values.centroidWindowMs * ratio;
          minTrigger += entry.values.minTriggerDurationMs * ratio;
        }
        return this.applyThresholdProfile({
          profile: 'transition',
          rms,
          centroidJump: centroid,
          rmsWindowMs: rmsWindow,
          centroidWindowMs: centroidWindow,
          minTriggerDurationMs: minTrigger,
          weights: {
            day: blendWeights.day,
            night: blendWeights.night,
            default: defaultWeight > 0 ? defaultWeight : undefined
          }
        });
      }
    }

    const usingNight = isNight && hasNight;
    const usingDay = !isNight && hasDay;
    const profile: ResolvedThresholds['profile'] = usingNight
      ? 'night'
      : usingDay
        ? 'day'
        : 'default';
    const chosen = usingNight
      ? resolvedNight
      : usingDay
        ? resolvedDay
        : resolvedDefault;

    return this.applyThresholdProfile({
      profile,
      rms: chosen.rms,
      centroidJump: chosen.centroidJump,
      rmsWindowMs: chosen.rmsWindowMs,
      centroidWindowMs: chosen.centroidWindowMs,
      minTriggerDurationMs: chosen.minTriggerDurationMs,
      weights:
        profile === 'default'
          ? { default: 1 }
          : profile === 'day'
            ? { day: 1 }
            : { night: 1 }
    });
  }

  private mergeThresholdEntry(
    entry: AudioAnomalyThresholds | undefined,
    base: { rms: number; centroidJump: number; rmsWindowMs: number; centroidWindowMs: number; minTriggerDurationMs: number }
  ) {
    if (!entry) {
      return { ...base };
    }

    return {
      rms: entry.rms ?? base.rms,
      centroidJump: entry.centroidJump ?? base.centroidJump,
      rmsWindowMs: entry.rmsWindowMs ?? base.rmsWindowMs,
      centroidWindowMs: entry.centroidWindowMs ?? base.centroidWindowMs,
      minTriggerDurationMs: entry.minTriggerDurationMs ?? base.minTriggerDurationMs
    };
  }

  private resolveBlendWeights(
    ts: number,
    schedule: AudioAnomalyThresholdSchedule,
    hasDay: boolean,
    hasNight: boolean
  ): ThresholdBlendWeights | null {
    const hoursConfig = this.options.nightHours;
    const blendMinutes = schedule.blendMinutes;
    if (!hoursConfig || !blendMinutes || blendMinutes <= 0 || !hasDay || !hasNight) {
      return null;
    }

    const halfWindow = Math.min(blendMinutes / 2, 720);
    if (halfWindow <= 0) {
      return null;
    }

    const startMinutes = normalizeMinutes(hoursToMinutes(hoursConfig.start));
    const endMinutes = normalizeMinutes(hoursToMinutes(hoursConfig.end));
    if (startMinutes === endMinutes) {
      return null;
    }

    const now = new Date(ts);
    const nowMinutes = normalizeMinutes(
      now.getHours() * 60 +
        now.getMinutes() +
        now.getSeconds() / 60 +
        now.getMilliseconds() / 60000
    );

    const distanceToStart = circularDistance(nowMinutes, startMinutes);
    const distanceToEnd = circularDistance(nowMinutes, endMinutes);

    let boundary: 'start' | 'end' = 'start';
    let boundaryMinutes = startMinutes;
    let distance = distanceToStart;
    if (distanceToEnd < distanceToStart) {
      boundary = 'end';
      boundaryMinutes = endMinutes;
      distance = distanceToEnd;
    }

    if (distance > halfWindow) {
      return null;
    }

    const forward = forwardDistance(boundaryMinutes, nowMinutes);
    const afterBoundary = forward <= halfWindow;
    const ratio = halfWindow === 0 ? 0 : Math.max(0, Math.min(1, distance / halfWindow));
    const eased = 1 - ratio * ratio;
    const targetWeight = eased;
    const otherWeight = 1 - targetWeight;

    if (boundary === 'start') {
      return afterBoundary
        ? { night: targetWeight, day: otherWeight }
        : { day: targetWeight, night: otherWeight };
    }

    return afterBoundary
      ? { day: targetWeight, night: otherWeight }
      : { night: targetWeight, day: otherWeight };
  }

  private applyThresholdProfile(resolved: ResolvedThresholds): ResolvedThresholds {
    const previous = this.currentThresholds;
    if (!previous) {
      const rmsFrames = Math.max(1, Math.round(resolved.rmsWindowMs / this.hopDurationMs));
      const centroidFrames = Math.max(
        1,
        Math.round(resolved.centroidWindowMs / this.hopDurationMs)
      );
      const applied = {
        ...resolved,
        rmsWindowMs: rmsFrames * this.hopDurationMs,
        centroidWindowMs: centroidFrames * this.hopDurationMs,
        minTriggerDurationMs: alignDuration(resolved.minTriggerDurationMs, this.hopDurationMs)
      } as ResolvedThresholds;
      this.currentThresholds = applied;
      this.rmsWindowFrames = rmsFrames;
      this.centroidWindowFrames = centroidFrames;
      return applied;
    }

    const profileChanged = previous.profile !== resolved.profile;
    const rmsWindowFrames = Math.max(1, Math.round(resolved.rmsWindowMs / this.hopDurationMs));
    const centroidWindowFrames = Math.max(
      1,
      Math.round(resolved.centroidWindowMs / this.hopDurationMs)
    );
    const windowChanged =
      rmsWindowFrames !== this.rmsWindowFrames || centroidWindowFrames !== this.centroidWindowFrames;

    if (windowChanged) {
      this.resampleWindows(rmsWindowFrames, centroidWindowFrames, profileChanged);
    } else {
      this.resampleWindows(rmsWindowFrames, centroidWindowFrames, false);
      if (profileChanged) {
        this.resetAccumulation();
      }
    }
    const applied = {
      ...resolved,
      rmsWindowMs: rmsWindowFrames * this.hopDurationMs,
      centroidWindowMs: centroidWindowFrames * this.hopDurationMs,
      minTriggerDurationMs: alignDuration(resolved.minTriggerDurationMs, this.hopDurationMs)
    } as ResolvedThresholds;
    this.currentThresholds = applied;
    return applied;
  }

  private isNight(ts: number) {
    const hoursConfig = this.options.nightHours;

    if (!hoursConfig) {
      return false;
    }

    const date = new Date(ts);
    const hour = date.getHours() + date.getMinutes() / 60;
    const start = clamp(hoursConfig.start, 0, 24);
    const end = clamp(hoursConfig.end, 0, 24);

    if (start === end) {
      return true;
    }

    if (start < end) {
      return hour >= start && hour < end;
    }

    return hour >= start || hour < end;
  }

  private pushValue(store: number[], value: number, maxLength: number) {
    store.push(value);
    if (store.length > maxLength) {
      store.splice(0, store.length - maxLength);
    }
  }
}

function normalizeSamples(samples: Int16Array): Float32Array {
  const normalized = new Float32Array(samples.length);
  const scale = 1 / 32768;
  for (let i = 0; i < samples.length; i += 1) {
    normalized[i] = samples[i] * scale;
  }
  return normalized;
}

function cloneThresholdSchedule(
  schedule?: AudioAnomalyThresholdSchedule
): AudioAnomalyThresholdSchedule | undefined {
  if (!schedule) {
    return undefined;
  }

  const cloneEntry = (entry?: AudioAnomalyThresholds) =>
    entry
      ? {
          ...entry
        }
      : undefined;

  const cloned: AudioAnomalyThresholdSchedule = {};
  const defaultEntry = cloneEntry(schedule.default);
  if (defaultEntry) {
    cloned.default = defaultEntry;
  }
  const dayEntry = cloneEntry(schedule.day);
  if (dayEntry) {
    cloned.day = dayEntry;
  }
  const nightEntry = cloneEntry(schedule.night);
  if (nightEntry) {
    cloned.night = nightEntry;
  }
  if (typeof schedule.blendMinutes === 'number' && Number.isFinite(schedule.blendMinutes)) {
    cloned.blendMinutes = Math.max(0, schedule.blendMinutes);
  }
  return cloned;
}

function createHanningWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1 || 1)));
  }
  return window;
}

function alignDuration(value: number, step: number) {
  if (!Number.isFinite(step) || step <= 0) {
    return value;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return step;
  }
  const frames = Math.max(1, Math.round(value / step));
  return frames * step;
}

function applyWindow(frame: number[], window: Float32Array): Float32Array {
  const result = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    result[i] = frame[i] * window[i];
  }
  return result;
}

function computeAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let sum = 0;
  for (const value of values) {
    sum += value;
  }

  return sum / values.length;
}

function computeRms(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (const value of values) {
    sumSquares += value * value;
  }

  return Math.sqrt(sumSquares / values.length);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const MINUTES_PER_DAY = 24 * 60;

function normalizeMinutes(value: number) {
  let normalized = value % MINUTES_PER_DAY;
  if (normalized < 0) {
    normalized += MINUTES_PER_DAY;
  }
  return normalized;
}

function hoursToMinutes(hours: number) {
  const whole = Math.trunc(hours);
  const remainder = hours - whole;
  return whole * 60 + remainder * 60;
}

function circularDistance(a: number, b: number) {
  const diff = Math.abs(a - b);
  return Math.min(diff, MINUTES_PER_DAY - diff);
}

function forwardDistance(from: number, to: number) {
  const diff = (to - from) % MINUTES_PER_DAY;
  return diff < 0 ? diff + MINUTES_PER_DAY : diff;
}

export default AudioAnomalyDetector;
