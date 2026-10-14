import { readFile, realpath, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { ToolContext } from '../tools/context.js';
import { displayPath, resolvePath } from '../tools/context.js';
import { isSensitivePath } from '../tools/files.js';

const MAX_IMPLICIT = 5;
const MAX_EXPLICIT = 10;
const MAX_BYTES = 60_000;
const MAX_LINES = 2000;
const MAX_DIR_ENTRIES = 200;

// Never auto-attach likely secrets just because they were mentioned ("don't touch .env.local").
const SECRET_NAME = /^\.env(\..*)?$|\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$|^id_[a-z0-9]+|secret|credential|\.npmrc$|\.netrc$|\.pgpass$|(^|[._-])tokens?([._-]|$)/i;
const IGNORED_DIR = /(^|\/)(node_modules|\.git|dist|\.next|build|\.tessera)(\/|$)/;

export function isSecretName(path: string): boolean {
  return SECRET_NAME.test(basename(path));
}

export interface Mentions {
  /** Paths written as @path: attached even without an extension; directories are listed. */
  explicit: string[];
  /** Bare file names like "median.ts": attached only if they exist and are small. */
  implicit: string[];
}

export function parseMentions(prompt: string): Mentions {
  const explicit = new Set<string>();
  for (const m of prompt.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const path = m[1]!.replace(/[,;:)\]'"!?]+$/, '').replace(/:\d+(-\d+)?$/, '').replace(/\.$/, '');
    if (path) explicit.add(path);
  }
  const implicit = new Set<string>();
  for (const m of prompt.matchAll(/(?<![@\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?::\d+)?/g)) {
    if (!explicit.has(m[1]!)) implicit.add(m[1]!);
  }
  return { explicit: [...explicit], implicit: [...implicit] };
}

export interface AttachResult {
  /** Text appended to the prompt for the model. */
  context?: string;
  /** One line per attached or skipped mention, for the UI. */
  notes: string[];
}

function numbered(content: string): { text: string; truncated: boolean; lines: number } {
  const lines = content.split('\n');
  const shown = lines.slice(0, MAX_LINES);
  return {
    text: shown.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'),
    truncated: lines.length > shown.length,
    lines: lines.length,
  };
}

/**
 * Pre-reads files the prompt mentions ("fix median.ts", "@src/app.ts", "@src/") and attaches them, so the model
 * can act right away instead of spending glob/read round trips. Each LLM round trip costs seconds; tools cost ms.
 * Attached files count as read for the edit tool's freshness check (only when attached in full).
 */
export async function attachMentionedFiles(
  ctx: ToolContext,
  prompt: string,
  /** Extra veto, e.g. PreToolUse hooks for the read tool. */
  allow: (abs: string) => Promise<boolean> = async () => true,
): Promise<AttachResult> {
  const { explicit, implicit } = parseMentions(prompt);
  const blocks: string[] = [];
  const notes: string[] = [];

  const attach = async (candidate: string, isExplicit: boolean): Promise<void> => {
    const abs = resolvePath(ctx, candidate);
    let target: string;
    try {
      target = await realpath(abs); // check the symlink target too: a link inside the repo may point at ~/.ssh
    } catch {
      if (isExplicit) notes.push(`@${candidate}: not found`);
      return;
    }
    const rel = displayPath(ctx, abs);
    if (isSensitivePath(ctx.cwd, abs) || isSensitivePath(ctx.cwd, target)) {
      if (isExplicit) notes.push(`@${candidate}: outside the project or protected; not attached`);
      return;
    }
    if (isSecretName(abs) || isSecretName(target)) {
      if (isExplicit) notes.push(`@${candidate}: looks like a secret; not attached`);
      return;
    }
    if (!(await allow(abs))) {
      if (isExplicit) notes.push(`@${candidate}: blocked by hook`);
      return;
    }
    const s = await stat(abs);
    if (s.isDirectory()) {
      if (!isExplicit) return;
      const prefix = rel === '.' ? '' : rel.replace(/\/?$/, '/');
      const entries = listProjectFiles(ctx.cwd).filter((f) => f.startsWith(prefix));
      const shown = entries.slice(0, MAX_DIR_ENTRIES);
      blocks.push(`<directory path="${rel}">\n${shown.join('\n')}${entries.length > shown.length ? `\n(${entries.length - shown.length} more)` : ''}\n</directory>`);
      notes.push(`📎 ${rel}/ (${entries.length} files listed)`);
      return;
    }
    if (!s.isFile()) return;
    if (!isExplicit && s.size > MAX_BYTES) return;
    const content = await readFile(abs, 'utf8');
    if (content.includes('\u0000')) {
      if (isExplicit) notes.push(`@${candidate}: binary file; not attached`);
      return;
    }
    const body = content.length > MAX_BYTES ? content.slice(0, MAX_BYTES) : content;
    const n = numbered(body);
    const partial = n.truncated || body.length < content.length;
    // Only a complete view may satisfy the edit tool's read-before-edit check.
    if (!partial) ctx.readFiles.set(abs, s.mtimeMs);
    blocks.push(
      `<file path="${rel}"${partial ? ' partial="true"' : ''}>\n${n.text}\n</file>` +
        (partial ? `\n(${rel} is truncated; read it with offset/limit before editing beyond this point)` : ''),
    );
    notes.push(`📎 ${rel} (${n.lines} lines${partial ? ', truncated' : ''})`);
  };

  for (const c of explicit.slice(0, MAX_EXPLICIT)) await attach(c, true).catch(() => notes.push(`@${c}: could not be read`));
  let implicitCount = 0;
  for (const c of implicit) {
    if (implicitCount >= MAX_IMPLICIT) break;
    const before = blocks.length;
    await attach(c, false).catch(() => {});
    if (blocks.length > before) implicitCount++;
  }
  return {
    context: blocks.length ? `Files mentioned in the request (already read; edit them directly):\n${blocks.join('\n')}` : undefined,
    notes,
  };
}

interface FileList {
  at: number;
  files: string[];
  git: boolean;
  /** Files plus their directories ("src/"), built on first use by completion. */
  withDirs?: string[];
  refreshing?: boolean;
}

const fileCache = new Map<string, FileList>();

function walk(cwd: string, max: number): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(join(cwd, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIR.test(rel)) visit(rel);
      } else if (e.isFile()) out.push(rel);
    }
  };
  visit('');
  return out;
}

/** Project files (git-tracked plus untracked-not-ignored, or a bounded walk outside git), secrets excluded. Cached 30s. */
export function listProjectFiles(cwd: string): string[] {
  return projectFiles(cwd).files;
}

const GIT_LS = ['ls-files', '--cached', '--others', '--exclude-standard'];

function entryOf(raw: string[] | undefined, cwd: string): FileList {
  const git = raw !== undefined;
  const files = (raw ?? walk(cwd, 10_000)).filter((f) => f && !isSecretName(f) && !IGNORED_DIR.test(f));
  return { at: Date.now(), files, git };
}

/**
 * Only the first listing blocks; after that a stale list is returned at once and refreshed in the background, so
 * typing (completion runs per keystroke) never waits for git.
 */
function projectFiles(cwd: string): FileList {
  const hit = fileCache.get(cwd);
  if (hit) {
    if (Date.now() - hit.at >= 30_000 && !hit.refreshing) {
      hit.refreshing = true;
      execFile('git', GIT_LS, { cwd, maxBuffer: 20_000_000 }, (err, out) => {
        fileCache.set(cwd, entryOf(err ? undefined : out.split('\n'), cwd));
      });
    }
    return hit;
  }
  let raw: string[] | undefined;
  try {
    raw = execFileSync('git', GIT_LS, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20_000_000 }).toString().split('\n');
  } catch {
    raw = undefined;
  }
  const entry = entryOf(raw, cwd);
  fileCache.set(cwd, entry);
  return entry;
}

/** Lists the project files without blocking (startup), so later synchronous lookups hit the cache. */
export function primeProjectFiles(cwd: string): Promise<void> {
  if (fileCache.has(cwd)) return Promise.resolve();
  return new Promise((resolve) => {
    execFile('git', GIT_LS, { cwd, maxBuffer: 20_000_000 }, (err, out) => {
      if (!fileCache.has(cwd)) fileCache.set(cwd, entryOf(err ? undefined : out.split('\n'), cwd));
      resolve();
    });
  });
}

/** Compact project file list for the system prompt, so the model rarely needs a glob round trip. */
export function projectFileList(cwd: string, max = 200): string | undefined {
  const { files, git } = projectFiles(cwd);
  if (!git || !files.length) return undefined; // outside git the walk may be arbitrary (e.g. $HOME); let the model glob
  const shown = files.slice(0, max).join('\n');
  return files.length > max ? `${shown}\n(${files.length - max} more files; use glob)` : shown;
}

/** Ranked completions for an @-mention: files and their directories, best matches first. */
export function suggestFiles(cwd: string, query: string, limit = 8): string[] {
  const entry = projectFiles(cwd);
  if (!entry.withDirs) {
    const dirs = new Set<string>();
    for (const f of entry.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }
    entry.withDirs = [...dirs, ...entry.files];
  }
  const q = query.toLowerCase();
  const all = entry.withDirs;
  if (!q) return all.filter((p) => !p.slice(0, -1).includes('/')).sort().slice(0, limit); // top level
  const score = (p: string): number => {
    const lower = p.toLowerCase();
    const base = basename(lower.replace(/\/$/, ''));
    if (lower === q || base === q) return 0;
    if (lower.startsWith(q)) return 1;
    if (base.startsWith(q)) return 2;
    if (base.includes(q)) return 3;
    if (lower.includes(q)) return 4;
    let i = 0;
    for (const ch of lower) if (ch === q[i]) i++;
    return i === q.length ? 5 : -1; // subsequence ("srcapp" -> src/app.ts)
  };
  return all
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}
