import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import metrics from '../src/metrics/index.js';
import AudioSource from '../src/audio/source.js';
import { registerShutdownHook, registerHealthIndicator, resetAppLifecycle } from '../src/app.js';
import logger from '../src/logger.js';
import configManager, { type GuardianConfig } from '../src/config/index.js';
import * as dbModule from '../src/db.js';

const startGuardMock = vi.fn();
vi.mock('../src/run-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../src/run-guard.js')>('../src/run-guard.js');
  return {
    ...actual,
    startGuard: startGuardMock
  };
});

import { runCli, buildHealthPayload, buildReadinessPayload, resolveHealthExitCode } from '../src/cli.js';

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function parseSystemdUnit(content: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex);
    const value = line.slice(eqIndex + 1);
    const bucket = map[key] ?? [];
    bucket.push(value);
    map[key] = bucket;
  }
  return map;
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
  it('CliDaemonLifecycleHealth maps health states to exit codes and readiness payload', async () => {
    expect(resolveHealthExitCode('ok')).toBe(0);
    expect(resolveHealthExitCode('degraded')).toBe(1);
    expect(resolveHealthExitCode('starting')).toBe(2);
    expect(resolveHealthExitCode('stopping')).toBe(3);

    const initialHealth = await buildHealthPayload();
    const readiness = buildReadinessPayload(initialHealth);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('service-idle');
    expect(readiness.probes.systemd.ready).toContain('--ready');
    expect(readiness.probes.docker.health).toContain('scripts/healthcheck.ts');

    const initialReady = createTestIo();
    const initialReadyCode = await runCli(['--ready'], initialReady.io);
    expect(initialReadyCode).toBe(1);
    const initialPayload = JSON.parse(initialReady.stdout().trim());
    expect(initialPayload.ready).toBe(false);
    expect(initialPayload.reason).toBe('service-idle');
    expect(initialPayload.metrics.channels.video).toBe(0);
    expect(initialPayload.metrics.channels.audio).toBe(0);
    expect(typeof initialPayload.metrics.snapshotCapturedAt).toBe('string');
    expect(initialPayload.probes.systemd.health).toContain('scripts/healthcheck.ts');

    const stopSpy = vi.fn();
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });
    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const readyIo = createTestIo();
    const readyCode = await runCli(['--ready'], readyIo.io);
    expect(readyCode).toBe(0);
    const readyPayload = JSON.parse(readyIo.stdout().trim());
    expect(readyPayload.ready).toBe(true);
    expect(readyPayload.reason).toBeNull();
    expect(readyPayload.metrics.channels.video).toBe(0);
    expect(readyPayload.metrics.channels.audio).toBe(0);
    expect(readyPayload.probes.docker.ready).toContain('--ready');

    metrics.incrementLogLevel('error', { message: 'detector error' });
    const degradedIo = createTestIo();
    const degradedCode = await runCli(['--ready'], degradedIo.io);
    expect(degradedCode).toBe(1);
    const degradedPayload = JSON.parse(degradedIo.stdout().trim());
    expect(degradedPayload.ready).toBe(false);
    expect(degradedPayload.reason).toBe('health-degraded');
    expect(typeof degradedPayload.metrics.snapshotCapturedAt).toBe('string');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliHealthcheckOutputsStatus reports ok status and pipeline summaries for daemon health JSON', async () => {
    const capture = createTestIo();
    const code = await runCli(['daemon', 'health', '--json'], capture.io);

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdout().trim());

    expect(payload.status).toBe('ok');
    expect(payload.metricsSummary.pipelines.restarts.video).toBe(0);
    expect(payload.metricsSummary.pipelines.restarts.audio).toBe(0);
    expect(payload.metricsSummary.pipelines.watchdogRestarts.video).toBe(0);
    expect(payload.metricsSummary.pipelines.watchdogRestarts.audio).toBe(0);
    expect(payload.metricsSummary.pipelines.watchdogBackoffMs.video).toBe(0);
    expect(payload.metricsSummary.pipelines.watchdogBackoffMs.audio).toBe(0);
    expect(payload.metricsSummary.pipelines.lastWatchdogJitterMs.video).toBeNull();
    expect(payload.metricsSummary.pipelines.lastWatchdogJitterMs.audio).toBeNull();
    expect(payload.metricsSummary.pipelines.transportFallbacks.video.total).toBe(0);
    expect(payload.metricsSummary.pipelines.transportFallbacks.audio.total).toBe(0);
    expect(payload.metricsSummary.pipelines.transportFallbacks.video.last).toBeNull();
    expect(payload.metricsSummary.pipelines.transportFallbacks.audio.last).toBeNull();
    expect(payload.metricsSummary.pipelines.channels.video).toBe(0);
    expect(payload.metricsSummary.pipelines.channels.audio).toBe(0);
    expect(payload.metricsSummary.pipelines.lastRestartAt.video).toBeNull();
    expect(payload.metricsSummary.pipelines.lastRestartAt.audio).toBeNull();
    expect(payload.pipelines.ffmpeg.channels).toEqual({});
    expect(payload.pipelines.audio.channels).toEqual({});
    expect(payload.pipelines.ffmpeg.totalDegraded).toBe(0);
    expect(payload.pipelines.audio.totalDegraded).toBe(0);
  });

  it('CliPipelinesListsThresholds includes detector thresholds and restart context in list output', async () => {
    const capture = createTestIo();
    const baseConfig = configManager.getConfig();
    const thresholdConfig: GuardianConfig = JSON.parse(JSON.stringify(baseConfig));
    thresholdConfig.motion = {
      ...thresholdConfig.motion,
      diffThreshold: 12,
      areaThreshold: 4096,
      minIntervalMs: 1500
    };
    thresholdConfig.person = {
      ...thresholdConfig.person,
      score: 0.42,
      minIntervalMs: 2500,
      checkEveryNFrames: 3,
      maxDetections: 6
    };
    thresholdConfig.video.channels = {
      'video:front-door': {
        motion: {
          diffThreshold: 18,
          minIntervalMs: 2000
        },
        person: {
          score: 0.5,
          checkEveryNFrames: 5
        }
      }
    };
    thresholdConfig.video.cameras = [
      {
        id: 'front-door',
        channel: 'video:front-door',
        input: 'rtsp://example/front',
        motion: {
          areaThreshold: 6144
        },
        person: {
          minIntervalMs: 3200,
          maxDetections: 8
        }
      }
    ];

    const configSpy = vi.spyOn(configManager, 'getConfig').mockReturnValue(thresholdConfig);

    metrics.recordPipelineRestart('ffmpeg', 'watchdog', {
      channel: 'video:front-door',
      delayMs: 2500,
      attempt: 2
    });
    metrics.recordPipelineRestart('ffmpeg', 'watchdog', {
      channel: 'video:front-door',
      delayMs: 5000,
      attempt: 3
    });
    metrics.setPipelineChannelHealth('ffmpeg', 'video:front-door', {
      severity: 'warning',
      restarts: 2,
      backoffMs: 5000,
      reason: 'test-warning'
    });

    try {
      const code = await runCli(['daemon', 'pipelines', 'list', '--json'], capture.io);
      expect(code).toBe(0);
      const payload = JSON.parse(capture.stdout().trim());
      const videoChannels = payload.pipelines.ffmpeg.channels;
      expect(Object.keys(videoChannels)).toContain('video:front-door');
      const summary = videoChannels['video:front-door'];
      expect(summary.severity).toBe('warning');
      expect(summary.restarts).toBe(2);
      expect(summary.thresholds.motion).toEqual({
        diffThreshold: 18,
        areaThreshold: 6144,
        minIntervalMs: 2000
      });
      expect(summary.thresholds.person).toEqual({
        score: 0.5,
        minIntervalMs: 3200,
        checkEveryNFrames: 5,
        maxDetections: 8
      });
    } finally {
      configSpy.mockRestore();
    }
  });

  it('CliAudioDevicesListsDiscovered outputs fallback-ordered device inventory', async () => {
    const capture = createTestIo();
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const discovered = [
      { format: 'pulse', device: 'default' },
      { format: 'pipewire', device: 'monitor' },
      { format: 'alsa', device: 'hw:1,0' },
      { format: 'dshow', device: 'audio="default"' }
    ];
    const listSpy = vi.spyOn(AudioSource, 'listDevices').mockResolvedValue(discovered);

    const code = await runCli(['audio', 'devices', '--json'], capture.io);

    expect(code).toBe(0);
    const payload = JSON.parse(capture.stdout().trim());
    expect(payload.format).toBe('auto');
    expect(payload.devices).toEqual(discovered);
    expect(payload.devices.map((entry: { format: string }) => entry.format)).toEqual([
      'pulse',
      'pipewire',
      'alsa',
      'dshow'
    ]);
    expect(listSpy).toHaveBeenCalledWith('auto', { channel: 'cli:audio-devices' });

    platformSpy.mockRestore();
    listSpy.mockRestore();
  });

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
    expect(flagPayload.probes.systemd.health).toContain('scripts/healthcheck.ts');
    expect(flagPayload.probes.docker.ready).toContain('--ready');
    expect(flagPayload.runtime.pipelines.videoChannels).toBeTypeOf('number');
    expect(flagPayload.runtime.pipelines.audioChannels).toBeTypeOf('number');
    expect(flagPayload.runtime.pipelines.videoRestarts).toBe(0);
    expect(flagPayload.runtime.pipelines.audioRestarts).toBe(0);
    expect(typeof flagPayload.metricsCapturedAt).toBe('string');
    expect(flagPayload.metricsSummary.pipelines.channels.video).toBe(0);
    expect(flagPayload.metricsSummary.pipelines.channels.audio).toBe(0);
    expect(flagPayload.metricsSummary.pipelines.lastRestartAt.video).toBeNull();
    expect(flagPayload.metricsSummary.pipelines.lastRestartAt.audio).toBeNull();
    expect(flagPayload.pipelines.ffmpeg.totalDegraded).toBe(0);
    expect(flagPayload.pipelines.audio.totalDegraded).toBe(0);

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

  it('CliJsonStatus exposes shutdown summaries and hook statuses', async () => {
    const capture = createTestIo();
    const initialCode = await runCli(['status', '--json'], capture.io);
    const initialPayload = JSON.parse(capture.stdout().trim());

    expect(initialCode).toBe(0);
    expect(initialPayload.application.shutdown.hooks).toEqual([]);
    expect(initialPayload.application.shutdown.lastReason).toBeNull();

    const stopSpy = vi.fn();
    const hook = vi.fn();
    registerShutdownHook('status-json-hook', hook);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startIo = createTestIo();
    const startPromise = runCli(['start'], startIo.io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const stopIo = createTestIo();
    await runCli(['stop'], stopIo.io);

    const statusCapture = createTestIo();
    const statusCode = await runCli(['status', '--json'], statusCapture.io);
    const statusPayload = JSON.parse(statusCapture.stdout().trim());

    expect(statusCode).toBe(0);
    expect(statusPayload.application.shutdown.lastReason).toBe('cli-stop');
    const hookSummary = statusPayload.application.shutdown.hooks.find(
      (entry: { name: string }) => entry.name === 'status-json-hook'
    );
    expect(hookSummary).toBeDefined();
    expect(hookSummary?.status).toBe('ok');

    await expect(startPromise).resolves.toBe(0);
  });

  it('CliAudioCircuitReset triggers audio circuit breaker resets and reports the channel', async () => {
    const stopSpy = vi.fn();
    const resetSpy = vi.fn().mockReturnValue(true);
    const resetHealthSpy = vi.fn().mockReturnValue(false);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: resetSpy,
      resetChannelHealth: resetHealthSpy,
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const restartIo = createTestIo();
    const code = await runCli(['daemon', 'restart', '--channel', 'audio:CLI-Stream'], restartIo.io);

    expect(code).toBe(0);
    expect(resetSpy).toHaveBeenCalledWith('audio:CLI-Stream');
    expect(restartIo.stdout()).toContain('Requested circuit breaker reset for audio channel audio:cli-stream');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliDaemonHealthcheck exposes daemon subcommands and exit codes', async () => {
    const healthIo = createTestIo();
    const healthCode = await runCli(['daemon', 'health'], healthIo.io);
    const healthPayload = JSON.parse(healthIo.stdout().trim());

    expect(healthCode).toBe(0);
    expect(healthPayload.status).toBe('ok');

    const readyIo = createTestIo();
    const readyCode = await runCli(['daemon', 'ready'], readyIo.io);
    const readyPayload = JSON.parse(readyIo.stdout().trim());

    expect(readyCode).toBe(1);
    expect(readyPayload.ready).toBe(false);
    expect(readyPayload.reason).toBe('service-stopped');
    expect(readyPayload.probes.systemd.health).toContain('scripts/healthcheck.ts');

    const stopIo = createTestIo();
    const stopCode = await runCli(['daemon', 'stop'], stopIo.io);

    expect(stopCode).toBe(0);
    expect(stopIo.stdout()).toContain('Guardian daemon is not running');
  });

  it('CliDaemonRestartChannel resets circuit breakers for the requested video channel', async () => {
    const stopSpy = vi.fn();
    const resetSpy = vi.fn().mockReturnValue(true);
    const resetHealthSpy = vi.fn().mockReturnValue(false);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: resetSpy,
      resetChannelHealth: resetHealthSpy,
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const restartIo = createTestIo();
    const code = await runCli(['daemon', 'restart', '--channel', 'video:lobby'], restartIo.io);

    expect(code).toBe(0);
    expect(resetSpy).toHaveBeenCalledWith('video:lobby');
    expect(restartIo.stdout()).toContain('video:lobby');

    const helpIo = createTestIo();
    const helpCode = await runCli(['daemon', 'restart', '--help'], helpIo.io);
    expect(helpCode).toBe(0);
    expect(helpIo.stdout()).toContain('guardian daemon restart');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliDaemonRestartUnknownChannel reports descriptive error for missing pipelines', async () => {
    const stopSpy = vi.fn();
    const resetSpy = vi.fn().mockReturnValue(false);
    const resetHealthSpy = vi.fn().mockReturnValue(false);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: resetSpy,
      resetChannelHealth: resetHealthSpy,
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const restartIo = createTestIo();
    const code = await runCli(['daemon', 'restart', '--channel', 'video:unknown'], restartIo.io);

    expect(code).toBe(1);
    expect(resetSpy).toHaveBeenCalledWith('video:unknown');
    expect(restartIo.stderr()).toContain('channel not found');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliTransportFallbackReset resets transport ladders for video channels', async () => {
    const stopSpy = vi.fn();
    const resetFallbackSpy = vi.fn().mockReturnValue(true);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: resetFallbackSpy
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const restartIo = createTestIo();
    const code = await runCli(['daemon', 'restart', '--transport', 'video:rtsp-main'], restartIo.io);

    expect(code).toBe(0);
    expect(resetFallbackSpy).toHaveBeenCalledWith('video:rtsp-main');
    expect(restartIo.stdout()).toContain('transport fallback reset');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliTransportFallbackMetrics resets transport ladders and clears summaries', async () => {
    const runtimeResetSpy = vi.fn().mockReturnValue(true);
    startGuardMock.mockResolvedValue({
      stop: vi.fn(),
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: runtimeResetSpy
    });

    const startIo = createTestIo();
    const startPromise = runCli(['start'], startIo.io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const channel = 'video:cam-transport';
    metrics.recordTransportFallback('ffmpeg', 'rtsp-timeout', {
      channel,
      from: 'udp',
      to: 'tcp',
      attempt: 2,
      stage: 1,
      at: Date.now() - 250,
      resetsBackoff: true,
      resetsCircuitBreaker: true
    });

    const restartIo = createTestIo();
    const restartCode = await runCli(['daemon', 'restart', '--transport', channel], restartIo.io);
    expect(restartCode).toBe(0);
    expect(runtimeResetSpy).toHaveBeenCalledWith(channel);
    expect(restartIo.stdout()).toContain('Cleared recorded transport fallback metrics');
    expect(restartIo.stdout()).toContain('Transport fallback ladder reset');

    const healthIo = createTestIo();
    const healthCode = await runCli(['daemon', 'health', '--json'], healthIo.io);
    expect(healthCode).toBe(0);
    const payload = JSON.parse(healthIo.stdout().trim());
    expect(payload.metricsSummary.pipelines.transportFallbacks.video.total).toBe(0);
    const channelSummary = payload.metricsSummary.pipelines.transportFallbacks.video.byChannel.find(
      (entry: { channel: string }) => entry.channel === channel
    );
    expect(channelSummary).toBeDefined();
    expect(channelSummary.total).toBe(0);
    expect(channelSummary.lastReason).toBeNull();

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliDaemonRestartTransport resets runtime fallbacks and clears metrics state', async () => {
    const runtimeResetSpy = vi.fn().mockReturnValue(true);
    const metricsResetSpy = vi.spyOn(metrics, 'resetTransportFallback');
    startGuardMock.mockResolvedValue({
      stop: vi.fn(),
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: runtimeResetSpy
    });

    const startIo = createTestIo();
    const startPromise = runCli(['start'], startIo.io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const channel = 'Video:Transport-Main';
    const restartIo = createTestIo();
    const code = await runCli(['daemon', 'restart', '--transport', channel], restartIo.io);

    expect(code).toBe(0);
    expect(runtimeResetSpy).toHaveBeenCalledTimes(1);
    expect(runtimeResetSpy).toHaveBeenCalledWith(channel);
    expect(metricsResetSpy).toHaveBeenCalledTimes(1);
    expect(metricsResetSpy).toHaveBeenCalledWith('video:transport-main');
    expect(restartIo.stdout()).toContain(
      'Requested transport fallback reset for video channel video:transport-main'
    );
    expect(restartIo.stdout()).toContain('Transport fallback ladder reset for video:transport-main');

    metricsResetSpy.mockRestore();

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliDaemonPipelineResetHealth clears pipeline health severity and fallback totals', async () => {
    metrics.reset();
    metrics.recordPipelineRestart('ffmpeg', 'watchdog-timeout', {
      channel: 'video:cam-1',
      at: Date.now() - 1_000,
      delayMs: 2_500
    });
    metrics.setPipelineChannelHealth('ffmpeg', 'video:cam-1', {
      severity: 'warning',
      reason: 'watchdog restarts exceeded',
      restarts: 1,
      backoffMs: 2_500
    });
    metrics.recordTransportFallback('ffmpeg', 'manual-cli-reset', {
      channel: 'video:cam-1',
      from: 'tcp',
      to: 'udp',
      attempt: 1,
      stage: 0,
      at: Date.now() - 500,
      resetsCircuitBreaker: true
    });

    const resetIo = createTestIo();
    const resetCode = await runCli(['daemon', 'pipelines', 'reset', '--channel', 'video:cam-1'], resetIo.io);

    expect(resetCode).toBe(0);
    expect(resetIo.stdout()).toContain('transport fallback');
    expect(resetIo.stdout()).toContain('circuit breaker');

    const healthIo = createTestIo();
    const healthCode = await runCli(['daemon', 'health', '--json'], healthIo.io);
    expect(healthCode).toBe(0);
    const payload = JSON.parse(healthIo.stdout().trim());

    const channelSummary = payload.pipelines.ffmpeg.channels['video:cam-1'];
    expect(channelSummary).toBeDefined();
    expect(channelSummary.severity).toBe('none');
    expect(channelSummary.restarts).toBe(0);
    expect(channelSummary.backoffMs).toBe(0);
    expect(channelSummary.watchdogRestarts).toBe(0);
    expect(channelSummary.watchdogBackoffMs).toBe(0);
    expect(payload.pipelines.ffmpeg.transportFallbacks.total).toBe(0);
    expect(payload.pipelines.ffmpeg.transportFallbacks.byChannel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'video:cam-1', total: 0, lastReason: null })
      ])
    );

    const fallbackSummary = payload.metricsSummary.pipelines.transportFallbacks.video.byChannel.find(
      (entry: { channel: string }) => entry.channel === 'video:cam-1'
    );
    expect(fallbackSummary).toBeDefined();
    expect(fallbackSummary.total).toBe(0);
    expect(fallbackSummary.lastReason).toBeNull();
  });

  it('CliHealthSummarySnapshot includes transport fallback and retention summaries', async () => {
    const baseTime = Date.now();
    metrics.recordTransportFallback('ffmpeg', 'rtsp-timeout', {
      channel: 'front-door',
      to: 'tcp',
      at: baseTime - 2500
    });
    metrics.recordTransportFallback('ffmpeg', 'connect-error', {
      channel: 'rear-lot',
      to: 'udp',
      at: baseTime - 1500
    });
    metrics.recordTransportFallback('ffmpeg', 'rtsp-timeout', {
      channel: 'front-door',
      to: 'udp',
      at: baseTime - 500
    });

    metrics.recordSuppressedEvent({
      ruleId: 'motion-window',
      reason: 'cooldown',
      channel: 'front-door',
      historyCount: 2,
      combinedHistoryCount: 3,
      channels: ['front-door']
    });
    metrics.recordSuppressedEvent({
      ruleId: 'motion-window',
      reason: 'cooldown',
      channel: 'rear-lot',
      historyCount: 1,
      combinedHistoryCount: 1,
      channels: ['rear-lot']
    });

    metrics.recordRetentionRun({
      removedEvents: 5,
      archivedSnapshots: 2,
      prunedArchives: 1,
      diskSavingsBytes: 4096,
      perCamera: {
        'front-door': { archivedSnapshots: 1, prunedArchives: 1 },
        'rear-lot': { archivedSnapshots: 1, prunedArchives: 0 }
      }
    });
    metrics.recordRetentionWarning({
      camera: 'front-door',
      path: '/data/front',
      reason: 'disk-low'
    });
    metrics.recordRetentionWarning({
      camera: null,
      path: '/data/global',
      reason: 'fs-readonly'
    });

    const payload = await buildHealthPayload();

    expect(payload.metricsSummary.pipelines.transportFallbacks.video.byChannel).toEqual([
      {
        channel: 'front-door',
        total: 2,
        lastReason: 'rtsp-timeout',
        lastAt: expect.any(String)
      },
      {
        channel: 'rear-lot',
        total: 1,
        lastReason: 'connect-error',
        lastAt: expect.any(String)
      }
    ]);
    expect(payload.metricsSummary.pipelines.transportFallbacks.audio.byChannel).toEqual([]);
    expect(payload.pipelines.ffmpeg.transportFallbacks.total).toBe(3);
    expect(payload.pipelines.ffmpeg.transportFallbacks.byChannel).toEqual([
      {
        channel: 'front-door',
        total: 2,
        lastReason: 'rtsp-timeout',
        lastAt: expect.any(String)
      },
      {
        channel: 'rear-lot',
        total: 1,
        lastReason: 'connect-error',
        lastAt: expect.any(String)
      }
    ]);
    expect(payload.suppression.total).toBe(2);
    expect(payload.suppression.byChannel).toEqual([
      { channel: 'front-door', total: 1 },
      { channel: 'rear-lot', total: 1 }
    ]);
    expect(payload.suppression.byReason).toEqual([{ reason: 'cooldown', total: 2 }]);
    expect(payload.suppression.history.historyCount).toBe(3);
    expect(payload.suppression.history.combinedHistoryCount).toBe(4);
    expect(payload.suppression.history.historyTtlPruned).toBe(0);
    expect(payload.suppression.lastEvent?.ruleId).toBe('motion-window');
    expect(payload.metricsSummary.retention).toMatchObject({
      runs: 1,
      warnings: 2,
      totals: {
        removedEvents: 5,
        archivedSnapshots: 2,
        prunedArchives: 1,
        diskSavingsBytes: 4096
      }
    });
    expect(payload.metricsSummary.retention.totalsByCamera).toEqual({
      'front-door': { archivedSnapshots: 1, prunedArchives: 1, fallbackMoves: 0 },
      'rear-lot': { archivedSnapshots: 1, prunedArchives: 0, fallbackMoves: 0 }
    });
  });

  it('CliPipelinesListJson mirrors summary output and orders degraded channels by severity', async () => {
    metrics.setPipelineChannelHealth('ffmpeg', 'video:beta', {
      severity: 'critical',
      restarts: 9,
      backoffMs: 60000,
      reason: 'watchdog restarts 9 ≥ 6'
    });
    metrics.setPipelineChannelHealth('ffmpeg', 'video:alpha', {
      severity: 'warning',
      restarts: 4,
      backoffMs: 12000,
      reason: 'watchdog restarts 4 ≥ 3'
    });
    metrics.setPipelineChannelHealth('audio', 'audio:lobby', {
      severity: 'warning',
      restarts: 2,
      backoffMs: 5000,
      reason: 'watchdog restarts 2 ≥ 2'
    });

    const listIo = createTestIo();
    const listCode = await runCli(['daemon', 'pipelines', 'list', '--json'], listIo.io);
    expect(listCode).toBe(0);
    const payload = JSON.parse(listIo.stdout().trim());

    const ffmpeg = payload.pipelines.ffmpeg;
    expect(ffmpeg.channels['video:alpha'].severity).toBe('warning');
    expect(ffmpeg.channels['video:beta'].severity).toBe('critical');
    expect(ffmpeg.degraded).toEqual(['video:beta', 'video:alpha']);
    expect(ffmpeg.totalDegraded).toBe(2);

    const audio = payload.pipelines.audio;
    expect(audio.channels['audio:lobby'].severity).toBe('warning');
    expect(audio.degraded).toEqual(['audio:lobby']);
    expect(audio.totalDegraded).toBe(1);
  });

  it('CliPipelinesReset delegates to runtime and clears recorded health state', async () => {
    const stopSpy = vi.fn();
    const resetChannelHealth = vi.fn().mockReturnValue(true);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn(),
      resetChannelHealth,
      resetTransportFallback: vi.fn()
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    metrics.setPipelineChannelHealth('ffmpeg', 'video:front', {
      severity: 'warning',
      restarts: 3,
      backoffMs: 12000,
      reason: 'watchdog restarts 3 ≥ 3'
    });

    const resetIo = createTestIo();
    const resetCode = await runCli([
      'daemon',
      'pipelines',
      'reset',
      '--channel',
      'video:front'
    ], resetIo.io);

    expect(resetCode).toBe(0);
    expect(resetChannelHealth).toHaveBeenCalledWith('video:front');
    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.ffmpeg.byChannel['video:front'].health.severity).toBe('none');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliPipelineResetNoRestartKeepsOffline', async () => {
    const stopSpy = vi.fn();
    const resetCircuitBreaker = vi.fn().mockReturnValue(true);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker,
      resetChannelHealth: vi.fn().mockReturnValue(true),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    metrics.setPipelineChannelHealth('ffmpeg', 'video:offline', {
      severity: 'critical',
      restarts: 5,
      backoffMs: 60000,
      reason: 'manual test'
    });

    const resetIo = createTestIo();
    const resetCode = await runCli(
      ['daemon', 'pipelines', 'reset', '--channel', 'video:offline', '--no-restart'],
      resetIo.io
    );

    expect(resetCode).toBe(0);
    expect(resetCircuitBreaker).toHaveBeenCalledWith('video:offline', { restart: false });
    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.ffmpeg.byChannel['video:offline'].health.severity).toBe('none');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliPipelineResetAudioResetsCounters', async () => {
    const stopSpy = vi.fn();
    const resetCircuitBreaker = vi.fn().mockReturnValue(true);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker,
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    metrics.setPipelineChannelHealth('audio', 'audio:lobby', {
      severity: 'warning',
      restarts: 2,
      backoffMs: 5000,
      reason: 'manual test'
    });

    const resetIo = createTestIo();
    const resetCode = await runCli(
      ['daemon', 'pipelines', 'reset', '--channel', 'audio:lobby'],
      resetIo.io
    );

    expect(resetCode).toBe(0);
    expect(resetCircuitBreaker).toHaveBeenCalledWith('audio:lobby', { restart: true });
    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.audio.byChannel['audio:lobby'].health.severity).toBe('none');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('GuardianCliPipelinesResetTransport surfaces transport resets and readiness probes', async () => {
    const stopSpy = vi.fn();
    const resetFallback = vi.fn().mockReturnValue(true);
    const resetCircuitBreaker = vi.fn().mockReturnValue(true);
    const resetChannelHealth = vi.fn().mockReturnValue(true);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker,
      resetChannelHealth,
      resetTransportFallback: resetFallback
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    metrics.setPipelineChannelHealth('ffmpeg', 'video:garage', {
      severity: 'warning',
      restarts: 2,
      backoffMs: 8000,
      reason: 'manual test'
    });

    const resetIo = createTestIo();
    const resetCode = await runCli(
      ['daemon', 'pipelines', 'reset', '--channel', 'video:garage'],
      resetIo.io
    );

    expect(resetCode).toBe(0);
    expect(resetFallback).toHaveBeenCalledWith('video:garage');
    const resetOutput = resetIo.stdout();
    expect(resetOutput).toContain('Cleared recorded transport fallback metrics for video:garage');
    expect(resetOutput).toContain('Transport fallback ladder reset for video:garage');

    const readyIo = createTestIo();
    const readyCode = await runCli(['daemon', 'ready'], readyIo.io);
    expect(readyCode).toBe(0);
    const readyPayload = JSON.parse(readyIo.stdout().trim());
    expect(readyPayload.probes.systemd.health).toContain('scripts/healthcheck.ts');
    expect(readyPayload.probes.systemd.ready).toContain('--ready');
    expect(readyPayload.probes.docker.health).toContain('scripts/healthcheck.ts');
    expect(readyPayload.probes.docker.ready).toContain('--ready');

    await runCli(['stop'], createTestIo().io);
    await expect(startPromise).resolves.toBe(0);
  });

  it('CliSystemdIntegration reports integration manifest and matches packaged commands', async () => {
    const health = await buildHealthPayload();
    const manifest = health.integration;

    expect(manifest.docker.healthcheck).toContain('pnpm exec tsx scripts/healthcheck.ts');
    expect(manifest.docker.stopCommand).toContain('pnpm exec tsx src/cli.ts stop');
    expect(manifest.docker.logLevel.get).toContain('log-level get');
    expect(manifest.docker.logLevel.set).toContain('log-level set');
    expect(manifest.docker.readyCommand).toContain('--ready');

    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toContain(manifest.docker.healthcheck);

    expect(manifest.systemd.execStartPre).toContain('scripts/healthcheck.ts');

    const guardianUnit = parseSystemdUnit(fs.readFileSync(path.join('deploy', 'guardian.service'), 'utf8'));
    expect(guardianUnit.ExecStart?.[0]).toBe(manifest.systemd.execStart);
    expect(guardianUnit.ExecStartPre?.[0]).toBe(manifest.systemd.execStartPre);
    expect(guardianUnit.ExecStop?.[0]).toBe(manifest.systemd.execStop);
    expect(guardianUnit.ExecReload?.[0]).toBe(manifest.systemd.execReload);
    expect(guardianUnit.ExecStopPost).toEqual(manifest.systemd.execStopPost);

    const systemdUnit = parseSystemdUnit(fs.readFileSync(path.join('deploy', 'systemd.service'), 'utf8'));
    expect(systemdUnit.ExecStartPre?.[0]).toBe(manifest.systemd.execStartPre);
    expect(systemdUnit.ExecStart?.[0]).toBe(manifest.systemd.execStart);
    expect(systemdUnit.ExecStop?.[0]).toBe(manifest.systemd.execStop);
    expect(systemdUnit.ExecStopPost).toEqual(manifest.systemd.execStopPost);

    expect(manifest.systemd.healthCommand).toBe(manifest.systemd.execStartPre);
    expect(manifest.systemd.readyCommand).toContain('--ready');
    expect(manifest.systemd.logLevel.get).toContain('log-level get');
    expect(manifest.systemd.logLevel.set).toContain('log-level set');
  });

  it('DockerHealthProbeConfig wires CLI health command and entrypoint', () => {
    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('scripts/healthcheck.ts --health');
    expect(dockerfile).toContain('"daemon", "start"');
  });

  it('CliAudioDevicesList returns JSON payload for detected devices', async () => {
    const capture = createTestIo();
    const devices = [
      { format: 'alsa', device: 'hw:0' },
      { format: 'alsa', device: 'default' }
    ];

    const spy = vi.spyOn(AudioSource, 'listDevices').mockResolvedValue(devices);

    try {
      const code = await runCli(['audio', 'devices', '--format', 'alsa', '--json'], capture.io);
      expect(code).toBe(0);
      expect(capture.stderr()).toBe('');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('alsa', { channel: 'cli:audio-devices' });

      const payload = JSON.parse(capture.stdout().trim());
      expect(payload.format).toBe('alsa');
      expect(payload.devices).toEqual(devices);
    } finally {
      spy.mockRestore();
    }
  });

  it('CliAudioDevicesFormats accepts pulse and pipewire formats', async () => {
    const spy = vi.spyOn(AudioSource, 'listDevices');

    const pulseIo = createTestIo();
    spy.mockResolvedValueOnce([{ format: 'pulse', device: 'default' }]);
    const pulseCode = await runCli(
      ['audio', 'devices', '--format', 'pulse', '--json'],
      pulseIo.io
    );
    expect(pulseCode).toBe(0);
    expect(JSON.parse(pulseIo.stdout().trim()).format).toBe('pulse');
    expect(spy).toHaveBeenNthCalledWith(1, 'pulse', { channel: 'cli:audio-devices' });

    const pipewireIo = createTestIo();
    spy.mockResolvedValueOnce([{ format: 'pipewire', device: 'monitor' }]);
    const pipewireCode = await runCli(
      ['audio', 'devices', '--format', 'pipewire', '--json'],
      pipewireIo.io
    );
    expect(pipewireCode).toBe(0);
    expect(JSON.parse(pipewireIo.stdout().trim()).format).toBe('pipewire');
    expect(spy).toHaveBeenNthCalledWith(2, 'pipewire', { channel: 'cli:audio-devices' });

    const helpIo = createTestIo();
    const helpCode = await runCli(['audio', '--help'], helpIo.io);
    expect(helpCode).toBe(0);
    expect(helpIo.stdout()).toContain('pulse');
    expect(helpIo.stdout()).toContain('pipewire');

    spy.mockRestore();
  });
});

describe('GuardianCliRetention', () => {
  it('CliRetentionRun executes retention task once and emits diagnostics', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-cli-retention-'));
    const archiveDir = path.join(tempDir, 'archive');
    const snapshotDir = path.join(tempDir, 'snapshots');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(snapshotDir, { recursive: true });

    const baseConfig = configManager.getConfig();
    const retentionConfig = JSON.parse(JSON.stringify(baseConfig));
    retentionConfig.events = retentionConfig.events ?? { thresholds: { info: 0, warning: 1, critical: 2 } };
    retentionConfig.events.retention = {
      ...retentionConfig.events.retention,
      archiveDir,
      enabled: true
    };
    retentionConfig.person = {
      ...retentionConfig.person,
      snapshotDir
    };
    if (Array.isArray(retentionConfig.video?.cameras)) {
      retentionConfig.video.cameras = retentionConfig.video.cameras.map(camera => ({
        ...camera,
        person: { ...camera.person, snapshotDir }
      }));
    }

    const configSpy = vi.spyOn(configManager, 'getConfig').mockReturnValue(retentionConfig);
    const applySpy = vi.spyOn(dbModule, 'applyRetentionPolicy').mockReturnValue({
      removedEvents: 3,
      archivedSnapshots: 2,
      prunedArchives: 1,
      warnings: [],
      perCamera: {}
    });
    const baselineDisk = dbModule.getDatabaseDiskUsage();
    const vacuumSpy = vi.spyOn(dbModule, 'vacuumDatabase').mockImplementation(() => ({
      run: 'always',
      mode: 'auto',
      target: undefined,
      analyze: false,
      reindex: false,
      optimize: false,
      pragmas: undefined,
      indexVersion: 1,
      indexVersionChanged: false,
      ensuredIndexes: [],
      disk: { before: baselineDisk, after: baselineDisk, savingsBytes: 0 },
      tables: []
    }));
    const runSpy = vi.spyOn(metrics, 'recordRetentionRun');
    const warnSpy = vi.spyOn(metrics, 'recordRetentionWarning');
    const infoSpy = vi.spyOn(logger, 'info');
    const warnLogSpy = vi.spyOn(logger, 'warn');

    const capture = createTestIo();

    try {
      const code = await runCli(['retention', 'run'], capture.io);

      expect(code).toBe(0);
      expect(capture.stdout()).toContain('Retention task completed');
      expect(runSpy).toHaveBeenCalledWith({
        removedEvents: 3,
        archivedSnapshots: 2,
        prunedArchives: 1,
        diskSavingsBytes: expect.any(Number),
        perCamera: {}
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(vacuumSpy).toHaveBeenCalledTimes(1);
      const completionCall = infoSpy.mock.calls.find(([, message]) => message === 'Retention task completed');
      expect(completionCall).toBeDefined();
      expect(warnLogSpy).not.toHaveBeenCalled();
    } finally {
      configSpy.mockRestore();
      applySpy.mockRestore();
      vacuumSpy.mockRestore();
      runSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      warnLogSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('GuardianCliShutdown', () => {
  it('CliDaemonLifecycle stops the running guard runtime and reports graceful shutdown', async () => {
    const stopSpy = vi.fn();
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

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

  it('CliHealthAwaitStop waits for guard stop promises and reports suppression summaries', async () => {
    const deferred = createDeferred<void>();
    const stopSpy = vi.fn().mockReturnValue(deferred.promise);
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

    const startPromise = runCli(['start'], createTestIo().io);

    await vi.waitFor(() => {
      expect(startGuardMock).toHaveBeenCalledTimes(1);
    });

    const sampleTime = Date.now();
    metrics.recordPipelineRestart('ffmpeg', 'watchdog-timeout', {
      channel: 'video:cam-main',
      delayMs: 1500,
      jitterMs: 60,
      at: sampleTime - 250
    });
    metrics.recordTransportFallback('ffmpeg', 'rtsp-timeout', {
      channel: 'video:cam-main',
      from: 'udp',
      to: 'tcp',
      at: sampleTime - 500
    });
    metrics.recordSuppressedEvent({
      ruleId: 'motion-window',
      reason: 'cooldown',
      channel: 'video:cam-main',
      historyCount: 2,
      combinedHistoryCount: 4,
      cooldownMs: 1500,
      channels: ['video:cam-main']
    });

    const healthIo = createTestIo();
    const healthCode = await runCli(['daemon', 'health', '--json'], healthIo.io);
    expect(healthCode).toBe(0);
    const payload = JSON.parse(healthIo.stdout().trim());
    expect(payload.pipelines.ffmpeg.watchdogRestarts).toBe(1);
    expect(payload.pipelines.ffmpeg.transportFallbacks.total).toBe(1);
    expect(payload.pipelines.ffmpeg.transportFallbacks.byChannel).toEqual([
      {
        channel: 'video:cam-main',
        total: 1,
        lastReason: 'rtsp-timeout',
        lastAt: expect.any(String)
      }
    ]);
    expect(payload.suppression.total).toBe(1);
    expect(payload.suppression.byChannel).toEqual([
      { channel: 'video:cam-main', total: 1 }
    ]);
    expect(payload.suppression.lastEvent?.reason).toBe('cooldown');

    const stopIo = createTestIo();
    const stopPromise = runCli(['stop'], stopIo.io);

    await vi.waitFor(() => {
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(stopResolved).toBe(false);
    expect(stopIo.stdout()).toBe('');

    deferred.resolve();

    const stopCode = await stopPromise;
    expect(stopCode).toBe(0);
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
    startGuardMock.mockResolvedValue({
      stop: stopSpy,
      resetCircuitBreaker: vi.fn().mockReturnValue(false),
      resetChannelHealth: vi.fn().mockReturnValue(false),
      resetTransportFallback: vi.fn().mockReturnValue(false)
    });

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
    expect(stopIo.stdout()).toContain('Shutdown hooks executed: 1 ok, 0 failed');
    expect(stopIo.stdout()).toContain('Guardian daemon stopped (status: ok)');

    await expect(startPromise).resolves.toBe(0);
  });
});
