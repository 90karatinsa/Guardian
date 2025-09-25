import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { EventRecordWithId, getEventById, listEvents, ListEventsOptions } from '../../db.js';
import FaceRegistry, { IdentifyResult } from '../../video/faceRegistry.js';
import logger from '../../logger.js';
import { EventRecord } from '../../types.js';

interface EventsRouterOptions {
  bus: EventEmitter;
  faceRegistry?: FaceRegistry | null;
  createFaceRegistry?: () => Promise<FaceRegistry>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

type StreamFilters = Omit<ListEventsOptions, 'limit' | 'offset'>;

type ClientState = {
  heartbeat: NodeJS.Timeout;
  filters: StreamFilters;
  retryMs: number;
};

export class EventsRouter {
  private readonly bus: EventEmitter;
  private readonly clients = new Map<ServerResponse, ClientState>();
  private readonly handlers: Handler[];
  private readonly heartbeatMs: number;
  private faceRegistry: FaceRegistry | null;
  private faceRegistryFactory?: () => Promise<FaceRegistry>;
  private faceRegistryPromise: Promise<FaceRegistry | null> | null = null;

  constructor(options: EventsRouterOptions) {
    this.bus = options.bus;
    this.heartbeatMs = 15000;
    this.handlers = [
      (req, res, url) => this.handleList(req, res, url),
      (req, res, url) => this.handleStream(req, res, url),
      (req, res, url) => this.handleSnapshot(req, res, url),
      (req, res, url) => this.handleFaces(req, res, url)
    ];
    this.faceRegistry = options.faceRegistry ?? null;
    this.faceRegistryFactory = options.createFaceRegistry;

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
    const payload = JSON.stringify(event);
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

    sendJson(res, 200, {
      items: result.items,
      total: result.total,
      limit: options.limit ?? undefined,
      offset: options.offset ?? undefined
    });

    return true;
  }

  private handleStream(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET' || url.pathname !== '/api/events/stream') {
      return false;
    }

    const filters = extractStreamFilters(url);
    const retryMs = resolveRetryInterval(url.searchParams);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': connected\n');
    res.write(`retry: ${retryMs}\n`);
    res.write(`event: stream-status\n`);
    res.write(`data: ${JSON.stringify({ status: 'connected', retryMs, filters })}\n\n`);

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

    this.clients.set(res, { heartbeat, filters, retryMs });

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

    const snapshotMatch = url.pathname.match(/^\/api\/events\/(\d+)\/snapshot$/);
    if (!snapshotMatch) {
      return false;
    }

    const eventId = Number(snapshotMatch[1]);
    if (!Number.isFinite(eventId)) {
      sendJson(res, 400, { error: 'Invalid event id' });
      return true;
    }

    const event = getEventById(eventId);
    if (!event) {
      sendJson(res, 404, { error: 'Event not found' });
      return true;
    }

    const snapshotPath = extractSnapshotPath(event);
    if (!snapshotPath) {
      sendJson(res, 404, { error: 'Snapshot not available' });
      return true;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(snapshotPath);
    } catch (error) {
      sendJson(res, 404, { error: 'Snapshot missing' });
      return true;
    }

    if (!stats.isFile()) {
      sendJson(res, 404, { error: 'Snapshot not available' });
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
      'Content-Type': guessMimeType(snapshotPath)
    });

    stream.pipe(res);
    return true;
  }

  private handleFaces(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith('/api/faces')) {
      return false;
    }

    if (req.method === 'GET' && url.pathname === '/api/faces') {
      void this.handleFaceList(res);
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

  private async handleFaceList(res: ServerResponse) {
    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      this.respondFaceUnavailable(res);
      return;
    }

    const faces = registry.list();
    sendJson(res, 200, { faces });
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
      match: result.match
        ? { face: result.match.face, distance: result.match.distance }
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

  const channel = params.get('channel');
  if (channel) {
    options.channel = channel;
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

function matchesStreamFilters(event: EventRecord, filters: StreamFilters): boolean {
  const meta = (event.meta ?? {}) as Record<string, unknown>;
  const metaChannel = typeof meta.channel === 'string' ? meta.channel : undefined;
  const metaCamera = typeof meta.camera === 'string' ? meta.camera : undefined;
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : '';

  if (filters.detector && event.detector !== filters.detector) {
    return false;
  }
  if (filters.source && event.source !== filters.source) {
    return false;
  }
  if (filters.channel && metaChannel !== filters.channel) {
    return false;
  }
  if (filters.camera) {
    const cameraMatch =
      event.source === filters.camera || metaCamera === filters.camera || metaChannel === filters.camera;
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
      metaChannel,
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
