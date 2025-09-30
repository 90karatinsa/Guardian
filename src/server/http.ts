import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { EventEmitter } from 'node:events';
import defaultBus from '../eventBus.js';
import logger from '../logger.js';
import { createEventsRouter } from './routes/events.js';
import FaceRegistry from '../video/faceRegistry.js';
import metrics from '../metrics/index.js';

export interface HttpServerOptions {
  port?: number;
  host?: string;
  bus?: EventEmitter;
  staticDir?: string;
  faceRegistry?: FaceRegistry;
  createFaceRegistry?: () => Promise<FaceRegistry>;
  snapshotDirs?: string[];
}

export interface HttpServerRuntime {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<HttpServerRuntime> {
  const port = options.port ?? 3000;
  const host = options.host ?? '0.0.0.0';
  const staticDir = options.staticDir ?? path.resolve(process.cwd(), 'public');
  const bus = options.bus ?? defaultBus;

  const eventsRouter = createEventsRouter({
    bus,
    faceRegistry: options.faceRegistry,
    createFaceRegistry:
      options.createFaceRegistry ??
      (async () => FaceRegistry.create({ modelPath: path.resolve(process.cwd(), 'models/face.onnx') })),
    metrics,
    snapshotDirs: options.snapshotDirs
  });

  const server = http.createServer((req, res) => {
    try {
      if (eventsRouter.handle(req, res)) {
        return;
      }

      if (serveStatic(req, res, staticDir)) {
        return;
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      logger.error({ err: error }, 'HTTP request failed');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.on('close', () => {
    eventsRouter.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  logger.info({ port: actualPort, host }, 'HTTP server listening');

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
  };
}

function serveStatic(req: IncomingMessage, res: ServerResponse, directory: string): boolean {
  if (!req.url) {
    return false;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  } else if (pathname.endsWith('/')) {
    pathname = `${pathname}index.html`;
  }

  const normalized = path.normalize(pathname).replace(/^[/\\]+/, '');
  const root = path.resolve(directory);
  const candidatePath = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidatePath !== root && !candidatePath.startsWith(rootWithSep)) {
    return false;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(candidatePath);
  } catch {
    return false;
  }

  let resolvedPath = candidatePath;
  if (stats.isDirectory()) {
    resolvedPath = path.join(candidatePath, 'index.html');
    try {
      stats = fs.statSync(resolvedPath);
    } catch {
      return false;
    }
  }

  if (!stats.isFile()) {
    return false;
  }

  const contentType = getContentType(resolvedPath);
  res.writeHead(200, { 'Content-Type': contentType });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = fs.createReadStream(resolvedPath);
  stream.on('error', error => {
    logger.error({ err: error }, 'Failed to read static asset');
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Internal Server Error');
  });

  stream.pipe(res);
  return true;
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpServer().catch(error => {
    logger.error({ err: error }, 'Failed to start HTTP server');
    process.exitCode = 1;
  });
}

export default startHttpServer;
