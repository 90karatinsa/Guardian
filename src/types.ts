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
