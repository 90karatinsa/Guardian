import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { EventEmitter } from 'node:events';
import { clearEvents, listEvents, storeEvent } from '../src/db.js';
import { startHttpServer, type HttpServerRuntime, type HttpServerOptions } from '../src/server/http.js';
import metrics from '../src/metrics/index.js';

type StubFace = {
  id: number;
  label: string;
  createdAt: number;
  metadata?: Record<string, unknown> | null;
  embedding: number[];
};

class StubFaceRegistry {
  private identifyHandler: ((buffer: Buffer, threshold: number) => Promise<any> | any) | null = null;

  constructor(private readonly faces: StubFace[]) {}

  list() {
    return this.faces.map(face => ({ ...face }));
  }

  async enroll(_buffer: Buffer, label: string, metadata?: Record<string, unknown>) {
    const nextId = this.faces.length > 0 ? Math.max(...this.faces.map(face => face.id)) + 1 : 1;
    const record: StubFace = {
      id: nextId,
      label,
      createdAt: Date.now(),
      metadata: metadata ?? null,
      embedding: []
    };
    this.faces.push(record);
    return { ...record };
  }

  setIdentifyHandler(handler: (buffer: Buffer, threshold: number) => Promise<any> | any) {
    this.identifyHandler = handler;
  }

  async identify(buffer: Buffer, threshold: number) {
    if (this.identifyHandler) {
      return await this.identifyHandler(buffer, threshold);
    }
    return { embedding: [], match: null, threshold: Math.max(0, threshold), distance: null, unknown: true };
  }

  remove(id: number) {
    const index = this.faces.findIndex(face => face.id === id);
    if (index >= 0) {
      this.faces.splice(index, 1);
      return true;
    }
    return false;
  }
}

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
    metrics.reset();
  });

  async function ensureServer(overrides: Partial<HttpServerOptions> = {}) {
    if (!runtime) {
      runtime = await startHttpServer({ port: 0, bus, ...overrides });
    }
    return runtime;
  }

  it('HttpApiSnapshotListing surfaces summary, metrics, and snapshot URLs', async () => {
    const now = Date.now();
    const snapshotPath = path.join(snapshotDir, 'sample.png');
    fs.writeFileSync(snapshotPath, Buffer.from([0, 1, 2, 3]));
    const faceSnapshotPath = path.join(snapshotDir, 'face.png');
    fs.writeFileSync(faceSnapshotPath, Buffer.from([9, 9, 9, 9]));

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
      meta: { channel: 'video:cam-2', faceSnapshot: faceSnapshotPath }
    });

    const { port } = await ensureServer();

    const pageResponse = await fetch(`http://localhost:${port}/api/events?limit=2`);
    expect(pageResponse.status).toBe(200);
    const pagePayload = await pageResponse.json();

    expect(pagePayload.items).toHaveLength(2);
    expect(pagePayload.total).toBe(3);
    expect(pagePayload.items[0].detector).toBe('person');
    expect(pagePayload.items[1].detector).toBe('motion');
    expect(pagePayload.summary.channels.length).toBeGreaterThan(0);
    const personMeta = pagePayload.items[0].meta ?? {};
    expect(typeof personMeta.snapshotUrl === 'string' || personMeta.snapshotUrl === undefined).toBe(true);
    expect(personMeta.faceSnapshotUrl).toBe(`/api/events/${pagePayload.items[0].id}/face-snapshot`);
    expect(pagePayload.metrics).toBeTruthy();

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
    expect(snapshotPayload.items[0].meta?.snapshotUrl).toBe(`/api/events/${snapshotPayload.items[0].id}/snapshot`);
  });

  it('HttpEventsChannelFilter limits REST and SSE streams by channel', async () => {
    const now = Date.now();
    storeEvent({
      ts: now - 1000,
      source: 'video:lobby',
      detector: 'motion',
      severity: 'info',
      message: 'Lobby movement',
      meta: { channel: 'video:lobby' }
    });
    storeEvent({
      ts: now - 800,
      source: 'video:door',
      detector: 'motion',
      severity: 'warning',
      message: 'Door movement',
      meta: { channel: 'video:door' }
    });
    storeEvent({
      ts: now - 600,
      source: 'video:perimeter',
      detector: 'motion',
      severity: 'warning',
      message: 'Perimeter movement',
      meta: { channel: 'video:perimeter' }
    });

    const faces = [
      { id: 1, label: 'Lobby Face', createdAt: now - 500, metadata: { channel: 'video:lobby' }, embedding: [] },
      { id: 2, label: 'Door Face', createdAt: now - 400, metadata: { channel: 'video:door' }, embedding: [] },
      { id: 3, label: 'Perimeter Face', createdAt: now - 300, metadata: { channel: 'video:perimeter' }, embedding: [] }
    ];
    const registry = new StubFaceRegistry(faces as any);

    const { port } = await ensureServer({ faceRegistry: registry as any });

    const channelQuery = `channel=${encodeURIComponent('video:lobby')}&channel=${encodeURIComponent('video:door')}`;
    const restResponse = await fetch(`http://localhost:${port}/api/events?${channelQuery}`);
    expect(restResponse.status).toBe(200);
    const restPayload = await restResponse.json();
    expect(restPayload.items).toHaveLength(2);
    expect(
      restPayload.items.every((item: { meta?: { channel?: string } }) =>
        ['video:lobby', 'video:door'].includes(item.meta?.channel ?? '')
      )
    ).toBe(true);

    const controller = new AbortController();
    const streamResponse = await fetch(
      `http://localhost:${port}/api/events/stream?faces=1&${channelQuery}`,
      { signal: controller.signal }
    );
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let buffer = '';
    const receivedEvents: unknown[] = [];
    const metricsEvents: unknown[] = [];
    let facesPayload: any = null;

    const readPromise = new Promise<void>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }

      const processChunk = (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          const lines = block.split('\n');
          let eventName = 'message';
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            }
          }
          if (dataLines.length === 0) {
            continue;
          }
          const dataText = dataLines.join('\n');
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataText);
          } catch (error) {
            reject(error);
            return;
          }

          if (eventName === 'faces') {
            facesPayload = parsed;
          } else if (eventName === 'metrics') {
            metricsEvents.push(parsed);
          } else if (eventName !== 'stream-status' && eventName !== 'heartbeat') {
            receivedEvents.push(parsed);
          }

          if (facesPayload && receivedEvents.length >= 1 && metricsEvents.length >= 1) {
            resolve();
            return;
          }
        }
      };

      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            processChunk(decoder.decode(value, { stream: true }));
            readNext();
          })
          .catch(reject);
      };

      readNext();
    });

    bus.emit('event', {
      ts: now - 200,
      source: 'video:lobby',
      detector: 'motion',
      severity: 'info',
      message: 'Lobby follow-up',
      meta: { channel: 'video:lobby' }
    });

    bus.emit('event', {
      ts: now - 100,
      source: 'video:perimeter',
      detector: 'motion',
      severity: 'warning',
      message: 'Perimeter follow-up',
      meta: { channel: 'video:perimeter' }
    });

    await readPromise;
    controller.abort();

    expect(receivedEvents).toHaveLength(1);
    const streamed = receivedEvents[0] as { meta?: { channel?: string } };
    expect(streamed.meta?.channel).toBe('video:lobby');
    expect(metricsEvents.length).toBeGreaterThan(0);
    const metricsDigest = metricsEvents[0] as { pipelines?: { ffmpeg?: { channels?: unknown[] } } };
    expect(Array.isArray(metricsDigest.pipelines?.ffmpeg?.channels)).toBe(true);
    expect(facesPayload?.faces?.length).toBe(2);
    expect(facesPayload?.threshold).toBeCloseTo(0.5, 5);
    expect(
      Array.isArray(facesPayload?.faces) &&
        facesPayload.faces.every((face: { metadata?: { channel?: string } }) =>
          ['video:lobby', 'video:door'].includes(face.metadata?.channel ?? '')
        )
    ).toBe(true);
  });

  it('HttpMetricsStream returns pipeline metrics snapshot', async () => {
    metrics.reset();
    metrics.recordPipelineRestart('ffmpeg', 'spawn-error', { channel: 'video:lobby' });
    metrics.recordPipelineRestart('audio', 'watchdog-timeout', { channel: 'audio:mic' });
    metrics.recordRetentionRun({
      removedEvents: 2,
      archivedSnapshots: 3,
      prunedArchives: 1,
      perCamera: {
        lobby: { archivedSnapshots: 2, prunedArchives: 1 },
        global: { archivedSnapshots: 1, prunedArchives: 0 }
      }
    });

    const { port } = await ensureServer();
    const response = await fetch(`http://localhost:${port}/api/metrics/pipelines`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.pipelines.ffmpeg.restarts).toBe(1);
    expect(payload.pipelines.ffmpeg.byChannel['video:lobby'].restarts).toBe(1);
    expect(payload.pipelines.audio.restarts).toBe(1);
    expect(payload.retention.totals.archivedSnapshots).toBe(3);
    expect(payload.retention.totalsByCamera.lobby.archivedSnapshots).toBe(2);
  });

  it('HttpApiSnapshotDelivery handles snapshot errors and streams face registry results', async () => {
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

    const faces = [
      {
        id: 7,
        label: 'Lobby Guard',
        createdAt: Date.now() - 1_000,
        metadata: { camera: 'video:lobby' },
        embedding: []
      }
    ];

    const stubRegistry = new StubFaceRegistry(faces);

    const { port } = await ensureServer({ faceRegistry: stubRegistry as any });

    const events = listEvents({ limit: 1 });
    const event = events.items[0];

    const response = await fetch(`http://localhost:${port}/api/events/${event.id}/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/image/);
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);

    const invalidId = await fetch(`http://localhost:${port}/api/events/not-a-number/snapshot`);
    expect(invalidId.status).toBe(400);

    const missingEvent = await fetch(`http://localhost:${port}/api/events/${event.id + 999}/snapshot`);
    expect(missingEvent.status).toBe(404);

    fs.rmSync(snapshotPath);
    const missingFile = await fetch(`http://localhost:${port}/api/events/${event.id}/snapshot`);
    expect(missingFile.status).toBe(404);

    const controller = new AbortController();
    const facesResponse = await fetch(
      `http://localhost:${port}/api/events/stream?faces=${encodeURIComponent('Lobby')}`,
      {
        signal: controller.signal
      }
    );

    expect(facesResponse.status).toBe(200);
    const reader = facesResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let payload: unknown = null;
    let bufferText = '';

    await new Promise<void>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }

      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }

            bufferText += decoder.decode(value, { stream: true });
            const match = bufferText.match(/event: faces\ndata: ([^\n]+)\n\n/);
            if (match) {
              payload = JSON.parse(match[1]);
              resolve();
              return;
            }

            readNext();
          })
          .catch(reject);
      };

      readNext();
    });

    controller.abort();
    expect(payload && typeof payload === 'object').toBe(true);
    const facesPayload = payload as { faces: Array<{ label: string }>; count: number; query: string };
    expect(facesPayload.count).toBe(1);
    expect(facesPayload.query).toBe('Lobby');
    expect(facesPayload.faces[0]?.label).toBe('Lobby Guard');
    expect((facesPayload as any).threshold).toBeCloseTo(0.5, 5);
  });

  it('FaceRegistryRestIntegration returns thresholds and unknown flags', async () => {
    const faces: StubFace[] = [
      { id: 1, label: 'Guard', createdAt: Date.now(), metadata: { camera: 'video:lobby' }, embedding: [] }
    ];

    const stubRegistry = new StubFaceRegistry(faces);
    const identifyMock = vi.fn((_: Buffer, threshold: number) => {
      const normalized = Math.max(0, threshold);
      if (normalized <= 0.2) {
        return {
          embedding: [0.1, 0.2],
          match: { face: faces[0], distance: 0.12 },
          threshold: normalized,
          distance: 0.12,
          unknown: false
        };
      }
      return {
        embedding: [0.3, 0.4],
        match: null,
        threshold: normalized,
        distance: null,
        unknown: true
      };
    });
    stubRegistry.setIdentifyHandler(identifyMock);

    const { port } = await ensureServer({ faceRegistry: stubRegistry as any });

    const facesResponse = await fetch(`http://localhost:${port}/api/faces`);
    expect(facesResponse.status).toBe(200);
    const facesPayload = await facesResponse.json();
    expect(facesPayload.threshold).toBeCloseTo(0.5, 5);
    expect(facesPayload.faces).toHaveLength(1);

    const image = Buffer.from([1, 2, 3, 4]).toString('base64');
    const identifyResponse = await fetch(`http://localhost:${port}/api/faces/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, threshold: 0.1 })
    });
    expect(identifyResponse.status).toBe(200);
    const identifyPayload = await identifyResponse.json();
    expect(identifyPayload.threshold).toBeCloseTo(0.1, 5);
    expect(identifyPayload.unknown).toBe(false);
    expect(identifyPayload.distance).toBeCloseTo(0.12, 5);
    expect(identifyPayload.match.face.label).toBe('Guard');

    const unknownResponse = await fetch(`http://localhost:${port}/api/faces/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, threshold: 0.4 })
    });
    expect(unknownResponse.status).toBe(200);
    const unknownPayload = await unknownResponse.json();
    expect(unknownPayload.unknown).toBe(true);
    expect(unknownPayload.match).toBeNull();
    expect(identifyMock).toHaveBeenCalledTimes(2);
  });

  it('DashboardChannelFilter updates widget counts on SSE events', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalEventSource = globalThis.EventSource;
    const originalFetch = globalThis.fetch;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalMessageEvent = globalThis.MessageEvent;
    const originalNavigator = globalThis.navigator;

    const { JSDOM } = await import(/* @vite-ignore */ 'jsdom');
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

    const metricsSnapshot = {
      fetchedAt: new Date(1700000000000).toISOString(),
      pipelines: {
        ffmpeg: {
          restarts: 2,
          lastRestartAt: new Date(1700000000400).toISOString(),
          byReason: { 'watchdog-timeout': 2 },
          lastRestart: { reason: 'watchdog-timeout' },
          attempts: {},
          byChannel: {
            'video:lobby': {
              restarts: 2,
              lastRestartAt: new Date(1700000000400).toISOString(),
              byReason: { 'watchdog-timeout': 2 },
              lastRestart: { reason: 'watchdog-timeout' }
            }
          },
          deviceDiscovery: {},
          deviceDiscoveryByChannel: {},
          delayHistogram: {},
          attemptHistogram: {}
        },
        audio: {
          restarts: 1,
          lastRestartAt: null,
          byReason: { 'spawn-error': 1 },
          lastRestart: { reason: 'spawn-error' },
          attempts: {},
          byChannel: {},
          deviceDiscovery: {},
          deviceDiscoveryByChannel: {},
          delayHistogram: {},
          attemptHistogram: {}
        }
      },
      retention: {
        runs: 1,
        lastRunAt: new Date(1700000000200).toISOString(),
        warnings: 0,
        warningsByCamera: {},
        lastWarning: null,
        totals: { removedEvents: 0, archivedSnapshots: 2, prunedArchives: 0 },
        totalsByCamera: {
          lobby: { archivedSnapshots: 1, prunedArchives: 0 },
          stream: { archivedSnapshots: 1, prunedArchives: 0 }
        }
      }
    };

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? '';
      if (url.includes('/api/events')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 1,
                ts: 1700000000100,
                source: 'video:lobby',
                detector: 'motion',
                severity: 'warning',
                message: 'initial event',
                meta: { channel: 'video:lobby', camera: 'video:lobby', snapshot: '/snapshots/1.jpg' }
              }
            ],
            total: 1
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200
          }
        );
      }

      if (url.includes('/api/metrics/pipelines')) {
        return new Response(JSON.stringify(metricsSnapshot), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }

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
    await vi.waitFor(() => {
      const state = (window as any).__guardianDashboardState;
      if (!state) throw new Error('dashboard state unavailable');
      expect(Array.isArray(state.events) && state.events.length > 0).toBe(true);
    });

    const instance = MockEventSource.instances[0];
    expect(instance).toBeDefined();
    instance!.open();

    instance!.dispatch('stream-status', JSON.stringify({ status: 'connected', retryMs: 1500 }));
    instance!.dispatch('heartbeat', JSON.stringify({ ts: 1700000000000 }));
    instance!.dispatch('faces', JSON.stringify({
      status: 'ok',
      query: null,
      faces: [
        { id: 1, label: 'Lobby Guard', metadata: { camera: 'video:lobby' } },
        { id: 2, label: 'Backdoor', metadata: { camera: 'video:backdoor' } }
      ]
    }));
    const eventPayload = {
      id: 42,
      ts: 1700000000500,
      source: 'cam-stream',
      detector: 'motion',
      severity: 'warning',
      message: 'stream event',
      meta: { channel: 'video:stream', camera: 'cam-stream', snapshot: '/snapshots/42.jpg' }
    };
    instance!.emitMessage(JSON.stringify(eventPayload));

    const channelChips = window.document.querySelectorAll('#channel-filter input[type="checkbox"]');
    expect(channelChips.length).toBeGreaterThan(0);
    const streamChannelInput = window.document.querySelector(
      '#channel-filter input[value="video:stream"]'
    ) as HTMLInputElement | null;
    expect(streamChannelInput).not.toBeNull();
    streamChannelInput!.checked = true;
    streamChannelInput!.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    instance!.emitMessage(
      JSON.stringify({
        id: 43,
        ts: 1700000000600,
        source: 'video:other',
        detector: 'motion',
        severity: 'warning',
        message: 'other channel',
        meta: { channel: 'video:lobby', camera: 'video:lobby', snapshot: '/snapshots/43.jpg' }
      })
    );

    const stateText = window.document.getElementById('stream-state')?.textContent;
    expect(stateText).toBe('Connected');
    expect(window.document.getElementById('stream-heartbeats')?.textContent).toBe('1');
    expect(window.document.getElementById('stream-events')?.textContent).toBe('2');
    const updatedText = window.document.getElementById('stream-updated')?.textContent ?? '';
    expect(updatedText).not.toBe('—');

    const dashboardState = (window as any).__guardianDashboardState;
    expect(dashboardState).toBeTruthy();
    expect(Array.from(dashboardState.filters.channels)).toContain('video:stream');

    const eventCards = window.document.querySelectorAll('#events .event');
    expect(eventCards.length).toBe(1);
    expect(eventCards[0].textContent).toContain('stream event');

    await vi.waitFor(() => {
      const metricsWidget = window.document.getElementById('pipeline-metrics');
      if (!metricsWidget) {
        throw new Error('metrics widget not ready');
      }
      const content = metricsWidget.textContent ?? '';
      expect(content.includes('Video streams')).toBe(true);
      expect(content.includes('lobby')).toBe(true);
      expect(content.includes('Retention')).toBe(true);
    });

    const previewImg = window.document.getElementById('preview-image') as HTMLImageElement;
    expect(previewImg.src).toContain('/api/events/42/snapshot');
    expect(previewImg.dataset.channel).toBe('video:stream');

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

