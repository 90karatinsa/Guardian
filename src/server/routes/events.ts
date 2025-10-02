import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { PNG } from 'pngjs';
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
import metricsModule, {
  MetricsRegistry,
  type MetricsWarningEvent,
  type RetentionWarningSnapshot,
  type TransportFallbackRecordSnapshot,
  type SuppressionWarningSnapshot
} from '../../metrics/index.js';
import { canonicalChannel, normalizeChannelId } from '../../utils/channel.js';
import configManager from '../../config/index.js';

interface EventsRouterOptions {
  bus: EventEmitter;
  faceRegistry?: FaceRegistry | null;
  createFaceRegistry?: () => Promise<FaceRegistry>;
  metrics?: MetricsRegistry;
  snapshotDirs?: string[];
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

type StreamFilters = Omit<ListEventsOptions, 'limit' | 'offset' | 'afterId'>;

type MetricsSelection = {
  enabled: boolean;
  includeEvents: boolean;
  includeRetention: boolean;
  pipelines: Set<'ffmpeg' | 'audio'>;
};

type SnapshotSelection = {
  enabled: boolean;
  historyLimit: number;
};

type ResumeRequest = {
  enabled: boolean;
  lastEventId: number | null;
  backlogLimit: number;
};

type ClientState = {
  heartbeat: NodeJS.Timeout;
  filters: StreamFilters;
  retryMs: number;
  includeFaces: boolean;
  facesQuery: string | null;
  metricsFilter: MetricsSelection;
  snapshots: SnapshotSelection;
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
  private readonly metricsWarningHandler: ((event: MetricsWarningEvent) => void) | null;
  private readonly snapshotAllowlist: Set<string>;

  constructor(options: EventsRouterOptions) {
    this.bus = options.bus;
    this.heartbeatMs = 15000;
    this.handlers = [
      (req, res, url) => this.handleList(req, res, url),
      (req, res, url) => this.handleSnapshotList(req, res, url),
      (req, res, url) => this.handleMetrics(req, res, url),
      (req, res, url) => this.handleStream(req, res, url),
      (req, res, url) => this.handleSnapshotDiff(req, res, url),
      (req, res, url) => this.handleSnapshot(req, res, url),
      (req, res, url) => this.handleFaces(req, res, url)
    ];
    this.faceRegistry = options.faceRegistry ?? null;
    this.faceRegistryFactory = options.createFaceRegistry;
    this.metrics = options.metrics ?? metricsModule;
    this.metricsWarningHandler = event => {
      this.broadcastWarning(event);
    };
    this.snapshotAllowlist = buildSnapshotAllowlist(options.snapshotDirs ?? []);
    this.metrics.onWarning(this.metricsWarningHandler);

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
    if (this.metricsWarningHandler) {
      this.metrics.offWarning(this.metricsWarningHandler);
    }
    for (const [client, state] of this.clients) {
      clearInterval(state.heartbeat);
      client.end();
    }
    this.clients.clear();
  }

  private readonly handleBusEvent = (event: EventRecord) => {
    const formatted = formatEventForClient(event);
    const payload = JSON.stringify(formatted);
    const metricsSnapshot = this.metrics.snapshot();
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
        writeEventBlock(client, formatted, payload);
        const digest = createMetricsDigest(metricsSnapshot, state.metricsFilter);
        if (digest) {
          client.write(`event: metrics\n`);
          client.write(`data: ${JSON.stringify(digest)}\n\n`);
        }
      } catch (error) {
        clearInterval(state.heartbeat);
        client.end();
        this.clients.delete(client);
      }
    }
  };

  private broadcastWarning(event: MetricsWarningEvent) {
    let payload:
      | { type: 'retention'; warning: RetentionWarningSnapshot }
      | { type: 'transport-fallback'; fallback: TransportFallbackRecordSnapshot }
      | { type: 'suppression'; suppression: SuppressionWarningSnapshot };

    switch (event.type) {
      case 'retention':
        payload = { type: 'retention', warning: event.warning };
        break;
      case 'transport-fallback':
        payload = { type: 'transport-fallback', fallback: event.fallback };
        break;
      case 'suppression':
        payload = { type: 'suppression', suppression: event.suppression };
        break;
      default:
        return;
    }

    for (const [client, state] of this.clients) {
      if (client.writableEnded) {
        clearInterval(state.heartbeat);
        this.clients.delete(client);
        continue;
      }

      try {
        client.write('event: warning\n');
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        clearInterval(state.heartbeat);
        client.end();
        this.clients.delete(client);
      }
    }
  }

  private isSnapshotAllowed(filePath: string): boolean {
    return isPathInAllowedDirectories(filePath, this.snapshotAllowlist);
  }

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

  private handleSnapshotList(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET' || url.pathname !== '/api/events/snapshots') {
      return false;
    }

    const options = parseListOptions(url);
    if (!options.snapshot) {
      options.snapshot = 'with';
    }
    const faceFilter = resolveFaceSnapshotFilter(url.searchParams);
    if (faceFilter) {
      options.faceSnapshot = faceFilter;
    }

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
    const metricsFilter = resolveMetricsSelection(url.searchParams);
    const snapshotRequest = resolveSnapshotRequest(url.searchParams);
    const resumeRequest = resolveResumeRequest(req, url);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': connected\n');
    res.write(`retry: ${retryMs}\n`);
    res.write(`event: stream-status\n`);
    const statusPayload = {
      status: 'connected',
      retryMs,
      filters,
      metrics: metricsFilter.enabled
        ? {
            enabled: true,
            events: metricsFilter.includeEvents,
            retention: metricsFilter.includeRetention,
            pipelines: Array.from(metricsFilter.pipelines)
          }
        : { enabled: false }
    };
    res.write(`data: ${JSON.stringify(statusPayload)}\n\n`);
    const metricsSnapshot = this.metrics.snapshot();
    const initialDigest = createMetricsDigest(metricsSnapshot, metricsFilter);
    if (initialDigest) {
      res.write(`event: metrics\n`);
      res.write(`data: ${JSON.stringify(initialDigest)}\n\n`);
    }

    this.sendHeartbeat(res);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        this.clients.delete(res);
        return;
      }

      if (!this.sendHeartbeat(res)) {
        clearInterval(heartbeat);
        this.clients.delete(res);
      }
    }, this.heartbeatMs);

    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }

    this.clients.set(res, {
      heartbeat,
      filters,
      retryMs,
      includeFaces: facesRequest.includeFaces,
      facesQuery: facesRequest.query,
      metricsFilter,
      snapshots: snapshotRequest
    });

    if (facesRequest.includeFaces) {
      void this.pushFacesSnapshot(res, facesRequest.query, filters.channels);
    }

    if (snapshotRequest.enabled) {
      void this.pushSnapshotHistory(res, filters, snapshotRequest);
    }

    if (resumeRequest.enabled && resumeRequest.lastEventId !== null) {
      void this.pushEventBacklog(res, filters, resumeRequest.lastEventId, resumeRequest.backlogLimit);
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      req.off('close', cleanup);
      req.off('end', cleanup);
      req.off('error', cleanup);
      res.off('error', cleanup);
      res.off('close', cleanup);

      const client = this.clients.get(res);
      if (client) {
        clearInterval(client.heartbeat);
      }
      this.clients.delete(res);
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    res.on('close', cleanup);
    return true;
  }

  private handleSnapshotDiff(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET') {
      return false;
    }

    const match = url.pathname.match(/^\/api\/events\/(\d+)\/snapshot\/diff$/);
    if (!match) {
      return false;
    }

    const eventId = Number(match[1]);
    if (!Number.isInteger(eventId) || eventId < 0) {
      sendJson(res, 400, { error: 'Invalid event id' });
      return true;
    }

    const event = getEventById(eventId);
    if (!event) {
      sendJson(res, 404, { error: 'Event not found' });
      return true;
    }

    const currentSnapshot = extractSnapshotPath(event);
    const baselineSnapshot = extractSnapshotBaselinePath(event);
    if (!currentSnapshot || !baselineSnapshot) {
      sendJson(res, 404, { error: 'Snapshot diff not available' });
      return true;
    }

    if (!this.isSnapshotAllowed(currentSnapshot) || !this.isSnapshotAllowed(baselineSnapshot)) {
      sendJson(res, 403, { error: 'Snapshot path not authorized' });
      return true;
    }

    try {
      const diffBuffer = createSnapshotDiff(currentSnapshot, baselineSnapshot);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(diffBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Snapshot dimensions do not match') {
        logger.debug(
          { snapshot: currentSnapshot, baseline: baselineSnapshot },
          'Snapshot diff dimensions mismatch'
        );
        sendJson(res, 409, { error: 'Snapshot dimensions do not match' });
      } else {
        logger.error(
          { err: error, snapshot: currentSnapshot, baseline: baselineSnapshot },
          'Failed to generate snapshot diff'
        );
        sendJson(res, 500, { error: 'Failed to generate snapshot diff' });
      }
    }

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
    return serveSnapshotFile(req, res, snapshotPath, this.snapshotAllowlist);
  }

  private handleFaces(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith('/api/faces')) {
      return false;
    }

    if (req.method === 'GET' && url.pathname === '/api/faces') {
      const search = (url.searchParams.get('search') ?? url.searchParams.get('q')) || null;
      const channelFilters = parseChannelParams(url.searchParams);
      void this.handleFaceList(res, search, channelFilters);
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

  private async handleFaceList(res: ServerResponse, search: string | null, channels: string[]) {
    const registry = await this.ensureFaceRegistry();
    if (!registry) {
      this.respondFaceUnavailable(res);
      return;
    }

    const faces = filterFaces(registry.list(), search, channels);
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

  private sendHeartbeat(res: ServerResponse): boolean {
    if (res.writableEnded) {
      return false;
    }

    try {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      return true;
    } catch (error) {
      return false;
    }
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

  private async pushSnapshotHistory(
    target: ServerResponse,
    filters: StreamFilters,
    request: SnapshotSelection
  ): Promise<void> {
    if (!request.enabled || request.historyLimit <= 0 || target.writableEnded) {
      return;
    }

    const options: ListEventsOptions = {
      ...filters,
      snapshot: 'with',
      limit: request.historyLimit,
      offset: 0
    };

    try {
      const history = listEvents(options);
      if (!history.items.length) {
        return;
      }

      const ordered = history.items.slice().reverse();
      for (const entry of ordered) {
        if (target.writableEnded) {
          return;
        }
        const formatted = formatEventForClient(entry);
        writeEventBlock(target, formatted);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stream snapshot history');
    }
  }

  private async pushEventBacklog(
    target: ServerResponse,
    filters: StreamFilters,
    lastEventId: number,
    limit: number
  ): Promise<void> {
    if (target.writableEnded) {
      return;
    }

    const normalizedLastId = Number.isFinite(lastEventId) ? Math.floor(lastEventId) : NaN;
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;

    if (!Number.isFinite(normalizedLastId) || normalizedLastId < 0) {
      return;
    }

    const options: ListEventsOptions = {
      ...filters,
      afterId: normalizedLastId,
      limit: normalizedLimit,
      offset: 0
    };

    try {
      const backlog = listEvents(options);
      if (!backlog.items.length) {
        return;
      }

      const ordered = backlog.items.slice().reverse();
      for (const entry of ordered) {
        if (target.writableEnded) {
          return;
        }
        const formatted = formatEventForClient(entry);
        writeEventBlock(target, formatted);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stream event backlog');
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

function buildSnapshotAllowlist(additional: string[]): Set<string> {
  const allowlist = new Set<string>();

  const register = (value: string | undefined | null) => {
    if (!value) {
      return;
    }
    allowlist.add(path.resolve(value));
  };

  try {
    const config = configManager.getConfig();
    register(config.person?.snapshotDir);

    const video = config.video ?? {};
    for (const channelConfig of Object.values(video.channels ?? {})) {
      register(channelConfig.person?.snapshotDir);
    }
    for (const camera of video.cameras ?? []) {
      register(camera.person?.snapshotDir);
    }
  } catch (error) {
    logger.debug({ err: error }, 'Failed to load snapshot directories from config');
  }

  for (const directory of additional) {
    register(directory);
  }

  return allowlist;
}

function isPathInAllowedDirectories(filePath: string, directories: Set<string>): boolean {
  if (!filePath || directories.size === 0) {
    return false;
  }

  const resolvedTarget = path.resolve(filePath);
  for (const directory of directories) {
    const resolvedDirectory = path.resolve(directory);
    if (resolvedTarget === resolvedDirectory) {
      return true;
    }

    const prefix = resolvedDirectory.endsWith(path.sep)
      ? resolvedDirectory
      : `${resolvedDirectory}${path.sep}`;
    if (resolvedTarget.startsWith(prefix)) {
      return true;
    }
  }

  return false;
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

  const faceSnapshotParam = params.get('faceSnapshot');
  if (faceSnapshotParam) {
    const normalized = faceSnapshotParam.toLowerCase();
    if (normalized === 'with' || normalized === 'only' || normalized === 'true') {
      options.faceSnapshot = 'with';
    } else if (normalized === 'without' || normalized === 'false') {
      options.faceSnapshot = 'without';
    }
  } else {
    const facesFilter = params.get('faces');
    if (facesFilter) {
      const normalized = facesFilter.trim().toLowerCase();
      if (normalized === 'with' || normalized === 'only') {
        options.faceSnapshot = 'with';
      } else if (normalized === 'without') {
        options.faceSnapshot = 'without';
      }
    }
  }

  return options;
}

function extractStreamFilters(url: URL): StreamFilters {
  const parsed = parseListOptions(url);
  const { limit: _limit, offset: _offset, afterId: _afterId, ...filters } = parsed;
  if (filters.search) {
    filters.search = filters.search.toLowerCase();
  }
  return filters;
}

const DEFAULT_BACKLOG_LIMIT = 50;

function resolveResumeRequest(req: IncomingMessage, url: URL): ResumeRequest {
  const params = url.searchParams;

  const parseId = (value: string | null): number | null => {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const normalized = Math.floor(parsed);
    return normalized >= 0 ? normalized : null;
  };

  const queryId =
    parseId(params.get('lastEventId')) ?? parseId(params.get('lastEventID')) ?? null;

  const headerValue = req.headers['last-event-id'];
  let headerId: number | null = null;
  if (typeof headerValue === 'string') {
    headerId = parseId(headerValue);
  } else if (Array.isArray(headerValue)) {
    const lastValue = headerValue[headerValue.length - 1] ?? null;
    headerId = parseId(lastValue ?? null);
  }

  const lastEventId = queryId ?? headerId;

  const backlogParam = params.get('backlog');
  const backlogDisabled =
    backlogParam !== null &&
    ['0', 'false', 'no', 'off'].includes(backlogParam.trim().toLowerCase());

  const limitParam = params.get('backlogLimit');
  let backlogLimit = DEFAULT_BACKLOG_LIMIT;
  if (limitParam) {
    const parsedLimit = Number(limitParam);
    if (Number.isFinite(parsedLimit)) {
      const normalized = Math.max(1, Math.floor(parsedLimit));
      backlogLimit = Math.min(normalized, 100);
    }
  }

  const enabled = !backlogDisabled && typeof lastEventId === 'number';

  return {
    enabled,
    lastEventId: typeof lastEventId === 'number' ? lastEventId : null,
    backlogLimit
  };
}

function resolveRetryInterval(params: URLSearchParams): number {
  const clamp = (value: number) => Math.max(1000, Math.min(Math.floor(value), 60000));

  const retryMs = params.get('retryMs');
  if (retryMs) {
    const parsed = Number(retryMs);
    if (Number.isFinite(parsed)) {
      return clamp(parsed);
    }
    return 5000;
  }

  const retrySeconds = params.get('retry');
  if (!retrySeconds) {
    return 5000;
  }

  const normalized = retrySeconds.trim().toLowerCase();
  const numeric = Number(normalized.endsWith('s') ? normalized.slice(0, -1) : normalized);
  if (!Number.isFinite(numeric)) {
    return 5000;
  }

  return clamp(numeric * 1000);
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

function extractSnapshotBaselinePath(event: EventRecordWithId): string | null {
  const meta = event.meta ?? {};
  const candidates: Array<string | null | undefined> = [
    (meta as Record<string, unknown>).snapshotBaseline as string | undefined,
    (meta as Record<string, unknown>).baselineSnapshot as string | undefined
  ];
  const diffMeta = (meta as Record<string, unknown>).snapshotDiff;
  if (diffMeta && typeof diffMeta === 'object') {
    const diffRecord = diffMeta as Record<string, unknown>;
    candidates.push(diffRecord.baseline as string | undefined);
    candidates.push(diffRecord.previous as string | undefined);
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function createSnapshotDiff(currentPath: string, baselinePath: string): Buffer {
  const currentBuffer = fs.readFileSync(currentPath);
  const baselineBuffer = fs.readFileSync(baselinePath);
  const current = PNG.sync.read(currentBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (current.width !== baseline.width || current.height !== baseline.height) {
    throw new Error('Snapshot dimensions do not match');
  }

  const diff = new PNG({ width: current.width, height: current.height });
  for (let y = 0; y < current.height; y += 1) {
    for (let x = 0; x < current.width; x += 1) {
      const idx = (current.width * y + x) << 2;
      const r = Math.abs(current.data[idx] - baseline.data[idx]);
      const g = Math.abs(current.data[idx + 1] - baseline.data[idx + 1]);
      const b = Math.abs(current.data[idx + 2] - baseline.data[idx + 2]);
      const magnitude = Math.max(r, g, b);
      diff.data[idx] = magnitude;
      diff.data[idx + 1] = g;
      diff.data[idx + 2] = b;
      diff.data[idx + 3] = magnitude > 0 ? 255 : 80;
    }
  }

  return PNG.sync.write(diff);
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
    const baselineSnapshotPath = extractSnapshotBaselinePath(event as EventRecordWithId);
    if (snapshotPath && baselineSnapshotPath) {
      meta.snapshotDiffUrl = `/api/events/${id}/snapshot/diff`;
    }
  }
  return typed;
}

type SummarizedEvent = EventRecordWithId & { meta?: Record<string, unknown> };

function writeEventBlock(
  target: ServerResponse,
  event: SummarizedEvent,
  serialized?: string
) {
  const payload = serialized ?? JSON.stringify(event);
  if (typeof event.id === 'number') {
    target.write(`id: ${event.id}\n`);
  }
  target.write(`data: ${payload}\n\n`);
}

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
      canonicalChannel(typeof meta.channel === 'string' ? meta.channel : null) ||
      canonicalChannel(event.source ?? null) ||
      'unassigned';
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

function createMetricsDigest(
  snapshot: ReturnType<MetricsRegistry['snapshot']>,
  selection: MetricsSelection = {
    enabled: true,
    includeEvents: true,
    includeRetention: true,
    pipelines: new Set(['ffmpeg', 'audio'])
  }
) {
  if (!selection.enabled) {
    return null;
  }

  const digest: Record<string, unknown> = {
    fetchedAt: snapshot.createdAt
  };

  if (selection.includeEvents) {
    digest.events = snapshot.events;
  }

  const pipelinePayload: Record<string, unknown> = {};

  if (selection.pipelines.has('ffmpeg')) {
    const ffmpegChannels = Object.entries(snapshot.pipelines.ffmpeg.byChannel ?? {}).map(
      ([channel, data]) => ({
        channel,
        restarts: data.restarts,
        lastRestartAt: data.lastRestartAt,
        watchdogBackoffMs: data.watchdogBackoffMs,
        totalWatchdogBackoffMs: data.totalWatchdogBackoffMs,
        totalDelayMs: data.totalRestartDelayMs,
        lastRestart: data.lastRestart,
        health: {
          severity: data.health?.severity ?? 'none',
          reason: data.health?.reason ?? null,
          degradedSince: data.health?.degradedSince ?? null
        }
      })
    );
    pipelinePayload.ffmpeg = {
      restarts: snapshot.pipelines.ffmpeg.restarts,
      lastRestartAt: snapshot.pipelines.ffmpeg.lastRestartAt,
      channels: ffmpegChannels
    };
  }

  if (selection.pipelines.has('audio')) {
    const audioChannels = Object.entries(snapshot.pipelines.audio.byChannel ?? {}).map(
      ([channel, data]) => ({
        channel,
        restarts: data.restarts,
        watchdogBackoffMs: data.watchdogBackoffMs,
        lastRestartAt: data.lastRestartAt,
        lastRestart: data.lastRestart,
        health: {
          severity: data.health?.severity ?? 'none',
          reason: data.health?.reason ?? null,
          degradedSince: data.health?.degradedSince ?? null
        }
      })
    );
    pipelinePayload.audio = {
      restarts: snapshot.pipelines.audio.restarts,
      lastRestartAt: snapshot.pipelines.audio.lastRestartAt,
      watchdogBackoffMs: snapshot.pipelines.audio.watchdogBackoffMs,
      channels: audioChannels
    };
  }

  if (Object.keys(pipelinePayload).length > 0) {
    digest.pipelines = pipelinePayload;
  }

  if (selection.includeRetention && snapshot.retention) {
    digest.retention = {
      runs: snapshot.retention.runs,
      lastRunAt: snapshot.retention.lastRunAt,
      warnings: snapshot.retention.warnings,
      warningsByCamera: snapshot.retention.warningsByCamera,
      lastWarning: snapshot.retention.lastWarning,
      totals: snapshot.retention.totals,
      totalsByCamera: snapshot.retention.totalsByCamera
    };
  }

  return digest;
}

function matchesStreamFilters(event: EventRecord, filters: StreamFilters): boolean {
  const meta = (event.meta ?? {}) as Record<string, unknown>;
  const metaCamera = typeof meta.camera === 'string' ? meta.camera : undefined;
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : '';
  const eventChannels = resolveEventChannels(meta);
  const sourceChannel = canonicalChannel(event.source ?? null);
  const cameraChannel =
    typeof metaCamera === 'string' ? canonicalChannel(metaCamera) : null;
  const channelCandidates = new Set(eventChannels);
  if (cameraChannel) {
    channelCandidates.add(cameraChannel);
  }
  if (sourceChannel) {
    channelCandidates.add(sourceChannel);
  }
  const candidateChannels = Array.from(channelCandidates);
  const channelFilters = collectChannelFilters(filters);

  if (filters.detector && event.detector !== filters.detector) {
    return false;
  }
  if (filters.source && event.source !== filters.source) {
    return false;
  }
  if (channelFilters.length > 0) {
    const matchesChannel = candidateChannels.some(channel => channelFilters.includes(channel));
    if (!matchesChannel) {
      return false;
    }
  }
  if (filters.camera) {
    const canonicalCameraFilter = canonicalChannel(filters.camera);
    const cameraMatch =
      event.source === filters.camera ||
      metaCamera === filters.camera ||
      candidateChannels.includes(filters.camera) ||
      (canonicalCameraFilter ? candidateChannels.includes(canonicalCameraFilter) : false);
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

function resolveSnapshotRequest(params: URLSearchParams): SnapshotSelection {
  const raw = params.get('snapshots') ?? params.get('snapshotStream');
  if (!raw) {
    return { enabled: false, historyLimit: 0 };
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized || ['0', 'false', 'no', 'off', 'none'].includes(normalized)) {
    return { enabled: false, historyLimit: 0 };
  }

  const limitParam =
    params.get('snapshotLimit') ?? params.get('snapshotsLimit') ?? params.get('history') ?? params.get('snapshotsHistory');
  const parsedLimit = limitParam ? Number(limitParam) : NaN;
  const defaultLimit = 10;
  const limit = Number.isFinite(parsedLimit) ? Math.max(0, Math.min(Math.floor(parsedLimit), 100)) : defaultLimit;
  return { enabled: true, historyLimit: limit };
}

function parseChannelParams(params: URLSearchParams): string[] {
  const raw: string[] = [];
  raw.push(...params.getAll('channel'));
  const multi = params.getAll('channels');
  for (const entry of multi) {
    raw.push(entry);
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.flatMap(value => value.split(','))) {
    const normalized = canonicalChannel(entry);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      values.push(normalized);
    }

    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    if (trimmed && !trimmed.includes(':')) {
      const audioVariant = canonicalChannel(entry, { defaultType: 'audio' });
      if (audioVariant && !seen.has(audioVariant)) {
        seen.add(audioVariant);
        values.push(audioVariant);
      }
    }
  }
  return values;
}

function resolveMetricsSelection(params: URLSearchParams): MetricsSelection {
  const rawTokens = params
    .getAll('metrics')
    .flatMap(value => value.split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (rawTokens.length === 0) {
    return {
      enabled: true,
      includeEvents: true,
      includeRetention: true,
      pipelines: new Set(['ffmpeg', 'audio'])
    };
  }

  const recognized = rawTokens.filter(token =>
    ['none', 'all', 'events', 'retention', 'ffmpeg', 'audio'].includes(token)
  );

  if (recognized.includes('none')) {
    return { enabled: false, includeEvents: false, includeRetention: false, pipelines: new Set() };
  }

  if (recognized.length === 0) {
    return {
      enabled: true,
      includeEvents: true,
      includeRetention: true,
      pipelines: new Set(['ffmpeg', 'audio'])
    };
  }

  const includeAll = recognized.includes('all');
  const includeRetention = includeAll || recognized.includes('retention');
  const pipelineTokens = includeAll
    ? ['ffmpeg', 'audio']
    : recognized.filter(token => token === 'ffmpeg' || token === 'audio');
  const pipelines = pipelineTokens.length > 0
    ? new Set(pipelineTokens as Array<'ffmpeg' | 'audio'>)
    : new Set<'ffmpeg' | 'audio'>();

  const includeEvents = includeAll || recognized.includes('events');

  return { enabled: true, includeEvents, includeRetention, pipelines };
}

function resolveFaceSnapshotFilter(params: URLSearchParams): 'with' | 'without' | undefined {
  const candidate = params.get('faceSnapshot') ?? params.get('faces');
  if (!candidate) {
    return undefined;
  }
  const normalized = candidate.trim().toLowerCase();
  if (normalized === 'with' || normalized === 'only' || normalized === 'true') {
    return 'with';
  }
  if (normalized === 'without' || normalized === 'false') {
    return 'without';
  }
  return undefined;
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

  delete (clone as Record<string, unknown>).snapshotBaseline;
  delete (clone as Record<string, unknown>).baselineSnapshot;
  const diffMeta = (clone as Record<string, unknown>).snapshotDiff;
  if (diffMeta && typeof diffMeta === 'object') {
    const diffRecord = diffMeta as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    if (typeof diffRecord.label === 'string') {
      sanitized.label = diffRecord.label;
    }
    if (typeof diffRecord.reason === 'string') {
      sanitized.reason = diffRecord.reason;
    }
    (clone as Record<string, unknown>).snapshotDiff = Object.keys(sanitized).length > 0 ? sanitized : undefined;
    if (Object.keys(sanitized).length === 0) {
      delete (clone as Record<string, unknown>).snapshotDiff;
    }
  } else {
    delete (clone as Record<string, unknown>).snapshotDiff;
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

function serveSnapshotFile(
  req: IncomingMessage,
  res: ServerResponse,
  snapshotPath: string,
  allowlist: Set<string>
): boolean {
  const resolvedPath = path.resolve(snapshotPath);
  if (!isPathInAllowedDirectories(resolvedPath, allowlist)) {
    sendJson(res, 403, { error: 'Snapshot path not authorized' });
    return true;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedPath);
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

  const stream = fs.createReadStream(resolvedPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Failed to read snapshot' });
    } else {
      res.destroy();
    }
  });

  res.writeHead(200, {
    'Content-Type': guessMimeType(resolvedPath),
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
    const normalized = canonicalChannel(candidate);
    if (normalized) {
      channels.push(normalized);
    }
  } else if (Array.isArray(candidate)) {
    for (const value of candidate) {
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = canonicalChannel(value);
      if (normalized) {
        channels.push(normalized);
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
