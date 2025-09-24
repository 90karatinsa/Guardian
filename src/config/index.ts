import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { EventSuppressionRule } from '../types.js';

export type ThresholdConfig = {
  info: number;
  warning: number;
  critical: number;
};

export type EventSuppressionConfig = {
  rules: EventSuppressionRule[];
};

export type EventsConfig = {
  thresholds: ThresholdConfig;
  suppression?: EventSuppressionConfig;
  retention?: RetentionConfig;
};

export type RetentionVacuumMode = 'auto' | 'full';

export type RetentionConfig = {
  enabled?: boolean;
  retentionDays: number;
  intervalMinutes?: number;
  vacuum?: RetentionVacuumMode;
  archiveDir: string;
};

export type AppConfig = {
  name: string;
};

export type LoggingConfig = {
  level: string;
};

export type DatabaseConfig = {
  path: string;
};

export type CameraPersonConfig = {
  score?: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
};

export type MotionTuningConfig = {
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
  areaSmoothing?: number;
  areaInflation?: number;
  areaDeltaThreshold?: number;
};

export type CameraMotionConfig = MotionTuningConfig & {
  diffThreshold?: number;
  areaThreshold?: number;
  minIntervalMs?: number;
};

export type CameraFfmpegConfig = {
  inputArgs?: string[];
  rtspTransport?: string;
  idleTimeoutMs?: number;
  startTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  forceKillTimeoutMs?: number;
  restartDelayMs?: number;
  restartMaxDelayMs?: number;
  restartJitterFactor?: number;
};

export type CameraConfig = {
  id: string;
  channel?: string;
  input?: string;
  framesPerSecond?: number;
  person?: CameraPersonConfig;
  motion?: CameraMotionConfig;
  ffmpeg?: CameraFfmpegConfig;
};

export type VideoConfig = {
  framesPerSecond: number;
  cameras?: CameraConfig[];
  testFile?: string;
  ffmpeg?: CameraFfmpegConfig;
};

export type PersonConfig = {
  modelPath: string;
  score: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
};

export type MotionConfig = MotionTuningConfig & {
  diffThreshold: number;
  areaThreshold: number;
  minIntervalMs?: number;
};

export type LightTuningConfig = {
  smoothingFactor?: number;
  minIntervalMs?: number;
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
};

export type LightConfig = LightTuningConfig & {
  deltaThreshold: number;
  normalHours?: Array<{ start: number; end: number }>;
};

export type AudioMicFallbackCandidate = { format?: string; device: string };

export type AudioAnomalyThresholdConfig = {
  rms?: number;
  centroidJump?: number;
};

export type AudioAnomalyThresholdScheduleConfig = {
  default?: AudioAnomalyThresholdConfig;
  day?: AudioAnomalyThresholdConfig;
  night?: AudioAnomalyThresholdConfig;
};

export type AudioAnomalyNightHoursConfig = { start: number; end: number };

export type AudioAnomalyConfig = {
  sampleRate?: number;
  frameDurationMs?: number;
  hopDurationMs?: number;
  frameSize?: number;
  hopSize?: number;
  rmsThreshold?: number;
  centroidJumpThreshold?: number;
  minIntervalMs?: number;
  minTriggerDurationMs?: number;
  rmsWindowMs?: number;
  centroidWindowMs?: number;
  thresholds?: AudioAnomalyThresholdScheduleConfig;
  nightHours?: AudioAnomalyNightHoursConfig;
};

export type AudioConfig = {
  idleTimeoutMs?: number;
  startTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  restartDelayMs?: number;
  restartMaxDelayMs?: number;
  restartJitterFactor?: number;
  forceKillTimeoutMs?: number;
  micFallbacks?: Record<string, AudioMicFallbackCandidate[]>;
  anomaly?: AudioAnomalyConfig;
};

export type GuardianConfig = {
  app: AppConfig;
  logging: LoggingConfig;
  database: DatabaseConfig;
  events: EventsConfig;
  video: VideoConfig;
  person: PersonConfig;
  motion: MotionConfig;
  light?: LightConfig;
  audio?: AudioConfig;
};

type JsonType = 'object' | 'number' | 'string' | 'boolean' | 'array';

type JsonSchema = {
  type: JsonType | JsonType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: (string | number | boolean)[];
  minimum?: number;
};

const anomalyThresholdSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rms: { type: 'number', minimum: 0 },
    centroidJump: { type: 'number', minimum: 0 }
  }
};

const guardianConfigSchema: JsonSchema = {
  type: 'object',
  required: ['app', 'logging', 'database', 'events', 'video', 'person', 'motion'],
  additionalProperties: true,
  properties: {
    app: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' }
      }
    },
    logging: {
      type: 'object',
      required: ['level'],
      additionalProperties: false,
      properties: {
        level: { type: 'string' }
      }
    },
    database: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string' }
      }
    },
    events: {
      type: 'object',
      required: ['thresholds'],
      additionalProperties: false,
      properties: {
        thresholds: {
          type: 'object',
          required: ['info', 'warning', 'critical'],
          additionalProperties: false,
          properties: {
            info: { type: 'number' },
            warning: { type: 'number' },
            critical: { type: 'number' }
          }
        },
        retention: {
          type: 'object',
          required: ['retentionDays', 'archiveDir'],
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            retentionDays: { type: 'number', minimum: 0 },
            intervalMinutes: { type: 'number', minimum: 1 },
            vacuum: { type: 'string', enum: ['auto', 'full'] },
            archiveDir: { type: 'string' }
          }
        },
        suppression: {
          type: 'object',
          required: ['rules'],
          additionalProperties: false,
          properties: {
            rules: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'reason'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  reason: { type: 'string' },
                  detector: {
                    type: ['string', 'array'],
                    items: { type: 'string' }
                  },
                  source: {
                    type: ['string', 'array'],
                    items: { type: 'string' }
                  },
                  severity: {
                    type: ['string', 'array'],
                    enum: ['info', 'warning', 'critical'],
                    items: {
                      type: 'string',
                      enum: ['info', 'warning', 'critical']
                    }
                  },
                  channel: {
                    type: ['string', 'array'],
                    items: { type: 'string' }
                  },
                  suppressForMs: { type: 'number', minimum: 0 },
                  rateLimit: {
                    type: 'object',
                    required: ['count', 'perMs'],
                    additionalProperties: false,
                    properties: {
                      count: { type: 'number', minimum: 1 },
                      perMs: { type: 'number', minimum: 1 }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    video: {
      type: 'object',
      required: ['framesPerSecond'],
      additionalProperties: false,
      properties: {
        framesPerSecond: { type: 'number', minimum: 1 },
        testFile: { type: 'string' },
        ffmpeg: {
          type: 'object',
          additionalProperties: false,
          properties: {
            inputArgs: {
              type: 'array',
              items: { type: 'string' }
            },
            rtspTransport: { type: 'string' },
            idleTimeoutMs: { type: 'number', minimum: 0 },
            startTimeoutMs: { type: 'number', minimum: 0 },
            watchdogTimeoutMs: { type: 'number', minimum: 0 },
            forceKillTimeoutMs: { type: 'number', minimum: 0 },
            restartDelayMs: { type: 'number', minimum: 0 },
            restartMaxDelayMs: { type: 'number', minimum: 0 },
            restartJitterFactor: { type: 'number', minimum: 0, maximum: 1 }
          }
        },
        cameras: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              channel: { type: 'string' },
              input: { type: 'string' },
              framesPerSecond: { type: 'number', minimum: 1 },
              person: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  score: { type: 'number' },
                  checkEveryNFrames: { type: 'number', minimum: 1 },
                  maxDetections: { type: 'number', minimum: 1 },
                  snapshotDir: { type: 'string' },
                  minIntervalMs: { type: 'number', minimum: 0 }
                }
              },
              motion: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  diffThreshold: { type: 'number' },
                  areaThreshold: { type: 'number' },
                  minIntervalMs: { type: 'number', minimum: 0 },
                  debounceFrames: { type: 'number', minimum: 0 },
                  backoffFrames: { type: 'number', minimum: 0 },
                  noiseMultiplier: { type: 'number', minimum: 0 },
                  noiseSmoothing: { type: 'number', minimum: 0, maximum: 1 },
                  areaSmoothing: { type: 'number', minimum: 0, maximum: 1 },
                  areaInflation: { type: 'number', minimum: 0 },
                  areaDeltaThreshold: { type: 'number', minimum: 0 }
                }
              },
              ffmpeg: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  inputArgs: {
                    type: 'array',
                    items: { type: 'string' }
                  },
                  rtspTransport: { type: 'string' },
                  idleTimeoutMs: { type: 'number', minimum: 0 },
                  startTimeoutMs: { type: 'number', minimum: 0 },
                  watchdogTimeoutMs: { type: 'number', minimum: 0 },
                  forceKillTimeoutMs: { type: 'number', minimum: 0 },
                  restartDelayMs: { type: 'number', minimum: 0 },
                  restartMaxDelayMs: { type: 'number', minimum: 0 },
                  restartJitterFactor: { type: 'number', minimum: 0, maximum: 1 }
                }
              }
            }
          }
        }
      }
    },
    person: {
      type: 'object',
      required: ['modelPath', 'score'],
      additionalProperties: false,
      properties: {
        modelPath: { type: 'string' },
        score: { type: 'number' },
        checkEveryNFrames: { type: 'number', minimum: 1 },
        maxDetections: { type: 'number', minimum: 1 },
        snapshotDir: { type: 'string' },
        minIntervalMs: { type: 'number', minimum: 0 }
      }
    },
    motion: {
      type: 'object',
      required: ['diffThreshold', 'areaThreshold'],
      additionalProperties: false,
      properties: {
        diffThreshold: { type: 'number' },
        areaThreshold: { type: 'number' },
        minIntervalMs: { type: 'number', minimum: 0 },
        debounceFrames: { type: 'number', minimum: 0 },
        backoffFrames: { type: 'number', minimum: 0 },
        noiseMultiplier: { type: 'number', minimum: 0 },
        noiseSmoothing: { type: 'number', minimum: 0, maximum: 1 },
        areaSmoothing: { type: 'number', minimum: 0, maximum: 1 },
        areaInflation: { type: 'number', minimum: 0 },
        areaDeltaThreshold: { type: 'number', minimum: 0 }
      }
    },
    light: {
      type: 'object',
      required: ['deltaThreshold'],
      additionalProperties: false,
      properties: {
        deltaThreshold: { type: 'number' },
        normalHours: {
          type: 'array',
          items: {
            type: 'object',
            required: ['start', 'end'],
            additionalProperties: false,
            properties: {
              start: { type: 'number', minimum: 0, maximum: 24 },
              end: { type: 'number', minimum: 0, maximum: 24 }
            }
          }
        },
        smoothingFactor: { type: 'number', minimum: 0, maximum: 1 },
        minIntervalMs: { type: 'number', minimum: 0 },
        debounceFrames: { type: 'number', minimum: 0 },
        backoffFrames: { type: 'number', minimum: 0 },
        noiseMultiplier: { type: 'number', minimum: 0 },
        noiseSmoothing: { type: 'number', minimum: 0, maximum: 1 }
      }
    },
    audio: {
      type: 'object',
      additionalProperties: false,
      properties: {
        idleTimeoutMs: { type: 'number', minimum: 0 },
        startTimeoutMs: { type: 'number', minimum: 0 },
        watchdogTimeoutMs: { type: 'number', minimum: 0 },
        restartDelayMs: { type: 'number', minimum: 0 },
        restartMaxDelayMs: { type: 'number', minimum: 0 },
        restartJitterFactor: { type: 'number', minimum: 0, maximum: 1 },
        forceKillTimeoutMs: { type: 'number', minimum: 0 },
        micFallbacks: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              required: ['device'],
              additionalProperties: false,
              properties: {
                format: { type: 'string' },
                device: { type: 'string' }
              }
            }
          }
        },
        anomaly: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sampleRate: { type: 'number', minimum: 1 },
            frameDurationMs: { type: 'number', minimum: 0 },
            hopDurationMs: { type: 'number', minimum: 0 },
            frameSize: { type: 'number', minimum: 1 },
            hopSize: { type: 'number', minimum: 1 },
            rmsThreshold: { type: 'number', minimum: 0 },
            centroidJumpThreshold: { type: 'number', minimum: 0 },
            minIntervalMs: { type: 'number', minimum: 0 },
            minTriggerDurationMs: { type: 'number', minimum: 0 },
            rmsWindowMs: { type: 'number', minimum: 0 },
            centroidWindowMs: { type: 'number', minimum: 0 },
            thresholds: {
              type: 'object',
              additionalProperties: false,
              properties: {
                default: anomalyThresholdSchema,
                day: anomalyThresholdSchema,
                night: anomalyThresholdSchema
              }
            },
            nightHours: {
              type: 'object',
              required: ['start', 'end'],
              additionalProperties: false,
              properties: {
                start: { type: 'number', minimum: 0, maximum: 24 },
                end: { type: 'number', minimum: 0, maximum: 24 }
              }
            }
          }
        }
      }
    }
  }
};

function validateAgainstSchema(schema: JsonSchema, value: unknown, pathLabel: string): string[] {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const results = types.map(type => validateAgainstSchemaForType(type, schema, value, pathLabel));

  if (results.some(errors => errors.length === 0)) {
    return [];
  }

  return results[0] ?? [];
}

function validateAgainstSchemaForType(
  type: JsonType,
  schema: JsonSchema,
  value: unknown,
  pathLabel: string
): string[] {
  const errors: string[] = [];

  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${pathLabel} must be an object`);
      return errors;
    }

    const obj = value as Record<string, unknown>;
    const required = schema.required ?? [];

    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`${pathLabel}.${key} is required`);
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push(`${pathLabel}.${key} is not allowed`);
        }
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (!(key in obj)) {
        continue;
      }
      errors.push(...validateAgainstSchema(childSchema, obj[key], `${pathLabel}.${key}`));
    }

    return errors;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${pathLabel} must be an array`);
      return errors;
    }

    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(schema.items as JsonSchema, item, `${pathLabel}[${index}]`));
      });
    }

    return errors;
  }

  if (type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`${pathLabel} must be a number`);
      return errors;
    }

    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${pathLabel} must be >= ${schema.minimum}`);
    }

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${pathLabel} must be one of ${schema.enum.join(', ')}`);
    }

    return errors;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${pathLabel} must be a string`);
      return errors;
    }

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${pathLabel} must be one of ${schema.enum.join(', ')}`);
    }

    return errors;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`${pathLabel} must be a boolean`);
    }
    return errors;
  }

  return errors;
}

export function validateConfig(config: unknown): asserts config is GuardianConfig {
  const errors = validateAgainstSchema(guardianConfigSchema, config, 'config');
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

export function parseConfig(contents: string): GuardianConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse configuration: ${message}`);
  }

  validateConfig(parsed);
  return parsed;
}

export function loadConfigFromFile(filePath: string): GuardianConfig {
  const resolvedPath = path.resolve(filePath);
  const contents = fs.readFileSync(resolvedPath, 'utf-8');
  return parseConfig(contents);
}

export type ConfigReloadEvent = {
  previous: GuardianConfig;
  next: GuardianConfig;
};

export class ConfigManager extends EventEmitter {
  private currentConfig: GuardianConfig;
  private readonly filePath: string;
  private watcher: fs.FSWatcher | null = null;
  private watchRefs = 0;
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastGoodRaw: string;
  private restoring = false;
  private restoreTimer: NodeJS.Timeout | null = null;

  constructor(filePath = path.resolve(process.cwd(), 'config/default.json')) {
    super();
    this.filePath = path.resolve(filePath);
    const { config, raw } = this.loadFromDisk();
    this.currentConfig = config;
    this.lastGoodRaw = raw;
  }

  getConfig(): GuardianConfig {
    return this.currentConfig;
  }

  reload(): GuardianConfig {
    const { config: next, raw } = this.loadFromDisk();
    const previous = this.currentConfig;
    this.currentConfig = next;
    this.lastGoodRaw = raw;
    this.emit('reload', { previous, next } satisfies ConfigReloadEvent);
    return next;
  }

  watch(): () => void {
    if (!this.watcher) {
      this.watcher = this.createWatcher();
    }

    this.watchRefs += 1;

    return () => {
      this.watchRefs = Math.max(0, this.watchRefs - 1);
      if (this.watchRefs === 0) {
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer);
          this.reloadTimer = null;
        }
        this.closeWatcher();
      }
    };
  }

  private scheduleReload() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      try {
        this.reload();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        this.restorePreviousConfig();
      }
    }, 100);
  }

  private recreateWatcher() {
    this.closeWatcher();
    this.watcher = this.createWatcher();
  }

  private closeWatcher() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.restoring = false;
  }

  private createWatcher() {
    return fs.watch(this.filePath, { persistent: false }, eventType => {
      if (this.restoring) {
        return;
      }

      if (eventType === 'rename') {
        this.recreateWatcher();
      }
      this.scheduleReload();
    });
  }

  private loadFromDisk(): { config: GuardianConfig; raw: string } {
    const contents = fs.readFileSync(this.filePath, 'utf-8');
    const config = parseConfig(contents);
    return { config, raw: contents };
  }

  private restorePreviousConfig() {
    if (!this.lastGoodRaw) {
      return;
    }

    this.restoring = true;
    try {
      fs.writeFileSync(this.filePath, this.lastGoodRaw, 'utf-8');
    } catch (error) {
      if (this.listenerCount('error') > 0) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit('error', err);
      }
    } finally {
      if (this.restoreTimer) {
        clearTimeout(this.restoreTimer);
      }
      this.restoreTimer = setTimeout(() => {
        this.restoring = false;
        this.restoreTimer = null;
      }, 200);
    }
  }
}

const defaultManager = new ConfigManager();

export default defaultManager;
export { guardianConfigSchema };
