import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { HOME_DIR } from '../config.js';
import { isImagePart } from '../agent/agent.js';

/** Per-session settings restored on resume. */
export interface SessionState {
  model: string;
  thinking: boolean;
  /** Absent in sessions saved before thinking levels existed. */
  thinkingLevel?: string;
  mode: string;
  total: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cost: number };
}

/** A file as it was before a turn first modified it. `blob` is absent when the file did not exist. */
export interface FileSnapshot {
  path: string;
  blob?: string;
}

/** Undo point: the state before one user turn. */
export interface Checkpoint {
  turn: number;
  /** History length before the turn. */
  index: number;
  /** Hash of the history before the turn; a mismatch (compaction, /clear) means only files can be rewound. */
  anchor: string;
  prompt: string;
  at: string;
  files: FileSnapshot[];
}

type Record =
  | { type: 'meta'; sessionId: string; cwd: string; createdAt: string; forkedFrom?: string }
  | { type: 'messages'; messages: ModelMessage[]; at: string }
  /** Replaces all prior history, e.g. after /clear or compaction. */
  | { type: 'reset'; messages: ModelMessage[]; at: string }
  | { type: 'title'; title: string }
  | ({ type: 'state' } & SessionState)
  | ({ type: 'checkpoint' } & Checkpoint)
  /** Drops checkpoints from `turn` on (after a rewind). */
  | { type: 'rewind'; turn: number };

export interface SessionSummary {
  id: string;
  path: string;
  updatedAt: Date;
  title: string;
  messages: number;
  model?: string;
}

export interface LoadedSession {
  messages: ModelMessage[];
  title?: string;
  state?: SessionState;
  checkpoints: Checkpoint[];
}

const BLOB_REF = 'tessera-blob:';

export function projectDir(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(HOME_DIR, 'sessions', hash);
}

async function endsWithNewline(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

/** Tolerates a truncated last line (e.g. the process was killed mid-write). */
function parseLine(line: string): Record | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as Record;
  } catch {
    return undefined;
  }
}

function textOf(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .flatMap((p) => ('text' in p && typeof p.text === 'string' ? [p.text] : []))
    .join(' ');
}

/** The user's own words of a prompt (attachments appended by tessera dropped), with a marker per attached image. */
export function promptText(m: ModelMessage): string {
  const text = textOf(m).replace(/\n*<context>[\s\S]*$/, '');
  const images = typeof m.content === 'string' ? 0 : m.content.filter(isImagePart).length;
  return images && !/\[Image #\d+\]/.test(text) ? `${text} ${'[Image] '.repeat(images).trim()}` : text;
}

export function parseSession(raw: string): LoadedSession {
  const out: LoadedSession = { messages: [], checkpoints: [] };
  for (const line of raw.split('\n')) {
    const rec = parseLine(line);
    if (!rec) continue;
    switch (rec.type) {
      case 'messages':
        out.messages.push(...rec.messages);
        break;
      case 'reset':
        out.messages = [...rec.messages];
        break;
      case 'title':
        out.title = rec.title;
        break;
      case 'state': {
        const { type: _, ...state } = rec;
        out.state = state;
        break;
      }
      case 'checkpoint': {
        const { type: _, ...cp } = rec;
        out.checkpoints.push(cp);
        break;
      }
      case 'rewind':
        out.checkpoints = out.checkpoints.filter((c) => c.turn < rec.turn);
        break;
    }
  }
  return out;
}

export class SessionStore {
  readonly path: string;
  /** Directory for file snapshots taken before edits (undo/rewind). */
  readonly blobDir: string;
  private savedCount = 0;
  private savedGeneration = 0;
  private savedState = '';
  private checkedTail = false;

  constructor(
    readonly cwd: string,
    readonly sessionId: string,
  ) {
    this.path = join(projectDir(cwd), `${sessionId}.jsonl`);
    this.blobDir = join(projectDir(cwd), `${sessionId}.files`);
  }

  /** The file is created on first write, so sessions that are never used leave nothing behind. */
  private async append(rec: Record): Promise<void> {
    await mkdir(projectDir(this.cwd), { recursive: true });
    const lines = [rec];
    let prefix = '';
    if (!existsSync(this.path)) lines.unshift({ type: 'meta', sessionId: this.sessionId, cwd: this.cwd, createdAt: new Date().toISOString() });
    else if (!this.checkedTail) prefix = (await endsWithNewline(this.path)) ? '' : '\n'; // a killed write left a partial line
    this.checkedTail = true;
    await appendFile(this.path, prefix + lines.map((l) => JSON.stringify(l) + '\n').join(''), { mode: 0o600 });
  }

  get exists(): boolean {
    return existsSync(this.path);
  }

  /** Treats the agent's current history as already saved (after loading or switching to this session). */
  adopt(agent: { messages: ModelMessage[]; generation: number }): void {
    this.savedCount = agent.messages.length;
    this.savedGeneration = agent.generation;
  }

  /**
   * Persists the agent's history: appends new messages, or writes a full reset record when the history
   * was replaced (compaction, /clear) since the last sync.
   */
  async sync(agent: { messages: ModelMessage[]; generation: number }): Promise<void> {
    if (agent.generation !== this.savedGeneration || agent.messages.length < this.savedCount) {
      await this.append({ type: 'reset', messages: await this.dehydrate(agent.messages), at: new Date().toISOString() });
      this.savedCount = agent.messages.length;
      this.savedGeneration = agent.generation;
      return;
    }
    const fresh = agent.messages.slice(this.savedCount);
    if (!fresh.length) return;
    await this.append({ type: 'messages', messages: await this.dehydrate(fresh), at: new Date().toISOString() });
    this.savedCount = agent.messages.length;
  }

  /** Records model/thinking/mode/usage when they changed since the last save. */
  async saveState(state: SessionState): Promise<void> {
    const json = JSON.stringify(state);
    if (json === this.savedState) return;
    this.savedState = json;
    await this.append({ type: 'state', ...state });
  }

  async setTitle(title: string): Promise<void> {
    await this.append({ type: 'title', title });
  }

  async addCheckpoint(cp: Checkpoint): Promise<void> {
    await this.append({ type: 'checkpoint', ...cp });
  }

  async markRewind(turn: number): Promise<void> {
    await this.append({ type: 'rewind', turn });
  }

  /** Stores a file's pre-edit content; returns the blob name. */
  async saveBlob(content: Buffer): Promise<string> {
    const name = createHash('sha256').update(content).digest('hex').slice(0, 32);
    await mkdir(this.blobDir, { recursive: true, mode: 0o700 });
    const path = join(this.blobDir, name);
    if (!existsSync(path)) await writeFile(path, content, { mode: 0o600 });
    return name;
  }

  readBlob(name: string): Promise<Buffer> {
    return readFile(join(this.blobDir, name));
  }

  /** Reads the whole session. Call adopt() once the agent holds the loaded history. */
  async load(): Promise<LoadedSession> {
    const loaded = existsSync(this.path) ? parseSession(await readFile(this.path, 'utf8')) : { messages: [], checkpoints: [] };
    if (loaded.state) this.savedState = JSON.stringify(loaded.state);
    loaded.messages = await this.rehydrate(loaded.messages);
    return loaded;
  }

  /** Images are kept as blobs next to the session, so the JSONL holds a short reference instead of megabytes. */
  private async dehydrate(messages: ModelMessage[]): Promise<ModelMessage[]> {
    return Promise.all(
      messages.map(async (m) => {
        if (!Array.isArray(m.content) || !m.content.some(isImagePart)) return m;
        const content = await Promise.all(
          (m.content as Array<{ [key: string]: unknown }>).map(async (p) => {
            const key = p.type === 'file' ? 'data' : 'image';
            const data = p[key];
            if (!isImagePart(p) || typeof data !== 'string' || data.length < 1024 || data.startsWith(BLOB_REF)) return p;
            return { ...p, [key]: BLOB_REF + (await this.saveBlob(Buffer.from(data, 'base64'))) };
          }),
        );
        return { ...m, content } as ModelMessage;
      }),
    );
  }

  private async rehydrate(messages: ModelMessage[]): Promise<ModelMessage[]> {
    return Promise.all(
      messages.map(async (m) => {
        if (!Array.isArray(m.content) || !m.content.some(isImagePart)) return m;
        const content = await Promise.all(
          (m.content as Array<{ [key: string]: unknown }>).map(async (p) => {
            const key = p.type === 'file' ? 'data' : 'image';
            const ref = p[key];
            if (typeof ref !== 'string' || !ref.startsWith(BLOB_REF)) return p;
            try {
              return { ...p, [key]: (await this.readBlob(ref.slice(BLOB_REF.length))).toString('base64') };
            } catch {
              return { type: 'text', text: '[image no longer available]' };
            }
          }),
        );
        return { ...m, content } as ModelMessage;
      }),
    );
  }

  /** Copies this session (history, checkpoints and file snapshots) into a new session id. */
  async fork(newId: string): Promise<SessionStore> {
    const target = new SessionStore(this.cwd, newId);
    const raw = existsSync(this.path) ? await readFile(this.path, 'utf8') : '';
    const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('{"type":"meta"'));
    const meta: Record = { type: 'meta', sessionId: newId, cwd: this.cwd, createdAt: new Date().toISOString(), forkedFrom: this.sessionId };
    await mkdir(projectDir(this.cwd), { recursive: true });
    await writeFile(target.path, [JSON.stringify(meta), ...lines].join('\n') + '\n', { mode: 0o600 });
    if (existsSync(this.blobDir)) {
      await mkdir(target.blobDir, { recursive: true, mode: 0o700 });
      for (const f of await readdir(this.blobDir)) await copyFile(join(this.blobDir, f), join(target.blobDir, f));
    }
    return target;
  }

  /**
   * Sessions of `cwd`, newest first. Summaries are cached in an index next to the sessions (keyed by mtime and size),
   * so only sessions that changed since the last listing are parsed.
   */
  static async list(cwd: string, limit = 50): Promise<SessionSummary[]> {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    const files = await Promise.all(
      names.map(async (f) => {
        const path = join(dir, f);
        const st = await stat(path);
        return { id: f.replace(/\.jsonl$/, ''), path, updatedAt: st.mtime, key: `${st.mtimeMs}:${st.size}` };
      }),
    );
    files.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const indexPath = join(dir, INDEX_FILE);
    const index = await readIndex(indexPath);
    let changed = false;
    const out: SessionSummary[] = [];
    for (const f of files) {
      if (out.length >= limit) break;
      let entry = index[f.id];
      if (entry?.key !== f.key) {
        entry = { key: f.key, ...summarize(parseSession(await readFile(f.path, 'utf8'))) };
        index[f.id] = entry;
        changed = true;
      }
      if (!entry.used) continue; // never used
      out.push({ id: f.id, path: f.path, updatedAt: f.updatedAt, title: entry.title, messages: entry.messages, model: entry.model });
    }
    for (const id of Object.keys(index)) {
      if (!names.includes(`${id}.jsonl`)) {
        delete index[id]; // deleted sessions
        changed = true;
      }
    }
    if (changed) await writeAtomic(indexPath, JSON.stringify(index)).catch(() => {});
    return out;
  }

  /** The session `id` names: an exact id, else the newest session whose id starts with it (no session is parsed). */
  static async find(cwd: string, id: string): Promise<string | undefined> {
    const dir = projectDir(cwd);
    if (!id || !existsSync(dir)) return undefined;
    const ids = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
    if (ids.includes(id)) return id;
    const matches = await Promise.all(ids.filter((x) => x.startsWith(id)).map(async (x) => ({ x, t: (await stat(join(dir, `${x}.jsonl`))).mtimeMs })));
    return matches.sort((a, b) => b.t - a.t)[0]?.x;
  }
}

const INDEX_FILE = '.index.json';

/** Write via a temp file and rename, so a concurrent reader never sees a half-written file. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

interface IndexEntry {
  key: string;
  used: boolean;
  title: string;
  messages: number;
  model?: string;
}

async function readIndex(path: string): Promise<{ [id: string]: IndexEntry }> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { [id: string]: IndexEntry };
  } catch {
    return {};
  }
}

function summarize(s: LoadedSession): Omit<IndexEntry, 'key'> {
  const firstUser = s.messages.find((m) => m.role === 'user');
  return {
    used: s.messages.length > 0 || s.title !== undefined,
    title: s.title ?? (firstUser ? promptText(firstUser).replace(/\s+/g, ' ').trim().slice(0, 80) : '(empty)'),
    messages: s.messages.length,
    model: s.state?.model,
  };
}

/** Identifies a history prefix, so a checkpoint can tell whether its conversation point still exists. */
export function historyAnchor(messages: ModelMessage[]): string {
  // Long strings (image data) are represented by their length and ends: identity is preserved without hashing megabytes.
  const json = JSON.stringify(messages, (_, v) => (typeof v === 'string' && v.length > 4096 ? `${v.length}:${v.slice(0, 64)}:${v.slice(-64)}` : v));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}
