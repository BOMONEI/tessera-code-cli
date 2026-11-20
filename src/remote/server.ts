import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Devices } from './devices.js';
import { ApiError, callApi, eventsRoute, streamEvents, type Hub } from './api.js';
import type { Sequenced } from './protocol.js';

export type { Hub } from './api.js';


const MAX_BODY = 1_000_000;
const HEARTBEAT_MS = 25_000;
/** Open event streams at once (a few devices with a few tabs each). */
const MAX_STREAMS = 32;

const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
  '/icon.svg': 'icon.svg',
};
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
};
// The page can only run its own script and talk to this server: model output it shows cannot load anything.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** The bundled web app: next to the bundle chunk, or the build output when run from source. */
export function webDir(): string | undefined {
  for (const rel of ['./web/', '../../dist/bundle/web/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir + 'index.html')) return dir;
  }
  return undefined;
}

/** Serves a file of the web app for `path`; false when `path` is not one of them. */
export async function serveStatic(dir: string | undefined, path: string, res: ServerResponse): Promise<boolean> {
  const file = STATIC[path];
  if (!file) return false;
  if (!dir) throw new ApiError(500, 'The web app is not built (npm run build).');
  res.writeHead(200, { 'content-type': TYPES[file.split('.').pop()!]!, ...SECURITY_HEADERS });
  res.end(await readFile(dir + file));
  return true;
}

export interface RemoteServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * The remote app's HTTP API. Listens on 127.0.0.1 only; requests must name this host (DNS rebinding), writes must come
 * from this origin with the app's header (CSRF), and everything under /api but pairing needs a paired device's token
 * ("Authorization: Bearer <id>.<secret>"). The token lives in the page's localStorage, not a cookie: browsers send
 * cookies to every port of 127.0.0.1, so any other local server the browser visits would receive it.
 */
export async function startServer(hub: Hub, devices: Devices, opts: { port: number; host?: string }): Promise<RemoteServer> {
  const dir = webDir();
  const streams = new Set<ServerResponse>();
  let port = opts.port;

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof ApiError ? e.status : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ApiError(421, 'Unknown host');
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;

    if (req.method === 'GET' && (await serveStatic(dir, path, res))) return;
    if (!path.startsWith('/api/')) throw new ApiError(404, 'Not found');

    if (req.method === 'POST') {
      // A cross-site form or fetch cannot set this header without a CORS preflight, which this server never allows.
      if (req.headers['x-tessera'] !== '1') throw new ApiError(403, 'Missing X-Tessera header');
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) throw new ApiError(403, 'Cross-origin request');
    }

    if (req.method === 'POST' && path === '/api/pair') {
      const body = await json(req);
      const device = await devices.pair(String(body.code ?? ''), String(body.name ?? 'browser').slice(0, 80));
      if (!device) throw new ApiError(401, 'The pairing link is invalid or expired. Press p where `tessera-code serve` runs for a new one.');
      return send(res, { token: device });
    }

    const device = await devices.verify(bearer(req));
    if (!device) throw new ApiError(401, 'Not paired');

    const session = eventsRoute(hub, req.method ?? '', path);
    if (session) {
      if (streams.size >= MAX_STREAMS) throw new ApiError(429, 'Too many open streams; close some tabs.');
      const last = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? undefined;
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY_HEADERS });
      streams.add(res);
      const stop = streamEvents(session, last === undefined || last === '' ? undefined : Number(last), (e: Sequenced) =>
        res.write(`${e.seq ? `id: ${e.seq}\n` : ''}data: ${JSON.stringify(e.event)}\n\n`),
      );
      const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      req.on('close', () => {
        clearInterval(beat);
        stop();
        streams.delete(res);
      });
      return;
    }
    send(res, await callApi(hub, devices, { method: req.method ?? '', path: req.url ?? '/', body: req.method === 'POST' ? await json(req) : {}, device }));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise((resolve) => {
        for (const s of streams) s.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function send(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, 'Expected a JSON object');
}

function bearer(req: IncomingMessage): string | undefined {
  return /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
}
