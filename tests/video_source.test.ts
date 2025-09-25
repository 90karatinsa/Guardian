import type { FfmpegCommand } from 'fluent-ffmpeg';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import metrics from '../src/metrics/index.js';
import { VideoSource, type RecoverEventMeta } from '../src/video/source.js';

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
      source.stop();
    }

    expect(recoverReasons[0]).toBe('start-timeout');
    expect(recoverReasons.filter(reason => reason === 'start-timeout')).not.toHaveLength(0);
    expect(recoverReasons.filter(reason => reason === 'watchdog-timeout')).not.toHaveLength(0);
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
      source.stop();
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

    source.stop();

    const internals = source as unknown as {
      startTimer: NodeJS.Timeout | null;
      watchdogTimer: NodeJS.Timeout | null;
      restartTimer: NodeJS.Timeout | null;
      killTimer: NodeJS.Timeout | null;
    };

    expect(internals.startTimer).toBeNull();
    expect(internals.watchdogTimer).toBeNull();
    expect(internals.restartTimer).toBeNull();
    expect(internals.killTimer).toBeNull();

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(commands).toHaveLength(1);
    expect(commands[0].killedSignals).toContain('SIGKILL');

    vi.useRealTimers();
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

    source.stop();

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
    expect(snapshot.pipelines.ffmpeg.lastRestart).toEqual({
      reason: 'start-timeout',
      attempt: 3,
      delayMs: 40,
      baseDelayMs: 40,
      minDelayMs: 10,
      maxDelayMs: 40,
      jitterMs: 0
    });
    expect(snapshot.latencies['pipeline.ffmpeg.restart.delay'].count).toBeGreaterThanOrEqual(3);
    expect(snapshot.histograms['pipeline.ffmpeg.restart.delay']).toMatchObject({
      '<25': 2,
      '25-50': 1
    });

    source.stop();
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

    source.stop();

    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(commands[0].killedSignals).toContain('SIGKILL');

    vi.useRealTimers();
  });
});

class FakeCommand extends EventEmitter {
  public readonly killedSignals: NodeJS.Signals[] = [];
  public readonly stream: PassThrough;
  public framesPushed = 0;

  constructor() {
    super();
    this.stream = new PassThrough();
  }

  pipe() {
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
