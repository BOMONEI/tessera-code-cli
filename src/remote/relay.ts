import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ApiError } from './api.js';
import { serveStatic, webDir } from './server.js';

/**
 * `tessera-code relay`: runs on a server both the computer and the phone can reach (a personal VPS, behind a TLS proxy
 * such as Caddy). It pairs a daemon's outbound stream with browser connections and forwards their messages, which are
 * end-to-end encrypted (e2e.ts): it can neither read nor forge them, and it keeps nothing.
 *
 * Daemon (needs the relay token):
 *   GET  /relay/d/:daemon/stream   SSE of {conn, type: open|msg|close, data?}
 *   POST /relay/d/:daemon/send     {conn, data} → that browser; {conn, close: true} ends it
 * Browser:
 *   GET  /relay/c/:daemon/stream?conn=…   SSE of the daemon's messages for this connection
 *   POST /relay/c/:daemon/send            {conn, data} → the daemon
 * It also serves the web app (/), which the phone opens.
 */

const MAX_BODY = 2_000_000;
const MAX_DAEMONS = 16;
const MAX_CONNECTIONS = 32; // per daemon
const HEARTBEAT_MS = 25_000;
/** A browser connection the daemon has not answered by then (no handshake) is closed: idle ones cannot fill the slots. */
const ANSWER_MS = 15_000;
/** What a browser may send before the daemon answered: a handshake is well under 1 KB. */
const MAX_BEFORE_ANSWER = 8_000;
/** A reader this far behind (a stalled stream) is disconnected instead of buffering more. */
const MAX_BUFFERED = 8_000_000;
const ID = /^[\w-]{16,64}$/;

const HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

interface Connection {
  res: ServerResponse;
  /** The daemon has sent something on it (the handshake reply). */
  answered: boolean;
  /** Bytes sent to the daemon before that. */
  early: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Daemon {
  stream: ServerResponse;
  connections: Map<string, Connection>;
}

export interface RelayServer {
  port: number;
  close(): Promise<void>;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export async function startRelay(opts: { port: number; host?: string; token: string; log?: (line: string) => void }): Promise<RelayServer> {
  if (opts.token.length < 32) throw new Error('The relay token must be at least 32 characters (e.g. `openssl rand -base64 32`).');
  const tokenDigest = digest(opts.token);
  const daemons = new Map<string, Daemon>();
  const dir = webDir();
  const log = opts.log ?? (() => {});

  const sse = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no', ...HEADERS });
    res.write(': open\n\n'); // send the headers through proxies that wait for a body
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => clearInterval(beat));
  };
  /** Writes an event to a stream; one whose reader stopped reading is ended rather than buffered without limit. */
  const write = (res: ServerResponse, data: string) => {
    if (!res.write(`data: ${data}\n\n`) && res.writableLength > MAX_BUFFERED) res.destroy();
  };
  const toDaemon = (d: Daemon, message: object) => write(d.stream, JSON.stringify(message));

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof ApiError ? e.status : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', ...HEADERS });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (req.method === 'GET' && (await serveStatic(dir, url.pathname, res))) return;
    const m = /^\/relay\/([dc])\/([\w-]+)\/(stream|send)$/.exec(url.pathname);
    if (!m) throw new ApiError(404, 'Not found');
    const [, side, daemonId, action] = m as unknown as [string, 'd' | 'c', string, 'stream' | 'send'];
    if (!ID.test(daemonId)) throw new ApiError(400, 'Bad daemon id');

    if (side === 'd') {
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!timingSafeEqual(digest(auth), tokenDigest)) throw new ApiError(401, 'Wrong relay token');
      if (action === 'stream' && req.method === 'GET') {
        const old = daemons.get(daemonId);
        if (!old && daemons.size >= MAX_DAEMONS) throw new ApiError(429, 'Too many daemons');
        // A reconnecting daemon starts over: its browsers reconnect and shake hands again.
        if (old) closeDaemon(daemonId, old);
        sse(res);
        const d: Daemon = { stream: res, connections: new Map() };
        daemons.set(daemonId, d);
        log(`daemon ${daemonId.slice(0, 8)} connected`);
        res.on('close', () => {
          if (daemons.get(daemonId) === d) closeDaemon(daemonId, d);
        });
        return;
      }
      if (action === 'send' && req.method === 'POST') {
        const d = daemons.get(daemonId);
        if (!d) throw new ApiError(409, 'Daemon stream not open');
        const body = await json(req);
        const conn = d.connections.get(String(body.conn));
        if (!conn) throw new ApiError(404, 'No such connection');
        if (body.close === true) conn.res.end();
        else if (typeof body.data === 'string' && !/[\r\n]/.test(body.data)) {
          conn.answered = true;
          clearTimeout(conn.timer);
          write(conn.res, body.data);
        } else throw new ApiError(400, 'data (one line) is required');
        return ok(res);
      }
      throw new ApiError(405, 'Method not allowed');
    }

    const d = daemons.get(daemonId);
    if (!d) throw new ApiError(503, 'The computer is not connected to the relay (is `tessera-code serve` running?).');
    if (action === 'stream' && req.method === 'GET') {
      const conn = url.searchParams.get('conn') ?? '';
      if (!ID.test(conn)) throw new ApiError(400, 'Bad connection id');
      if (d.connections.has(conn)) throw new ApiError(409, 'Connection id in use');
      if (d.connections.size >= MAX_CONNECTIONS) throw new ApiError(429, 'Too many connections');
      sse(res);
      const c: Connection = { res, answered: false, early: 0, timer: setTimeout(() => c.answered || res.end(), ANSWER_MS) };
      d.connections.set(conn, c);
      toDaemon(d, { conn, type: 'open' });
      res.on('close', () => {
        clearTimeout(c.timer);
        if (d.connections.get(conn) !== c) return;
        d.connections.delete(conn);
        if (daemons.get(daemonId) === d) toDaemon(d, { conn, type: 'close' });
      });
      return;
    }
    if (action === 'send' && req.method === 'POST') {
      const body = await json(req);
      const conn = String(body.conn);
      const c = d.connections.get(conn);
      if (!c) throw new ApiError(404, 'No such connection');
      if (typeof body.data !== 'string') throw new ApiError(400, 'data is required');
      if (!c.answered && (c.early += body.data.length) > MAX_BEFORE_ANSWER) {
        c.res.end();
        throw new ApiError(413, 'Too much data before the handshake');
      }
      toDaemon(d, { conn, type: 'msg', data: body.data });
      return ok(res);
    }
    throw new ApiError(405, 'Method not allowed');
  }

  function closeDaemon(id: string, d: Daemon): void {
    daemons.delete(id);
    for (const c of d.connections.values()) c.res.end();
    d.connections.clear();
    d.stream.end();
    log(`daemon ${id.slice(0, 8)} disconnected`);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const [id, d] of daemons) closeDaemon(id, d);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function ok(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json', ...HEADERS });
  res.end('{}');
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, 'Message too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, 'Expected a JSON object');
}
