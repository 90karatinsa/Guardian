import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export type ThresholdConfig = {
  info: number;
  warning: number;
  critical: number;
};

export type EventsConfig = {
  thresholds: ThresholdConfig;
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

export type CameraConfig = {
  id: string;
  channel?: string;
  input?: string;
  framesPerSecond?: number;
  person?: CameraPersonConfig;
};

export type VideoConfig = {
  framesPerSecond: number;
  cameras?: CameraConfig[];
  testFile?: string;
};

export type PersonConfig = {
  modelPath: string;
  score: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
};

export type MotionConfig = {
  diffThreshold: number;
  areaThreshold: number;
  minIntervalMs?: number;
};

export type GuardianConfig = {
  app: AppConfig;
  logging: LoggingConfig;
  database: DatabaseConfig;
  events: EventsConfig;
  video: VideoConfig;
  person: PersonConfig;
  motion: MotionConfig;
};

type JsonSchema = {
  type: 'object' | 'number' | 'string' | 'boolean' | 'array';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: (string | number | boolean)[];
  minimum?: number;
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
        minIntervalMs: { type: 'number', minimum: 0 }
      }
    }
  }
};

function validateAgainstSchema(schema: JsonSchema, value: unknown, pathLabel: string): string[] {
  const errors: string[] = [];

  if (schema.type === 'object') {
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

  if (schema.type === 'array') {
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

  if (schema.type === 'number') {
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

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${pathLabel} must be a string`);
      return errors;
    }

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${pathLabel} must be one of ${schema.enum.join(', ')}`);
    }

    return errors;
  }

  if (schema.type === 'boolean') {
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

export function loadConfigFromFile(filePath: string): GuardianConfig {
  const resolvedPath = path.resolve(filePath);
  const contents = fs.readFileSync(resolvedPath, 'utf-8');

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

  constructor(filePath = path.resolve(process.cwd(), 'config/default.json')) {
    super();
    this.filePath = path.resolve(filePath);
    this.currentConfig = loadConfigFromFile(this.filePath);
  }

  getConfig(): GuardianConfig {
    return this.currentConfig;
  }

  reload(): GuardianConfig {
    const next = loadConfigFromFile(this.filePath);
    const previous = this.currentConfig;
    this.currentConfig = next;
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
  }

  private createWatcher() {
    return fs.watch(this.filePath, { persistent: false }, eventType => {
      if (eventType === 'rename') {
        this.recreateWatcher();
      }
      this.scheduleReload();
    });
  }
}

const defaultManager = new ConfigManager();

export default defaultManager;
export { guardianConfigSchema };
