import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import type { App } from '../src/app.js';
import type { AgentEvent } from '../src/agent/agent.js';
import { SessionController } from '../src/remote/controller.js';
import { Devices } from '../src/remote/devices.js';
import { startServer, type Hub } from '../src/remote/server.js';
import { Daemon } from '../src/remote/daemon.js';
import type { RemoteEvent } from '../src/remote/protocol.js';

type Script = (signal: AbortSignal, app: FakeApp) => AsyncGenerator<AgentEvent>;
interface FakeApp {
  interjected: string[];
  turns: string[];
  script: Script;
  app: App;
}

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cost: 0 };
const finish = (extra: object = {}): AgentEvent => ({ type: 'turn-finish', usage, finishReason: 'stop', elapsedMs: 10, ...extra });

function fakeApp(script: Script): FakeApp {
  const f: FakeApp = { interjected: [], turns: [], script, app: undefined as unknown as App };
  f.app = {
    agent: {
      sessionId: 'sess-1',
      model: { id: 'mock', reasoning: false },
      thinking: false,
      messages: [],
      interject: (t: string) => void f.interjected.push(t),
      takeInterjections: () => f.interjected.splice(0),
    },
    ctx: { cwd: '/work' },
    permissions: { mode: 'default' },
    title: undefined,
    run: (prompt: string, signal: AbortSignal) => {
      f.turns.push(prompt);
      return f.script(signal, f);
    },
    shell: async (command: string) => ({ output: `ran ${command}`, code: 0 }),
    summaries: () => [],
    close: async () => {},
  } as unknown as App;
  return f;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const kinds = (c: SessionController) => c.events().events.map((e) => e.event.kind);
const waitIdle = (c: SessionController) => until(() => c.state().busy === undefined);
const abortable = (signal: AbortSignal) => new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));

describe('SessionController', () => {
  it('records a turn: the prompt, merged text, the tool with its diff after the result, and the summary', async () => {
    let c!: SessionController;
    const f = fakeApp(async function* () {
      yield { type: 'text', text: 'Hel' };
      yield { type: 'text', text: 'lo' };
      yield { type: 'tool-call', id: 't1', name: 'edit', input: { path: 'a.ts' } };
      c.onDiff('a.ts', '@@ -1 +1 @@\n-a\n+b');
      yield { type: 'tool-result', id: 't1', name: 'edit', output: 'Edited a.ts', isError: false };
      yield finish();
    });
    c = new SessionController(f.app);
    c.send('hi');
    await until(() => kinds(c).includes('turn-finish'));
    await waitIdle(c);
    const events = c.events().events.map((e) => e.event);
    expect(events.map((e) => e.kind)).toEqual(['user', 'text', 'tool', 'tool-result', 'diff', 'turn-finish']);
    expect(events[1]).toEqual({ kind: 'text', text: 'Hello' });
    expect(events[3]).toMatchObject({ label: 'edit(a.ts)', output: 'Edited a.ts' });
  });

  it('removes a turn cancelled before any answer and hands the message back', async () => {
    const f = fakeApp(async function* (signal) {
      await abortable(signal);
      yield finish({ finishReason: 'interrupted', discarded: true });
    });
    const c = new SessionController(f.app);
    const seen: RemoteEvent[] = [];
    c.subscribe((e) => e.seq && seen.push(e.event));
    c.send('never mind');
    await until(() => c.state().busy === 'Thinking');
    c.interrupt();
    await waitIdle(c);
    expect(c.events().events).toEqual([expect.objectContaining({ event: expect.objectContaining({ kind: 'discard', text: 'never mind' }) })]);
    expect(seen.at(-1)).toMatchObject({ kind: 'discard', from: 1 });
  });

  it('keeps an interrupted turn that had answered', async () => {
    const f = fakeApp(async function* (signal) {
      yield { type: 'text', text: 'partial' };
      await abortable(signal);
      yield finish({ finishReason: 'interrupted' });
    });
    const c = new SessionController(f.app);
    c.send('go');
    await until(() => kinds(c).includes('text'));
    c.interrupt();
    await waitIdle(c);
    expect(kinds(c)).toEqual(['user', 'text', 'turn-finish', 'info']);
  });

  it('asks permission through the clients; the first answer wins and a sensitive request is never remembered', async () => {
    const f = fakeApp(async function* () {
      yield finish();
    });
    const c = new SessionController(f.app);
    const answer = c.ask({ tool: 'edit', rule: 'edit', title: 'Edit ../x', sensitive: true });
    const ev = c.events().events.at(-1)!.event as Extract<RemoteEvent, { kind: 'permission' }>;
    expect(ev).toMatchObject({ kind: 'permission', title: 'Edit ../x', rememberable: false });
    expect(c.answer(ev.id, 'allow-always')).toBe(true);
    expect(c.answer(ev.id, 'deny')).toBe(false);
    expect(await answer).toBe('allow-once');
    expect(c.events().events.at(-1)!.event).toEqual({ kind: 'permission-done', id: ev.id, decision: 'allow-once' });
  });

  it('denies a pending permission when the turn is interrupted', async () => {
    const f = fakeApp(async function* () {
      yield finish();
    });
    const c = new SessionController(f.app);
    const ac = new AbortController();
    const answer = c.ask({ tool: 'bash', rule: 'bash(rm x)', title: 'rm x', signal: ac.signal });
    ac.abort();
    expect(await answer).toBe('deny');
  });

  it('steers a running turn with plain messages and queues commands until it ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeApp(async function* () {
      await gate;
      yield finish();
    });
    const c = new SessionController(f.app);
    c.send('first');
    await until(() => c.state().busy === 'Thinking');
    c.send('also this');
    c.send('!ls');
    expect(f.interjected).toEqual(['also this']);
    expect(c.state().queued).toEqual(['↳ also this', '!ls']);
    release();
    // "also this" was never read by the (fake) agent: it runs as the next turn, after "!ls".
    await until(() => kinds(c).filter((k) => k === 'turn-finish').length === 2);
    await waitIdle(c);
    expect(c.events().events.filter((e) => e.event.kind === 'user').map((e) => (e.event as { text: string }).text)).toEqual(['first', '!ls', 'also this']);
    expect(c.events().events.find((e) => e.event.kind === 'tool-result')!.event).toMatchObject({ label: '$ ls', output: 'ran ls' });
  });

  it('refuses commands that only the computer may run', async () => {
    const c = new SessionController(fakeApp(async function* () {}).app);
    c.send('/auth sk-secret-0123456789');
    await waitIdle(c);
    c.send('/mode dangerous');
    await waitIdle(c);
    c.send('/mode');
    await waitIdle(c);
    const errors = c.events().events.filter((e) => e.event.kind === 'error').map((e) => (e.event as { text: string }).text);
    expect(JSON.stringify(c.events().events)).not.toContain('secret-0123');
    expect(errors).toEqual([
      '/auth is not available remotely; run it on the computer.',
      '/mode dangerous can only be set on the computer.',
      'Give the mode: /mode default, /mode acceptEdits or /mode plan.',
    ]);
  });

  it('switches the mode for the session only, never to bypass, and refuses commands that change this computer', async () => {
    const f = fakeApp(async function* () {});
    const c = new SessionController(f.app);
    for (const cmd of ['/mode plan', '/mode bypass', '/skill install https://example.com/x.git', '/mcp reload', '/agents multi']) {
      c.send(cmd);
      await waitIdle(c);
    }
    expect(f.app.permissions.mode).toBe('plan');
    const lines = c.events().events.filter((e) => e.event.kind === 'info' || e.event.kind === 'error').map((e) => (e.event as { text: string }).text);
    expect(lines).toEqual([
      'Permission mode: plan (this session only)',
      '/mode bypass can only be set on the computer.',
      '/skill install is not available remotely; run it on the computer.',
      '/mcp reload is not available remotely; run it on the computer.',
      '/agents is not available remotely; run it on the computer.',
    ]);
  });

  it('never saves an "always" rule from remote', async () => {
    const c = new SessionController(fakeApp(async function* () {}).app);
    const answer = c.ask({ tool: 'bash', rule: 'bash(npm test)', title: 'npm test' });
    const ev = c.events().events.at(-1)!.event as Extract<RemoteEvent, { kind: 'permission' }>;
    c.answer(ev.id, 'allow-always');
    expect(await answer).toBe('allow-session');
  });

  it('replays events after a seq and says when older ones were dropped', () => {
    const c = new SessionController(fakeApp(async function* () {}).app, { maxEvents: 3 });
    for (let i = 0; i < 5; i++) void c.ask({ tool: 'bash', rule: 'x', title: `t${i}` });
    const { events } = c.events();
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(c.events(4).events.map((e) => e.seq)).toEqual([5]);
    expect(c.events(4).reset).toBe(false);
    expect(c.events(1).reset).toBe(true);
  });
});

describe('remote server', () => {
  async function setup() {
    const f = fakeApp(async function* () {
      yield { type: 'text', text: 'answer' };
      yield finish();
    });
    const session = new SessionController(f.app);
    const hub: Hub = {
      list: () => ({ open: [session.state()], roots: ['/work'] }),
      get: (id) => (id === session.id ? session : undefined),
      open: async () => session.state(),
      close: async () => {},
      stored: async () => [],
    };
    const devices = await Devices.load(join(mkdtempSync(join(tmpdir(), 'tessera-remote-')), 'remote.json'));
    const srv = await startServer(hub, devices, { port: 0 });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tessera': '1', ...headers }, body: JSON.stringify(body) });
    /** Pairs a device; returns its Authorization header. */
    const pair = async () => {
      const res = await post('/api/pair', { code: devices.newPairingCode(), name: 'test' });
      expect(res.status).toBe(200);
      return `Bearer ${((await res.json()) as { token: string }).token}`;
    };
    return { srv, base, post, pair, session, devices };
  }

  it('needs a paired device; a pairing code works once', async () => {
    const { srv, base, post, devices } = await setup();
    try {
      expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
      const code = devices.newPairingCode();
      const ok = await post('/api/pair', { code, name: 'phone' });
      expect(ok.status).toBe(200);
      // No cookie: the browser would send it to every port of 127.0.0.1.
      expect(ok.headers.get('set-cookie')).toBeNull();
      const { token } = (await ok.json()) as { token: string };
      expect((await post('/api/pair', { code, name: 'other' })).status).toBe(401);
      const list = await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { roots: string[] }).roots).toEqual(['/work']);
      expect((await fetch(`${base}/api/sessions`, { headers: { authorization: 'Bearer abc.def' } })).status).toBe(401);
      expect((await fetch(`${base}/api/sessions`, { headers: { cookie: `tessera_device=${token}` } })).status).toBe(401);
      expect((await post('/api/logout', {}, { authorization: `Bearer ${token}` })).status).toBe(200);
      expect((await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it('rejects other host names, cross-origin writes and writes without the app header', async () => {
    const { srv, base, post, pair, session } = await setup();
    try {
      const authorization = await pair();
      // fetch cannot change Host (a DNS-rebinding page would send its own name): use a raw request.
      const status = await new Promise<number>((resolve, reject) =>
        request({ host: '127.0.0.1', port: srv.port, path: '/api/sessions', headers: { authorization, host: 'evil.example' } }, (r) => (r.resume(), resolve(r.statusCode!)))
          .on('error', reject)
          .end(),
      );
      expect(status).toBe(421);
      expect((await post(`/api/sessions/${session.id}/send`, { text: 'x' }, { authorization, origin: 'http://evil.example' })).status).toBe(403);
      const noHeader = await fetch(`${base}/api/sessions/${session.id}/send`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{"text":"x"}' });
      expect(noHeader.status).toBe(403);
      expect(session.events().events).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('streams the state and events, and resumes after Last-Event-ID', async () => {
    const { srv, base, post, pair, session } = await setup();
    try {
      const authorization = await pair();
      expect((await post(`/api/sessions/${session.id}/send`, { text: 'hello' }, { authorization })).status).toBe(200);
      await until(() => session.state().busy === undefined && session.events().events.length === 3);
      const read = async (headers: Record<string, string>) => {
        const ac = new AbortController();
        const res = await fetch(`${base}/api/sessions/${session.id}/events`, { headers: { authorization, ...headers }, signal: ac.signal });
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        const reader = res.body!.getReader();
        let text = '';
        while (!text.includes('turn-finish') && !(headers['last-event-id'] && text.split('\n\n').length > 2)) text += new TextDecoder().decode((await reader.read()).value);
        ac.abort();
        return text
          .split('\n\n')
          .filter(Boolean)
          .map((m) => ({ id: /^id: (\d+)/m.exec(m)?.[1], event: JSON.parse(/^data: (.*)$/m.exec(m)![1]!) as RemoteEvent }));
      };
      const all = await read({});
      expect(all.map((m) => m.event.kind)).toEqual(['state', 'user', 'text', 'turn-finish']);
      expect(all.map((m) => m.id)).toEqual([undefined, '1', '2', '3']);
      const resumed = await read({ 'last-event-id': '2' });
      expect(resumed.map((m) => m.event.kind)).toEqual(['state', 'turn-finish']);
    } finally {
      await srv.close();
    }
  });

  it('serves the web app with a strict content security policy', async () => {
    const { srv, base } = await setup();
    try {
      const res = await fetch(`${base}/`);
      if (res.status === 500) return; // not built in this checkout (npm run build); the API is covered above
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(await res.text()).toContain('<script type="module" src="app.js">');
    } finally {
      await srv.close();
    }
  });
});

describe('Daemon', () => {
  it('opens sessions only in directories under its roots', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'tessera-roots-')));
    const root = join(base, 'root');
    mkdirSync(join(root, 'project'), { recursive: true });
    mkdirSync(join(base, 'outside'));
    symlinkSync(join(base, 'outside'), join(root, 'escape'));
    const d = new Daemon([root]);
    expect(await d.allowed(join(root, 'project'))).toBe(join(root, 'project'));
    expect(await d.allowed(root)).toBe(root);
    await expect(d.allowed(join(base, 'outside'))).rejects.toThrow(/outside the allowed directories/);
    await expect(d.allowed(join(root, 'escape'))).rejects.toThrow(/outside the allowed directories/);
    await expect(d.allowed(join(root, '..', 'outside'))).rejects.toThrow(/outside the allowed directories/);
    await expect(d.allowed(join(root, 'missing'))).rejects.toThrow(/Not a directory/);
  });
});
