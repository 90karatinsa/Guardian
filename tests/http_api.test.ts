import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TextDecoder } from 'node:util';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { PNG } from 'pngjs';
import { clearEvents, listEvents, storeEvent } from '../src/db.js';
import { startHttpServer, type HttpServerRuntime, type HttpServerOptions } from '../src/server/http.js';
import metrics, { MetricsRegistry } from '../src/metrics/index.js';
import { createEventsRouter } from '../src/server/routes/events.js';
import { EventBus } from '../src/eventBus.js';

const dashboardScriptSource = fs.readFileSync(path.resolve('public/dashboard.js'), 'utf-8');
const dashboardScriptTranspiled = ts.transpileModule(dashboardScriptSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020
  },
  fileName: 'public/dashboard.ts'
}).outputText;

function bootstrapDashboardScript() {
  if (!globalThis.window) {
    throw new Error('window is not defined');
  }

  Reflect.deleteProperty(globalThis.window as any, '__guardianDashboardState');
  globalThis.window.eval(dashboardScriptTranspiled);
}

class StubIncomingMessage extends EventEmitter {
  method = 'GET';
  url: string;
  headers: Record<string, string> = {};

  constructor(url: string) {
    super();
    this.url = url;
  }
}

class StubServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  headers: Record<string, string> = {};

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headersSent = true;
    this.headers = { ...headers };
  }

  write(_chunk: any) {
    return true;
  }

  end(_chunk?: any) {
    this.writableEnded = true;
    this.emit('finish');
  }
}

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
      const { snapshotDirs: overrideSnapshotDirs, ...rest } = overrides;
      runtime = await startHttpServer({
        port: 0,
        bus,
        snapshotDirs: overrideSnapshotDirs ?? [snapshotDir],
        ...rest
      });
    }
    return runtime;
  }

  it('HttpApiChannelSnapshots surfaces summary, metrics, and snapshot URLs', async () => {
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

    const normalizedResponse = await fetch(`http://localhost:${port}/api/events/snapshots?channels=cam-1`);
    expect(normalizedResponse.status).toBe(200);
    const normalizedPayload = await normalizedResponse.json();
    expect(normalizedPayload.items.every((item: { meta: { resolvedChannels?: string[] } }) =>
      Array.isArray(item.meta?.resolvedChannels) && item.meta.resolvedChannels.includes('video:cam-1')
    )).toBe(true);
    const channelIds = new Set((normalizedPayload.summary?.channels ?? []).map((entry: { id: string }) => entry.id));
    expect(channelIds.has('video:cam-1')).toBe(true);

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

  it('HttpDashboardAssetsResolveChannelUtils serves dashboard asset and streams metrics', async () => {
    metrics.recordRetentionRun({
      removedEvents: 1,
      archivedSnapshots: 0,
      prunedArchives: 0,
      diskSavingsBytes: 0,
      perCamera: { 'video:cam-asset': { archivedSnapshots: 0, prunedArchives: 0 } }
    });

    const { port } = await ensureServer();

    const assetResponse = await fetch(`http://localhost:${port}/dashboard.js`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('application/javascript');
    const assetContent = await assetResponse.text();
    expect(assetContent.includes("from '../src/utils/channel.js'"))
      .toBe(false);
    expect(assetContent.includes('function normalizeChannelId')).toBe(true);

    const controller = new AbortController();
    const streamResponse = await fetch(`http://localhost:${port}/api/events/stream?metrics=retention`, {
      signal: controller.signal
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const metricsPayload = await new Promise<any>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readChunk = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new Error('stream ended before metrics arrived'));
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (eventName === 'metrics' && dataLines.length > 0) {
                resolve(JSON.parse(dataLines.join('')));
                return;
              }
            }
            readChunk();
          })
          .catch(reject);
      };
      readChunk();
    });

    controller.abort();
    await reader?.cancel().catch(() => undefined);

    expect(metricsPayload).toBeDefined();
    expect(metricsPayload.retention?.totals?.removedEvents).toBeGreaterThanOrEqual(1);
    expect(Object.keys(metricsPayload).sort()).toEqual(['fetchedAt', 'retention']);
  });

  it('DashboardResponsiveLayout exposes responsive markup and breakpoint-aware layout controls', async () => {
    const { port } = await ensureServer();

    const indexResponse = await fetch(`http://localhost:${port}/`);
    expect(indexResponse.status).toBe(200);
    const html = await indexResponse.text();

    expect(html).toContain('class="dashboard dashboard-grid"');
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain('class="dashboard-card stream-widget"');
    expect(html).toContain('class="dashboard-card preview-panel"');
    expect(html).toContain('role="group"');

    expect(dashboardScriptSource).toContain('const LAYOUT_BREAKPOINTS');
    expect(dashboardScriptSource).toContain('matchMedia(');
    expect(dashboardScriptSource).toContain('dataset.layout');
  });

  it('HttpStaticHeadRequest serves dashboard assets without body for HEAD requests', async () => {
    const { port } = await ensureServer();

    const response = await fetch(`http://localhost:${port}/dashboard.js`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    const body = await response.text();
    expect(body).toBe('');
  });

  it('HttpStaticSvgContentType serves SVG assets with image/svg+xml type', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-svg-'));
    const svgPath = path.join(tempDir, 'icon.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');

    try {
      const { port } = await ensureServer({ staticDir: tempDir });

      const response = await fetch(`http://localhost:${port}/icon.svg`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/svg+xml');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('HttpApiChannelFiltersWithoutManualMeta streams and lists enriched events', async () => {
    const busLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const eventBus = new EventBus({ store: event => storeEvent(event), log: busLogger as any, metrics });
    bus = eventBus;

    const snapshotPath = path.join(snapshotDir, 'auto.png');
    fs.writeFileSync(snapshotPath, Buffer.from([7, 7, 7, 7]));

    const { port } = await ensureServer();

    const controller = new AbortController();
    const streamResponse = await fetch(
      `http://localhost:${port}/api/events/stream?channels=video:cam-1`,
      { signal: controller.signal }
    );
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const messages: any[] = [];
    const streamPromise = new Promise<void>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new Error('stream ended before event payload'));
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              if (!chunk) {
                continue;
              }
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith(':')) {
                  continue;
                }
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (dataLines.length === 0) {
                continue;
              }
              if (eventName === 'stream-status' || eventName === 'metrics') {
                continue;
              }
              try {
                const payload = JSON.parse(dataLines.join('\n'));
                if (payload && typeof payload === 'object' && 'meta' in payload) {
                  messages.push(payload);
                  resolve();
                  return;
                }
              } catch (error) {
                reject(error as Error);
                return;
              }
              readNext();
            }
            readNext();
          })
          .catch(reject);
      };
      readNext();
    });

    eventBus.emitEvent({
      ts: Date.now(),
      source: 'video:cam-1',
      detector: 'motion',
      severity: 'warning',
      message: 'auto-generated',
      meta: { snapshot: snapshotPath }
    });

    await streamPromise;
    controller.abort();

    expect(messages).toHaveLength(1);
    const streamed = messages[0];
    expect(streamed.meta?.channel).toBe('video:cam-1');
    expect(streamed.meta?.camera).toBe('video:cam-1');

    await vi.waitFor(() => listEvents({ channel: 'video:cam-1', limit: 1 }).total === 1);

    const restResponse = await fetch(`http://localhost:${port}/api/events?channel=video:cam-1`);
    expect(restResponse.status).toBe(200);
    const restPayload = await restResponse.json();
    expect(restPayload.items).toHaveLength(1);
    const stored = restPayload.items[0];
    expect(stored.meta?.channel).toBe('video:cam-1');
    expect(stored.meta?.camera).toBe('video:cam-1');
    expect(stored.meta?.snapshotUrl).toBe(`/api/events/${stored.id}/snapshot`);
  });

  it('HttpApiStreamRetryBounds clamps retry seconds to 1-60 and emits retry line', async () => {
    const router = createEventsRouter({ bus: new EventEmitter() });
    const decoder = new TextDecoder();

    class RecordingResponse extends StubServerResponse {
      chunks: string[] = [];

      write(chunk: any) {
        const value = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
        this.chunks.push(value);
        return true;
      }
    }

    const collectRetryLine = (query: string) => {
      const request = new StubIncomingMessage(`/api/events/stream${query}`);
      const response = new RecordingResponse();

      const handled = router.handle(
        request as unknown as import('node:http').IncomingMessage,
        response as unknown as import('node:http').ServerResponse
      );
      expect(handled).toBe(true);
      expect(response.headers['Content-Type']).toBe('text/event-stream');

      const retryLine = response.chunks.find(chunk => chunk.startsWith('retry:')) ?? '';

      request.emit('close');
      response.emit('close');
      return retryLine.trim();
    };

    expect(collectRetryLine('?retry=0.5')).toBe('retry: 1000');
    expect(collectRetryLine('?retry=90')).toBe('retry: 60000');
    expect(collectRetryLine('?retry=15')).toBe('retry: 15000');
    expect(collectRetryLine('?retryMs=2500')).toBe('retry: 2500');

    router.close();
  });

  it('HttpEventStreamHeartbeatUnref unrefs and clears the heartbeat timer on close', () => {
    const router = createEventsRouter({ bus: new EventEmitter() });
    const fakeTimer = {
      unref: vi.fn(),
      ref: vi.fn(),
      hasRef: vi.fn()
    } as unknown as NodeJS.Timeout;

    const intervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation((...args: Parameters<typeof setInterval>) => {
        const [handler, timeout] = args;
        expect(typeof handler).toBe('function');
        expect(timeout).toBe(15000);
        return fakeTimer;
      });
    const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});

    const request = new StubIncomingMessage('/api/events/stream?metrics=none');
    const response = new StubServerResponse();

    try {
      const handled = router.handle(
        request as unknown as import('node:http').IncomingMessage,
        response as unknown as import('node:http').ServerResponse
      );

      expect(handled).toBe(true);
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(fakeTimer.unref).toHaveBeenCalledTimes(1);

      request.emit('close');
      response.emit('close');

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    } finally {
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
      router.close();
    }
  });

  it('HttpApiSnapshotAllowlist denies ../etc/passwd style inputs', async () => {
    const now = Date.now();
    storeEvent({
      ts: now,
      source: 'video:test-camera',
      detector: 'motion',
      severity: 'info',
      message: 'Traversal attempt',
      meta: { snapshot: '../etc/passwd' }
    });
    const firstId = listEvents({ limit: 1 }).items[0].id;

    storeEvent({
      ts: now + 1,
      source: 'video:test-camera',
      detector: 'person',
      severity: 'warning',
      message: 'Traversal face attempt',
      meta: { faceSnapshot: '../../etc/shadow' }
    });
    const secondId = listEvents({ limit: 1 }).items[0].id;

    const { port } = await ensureServer();

    const snapshotResponse = await fetch(
      `http://localhost:${port}/api/events/${firstId}/snapshot`
    );
    expect(snapshotResponse.status).toBe(403);
    const snapshotPayload = await snapshotResponse.json();
    expect(snapshotPayload.error).toContain('not authorized');

    const faceResponse = await fetch(
      `http://localhost:${port}/api/events/${secondId}/face-snapshot`
    );
    expect(faceResponse.status).toBe(403);
    const facePayload = await faceResponse.json();
    expect(facePayload.error).toContain('not authorized');
  });

  it('HttpSnapshotDiffDimensionMismatch returns a conflict response with explanation', async () => {
    const now = Date.now();
    const baseline = new PNG({ width: 2, height: 2 });
    baseline.data.fill(10);
    const baselinePath = path.join(snapshotDir, 'baseline.png');
    fs.writeFileSync(baselinePath, PNG.sync.write(baseline));

    const current = new PNG({ width: 3, height: 2 });
    current.data.fill(20);
    const currentPath = path.join(snapshotDir, 'current.png');
    fs.writeFileSync(currentPath, PNG.sync.write(current));

    storeEvent({
      ts: now,
      source: 'video:test-camera',
      detector: 'motion',
      severity: 'info',
      message: 'Mismatch diff test',
      meta: { snapshot: currentPath, snapshotBaseline: baselinePath }
    });
    const eventId = listEvents({ limit: 1 }).items[0].id;

    const { port } = await ensureServer();

    const response = await fetch(
      `http://localhost:${port}/api/events/${eventId}/snapshot/diff`
    );
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error).toBe('Snapshot dimensions do not match');
  });

  it('HttpApiChannelNormalizationSupportsAudio', async () => {
    const now = Date.now();
    storeEvent({
      ts: now - 200,
      source: 'audio:Lobby',
      detector: 'audio-anomaly',
      severity: 'warning',
      message: 'Raised noise level',
      meta: { channel: 'Audio:Lobby' }
    });
    storeEvent({
      ts: now - 100,
      source: 'video:cam-1',
      detector: 'motion',
      severity: 'info',
      message: 'Motion event',
      meta: { channel: 'video:cam-1' }
    });

    const { port } = await ensureServer();

    const prefixlessResponse = await fetch(`http://localhost:${port}/api/events?channel=lobby`);
    expect(prefixlessResponse.status).toBe(200);
    const prefixlessPayload = await prefixlessResponse.json();
    expect(prefixlessPayload.items).toHaveLength(1);
    const audioMeta = prefixlessPayload.items[0].meta ?? {};
    expect(Array.isArray(audioMeta.resolvedChannels)).toBe(true);
    expect(audioMeta.resolvedChannels).toContain('audio:lobby');
    const prefixlessSummaryChannels = new Set(
      (prefixlessPayload.summary?.channels ?? []).map((entry: { id: string }) => entry.id)
    );
    expect(prefixlessSummaryChannels.has('audio:lobby')).toBe(true);

    const casedResponse = await fetch(`http://localhost:${port}/api/events?channel=AUDIO:LOBBY`);
    expect(casedResponse.status).toBe(200);
    const casedPayload = await casedResponse.json();
    expect(casedPayload.items).toHaveLength(1);
    expect((casedPayload.items[0].meta?.resolvedChannels ?? [])).toContain('audio:lobby');
  });

  it('HttpApiSnapshotFaces filters snapshot listings, faces, and SSE metrics selections', async () => {
    const now = Date.now();
    const snapshotA = path.join(snapshotDir, 'snap-a.png');
    const snapshotB = path.join(snapshotDir, 'snap-b.png');
    const faceSnap = path.join(snapshotDir, 'face-a.png');
    fs.writeFileSync(snapshotA, Buffer.from([1, 2, 3]));
    fs.writeFileSync(snapshotB, Buffer.from([4, 5, 6]));
    fs.writeFileSync(faceSnap, Buffer.from([7, 8, 9]));

    storeEvent({
      ts: now - 400,
      source: 'video:alpha',
      detector: 'motion',
      severity: 'warning',
      message: 'alpha motion',
      meta: { channel: 'video:alpha', snapshot: snapshotA, faceSnapshot: faceSnap }
    });
    storeEvent({
      ts: now - 200,
      source: 'video:beta',
      detector: 'motion',
      severity: 'info',
      message: 'beta motion',
      meta: { channel: 'video:beta', snapshot: snapshotB }
    });

    const { port } = await ensureServer();

    const listingResponse = await fetch(`http://localhost:${port}/api/events/snapshots?limit=5`);
    expect(listingResponse.status).toBe(200);
    const listingPayload = await listingResponse.json();
    expect(listingPayload.items.length).toBeGreaterThanOrEqual(2);
    const firstItem = listingPayload.items.find((item: any) => item.meta?.channel === 'video:alpha');
    expect(firstItem?.meta?.faceSnapshotUrl).toBe(`/api/events/${firstItem?.id}/face-snapshot`);

    const faceFiltered = await fetch(`http://localhost:${port}/api/events/snapshots?faceSnapshot=with`);
    const faceFilteredPayload = await faceFiltered.json();
    expect(faceFilteredPayload.items).toHaveLength(1);
    expect(faceFilteredPayload.items[0]?.meta?.channel).toBe('video:alpha');

    const facesResponse = await fetch(
      `http://localhost:${port}/api/faces?channel=${encodeURIComponent('video:alpha')}`
    );
    expect(facesResponse.status).toBe(200);
    const facesPayload = await facesResponse.json();
    expect(Array.isArray(facesPayload.faces)).toBe(true);
    expect(facesPayload.faces.every((face: { metadata?: { channel?: string } }) => face.metadata?.channel === 'video:alpha')).toBe(
      true
    );

    const controller = new AbortController();
    const streamResponse = await fetch(
      `http://localhost:${port}/api/events/stream?metrics=audio&faces=0`,
      { signal: controller.signal }
    );
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const metricsEvents: any[] = [];
    const readMetrics = new Promise<void>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (eventName === 'metrics' && dataLines.length > 0) {
                metricsEvents.push(JSON.parse(dataLines.join('')));
                resolve();
                return;
              }
            }
            readNext();
          })
          .catch(reject);
      };
      readNext();
    });

    await readMetrics;
    controller.abort();
    expect(metricsEvents).toHaveLength(1);
    const firstMetrics = metricsEvents[0];
    expect(firstMetrics.pipelines?.audio?.restarts).toBeDefined();
    expect(firstMetrics.pipelines?.ffmpeg).toBeUndefined();
    expect(firstMetrics.events).toBeUndefined();

    const noneController = new AbortController();
    const noneResponse = await fetch(`http://localhost:${port}/api/events/stream?metrics=none`, {
      signal: noneController.signal
    });
    const noneReader = noneResponse.body?.getReader();
    expect(noneReader).toBeDefined();
    const firstChunk = await noneReader!.read();
    const chunkText = decoder.decode(firstChunk.value ?? new Uint8Array());
    expect(chunkText.includes('event: metrics')).toBe(false);
    noneController.abort();
  });

  it('HttpSseResponseErrorCleanup clears clients when streams error', async () => {
    const router = createEventsRouter({
      bus: new EventEmitter(),
      metrics: new MetricsRegistry(),
      snapshotDirs: []
    });

    const clients = (router as unknown as { clients: Map<any, any> }).clients;
    expect(clients.size).toBe(0);

    const createStream = () => {
      const request = new StubIncomingMessage('/api/events/stream?metrics=none');
      const response = new StubServerResponse();
      const handled = router.handle(
        request as unknown as import('node:http').IncomingMessage,
        response as unknown as import('node:http').ServerResponse
      );
      expect(handled).toBe(true);
      return { request, response };
    };

    const first = createStream();
    expect(clients.size).toBe(1);
    first.response.emit('error', new Error('stream failure'));
    expect(clients.size).toBe(0);

    const second = createStream();
    expect(clients.size).toBe(1);
    second.request.emit('error', new Error('request failure'));
    expect(clients.size).toBe(0);

    router.close();
  });

  it('HttpApiSnapshotStream delivers snapshot history with heartbeat and metrics', async () => {
    const now = Date.now();
    const alphaSnapshot = path.join(snapshotDir, 'alpha.png');
    fs.writeFileSync(alphaSnapshot, Buffer.from([1, 2, 3]));
    const betaSnapshot = path.join(snapshotDir, 'beta.png');
    fs.writeFileSync(betaSnapshot, Buffer.from([4, 5, 6]));

    storeEvent({
      ts: now - 500,
      source: 'video:alpha-camera',
      detector: 'motion',
      severity: 'warning',
      message: 'Alpha snapshot event',
      meta: { channel: 'video:alpha', snapshot: alphaSnapshot }
    });

    storeEvent({
      ts: now - 400,
      source: 'video:beta-camera',
      detector: 'motion',
      severity: 'info',
      message: 'Beta snapshot event',
      meta: { channel: 'video:beta', snapshot: betaSnapshot }
    });

    const expected = listEvents({ snapshot: 'with', channel: 'video:alpha', limit: 1 });
    expect(expected.items.length).toBeGreaterThan(0);
    const expectedId = expected.items[0]?.id;

    const { port } = await ensureServer();

    const controller = new AbortController();
    const response = await fetch(
      `http://localhost:${port}/api/events/stream?snapshots=1&snapshotLimit=5&channels=video:alpha`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const messages: any[] = [];
    const metricsEvents: any[] = [];
    const heartbeats: any[] = [];

    await new Promise<void>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
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
              const payload = JSON.parse(dataLines.join(''));
              if (eventName === 'metrics') {
                metricsEvents.push(payload);
              } else if (eventName === 'heartbeat') {
                heartbeats.push(payload);
              } else if (eventName === 'message') {
                messages.push(payload);
              }
            }
            if (messages.length >= 1 && metricsEvents.length >= 1 && heartbeats.length >= 1) {
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

  expect(messages.length).toBeGreaterThanOrEqual(1);
  const streamed = messages.find(message => message.meta?.channel === 'video:alpha') ?? messages[0];
  expect(streamed?.meta?.snapshotUrl).toBe(`/api/events/${expectedId}/snapshot`);
  expect(streamed?.id).toBe(expectedId);
  expect(metricsEvents.length).toBeGreaterThan(0);
  expect(metricsEvents[0]?.pipelines).toBeTruthy();
  expect(heartbeats.length).toBeGreaterThan(0);
});

  it('HttpApiSnapshotDiffStream returns diff image and emits warning SSE events', async () => {
    const makeImage = (filePath: string, color: [number, number, number]) => {
      const png = new PNG({ width: 4, height: 4 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = color[0];
        png.data[i + 1] = color[1];
        png.data[i + 2] = color[2];
        png.data[i + 3] = 255;
      }
      fs.writeFileSync(filePath, PNG.sync.write(png));
    };

    const now = Date.now();
    const baselinePath = path.join(snapshotDir, 'baseline-diff.png');
    const currentPath = path.join(snapshotDir, 'current-diff.png');
    makeImage(baselinePath, [10, 20, 30]);
    makeImage(currentPath, [200, 40, 220]);

    storeEvent({
      ts: now,
      source: 'video:diff-camera',
      detector: 'motion',
      severity: 'info',
      message: 'Diff snapshot',
      meta: { snapshot: currentPath, snapshotBaseline: baselinePath, channel: 'video:diff' }
    });

    const stored = listEvents({ snapshot: 'with', channel: 'video:diff', limit: 1 });
    const eventId = stored.items[0]?.id;
    expect(typeof eventId).toBe('number');

    const { port } = await ensureServer();

    const diffResponse = await fetch(`http://localhost:${port}/api/events/${eventId}/snapshot/diff`);
    expect(diffResponse.status).toBe(200);
    expect(diffResponse.headers.get('content-type')).toContain('image/png');
    const diffBuffer = Buffer.from(await diffResponse.arrayBuffer());
    const diffImage = PNG.sync.read(diffBuffer);
    const hasDifference = diffImage.data.some((value, index) => index % 4 !== 3 && value > 0);
    expect(hasDifference).toBe(true);

    const listing = await fetch(`http://localhost:${port}/api/events?channels=video:diff&limit=1`);
    const listingPayload = await listing.json();
    expect(listingPayload.items[0]?.meta?.snapshotDiffUrl).toBe(`/api/events/${eventId}/snapshot/diff`);

    metrics.reset();
    const controller = new AbortController();
    const response = await fetch(`http://localhost:${port}/api/events/stream?metrics=retention`, {
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const warnings: any[] = [];

    const readPromise = new Promise<void>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (eventName === 'warning' && dataLines.length > 0) {
                warnings.push(JSON.parse(dataLines.join('')));
              }
            }
            if (warnings.length >= 2) {
              resolve();
              return;
            }
            readNext();
          })
          .catch(reject);
      };
      readNext();
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    metrics.recordRetentionWarning({
      camera: 'video:diff',
      path: baselinePath,
      reason: 'rotation failed'
    });
    metrics.recordTransportFallback('ffmpeg', 'rtsp-timeout', {
      channel: 'video:diff',
      from: 'tcp',
      to: 'udp',
      at: Date.now(),
      resetsBackoff: true
    });

    await readPromise;
    controller.abort();
    await reader?.cancel().catch(() => undefined);

    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const warningTypes = warnings.map(entry => entry?.type);
    expect(warningTypes).toContain('retention');
    expect(warningTypes).toContain('transport-fallback');
  });

  it('HttpEventStreamResume demonstrates reconnection backlog and dashboard resume', async () => {
    const now = Date.now();
    storeEvent({
      ts: now - 1_000,
      source: 'video:lobby',
      detector: 'motion',
      severity: 'info',
      message: 'Initial lobby motion',
      meta: { channel: 'video:lobby', camera: 'video:lobby' }
    });

    const firstRecord = listEvents({ channel: 'video:lobby', limit: 1 }).items[0];
    expect(firstRecord).toBeTruthy();

    const { port } = await ensureServer();

    const controller = new AbortController();
    const streamResponse = await fetch(
      `http://localhost:${port}/api/events/stream?channel=${encodeURIComponent('video:lobby')}`,
      { signal: controller.signal }
    );
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const createSseMessageReader = (streamReader: any) => {
      let buffer = '';
      return async () => {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) {
            throw new Error('stream ended before message event');
          }
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            const lines = block.split('\n');
            let eventName = 'message';
            const dataLines: string[] = [];
            let id: string | null = null;
            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
              } else if (line.startsWith('id:')) {
                id = line.slice(3).trim();
              }
            }
            if (eventName === 'message' && dataLines.length > 0) {
              return { id, data: dataLines.join('\n') };
            }
          }
        }
      };
    };

    const readInitialMessage = createSseMessageReader(reader!);
    const firstMessagePromise = readInitialMessage();
    bus.emit('event', firstRecord);
    const firstMessage = await firstMessagePromise;
    const firstPayload = JSON.parse(firstMessage.data);
    expect(firstPayload.id).toBe(firstRecord.id);
    expect(Number(firstMessage.id)).toBe(firstRecord.id);

    controller.abort();

    storeEvent({
      ts: now + 100,
      source: 'video:lobby',
      detector: 'motion',
      severity: 'warning',
      message: 'Follow-up lobby motion',
      meta: { channel: 'video:lobby', camera: 'video:lobby' }
    });

    const backlogRecord = listEvents({ channel: 'video:lobby', limit: 1 }).items[0];
    expect(backlogRecord.id).toBeGreaterThan(firstRecord.id ?? 0);

    const resumeController = new AbortController();
    const resumeResponse = await fetch(
      `http://localhost:${port}/api/events/stream?channel=${encodeURIComponent('video:lobby')}` +
        `&lastEventId=${firstRecord.id}&backlog=1`,
      { signal: resumeController.signal }
    );
    expect(resumeResponse.status).toBe(200);
    const resumeReader = resumeResponse.body?.getReader();
    expect(resumeReader).toBeDefined();
    const readResumedMessage = createSseMessageReader(resumeReader!);
    const backlogMessage = await readResumedMessage();
    const backlogPayload = JSON.parse(backlogMessage.data);
    expect(backlogPayload.id).toBe(backlogRecord.id);
    expect(Number(backlogMessage.id)).toBe(backlogRecord.id);
    resumeController.abort();

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalEventSource = globalThis.EventSource;
    const originalFetch = globalThis.fetch;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalMessageEvent = globalThis.MessageEvent;
    const originalNavigator = globalThis.navigator;

    vi.useFakeTimers();

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

    const initialDashboardEvents = [
      {
        id: 750,
        ts: now - 500,
        source: 'video:lobby',
        detector: 'motion',
        severity: 'info',
        message: 'Seed dashboard event',
        meta: { channel: 'video:lobby', camera: 'video:lobby' }
      }
    ];

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? '';
      if (url.includes('/api/events?')) {
        return new Response(
          JSON.stringify({
            items: initialDashboardEvents,
            total: initialDashboardEvents.length,
            summary: { detectors: [], channels: [] }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/metrics/pipelines')) {
        return new Response(
          JSON.stringify({
            fetchedAt: new Date(now).toISOString(),
            pipelines: {},
            retention: {
              runs: 0,
              lastRunAt: null,
              warnings: 0,
              warningsByCamera: {},
              lastWarning: null,
              totals: {
                removedEvents: 0,
                archivedSnapshots: 0,
                prunedArchives: 0,
                diskSavingsBytes: 0
              },
              totalsByCamera: {}
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    type Listener = (event: MessageEvent) => void;
    class ResumeEventSource {
      static instances: ResumeEventSource[] = [];
      public url: string;
      public readyState = 0;
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent) => void) | null = null;
      public onerror: ((event: Event) => void) | null = null;
      private listeners = new Map<string, Set<Listener>>();

      constructor(url: string) {
        this.url = url;
        ResumeEventSource.instances.push(this);
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
        const event = new window.MessageEvent(type, { data } as MessageEventInit);
        this.listeners.get(type)?.forEach(listener => listener(event));
      }

      emitMessage(data: string, options: { lastEventId?: string } = {}) {
        const init: MessageEventInit = { data };
        if (options.lastEventId) {
          (init as any).lastEventId = options.lastEventId;
        }
        this.onmessage?.(new window.MessageEvent('message', init));
      }

      open() {
        this.readyState = 1;
        this.onopen?.(new window.Event('open'));
      }

      fail() {
        this.onerror?.(new window.Event('error'));
      }

      close() {
        this.readyState = 2;
      }
    }

    vi.stubGlobal('EventSource', ResumeEventSource as unknown as typeof EventSource);

    bootstrapDashboardScript();

    await vi.waitFor(() => {
      const state = (window as any).__guardianDashboardState;
      if (!state) {
        throw new Error('dashboard state unavailable');
      }
    });

    const initialInstance = ResumeEventSource.instances[0];
    expect(initialInstance).toBeDefined();
    initialInstance!.open();
    initialInstance!.dispatch('stream-status', JSON.stringify({ status: 'connected', retryMs: 75 }));

    const firstStreamEvent = {
      id: 760,
      ts: now + 250,
      source: 'video:lobby',
      detector: 'motion',
      severity: 'warning',
      message: 'Live lobby alert',
      meta: { channel: 'video:lobby', camera: 'video:lobby' }
    };
    initialInstance!.emitMessage(JSON.stringify(firstStreamEvent), {
      lastEventId: String(firstStreamEvent.id)
    });

    await Promise.resolve();

    const dashboardState = (window as any).__guardianDashboardState;
    expect(dashboardState.lastEventId).toBe(firstStreamEvent.id);
    expect(dashboardState.stream.events).toBeGreaterThanOrEqual(1);

    initialInstance!.fail();
    await vi.runOnlyPendingTimersAsync();

    await vi.waitFor(() => {
      if (ResumeEventSource.instances.length < 2) {
        throw new Error('awaiting reconnection');
      }
    });

    const resumedInstance = ResumeEventSource.instances[1];
    expect(resumedInstance.url).toContain(`lastEventId=${firstStreamEvent.id}`);
    expect(resumedInstance.url).toContain('backlog=1');
    resumedInstance.open();

    const resumedEvent = {
      id: 765,
      ts: now + 500,
      source: 'video:lobby',
      detector: 'motion',
      severity: 'critical',
      message: 'Recovered backlog event',
      meta: { channel: 'video:lobby', camera: 'video:lobby' }
    };
    resumedInstance.emitMessage(JSON.stringify(resumedEvent), {
      lastEventId: String(resumedEvent.id)
    });

    await Promise.resolve();

    const resumedState = (window as any).__guardianDashboardState;
    expect(resumedState.lastEventId).toBe(resumedEvent.id);
    expect(resumedState.events.some((entry: any) => entry.id === resumedEvent.id)).toBe(true);
    expect(resumedState.stream.events).toBeGreaterThanOrEqual(1);

    resumedInstance.close();
    initialInstance?.close();
    ResumeEventSource.instances.length = 0;
    dom.window.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();

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

  it('HttpStreamCombinedMetricsSelection streams selected metrics subsets without extras', async () => {
    metrics.recordRetentionRun({
      removedEvents: 2,
      archivedSnapshots: 1,
      prunedArchives: 0,
      diskSavingsBytes: 0,
      perCamera: { 'video:test': { archivedSnapshots: 1, prunedArchives: 0 } }
    });

    const { port } = await ensureServer();
    const controller = new AbortController();
    const response = await fetch(
      `http://localhost:${port}/api/events/stream?metrics=audio,retention`,
      { signal: controller.signal }
    );

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const payload = await new Promise<any>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new Error('stream ended before metrics arrived'));
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (eventName === 'metrics' && dataLines.length > 0) {
                resolve(JSON.parse(dataLines.join('')));
                return;
              }
            }
            readNext();
          })
          .catch(reject);
      };
      readNext();
    });

    controller.abort();
    await reader?.cancel().catch(() => undefined);

    expect(payload).toBeDefined();
    expect(payload.events).toBeUndefined();
    expect(payload.pipelines?.ffmpeg).toBeUndefined();
    expect(payload.pipelines?.audio?.restarts).toBeDefined();
    expect(payload.retention?.runs).toBeGreaterThanOrEqual(1);
    expect(Object.keys(payload).sort()).toEqual(['fetchedAt', 'pipelines', 'retention']);
  });

  it('HttpStreamRetentionMetricsToggle streams retention-only metrics and updates dashboard widget', async () => {
    metrics.recordRetentionRun({
      removedEvents: 3,
      archivedSnapshots: 0,
      prunedArchives: 0,
      diskSavingsBytes: 0,
      perCamera: { 'video:test': { archivedSnapshots: 0, prunedArchives: 0 } }
    });

    const { port } = await ensureServer();
    const controller = new AbortController();
    const response = await fetch(`http://localhost:${port}/api/events/stream?metrics=retention`, {
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const metricsPayload = await new Promise<any>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readChunk = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new Error('stream ended'));
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (eventName === 'metrics' && dataLines.length > 0) {
                resolve(JSON.parse(dataLines.join('')));
                return;
              }
            }
            readChunk();
          })
          .catch(reject);
      };
      readChunk();
    });

    controller.abort();
    await reader?.cancel().catch(() => undefined);
    expect(metricsPayload).toBeDefined();
    expect(metricsPayload.events).toBeUndefined();
    expect(metricsPayload.pipelines).toBeUndefined();
    expect(metricsPayload.retention?.totals?.removedEvents).toBeGreaterThan(0);
    expect(Object.keys(metricsPayload).sort()).toEqual(['fetchedAt', 'retention']);

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

    const baselineMetrics = {
      fetchedAt: new Date(1700004000000).toISOString(),
      pipelines: {},
      retention: {
        runs: 0,
        lastRunAt: null,
        warnings: 0,
        warningsByCamera: {},
        lastWarning: null,
        totals: { removedEvents: 0, archivedSnapshots: 0, prunedArchives: 0, diskSavingsBytes: 0 },
        totalsByCamera: {}
      }
    };

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? '';
      if (url.includes('/api/events?')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/api/metrics/pipelines')) {
        return new Response(JSON.stringify(baselineMetrics), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    type Listener = (event: MessageEvent) => void;
    class RetentionEventSource {
      static instances: RetentionEventSource[] = [];
      public readyState = 0;
      public url: string;
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent) => void) | null = null;
      private listeners = new Map<string, Set<Listener>>();

      constructor(url: string) {
        this.url = url;
        RetentionEventSource.instances.push(this);
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

      open() {
        this.onopen?.(new window.Event('open'));
      }

      close() {
        this.readyState = 2;
      }
    }

    vi.stubGlobal('EventSource', RetentionEventSource as unknown as typeof EventSource);

    bootstrapDashboardScript();
    await Promise.resolve();
    await vi.waitFor(() => {
      const state = (window as any).__guardianDashboardState;
      if (!state) {
        throw new Error('dashboard state unavailable');
      }
    });

    const instance = RetentionEventSource.instances[0];
    expect(instance).toBeDefined();
    instance?.open();

    const retentionDigest = {
      fetchedAt: new Date(1700005000000).toISOString(),
      retention: {
        runs: 2,
        lastRunAt: new Date(1700004800000).toISOString(),
        warnings: 1,
        warningsByCamera: { 'video:test': 1 },
        lastWarning: { camera: 'video:test', path: '/snapshots/test.jpg', reason: 'Missing file' },
        totals: { removedEvents: 5, archivedSnapshots: 0, prunedArchives: 0, diskSavingsBytes: 0 },
        totalsByCamera: { 'video:test': { archivedSnapshots: 0, prunedArchives: 0 } }
      }
    };
    instance?.dispatch('metrics', JSON.stringify(retentionDigest));

    await vi.waitFor(() => {
      const widget = window.document.getElementById('pipeline-metrics');
      if (!widget) {
        throw new Error('pipeline widget missing');
      }
      const content = widget.textContent ?? '';
      expect(content.includes('Retention')).toBe(true);
      expect(content.includes('5 removed')).toBe(true);
      expect(content.includes('Video streams')).toBe(false);
    });

    dom.window.close();
    vi.unstubAllGlobals();

    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error cleanup
      delete globalThis.window;
    }
    if (originalDocument) {
      globalThis.document = originalDocument;
    } else {
      // @ts-expect-error cleanup
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
      // @ts-expect-error cleanup navigator
      delete globalThis.navigator;
    }
  });

  it('HttpApiPoseThreatPayload surfaces pose metadata and caches snapshots', async () => {
    const now = Date.now();
    const snapshotPath = path.join(snapshotDir, 'pose.png');
    const facePath = path.join(snapshotDir, 'pose-face.png');
    fs.writeFileSync(snapshotPath, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(facePath, Buffer.from([9, 8, 7, 6]));

    storeEvent({
      ts: now,
      source: 'video:pose-cam',
      detector: 'motion',
      severity: 'warning',
      message: 'Pose telemetry captured',
      meta: {
        channel: 'video:pose-cam',
        snapshot: snapshotPath,
        faceSnapshot: facePath,
        poseForecast: {
          horizonMs: 900,
          confidence: 0.82,
          movingJointCount: 4,
          movingJointRatio: 0.5,
          movementFlags: [1, 0, 1],
          velocity: [0.1, 0.2, 0.3],
          history: [
            {
              ts: now - 500,
              keypoints: [
                { x: 0.1, y: 0.2, confidence: 0.9 },
                { x: 0.4, y: 0.6, confidence: 0.8 }
              ]
            }
          ]
        },
        poseThreatSummary: {
          maxThreatScore: 0.91,
          maxThreatLabel: 'intruder',
          totalDetections: 3,
          averageThreatScore: 0.74,
          objects: [
            { label: 'intruder', threatScore: 0.91, threat: true },
            { label: 'bystander', threatScore: 0.3, threat: false }
          ]
        }
      }
    });

    const { port } = await ensureServer();

    const response = await fetch(`http://localhost:${port}/api/events`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items).toHaveLength(1);
    const item = payload.items[0];
    expect(item.meta.poseForecast.confidence).toBeCloseTo(0.82, 5);
    expect(item.meta.poseForecast.movementFlags).toEqual([true, false, true]);
    expect(item.meta.poseForecast.velocity).toEqual([0.1, 0.2, 0.3]);
    expect(item.meta.poseForecast.history[0].keypoints[0].confidence).toBeCloseTo(0.9, 5);
    expect(item.meta.poseThreatSummary.maxThreatLabel).toBe('intruder');
    expect(item.meta.poseThreatSummary.maxThreatScore).toBeCloseTo(0.91, 5);
    expect(Array.isArray(item.meta.poseThreatSummary.objects)).toBe(true);
    expect(item.meta.poseThreatSummary.objects[0]).toMatchObject({ label: 'intruder', threat: true });
    expect(payload.summary.pose.forecasts).toBe(1);
    expect(payload.summary.pose.threats.maxThreat.label).toBe('intruder');
    expect(payload.summary.pose.threats.maxThreat.threatScore).toBeCloseTo(0.91, 5);

    const eventId = item.id;
    expect(typeof eventId).toBe('number');

    const snapshotResponse = await fetch(`http://localhost:${port}/api/events/${eventId}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshotEtag = snapshotResponse.headers.get('etag');
    const snapshotModified = snapshotResponse.headers.get('last-modified');
    expect(snapshotResponse.headers.get('cache-control')).toContain('max-age');
    expect(snapshotEtag).toBeTruthy();
    expect(snapshotModified).toBeTruthy();

    const snapshotNotModified = await fetch(`http://localhost:${port}/api/events/${eventId}/snapshot`, {
      headers: {
        'If-None-Match': snapshotEtag ?? '',
        'If-Modified-Since': snapshotModified ?? ''
      }
    });
    expect(snapshotNotModified.status).toBe(304);

    const faceResponse = await fetch(`http://localhost:${port}/api/events/${eventId}/face-snapshot`);
    expect(faceResponse.status).toBe(200);
    const faceEtag = faceResponse.headers.get('etag');
    const faceModified = faceResponse.headers.get('last-modified');
    expect(faceResponse.headers.get('cache-control')).toContain('max-age');

    const faceNotModified = await fetch(`http://localhost:${port}/api/events/${eventId}/face-snapshot`, {
      headers: {
        'If-None-Match': faceEtag ?? '',
        'If-Modified-Since': faceModified ?? ''
      }
    });
    expect(faceNotModified.status).toBe(304);

    const staleFace = await fetch(`http://localhost:${port}/api/events/${eventId}/face-snapshot`, {
      headers: { 'If-Modified-Since': new Date(0).toUTCString() }
    });
    expect(staleFace.status).toBe(200);
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
      diskSavingsBytes: 0,
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

  it('HttpSseChannelHealthDigest surfaces channel severity metadata', async () => {
    metrics.reset();
    const now = Date.now();
    metrics.setPipelineChannelHealth('ffmpeg', 'video:lobby', {
      severity: 'critical',
      reason: 'no-signal',
      degradedSince: now - 90_000
    });
    metrics.setPipelineChannelHealth('ffmpeg', 'video:loading', {
      severity: 'warning',
      reason: 'packet-loss',
      degradedSince: now - 45_000
    });

    const { port } = await ensureServer();

    const controller = new AbortController();
    const response = await fetch(`http://localhost:${port}/api/events/stream?metrics=all`, {
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const digest = await new Promise<any>((resolve, reject) => {
      if (!reader) {
        reject(new Error('missing reader'));
        return;
      }
      let buffer = '';
      const readNext = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new Error('stream ended before metrics digest'));
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const lines = chunk.split('\n');
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (eventName === 'metrics' && dataLines.length > 0) {
                try {
                  resolve(JSON.parse(dataLines.join('')));
                } catch (error) {
                  reject(error);
                }
                return;
              }
            }
            readNext();
          })
          .catch(reject);
      };
      readNext();
    });

    controller.abort();

    expect(digest?.pipelines?.ffmpeg?.channels).toBeDefined();
    const channels = Array.isArray(digest?.pipelines?.ffmpeg?.channels)
      ? digest.pipelines.ffmpeg.channels
      : [];
    const lobby = channels.find((entry: any) => entry.channel === 'video:lobby');
    const loadingDock = channels.find((entry: any) => entry.channel === 'video:loading');
    expect(lobby?.health?.severity).toBe('critical');
    expect(lobby?.health?.reason).toBe('no-signal');
    expect(typeof lobby?.health?.degradedSince === 'string').toBe(true);
    expect(Number.isFinite(Date.parse(lobby?.health?.degradedSince ?? ''))).toBe(true);
    expect(loadingDock?.health?.severity).toBe('warning');
    expect(loadingDock?.health?.reason).toBe('packet-loss');
    expect(typeof loadingDock?.health?.degradedSince === 'string').toBe(true);
  });

  it('HttpApiAudioPipelineDigest surfaces audio channel restart metadata', async () => {
    metrics.reset();
    metrics.recordPipelineRestart('audio', 'watchdog-timeout', {
      channel: 'audio:entrance',
      delayMs: 1500,
      attempt: 2
    });
    metrics.recordPipelineRestart('audio', 'spawn-error', { channel: 'audio:lobby' });

    const { port } = await ensureServer();
    const response = await fetch(`http://localhost:${port}/api/events`);
    expect(response.status).toBe(200);
    const payload = await response.json();

    const audioDigest = payload.metrics?.pipelines?.audio;
    expect(audioDigest.restarts).toBe(2);
    expect(Array.isArray(audioDigest.channels)).toBe(true);
    const entrance = audioDigest.channels.find((entry: { channel: string }) => entry.channel === 'audio:entrance');
    const lobby = audioDigest.channels.find((entry: { channel: string }) => entry.channel === 'audio:lobby');
    expect(entrance).toBeDefined();
    expect(lobby).toBeDefined();
    expect(entrance.restarts).toBe(1);
    expect(entrance.watchdogBackoffMs).toBe(1500);
    expect(entrance.lastRestart?.reason).toBe('watchdog-timeout');
    expect(typeof entrance.lastRestartAt === 'string' || entrance.lastRestartAt === null).toBe(true);
    expect(lobby.restarts).toBe(1);
    expect(lobby.watchdogBackoffMs).toBe(0);
    expect(lobby.lastRestart?.reason).toBe('spawn-error');
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

  it('DashboardSseHeartbeat updates widget counts and health status', async () => {
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

    const now = Date.now();
    const metricsSnapshot = {
      fetchedAt: new Date(now).toISOString(),
      pipelines: {
        ffmpeg: {
          restarts: 2,
          lastRestartAt: new Date(now - 1000).toISOString(),
          byReason: { 'watchdog-timeout': 2 },
          lastRestart: { reason: 'watchdog-timeout' },
          attempts: {},
          byChannel: {
            'video:lobby': {
              restarts: 2,
              lastRestartAt: new Date(now - 1000).toISOString(),
              byReason: { 'watchdog-timeout': 2 },
              lastRestart: { reason: 'watchdog-timeout' }
            }
          },
          deviceDiscovery: { byReason: {}, byFormat: {} },
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
          deviceDiscovery: { byReason: {}, byFormat: {} },
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
        totals: { removedEvents: 0, archivedSnapshots: 2, prunedArchives: 0, diskSavingsBytes: 0 },
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

    bootstrapDashboardScript();
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
    instance!.dispatch('metrics', JSON.stringify(metricsSnapshot));
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
    expect(window.document.getElementById('stream-health')?.textContent).toBe('Degraded');
    expect(window.document.getElementById('stream-events')?.textContent).toBe('2');
    const updatedText = window.document.getElementById('stream-updated')?.textContent ?? '';
    expect(updatedText).not.toBe('—');

    const dashboardState = (window as any).__guardianDashboardState;
    expect(dashboardState).toBeTruthy();
    expect(Array.from(dashboardState.filters.channels)).toContain('video:stream');
    expect(dashboardState.stream.health).toBe('Degraded');

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

    const snapshotsBefore = Number(
      window.document.getElementById('stream-snapshots')?.textContent ?? '0'
    );
    instance!.dispatch(
      'warning',
      JSON.stringify({
        type: 'transport-fallback',
        fallback: {
          channel: 'video:stream',
          from: 'tcp',
          to: 'udp',
          reason: 'rtsp-timeout',
          at: new Date(1700000000800).toISOString(),
          resetsBackoff: true,
          resetsCircuitBreaker: false
        }
      })
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    const snapshotsAfter = Number(
      window.document.getElementById('stream-snapshots')?.textContent ?? '0'
    );
    expect(snapshotsAfter).toBeGreaterThanOrEqual(snapshotsBefore + 1);
    const warningItems = window.document.querySelectorAll('#warning-list .warning-item');
    expect(warningItems.length).toBeGreaterThan(0);
    expect(warningItems[0].textContent).toContain('Transport fallback');
    expect(warningItems[0].textContent).toContain('rtsp-timeout');

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

  it('DashboardRenderEvents renders face previews and snapshots', async () => {
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
      fetchedAt: new Date(1700002000000).toISOString(),
      pipelines: {
        ffmpeg: {
          restarts: 0,
          lastRestartAt: null,
          channels: []
        },
        audio: {
          restarts: 0,
          lastRestartAt: null,
          watchdogBackoffMs: 0
        }
      },
      retention: {
        runs: 0,
        lastRunAt: null,
        warnings: 0,
        warningsByCamera: {},
        lastWarning: null,
        totals: { removedEvents: 0, archivedSnapshots: 0, prunedArchives: 0, diskSavingsBytes: 0 },
        totalsByCamera: {}
      }
    };

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? '';
      if (url.includes('/api/events?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 101,
                ts: 1700002000100,
                source: 'video:alpha',
                detector: 'motion',
                severity: 'warning',
                message: 'alpha event',
                meta: {
                  channel: 'video:alpha',
                  snapshotUrl: '/api/events/101/snapshot',
                  faceSnapshotUrl: '/api/events/101/face-snapshot'
                }
              }
            ],
            total: 1
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/api/metrics/pipelines')) {
        return new Response(JSON.stringify(metricsSnapshot), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    type Listener = (event: MessageEvent) => void;
    class MinimalEventSource {
      static instances: MinimalEventSource[] = [];
      public readyState = 0;
      public url: string;
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent) => void) | null = null;
      private listeners = new Map<string, Set<Listener>>();

      constructor(url: string) {
        this.url = url;
        MinimalEventSource.instances.push(this);
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

    vi.stubGlobal('EventSource', MinimalEventSource as unknown as typeof EventSource);

    bootstrapDashboardScript();
    await Promise.resolve();
    await vi.waitFor(() => {
      const events = (window as any).__guardianDashboardState?.events ?? [];
      if (events.length === 0) {
        throw new Error('events not loaded');
      }
    });

    const firstEvent = window.document.querySelector('#events .event');
    expect(firstEvent).not.toBeNull();
    firstEvent?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const previewImg = window.document.getElementById('preview-image') as HTMLImageElement;
    const faceImg = window.document.getElementById('preview-face-image') as HTMLImageElement;
    const faceCaption = window.document.getElementById('preview-face-caption');
    expect(previewImg.hidden).toBe(false);
    expect(previewImg.src).toContain('/api/events/101/snapshot');
    expect(faceImg.hidden).toBe(false);
    expect(faceImg.src).toContain('/api/events/101/face-snapshot');
    expect(faceCaption?.textContent).toBe('Face snapshot available');

    dom.window.close();
    vi.unstubAllGlobals();

    if (originalWindow) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error cleanup
      delete globalThis.window;
    }
    if (originalDocument) {
      globalThis.document = originalDocument;
    } else {
      // @ts-expect-error cleanup
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
      // @ts-expect-error cleanup for navigator
      delete globalThis.navigator;
    }
  });

  it('DashboardSsePoseRender updates pose widgets via SSE events', async () => {
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
      fetchedAt: new Date(1700001000000).toISOString(),
      pipelines: {
        ffmpeg: {
          restarts: 0,
          lastRestartAt: null,
          byReason: {},
          lastRestart: null,
          attempts: {},
          byChannel: {},
          deviceDiscovery: { byReason: {}, byFormat: {} },
          deviceDiscoveryByChannel: {},
          delayHistogram: {},
          attemptHistogram: {}
        }
      },
      retention: {
        runs: 0,
        lastRunAt: null,
        warnings: 0,
        warningsByCamera: {},
        lastWarning: null,
        totals: { removedEvents: 0, archivedSnapshots: 0, prunedArchives: 0, diskSavingsBytes: 0 },
        totalsByCamera: {}
      }
    };

    const initialSummary = {
      totals: { byDetector: { motion: 1 }, bySeverity: { info: 1 } },
      channels: [],
      pose: {
        forecasts: 1,
        averageConfidence: 0.6,
        lastForecast: {
          confidence: 0.6,
          movingJointCount: 3,
          movingJointRatio: 0.4,
          ts: 1700001000100
        },
        threats: {
          events: 1,
          averageMaxThreatScore: 0.4,
          totalDetections: 1,
          maxThreat: {
            label: 'none',
            threatScore: 0.4,
            ts: 1700001000100
          }
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
                id: 7,
                ts: 1700001000100,
                source: 'video:pose-cam',
                detector: 'motion',
                severity: 'info',
                message: 'initial pose event',
                meta: {
                  channel: 'video:pose-cam',
                  snapshot: '/snapshots/pose.jpg',
                  poseForecast: {
                    confidence: 0.6,
                    movingJointCount: 3,
                    movingJointRatio: 0.4
                  },
                  poseThreatSummary: {
                    maxThreatScore: 0.4,
                    maxThreatLabel: 'none',
                    totalDetections: 1
                  }
                }
              }
            ],
            total: 1,
            summary: initialSummary,
            metrics: metricsSnapshot
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

      return new Response(
        JSON.stringify({ items: [], total: 0, summary: { totals: { byDetector: {}, bySeverity: {} }, channels: [] } }),
        {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        }
      );
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

    bootstrapDashboardScript();
    await Promise.resolve();
    await vi.waitFor(() => {
      const state = (window as any).__guardianDashboardState;
      if (!state) throw new Error('dashboard state unavailable');
      expect(Array.isArray(state.events) && state.events.length > 0).toBe(true);
    });

    const poseConfidenceEl = window.document.getElementById('pose-confidence');
    const poseMovementEl = window.document.getElementById('pose-movement');
    const poseThreatEl = window.document.getElementById('pose-threat');
    expect(poseConfidenceEl?.textContent).toBe('60%');
    expect(poseMovementEl?.textContent).toBe('3 joints (40%)');
    expect(poseThreatEl?.textContent).toBe('none (40%)');

    const instance = MockEventSource.instances[0];
    expect(instance).toBeDefined();
    instance!.open();

    instance!.emitMessage(
      JSON.stringify({
        id: 8,
        ts: 1700001001200,
        source: 'video:pose-cam',
        detector: 'motion',
        severity: 'warning',
        message: 'pose update',
        meta: {
          channel: 'video:pose-cam',
          poseForecast: {
            confidence: 0.95,
            movingJointCount: 6,
            movingJointRatio: 0.75
          },
          poseThreatSummary: {
            maxThreatScore: 0.88,
            maxThreatLabel: 'intruder',
            totalDetections: 4
          }
        }
      })
    );

    await vi.waitFor(() => {
      expect(poseConfidenceEl?.textContent).toBe('95%');
      expect(poseMovementEl?.textContent).toBe('6 joints (75%)');
      expect(poseThreatEl?.textContent).toBe('intruder (88%)');
    });

    const dashboardState = (window as any).__guardianDashboardState;
    expect(dashboardState.pose.lastForecast.confidence).toBeCloseTo(0.95, 5);
    expect(dashboardState.pose.lastThreat.threatScore).toBeCloseTo(0.88, 5);
    expect(dashboardState.pose.lastThreat.label).toBe('intruder');

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

  it('DashboardSuppressionWarningRender renders TTL prune warnings', async () => {
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

    const baselineMetrics = {
      fetchedAt: new Date(1700005000000).toISOString(),
      pipelines: {},
      retention: {
        runs: 0,
        lastRunAt: null,
        warnings: 0,
        warningsByCamera: {},
        lastWarning: null,
        totals: { removedEvents: 0, archivedSnapshots: 0, prunedArchives: 0, diskSavingsBytes: 0 },
        totalsByCamera: {}
      }
    };

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? '';
      if (url.includes('/api/events?')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/api/events/snapshots')) {
        return new Response(JSON.stringify({ items: [], total: 0, summary: { channels: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/api/metrics/pipelines')) {
        return new Response(JSON.stringify(baselineMetrics), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    type Listener = (event: MessageEvent) => void;
    class SuppressionEventSource {
      static instances: SuppressionEventSource[] = [];
      public readyState = 0;
      public url: string;
      public onopen: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent) => void) | null = null;
      private listeners = new Map<string, Set<Listener>>();

      constructor(url: string) {
        this.url = url;
        SuppressionEventSource.instances.push(this);
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
        this.readyState = 1;
        this.onopen?.(new window.Event('open'));
      }

      close() {
        this.readyState = 2;
      }
    }

    vi.stubGlobal('EventSource', SuppressionEventSource as unknown as typeof EventSource);

    bootstrapDashboardScript();

    await vi.waitFor(() => {
      const state = (window as any).__guardianDashboardState;
      if (!state) {
        throw new Error('dashboard state unavailable');
      }
    });

    const instance = SuppressionEventSource.instances[0];
    expect(instance).toBeDefined();
    instance!.open();

    const warningPayload = {
      type: 'suppression',
      suppression: {
        ruleId: 'timeline-ttl',
        channel: 'cam:a',
        count: 2,
        timelineTtlMs: 500,
        timelineExpired: true,
        at: new Date(1700005000500).toISOString()
      }
    };
    instance!.dispatch('warning', JSON.stringify(warningPayload));
    await new Promise(resolve => setTimeout(resolve, 0));

    const warningItems = window.document.querySelectorAll('#warning-list .warning-item');
    expect(warningItems.length).toBeGreaterThan(0);
    const latestWarning = warningItems[0]?.textContent ?? '';
    expect(latestWarning).toContain('Suppression TTL pruned');
    expect(latestWarning).toContain('cam:a');
    expect(latestWarning).toContain('2 suppression entries pruned');

    const dashboardState = (window as any).__guardianDashboardState;
    expect(Array.isArray(dashboardState?.warnings)).toBe(true);
    expect(dashboardState.warnings?.[0]?.type).toBe('suppression');

    instance?.close();
    SuppressionEventSource.instances.length = 0;
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

