import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import {
  EventRecordWithId,
  FaceRecord,
  getEventById,
  listEvents,
  ListEventsOptions
} from '../../db.js';
import FaceRegistry, { IdentifyResult } from '../../video/faceRegistry.js';
import logger from '../../logger.js';
import { EventRecord } from '../../types.js';
import metricsModule, { MetricsRegistry } from '../../metrics/index.js';

interface EventsRouterOptions {
  bus: EventEmitter;
  faceRegistry?: FaceRegistry | null;
  createFaceRegistry?: () => Promise<FaceRegistry>;
  metrics?: MetricsRegistry;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

type StreamFilters = Omit<ListEventsOptions, 'limit' | 'offset'>;

type ClientState = {
  heartbeat: NodeJS.Timeout;
  filters: StreamFilters;
  retryMs: number;
  includeFaces: boolean;
  facesQuery: string | null;
};

const DEFAULT_FACE_THRESHOLD = 0.5;

export class EventsRouter {
  private readonly bus: EventEmitter;
  private readonly clients = new Map<ServerResponse, ClientState>();
  private readonly handlers: Handler[];
  private readonly heartbeatMs: number;
  private faceRegistry: FaceRegistry | null;
  private faceRegistryFactory?: () => Promise<FaceRegistry>;
  private faceRegistryPromise: Promise<FaceRegistry | null> | null = null;
  private readonly metrics: MetricsRegistry;

  constructor(options: EventsRouterOptions) {
    this.bus = options.bus;
    this.heartbeatMs = 15000;
    this.handlers = [
      (req, res, url) => this.handleList(req, res, url),
      (req, res, url) => this.handleMetrics(req, res, url),
      (req, res, url) => this.handleStream(req, res, url),
      (req, res, url) => this.handleSnapshot(req, res, url),
      (req, res, url) => this.handleFaces(req, res, url)
    ];
    this.faceRegistry = options.faceRegistry ?? null;
    this.faceRegistryFactory = options.createFaceRegistry;
    this.metrics = options.metrics ?? metricsModule;

    this.bus.on('event', this.handleBusEvent);
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (!req.url) {
      return false;
    }

    const url = new URL(req.url, 'http://localhost');
    for (const handler of this.handlers) {
      if (handler(req, res, url)) {
        return true;
      }
    }

    return false;
  }

  close() {
    this.bus.off('event', this.handleBusEvent);
    for (const [client, timer] of this.clients) {
      clearInterval(timer);
      client.end();
    }
    this.clients.clear();
  }

  private readonly handleBusEvent = (event: EventRecord) => {
    const payload = JSON.stringify(formatEventForClient(event));
    const digest = createMetricsDigest(this.metrics.snapshot());
    for (const [client, state] of this.clients) {
      if (client.writableEnded) {
        clearInterval(state.heartbeat);
        this.clients.delete(client);
        continue;
      }

      if (!matchesStreamFilters(event, state.filters)) {
        continue;
      }

      try {
        client.write(`data: ${payload}\n\n`);
        client.write(`event: metrics\n`);
        client.write(`data: ${JSON.stringify(digest)}\n\n`);
      } catch (error) {
        clearInterval(state.heartbeat);
        client.end();
        this.clients.delete(client);
      }
    }
  };

  private handleList(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET' || url.pathname !== '/api/events') {
      return false;
    }

    const options = parseListOptions(url);
    const result = listEvents(options);
    const items = result.items.map(formatEventForClient);
    const summary = summarizeEvents(items);
    const digest = createMetricsDigest(this.metrics.snapshot());

    sendJson(res, 200, {
      items,
      total: result.total,
      limit: options.limit ?? undefined,
      offset: options.offset ?? undefined,
      summary,
      metrics: digest
    });

    return true;
  }

  private handleMetrics(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET' || url.pathname !== '/api/metrics/pipelines') {
      return false;
    }

    const snapshot = this.metrics.snapshot();
    sendJson(res, 200, {
      fetchedAt: snapshot.createdAt,
      pipelines: snapshot.pipelines,
      retention: snapshot.retention
    });

    return true;
  }

  private handleStream(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET' || url.pathname !== '/api/events/stream') {
      return false;
    }

    const filters = extractStreamFilters(url);
    const retryMs = resolveRetryInterval(url.searchParams);
    const facesRequest = resolveFacesRequest(url.searchParams);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': connected\n');
    res.write(`retry: ${retryMs}\n`);
    res.write(`event: stream-status\n`);
    res.write(`data: ${JSON.stringify({ status: 'connected', retryMs, filters })}\n\n`);
    const initialDigest = createMetricsDigest(this.metrics.snapshot());
    res.write(`event: metrics\n`);
    res.write(`data: ${JSON.stringify(initialDigest)}\n\n`);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        this.clients.delete(res);
        return;
      }

      try {
        res.write(`event: heartbeat\n`);
        res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch (error) {
        clearInterval(heartbeat);
        this.clients.delete(res);
      }
    }, this.heartbeatMs);

    this.clients.set(res, {
      heartbeat,
      filters,
      retryMs,
      includeFaces: facesRequest.includeFaces,
      facesQuery: facesRequest.query
    });

    if (facesRequest.includeFaces) {
      void this.pushFacesSnapshot(res, facesRequest.query, filters.channels);
    }

    const cleanup = () => {
      const client = this.clients.get(res);
      if (client) {
        clearInterval(client.heartbeat);
      }
      this.clients.delete(res);
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
    return true;
  }

  private handleSnapshot(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET') {
      return false;
    }

    const snapshotMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/(face-)?snapshot$/);
    if (!snapshotMatch) {
      return false;
    }

    const eventId = Number(snapshotMatch[1]);
    if (!Number.isFinite(eventId) || !Number.isInteger(eventId) || eventId < 0) {
      sendJson(res, 400, { error: 'Invalid event id' });
      return true;
    }

    const variant = snapshotMatch[2] ? 'face' : 'default';

    const event = getEventById(eventId);
    if (!event) {
      sendJson(res, 404, { error: 'Event not found' });
      return true;
    }

    const snapshotPath = variant === 'face' ? extractFaceSnapshotPath(event) : extractSnapshotPath(event);
    if (!snapshotPath) {
      sendJson(res, 404, { error: 'Snapshot not available' });
      return true;
    }
    return serveSnapshotFile(req, res, snapshotPath);
  }

  private handleFaces(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith('/api/faces')) {
      return false;
    }

    if (req.method === 'GET' && url.pathname === '/api/faces') {
      const search = (url.searchParams.get('search') ?? url.searchParams.get('q')) || null;
      void this.handleFaceList(res, search);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/faces/enroll') {
      void this.handleFaceEnroll(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/faces/identify') {
      void this.handleFaceIdentify(req, res);
      return true;
    }

    if (req.method === 'DELETE') {
      const match = url.pathname.match(/^\/api\/faces\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);
        if (!Number.isFinite(id)) {
          sendJson(res, 400, { error: 'Invalid face id' });
          return true;
        }
        void this.handleFaceDelete(id, res);
        return true;
      }
    }

    return false;
  }

  private async handleFaceList(res: ServerResponse, search: string | null) {
    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      this.respondFaceUnavailable(res);
      return;
    }

    const faces = filterFaces(registry.list(), search);
    sendJson(res, 200, { faces, threshold: DEFAULT_FACE_THRESHOLD });
  }

  private async handleFaceEnroll(req: IncomingMessage, res: ServerResponse) {
    const payload = await readJsonBody(req).catch(() => null);
    if (!payload || typeof payload !== 'object') {
      sendJson(res, 400, { error: 'Invalid enrollment payload' });
      return;
    }

    const record = payload as Record<string, unknown>;
    const labelRaw = record.label;
    const imageRaw = record.image;
    const metadataRaw = record.metadata;

    const label = typeof labelRaw === 'string' ? labelRaw.trim() : '';
    if (!label) {
      sendJson(res, 400, { error: 'Face label is required' });
      return;
    }

    if (typeof imageRaw !== 'string' || imageRaw.length === 0) {
      sendJson(res, 400, { error: 'Face image is required' });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(imageRaw, 'base64');
    } catch (error) {
      sendJson(res, 400, { error: 'Image must be base64 encoded' });
      return;
    }

    if (buffer.length === 0) {
      sendJson(res, 400, { error: 'Image payload is empty' });
      return;
    }

    const metadata = metadataRaw && typeof metadataRaw === 'object' ? (metadataRaw as Record<string, unknown>) : undefined;

    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      this.respondFaceUnavailable(res);
      return;
    }

    try {
      const face = await registry.enroll(buffer, label, metadata);
      sendJson(res, 201, { face });
      void this.broadcastFacesSnapshot();
    } catch (error) {
      logger.error({ err: error }, 'Failed to enroll face');
      sendJson(res, 500, { error: 'Failed to enroll face' });
    }
  }

  private async handleFaceIdentify(req: IncomingMessage, res: ServerResponse) {
    const payload = await readJsonBody(req).catch(() => null);
    if (!payload || typeof payload !== 'object') {
      sendJson(res, 400, { error: 'Invalid identify payload' });
      return;
    }

    const record = payload as Record<string, unknown>;
    const imageRaw = record.image;
    const thresholdRaw = record.threshold;

    if (typeof imageRaw !== 'string' || imageRaw.length === 0) {
      sendJson(res, 400, { error: 'Face image is required' });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(imageRaw, 'base64');
    } catch (error) {
      sendJson(res, 400, { error: 'Image must be base64 encoded' });
      return;
    }

    if (buffer.length === 0) {
      sendJson(res, 400, { error: 'Image payload is empty' });
      return;
    }

    const threshold = typeof thresholdRaw === 'number' && Number.isFinite(thresholdRaw) ? Math.max(thresholdRaw, 0) : 0.5;

    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      this.respondFaceUnavailable(res);
      return;
    }

    let result: IdentifyResult;
    try {
      result = await registry.identify(buffer, threshold);
    } catch (error) {
      logger.error({ err: error }, 'Failed to identify face');
      sendJson(res, 500, { error: 'Failed to identify face' });
      return;
    }

    const response: Record<string, unknown> = {
      embedding: result.embedding,
      threshold: result.threshold,
      distance: result.distance,
      unknown: result.unknown,
      match: result.match
        ? { face: result.match.face, distance: result.match.distance, unknown: false }
        : null
    };

    sendJson(res, 200, response);
  }

  private async handleFaceDelete(id: number, res: ServerResponse) {
    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      this.respondFaceUnavailable(res);
      return;
    }

    const removed = registry.remove(id);
    if (!removed) {
      sendJson(res, 404, { error: 'Face not found' });
      return;
    }

    sendJson(res, 200, { deleted: true });
    void this.broadcastFacesSnapshot();
  }

  private async ensureFaceRegistry(): Promise<FaceRegistry | null> {
    if (this.faceRegistry) {
      return this.faceRegistry;
    }

    if (!this.faceRegistryFactory) {
      return null;
    }

    if (!this.faceRegistryPromise) {
      this.faceRegistryPromise = this.faceRegistryFactory()
        .then(instance => {
          this.faceRegistry = instance;
          return instance;
        })
        .catch(error => {
          logger.error({ err: error }, 'Failed to initialize face registry');
          return null;
        });
    }

    const instance = await this.faceRegistryPromise;
    if (!instance) {
      this.faceRegistryPromise = null;
      return null;
    }

    this.faceRegistryPromise = null;
    return instance;
  }

  private respondFaceUnavailable(res: ServerResponse) {
    sendJson(res, 503, { error: 'Face registry unavailable' });
  }

  private async pushFacesSnapshot(target: ServerResponse, query: string | null, channels?: string[]) {
    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      try {
        target.write(`event: faces\n`);
        target.write(`data: ${JSON.stringify({ status: 'unavailable', query })}\n\n`);
      } catch (error) {
        logger.debug({ err: error }, 'Failed to write faces snapshot');
      }
      return;
    }

    const faces = filterFaces(registry.list(), query, channels);
    const payload = faces.map(face => ({
      id: face.id,
      label: face.label,
      metadata: face.metadata ?? null,
      createdAt: face.createdAt
    }));

    try {
      target.write(`event: faces\n`);
      target.write(
        `data: ${JSON.stringify({
          status: 'ok',
          query,
          count: payload.length,
          faces: payload,
          threshold: DEFAULT_FACE_THRESHOLD
        })}\n\n`
      );
    } catch (error) {
      logger.debug({ err: error }, 'Failed to dispatch faces snapshot');
    }
  }

  private async broadcastFacesSnapshot() {
    if (this.clients.size === 0) {
      return;
    }

    const tasks: Array<Promise<void>> = [];
    for (const [client, state] of this.clients) {
      if (!state.includeFaces) {
        continue;
      }
      tasks.push(this.pushFacesSnapshot(client, state.facesQuery, state.filters.channels));
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }
}

export function createEventsRouter(options: EventsRouterOptions) {
  return new EventsRouter(options);
}

function parseListOptions(url: URL): ListEventsOptions {
  const params = url.searchParams;
  const toNumber = (value: string | null) => {
    if (value === null) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const options: ListEventsOptions = {};
  const limit = toNumber(params.get('limit'));
  const offset = toNumber(params.get('offset'));
  const since = resolveDateParam(params.get('since')) ?? resolveDateParam(params.get('from'));
  const until = resolveDateParam(params.get('until')) ?? resolveDateParam(params.get('to'));
  const channelParams = parseChannelParams(params);

  if (typeof limit === 'number') {
    options.limit = limit;
  }
  if (typeof offset === 'number') {
    options.offset = offset;
  }
  if (typeof since === 'number') {
    options.since = since;
  }
  if (typeof until === 'number') {
    options.until = until;
  }

  if (channelParams.length > 0) {
    options.channel = channelParams[0];
    if (channelParams.length > 1) {
      options.channels = Array.from(new Set(channelParams));
    }
  }

  const detector = params.get('detector');
  if (detector) {
    options.detector = detector;
  }

  const source = params.get('source');
  if (source) {
    options.source = source;
  }

  const severity = params.get('severity');
  if (severity) {
    options.severity = severity as ListEventsOptions['severity'];
  }

  const camera = params.get('camera');
  if (camera) {
    options.camera = camera;
  }

  const search = params.get('search') ?? params.get('q');
  if (search) {
    const trimmed = search.trim();
    if (trimmed) {
      options.search = trimmed;
    }
  }

  const snapshot = params.get('snapshot') ?? params.get('hasSnapshot');
  if (snapshot) {
    const normalized = snapshot.toLowerCase();
    if (normalized === 'with' || normalized === 'true') {
      options.snapshot = 'with';
    } else if (normalized === 'without' || normalized === 'false') {
      options.snapshot = 'without';
    }
  }

  return options;
}

function extractStreamFilters(url: URL): StreamFilters {
  const parsed = parseListOptions(url);
  const { limit: _limit, offset: _offset, ...filters } = parsed;
  if (filters.search) {
    filters.search = filters.search.toLowerCase();
  }
  return filters;
}

function resolveRetryInterval(params: URLSearchParams): number {
  const value = params.get('retry') ?? params.get('retryMs');
  if (!value) {
    return 5000;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 5000;
  }
  return Math.max(1000, Math.min(Math.floor(parsed), 60000));
}

function resolveDateParam(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', chunk => {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify(payload));
}

function extractSnapshotPath(event: EventRecordWithId): string | null {
  const snapshot = event.meta?.snapshot;
  if (typeof snapshot === 'string') {
    return path.resolve(snapshot);
  }
  return null;
}

function extractFaceSnapshotPath(event: EventRecordWithId): string | null {
  const meta = event.meta ?? {};
  const direct = (meta as Record<string, unknown>).faceSnapshot;
  if (typeof direct === 'string' && direct.trim()) {
    return path.resolve(direct);
  }
  const nested = (meta as Record<string, unknown>).face;
  if (nested && typeof nested === 'object' && nested !== null) {
    const snapshot = (nested as Record<string, unknown>).snapshot;
    if (typeof snapshot === 'string' && snapshot.trim()) {
      return path.resolve(snapshot);
    }
  }
  return null;
}

function formatEventForClient<T extends EventRecord | EventRecordWithId>(
  event: T
): T & { meta?: Record<string, unknown> } {
  const originalMeta = (event.meta as Record<string, unknown> | undefined) ?? undefined;
  const meta = sanitizeEventMeta(originalMeta);
  const resolvedChannels = resolveEventChannels(meta);
  if (resolvedChannels.length > 0) {
    meta.resolvedChannels = Array.from(new Set(resolvedChannels));
  }
  const typed = { ...event, meta } as T & { meta?: Record<string, unknown> };
  const id = (event as EventRecordWithId).id;
  if (typeof id === 'number') {
    const snapshotPath = extractSnapshotPath(event as EventRecordWithId);
    const faceSnapshotPath = extractFaceSnapshotPath(event as EventRecordWithId);
    if (snapshotPath) {
      meta.snapshotUrl = `/api/events/${id}/snapshot`;
    }
    if (faceSnapshotPath) {
      meta.faceSnapshotUrl = `/api/events/${id}/face-snapshot`;
    }
  }
  return typed;
}

type SummarizedEvent = EventRecordWithId & { meta?: Record<string, unknown> };

function summarizeEvents(events: SummarizedEvent[]) {
  const totalsByDetector: Record<string, number> = {};
  const totalsBySeverity: Record<string, number> = {};
  const channelMap = new Map<
    string,
    {
      total: number;
      byDetector: Record<string, number>;
      bySeverity: Record<string, number>;
      lastEventTs: number | null;
      snapshots: number;
    }
  >();
  const poseAccumulator = createPoseAccumulator();

  for (const event of events) {
    const detector = event.detector ?? 'unknown';
    const severity = event.severity ?? 'info';
    totalsByDetector[detector] = (totalsByDetector[detector] ?? 0) + 1;
    totalsBySeverity[severity] = (totalsBySeverity[severity] ?? 0) + 1;
    const meta = (event.meta as Record<string, unknown> | undefined) ?? {};
    const resolvedChannels = Array.isArray(meta.resolvedChannels)
      ? (meta.resolvedChannels as unknown[]).filter((value): value is string => typeof value === 'string')
      : resolveEventChannels(meta);
    const fallbackChannel =
      (typeof meta.channel === 'string' && meta.channel.trim()) || event.source || 'unassigned';
    const channels = resolvedChannels.length > 0 ? resolvedChannels : [fallbackChannel];
    const tsCandidate = normalizeTimestamp(event.ts);
    const hasSnapshot = Boolean(meta.snapshotUrl || meta.snapshot || meta.faceSnapshotUrl);

    accumulatePoseSummary(poseAccumulator, meta, {
      eventId: typeof (event as EventRecordWithId).id === 'number' ? (event as EventRecordWithId).id : null,
      ts: tsCandidate,
      detector,
      severity
    });

    for (const channel of channels) {
      const state = channelMap.get(channel) ?? {
        total: 0,
        byDetector: {},
        bySeverity: {},
        lastEventTs: null,
        snapshots: 0
      };
      state.total += 1;
      state.byDetector[detector] = (state.byDetector[detector] ?? 0) + 1;
      state.bySeverity[severity] = (state.bySeverity[severity] ?? 0) + 1;
      if (typeof tsCandidate === 'number') {
        state.lastEventTs = state.lastEventTs ? Math.max(state.lastEventTs, tsCandidate) : tsCandidate;
      }
      if (hasSnapshot) {
        state.snapshots += 1;
      }
      channelMap.set(channel, state);
    }
  }

  const channels = Array.from(channelMap.entries()).map(([id, stats]) => ({
    id,
    total: stats.total,
    lastEventTs: stats.lastEventTs,
    byDetector: stats.byDetector,
    bySeverity: stats.bySeverity,
    snapshots: stats.snapshots
  }));

  const summary: Record<string, unknown> = {
    totals: {
      byDetector: totalsByDetector,
      bySeverity: totalsBySeverity
    },
    channels
  };

  const poseSummary = finalizePoseSummary(poseAccumulator);
  if (poseSummary) {
    summary.pose = poseSummary;
  }

  return summary;
}

function createMetricsDigest(snapshot: ReturnType<MetricsRegistry['snapshot']>) {
  const ffmpegChannels = Object.entries(snapshot.pipelines.ffmpeg.byChannel ?? {}).map(
    ([channel, data]) => ({
      channel,
      restarts: data.restarts,
      lastRestartAt: data.lastRestartAt,
      watchdogBackoffMs: data.watchdogBackoffMs,
      totalWatchdogBackoffMs: data.totalWatchdogBackoffMs,
      totalDelayMs: data.totalRestartDelayMs,
      lastRestart: data.lastRestart
    })
  );

  const retention = snapshot.retention
    ? {
        runs: snapshot.retention.runs,
        lastRunAt: snapshot.retention.lastRunAt,
        warnings: snapshot.retention.warnings,
        warningsByCamera: snapshot.retention.warningsByCamera,
        lastWarning: snapshot.retention.lastWarning,
        totals: snapshot.retention.totals,
        totalsByCamera: snapshot.retention.totalsByCamera
      }
    : undefined;

  return {
    fetchedAt: snapshot.createdAt,
    events: snapshot.events,
    pipelines: {
      ffmpeg: {
        restarts: snapshot.pipelines.ffmpeg.restarts,
        lastRestartAt: snapshot.pipelines.ffmpeg.lastRestartAt,
        channels: ffmpegChannels
      },
      audio: {
        restarts: snapshot.pipelines.audio.restarts,
        lastRestartAt: snapshot.pipelines.audio.lastRestartAt,
        watchdogBackoffMs: snapshot.pipelines.audio.watchdogBackoffMs
      }
    },
    retention
  };
}

function matchesStreamFilters(event: EventRecord, filters: StreamFilters): boolean {
  const meta = (event.meta ?? {}) as Record<string, unknown>;
  const metaCamera = typeof meta.camera === 'string' ? meta.camera : undefined;
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : '';
  const eventChannels = resolveEventChannels(meta);
  const channelFilters = collectChannelFilters(filters);

  if (filters.detector && event.detector !== filters.detector) {
    return false;
  }
  if (filters.source && event.source !== filters.source) {
    return false;
  }
  if (channelFilters.length > 0) {
    const matchesChannel = eventChannels.some(channel => channelFilters.includes(channel));
    if (!matchesChannel) {
      return false;
    }
  }
  if (filters.camera) {
    const cameraMatch =
      event.source === filters.camera || metaCamera === filters.camera || eventChannels.includes(filters.camera);
    if (!cameraMatch) {
      return false;
    }
  }
  if (filters.severity && event.severity !== filters.severity) {
    return false;
  }
  if (typeof filters.since === 'number' && event.ts < filters.since) {
    return false;
  }
  if (typeof filters.until === 'number' && event.ts > filters.until) {
    return false;
  }
  if (filters.snapshot === 'with' && !snapshotPath) {
    return false;
  }
  if (filters.snapshot === 'without' && snapshotPath) {
    return false;
  }

  if (filters.search) {
    const haystack = [
      event.message,
      event.detector,
      event.source,
      snapshotPath,
      ...eventChannels,
      metaCamera
    ]
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.toLowerCase());

    const matches = haystack.some(value => value.includes(filters.search!));
    if (!matches) {
      return false;
    }
  }

  return true;
}

function guessMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.png':
    default:
      return 'image/png';
  }
}

function resolveFacesRequest(params: URLSearchParams): { includeFaces: boolean; query: string | null } {
  const raw = params.get('faces');
  if (!raw) {
    return { includeFaces: false, query: null };
  }

  const normalized = raw.trim();
  if (!normalized) {
    return { includeFaces: false, query: null };
  }

  if (normalized === '1' || normalized.toLowerCase() === 'true') {
    return { includeFaces: true, query: null };
  }

  return { includeFaces: true, query: normalized };
}

function parseChannelParams(params: URLSearchParams): string[] {
  const values: string[] = [];
  values.push(...params.getAll('channel'));
  const multi = params.getAll('channels');
  for (const entry of multi) {
    values.push(entry);
  }
  return values
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

function collectChannelFilters(source: { channel?: string; channels?: string[] | undefined }): string[] {
  const set = new Set<string>();
  if (typeof source.channel === 'string') {
    const trimmed = source.channel.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  if (Array.isArray(source.channels)) {
    for (const candidate of source.channels) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const trimmed = candidate.trim();
      if (trimmed) {
        set.add(trimmed);
      }
    }
  }
  return Array.from(set);
}

type PoseAccumulator = {
  forecasts: number;
  confidenceTotal: number;
  confidenceCount: number;
  lastForecast: {
    ts: number | null;
    eventId: number | null;
    confidence: number | null;
    movingJointCount: number | null;
    movingJointRatio: number | null;
    detector: string | null;
    severity: string | null;
  } | null;
  highestThreat: {
    threatScore: number;
    label: string | null;
    eventId: number | null;
    ts: number | null;
    detector: string | null;
    severity: string | null;
  } | null;
  threatEvents: number;
  threatScoreTotal: number;
  threatDetections: number;
};

type PoseSummaryContext = {
  eventId: number | null;
  ts: number | null;
  detector: string | null;
  severity: string | null;
};

function createPoseAccumulator(): PoseAccumulator {
  return {
    forecasts: 0,
    confidenceTotal: 0,
    confidenceCount: 0,
    lastForecast: null,
    highestThreat: null,
    threatEvents: 0,
    threatScoreTotal: 0,
    threatDetections: 0
  };
}

function accumulatePoseSummary(
  accumulator: PoseAccumulator,
  meta: Record<string, unknown>,
  context: PoseSummaryContext
) {
  const forecast = extractPoseForecast(meta);
  if (forecast) {
    accumulator.forecasts += 1;
    if (typeof forecast.confidence === 'number') {
      accumulator.confidenceTotal += forecast.confidence;
      accumulator.confidenceCount += 1;
    }
    const latest = accumulator.lastForecast;
    if (!latest || (typeof context.ts === 'number' && (latest.ts ?? -Infinity) <= context.ts)) {
      accumulator.lastForecast = {
        ts: context.ts ?? null,
        eventId: context.eventId,
        confidence: typeof forecast.confidence === 'number' ? forecast.confidence : null,
        movingJointCount:
          typeof forecast.movingJointCount === 'number' && Number.isFinite(forecast.movingJointCount)
            ? forecast.movingJointCount
            : null,
        movingJointRatio:
          typeof forecast.movingJointRatio === 'number' && Number.isFinite(forecast.movingJointRatio)
            ? forecast.movingJointRatio
            : null,
        detector: context.detector ?? null,
        severity: context.severity ?? null
      };
    }
  }

  const threat = extractPoseThreatSummary(meta);
  if (threat) {
    accumulator.threatEvents += 1;
    const maxScore = typeof threat.maxThreatScore === 'number' ? threat.maxThreatScore : null;
    if (maxScore !== null) {
      accumulator.threatScoreTotal += maxScore;
      const highest = accumulator.highestThreat;
      if (!highest || highest.threatScore < maxScore) {
        accumulator.highestThreat = {
          threatScore: maxScore,
          label: typeof threat.maxThreatLabel === 'string' ? threat.maxThreatLabel : null,
          eventId: context.eventId,
          ts: context.ts ?? null,
          detector: context.detector ?? null,
          severity: context.severity ?? null
        };
      }
    }
    if (typeof threat.totalDetections === 'number') {
      accumulator.threatDetections += threat.totalDetections;
    }
  }
}

function finalizePoseSummary(accumulator: PoseAccumulator): Record<string, unknown> | null {
  if (
    accumulator.forecasts === 0 &&
    accumulator.confidenceCount === 0 &&
    accumulator.threatEvents === 0 &&
    !accumulator.highestThreat
  ) {
    return null;
  }

  const summary: Record<string, unknown> = {
    forecasts: accumulator.forecasts
  };

  if (accumulator.confidenceCount > 0) {
    summary.averageConfidence = accumulator.confidenceTotal / accumulator.confidenceCount;
  }

  if (accumulator.lastForecast) {
    summary.lastForecast = {
      ts: accumulator.lastForecast.ts,
      eventId: accumulator.lastForecast.eventId,
      confidence: accumulator.lastForecast.confidence,
      movingJointCount: accumulator.lastForecast.movingJointCount,
      movingJointRatio: accumulator.lastForecast.movingJointRatio,
      detector: accumulator.lastForecast.detector,
      severity: accumulator.lastForecast.severity
    };
  }

  if (accumulator.threatEvents > 0 || accumulator.highestThreat) {
    const maxThreat = accumulator.highestThreat
      ? {
          label: accumulator.highestThreat.label,
          threatScore: accumulator.highestThreat.threatScore,
          eventId: accumulator.highestThreat.eventId,
          ts: accumulator.highestThreat.ts,
          detector: accumulator.highestThreat.detector,
          severity: accumulator.highestThreat.severity
        }
      : null;
    summary.threats = {
      events: accumulator.threatEvents,
      averageMaxThreatScore:
        accumulator.threatEvents > 0 ? accumulator.threatScoreTotal / accumulator.threatEvents : null,
      totalDetections: accumulator.threatDetections,
      maxThreat
    };
  }

  return summary;
}

function extractPoseForecast(meta: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = (meta as { poseForecast?: unknown }).poseForecast;
  const sanitized = sanitizePoseForecast(candidate);
  return sanitized;
}

function extractPoseThreatSummary(meta: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = (meta as { poseThreatSummary?: unknown; threats?: unknown }).poseThreatSummary ?? (
    meta as { threats?: unknown }
  ).threats;
  const sanitized = sanitizeThreatSummary(candidate);
  return sanitized;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function sanitizeEventMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const clone = cloneSerializable(meta ?? {});
  const forecast = sanitizePoseForecast(meta ? (meta as Record<string, unknown>)['poseForecast'] : undefined);
  if (forecast) {
    (clone as Record<string, unknown>).poseForecast = forecast;
  } else {
    delete (clone as Record<string, unknown>).poseForecast;
  }

  const threatCandidate = meta
    ? (meta as Record<string, unknown>)['poseThreatSummary'] ?? (meta as Record<string, unknown>)['threats']
    : undefined;
  const threat = sanitizeThreatSummary(threatCandidate);
  if (threat) {
    (clone as Record<string, unknown>).poseThreatSummary = threat;
  } else {
    delete (clone as Record<string, unknown>).poseThreatSummary;
  }

  const threatsField = (clone as Record<string, unknown>).threats;
  if (threatsField) {
    const sanitizedThreats = sanitizeThreatSummary(threatsField);
    if (sanitizedThreats) {
      (clone as Record<string, unknown>).threats = sanitizedThreats;
    } else {
      delete (clone as Record<string, unknown>).threats;
    }
  }

  return clone as Record<string, unknown>;
}

function sanitizePoseForecast(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sanitized = cloneSerializable(record) as Record<string, unknown>;

  const horizon = toFiniteNumber(record.horizonMs);
  if (horizon !== null) {
    sanitized.horizonMs = horizon;
  }

  const confidence = toFiniteNumber(record.confidence);
  if (confidence !== null) {
    sanitized.confidence = confidence;
  }

  const movingJointCount = toFiniteNumber(record.movingJointCount);
  if (movingJointCount !== null) {
    sanitized.movingJointCount = movingJointCount;
  }

  const movingJointRatio = toFiniteNumber(record.movingJointRatio);
  if (movingJointRatio !== null) {
    sanitized.movingJointRatio = movingJointRatio;
  }

  if ('dominantJoint' in record) {
    const dominantJoint = record.dominantJoint;
    if (dominantJoint === null) {
      sanitized.dominantJoint = null;
    } else if (typeof dominantJoint === 'number' && Number.isFinite(dominantJoint)) {
      sanitized.dominantJoint = dominantJoint;
    }
  }

  const booleanFlags = sanitizeBooleanArray(record.movementFlags);
  if (booleanFlags) {
    sanitized.movementFlags = booleanFlags;
  }

  for (const key of [
    'velocity',
    'acceleration',
    'velocityMagnitude',
    'accelerationMagnitude',
    'smoothedVelocity',
    'smoothedAcceleration'
  ]) {
    const array = sanitizeNumberArray(record[key as keyof typeof record]);
    if (array) {
      sanitized[key] = array;
    }
  }

  if (Array.isArray(record.history)) {
    sanitized.history = record.history
      .map(item => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const frame = item as Record<string, unknown>;
        const ts = toFiniteNumber(frame.ts);
        const keypoints = Array.isArray(frame.keypoints)
          ? frame.keypoints
              .map(point => {
                if (!point || typeof point !== 'object') {
                  return null;
                }
                const kp = point as Record<string, unknown>;
                const x = toFiniteNumber(kp.x);
                const y = toFiniteNumber(kp.y);
                if (x === null || y === null) {
                  return null;
                }
                const cleaned: Record<string, unknown> = { x, y };
                const z = toFiniteNumber(kp.z);
                if (z !== null) {
                  cleaned.z = z;
                }
                const c = toFiniteNumber(kp.confidence);
                if (c !== null) {
                  cleaned.confidence = c;
                }
                return cleaned;
              })
              .filter((entry): entry is Record<string, unknown> => entry !== null)
          : [];
        return {
          ts: ts ?? null,
          keypoints
        };
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }

  return sanitized;
}

function sanitizeThreatSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sanitized = cloneSerializable(record) as Record<string, unknown>;

  const maxScore = toFiniteNumber(record.maxThreatScore);
  if (maxScore !== null) {
    sanitized.maxThreatScore = maxScore;
  }

  if ('maxThreatLabel' in record) {
    const label = record.maxThreatLabel;
    if (typeof label === 'string') {
      sanitized.maxThreatLabel = label;
    } else if (label === null) {
      sanitized.maxThreatLabel = null;
    }
  }

  const averageScore = toFiniteNumber(record.averageThreatScore);
  if (averageScore !== null) {
    sanitized.averageThreatScore = averageScore;
  }

  const detections = toFiniteNumber(record.totalDetections);
  if (detections !== null) {
    sanitized.totalDetections = detections;
  }

  if (Array.isArray(record.objects)) {
    sanitized.objects = record.objects
      .map(entry => sanitizeThreatEntry(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }

  return sanitized;
}

function sanitizeThreatEntry(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const threatScore = toFiniteNumber(record.threatScore ?? record.score ?? record.confidence);
  if (threatScore === null) {
    return null;
  }
  const sanitized: Record<string, unknown> = {
    threatScore
  };
  if ('label' in record && typeof record.label === 'string') {
    sanitized.label = record.label;
  }
  if ('threat' in record) {
    sanitized.threat = Boolean(record.threat);
  }
  return sanitized;
}

function cloneSerializable<T>(input: T): T {
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'bigint') {
      return (input <= Number.MAX_SAFE_INTEGER && input >= Number.MIN_SAFE_INTEGER
        ? Number(input)
        : input.toString()) as T;
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(item => cloneSerializable(item)) as unknown as T;
  }
  if (ArrayBuffer.isView(input)) {
    return Array.from(input as unknown as ArrayLike<number>) as unknown as T;
  }
  if (input instanceof Date) {
    return input.toISOString() as unknown as T;
  }
  if (input instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of input.entries()) {
      if (typeof key === 'string') {
        result[key] = cloneSerializable(value);
      }
    }
    return result as unknown as T;
  }
  if (input instanceof Set) {
    return Array.from(input.values()).map(value => cloneSerializable(value)) as unknown as T;
  }
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || typeof value === 'function') {
      continue;
    }
    plain[key] = cloneSerializable(value);
  }
  return plain as unknown as T;
}

function sanitizeNumberArray(value: unknown): number[] | null {
  if (!value) {
    return null;
  }
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (ArrayBuffer.isView(value)) {
    entries = Array.from(value as ArrayLike<number>);
  } else {
    return null;
  }
  const numbers = entries
    .map(item => toFiniteNumber(item))
    .filter((item): item is number => item !== null);
  return numbers.length > 0 ? numbers : null;
}

function sanitizeBooleanArray(value: unknown): boolean[] | null {
  if (!value) {
    return null;
  }
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (ArrayBuffer.isView(value)) {
    entries = Array.from(value as ArrayLike<number>);
  } else {
    return null;
  }
  const booleans = entries.map(item => Boolean(item));
  return booleans.length > 0 ? booleans : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return null;
}

function serveSnapshotFile(req: IncomingMessage, res: ServerResponse, snapshotPath: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(snapshotPath);
  } catch {
    sendJson(res, 404, { error: 'Snapshot missing' });
    return true;
  }

  if (!stats.isFile()) {
    sendJson(res, 404, { error: 'Snapshot not available' });
    return true;
  }

  const etag = createSnapshotEtag(stats);
  const lastModified = stats.mtime.toUTCString();

  if (isNotModified(req, etag, stats.mtimeMs)) {
    res.statusCode = 304;
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('ETag', etag);
    res.end();
    return true;
  }

  const stream = fs.createReadStream(snapshotPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Failed to read snapshot' });
    } else {
      res.destroy();
    }
  });

  res.writeHead(200, {
    'Content-Type': guessMimeType(snapshotPath),
    'Content-Length': stats.size,
    'Cache-Control': 'private, max-age=60',
    'Last-Modified': lastModified,
    ETag: etag
  });
  stream.pipe(res);
  return true;
}

function createSnapshotEtag(stats: fs.Stats): string {
  const mtime = Math.floor(stats.mtimeMs);
  return `W/"${stats.size.toString(16)}-${mtime.toString(16)}"`;
}

function isNotModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const ifNoneMatchRaw = req.headers['if-none-match'];
  const etagMatches = typeof ifNoneMatchRaw === 'string'
    ? checkEtagMatch(parseIfNoneMatch(ifNoneMatchRaw), etag)
    : Array.isArray(ifNoneMatchRaw)
    ? ifNoneMatchRaw.some(value => checkEtagMatch(parseIfNoneMatch(value), etag))
    : false;
  if (etagMatches) {
    return true;
  }

  const modifiedSince = req.headers['if-modified-since'];
  if (typeof modifiedSince === 'string') {
    const parsed = Date.parse(modifiedSince);
    if (!Number.isNaN(parsed) && parsed >= Math.floor(mtimeMs)) {
      return true;
    }
  }

  return false;
}

function parseIfNoneMatch(header: string): string[] {
  return header
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function checkEtagMatch(candidates: string[], etag: string): boolean {
  if (candidates.includes('*')) {
    return true;
  }
  return candidates.includes(etag);
}

function resolveEventChannels(meta: Record<string, unknown>): string[] {
  const channels: string[] = [];
  const candidate = meta.channel;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (trimmed) {
      channels.push(trimmed);
    }
  } else if (Array.isArray(candidate)) {
    for (const value of candidate) {
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        channels.push(trimmed);
      }
    }
  }
  return channels;
}

function filterFaces(faces: FaceRecord[], search: string | null, channels?: string[]): FaceRecord[] {
  let filtered = faces;

  if (search) {
    const query = search.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(face => {
        if (face.label.toLowerCase().includes(query)) {
          return true;
        }
        if (face.metadata) {
          const metadataString = JSON.stringify(face.metadata).toLowerCase();
          return metadataString.includes(query);
        }
        return false;
      });
    }
  }

  const channelFilters = collectChannelFilters({ channels });
  if (channelFilters.length === 0) {
    return filtered;
  }

  const channelSet = new Set(channelFilters);
  return filtered.filter(face => {
    const metadata = face.metadata;
    const candidateChannel =
      metadata && typeof (metadata as Record<string, unknown>).channel === 'string'
        ? ((metadata as Record<string, unknown>).channel as string).trim()
        : metadata && typeof (metadata as Record<string, unknown>).camera === 'string'
        ? ((metadata as Record<string, unknown>).camera as string).trim()
        : '';
    if (!candidateChannel) {
      return false;
    }
    return channelSet.has(candidateChannel);
  });
}
