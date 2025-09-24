import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { EventRecordWithId, getEventById, listEvents, ListEventsOptions } from '../../db.js';
import { EventRecord } from '../../types.js';

interface EventsRouterOptions {
  bus: EventEmitter;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

export class EventsRouter {
  private readonly bus: EventEmitter;
  private readonly clients = new Map<ServerResponse, NodeJS.Timeout>();
  private readonly handlers: Handler[];
  private readonly heartbeatMs: number;

  constructor(options: EventsRouterOptions) {
    this.bus = options.bus;
    this.heartbeatMs = 15000;
    this.handlers = [
      (req, res, url) => this.handleList(req, res, url),
      (req, res, url) => this.handleStream(req, res, url),
      (req, res, url) => this.handleSnapshot(req, res, url)
    ];

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
    for (const [client, timer] of this.clients) {
      if (client.writableEnded) {
        clearInterval(timer);
        this.clients.delete(client);
        continue;
      }

      try {
        client.write(`data: ${payload}\n\n`);
      } catch (error) {
        clearInterval(timer);
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

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        this.clients.delete(res);
        return;
      }

      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (error) {
        clearInterval(heartbeat);
        this.clients.delete(res);
      }
    }, this.heartbeatMs);

    this.clients.set(res, heartbeat);

    const cleanup = () => {
      const timer = this.clients.get(res);
      if (timer) {
        clearInterval(timer);
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
  const since = toNumber(params.get('since'));
  const until = toNumber(params.get('until'));

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

  return options;
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
