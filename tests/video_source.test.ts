import type { FfmpegCommand } from 'fluent-ffmpeg';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import metrics from '../src/metrics/index.js';
import {
  VideoSource,
  type FatalEvent,
  type RecoverEventMeta,
  type RecoverEvent
} from '../src/video/source.js';

const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZuX6kAAAAASUVORK5CYII=',
  'base64'
);

describe('VideoSource', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    metrics.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    metrics.reset();
  });

  it('emits a frame for each PNG in the stream', async () => {
    const source = new VideoSource({ file: 'noop', framesPerSecond: 1 });
    const stream = new PassThrough();
    const frames: Buffer[] = [];

    source.on('frame', frame => {
      frames.push(frame);
    });

    source.consume(stream);

    stream.write(SAMPLE_PNG.subarray(0, 10));
    stream.write(SAMPLE_PNG.subarray(10));
    stream.write(SAMPLE_PNG);
    stream.end();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(SAMPLE_PNG);
  });

  it('VideoFfmpegWatchdog terminates hung ffmpeg and restarts with watchdog reasons', async () => {
    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      startTimeoutMs: 5,
      watchdogTimeoutMs: 10,
      restartDelayMs: 5,
      forceKillTimeoutMs: 5,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        const index = commands.length - 1;
        if (index === 1) {
          setTimeout(() => {
            command.pushFrame(SAMPLE_PNG);
          }, 1);
        }
        return command as unknown as FfmpegCommand;
      }
    });

    const recoverReasons: string[] = [];
    source.on('recover', info => {
      recoverReasons.push(info.reason);
    });
    source.on('error', () => {});
    source.on('error', () => {
      // Swallow errors emitted for watchdog testing
    });

    source.start();

    try {
      await waitFor(() => commands.length === 1, 100);
      await new Promise(resolve => setTimeout(resolve, 20));
      await waitFor(() => recoverReasons.includes('start-timeout'), 200);

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(commands[0].killedSignals).toContain('SIGTERM');
      expect(commands[0].killedSignals).toContain('SIGKILL');

      await new Promise(resolve => setTimeout(resolve, 20));
      await waitFor(() => commands.length >= 2, 200);

      await new Promise(resolve => setTimeout(resolve, 20));
      await waitFor(() => commands[1].framesPushed >= 1, 200);

      await new Promise(resolve => setTimeout(resolve, 25));
      await waitFor(() => recoverReasons.includes('watchdog-timeout'), 200);
    } finally {
      await source.stop();
    }

    expect(recoverReasons[0]).toBe('start-timeout');
    expect(recoverReasons.filter(reason => reason === 'start-timeout')).not.toHaveLength(0);
    expect(recoverReasons.filter(reason => reason === 'watchdog-timeout')).not.toHaveLength(0);
  });

  it('VideoSourceWatchdogRecovery records jitter metrics and watchdog restart details', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const randomValues = [0.9, 0.1];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:watchdog-retry',
      startTimeoutMs: 0,
      idleTimeoutMs: 0,
      watchdogTimeoutMs: 20,
      restartDelayMs: 40,
      restartMaxDelayMs: 80,
      restartJitterFactor: 0.5,
      forceKillTimeoutMs: 0,
      random: () => (randomValues.shift() ?? 0.5),
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        setTimeout(() => {
          command.emit('start');
        }, 0);
        return command as unknown as FfmpegCommand;
      }
    });

    const recoverEvents: RecoverEvent[] = [];
    source.on('recover', event => recoverEvents.push(event));
    source.on('error', () => {});

    try {
      source.start();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(recoverEvents[0]).toMatchObject({
        reason: 'watchdog-timeout',
        channel: 'video:watchdog-retry',
        errorCode: 'watchdog-timeout'
      });
      expect(commands[0].killedSignals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));

      const firstDelay = recoverEvents[0]?.delayMs ?? 0;
      expect(firstDelay).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(firstDelay);
      await Promise.resolve();

      expect(commands).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      const watchdogRecoveries = recoverEvents.filter(event => event.reason === 'watchdog-timeout');
      expect(watchdogRecoveries).toHaveLength(2);
      expect(commands[1].killedSignals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
    } finally {
      await source.stop();
      vi.useRealTimers();
    }

    const snapshot = metrics.snapshot();
    const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:watchdog-retry'];
    expect(channelStats.watchdogRestarts).toBeGreaterThanOrEqual(2);
    expect(channelStats.watchdogBackoffMs).toBeGreaterThan(0);
    expect(channelStats.lastWatchdogJitterMs).not.toBeNull();
    expect(snapshot.pipelines.ffmpeg.lastRestart?.reason).toBe('watchdog-timeout');
  });

  it('VideoFfmpegGracefulRecovery tracks start-timeout and watchdog restarts with metrics', async () => {
    metrics.reset();

    const commands: FakeCommand[] = [];
    const recoverEvents: Array<{ reason: string; delayMs: number; attempt: number; meta: RecoverEventMeta }>
      = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:test',
      startTimeoutMs: 25,
      watchdogTimeoutMs: 35,
      restartDelayMs: 20,
      restartMaxDelayMs: 20,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 15,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverEvents.push({
        reason: event.reason,
        delayMs: event.delayMs,
        attempt: event.attempt,
        meta: event.meta
      });
    });
    source.on('error', () => {});

    try {
      source.start();
      expect(commands).toHaveLength(1);

      await waitFor(
        () => recoverEvents.some(event => event.reason === 'start-timeout'),
        500
      );
      await waitFor(() => commands[0].killedSignals.includes('SIGTERM'), 500);
      await waitFor(() => commands[0].killedSignals.includes('SIGKILL'), 500);

      await waitFor(() => commands.length >= 2, 500);
      const second = commands[commands.length - 1];
      second.emit('start');

      await waitFor(
        () => recoverEvents.filter(event => event.reason === 'watchdog-timeout').length > 0,
        1000
      );

      await waitFor(() => second.killedSignals.includes('SIGTERM'), 1000);
      await waitFor(() => second.killedSignals.includes('SIGKILL'), 1000);

      const snapshot = metrics.snapshot();
      const lastEvent = recoverEvents[recoverEvents.length - 1];
      expect(lastEvent).toBeDefined();
      expect(lastEvent?.reason).toBe('watchdog-timeout');
      expect(snapshot.pipelines.ffmpeg.lastRestart).toMatchObject({
        reason: lastEvent?.reason ?? '',
        attempt: lastEvent?.attempt ?? 0,
        delayMs: lastEvent?.delayMs ?? 0,
        baseDelayMs: lastEvent?.meta.baseDelayMs ?? 0,
        minDelayMs: lastEvent?.meta.minDelayMs ?? 0,
        maxDelayMs: lastEvent?.meta.maxDelayMs ?? 0,
        jitterMs: lastEvent?.meta.appliedJitterMs ?? 0
      });

      const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:test'];
      expect(channelStats.restarts).toBeGreaterThanOrEqual(2);
      expect(channelStats.byReason['start-timeout']).toBeGreaterThanOrEqual(1);
      expect(channelStats.byReason['watchdog-timeout']).toBeGreaterThanOrEqual(1);
    } finally {
      await source.stop();
    }
  });

  it('VideoSourceCircuitBreaker stops retries and emits fatal event after threshold', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const recoverReasons: string[] = [];
    const fatalEvents: Array<{ reason: string }> = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:circuit',
      startTimeoutMs: 5,
      watchdogTimeoutMs: 5,
      restartDelayMs: 2,
      restartMaxDelayMs: 2,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      circuitBreakerThreshold: 3,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverReasons.push(event.reason);
    });
    source.on('fatal', event => {
      fatalEvents.push(event);
    });
    source.on('error', () => {});

    source.start();

    try {
      expect(commands).toHaveLength(1);

      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(10);
        await Promise.resolve();
      }

      expect(commands).toHaveLength(3);
      expect(fatalEvents).toHaveLength(1);
      expect(fatalEvents[0]).toMatchObject({ reason: 'circuit-breaker' });
      expect(recoverReasons).toHaveLength(2);

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart?.reason).toBe('circuit-breaker');
      const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:circuit'];
      expect(channelStats?.restartHistory.length ?? 0).toBeLessThanOrEqual(
        channelStats?.historyLimit ?? 0
      );
    } finally {
      await source.stop();
      vi.useRealTimers();
    }
  });

  it('VideoSourceCircuitBreakerResets restarts after clearing breaker and closes commands on stop', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const fatalEvents: FatalEvent[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:circuit-reset',
      startTimeoutMs: 0,
      idleTimeoutMs: 0,
      watchdogTimeoutMs: 15,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      circuitBreakerThreshold: 2,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        setTimeout(() => {
          command.emit('start');
        }, 0);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('fatal', event => fatalEvents.push(event));
    source.on('error', () => {});

    try {
      source.start();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(fatalEvents).toHaveLength(0);

      const firstDelay = 10;
      await vi.advanceTimersByTimeAsync(firstDelay);
      await Promise.resolve();

      expect(commands).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(fatalEvents).toHaveLength(1);
      expect(source.isCircuitBroken()).toBe(true);

      const terminated = commands.slice(0, fatalEvents.length + 1);
      expect(
        terminated.every(command => command.killedSignals.includes('SIGKILL'))
      ).toBe(true);

      const wasBroken = source.resetCircuitBreaker();
      expect(wasBroken).toBe(true);
      expect(source.isCircuitBroken()).toBe(false);

      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(commands.length).toBeGreaterThanOrEqual(3);

      await source.stop();
    } finally {
      await source.stop();
      vi.useRealTimers();
    }

    const snapshot = metrics.snapshot();
    const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:circuit-reset'];
    expect(channelStats.byReason['watchdog-timeout']).toBeGreaterThanOrEqual(2);
    expect(snapshot.pipelines.ffmpeg.lastRestart?.reason).toBe('watchdog-timeout');
  });

  it('VideoFfmpegSpawnFallbacks recovers when ffmpeg binary is missing', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:spawn-test',
      startTimeoutMs: 0,
      idleTimeoutMs: 0,
      restartDelayMs: 5,
      restartMaxDelayMs: 5,
      restartJitterFactor: 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        if (commands.length === 1) {
          const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
          command.setPipeError(error);
        } else {
          setTimeout(() => {
            command.emit('start');
            command.pushFrame(SAMPLE_PNG);
          }, 1);
        }
        return command as unknown as FfmpegCommand;
      }
    });

    const recoverEvents: RecoverEvent[] = [];
    source.on('recover', event => recoverEvents.push(event));
    source.on('error', () => {});

    try {
      source.start();

      expect(commands).toHaveLength(1);
      expect(recoverEvents).toHaveLength(1);
      const first = recoverEvents[0];
      expect(first.reason).toBe('ffmpeg-missing');
      expect(first.errorCode).toBe('ENOENT');
      expect(first.exitCode).toBeNull();
      expect(first.channel).toBe('video:spawn-test');

      await vi.runOnlyPendingTimersAsync();
      expect(commands).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(2);
      await Promise.resolve();

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart).toMatchObject({
        reason: 'ffmpeg-missing',
        errorCode: 'ENOENT',
        exitCode: null,
        channel: 'video:spawn-test'
      });
      expect(commands[1].framesPushed).toBeGreaterThanOrEqual(1);
    } finally {
      await source.stop();
      vi.useRealTimers();
    }
  });

  it('VideoFfmpegAuthRetry classifies auth failures and records restart metrics', async () => {
    vi.useFakeTimers();
    metrics.reset();

    const commands: FakeCommand[] = [];
    const recoverReasons: string[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:test',
      restartDelayMs: 50,
      restartMaxDelayMs: 50,
      restartJitterFactor: 0,
      random: () => 0.5,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverReasons.push(event.reason);
    });
    source.on('error', () => {});

    source.start();

    try {
      await waitFor(() => commands.length === 1, 200);
      const first = commands[0];
      first.emit('start');
      first.emit('stderr', 'method DESCRIBE failed: 401 Unauthorized');
      await Promise.resolve();

      expect(recoverReasons).toContain('rtsp-auth-failure');
      expect(first.killedSignals).toContain('SIGTERM');

      first.emitClose(1);
      await vi.runOnlyPendingTimersAsync();
      await waitFor(() => commands.length >= 2, 500);
    } finally {
      await source.stop();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }

    const snapshot = metrics.snapshot();
    expect(
      recoverReasons.filter(reason => reason === 'rtsp-auth-failure').length
    ).toBeGreaterThanOrEqual(1);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:test'].byReason['rtsp-auth-failure']).toBe(1);
  });

  it('VideoFfmpegIdleTimeout restarts idle streams with metrics reason tracking', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:idle-test',
      startTimeoutMs: 0,
      idleTimeoutMs: 15,
      watchdogTimeoutMs: 0,
      restartDelayMs: 5,
      restartMaxDelayMs: 5,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        setTimeout(() => {
          command.emit('start');
          command.pushFrame(SAMPLE_PNG);
        }, 1);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => recoverEvents.push(event));
    source.on('error', () => {});

    try {
      source.start();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(16);
      await Promise.resolve();

      const idleEvent = recoverEvents.find(event => event.reason === 'stream-idle');
      expect(idleEvent).toBeDefined();
      expect(idleEvent?.channel).toBe('video:idle-test');

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.byReason['stream-idle']).toBeGreaterThanOrEqual(1);
    } finally {
      await source.stop();
      vi.useRealTimers();
    }
  });

  it('VideoFfmpegExitBackoff escalates delays when ffmpeg exits unexpectedly', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:exit-test',
      startTimeoutMs: 0,
      idleTimeoutMs: 0,
      restartDelayMs: 5,
      restartMaxDelayMs: 20,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        setTimeout(() => {
          command.emit('start');
          command.pushFrame(SAMPLE_PNG);
          setTimeout(() => {
            command.emitClose(-1, null);
          }, 2);
        }, 1);
        return command as unknown as FfmpegCommand;
      }
    });

    const recoverEvents: RecoverEvent[] = [];
    source.on('recover', event => recoverEvents.push(event));
    source.on('error', () => {});

    try {
      source.start();

      const expectedDelays = [5, 10, 20];
      for (let i = 0; i < expectedDelays.length; i += 1) {
        await vi.advanceTimersByTimeAsync(3);
        expect(recoverEvents.length).toBeGreaterThan(i);
        const event = recoverEvents[i];
        expect(event.reason).toBe('ffmpeg-exit');
        expect(event.exitCode).toBe(-1);
        expect(event.errorCode).toBe(-1);
        expect(event.channel).toBe('video:exit-test');
        expect(event.delayMs).toBe(expectedDelays[i]);
        if (i < expectedDelays.length - 1) {
          await vi.advanceTimersByTimeAsync(expectedDelays[i]);
        }
      }

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart).toMatchObject({
        reason: 'ffmpeg-exit',
        attempt: 3,
        delayMs: 20,
        exitCode: -1,
        errorCode: -1,
        channel: 'video:exit-test'
      });
    } finally {
      await source.stop();
      vi.useRealTimers();
    }
  });

  it('VideoPipelineStopCleansUp clears timers and terminates ffmpeg processes', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      startTimeoutMs: 25,
      restartDelayMs: 50,
      restartMaxDelayMs: 50,
      restartJitterFactor: 0,
      watchdogTimeoutMs: 40,
      forceKillTimeoutMs: 10,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('error', () => {});

    source.start();
    expect(commands).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(26);
    await Promise.resolve();
    expect(commands[0].killedSignals).toContain('SIGTERM');

    await source.stop();

    const internals = source as unknown as {
      startTimer: NodeJS.Timeout | null;
      watchdogTimer: NodeJS.Timeout | null;
      streamIdleTimer: NodeJS.Timeout | null;
      restartTimer: NodeJS.Timeout | null;
      killTimer: NodeJS.Timeout | null;
    };

    expect(internals.startTimer).toBeNull();
    expect(internals.watchdogTimer).toBeNull();
    expect(internals.streamIdleTimer).toBeNull();
    expect(internals.restartTimer).toBeNull();
    expect(internals.killTimer).toBeNull();

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(commands).toHaveLength(1);
    expect(commands[0].killedSignals).toContain('SIGKILL');

    vi.useRealTimers();
  });

  it('VideoSourceRtspErrorClassification restarts on RTSP timeouts and records circuit events', async () => {
    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];
    const fatalEvents: Array<{ reason: string; lastFailure: { reason: string } }> = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:rtsp',
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      startTimeoutMs: 0,
      watchdogTimeoutMs: 0,
      circuitBreakerThreshold: 2,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverEvents.push(event);
    });
    source.on('fatal', event => {
      fatalEvents.push(event);
    });
    source.on('error', () => {});

    try {
      source.start();
      await waitFor(() => commands.length === 1, 500);
      const first = commands[0];
      first.emit('start');
      first.emit('stderr', 'method DESCRIBE failed: Connection timed out');

      await waitFor(
        () => recoverEvents.some(event => event.reason === 'rtsp-timeout'),
        1000
      );

      expect(recoverEvents[0].reason).toBe('rtsp-timeout');
      expect(first.killedSignals).toContain('SIGTERM');
      expect(first.killedSignals).toContain('SIGKILL');

      await waitFor(() => commands.length >= 2, 1000);
      const second = commands[commands.length - 1];
      second.emit('start');
      second.emit('stderr', 'Connection timed out during read operation');

      await waitFor(() => fatalEvents.length === 1, 1000);
      expect(fatalEvents[0].reason).toBe('circuit-breaker');
      expect(fatalEvents[0].lastFailure.reason).toBe('rtsp-timeout');

      const snapshot = metrics.snapshot();
      const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:rtsp'];
      expect(channelStats.byReason['rtsp-timeout']).toBeGreaterThanOrEqual(1);
      expect(channelStats.byReason['circuit-breaker']).toBe(1);
    } finally {
      await source.stop();
    }
  });

  it('VideoFfmpegCorruptedFrameRecovery retries when corrupted frames are detected', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];
    const errors: Error[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:corrupted-test',
      startTimeoutMs: 0,
      idleTimeoutMs: 0,
      watchdogTimeoutMs: 0,
      restartDelayMs: 5,
      restartMaxDelayMs: 5,
      restartJitterFactor: 0,
      maxBufferBytes: 32,
      forceKillTimeoutMs: 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        setTimeout(() => {
          command.emit('start');
          command.stream.write(Buffer.alloc(64, 0));
        }, 1);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => recoverEvents.push(event));
    source.on('error', err => {
      errors.push(err);
    });

    try {
      source.start();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(errors.some(error => error.message.includes('Corrupted frame'))).toBe(true);

      const recovery = recoverEvents.find(event => event.reason === 'corrupted-frame');
      expect(recovery).toBeDefined();
      expect(recovery?.channel).toBe('video:corrupted-test');
      expect(recovery?.reason).toBe('corrupted-frame');

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart?.reason).toBe('corrupted-frame');
      expect(snapshot.pipelines.ffmpeg.byReason['corrupted-frame']).toBeGreaterThanOrEqual(1);
    } finally {
      await source.stop();
      vi.useRealTimers();
    }
  });

  it('removes stream listeners when the stream closes', async () => {
    const source = new VideoSource({ file: 'noop', framesPerSecond: 1 });
    const stream = new PassThrough();

    source.consume(stream);
    expect(stream.listenerCount('data')).toBeGreaterThan(0);

    stream.end();
    stream.destroy();

    await new Promise(resolve => setImmediate(resolve));

    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);

    await source.stop();

    expect(commands.length).toBeGreaterThanOrEqual(3);
  });

  it('VideoSourceRecovery surfaces guard feedback with reason', async () => {
    vi.useRealTimers();
    const sourceInstances: FakeGuardSource[] = [];
    const startMock = vi.fn();
    const stopMock = vi.fn();

    vi.doMock('../src/video/source.js', () => ({
      VideoSource: vi.fn().mockImplementation(() => {
        const instance = new FakeGuardSource(startMock, stopMock);
        sourceInstances.push(instance);
        return instance as unknown as VideoSource;
      })
    }));

    vi.doMock('../src/video/motionDetector.js', () => ({
      default: vi.fn().mockImplementation(() => ({
        handleFrame: vi.fn(),
        updateOptions: vi.fn()
      }))
    }));

    vi.doMock('../src/video/personDetector.js', () => ({
      default: { create: vi.fn().mockResolvedValue({ handleFrame: vi.fn() }) }
    }));

    vi.doMock('../src/video/sampleVideo.js', () => ({
      ensureSampleVideo: vi.fn((input: string) => input)
    }));

    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    const { startGuard } = await import('../src/run-guard.js');

    const runtime = await startGuard({
      logger: { info, warn, error },
      config: {
        video: {
          framesPerSecond: 1,
          cameras: [
            {
              id: 'camera-1',
              channel: 'video:camera-1',
              input: 'test-source'
            }
          ]
        },
        person: {
          modelPath: 'noop',
          score: 0.5
        },
        motion: {
          diffThreshold: 1,
          areaThreshold: 0.01
        }
      }
    });

    expect(sourceInstances).toHaveLength(1);
    const instance = sourceInstances[0];
    instance.emit('recover', {
      reason: 'watchdog-timeout',
      attempt: 2,
      delayMs: 1234,
      meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
    });

    expect(warn).toHaveBeenCalledWith(
      {
        camera: 'camera-1',
        attempt: 2,
        reason: 'watchdog-timeout',
        delayMs: 1234,
        meta: { minDelayMs: 0, maxDelayMs: 0, baseDelayMs: 0, appliedJitterMs: 0 }
      },
      'Video source reconnecting (reason=watchdog-timeout)'
    );

    const pipeline = runtime.pipelines.get('video:camera-1');
    expect(pipeline?.restartStats.last?.meta).toEqual({
      minDelayMs: 0,
      maxDelayMs: 0,
      baseDelayMs: 0,
      appliedJitterMs: 0
    });

    runtime.stop();

    vi.resetModules();
    vi.doUnmock('../src/video/source.js');
    vi.doUnmock('../src/video/motionDetector.js');
    vi.doUnmock('../src/video/personDetector.js');
    vi.doUnmock('../src/video/sampleVideo.js');
  });

  it('VideoSourceBackoffMetrics records restart delays with backoff', async () => {
    vi.useFakeTimers();
    metrics.reset();

    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      startTimeoutMs: 5,
      restartDelayMs: 10,
      restartMaxDelayMs: 40,
      restartJitterFactor: 0,
      watchdogTimeoutMs: 0,
      forceKillTimeoutMs: 0,
      random: () => 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    const delays: number[] = [];
    const attempts: number[] = [];
    const metas: RecoverEventMeta[] = [];
    source.on('recover', info => {
      delays.push(info.delayMs);
      attempts.push(info.attempt);
      metas.push(info.meta);
    });
    source.on('error', () => {});

    source.start();

    await vi.advanceTimersByTimeAsync(6);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(6);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(6);

    expect(delays).toEqual([10, 20, 40]);
    expect(attempts).toEqual([1, 2, 3]);
    expect(metas.map(meta => meta.baseDelayMs)).toEqual([10, 20, 40]);
    expect(metas.map(meta => meta.appliedJitterMs)).toEqual([0, 0, 0]);
    expect(metas.map(meta => meta.minDelayMs)).toEqual([10, 10, 10]);
    expect(metas.map(meta => meta.maxDelayMs)).toEqual([40, 40, 40]);

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.ffmpeg.lastRestart).toMatchObject({
      reason: 'start-timeout',
      attempt: 3,
      delayMs: 40,
      baseDelayMs: 40,
      minDelayMs: 10,
      maxDelayMs: 40,
      jitterMs: 0,
      errorCode: null,
      exitCode: null,
      signal: null,
      channel: null
    });
    expect(snapshot.latencies['pipeline.ffmpeg.restart.delay'].count).toBeGreaterThanOrEqual(3);
    expect(snapshot.histograms['pipeline.ffmpeg.restart.delay']).toMatchObject({
      '<25': 2,
      '25-50': 1
    });

    await source.stop();
    expect(commands.length).toBeGreaterThanOrEqual(3);
  });

  it('VideoSourceStop cancels scheduled restarts and clears timers', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      startTimeoutMs: 5,
      restartDelayMs: 25,
      restartMaxDelayMs: 50,
      restartJitterFactor: 0,
      watchdogTimeoutMs: 0,
      forceKillTimeoutMs: 0,
      random: () => 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('error', () => {});

    source.start();
    expect(commands).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6);
    expect(commands[0].killedSignals).toContain('SIGTERM');

    await source.stop();

    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(commands[0].killedSignals).toContain('SIGKILL');

    vi.useRealTimers();
  });

  it('VideoFfmpegStopDrainsProcess waits for ffmpeg shutdown before resolving', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      restartDelayMs: 0,
      restartMaxDelayMs: 0,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 50,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('error', () => {});
    source.start();

    try {
      await waitFor(() => commands.length === 1, 200);
      const command = commands[0];
      command.emit('start');

      let settled = false;
      const stopPromise = source.stop();
      stopPromise.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
      expect(settled).toBe(false);

      command.emitClose(0, null);
      await stopPromise;

      expect(settled).toBe(true);
      expect(command.listenerCount('close')).toBe(0);
      expect(command.listenerCount('error')).toBe(0);
      expect(command.listenerCount('end')).toBe(0);
      expect(command.listenerCount('stderr')).toBe(0);
      expect(command.stream.listenerCount('data')).toBe(0);
      expect(command.stream.listenerCount('error')).toBe(0);
      expect(command.stream.listenerCount('end')).toBe(0);
      expect(command.stream.listenerCount('close')).toBe(0);
      expect(command.stream.destroyed).toBe(true);

      const internals = source as unknown as { killTimer: NodeJS.Timeout | null };
      expect(internals.killTimer).toBeNull();
    } finally {
      await source.dispose();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it('VideoFfmpegStartStopNoLeak reuses the source without leaking listeners', async () => {
    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      restartDelayMs: 0,
      restartMaxDelayMs: 0,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 25,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    const frames: Buffer[] = [];
    source.on('frame', frame => {
      frames.push(frame);
    });
    source.on('recover', () => {});
    source.on('error', () => {});

    try {
      for (let i = 0; i < 3; i += 1) {
        source.start();
        await waitFor(() => commands.length === i + 1, 500);
        const command = commands[i];
        command.emit('start');
        command.pushFrame(SAMPLE_PNG);

        const stopPromise = source.stop();
        command.emitClose(0, null);
        await stopPromise;

        expect(command.listenerCount('close')).toBe(0);
        expect(command.listenerCount('stderr')).toBe(0);
        expect(command.listenerCount('error')).toBe(0);
        expect(command.stream.listenerCount('data')).toBe(0);
        expect(command.stream.listenerCount('end')).toBe(0);
        expect(command.stream.listenerCount('close')).toBe(0);
        expect(command.stream.destroyed).toBe(true);
      }

      expect(frames.length).toBeGreaterThan(0);
    } finally {
      await source.dispose();
    }

    expect(source.listenerCount('frame')).toBe(0);
    expect(source.listenerCount('recover')).toBe(0);
    expect(source.listenerCount('error')).toBe(0);
  });

  it('VideoRtspAdaptiveBackoff escalates delays and updates metrics before tripping circuit breaker', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];
    const fatalEvents: FatalEvent[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:rtsp-backoff',
      restartDelayMs: 25,
      restartMaxDelayMs: 200,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 5,
      startTimeoutMs: 0,
      watchdogTimeoutMs: 0,
      circuitBreakerThreshold: 4,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverEvents.push(event);
    });
    source.on('fatal', event => {
      fatalEvents.push(event);
    });
    source.on('error', () => {});

    source.start();

    try {
      await waitFor(() => commands.length === 1, 500);
      const first = commands[0];
      first.emit('start');
      first.emit('stderr', 'method DESCRIBE failed: Connection timed out');
      first.emitClose(1);
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      await waitFor(() => commands.length === 2, 500);
      const second = commands[1];
      second.emit('start');
      second.emit('stderr', 'Read timeout after 100 ms');
      second.emitClose(1);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      await waitFor(() => commands.length === 3, 500);
      const third = commands[2];
      third.emit('start');
      third.emit('stderr', 'connection refused');
      third.emitClose(1);
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      await waitFor(() => commands.length === 4, 500);
      const fourth = commands[3];
      fourth.emit('start');
      fourth.emit('stderr', 'network is unreachable');
      fourth.emitClose(1);

      await vi.runOnlyPendingTimersAsync();
      await waitFor(() => fatalEvents.length === 1, 500);

      expect(recoverEvents.map(event => event.delayMs)).toEqual([25, 50, 100]);
      expect(recoverEvents.map(event => event.attempt)).toEqual([1, 2, 3]);
      expect(fatalEvents).toHaveLength(1);
      expect(fatalEvents[0].reason).toBe('circuit-breaker');
      expect(fatalEvents[0].lastFailure.reason).toBe('rtsp-connection-failure');

      const snapshot = metrics.snapshot();
      const channelStats = snapshot.pipelines.ffmpeg.byChannel['video:rtsp-backoff'];
      expect(channelStats.delayHistogram['25-50']).toBeGreaterThanOrEqual(1);
      expect(channelStats.delayHistogram['50-100']).toBeGreaterThanOrEqual(1);
      expect(channelStats.delayHistogram['100-250']).toBeGreaterThanOrEqual(1);
      expect(channelStats.attemptHistogram['1']).toBeGreaterThanOrEqual(1);
      expect(channelStats.attemptHistogram['2']).toBeGreaterThanOrEqual(1);
      expect(channelStats.attemptHistogram['3']).toBeGreaterThanOrEqual(1);
    } finally {
      await source.dispose();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it('VideoFfmpegStopCancelsRecovery clears pending timers when stopped mid-recovery', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      restartDelayMs: 50,
      restartMaxDelayMs: 50,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 10,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverEvents.push(event);
    });
    source.on('error', () => {});

    source.start();

    try {
      await waitFor(() => commands.length === 1, 200);
      const command = commands[0];
      command.emit('start');
      command.emit('stderr', 'Read timeout after 100 ms');
      await Promise.resolve();
      expect(recoverEvents).toHaveLength(1);

      const stopPromise = source.stop();
      command.emitClose(1);
      await stopPromise;

      await vi.runOnlyPendingTimersAsync();

      const internals = source as unknown as {
        restartTimer: NodeJS.Timeout | null;
        killTimer: NodeJS.Timeout | null;
        restartCount: number;
        recovering: boolean;
      };

      expect(internals.restartTimer).toBeNull();
      expect(internals.killTimer).toBeNull();
      expect(internals.restartCount).toBe(0);
      expect(internals.recovering).toBe(false);
      expect(command.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(commands).toHaveLength(1);
    } finally {
      await source.dispose();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it('VideoFfmpegRestartJitterBounds records jitter limits and applied jitter in metrics', async () => {
    vi.useFakeTimers();

    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];
    const randomValues = [0, 1, 0.5];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:jitter',
      restartDelayMs: 30,
      restartMaxDelayMs: 90,
      restartJitterFactor: 0.5,
      forceKillTimeoutMs: 5,
      random: () => (randomValues.length > 0 ? randomValues.shift()! : 0.5),
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverEvents.push(event);
    });
    source.on('error', () => {});

    source.start();

    try {
      await waitFor(() => commands.length === 1, 500);
      const first = commands[0];
      first.emit('start');
      first.emit('stderr', 'Read timeout after 100 ms');
      first.emitClose(1);
      await Promise.resolve();

      expect(recoverEvents).toHaveLength(1);
      const firstEvent = recoverEvents[0];
      expect(firstEvent.meta.minJitterMs).toBe(0);
      expect(firstEvent.meta.maxJitterMs).toBe(15);
      expect(firstEvent.meta.appliedJitterMs).toBeGreaterThanOrEqual(firstEvent.meta.minJitterMs);
      expect(firstEvent.meta.appliedJitterMs).toBeLessThanOrEqual(firstEvent.meta.maxJitterMs);

      await vi.advanceTimersByTimeAsync(firstEvent.delayMs);
      await Promise.resolve();

      await waitFor(() => commands.length === 2, 500);
      const second = commands[1];
      second.emit('start');
      second.emit('stderr', 'Read timeout after 100 ms');
      second.emitClose(1);
      await Promise.resolve();

      expect(recoverEvents).toHaveLength(2);
      const secondEvent = recoverEvents[1];
      expect(secondEvent.meta.minJitterMs).toBe(-30);
      expect(secondEvent.meta.maxJitterMs).toBe(30);
      expect(secondEvent.meta.appliedJitterMs).toBeLessThanOrEqual(secondEvent.meta.maxJitterMs);
      expect(secondEvent.meta.appliedJitterMs).toBeGreaterThanOrEqual(secondEvent.meta.minJitterMs);

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart?.minJitterMs).toBe(secondEvent.meta.minJitterMs);
      expect(snapshot.pipelines.ffmpeg.lastRestart?.maxJitterMs).toBe(secondEvent.meta.maxJitterMs);
      expect(snapshot.pipelines.ffmpeg.lastRestart?.jitterMs).toBe(secondEvent.meta.appliedJitterMs);
    } finally {
      await source.dispose();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it('VideoRestartCounterResetsAfterFrame resets restart attempts after healthy frames', async () => {
    const commands: FakeCommand[] = [];
    const recoverEvents: RecoverEvent[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:restart-reset',
      startTimeoutMs: 0,
      idleTimeoutMs: 0,
      watchdogTimeoutMs: 0,
      restartDelayMs: 10,
      restartMaxDelayMs: 10,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('recover', event => {
      recoverEvents.push(event);
    });
    source.on('error', () => {});

    try {
      source.start();

      await waitFor(() => commands.length === 1, 200);
      const first = commands[0];
      first.emit('start');
      first.pushFrame(SAMPLE_PNG);
      await new Promise(resolve => setTimeout(resolve, 20));

      first.emitClose(1);
      await waitFor(() => recoverEvents.length >= 1, 200);
      expect(recoverEvents[0].attempt).toBe(1);

      await waitFor(() => commands.length === 2, 500);
      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart?.attempt).toBe(1);
    } finally {
      await source.stop();
    }
  });

  it('VideoRtspAuthCircuitBreaker trips after repeated authentication failures', async () => {
    const commands: FakeCommand[] = [];
    const fatalEvents: FatalEvent[] = [];

    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      channel: 'video:rtsp-auth',
      restartDelayMs: 5,
      restartMaxDelayMs: 5,
      restartJitterFactor: 0,
      forceKillTimeoutMs: 0,
      circuitBreakerThreshold: 2,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        queueMicrotask(() => {
          command.emit('start');
          command.emit('stderr', 'RTSP/1.0 401 Unauthorized');
          command.emitClose(1);
        });
        return command as unknown as FfmpegCommand;
      }
    });

    source.on('fatal', event => {
      fatalEvents.push(event);
    });
    source.on('error', () => {});

    try {
      source.start();

      await waitFor(() => commands.length >= 2, 500);
      await waitFor(() => fatalEvents.length === 1, 500);

      expect(source.isCircuitBroken()).toBe(true);
      const fatal = fatalEvents[0];
      expect(fatal).toBeDefined();
      expect(fatal.reason).toBe('circuit-breaker');
      expect(fatal.channel).toBe('video:rtsp-auth');
      expect(fatal.lastFailure.reason).toBe('rtsp-auth-failure');
      expect(fatal.attempts).toBeGreaterThanOrEqual(2);

      const snapshot = metrics.snapshot();
      expect(snapshot.pipelines.ffmpeg.lastRestart?.reason).toBe('circuit-breaker');
      expect(snapshot.pipelines.ffmpeg.lastRestart?.channel).toBe('video:rtsp-auth');
    } finally {
      await source.stop();
    }
  });
});

class FakeCommand extends EventEmitter {
  public readonly killedSignals: NodeJS.Signals[] = [];
  public readonly stream: PassThrough;
  public framesPushed = 0;
  public pipeCalls = 0;
  private pipeError: NodeJS.ErrnoException | null = null;

  constructor() {
    super();
    this.stream = new PassThrough();
  }

  pipe() {
    this.pipeCalls += 1;
    if (this.pipeError) {
      const error = this.pipeError;
      this.pipeError = null;
      throw error;
    }
    return this.stream;
  }

  kill(signal: NodeJS.Signals) {
    this.killedSignals.push(signal);
    return this;
  }

  pushFrame(frame: Buffer) {
    this.framesPushed += 1;
    this.stream.write(frame);
  }

  setPipeError(error: NodeJS.ErrnoException) {
    this.pipeError = error;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('close', code, signal);
  }
}

class FakeGuardSource extends EventEmitter {
  constructor(private readonly startMock: () => void, private readonly stopMock: () => void) {
    super();
  }

  start() {
    this.startMock();
  }

  stop() {
    this.stopMock();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for predicate');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
