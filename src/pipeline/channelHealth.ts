export type RestartSeverityLevel = 'none' | 'warning' | 'critical';

export type RestartSeverityThreshold = {
  watchdogRestarts: number;
  watchdogBackoffMs: number;
};

export type RestartSeverityThresholds = {
  warning: RestartSeverityThreshold;
  critical: RestartSeverityThreshold;
};

export type RestartSeverityEvaluation = {
  severity: RestartSeverityLevel;
  triggeredBy: 'watchdog-restarts' | 'watchdog-backoff' | null;
  threshold: number | null;
  actual: number;
};

export const DEFAULT_RESTART_SEVERITY_THRESHOLDS: RestartSeverityThresholds = {
  warning: {
    watchdogRestarts: 3,
    watchdogBackoffMs: 60_000
  },
  critical: {
    watchdogRestarts: 6,
    watchdogBackoffMs: 180_000
  }
};

export function evaluateRestartSeverity(
  stats: { watchdogRestarts: number; watchdogBackoffMs: number },
  thresholds: RestartSeverityThresholds = DEFAULT_RESTART_SEVERITY_THRESHOLDS
): RestartSeverityEvaluation {
  const restarts = stats.watchdogRestarts;
  const backoffMs = stats.watchdogBackoffMs;

  if (restarts >= thresholds.critical.watchdogRestarts) {
    return {
      severity: 'critical',
      triggeredBy: 'watchdog-restarts',
      threshold: thresholds.critical.watchdogRestarts,
      actual: restarts
    };
  }

  if (backoffMs >= thresholds.critical.watchdogBackoffMs) {
    return {
      severity: 'critical',
      triggeredBy: 'watchdog-backoff',
      threshold: thresholds.critical.watchdogBackoffMs,
      actual: backoffMs
    };
  }

  if (restarts >= thresholds.warning.watchdogRestarts) {
    return {
      severity: 'warning',
      triggeredBy: 'watchdog-restarts',
      threshold: thresholds.warning.watchdogRestarts,
      actual: restarts
    };
  }

  if (backoffMs >= thresholds.warning.watchdogBackoffMs) {
    return {
      severity: 'warning',
      triggeredBy: 'watchdog-backoff',
      threshold: thresholds.warning.watchdogBackoffMs,
      actual: backoffMs
    };
  }

  return { severity: 'none', triggeredBy: null, threshold: null, actual: backoffMs };
}

export function formatRestartSeverityReason(
  evaluation: RestartSeverityEvaluation
): string | null {
  if (evaluation.severity === 'none' || !evaluation.triggeredBy || evaluation.threshold === null) {
    return null;
  }

  if (evaluation.triggeredBy === 'watchdog-restarts') {
    return `watchdog restarts ${evaluation.actual} \u2265 ${evaluation.threshold}`;
  }

  return `watchdog backoff ${evaluation.actual}ms \u2265 ${evaluation.threshold}ms`;
}
