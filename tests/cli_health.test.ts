import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import metrics from '../src/metrics/index.js';

const startGuardMock = vi.fn();
vi.mock('../src/run-guard.js', () => ({
  startGuard: startGuardMock
}));

import { runCli } from '../src/cli.js';

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
  const cleanupIo = createTestIo();
  await runCli(['stop'], cleanupIo.io);
});

afterEach(async () => {
  const cleanupIo = createTestIo();
  await runCli(['stop'], cleanupIo.io);
});

describe('GuardianCliHealthcheck', () => {
  it('returns JSON payload for --health and embeds pipeline metrics', async () => {
    const capture = createTestIo();
    const code = await runCli(['--health'], capture.io);
    const payload = JSON.parse(capture.stdout().trim());

    expect(code).toBe(0);
    expect(payload.status).toBe('ok');
    expect(payload.metrics.pipelines.ffmpeg).toBeDefined();
    expect(payload.metrics.pipelines.audio).toBeDefined();
  });

  it('propagates degraded exit code when error logs are present', async () => {
    metrics.incrementLogLevel('error', { message: 'detector failure' });
    const capture = createTestIo();
    const code = await runCli(['--health'], capture.io);

    expect(code).toBe(1);
    const payload = JSON.parse(capture.stdout().trim());
    expect(payload.status).toBe('degraded');
  });

  it('summarizes status output with restart counters', async () => {
    metrics.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    metrics.recordPipelineRestart('audio', 'spawn-error');
    const capture = createTestIo();
    const code = await runCli(['status'], capture.io);

    expect(code).toBe(0);
    expect(capture.stdout()).toContain('Restarts - video: 1, audio: 1');
  });
});

describe('GuardianCliShutdown', () => {
  it('stops the running guard runtime and reports graceful shutdown', async () => {
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
    expect(stopIo.stdout()).toContain('Guardian daemon stopped');
    await expect(startPromise).resolves.toBe(0);
  });
});
