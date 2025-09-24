import type { FfmpegCommand } from 'fluent-ffmpeg';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { VideoSource } from '../src/video/source.js';

const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZuX6kAAAAASUVORK5CYII=',
  'base64'
);

describe('VideoSource', () => {
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

  it('VideoSourceRecovery restarts command when stream stalls and cleans up processes', async () => {
    const commands: FakeCommand[] = [];
    const source = new VideoSource({
      file: 'noop',
      framesPerSecond: 1,
      idleTimeoutMs: 5,
      restartDelayMs: 5,
      forceKillTimeoutMs: 5,
      commandFactory: () => {
        const command = new FakeCommand();
        commands.push(command);
        return command as unknown as FfmpegCommand;
      }
    });

    const recoverReasons: string[] = [];
    source.on('recover', info => {
      recoverReasons.push(info.reason);
    });

    source.start();

    try {
      await waitFor(() => commands.length >= 2, 100);
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(recoverReasons).toContain('Stream stalled');
      expect(commands[0].killedSignals).toContain('SIGTERM');
      expect(commands[0].killedSignals).toContain('SIGKILL');
    } finally {
      source.stop();
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

    source.stop();
  });
});

class FakeCommand extends EventEmitter {
  public readonly killedSignals: NodeJS.Signals[] = [];
  public readonly stream: PassThrough;

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
