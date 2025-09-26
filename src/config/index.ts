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

export type RetentionVacuumConfig = {
  mode?: RetentionVacuumMode;
  target?: string;
  analyze?: boolean;
  reindex?: boolean;
  optimize?: boolean;
  pragmas?: string[];
};

export type RetentionSnapshotMode = 'archive' | 'delete' | 'ignore';

export type RetentionSnapshotConfig = {
  mode?: RetentionSnapshotMode;
  retentionDays?: number;
  maxArchivesPerCamera?: number | Record<string, number>;
  perCameraMax?: Record<string, number>;
};

export type RetentionConfig = {
  enabled?: boolean;
  retentionDays: number;
  intervalMinutes?: number;
  archiveDir: string;
  maxArchivesPerCamera?: number;
  vacuum?: RetentionVacuumMode | RetentionVacuumConfig;
  snapshot?: RetentionSnapshotConfig;
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
  classScoreThresholds?: Record<number, number>;
};

export type MotionTuningConfig = {
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
  areaSmoothing?: number;
  areaInflation?: number;
  areaDeltaThreshold?: number;
  idleRebaselineMs?: number;
};

export type CameraMotionConfig = MotionTuningConfig & {
  diffThreshold?: number;
  areaThreshold?: number;
  minIntervalMs?: number;
};

export type CameraLightConfig = LightTuningConfig & {
  deltaThreshold?: number;
  normalHours?: Array<{ start: number; end: number }>;
};

export type VideoChannelConfig = {
  framesPerSecond?: number;
  ffmpeg?: CameraFfmpegConfig;
  motion?: CameraMotionConfig;
  person?: CameraPersonConfig;
  light?: CameraLightConfig;
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
  circuitBreakerThreshold?: number;
};

export type CameraConfig = {
  id: string;
  channel: string;
  input?: string;
  framesPerSecond?: number;
  person?: CameraPersonConfig;
  motion?: CameraMotionConfig;
  ffmpeg?: CameraFfmpegConfig;
  light?: CameraLightConfig;
};

export type VideoConfig = {
  framesPerSecond: number;
  cameras?: CameraConfig[];
  testFile?: string;
  ffmpeg?: CameraFfmpegConfig;
  channels?: Record<string, VideoChannelConfig>;
};

export type PersonConfig = {
  modelPath: string;
  score: number;
  checkEveryNFrames?: number;
  maxDetections?: number;
  snapshotDir?: string;
  minIntervalMs?: number;
  classIndices?: number[];
  classScoreThresholds?: Record<number, number>;
};

export type MotionConfig = MotionTuningConfig & {
  diffThreshold: number;
  areaThreshold: number;
  minIntervalMs?: number;
};

export type PoseConfig = {
  modelPath: string;
  forecastHorizonMs?: number;
  smoothingWindow?: number;
  minMovement?: number;
  historySize?: number;
};

export type FaceConfig = {
  modelPath: string;
  embeddingSize?: number;
};

export type ObjectsConfig = {
  modelPath: string;
  labels: string[];
  threatLabels?: string[];
  threatThreshold?: number;
  classIndices?: number[];
};

export type LightTuningConfig = {
  smoothingFactor?: number;
  minIntervalMs?: number;
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
  idleRebaselineMs?: number;
};

export type LightConfig = LightTuningConfig & {
  deltaThreshold: number;
  normalHours?: Array<{ start: number; end: number }>;
};

export type AudioMicFallbackCandidate = { format?: string; device: string };

export type AudioAnomalyThresholdConfig = {
  rms?: number;
  centroidJump?: number;
  rmsWindowMs?: number;
  centroidWindowMs?: number;
  minTriggerDurationMs?: number;
};

export type AudioAnomalyThresholdScheduleConfig = {
  default?: AudioAnomalyThresholdConfig;
  day?: AudioAnomalyThresholdConfig;
  night?: AudioAnomalyThresholdConfig;
  blendMinutes?: number;
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
  channel?: string;
  idleTimeoutMs?: number;
  startTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  restartDelayMs?: number;
  restartMaxDelayMs?: number;
  restartJitterFactor?: number;
  forceKillTimeoutMs?: number;
  deviceDiscoveryTimeoutMs?: number;
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
  pose?: PoseConfig;
  face?: FaceConfig;
  objects?: ObjectsConfig;
};

type JsonType = 'object' | 'number' | 'string' | 'boolean' | 'array';

type JsonSchema = {
  type: JsonType | JsonType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
};

const classScoreThresholdSchema: JsonSchema = {
  type: 'object',
  additionalProperties: {
    type: 'number',
    minimum: 0,
    maximum: 1
  }
};

const anomalyThresholdSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rms: { type: 'number', minimum: 0 },
    centroidJump: { type: 'number', minimum: 0 },
    rmsWindowMs: { type: 'number', minimum: 0 },
    centroidWindowMs: { type: 'number', minimum: 0 },
    minTriggerDurationMs: { type: 'number', minimum: 0 }
  }
};

const lightNormalHoursSchema: JsonSchema = {
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
};

const cameraLightConfigSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deltaThreshold: { type: 'number', minimum: 0 },
    normalHours: lightNormalHoursSchema,
    smoothingFactor: { type: 'number', minimum: 0, maximum: 1 },
    minIntervalMs: { type: 'number', minimum: 0 },
    debounceFrames: { type: 'number', minimum: 0 },
    backoffFrames: { type: 'number', minimum: 0 },
    noiseMultiplier: { type: 'number', minimum: 0 },
    noiseSmoothing: { type: 'number', minimum: 0, maximum: 1 }
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
            info: { type: 'number', minimum: 0 },
            warning: { type: 'number', minimum: 0 },
            critical: { type: 'number', minimum: 0 }
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
            vacuum: {
              type: ['string', 'object'],
              enum: ['auto', 'full'],
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['auto', 'full'] },
                target: { type: 'string' },
                analyze: { type: 'boolean' },
                reindex: { type: 'boolean' },
                optimize: { type: 'boolean' },
                pragmas: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            },
            archiveDir: { type: 'string' },
            maxArchivesPerCamera: { type: 'number', minimum: 0 },
            snapshot: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['archive', 'delete', 'ignore'] },
                retentionDays: { type: 'number', minimum: 0 },
                maxArchivesPerCamera: {
                  anyOf: [
                    { type: 'number', minimum: 0 },
                    {
                      type: 'object',
                      additionalProperties: { type: 'number', minimum: 0 }
                    }
                  ]
                },
                perCameraMax: {
                  type: 'object',
                  additionalProperties: { type: 'number', minimum: 0 }
                }
              }
            }
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
            restartJitterFactor: { type: 'number', minimum: 0, maximum: 1 },
            circuitBreakerThreshold: { type: 'number', minimum: 1 }
          }
        },
        channels: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              framesPerSecond: { type: 'number', minimum: 1 },
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
                  restartJitterFactor: { type: 'number', minimum: 0, maximum: 1 },
                  circuitBreakerThreshold: { type: 'number', minimum: 1 }
                }
              },
              motion: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  diffThreshold: { type: 'number', minimum: 0 },
                  areaThreshold: { type: 'number', minimum: 0 },
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
              light: cameraLightConfigSchema,
              person: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  score: { type: 'number' },
                  checkEveryNFrames: { type: 'number', minimum: 1 },
                  maxDetections: { type: 'number', minimum: 1 },
                  snapshotDir: { type: 'string' },
                  minIntervalMs: { type: 'number', minimum: 0 },
                  classIndices: {
                    type: 'array',
                    items: { type: 'number', minimum: 0 }
                  },
                  classScoreThresholds: classScoreThresholdSchema
                }
              }
            }
          }
        },
        cameras: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'channel'],
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
                  minIntervalMs: { type: 'number', minimum: 0 },
                  classIndices: {
                    type: 'array',
                    items: { type: 'number', minimum: 0 }
                  },
                  classScoreThresholds: classScoreThresholdSchema
                }
              },
              motion: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  diffThreshold: { type: 'number', minimum: 0 },
                  areaThreshold: { type: 'number', minimum: 0 },
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
              light: cameraLightConfigSchema,
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
                  restartJitterFactor: { type: 'number', minimum: 0, maximum: 1 },
                  circuitBreakerThreshold: { type: 'number', minimum: 1 }
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
        minIntervalMs: { type: 'number', minimum: 0 },
        classIndices: {
          type: 'array',
          items: { type: 'number', minimum: 0 }
        },
        classScoreThresholds: classScoreThresholdSchema
      }
    },
    motion: {
      type: 'object',
      required: ['diffThreshold', 'areaThreshold'],
      additionalProperties: false,
      properties: {
        diffThreshold: { type: 'number', minimum: 0 },
        areaThreshold: { type: 'number', minimum: 0 },
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
    pose: {
      type: 'object',
      required: ['modelPath'],
      additionalProperties: false,
      properties: {
        modelPath: { type: 'string' },
        forecastHorizonMs: { type: 'number', minimum: 0 },
        smoothingWindow: { type: 'number', minimum: 1 },
        minMovement: { type: 'number', minimum: 0 },
        historySize: { type: 'number', minimum: 1 }
      }
    },
    face: {
      type: 'object',
      required: ['modelPath'],
      additionalProperties: false,
      properties: {
        modelPath: { type: 'string' },
        embeddingSize: { type: 'number', minimum: 1 }
      }
    },
    objects: {
      type: 'object',
      required: ['modelPath', 'labels'],
      additionalProperties: false,
      properties: {
        modelPath: { type: 'string' },
        labels: {
          type: 'array',
          items: { type: 'string' }
        },
        threatLabels: {
          type: 'array',
          items: { type: 'string' }
        },
        threatThreshold: { type: 'number', minimum: 0 },
        classIndices: {
          type: 'array',
          items: { type: 'number', minimum: 0 }
        }
      }
    },
    light: {
      type: 'object',
      required: ['deltaThreshold'],
      additionalProperties: false,
      properties: {
    deltaThreshold: { type: 'number', minimum: 0 },
        normalHours: lightNormalHoursSchema,
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
        channel: { type: 'string' },
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
                night: anomalyThresholdSchema,
                blendMinutes: { type: 'number', minimum: 0 }
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

    const definedProperties = new Set(Object.keys(schema.properties ?? {}));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!definedProperties.has(key)) {
          errors.push(`${pathLabel}.${key} is not allowed`);
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(obj)) {
        if (definedProperties.has(key)) {
          continue;
        }
        errors.push(
          ...validateAgainstSchema(
            schema.additionalProperties,
            obj[key],
            `${pathLabel}.${key}`
          )
        );
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
  validateLogicalConfig(config as GuardianConfig);
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

function validateLogicalConfig(config: GuardianConfig) {
  const messages: string[] = [];

  const channelDefinitions = config.video.channels ? new Set(Object.keys(config.video.channels)) : null;
  const normalizedChannelDefinitions = new Map<string, string>();
  if (config.video.channels) {
    for (const channelId of Object.keys(config.video.channels)) {
      const trimmed = channelId.trim();
      if (!trimmed) {
        messages.push('config.video.channels must not include empty channel identifiers');
        continue;
      }
      const normalized = trimmed.toLowerCase();
      const existing = normalizedChannelDefinitions.get(normalized);
      if (existing && existing !== channelId) {
        messages.push(
          `config.video.channels.${channelId} duplicates channel id "${existing}" ignoring case`
        );
      } else if (!existing) {
        normalizedChannelDefinitions.set(normalized, channelId);
      }
    }
  }
  const cameraIdMap = new Map<string, { index: number; label: string }>();
  const channelMap = new Map<string, { id: string; label: string }>();
  const cameraChannelNormalized = new Map<string, { id: string; label: string }>();
  if (Array.isArray(config.video.cameras)) {
    config.video.cameras.forEach((camera, index) => {
      const label = camera.id ?? `#${index}`;

      if (!camera.channel || camera.channel.trim().length === 0) {
        messages.push(`config.video.cameras[${label}] must specify a non-empty channel`);
      }

      if (channelDefinitions && !channelDefinitions.has(camera.channel)) {
        messages.push(`config.video.cameras[${label}] references undefined channel "${camera.channel}"`);
      }

      if (camera.id) {
        const existing = cameraIdMap.get(camera.id);
        if (existing) {
          messages.push(
            `config.video.cameras[${label}] duplicates camera id "${camera.id}" already used by config.video.cameras[${existing.label}]`
          );
        } else {
          cameraIdMap.set(camera.id, { index, label });
        }
      }

      if (camera.channel) {
        const existingChannel = channelMap.get(camera.channel);
        if (existingChannel) {
          messages.push(
            `config.video.cameras[${label}] reuses channel "${camera.channel}" already assigned to camera "${existingChannel.id}"`
          );
        } else {
          channelMap.set(camera.channel, { id: camera.id ?? label, label });
        }

        const normalized = camera.channel.trim().toLowerCase();
        if (normalized) {
          const existingNormalized = cameraChannelNormalized.get(normalized);
          if (existingNormalized) {
            messages.push(
              `config.video.cameras[${label}] reuses channel "${camera.channel}" already assigned to camera "${existingNormalized.id}" (case-insensitive match)`
            );
          } else {
            cameraChannelNormalized.set(normalized, { id: camera.id ?? label, label });
          }
        }
      }
    });
  }

  if (typeof config.audio?.channel === 'string' && config.audio.channel.trim().length === 0) {
    messages.push('config.audio.channel must be a non-empty string when provided');
  }

  const audioChannelCandidate =
    typeof config.audio?.channel === 'string' && config.audio.channel.trim().length > 0
      ? config.audio.channel.trim()
      : 'audio:microphone';
  if (audioChannelCandidate) {
    const normalized = audioChannelCandidate.toLowerCase();
    const normalizedVideo = normalizedChannelDefinitions.get(normalized);
    if (normalizedVideo) {
      messages.push(
        `config.audio.channel "${audioChannelCandidate}" conflicts with video channel definition "${normalizedVideo}"`
      );
    }
    const cameraConflict = cameraChannelNormalized.get(normalized);
    if (cameraConflict) {
      messages.push(
        `config.audio.channel "${audioChannelCandidate}" conflicts with camera "${cameraConflict.id}" channel`
      );
    }
  }

  const micFallbacks = config.audio?.micFallbacks;
  if (micFallbacks && typeof micFallbacks === 'object') {
    for (const [platform, fallbacks] of Object.entries(micFallbacks)) {
      if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
        messages.push(`config.audio.micFallbacks.${platform} must define at least one device`);
        continue;
      }
      fallbacks.forEach((candidate, index) => {
        const device = typeof candidate.device === 'string' ? candidate.device.trim() : '';
        if (!device) {
          messages.push(`config.audio.micFallbacks.${platform}[${index}].device must be a non-empty string`);
        }
      });
    }
  }

  const suppressionRules = config.events?.suppression?.rules ?? [];
  suppressionRules.forEach((rule, index) => {
    if (typeof rule.suppressForMs !== 'undefined') {
      if (!Number.isInteger(rule.suppressForMs) || rule.suppressForMs <= 0) {
        messages.push(
          `config.events.suppression.rules[${index}].suppressForMs must be a positive integer`
        );
      }
    }
    if (typeof rule.maxEvents !== 'undefined') {
      if (!Number.isInteger(rule.maxEvents) || rule.maxEvents <= 0) {
        messages.push(
          `config.events.suppression.rules[${index}].maxEvents must be a positive integer`
        );
      }
      if (typeof rule.suppressForMs === 'undefined' || rule.suppressForMs <= 0) {
        messages.push(
          `config.events.suppression.rules[${index}].suppressForMs must be set when maxEvents is defined`
        );
      }
    }
    const rateLimit = rule.rateLimit;
    if (!rateLimit) {
      return;
    }
    const { count, perMs } = rateLimit;
    if (!Number.isInteger(count) || count <= 0) {
      messages.push(`config.events.suppression.rules[${index}].rateLimit.count must be a positive integer`);
    }
    if (!Number.isInteger(perMs) || perMs <= 0) {
      messages.push(`config.events.suppression.rules[${index}].rateLimit.perMs must be a positive integer`);
    }
    if (Number.isInteger(count) && Number.isInteger(perMs) && perMs < count) {
      messages.push(
        `config.events.suppression.rules[${index}].rateLimit.perMs must be greater than or equal to count`
      );
    }
    if (typeof rateLimit.cooldownMs !== 'undefined') {
      if (!Number.isInteger(rateLimit.cooldownMs) || rateLimit.cooldownMs < 0) {
        messages.push(
          `config.events.suppression.rules[${index}].rateLimit.cooldownMs must be a non-negative integer`
        );
      }
    }
  });

  if (messages.length > 0) {
    throw new Error(messages.join('; '));
  }
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

  getPath(): string {
    return this.filePath;
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
