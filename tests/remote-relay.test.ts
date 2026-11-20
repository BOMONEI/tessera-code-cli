import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../src/app.js';
import type { AgentEvent } from '../src/agent/agent.js';
import { SessionController } from '../src/remote/controller.js';
import { Devices } from '../src/remote/devices.js';
import { daemonWelcome, deviceHello, exportPublic, generateKeyPair, keyId, pairingProof, type Channel, type Welcome } from '../src/remote/e2e.js';
import { startLink } from '../src/remote/link.js';
import type { RemoteEvent } from '../src/remote/protocol.js';
import { startRelay } from '../src/remote/relay.js';
import type { Hub } from '../src/remote/server.js';

describe('end-to-end encryption', () => {
  async function handshake(opts: { pairingSecret?: string } = {}) {
    const daemon = await generateKeyPair(true);
    const device = await generateKeyPair(false);
    const daemonPub = await exportPublic(daemon.publicKey);
    const { hello, finish } = await deviceHello(device, daemonPub, opts);
    const { welcome, channel: daemonSide } = await daemonWelcome(daemon, hello);
    return { daemon, device, daemonPub, hello, welcome, daemonSide, deviceSide: await finish(welcome) };
  }

  it('derives matching keys on both sides, one per direction', async () => {
    const { daemonSide, deviceSide } = await handshake();
    expect(await daemonSide.open(await deviceSide.seal({ hi: 1 }))).toEqual({ hi: 1 });
    expect(await deviceSide.open(await daemonSide.seal('back'))).toBe('back');
    // A message cannot be reflected back to its sender: the other direction has its own key.
    const sealed = await deviceSide.seal('mine');
    await expect(deviceSide.open(sealed)).rejects.toThrow();
  });

  it('rejects tampered, replayed, reordered and missing messages', async () => {
    const { daemonSide, deviceSide } = await handshake();
    const a = await deviceSide.seal('a');
    const b = await deviceSide.seal('b');
    const c = await deviceSide.seal('c');
    const d = await deviceSide.seal('d');
    const flipped = a.slice(0, -4) + (a.at(-4) === 'A' ? 'B' : 'A') + a.slice(-3);
    await expect(daemonSide.open(flipped)).rejects.toThrow();
    await expect(daemonSide.open(b)).rejects.toThrow(/Missing message/); // a relay withholding "a"
    expect(await daemonSide.open(a)).toBe('a');
    await expect(daemonSide.open(a)).rejects.toThrow(/Replayed or reordered/);
    expect(await daemonSide.open(b)).toBe('b');
    await expect(daemonSide.open(d)).rejects.toThrow(/Missing message/);
    expect(await daemonSide.open(c)).toBe('c');
  });

  it('fails the handshake when the daemon key is not the one from the QR code', async () => {
    const real = await generateKeyPair(true);
    const impostor = await generateKeyPair(true);
    const device = await generateKeyPair(false);
    const { hello, finish } = await deviceHello(device, await exportPublic(real.publicKey));
    const { welcome } = await daemonWelcome(impostor, hello); // e.g. the relay answering itself
    await expect(finish(welcome)).rejects.toThrow();
  });

  it('binds the pairing proof to the secret and both keys', async () => {
    const { hello, daemonPub } = await handshake({ pairingSecret: 'code-1' });
    expect(hello.proof).toBe(await pairingProof('code-1', hello.device, daemonPub));
    expect(hello.proof).not.toBe(await pairingProof('code-2', hello.device, daemonPub));
    const other = await exportPublic((await generateKeyPair(false)).publicKey);
    expect(hello.proof).not.toBe(await pairingProof('code-1', other, daemonPub));
    // The name shown in the device list cannot be changed on the way (by the relay).
    const named = await deviceHello(await generateKeyPair(false), daemonPub, { pairingSecret: 'code-1', name: 'my phone' });
    expect(named.hello.proof).toBe(await pairingProof('code-1', named.hello.device, daemonPub, 'my phone'));
    expect(named.hello.proof).not.toBe(await pairingProof('code-1', named.hello.device, daemonPub, 'evil\x1b]0;x'));
  });
});

const TOKEN = 'relay-token-0123456789-0123456789-abcdef';

/** A minimal device client (the browser's RelayTransport, without IndexedDB) talking to the relay over fetch. */
async function connectDevice(base: string, daemonId: string, daemonPub: string, device: CryptoKeyPair, secret?: string) {
  const conn = `conn-${Math.random().toString(36).slice(2)}-xxxxxxxx`;
  const ac = new AbortController();
  const res = await fetch(`${base}/relay/c/${daemonId}/stream?conn=${conn}`, { signal: ac.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const raw: string[] = [];
  const next = async (): Promise<string> => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data !== undefined) {
          raw.push(data);
          return data;
        }
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('closed');
      buf += value;
    }
  };
  const send = async (data: string) => {
    const r = await fetch(`${base}/relay/c/${daemonId}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn, data }) });
    expect(r.status).toBe(200);
  };
  const { hello, finish } = await deviceHello(device, daemonPub, secret ? { pairingSecret: secret, name: 'test phone' } : {});
  await send(JSON.stringify(hello));
  const reply = JSON.parse(await next()) as Welcome | { type: 'error'; error: string };
  if (reply.type === 'error') {
    ac.abort();
    return { error: reply.error };
  }
  const channel: Channel = await finish(reply);
  let sends = Promise.resolve();
  return {
    raw,
    close: () => ac.abort(),
    request: (msg: object) => (sends = sends.then(async () => send(await channel.seal(msg)))),
    receive: async () => channel.open<{ id: string; status?: number; body?: unknown; error?: string; seq?: number; event?: RemoteEvent }>(await next()),
  };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('relay and link', () => {
  async function setup() {
    const relay = await startRelay({ port: 0, token: TOKEN });
    const base = `http://127.0.0.1:${relay.port}`;
    const app = {
      agent: { sessionId: 's1', model: { id: 'mock', reasoning: false }, thinking: false, messages: [], interject() {}, takeInterjections: () => [] },
      ctx: { cwd: '/work' },
      permissions: { mode: 'default' },
      run: async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', text: 'secret answer text' };
        yield { type: 'turn-finish', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cost: 0 }, finishReason: 'stop', elapsedMs: 1 };
      },
      close: async () => {},
    } as unknown as App;
    const session = new SessionController(app);
    const hub: Hub = {
      list: () => ({ open: [session.state()], roots: ['/work'] }),
      get: (id) => (id === session.id ? session : undefined),
      open: async () => session.state(),
      close: async () => {},
      stored: async () => [],
    };
    const devices = await Devices.load(join(mkdtempSync(join(tmpdir(), 'tessera-relay-')), 'remote.json'));
    const daemonKey = await devices.daemonKey();
    const daemonPub = await exportPublic(daemonKey.publicKey);
    const daemonId = await keyId(daemonPub);
    const logs: string[] = [];
    const link = startLink({ relay: base, token: TOKEN, daemonKey, daemonPub, daemonId, hub, devices, log: (l) => logs.push(l) });
    await until(() => logs.some((l) => l.startsWith('Connected')));
    return {
      base,
      daemonId,
      daemonPub,
      devices,
      session,
      logs,
      done: async () => {
        link.close();
        await relay.close();
      },
    };
  }

  it('pairs a phone with the QR secret, then serves the API end-to-end encrypted', async () => {
    const t = await setup();
    try {
      const phone = await generateKeyPair(false);
      const secret = t.devices.newPairingCode();
      const d = await connectDevice(t.base, t.daemonId, t.daemonPub, phone, secret);
      if ('error' in d) throw new Error(d.error);
      expect(t.devices.all.map((x) => x.name)).toEqual(['test phone']);

      await d.request({ id: 'r1', method: 'GET', path: '/api/sessions' });
      const list = await d.receive();
      expect(list).toMatchObject({ id: 'r1', status: 200, body: { roots: ['/work'] } });

      await d.request({ id: 's1', method: 'GET', path: `/api/sessions/${t.session.id}/events` });
      expect(await d.receive()).toMatchObject({ id: 's1', seq: 0, event: { kind: 'state' } });
      await d.request({ id: 'r2', method: 'POST', path: `/api/sessions/${t.session.id}/send`, body: { text: 'my private prompt' } });
      const kinds: string[] = [];
      while (!kinds.includes('turn-finish')) {
        const m = await d.receive();
        if (m.event) kinds.push(m.event.kind);
      }
      expect(kinds.filter((k) => k !== 'state')).toEqual(['user', 'text', 'turn-finish']);
      // What passed through the relay is ciphertext only.
      expect(d.raw.join('\n')).not.toMatch(/secret answer text|my private prompt|"kind"/);
      d.close();

      // Next time the key alone is enough, without the (used up) secret.
      const again = await connectDevice(t.base, t.daemonId, t.daemonPub, phone);
      if ('error' in again) throw new Error(again.error);
      await again.request({ id: 'x', method: 'POST', path: '/api/sessions/nope/send', body: { text: 'x' } });
      expect(await again.receive()).toMatchObject({ id: 'x', status: 404 });
      again.close();
    } finally {
      await t.done();
    }
  });

  it('refuses unknown devices, wrong or reused pairing secrets', async () => {
    const t = await setup();
    try {
      const stranger = await connectDevice(t.base, t.daemonId, t.daemonPub, await generateKeyPair(false));
      expect(stranger).toEqual({ error: expect.stringMatching(/not paired/) });
      const secret = t.devices.newPairingCode();
      expect(await connectDevice(t.base, t.daemonId, t.daemonPub, await generateKeyPair(false), 'wrong-secret')).toEqual({ error: expect.stringMatching(/invalid or expired/) });
      const first = await connectDevice(t.base, t.daemonId, t.daemonPub, await generateKeyPair(false), secret);
      expect('error' in first).toBe(false);
      if (!('error' in first)) first.close();
      expect(await connectDevice(t.base, t.daemonId, t.daemonPub, await generateKeyPair(false), secret)).toEqual({ error: expect.stringMatching(/invalid or expired/) });
      expect(t.devices.all).toHaveLength(1);
    } finally {
      await t.done();
    }
  });

  it('ends a device\'s open connection as soon as it is unpaired', async () => {
    const t = await setup();
    try {
      const phone = await generateKeyPair(false);
      const d = await connectDevice(t.base, t.daemonId, t.daemonPub, phone, t.devices.newPairingCode());
      if ('error' in d) throw new Error(d.error);
      await t.devices.revoke(t.devices.all[0]!.id);
      await expect(d.receive()).rejects.toThrow(/closed/);
      expect(await connectDevice(t.base, t.daemonId, t.daemonPub, phone)).toEqual({ error: expect.stringMatching(/not paired/) });
    } finally {
      await t.done();
    }
  });

  it('limits what a browser may send before the computer answered, and rejects multi-line data', async () => {
    const t = await setup();
    try {
      const open = async (conn: string) => {
        const ac = new AbortController();
        expect((await fetch(`${t.base}/relay/c/${t.daemonId}/stream?conn=${conn}`, { signal: ac.signal })).status).toBe(200);
        return ac;
      };
      const flood = await open('flood-connection-xxxxxx');
      const big = await fetch(`${t.base}/relay/c/${t.daemonId}/send`, { method: 'POST', body: JSON.stringify({ conn: 'flood-connection-xxxxxx', data: 'x'.repeat(10_000) }) });
      expect(big.status).toBe(413);
      flood.abort();
      const other = await open('other-connection-xxxxxx');
      const injected = await fetch(`${t.base}/relay/d/${t.daemonId}/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ conn: 'other-connection-xxxxxx', data: 'a\n\ndata: forged' }),
      });
      expect(injected.status).toBe(400);
      other.abort();
    } finally {
      await t.done();
    }
  });

  it('lets only token holders register a daemon, and says when the computer is not connected', async () => {
    const t = await setup();
    try {
      expect((await fetch(`${t.base}/relay/d/${t.daemonId}/stream`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      expect((await fetch(`${t.base}/relay/d/${t.daemonId}/stream`)).status).toBe(401);
      const absent = await fetch(`${t.base}/relay/c/aaaaaaaaaaaaaaaaaaaaaa/stream?conn=cccccccccccccccccc`);
      expect(absent.status).toBe(503);
      expect((await fetch(`${t.base}/relay/c/${t.daemonId}/stream?conn=bad`)).status).toBe(400);
    } finally {
      await t.done();
    }
  });

  it('requires a long relay token', async () => {
    await expect(startRelay({ port: 0, token: 'short' })).rejects.toThrow(/at least 32/);
  });
});
