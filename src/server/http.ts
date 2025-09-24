import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { EventEmitter } from 'node:events';
import defaultBus from '../eventBus.js';
import logger from '../logger.js';
import { createEventsRouter } from './routes/events.js';

export interface HttpServerOptions {
  port?: number;
  host?: string;
  bus?: EventEmitter;
  staticDir?: string;
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

  const eventsRouter = createEventsRouter({ bus });

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
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    return false;
  }

  const indexPath = path.join(directory, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.statusCode = 404;
    res.end('Not Found');
    return true;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = fs.createReadStream(indexPath);
  stream.on('error', error => {
    logger.error({ err: error }, 'Failed to read dashboard');
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Internal Server Error');
  });

  stream.pipe(res);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpServer().catch(error => {
    logger.error({ err: error }, 'Failed to start HTTP server');
    process.exitCode = 1;
  });
}

export default startHttpServer;
