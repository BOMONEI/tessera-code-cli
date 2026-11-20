import { ApiError, callApi, eventsRoute, streamEvents, type Hub } from './api.js';
import { printable, type Devices } from './devices.js';
import { daemonWelcome, type Channel, type Hello } from './e2e.js';

/**
 * The daemon's side of the relay (relay.ts): one outbound event stream from the relay, a handshake per browser
 * connection (e2e.ts), then the same API as on 127.0.0.1, end-to-end encrypted.
 *
 * Inside the channel, browser → daemon: {id, method, path, body?, after?} and {id, cancel: true} (stops an event
 * stream); daemon → browser: {id, status, body | error} for a request, {id, seq, event} for each streamed event.
 */

export interface LinkOptions {
  relay: string;
  token: string;
  daemonKey: CryptoKeyPair;
  daemonPub: string;
  daemonId: string;
  hub: Hub;
  devices: Devices;
  log: (line: string) => void;
}

/** Browser connections at once; a connection that has not shaken hands by then is closed. */
const MAX_CONNECTIONS = 32;
const HANDSHAKE_MS = 10_000;
/** Messages waiting to go out on one connection (a stalled relay or browser): beyond this it is closed. */
const MAX_QUEUED = 1000;

interface Connection {
  channel?: Channel;
  device?: string;
  timer: ReturnType<typeof setTimeout>;
  queued: number;
  /** Messages go out one at a time, in order (the browser rejects a reordered counter). */
  outbox: Promise<unknown>;
  streams: Map<string, () => void>;
  /** Incoming messages are handled one at a time, in order (decryption checks the counter). */
  inbox: Promise<unknown>;
}

interface Request {
  id?: string;
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  after?: number;
  cancel?: boolean;
}

export interface Link {
  close(): void;
}

export function startLink(opts: LinkOptions): Link {
  const base = opts.relay.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${opts.token}` };
  const connections = new Map<string, Connection>();
  let stopped = false;
  let current: AbortController | undefined;

  const post = async (body: object) => {
    const res = await fetch(`${base}/relay/d/${opts.daemonId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`relay: ${res.status}`);
  };

  /**
   * Queues `make()` (the plaintext or sealed data) after the connection's earlier messages. A message that cannot be
   * delivered ends the connection: the browser would otherwise wait for it, and its counter is used up.
   */
  const send = (connId: string, c: Connection, make: () => Promise<string>) => {
    if (++c.queued > MAX_QUEUED) return close(connId);
    c.outbox = c.outbox
      .then(async () => {
        if (connections.get(connId) !== c) return;
        await post({ conn: connId, data: await make() });
        c.queued--;
      })
      .catch(() => close(connId));
  };
  const reply = (connId: string, c: Connection, message: object) => send(connId, c, () => c.channel!.seal(message));

  function drop(connId: string): void {
    const c = connections.get(connId);
    if (!c) return;
    clearTimeout(c.timer);
    for (const stop of c.streams.values()) stop();
    connections.delete(connId);
  }

  /** Drops the connection and asks the relay to end it for the browser too. */
  function close(connId: string): void {
    drop(connId);
    void post({ conn: connId, close: true }).catch(() => {});
  }

  // An unpaired device loses its open connections at once, not only its next one.
  opts.devices.onRevoke = (id) => {
    for (const [connId, c] of connections) if (c.device === id) close(connId);
  };

  async function onMessage(connId: string, c: Connection, data: string): Promise<void> {
    if (!c.channel) {
      // The first message is the plaintext hello; anything unexpected ends the connection.
      let hello: Hello;
      try {
        hello = JSON.parse(data) as Hello;
      } catch {
        return refuse(connId, 'Bad handshake');
      }
      if (hello.type !== 'hello' || typeof hello.device !== 'string') return refuse(connId, 'Bad handshake');
      const name = typeof hello.name === 'string' ? hello.name : 'phone';
      const device = await opts.devices.verifyKey(hello.device, opts.daemonPub, hello.proof, name).catch(() => undefined);
      if (!device) return refuse(connId, hello.proof ? 'The pairing code is invalid or expired: press p where `tessera-code serve` runs for a new QR code.' : 'This device is not paired (or was unpaired).');
      const { welcome, channel } = await daemonWelcome(opts.daemonKey, hello);
      c.channel = channel;
      c.device = device;
      clearTimeout(c.timer);
      send(connId, c, async () => JSON.stringify(welcome));
      if (hello.proof) opts.log(`Paired a device through the relay: ${printable(name)}`);
      return;
    }
    let req: Request;
    try {
      req = await c.channel.open<Request>(data);
    } catch {
      // Tampered, replayed, reordered or missing: the channel can no longer be trusted.
      return close(connId);
    }
    if (!opts.devices.has(c.device!)) return close(connId); // unpaired meanwhile
    const id = String(req.id ?? '');
    if (req.cancel) {
      c.streams.get(id)?.();
      c.streams.delete(id);
      return;
    }
    try {
      const method = String(req.method ?? 'GET');
      const path = String(req.path ?? '/');
      const session = eventsRoute(opts.hub, method, path);
      if (session) {
        c.streams.get(id)?.();
        c.streams.set(id, streamEvents(session, typeof req.after === 'number' ? req.after : undefined, (e) => reply(connId, c, { id, seq: e.seq, event: e.event })));
        return;
      }
      const body = await callApi(opts.hub, opts.devices, { method, path, body: req.body && typeof req.body === 'object' ? req.body : {}, device: c.device! });
      reply(connId, c, { id, status: 200, body });
    } catch (e) {
      reply(connId, c, { id, status: e instanceof ApiError ? e.status : 500, error: e instanceof Error ? e.message : String(e) });
    }
  }

  function refuse(connId: string, error: string): void {
    const c = connections.get(connId);
    if (!c) return;
    c.outbox = c.outbox
      .then(() => post({ conn: connId, data: JSON.stringify({ type: 'error', error }) }))
      .then(() => post({ conn: connId, close: true }))
      .catch(() => {});
    drop(connId);
  }

  async function run(): Promise<void> {
    let delay = 1000;
    let announced = false;
    while (!stopped) {
      const ac = new AbortController();
      current = ac;
      try {
        const res = await fetch(`${base}/relay/d/${opts.daemonId}/stream`, { headers: auth, signal: ac.signal });
        if (res.status === 401) throw new Error('the relay rejected the token ("remote.relay.token")');
        if (!res.ok || !res.body) throw new Error(`relay answered ${res.status}`);
        opts.log(`Connected to the relay ${base}`);
        announced = false;
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data === undefined) continue;
            let m: { conn: string; type: 'open' | 'msg' | 'close'; data?: string };
            try {
              m = JSON.parse(data) as typeof m;
            } catch {
              continue; // not from a working relay; skip it rather than drop every connection
            }
            if (typeof m.conn !== 'string') continue;
            if (m.type === 'open') {
              if (connections.size >= MAX_CONNECTIONS) {
                void post({ conn: m.conn, close: true }).catch(() => {});
                continue;
              }
              const connId = m.conn;
              const timer = setTimeout(() => connections.get(connId)?.channel || close(connId), HANDSHAKE_MS);
              connections.set(connId, { outbox: Promise.resolve(), inbox: Promise.resolve(), streams: new Map(), timer, queued: 0 });
            } else if (m.type === 'close') drop(m.conn);
            else {
              const c = connections.get(m.conn);
              if (c) c.inbox = c.inbox.then(() => onMessage(m.conn, c, m.data ?? '')).catch(() => drop(m.conn));
            }
          }
        }
      } catch (e) {
        if (stopped) return;
        if (!announced) opts.log(`Relay connection lost (${(e as Error).message}); retrying…`);
        announced = true;
      }
      for (const id of [...connections.keys()]) drop(id); // the relay ends them too; browsers shake hands again
      if (stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  void run();
  return {
    close: () => {
      stopped = true;
      current?.abort();
      for (const id of [...connections.keys()]) drop(id);
    },
  };
}
