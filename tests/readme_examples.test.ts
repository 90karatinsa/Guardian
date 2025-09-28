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
  it('ReadmeExamplesStayValid ensures README snippets and CLI output stay in sync', async () => {
    const readme = readReadme();

    expect(readme).toContain('"idleTimeoutMs": 5000');
    expect(readme).toContain('"restartJitterFactor": 0.2');
    expect(readme).toContain('"run": "on-change"');
    expect(readme).toContain('Audio source recovering (reason=ffmpeg-missing|stream-idle)');
    expect(readme).toContain('pipelines.ffmpeg.jitterHistogram');
    expect(readme).toContain('watchdogBackoffByChannel');
    expect(readme).toContain('pipelines.ffmpeg.watchdogRestartsByChannel');
    expect(readme).toContain('pipelines.ffmpeg.watchdogRestarts');
    expect(readme).toContain('guardian daemon start');
    expect(readme).toContain('guardian daemon status --json');
    expect(readme).toContain('guardian daemon health');
    expect(readme).toContain('guardian daemon ready');
    expect(readme).toContain('guardian daemon hooks --reason');
    expect(readme).toContain('guardian daemon restart --channel video:missing');
    expect(readme).toContain('channel not found: video:missing');
    expect(readme).toContain('guardian health');
    expect(readme).toContain('guardian retention run');
    expect(readme).toContain('pnpm exec tsx src/cli.ts status --json');
    expect(readme).toContain('guardian log-level set debug');
    expect(readme).toContain('metrics.histograms.pipeline.ffmpeg.restarts');
    expect(readme).toContain('metrics.logs.histogram.error');
    expect(readme).toContain('pipelines.ffmpeg.restartHistogram.delay');
    expect(readme).toContain('metrics.suppression.histogram.historyCount');
    expect(readme).toContain('metrics.logs.byLevel.error');
    expect(readme).toContain('metrics.exportLogLevelCountersForPrometheus');
    expect(readme).toContain('guardian_log_level_total');
    expect(readme).toContain('guardian_log_last_error_timestamp_seconds');
    expect(readme).toContain('guardian_ffmpeg_restart_jitter_ms');
    expect(readme).toContain('metrics=audio,retention');
    expect(readme).toContain('guardian_ffmpeg_restarts_total_bucket');
    expect(readme).toContain('guardian_detector_counter_total');
    expect(readme).toContain('"maxArchivesPerCamera": 3');
    expect(readme).toContain('vacuum=auto (run=on-change)');
    expect(readme).toContain('pose.forecast');
    expect(readme).toContain('threat.summary');
    expect(readme).toContain('Sorun giderme');
    expect(readme).toContain('Operasyon kılavuzu');
    expect(readme).toContain('docs/operations.md');
    expect(readme).toContain('pnpm tsx src/cli.ts --health');
    expect(readme).toContain('status: ok');
    expect(readme).toContain('scripts/healthcheck.ts --health');
    expect(readme).toContain('Offline kullanım');

    metrics.reset();
    const capture = createIo();
    const exitCode = await runCli(['status', '--json'], capture.io);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.stdout().trim());
    expect(payload.metrics.pipelines.ffmpeg.byChannel).toBeDefined();
    expect(payload.metrics.pipelines.audio.byChannel).toBeDefined();
    expect(payload.metrics.pipelines.ffmpeg.jitterHistogram).toBeDefined();

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

it('ReadmeIncludesDaemonRestart documents channel restarts and SSE metric filters', () => {
  const readme = readReadme();
  expect(readme).toContain('guardian daemon restart --channel video:missing');
  expect(readme).toContain('channel not found: video:missing');
  expect(readme).toContain('metrics=audio,retention');
});

it('ReadmeAudioSilenceDocs documents silence circuit breaker and device discovery timeout expectations', () => {
  const readme = readReadme();

  expect(readme).toContain('audio.silenceCircuitBreakerThreshold');
  expect(readme).toContain('Audio source recovering (reason=silence-circuit-breaker)');
  expect(readme).toContain('pipelines.audio.byReason');
  expect(readme).toContain('deviceDiscoveryTimeoutMs');
  expect(readme).toContain('Audio device discovery timed out after');
  expect(readme).toContain('pipelines.audio.deviceDiscovery');
  expect(readme).toContain('guardian audio devices --json');
});

describe('OperationsDocLinks', () => {
  it('OperationsDocLinks ensures README links to operations manual and sections are present', () => {
    const readme = readReadme();
    expect(readme).toContain('[Operasyon kılavuzu](docs/operations.md)');

    const operationsPath = path.resolve(__dirname, '..', 'docs', 'operations.md');
    const operations = fs.readFileSync(operationsPath, 'utf8');
    expect(operations).toContain('# Guardian Operasyon Kılavuzu');
    expect(operations).toContain('watchdogRestarts');
    expect(operations).toContain('guardian daemon health --json');
    expect(operations).toContain('pnpm exec tsx src/tasks/retention.ts --run');
    expect(operations).toContain('detector latency histogramlarını');
    expect(operations).toContain('guardian_log_level_total');
    expect(operations).toContain('guardian_ffmpeg_restart_jitter_ms');
    expect(operations).toContain('guardian_detector_counter_total');
  });
});
