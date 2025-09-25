import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import metrics from '../src/metrics/index.js';
import { registerShutdownHook, registerHealthIndicator, resetAppLifecycle } from '../src/app.js';

const startGuardMock = vi.fn();
vi.mock('../src/run-guard.js', () => ({
  startGuard: startGuardMock
}));

import { runCli, buildHealthPayload } from '../src/cli.js';

type TestIo = {
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  stdout: () => string;
  stderr: () => string;
};

function createTestIo(): TestIo {
  let stdout = '';
  let stderr = '';

  const makeWritable = (setter: (value: string) => void) =>
    new Writable({
      write(chunk, _enc, callback) {
        setter(typeof chunk === 'string' ? chunk : chunk.toString());
        callback();
      }
    });

  return {
    io: {
      stdout: makeWritable(value => {
        stdout += value;
      }),
      stderr: makeWritable(value => {
        stderr += value;
      })
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

beforeEach(async () => {
  startGuardMock.mockReset();
  metrics.reset();
  resetAppLifecycle();
  const cleanupIo = createTestIo();
  await runCli(['stop'], cleanupIo.io);
});

afterEach(async () => {
  const cleanupIo = createTestIo();
  await runCli(['stop'], cleanupIo.io);
});

describe('GuardianCliHealthcheck', () => {
  it('HealthcheckMetricsSnapshot includes runtime fields and degraded status', async () => {
    const capture = createTestIo();
    const flagCode = await runCli(['--health'], capture.io);
    const flagPayload = JSON.parse(capture.stdout().trim());

    expect(flagCode).toBe(0);
    expect(flagPayload.status).toBe('ok');
    expect(flagPayload.metrics.pipelines.ffmpeg).toBeDefined();
    expect(flagPayload.metrics.pipelines.audio).toBeDefined();
    expect(flagPayload.metrics.pipelines.ffmpeg.byChannel).toBeDefined();
    expect(flagPayload.metrics.pipelines.audio.byChannel).toBeDefined();
    expect(flagPayload.runtime.pipelines.videoChannels).toBeTypeOf('number');
    expect(flagPayload.runtime.pipelines.audioChannels).toBeTypeOf('number');
    expect(flagPayload.runtime.pipelines.videoRestarts).toBe(0);
    expect(flagPayload.runtime.pipelines.audioRestarts).toBe(0);

    metrics.reset();
    metrics.incrementLogLevel('error', { message: 'detector failure' });
    const aliasCapture = createTestIo();
    const aliasCode = await runCli(['health'], aliasCapture.io);
    const aliasPayload = JSON.parse(aliasCapture.stdout().trim());

    expect(aliasCode).toBe(1);
    expect(aliasPayload.status).toBe('degraded');
  });

  it('CliDaemonLifecycle summarizes status output with restart counters', async () => {
    metrics.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    metrics.recordPipelineRestart('audio', 'spawn-error');
    const capture = createTestIo();
    const code = await runCli(['status'], capture.io);

    expect(code).toBe(0);
    expect(capture.stdout()).toContain('Restarts - video: 1, audio: 1');
  });
});

describe('GuardianCliShutdown', () => {
  it('CliDaemonLifecycle stops the running guard runtime and reports graceful shutdown', async () => {
    const stopSpy = vi.fn();
    startGuardMock.mockResolvedValue({ stop: stopSpy });

    const startIo = createTestIo();
    const startPromise = runCli(['start'], startIo.io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const stopIo = createTestIo();
    const stopCode = await runCli(['stop'], stopIo.io);

    expect(stopCode).toBe(0);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopIo.stdout()).toContain('Guardian daemon stopped (status: ok)');
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliGracefulShutdown runs registered hooks and updates health payload', async () => {
    const stopSpy = vi.fn();
    const hook = vi.fn();
    registerShutdownHook('test-hook', hook);
    registerHealthIndicator('runtime', async () => ({
      status: 'ok',
      details: { ready: true }
    }));
    startGuardMock.mockResolvedValue({ stop: stopSpy });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const stopIo = createTestIo();
    const stopCode = await runCli(['stop'], stopIo.io);

    expect(stopCode).toBe(0);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ reason: 'cli-stop', signal: undefined });

    const health = await buildHealthPayload();
    expect(health.state).toBe('stopped');
    const runtimeCheck = health.checks.find(check => check.name === 'runtime');
    expect(runtimeCheck?.status).toBe('ok');
    expect(runtimeCheck?.details).toEqual({ ready: true });
    expect(stopIo.stdout()).toContain('Guardian daemon stopped (status: ok)');

    await expect(startPromise).resolves.toBe(0);
  });
});
