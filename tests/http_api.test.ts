import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { clearEvents, listEvents, storeEvent } from '../src/db.js';
import { startHttpServer, HttpServerRuntime } from '../src/server/http.js';

describe('RestApiEvents', () => {
  let runtime: HttpServerRuntime | null = null;
  let bus: EventEmitter;
  const snapshotDir = path.resolve('tmp-snapshots');

  beforeEach(() => {
    clearEvents();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.mkdirSync(snapshotDir, { recursive: true });
    bus = new EventEmitter();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
    clearEvents();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  });

  async function ensureServer() {
    if (!runtime) {
      runtime = await startHttpServer({ port: 0, bus });
    }
    return runtime;
  }

  it('HttpEventsCameraFilter filters by camera, channel, and time range', async () => {
    const now = Date.now();
    const snapshotPath = path.join(snapshotDir, 'sample.png');
    fs.writeFileSync(snapshotPath, Buffer.from([0, 1, 2, 3]));

    storeEvent({
      ts: now - 1000,
      source: 'cam-1',
      detector: 'motion',
      severity: 'warning',
      message: 'Motion started',
      meta: { snapshot: snapshotPath, channel: 'video:cam-1', camera: 'video:cam-1' }
    });
    storeEvent({
      ts: now - 500,
      source: 'video:test-camera',
      detector: 'motion',
      severity: 'info',
      message: 'Motion continuing',
      meta: { channel: 'video:cam-1', camera: 'video:test-camera' }
    });
    storeEvent({
      ts: now - 100,
      source: 'video:other-camera',
      detector: 'person',
      severity: 'critical',
      message: 'Person detected',
      meta: { channel: 'video:cam-2' }
    });

    const { port } = await ensureServer();

    const pageResponse = await fetch(`http://localhost:${port}/api/events?limit=2`);
    expect(pageResponse.status).toBe(200);
    const pagePayload = await pageResponse.json();

    expect(pagePayload.items).toHaveLength(2);
    expect(pagePayload.total).toBe(3);
    expect(pagePayload.items[0].detector).toBe('person');
    expect(pagePayload.items[1].detector).toBe('motion');

    const filterResponse = await fetch(`http://localhost:${port}/api/events?detector=motion`);
    expect(filterResponse.status).toBe(200);
    const filterPayload = await filterResponse.json();
    expect(filterPayload.items).toHaveLength(2);
    expect(filterPayload.items.every((item: { detector: string }) => item.detector === 'motion')).toBe(
      true
    );

    const channelResponse = await fetch(`http://localhost:${port}/api/events?channel=video:cam-1`);
    const channelPayload = await channelResponse.json();
    expect(channelPayload.items).toHaveLength(2);
    expect(channelPayload.items.every((item: { meta: { channel: string } }) => item.meta?.channel === 'video:cam-1')).toBe(
      true
    );

    const cameraResponse = await fetch(
      `http://localhost:${port}/api/events?camera=${encodeURIComponent('video:test-camera')}`
    );
    expect(cameraResponse.status).toBe(200);
    const cameraPayload = await cameraResponse.json();
    expect(cameraPayload.items).toHaveLength(1);
    expect(cameraPayload.items[0].source).toBe('video:test-camera');

    const from = new Date(now - 700).toISOString();
    const to = new Date(now - 200).toISOString();
    const rangeResponse = await fetch(
      `http://localhost:${port}/api/events?camera=${encodeURIComponent('video:test-camera')}&from=${encodeURIComponent(
        from
      )}&to=${encodeURIComponent(to)}`
    );
    const rangePayload = await rangeResponse.json();
    expect(rangePayload.items).toHaveLength(1);
    expect(rangePayload.items[0].source).toBe('video:test-camera');
  });

  it('serves snapshot files for events', async () => {
    const now = Date.now();
    const snapshotPath = path.join(snapshotDir, 'snapshot.png');
    fs.writeFileSync(snapshotPath, Buffer.from([0, 1, 2, 3]));

    storeEvent({
      ts: now - 10,
      source: 'cam-1',
      detector: 'motion',
      severity: 'warning',
      message: 'Motion detected',
      meta: { snapshot: snapshotPath }
    });

    const { port } = await ensureServer();

    const events = listEvents({ limit: 1 });
    const event = events.items[0];

    const response = await fetch(`http://localhost:${port}/api/events/${event.id}/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/image/);
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('DashboardStream streams events with heartbeat and stream-status metadata', async () => {
    const { port } = await ensureServer();
    const controller = new AbortController();

    const response = await fetch(`http://localhost:${port}/api/events/stream?camera=cam-stream&retry=2500`, {
      signal: controller.signal
    });
    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();

    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    const initialText = decoder.decode(firstChunk.value);
    expect(initialText).toContain(': connected');
    expect(initialText).toContain('retry: 2500');
    expect(initialText).toContain('stream-status');
    expect(initialText).toContain('cam-stream');

    const event = {
      id: 123,
      ts: Date.now(),
      source: 'cam-stream',
      detector: 'motion',
      severity: 'warning',
      message: 'stream event',
      meta: { channel: 'video:stream', camera: 'cam-stream' }
    };

    bus.emit('event', event);

    const payloadChunk = await readUntil(reader!, chunk => chunk.includes('data:'));
    expect(payloadChunk).toContain('stream event');

    controller.abort();
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (chunk: string) => boolean,
  timeoutMs = 2000
): Promise<string> {
  const decoder = new TextDecoder();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const text = decoder.decode(value);
    if (predicate(text)) {
      return text;
    }
  }
  throw new Error('Timed out waiting for stream chunk');
}
