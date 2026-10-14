import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { tool } from 'ai';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { type ToolContext, resolvePath, displayPath } from './context.js';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

async function mtime(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

async function assertFresh(ctx: ToolContext, abs: string): Promise<void> {
  const seen = ctx.readFiles.get(abs);
  if (seen === undefined) throw new Error(`You must read ${displayPath(ctx, abs)} with the read tool before modifying it.`);
  if ((await mtime(abs)) !== seen) throw new Error(`${displayPath(ctx, abs)} changed since you last read it. Read it again before modifying it.`);
}

/**
 * Paths where an edit always needs explicit approval: outside the project, or files that grant
 * the agent new powers (its own settings, git hooks).
 */
export function isSensitivePath(cwd: string, abs: string): boolean {
  // Resolve symlinks (through the nearest existing ancestor) and compare case-insensitively, since the
  // default macOS filesystem treats ".Git" as ".git".
  const real = (p: string): string => {
    let dir = p;
    const rest: string[] = [];
    while (!existsSync(dir) && dirname(dir) !== dir) {
      rest.unshift(basename(dir));
      dir = dirname(dir);
    }
    try {
      return join(realpathSync(dir), ...rest).toLowerCase();
    } catch {
      return p.toLowerCase();
    }
  };
  const root = real(cwd);
  const target = real(abs);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true;
  const top = rel.split(sep)[0];
  return top === '.tessera' || top === '.git' || target.startsWith(real(join(homedir(), '.tessera-code')));
}

// Serializes writes per file: parallel edit calls on one file would otherwise overwrite each other.
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(abs) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  fileLocks.set(abs, tail);
  try {
    return await run;
  } finally {
    if (fileLocks.get(abs) === tail) fileLocks.delete(abs);
  }
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, '', '', { context: 3 })
    .split('\n')
    .slice(2) // drop the "===" and "---/+++" header noise beyond the hunk headers
    .join('\n')
    .trim();
}

/**
 * Locate old_string in content. Falls back to matching with trailing whitespace ignored per line,
 * since models often drop or add trailing spaces when echoing code back.
 */
export function findOccurrences(content: string, needle: string): Array<{ start: number; end: number }> {
  const exact: Array<{ start: number; end: number }> = [];
  for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + Math.max(needle.length, 1))) {
    exact.push({ start: i, end: i + needle.length });
  }
  if (exact.length) return exact;

  const lines = content.split('\n');
  const target = needle.split('\n').map((l) => l.trimEnd());
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  const loose: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    if (target.every((t, j) => lines[i + j]!.trimEnd() === t)) {
      const lastLine = i + target.length - 1;
      loose.push({ start: offsets[i]!, end: offsets[lastLine]! + lines[lastLine]!.length });
      i = lastLine; // continue after this match so hits never overlap
    }
  }
  return loose;
}

export function fileTools(ctx: ToolContext) {
  return {
    read: tool({
      description:
        'Read a file from the local filesystem. Returns lines prefixed with line numbers (cat -n format). ' +
        `Reads up to ${MAX_LINES} lines by default; use offset/limit for large files. Always read a file before editing it.`,
      inputSchema: z.object({
        path: z.string().describe('Absolute path or path relative to the working directory'),
        offset: z.number().int().min(1).optional().describe('1-based line number to start from'),
        limit: z.number().int().min(1).optional().describe('Number of lines to read'),
      }),
      execute: async ({ path, offset = 1, limit = MAX_LINES }) => {
        const abs = resolvePath(ctx, path);
        if (!existsSync(abs)) throw new Error(`File not found: ${path}`);
        const s = await stat(abs);
        if (s.isDirectory()) throw new Error(`${path} is a directory. Use the glob tool to list files.`);
        const content = await readFile(abs, 'utf8');
        ctx.readFiles.set(abs, s.mtimeMs);
        if (content.length === 0) return '(file is empty)';
        const lines = content.split('\n');
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const body = slice
          .map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + '…' : l}`)
          .join('\n');
        const remaining = lines.length - (offset - 1 + slice.length);
        return remaining > 0 ? `${body}\n\n(${remaining} more lines; use offset=${offset + slice.length} to continue)` : body;
      },
    }),

    write: tool({
      description:
        'Create a new file or completely overwrite an existing one. Prefer the edit tool for changes to existing files. ' +
        'Existing files must be read first.',
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe('The full file content'),
      }),
      execute: async ({ path, content }, { abortSignal }) => {
        const abs = resolvePath(ctx, path);
        const rel = displayPath(ctx, abs);
        return withFileLock(abs, async () => {
          const exists = existsSync(abs);
          const before = exists ? await readFile(abs, 'utf8') : '';
          if (exists) await assertFresh(ctx, abs);
          const diff = unifiedDiff(rel, before, content);
          const denied = await ctx.permissions.check({
            tool: 'edit',
            rule: 'edit',
            title: `${exists ? 'Overwrite' : 'Create'} ${rel}`,
            detail: diff,
            sensitive: isSensitivePath(ctx.cwd, abs),
            signal: abortSignal,
          });
          if (denied) return denied;
          // The user may have changed the file while the permission dialog was open.
          if (exists) await assertFresh(ctx, abs);
          else if (existsSync(abs)) throw new Error(`${rel} was created by someone else meanwhile. Read it before overwriting.`);
          await ctx.beforeWrite?.(abs);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content);
          ctx.readFiles.set(abs, await mtime(abs));
          ctx.onDiff?.(rel, diff);
          return `${exists ? 'Overwrote' : 'Created'} ${rel} (${content.split('\n').length} lines)`;
        });
      },
    }),

    edit: tool({
      description:
        'Replace an exact string in a file. old_string must match the file content exactly (including indentation) ' +
        'and must be unique unless replace_all is true. Include enough surrounding lines to make it unique. ' +
        'Read the file first. Do not include line-number prefixes from the read output.',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional().describe('Replace every occurrence'),
      }),
      execute: async ({ path, old_string, new_string, replace_all }, { abortSignal }) => {
        const abs = resolvePath(ctx, path);
        const rel = displayPath(ctx, abs);
        if (!existsSync(abs)) throw new Error(`File not found: ${path}. Use the write tool to create new files.`);
        if (old_string === new_string) throw new Error('old_string and new_string are identical.');
        return withFileLock(abs, async () => {
          await assertFresh(ctx, abs);
          const before = await readFile(abs, 'utf8');
          const hits = findOccurrences(before, old_string);
          if (hits.length === 0) {
            throw new Error(`old_string was not found in ${rel}. Re-read the file and copy the exact text, including whitespace.`);
          }
          if (hits.length > 1 && !replace_all) {
            throw new Error(`old_string matches ${hits.length} locations in ${rel}. Add surrounding context to make it unique, or set replace_all.`);
          }
          let after = before;
          for (const h of [...hits].reverse()) after = after.slice(0, h.start) + new_string + after.slice(h.end);
          const diff = unifiedDiff(rel, before, after);
          const denied = await ctx.permissions.check({ tool: 'edit', rule: 'edit', title: `Edit ${rel}`, detail: diff, sensitive: isSensitivePath(ctx.cwd, abs), signal: abortSignal });
          if (denied) return denied;
          await assertFresh(ctx, abs); // changed while the permission dialog was open?
          await ctx.beforeWrite?.(abs);
          await writeFile(abs, after);
          ctx.readFiles.set(abs, await mtime(abs));
          ctx.onDiff?.(rel, diff);
          return `Edited ${rel} (${hits.length} replacement${hits.length > 1 ? 's' : ''})`;
        });
      },
    }),
  };
}
