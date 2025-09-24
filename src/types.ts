export type EventSeverity = 'info' | 'warning' | 'critical';

export interface EventPayload {
  ts?: number | Date;
  source: string;
  detector: string;
  severity: EventSeverity;
  message: string;
  meta?: Record<string, unknown>;
}

export interface EventRecord {
  ts: number;
  source: string;
  detector: string;
  severity: EventSeverity;
  message: string;
  meta: Record<string, unknown> | undefined;
}

export interface RateLimitConfig {
  count: number;
  perMs: number;
}

export interface EventSuppressionRule {
  detector?: string | string[];
  source?: string | string[];
  severity?: EventSeverity | EventSeverity[];
  suppressForMs?: number;
  rateLimit?: RateLimitConfig;
  reason: string;
}
