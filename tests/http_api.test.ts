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

  it('returns paginated and filtered event lists', async () => {
    const now = Date.now();
    const snapshotPath = path.join(snapshotDir, 'sample.png');
    fs.writeFileSync(snapshotPath, Buffer.from([0, 1, 2, 3]));

    storeEvent({
      ts: now - 1000,
      source: 'cam-1',
      detector: 'motion',
      severity: 'warning',
      message: 'Motion started',
      meta: { snapshot: snapshotPath, channel: 'video:cam-1' }
    });
    storeEvent({
      ts: now - 500,
      source: 'cam-1',
      detector: 'motion',
      severity: 'info',
      message: 'Motion continuing',
      meta: { channel: 'video:cam-1' }
    });
    storeEvent({
      ts: now - 100,
      source: 'cam-2',
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

  it('DashboardStream streams events with heartbeat', async () => {
    const { port } = await ensureServer();
    const controller = new AbortController();

    const response = await fetch(`http://localhost:${port}/api/events/stream`, {
      signal: controller.signal
    });
    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();

    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(decoder.decode(firstChunk.value)).toContain(': connected');

    const event = {
      id: 123,
      ts: Date.now(),
      source: 'cam-stream',
      detector: 'motion',
      severity: 'warning',
      message: 'stream event',
      meta: { channel: 'video:stream' }
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
