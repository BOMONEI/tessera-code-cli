import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GLOBAL_CONFIG, HOME_DIR } from '../config.js';
import { SessionController } from './controller.js';
import { Devices } from './devices.js';
import type { SessionList, SessionState, StoredSession } from './protocol.js';
import { startServer, type Hub } from './server.js';
import type { Link } from './link.js';

export const DEFAULT_PORT = 8723;
/** Sessions open at once (each may start MCP servers). */
const MAX_SESSIONS = 8;
export const DEVICES_FILE = join(HOME_DIR, 'remote.json');

export interface RemoteSettings {
  port: number;
  /** Directories (and everything under them) where the remote app may open sessions. */
  roots: string[];
  /** The relay (`tessera-code relay` on a server) that makes this computer reachable from anywhere. */
  relay?: { url: string; token: string };
}

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** "remote": { "port", "roots", "relay" } from ~/.tessera-code/config.json (the user's own file only, never a project's). */
export async function remoteSettings(cwd: string): Promise<RemoteSettings> {
  let remote: { port?: unknown; roots?: unknown; relay?: unknown } = {};
  if (existsSync(GLOBAL_CONFIG)) remote = ((JSON.parse(await readFile(GLOBAL_CONFIG, 'utf8')) as { remote?: object }).remote ?? {}) as typeof remote;
  const port = remote.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) throw new Error(`Invalid "remote.port" in config: ${JSON.stringify(port)}`);
  const roots = remote.roots ?? [cwd];
  if (!Array.isArray(roots) || !roots.length || roots.some((r) => typeof r !== 'string')) throw new Error('Invalid "remote.roots" in config: use a list of directories.');
  return { port: port as number, roots: (roots as string[]).map((r) => resolve(expand(r))), ...(remote.relay === undefined ? {} : { relay: relaySettings(remote.relay) }) };
}

function relaySettings(value: unknown): { url: string; token: string } {
  const r = (value ?? {}) as { url?: unknown; token?: unknown };
  if (typeof r.url !== 'string' || typeof r.token !== 'string' || !r.token) throw new Error('Invalid "remote.relay" in config: use { "url": "https://…", "token": "…" }.');
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    throw new Error(`Invalid "remote.relay.url" in config: ${r.url}`);
  }
  // The pages a phone opens there hold its keys: only HTTPS, except a relay on this computer (testing).
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('"remote.relay.url" must start with https://');
  return { url: url.origin, token: r.token };
}

/** The sessions `tessera-code serve` keeps open, each driven by a SessionController. */
export class Daemon implements Hub {
  private sessions = new Map<string, SessionController>();
  private opening = new Map<string, Promise<SessionState>>();

  constructor(readonly roots: string[]) {}

  list(): SessionList {
    return { open: [...this.sessions.values()].map((s) => s.state()), roots: this.roots };
  }

  get(id: string): SessionController | undefined {
    return this.sessions.get(id);
  }

  async open(cwd: string | undefined, resume?: string): Promise<SessionState> {
    const dir = await this.allowed(cwd ?? this.roots[0]!);
    if (resume) {
      // Already open (from another device): join it instead of running the conversation twice.
      const open = [...this.sessions.values()].find((s) => s.state().session === resume);
      if (open) return open.state();
      const key = `${dir}\0${resume}`;
      const pending = this.opening.get(key);
      if (pending) return pending;
      const p = this.create(dir, resume).finally(() => this.opening.delete(key));
      this.opening.set(key, p);
      return p;
    }
    return this.create(dir);
  }

  private async create(dir: string, resume?: string): Promise<SessionState> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`${MAX_SESSIONS} sessions are open; close one first.`);
    const { createApp } = await import('../app.js');
    let controller: SessionController | undefined;
    const app = await createApp({
      cwd: dir,
      resume,
      prompt: (req) => (controller ? controller.ask(req) : Promise.resolve('deny')),
      onDiff: (path, diff) => controller?.onDiff(path, diff),
      // Nobody is at the computer to answer: project hooks and MCP servers run only if trusted there before.
      confirmTrust: async () => false,
    });
    // "dangerous" (no prompts at all) is for someone watching the screen; remotely the guard stays on.
    if (app.permissions.mode === 'dangerous') app.permissions.mode = 'bypass';
    controller = new SessionController(app);
    this.sessions.set(controller.id, controller);
    return controller.state();
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
  }

  async stored(cwd: string): Promise<StoredSession[]> {
    const { SessionStore } = await import('../session/store.js');
    const list = await SessionStore.list(await this.allowed(cwd), 30);
    return list.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt.toISOString(), messages: s.messages }));
  }

  /** `path` resolved (symlinks too), if it is a directory under one of the roots. */
  async allowed(path: string): Promise<string> {
    const real = await realpath(resolve(expand(path))).catch(() => undefined);
    if (!real || !(await stat(real)).isDirectory()) throw new Error(`Not a directory: ${path}`);
    for (const root of this.roots) {
      const r = await realpath(root).catch(() => undefined);
      if (!r) continue;
      const rel = relative(r, real);
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return real;
    }
    throw new Error(`${path} is outside the allowed directories (${this.roots.join(', ')}); add it to "remote.roots" in ${GLOBAL_CONFIG}.`);
  }
}

export interface ServeOptions {
  port?: number;
  forgetDevices?: boolean;
  log: (line: string) => void;
}

/** `tessera-code serve`: the daemon, the web app on 127.0.0.1, and a pairing link. Resolves when stopped. */
export async function serve(opts: ServeOptions): Promise<void> {
  const settings = await remoteSettings(process.cwd());
  const devices = await Devices.load(DEVICES_FILE);
  if (opts.forgetDevices) await devices.revokeAll();
  const daemon = new Daemon(settings.roots);
  const server = await startServer(daemon, devices, { port: opts.port ?? settings.port });
  let relay: { link: Link; pairUrl: (code: string) => string } | undefined;
  if (settings.relay) {
    const { startLink } = await import('./link.js');
    const { exportPublic, keyId } = await import('./e2e.js');
    const daemonKey = await devices.daemonKey();
    const daemonPub = await exportPublic(daemonKey.publicKey);
    const daemonId = await keyId(daemonPub);
    const { url, token } = settings.relay;
    relay = {
      link: startLink({ relay: url, token, daemonKey, daemonPub, daemonId, hub: daemon, devices, log: opts.log }),
      // Everything after "#" stays in the phone: the relay never sees the key or the pairing code.
      pairUrl: (code) => `${url}/#d=${daemonId}&k=${daemonPub}&p=${code}`,
    };
  }
  const pairing = async (intro: string) => {
    const code = devices.newPairingCode();
    opts.log(`${intro} (one device, valid 10 minutes):`);
    opts.log(`  this computer: http://127.0.0.1:${server.port}/#pair=${code}`);
    if (relay) {
      const { renderUnicodeCompact } = await import('uqr');
      opts.log(`  phone (scan): ${relay.pairUrl(code)}`);
      opts.log(renderUnicodeCompact(relay.pairUrl(code), { border: 2 }));
    }
  };
  opts.log(`tessera-code serve: http://127.0.0.1:${server.port}`);
  opts.log(`Sessions may open in: ${settings.roots.join(', ')}`);
  if (settings.roots.some((r) => r === homedir() || r === '/')) {
    opts.log(`⚠ That includes your whole ${settings.roots.includes('/') ? 'disk' : 'home directory'}; set "remote.roots" in ${GLOBAL_CONFIG} to the projects you want.`);
  }
  opts.log('A paired browser can do anything you can in a terminal here (including "!" shell lines). Pair only your own devices.');
  opts.log(`Paired devices: ${devices.all.length}${devices.all.length ? ` (${devices.all.map((d) => d.name).join(', ')})` : ''}`);
  await pairing('Pair a browser');
  // The computer must stay awake while it serves (macOS: until this process exits).
  if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}).unref();

  await new Promise<void>((done) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      opts.log('Stopping…');
      relay?.link.close();
      void daemon
        .closeAll()
        .then(() => server.close())
        .finally(done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    if (process.stdin.isTTY) {
      opts.log('Keys: p = new pairing link, q = quit');
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key: string) => {
        if (key === 'p') void pairing('New pairing code');
        else if (key === 'q' || key === '\x03') stop();
      });
    }
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
