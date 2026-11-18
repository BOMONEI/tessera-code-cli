import { createElement } from 'react';
import { renderToString } from 'ink';
import sliceAnsi from 'slice-ansi';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { markdown } from '../lazy-markdown.js';
import { HistoryView, type HistoryItem } from './components.js';

/**
 * The full-screen transcript: every history item drawn to lines once (cached), so the app can show any window of
 * them, map a clicked row back to its item, and select text across rows.
 *
 * renderToString must not run while React renders or commits (it shares Ink's reconciler and layout engine, and
 * crashed there): call buildTranscript from a timer or an event handler, never from a component or an effect body.
 */
export interface Transcript {
  lines: string[];
  /** The id of the item each line belongs to. */
  owner: number[];
}

export interface TranscriptOptions {
  width: number;
  showThinking: boolean;
  /** Whether an item is drawn expanded (ctrl+o for all, a click for one). */
  isExpanded: (item: HistoryItem) => boolean;
}

const cache = new Map<string, string[]>();
let cacheWidth = 0;

function itemLines(item: HistoryItem, opts: TranscriptOptions): string[] {
  if (opts.width !== cacheWidth) {
    cache.clear(); // a resize redraws everything at the new width
    cacheWidth = opts.width;
  }
  const expanded = opts.isExpanded(item);
  // Answers drawn before the markdown renderer loaded (raw text) are drawn again once it has.
  const key = `${item.id}:${expanded ? 1 : 0}:${opts.showThinking ? 1 : 0}:${markdown() ? 1 : 0}`;
  let lines = cache.get(key);
  if (!lines) {
    const text = renderToString(createElement(HistoryView, { item, width: opts.width, expanded, showThinking: opts.showThinking, clickable: true }), { columns: opts.width });
    lines = text === '' ? [] : text.split('\n');
    cache.set(key, lines);
  }
  return lines;
}

export function buildTranscript(items: readonly HistoryItem[], opts: TranscriptOptions): Transcript {
  // Drop drawings of items no longer shown (an earlier conversation before /resume or /clear).
  const ids = new Set(items.map((i) => String(i.id)));
  for (const key of cache.keys()) if (!ids.has(key.slice(0, key.indexOf(':')))) cache.delete(key);
  const lines: string[] = [];
  const owner: number[] = [];
  for (const item of items) {
    for (const line of itemLines(item, opts)) {
      lines.push(line);
      owner.push(item.id);
    }
  }
  return { lines, owner };
}

export interface Point {
  line: number;
  col: number;
}

/** A drag from `anchor` to `head` (either order), in transcript lines and screen columns. */
export interface Selection {
  anchor: Point;
  head: Point;
}

function ordered(s: Selection): [Point, Point] {
  const { anchor: a, head: b } = s;
  return a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
}

/** Columns [from, to) of `line` that the selection covers, or undefined when it misses the line. */
export function selectedColumns(s: Selection, line: number): [number, number] | undefined {
  const [start, end] = ordered(s);
  if (line < start.line || line > end.line) return undefined;
  return [line === start.line ? start.col : 0, line === end.line ? end.col + 1 : Infinity];
}

/** The line with the selected columns shown inverted (their colors dropped, so the selection reads clearly). */
export function highlight(line: string, from: number, to: number): string {
  const width = stringWidth(stripAnsi(line));
  const end = Math.min(to, width);
  if (from >= end) return line;
  return `${sliceAnsi(line, 0, from)}\x1b[0m\x1b[7m${stripAnsi(sliceAnsi(line, from, end))}\x1b[27m${sliceAnsi(line, end)}`;
}

/** The selected text, plain, with each line's trailing spaces removed. */
export function selectedText(lines: readonly string[], s: Selection): string {
  const [start, end] = ordered(s);
  const out: string[] = [];
  for (let i = start.line; i <= end.line && i < lines.length; i++) {
    const cols = selectedColumns(s, i)!;
    const plain = stripAnsi(lines[i] ?? '');
    out.push(sliceAnsi(plain, cols[0], cols[1] === Infinity ? undefined : cols[1]).replace(/\s+$/, ''));
  }
  return out.join('\n');
}
