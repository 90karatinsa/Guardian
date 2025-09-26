import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { getLogLevel } from '../src/logger.js';
import metrics from '../src/metrics/index.js';

function readReadme() {
  const filePath = path.resolve(__dirname, '..', 'README.md');
  return fs.readFileSync(filePath, 'utf8');
}

function createIo() {
  let stdout = '';
  let stderr = '';

  const makeWritable = (capture: (value: string) => void) =>
    new Writable({
      write(chunk, _enc, callback) {
        capture(typeof chunk === 'string' ? chunk : chunk.toString());
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

describe('ReadmeExamples', () => {
  it('ReadmeUsageExamples ensures README snippets and CLI output stay in sync', async () => {
    const readme = readReadme();

    expect(readme).toContain('"idleTimeoutMs"');
    expect(readme).toContain('"restartJitterFactor"');
    expect(readme).toContain('Audio source recovering (reason=ffmpeg-missing|stream-idle)');
    expect(readme).toContain('pipelines.ffmpeg.byChannel');
    expect(readme).toContain('watchdogBackoffByChannel');
    expect(readme).toContain('circuit-breaker');
    expect(readme).toContain('guardian status --json');
    expect(readme).toContain('guardian health');
    expect(readme).toContain('guardian retention run');
    expect(readme).toContain('pnpm exec tsx src/cli.ts status --json');
    expect(readme).toContain('guardian log-level set debug');
    expect(readme).toContain('Platform farklılıkları (ALSA/CoreAudio/Video4Linux)');
    expect(readme).toContain('metrics.histograms.pipeline.ffmpeg.restarts');
    expect(readme).toContain('pnpm tsx src/cli.ts --health');

    metrics.reset();
    const capture = createIo();
    const exitCode = await runCli(['status', '--json'], capture.io);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.stdout().trim());
    expect(payload.metrics.pipelines.ffmpeg.byChannel).toBeDefined();
    expect(payload.metrics.pipelines.audio.byChannel).toBeDefined();

    const initialLevel = getLogLevel();
    const setCapture = createIo();
    const setExit = await runCli(['log-level', 'set', 'debug'], setCapture.io);
    expect(setExit).toBe(0);
    expect(setCapture.stdout()).toContain('Log level set to debug');
    expect(getLogLevel()).toBe('debug');

    const getCapture = createIo();
    const getExit = await runCli(['log-level'], getCapture.io);
    expect(getExit).toBe(0);
    expect(getCapture.stdout().trim()).toBe('debug');

    const restoreCapture = createIo();
    const restoreExit = await runCli(['log-level', 'set', initialLevel], restoreCapture.io);
    expect(restoreExit).toBe(0);
  });
});
