/**
 * How the web app reaches `tessera-code serve`: directly on this computer (127.0.0.1, bearer token), or through the
 * relay with end-to-end encryption (keys in IndexedDB, see e2e.ts). Both expose the same API.
 */
import { deviceHello, generateKeyPair, toB64, type Channel, type Welcome } from '../e2e.js';
import type { RemoteEvent } from '../protocol.js';

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Why an event stream ended for good: the session is gone, or this device is not (or no longer) paired. */
export type StreamEnd = 'gone' | 'unpaired';

export interface Transport {
  readonly kind: 'local' | 'relay';
  request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
  /** Follows a session's events, reconnecting after drops (resuming after the last one seen), until `signal` aborts. */
  events(session: string, onEvent: (seq: number, ev: RemoteEvent) => void, signal: AbortSignal): Promise<StreamEnd | void>;
  /** Shown while the connection is being restored; cleared by the next state event. */
  onReconnecting?: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits a text stream into Server-Sent Events blocks: yields {id, data} per message (heartbeats skipped). */
async function* sse(body: ReadableStream<BufferSource>): AsyncGenerator<{ id?: string; data: string }> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data !== undefined) yield { id: /^id: (\d+)$/m.exec(block)?.[1], data };
    }
  }
}

// --- On this computer -------------------------------------------------------------------------------------------------

const TOKEN_KEY = 'tessera.token';

export class LocalTransport implements Transport {
  readonly kind = 'local';
  onReconnecting?: () => void;
  private token: string | undefined;

  constructor() {
    try {
      this.token = localStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      // storage blocked: the token lasts until the page is closed
    }
  }

  // The device token lives in localStorage, which (unlike cookies) servers on this computer's other ports cannot read.
  private auth(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  async pair(code: string, name: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/api/pair', { code, name });
    this.token = r.token;
    try {
      localStorage.setItem(TOKEN_KEY, r.token);
    } catch {
      // kept for this page only
    }
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(
      path,
      method === 'GET' ? { headers: this.auth() } : { method, headers: { 'content-type': 'application/json', 'x-tessera': '1', ...this.auth() }, body: JSON.stringify(body ?? {}) },
    );
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new TransportError(data.error ?? res.statusText, res.status);
    return data;
  }

  async events(session: string, onEvent: (seq: number, ev: RemoteEvent) => void, signal: AbortSignal): Promise<StreamEnd | void> {
    let last: string | undefined;
    while (!signal.aborted) {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/events`, { headers: { ...this.auth(), ...(last ? { 'last-event-id': last } : {}) }, signal });
        if (res.status === 401) return 'unpaired';
        if (res.status === 404) return 'gone';
        if (!res.ok || !res.body) throw new Error(res.statusText);
        for await (const m of sse(res.body)) {
          if (m.id) last = m.id;
          onEvent(Number(m.id) || 0, JSON.parse(m.data) as RemoteEvent);
        }
      } catch {
        if (signal.aborted) return;
      }
      this.onReconnecting?.();
      await sleep(2000);
    }
  }
}

// --- Through the relay ----------------------------------------------------------------------------------------------

interface Pairing {
  daemonId: string;
  daemonPub: string;
  keys: CryptoKeyPair;
}

/** IndexedDB holds the device's key pair as unextractable CryptoKeys: scripts can use it, nothing can read it out. */
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('tessera-remote', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pairing');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = run(d.transaction('pairing', mode).objectStore('pairing'));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

export async function storedPairing(): Promise<Pairing | undefined> {
  try {
    return (await idb<Pairing | undefined>('readonly', (s) => s.get('relay'))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Deletes this browser's key: only when the user asks (a refusal arrives unauthenticated and could be forged). */
export async function forgetPairing(): Promise<void> {
  await idb('readwrite', (s) => s.delete('relay')).catch(() => {});
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface Subscription {
  session: string;
  last?: number;
  onEvent: (seq: number, ev: RemoteEvent) => void;
  done: (end: StreamEnd | void) => void;
}

/**
 * One end-to-end encrypted connection through the relay, re-established (new handshake) whenever it drops; event
 * streams then resume after the last event they saw.
 */
export class RelayTransport implements Transport {
  readonly kind = 'relay';
  onReconnecting?: () => void;
  private channel?: Promise<Channel>;
  /** The established channel; event streams opened from now on subscribe themselves. */
  private ready?: Channel;
  private conn = '';
  /** Ends the current connection's stream (then `read` reconnects). */
  private stream?: AbortController;
  private outbox: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private subs = new Map<string, Subscription>();
  private nextId = 0;
  /** Set when the daemon refused this device: no point reconnecting. */
  private refused?: string;

  private constructor(
    private pairing: Pairing,
    private firstConnect?: { secret: string; name: string },
  ) {}

  /** From a QR code link (#d=…&k=…&p=…): a new key pair, paired on the first connection. */
  static async pair(daemonId: string, daemonPub: string, secret: string, name: string): Promise<RelayTransport> {
    const pairing = { daemonId, daemonPub, keys: await generateKeyPair(false) };
    const t = new RelayTransport(pairing, { secret, name });
    await t.connect(); // pairs; throws if the code was wrong or expired
    await idb('readwrite', (s) => s.put(pairing, 'relay'));
    return t;
  }

  static fromStored(pairing: Pairing): RelayTransport {
    return new RelayTransport(pairing);
  }

  /** Error text when the daemon refused this device (then the app shows the pairing instructions). */
  get refusal(): string | undefined {
    return this.refused;
  }

  private connect(): Promise<Channel> {
    if (this.refused) return Promise.reject(new TransportError(this.refused, 401));
    this.channel ??= this.open().catch((e: unknown) => {
      this.channel = undefined;
      throw e;
    });
    return this.channel;
  }

  private async open(): Promise<Channel> {
    const { daemonId, daemonPub, keys } = this.pairing;
    const conn = toB64(crypto.getRandomValues(new Uint8Array(18)));
    const ac = new AbortController();
    const res = await fetch(`/relay/c/${daemonId}/stream?conn=${conn}`, { signal: ac.signal });
    if (!res.ok || !res.body) {
      const error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
      throw new TransportError(error, res.status);
    }
    this.conn = conn;
    this.stream = ac;
    this.outbox = Promise.resolve();
    const messages = sse(res.body);
    const { hello, finish } = await deviceHello(keys, daemonPub, this.firstConnect ? { pairingSecret: this.firstConnect.secret, name: this.firstConnect.name } : {});
    await this.post(JSON.stringify(hello));
    const first = await messages.next();
    if (first.done) throw new TransportError('The connection closed during the handshake', 502);
    const reply = JSON.parse(first.value.data) as Welcome | { type: 'error'; error: string };
    if (reply.type === 'error') {
      // Not authenticated (no keys yet): shown as the daemon's answer, but the key is kept unless the user forgets it.
      ac.abort();
      this.refused = String(reply.error).slice(0, 300);
      throw new TransportError(this.refused, 401);
    }
    const channel = await finish(reply);
    this.firstConnect = undefined;
    void this.read(messages, channel, conn);
    // Streams opened while connecting, or open before a reconnect, (re)subscribe here, resuming where they left off.
    this.ready = channel;
    for (const [id, sub] of this.subs) void this.subscribe(channel, id, sub);
    return channel;
  }

  private async read(messages: AsyncGenerator<{ data: string }>, channel: Channel, conn: string): Promise<void> {
    try {
      for await (const m of messages) {
        const msg = await channel.open<{ id: string; status?: number; body?: unknown; error?: string; seq?: number; event?: RemoteEvent }>(m.data);
        const sub = this.subs.get(msg.id);
        if (sub && msg.event) {
          if (msg.seq) sub.last = msg.seq;
          sub.onEvent(msg.seq ?? 0, msg.event);
          continue;
        }
        if (sub && msg.status !== undefined) {
          // The stream request failed (the session is gone).
          this.subs.delete(msg.id);
          sub.done(msg.status === 404 ? 'gone' : undefined);
          continue;
        }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.status === 200) p.resolve(msg.body);
        else p.reject(new TransportError(msg.error ?? 'Request failed', msg.status ?? 500));
      }
    } catch {
      // tampered or broken stream: start over
    }
    if (this.conn !== conn) return;
    this.channel = undefined;
    this.ready = undefined;
    for (const p of this.pending.values()) p.reject(new TransportError('Connection lost; try again.', 503));
    this.pending.clear();
    if (this.subs.size) {
      this.onReconnecting?.();
      void this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    for (let delay = 1000; this.subs.size && !this.channel && !this.refused; delay = Math.min(delay * 2, 30_000)) {
      try {
        await this.connect();
        return;
      } catch (e) {
        if ((e as TransportError).status === 401) {
          for (const sub of this.subs.values()) sub.done('unpaired');
          this.subs.clear();
          return;
        }
      }
      await sleep(delay);
    }
  }

  private subscribe(channel: Channel, id: string, sub: Subscription): Promise<unknown> {
    return this.sendSealed(channel, { id, method: 'GET', path: `/api/sessions/${encodeURIComponent(sub.session)}/events`, after: sub.last });
  }

  private post(data: string): Promise<unknown> {
    const conn = this.conn;
    this.outbox = this.outbox.catch(() => {}).then(async () => {
      const res = await fetch(`/relay/c/${this.pairing.daemonId}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn, data }) });
      if (!res.ok) throw new TransportError('Relay rejected the message', res.status);
    });
    return this.outbox;
  }

  /**
   * Seals and sends in one queue step, so messages leave in counter order. A message that did not arrive used up its
   * counter, and the daemon accepts only the next one: the connection is ended and made again.
   */
  private sendSealed(channel: Channel, message: object): Promise<unknown> {
    const conn = this.conn;
    const stream = this.stream;
    this.outbox = this.outbox
      .catch(() => {})
      .then(async () => {
        const data = await channel.seal(message);
        const res = await fetch(`/relay/c/${this.pairing.daemonId}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn, data }) });
        if (!res.ok) throw new TransportError('Relay rejected the message', res.status);
      })
      .catch((e: unknown) => {
        stream?.abort();
        throw e;
      });
    return this.outbox;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const channel = await this.connect();
    const id = `r${++this.nextId}`;
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    await this.sendSealed(channel, { id, method, path, body: body ?? {} }).catch((e: unknown) => {
      this.pending.get(id)?.reject(e as Error);
      this.pending.delete(id);
    });
    return result;
  }

  events(session: string, onEvent: (seq: number, ev: RemoteEvent) => void, signal: AbortSignal): Promise<StreamEnd | void> {
    const id = `s${++this.nextId}`;
    return new Promise((resolve) => {
      const done = (end: StreamEnd | void) => {
        this.subs.delete(id);
        resolve(end);
      };
      const sub: Subscription = { session, onEvent, done };
      this.subs.set(id, sub);
      signal.addEventListener(
        'abort',
        () => {
          if (this.channel) void this.channel.then((c) => this.sendSealed(c, { id, cancel: true })).catch(() => {});
          done();
        },
        { once: true },
      );
      if (this.ready) {
        void this.subscribe(this.ready, id, sub);
        return;
      }
      // Connecting subscribes every open stream (see open).
      this.connect().catch(
        (e: unknown) => {
          if ((e as TransportError).status === 401) done('unpaired');
          else {
            this.onReconnecting?.();
            void this.reconnect();
          }
        },
      );
    });
  }
}
