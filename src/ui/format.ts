import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { styleText } from 'node:util';
import stringWidth from 'string-width';
import type { Usage } from '../agent/agent.js';

export const dim = (s: string) => styleText('dim', s);
export const bold = (s: string) => styleText('bold', s);
export const red = (s: string) => styleText('red', s);
export const green = (s: string) => styleText('green', s);
export const yellow = (s: string) => styleText('yellow', s);
export const cyan = (s: string) => styleText('cyan', s);

/** One-line summary of a tool call, e.g. `read(src/cli.ts)` or `bash(npm test)`. */
export function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const arg = i.path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? i.name ?? '';
  const s = String(arg).replace(/\s+/g, ' ');
  return `${name}(${s.length > 80 ? s.slice(0, 79) + '…' : s})`;
}

/** A tool result as display text. */
export function outputText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2) ?? '';
}

/** First few lines of a tool result for display. */
export function toolPreview(output: unknown, maxLines = 4): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines).map((l) => (l.length > 160 ? l.slice(0, 159) + '…' : l));
  if (lines.length > maxLines) shown.push(`… +${lines.length - maxLines} lines`);
  return shown.join('\n');
}

// Truecolor backgrounds for changed lines (like Claude Code / opencode): a tinted band that reads on dark and light
// themes, with a brighter sign column. Without truecolor the 16-color fallback keeps green/red text.
const ADDED = { bg: '\x1b[48;2;22;58;34m', sign: '\x1b[38;2;95;215;120m' };
const REMOVED = { bg: '\x1b[48;2;72;28;32m', sign: '\x1b[38;2;240;110;120m' };

function band(gutter: string, line: string, c: typeof ADDED, width: number | undefined): string {
  const pad = width ? ' '.repeat(Math.max(0, width - stringWidth(gutter + line))) : '';
  return `${c.bg}${c.sign}${gutter}${line[0]}\x1b[39m${line.slice(1)}${pad}\x1b[0m`;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Line numbers for a unified diff, one column like Claude Code: the old number for removed lines, the new number for
 * added and context lines; '' for headers. All numbers share the width of the largest one.
 */
export function diffLineNumbers(lines: string[]): string[] {
  let max = 0;
  for (const l of lines) {
    const m = HUNK.exec(l);
    if (m) max = Math.max(max, Number(m[1]) + Number(m[2] ?? 1), Number(m[3]) + Number(m[4] ?? 1));
  }
  const w = String(max).length;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  return lines.map((l) => {
    const m = HUNK.exec(l);
    if (m) {
      [oldNo, newNo, inHunk] = [Number(m[1]), Number(m[3]), true];
      return '';
    }
    if (!inHunk || l.startsWith('\\')) return '';
    if (l.startsWith('-')) return String(oldNo++).padStart(w);
    if (l.startsWith('+')) return String(newNo++).padStart(w);
    oldNo++;
    return String(newNo++).padStart(w);
  });
}

/** Colors a unified diff with line numbers; with `width`, changed lines get a full-width background band. */
export function colorDiff(diff: string, width?: number): string {
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
  const lines = diff.split('\n');
  const numbers = diffLineNumbers(lines);
  return lines
    .map((raw, i) => {
      const l = raw.replace(/\t/g, '    ');
      const gutter = numbers[i] ? `${numbers[i]} ` : '';
      if (l.startsWith('@@')) return cyan(l);
      if (!gutter) return dim(l); // file headers ("--- a"), "\ No newline at end of file"
      if (l.startsWith('+')) return truecolor ? band(gutter, l, ADDED, width) : `${dim(gutter)}${green(l)}`;
      if (l.startsWith('-')) return truecolor ? band(gutter, l, REMOVED, width) : `${dim(gutter)}${red(l)}`;
      return dim(gutter + l);
    })
    .join('\n');
}

export function formatTokens(n: number): string {
  const short = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  if (n >= 1_000_000) return `${short(n / 1_000_000)}M`;
  return n >= 1000 ? `${short(n / 1000)}k` : String(n);
}

/** 850ms, 4.6s, 1m 05s */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** "⏱ 4.6s (first token 1.2s)" for the end of a turn. */
export function formatTiming(ev: { elapsedMs: number; firstOutputMs?: number }): string {
  return `⏱ ${formatDuration(ev.elapsedMs)}${ev.firstOutputMs !== undefined ? ` (first token ${formatDuration(ev.firstOutputMs)})` : ''}`;
}

export function formatUsage(u: Usage): string {
  return `${formatTokens(u.inputTokens)} in (${formatTokens(u.cacheReadTokens)} cached) · ${formatTokens(u.outputTokens)} out · $${u.cost.toFixed(4)}`;
}

/** Current git branch (short commit hash when detached), or undefined outside a repository. */
export function gitBranch(cwd: string): Promise<string | undefined> {
  const git = (args: string[]) =>
    new Promise<string | undefined>((resolve) =>
      execFile('git', args, { cwd, timeout: 2000 }, (err, out) => resolve(err ? undefined : out.trim() || undefined)),
    );
  return git(['symbolic-ref', '--short', '-q', 'HEAD']).then(async (branch) => {
    if (branch) return branch;
    const sha = await git(['rev-parse', '--short', 'HEAD']);
    return sha ? `@${sha}` : undefined;
  });
}

/** Path for display: home directory as "~". */
export function tildePath(path: string): string {
  const home = homedir();
  return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
}

/** Bell plus an OSC 9 desktop notification (iTerm2, Ghostty, WezTerm, kitty; others just beep or ignore it). */
export function notify(message: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\x1b]9;${message.replace(/[\x00-\x1f]/g, ' ')}\x07\x07`);
}

// "/auth <key>": the key must not be shown on screen or kept in the prompt history.
const AUTH_LINE = /^(\s*\/auth\s+)(\S+)/;

/** True for a "/auth <key>" line. */
export function hasSecret(text: string): boolean {
  return AUTH_LINE.test(text);
}

/** The prompt as drawn while typing: the key as dots, same length so the caret and selection stay in place. */
export function maskSecretInput(text: string): string {
  return text.replace(AUTH_LINE, (_, cmd: string, key: string) => cmd + '•'.repeat(key.length));
}

/** The line as recorded in the transcript or a queue: "/auth sk-…a1b2". */
export function redactSecret(text: string): string {
  return text.replace(AUTH_LINE, (_, cmd: string, key: string) => cmd + (key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`));
}
