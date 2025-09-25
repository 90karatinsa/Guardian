import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
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

    const searchResponse = await fetch(`http://localhost:${port}/api/events?search=person`);
    const searchPayload = await searchResponse.json();
    expect(searchPayload.items).toHaveLength(1);
    expect(searchPayload.items[0].message).toContain('Person');

    const snapshotResponse = await fetch(`http://localhost:${port}/api/events?snapshot=with`);
    const snapshotPayload = await snapshotResponse.json();
    expect(snapshotPayload.items).toHaveLength(1);
    expect(snapshotPayload.items[0].meta?.snapshot).toBe(snapshotPath);
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

  it('HttpDashboardStream updates widget counts on SSE events', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalEventSource = globalThis.EventSource;
    const originalFetch = globalThis.fetch;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalMessageEvent = globalThis.MessageEvent;
    const originalNavigator = globalThis.navigator;

    const html = fs.readFileSync(path.resolve('public/index.html'), 'utf-8');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    const { window } = dom;

    globalThis.window = window as unknown as typeof globalThis.window;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: window.document
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: window.navigator
    });
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.MessageEvent = window.MessageEvent;

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    type Listener = (event: MessageEvent) => void;
    class MockEventSource {
      static instances: MockEventSource[] = [];
      public url: string;
      public readyState = 0;
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent) => void) | null = null;
      public onerror: ((event: Event) => void) | null = null;
      private listeners = new Map<string, Set<Listener>>();

      constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
      }

      addEventListener(type: string, handler: Listener) {
        const set = this.listeners.get(type) ?? new Set<Listener>();
        set.add(handler);
        this.listeners.set(type, set);
      }

      removeEventListener(type: string, handler: Listener) {
        this.listeners.get(type)?.delete(handler);
      }

      dispatch(type: string, data: unknown) {
        const payload = new window.MessageEvent(type, { data } as MessageEventInit);
        this.listeners.get(type)?.forEach(listener => listener(payload));
      }

      emitMessage(data: string) {
        this.onmessage?.(new window.MessageEvent('message', { data }));
      }

      open() {
        this.onopen?.(new window.Event('open'));
      }

      close() {
        this.readyState = 2;
      }
    }

    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    await import('../public/dashboard.js');
    await Promise.resolve();

    const instance = MockEventSource.instances[0];
    expect(instance).toBeDefined();
    instance!.open();

    instance!.dispatch('stream-status', JSON.stringify({ status: 'connected', retryMs: 1500 }));
    instance!.dispatch('heartbeat', JSON.stringify({ ts: 1700000000000 }));
    const eventPayload = {
      id: 42,
      ts: 1700000000500,
      source: 'cam-stream',
      detector: 'motion',
      severity: 'warning',
      message: 'stream event',
      meta: { channel: 'video:stream', camera: 'cam-stream' }
    };
    instance!.emitMessage(JSON.stringify(eventPayload));

    const stateText = window.document.getElementById('stream-state')?.textContent;
    expect(stateText).toBe('Connected');
    expect(window.document.getElementById('stream-heartbeats')?.textContent).toBe('1');
    expect(window.document.getElementById('stream-events')?.textContent).toBe('1');
    const updatedText = window.document.getElementById('stream-updated')?.textContent ?? '';
    expect(updatedText).not.toBe('—');

    const eventCards = window.document.querySelectorAll('#events .event');
    expect(eventCards.length).toBe(1);
    expect(eventCards[0].textContent).toContain('stream event');

    await new Promise(resolve => setTimeout(resolve, 0));

    instance?.close();
    MockEventSource.instances.length = 0;
    dom.window.close();
    vi.unstubAllGlobals();

    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error cleanup for test environment
      delete globalThis.window;
    }
    if (originalDocument) {
      globalThis.document = originalDocument;
    } else {
      // @ts-expect-error cleanup for test environment
      delete globalThis.document;
    }
    if (originalEventSource) {
      globalThis.EventSource = originalEventSource;
    }
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    if (originalHTMLElement) {
      globalThis.HTMLElement = originalHTMLElement;
    }
    if (originalMessageEvent) {
      globalThis.MessageEvent = originalMessageEvent;
    }
    if (originalNavigator) {
      globalThis.navigator = originalNavigator;
    } else {
      // @ts-expect-error cleanup for navigator in node environment
      delete globalThis.navigator;
    }
  });
});

