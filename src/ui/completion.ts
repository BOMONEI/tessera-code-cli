import { basename } from 'node:path';

/** One completion candidate. `value` replaces the text between `start` and `end` of the completion. */
export interface CompletionItem {
  value: string;
  label: string;
  hint?: string;
}

export interface Completion {
  kind: 'command' | 'argument' | 'file' | 'shell';
  start: number;
  end: number;
  items: CompletionItem[];
}

export interface CommandInfo {
  name: string;
  description: string;
  argHint?: string;
}

export interface CompletionSources {
  commands: CommandInfo[];
  /** Argument candidates of a command; undefined while unknown (not loaded yet, or the command takes none). */
  args: (command: string) => Array<{ value: string; hint?: string }> | undefined;
  files: (query: string) => string[];
  /** Earlier prompts, newest first. */
  history: string[];
}

/**
 * How well `candidate` matches `query` (lower is better, -1 = no match): exact, prefix, basename prefix,
 * substring, then subsequence ("srcapp" -> src/app.ts).
 */
export function fuzzyScore(candidate: string, query: string): number {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 5;
  const base = basename(c.replace(/\/$/, ''));
  if (c === q || base === q) return 0;
  if (c.startsWith(q)) return 1;
  if (base.startsWith(q)) return 2;
  if (base.includes(q)) return 3;
  if (c.includes(q)) return 4;
  let i = 0;
  for (const ch of c) if (ch === q[i]) i++;
  return i === q.length ? 6 : -1;
}

/** Items matching `query`, best first (stable for equal scores). */
export function rank<T>(items: T[], query: string, key: (t: T) => string, limit = 50): T[] {
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(key(item), query) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

/** The @-mention being typed at the cursor, if any: "fix @src/ap|" -> { start: 4, query: "src/ap" }. */
export function mentionAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const before = value.slice(0, cursor);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return undefined;
  return { start: before.length - m[2]!.length - 1, query: m[2]! };
}

/** Completion for the text at the cursor: slash commands and their arguments, @files, or earlier !commands. */
export function complete(input: string, cursor: number, src: CompletionSources): Completion | undefined {
  const before = input.slice(0, cursor);
  if (before.includes('\n')) {
    const mention = mentionAt(input, cursor);
    return mention ? fileCompletion(input, cursor, mention, src) : undefined;
  }

  // "/cmd" -> command names; "/cmd arg" -> that command's arguments.
  const slash = /^\/(\S*)(?:\s+(.*))?$/.exec(before);
  if (slash) {
    const [, name = '', arg] = slash;
    if (arg === undefined) {
      const items = rank(src.commands, name, (c) => c.name).map((c) => ({
        value: `/${c.name}`,
        label: `/${c.name}${c.argHint ? ` ${c.argHint}` : ''}`,
        hint: c.description,
      }));
      return items.length ? { kind: 'command', start: 0, end: lineEnd(input, cursor), items } : undefined;
    }
    const options = src.args(name);
    if (!options?.length) return undefined;
    const argStart = before.length - arg.length;
    const items = rank(options, arg, (o) => o.value).map((o) => ({ value: o.value, label: o.value, hint: o.hint }));
    if (!items.length || (items.length === 1 && items[0]!.value === arg)) return undefined;
    return { kind: 'argument', start: argStart, end: lineEnd(input, cursor), items };
  }

  const mention = mentionAt(input, cursor);
  if (mention) return fileCompletion(input, cursor, mention, src);

  // "!git st" -> earlier shell commands. Enter only inserts: shell commands run without approval.
  if (before.startsWith('!')) {
    const seen = new Set<string>();
    const items = src.history
      .filter((h) => h.startsWith('!') && !h.includes('\n') && h !== before && h.startsWith(before) && !seen.has(h) && seen.add(h))
      .slice(0, 8)
      .map((h) => ({ value: h, label: h, hint: 'earlier command' }));
    return items.length ? { kind: 'shell', start: 0, end: lineEnd(input, cursor), items } : undefined;
  }
  return undefined;
}

function lineEnd(input: string, cursor: number): number {
  const nl = input.indexOf('\n', cursor);
  const end = nl === -1 ? input.length : nl;
  // Replace only the token under the cursor, not text typed after it.
  const ws = input.slice(cursor, end).search(/\s/);
  return ws === -1 ? end : cursor + ws;
}

function fileCompletion(input: string, cursor: number, mention: { start: number; query: string }, src: CompletionSources): Completion | undefined {
  const items = src.files(mention.query).map((f) => ({ value: `@${f}`, label: f, hint: f.endsWith('/') ? 'directory' : undefined }));
  if (!items.length) return undefined;
  return { kind: 'file', start: mention.start, end: lineEnd(input, cursor), items };
}

/**
 * What Enter does while a menu is open:
 * - 'typed': submit the input exactly as typed (shell lines, which run without approval, are never swapped for a
 *   suggestion; also when the cursor sits inside the command or nothing has been typed for an argument yet, so the
 *   bare command runs its own picker/toggle);
 * - 'complete-and-run': complete the selected command/argument and submit it;
 * - 'complete': insert the selected file (or submit as typed when it is already exactly what was typed).
 */
/**
 * `chosen`: the user moved through the menu with the arrows, so the highlighted item is a deliberate pick. Without
 * it, enter on an argument menu with nothing typed runs the bare command (e.g. /model shows the current model).
 */
export function enterAction(input: string, cursor: number, c: Completion, item: CompletionItem, chosen = false): 'typed' | 'complete-and-run' | 'complete' {
  const typed = input.slice(c.start, cursor);
  if (c.kind === 'shell') return 'typed';
  if (c.kind === 'file') return item.value === input.slice(c.start, c.end) ? 'typed' : 'complete';
  if (cursor !== c.end || (c.kind === 'argument' && typed === '' && !chosen)) return 'typed';
  return 'complete-and-run';
}

/** Applies a completion: the new input and cursor. Directories keep the menu open; files and commands add a space. */
export function applyCompletion(input: string, c: Completion, item: CompletionItem): { value: string; cursor: number } {
  const spaced = c.kind === 'command' || (c.kind === 'file' && !item.value.endsWith('/'));
  let rest = input.slice(c.end);
  if (spaced && rest.startsWith(' ')) rest = rest.slice(1);
  const text = item.value + (spaced ? ' ' : '');
  return { value: input.slice(0, c.start) + text + rest, cursor: c.start + text.length };
}

/**
 * Fish-style suggestion: the rest of the newest earlier single-line prompt that starts with what was typed. Only
 * for plain prompts with the cursor at the end.
 */
export function ghostText(input: string, cursor: number, history: string[]): string | undefined {
  if (input.length < 2 || cursor !== input.length || input.includes('\n') || /^[/!]/.test(input)) return undefined;
  const hit = history.find((h) => h.length > input.length && h.startsWith(input) && !h.includes('\n'));
  return hit?.slice(input.length);
}
