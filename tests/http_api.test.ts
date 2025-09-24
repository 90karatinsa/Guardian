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
      meta: { snapshot: snapshotPath }
    });
    storeEvent({
      ts: now - 500,
      source: 'cam-1',
      detector: 'motion',
      severity: 'info',
      message: 'Motion continuing',
      meta: {}
    });
    storeEvent({
      ts: now - 100,
      source: 'cam-2',
      detector: 'person',
      severity: 'critical',
      message: 'Person detected',
      meta: {}
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
});
