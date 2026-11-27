import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { Box, Text, useInput, usePaste } from 'ink';

/** Line/column of a string offset. */
function position(value: string, at: number): { line: number; col: number; lines: string[] } {
  const lines = value.split('\n');
  let rest = at;
  for (let line = 0; line < lines.length; line++) {
    if (rest <= lines[line]!.length) return { line, col: rest, lines };
    rest -= lines[line]!.length + 1;
  }
  return { line: lines.length - 1, col: lines.at(-1)!.length, lines };
}

function offsetOf(lines: string[], line: number, col: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) at += lines[i]!.length + 1;
  return at + Math.min(col, lines[line]!.length);
}

/**
 * String offsets in `line` where a new row starts when it is wrapped at `width` cells, with the same rule as
 * caretOf: a wide (CJK) character that does not fit moves to the next row whole. Ink's own hard wrap could leave
 * it straddling the edge, one cell past the input box's right border.
 */
export function wrapOffsets(line: string, width: number): number[] {
  const w = Math.max(1, width);
  const out: number[] = [];
  let x = 0;
  let i = 0;
  for (const ch of line) {
    const cw = stringWidth(ch);
    if (x + cw > w && x > 0) {
      out.push(i);
      x = 0;
    }
    x += cw;
    i += ch.length;
  }
  return out;
}

/** `line` with a newline at each wrap point, and the position in it of an offset into `line`. */
function folded(line: string, width: number | undefined): { text: string; at: (i: number) => number } {
  if (!width) return { text: line, at: (i) => i };
  const breaks = wrapOffsets(line, width);
  if (!breaks.length) return { text: line, at: (i) => i };
  let text = '';
  let prev = 0;
  for (const b of breaks) {
    text += line.slice(prev, b) + '\n';
    prev = b;
  }
  text += line.slice(prev);
  // A break at offset b sits just before the character at b, so it belongs to every slice that starts at b.
  return { text, at: (i) => i + breaks.filter((b) => b <= i).length };
}

/**
 * Which lines of a long input are drawn: at most `maxLines`, keeping the caret's line in view. Lines above and below
 * are summarized by one "N more lines" row each. A box taller than the terminal cannot be redrawn cleanly, so a long
 * input scrolls inside the box instead of growing past the screen.
 */
export function lineWindow(lineCount: number, cursorLine: number, maxLines: number | undefined): { start: number; end: number } {
  if (!maxLines || lineCount <= maxLines) return { start: 0, end: lineCount };
  const start = Math.min(Math.max(0, cursorLine - Math.floor(maxLines / 2)), lineCount - maxLines);
  return { start, end: start + maxLines };
}

/** Rows a line takes when wrapped at `width` (same rule as wrapOffsets and caretOf). */
function rowsOf(line: string, width: number): number {
  return wrapOffsets(line, width).length + 1;
}

/** Rows the input box's text takes on screen (window markers included). */
export function inputRows(value: string, cursor: number, width: number, maxLines?: number): number {
  const { line, lines } = position(value, cursor);
  const { start, end } = lineWindow(lines.length, line, maxLines);
  const shown = lines.slice(start, end).reduce((n, l) => n + rowsOf(l, width), 0);
  return shown + (start > 0 ? 1 : 0) + (end < lines.length ? 1 : 0);
}

/** caretOf for a windowed input: the caret's row among the rows actually drawn. */
export function visibleCaret(value: string, cursor: number, width: number, maxLines?: number): { x: number; row: number } {
  const caret = caretOf(value, cursor, width);
  const { line, lines } = position(value, cursor);
  const { start } = lineWindow(lines.length, line, maxLines);
  if (!start) return caret;
  const hidden = lines.slice(0, start).reduce((n, l) => n + rowsOf(l, Math.max(1, width)), 0);
  return { x: caret.x, row: caret.row - hidden + 1 }; // + the "more lines" row on top
}

/** The selected range [start, end) between the anchor and the caret, or undefined when nothing is selected. */
export function selectionRange(anchor: number | undefined, cursor: number): { start: number; end: number } | undefined {
  if (anchor === undefined || anchor === cursor) return undefined;
  return { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) };
}

/** A pasted run in the input: [start, end) in value offsets. It is colored and removed whole by one backspace. */
export type PasteChunk = { start: number; end: number };

/**
 * Moves the pasted runs for one edit (found as a common prefix/suffix diff): runs before it stay, runs after it
 * shift, a pure insertion right before a run keeps it (typing after a paste), and anything that reaches inside a
 * run leaves it as ordinary text. Also used for a value set from outside (history, an attached image, a command).
 */
export function adjustChunks(chunks: PasteChunk[], prev: string, next: string): PasteChunk[] {
  if (prev === next || !chunks.length) return chunks;
  const min = Math.min(prev.length, next.length);
  let p = 0;
  while (p < min && prev[p] === next[p]) p++;
  let s = 0;
  while (s < min - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const start = p;
  const prevEnd = prev.length - s;
  const nextEnd = next.length - s;
  const delta = nextEnd - prevEnd;
  const edited = prevEnd - start; // 0: a pure insertion
  const out: PasteChunk[] = [];
  for (const c of chunks) {
    if (c.end <= start) out.push(c);
    else if (c.start >= prevEnd) out.push({ start: c.start + delta, end: c.end + delta });
    else if (edited === 0 && c.start === start) out.push({ start: c.start + (nextEnd - start), end: c.end + (nextEnd - start) });
    // reaches inside the run: it is ordinary text from here
  }
  return out;
}

/**
 * What one backspace removes: the pasted run ending at the caret (whole, in one press), else the marker just
 * before it ("[Image #1]" / "[Pasted text #1 +42 lines]" with its trailing space), else undefined — one character.
 * The caret inside a run returns undefined: editing the paste turns it into ordinary text.
 */
export function backspaceTarget(chunks: PasteChunk[], value: string, at: number): { start: number; end: number } | undefined {
  if (at <= 0) return undefined;
  for (const c of chunks) {
    if (c.end === at && c.start < at) return c;
    if (at > c.start && at < c.end) return undefined;
  }
  const m = /\[(?:Image #\d+|Pasted text #\d+ \+\d+ lines)\] ?$/.exec(value.slice(0, at));
  return m ? { start: at - m[0].length, end: at } : undefined;
}

/**
 * Colored spans over [from, to): yellow for a collapsed long paste, magenta for images — short pastes are ordinary
 * text and draw in the default color. A marker keeps
 * its own color where it sits inside a run (the run's span is cut around it); the result is sorted and disjoint.
 */
export function pasteSpans(value: string, chunks: PasteChunk[], from: number, to: number): Array<{ start: number; end: number; color: string }> {
  const spans: Array<{ start: number; end: number; color: string }> = [];
  for (const c of chunks) {
    const start = Math.max(c.start, from);
    const end = Math.min(c.end, to);
    // A run is only ever a rewritten paste (a long one or a dropped image path): both carry a marker, drawn below.
    if (start < end) spans.push({ start, end, color: 'yellow' });
  }
  const markers: Array<{ start: number; end: number; color: string }> = [];
  for (const m of value.matchAll(/\[(?:Image #\d+|Pasted text #\d+ \+\d+ lines)\]/g)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (end <= from || start >= to) continue;
    markers.push({ start: Math.max(start, from), end: Math.min(end, to), color: m[0].startsWith('[Image') ? 'magenta' : 'yellow' });
  }
  if (!markers.length) return spans.sort((a, b) => a.start - b.start);
  const cut: Array<{ start: number; end: number; color: string }> = [];
  for (const sp of spans) {
    let pos = sp.start;
    for (const mk of markers.filter((m) => m.start < sp.end && m.end > sp.start).sort((a, b) => a.start - b.start)) {
      if (pos < mk.start) cut.push({ start: pos, end: mk.start, color: sp.color });
      pos = Math.max(pos, mk.end);
    }
    if (pos < sp.end) cut.push({ start: pos, end: sp.end, color: sp.color });
  }
  return [...cut, ...markers].sort((a, b) => a.start - b.start);
}

/**
 * Controlled multi-line input. Shift+arrows / shift+home/end select text (typing or backspace replaces it, ctrl+c
 * copies it); ctrl+c without a selection clears the input. Enter submits; shift+enter (kitty-protocol terminals), option/alt+enter or a
 * trailing "\" inserts a newline; pasted text keeps its newlines. Ctrl/meta shortcuts never leak characters.
 */
export function Input({
  value,
  cursor,
  onChange,
  onSubmit,
  onImmediate,
  onHistory,
  focus,
  menuOpen,
  placeholder,
  realCursor,
  transformPaste,
  onImagePaste,
  onCopy,
  width,
  mask,
  maxLines,
}: {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (v: string) => void;
  /** ctrl+enter: cut in immediately while the agent works (the app submits what is typed and cancels the running step). */
  onImmediate?: () => void;
  /** ↑ on the first line / ↓ on the last line: browse earlier prompts. */
  onHistory?: (direction: 'older' | 'newer') => string | undefined;
  focus: boolean;
  /** While a completion menu is open, Enter and arrows belong to the menu. */
  menuOpen?: boolean;
  placeholder?: string;
  /** The terminal's own cursor is placed at the caret (for IME composition), so no drawn cursor is needed. */
  realCursor?: boolean;
  /** At most this many lines are drawn (around the caret); see lineWindow. */
  maxLines?: number;
  /** Drawn instead of the value; must keep its length. */
  mask?: (value: string) => string;
  /** Rewrites pasted text before it is inserted (e.g. dropped image paths become "[Image #1]"). */
  transformPaste?: (text: string) => string;
  /** ctrl+v arrived inside a burst of keys (the parent handles a lone ctrl+v itself). */
  onImagePaste?: () => void;
  /** ctrl+c with text selected: copy it. */
  onCopy?: (text: string) => void;
  /** Text columns available; lines are wrapped here so wide characters never cross the right border. */
  width?: number;
}) {
  // Several key/paste events can arrive before React re-renders; each must build on the previous one's result,
  // not on the last rendered props, or keystrokes get lost.
  const latest = useRef({ value, cursor });
  latest.current = { value, cursor };
  // Selection anchor (the other end is the caret). Any change of the text drops it.
  const [anchor, setAnchorState] = useState<number | undefined>(undefined);
  const anchorRef = useRef<number | undefined>(undefined);
  const setAnchor = (a: number | undefined) => {
    anchorRef.current = a;
    setAnchorState(a);
  };
  const selectedValue = useRef(value);
  useEffect(() => {
    if (anchorRef.current !== undefined && value !== selectedValue.current) setAnchor(undefined);
  }, [value]);
  // Pasted runs: only rewritten pastes (a long one or a dropped image path) — drawn yellow / magenta, removed whole by one backspace. The last value seen keeps the
  // bookkeeping aligned — change() moves the runs for its own edit, this effect for a value set from outside.
  const chunksRef = useRef<PasteChunk[]>([]);
  const prevValue = useRef(value);
  useEffect(() => {
    if (value !== prevValue.current) {
      chunksRef.current = adjustChunks(chunksRef.current, prevValue.current, value);
      prevValue.current = value;
    }
  });
  const change = (v: string, c: number) => {
    chunksRef.current = adjustChunks(chunksRef.current, prevValue.current, v);
    prevValue.current = v;
    latest.current = { value: v, cursor: c };
    if (anchorRef.current !== undefined) setAnchor(undefined);
    onChange(v, c);
  };
  /** Moves the caret; with shift held it extends the selection instead of dropping it. */
  const move = (to: number, extend: boolean) => {
    const { value, cursor } = latest.current;
    if (extend) {
      if (anchorRef.current === undefined) setAnchor(cursor);
      selectedValue.current = value;
    } else if (anchorRef.current !== undefined) setAnchor(undefined);
    latest.current = { value, cursor: to };
    onChange(value, to);
  };
  /** The text with the selection removed (caret at its start), or as is when nothing is selected. */
  const withoutSelection = (): { value: string; at: number } => {
    const { value, cursor } = latest.current;
    const sel = selectionRange(anchorRef.current, cursor);
    const at = Math.min(Math.max(cursor, 0), value.length);
    return sel ? { value: value.slice(0, sel.start) + value.slice(sel.end), at: sel.start } : { value, at };
  };

  usePaste(
    (text) => {
      const { value, at } = withoutSelection();
      const clean = (transformPaste?.(text) ?? text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
      // A short paste stays exactly what typing makes: plain text, no run, no color, removed a character at a time.
      // transformPaste only rewrites long pastes (the placeholder) and dropped image paths — those are runs.
      if (transformPaste && clean !== text) {
        change(value.slice(0, at) + clean + value.slice(at), at + clean.length);
        chunksRef.current = [...chunksRef.current, { start: at, end: at + clean.length }].sort((a, b) => a.start - b.start);
        return;
      }
      change(value.slice(0, at) + clean + value.slice(at), at + clean.length);
    },
    { isActive: focus },
  );

  useInput(
    (input, key) => {
      const sel = selectionRange(anchorRef.current, latest.current.cursor);
      // cmd+c (super, reported by kitty-protocol terminals; VS Code needs a keybinding, see README) only copies.
      if (key.super && input === 'c') {
        if (sel) onCopy?.(latest.current.value.slice(sel.start, sel.end));
        return;
      }
      if (key.ctrl && input === 'c') {
        if (sel) {
          onCopy?.(latest.current.value.slice(sel.start, sel.end));
          setAnchor(undefined);
        } else if (latest.current.value) change('', 0);
        return; // empty input: the parent interrupts the turn or exits
      }
      const caret = Math.min(Math.max(latest.current.cursor, 0), latest.current.value.length);
      const pos0 = position(latest.current.value, caret);
      const shift = key.shift;
      if (shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end)) {
        const len = latest.current.value.length;
        if (key.leftArrow) return move(Math.max(0, caret - 1), true);
        if (key.rightArrow) return move(Math.min(len, caret + 1), true);
        if (key.home) return move(caret - pos0.col, true);
        if (key.end) return move(caret - pos0.col + pos0.lines[pos0.line]!.length, true);
        const target = pos0.line + (key.upArrow ? -1 : 1);
        if (target < 0) return move(0, true);
        if (target >= pos0.lines.length) return move(len, true);
        return move(offsetOf(pos0.lines, target, pos0.col), true);
      }
      // Typing or deleting with a selection replaces it; plain arrows collapse it to the side they point to.
      if (sel && (key.leftArrow || key.rightArrow)) return move(key.leftArrow ? sel.start : sel.end, false);
      if (sel && (key.backspace || key.delete)) {
        const r = withoutSelection();
        return change(r.value, r.at);
      }
      const typing = Boolean(input) && !key.ctrl && !key.meta && !key.super && !key.escape && !key.tab && !key.return;
      const base = sel && typing ? withoutSelection() : { value: latest.current.value, at: caret };
      if (sel && !typing && !key.return && (key.upArrow || key.downArrow || key.home || key.end || key.ctrl)) setAnchor(undefined);
      const { value, at } = base;
      const insert = (text: string) => change(value.slice(0, at) + text + value.slice(at), at + text.length);
      const pos = position(value, at);
      if (key.return) {
        if (key.ctrl) {
          if (!menuOpen) onImmediate?.();
          return;
        }
        if (key.shift || key.meta) return insert('\n');
        if (value[at - 1] === '\\') return change(value.slice(0, at - 1) + '\n' + value.slice(at), at);
        if (!menuOpen) {
          latest.current = { value: '', cursor: 0 };
          onSubmit(value);
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (menuOpen) return;
        const target = pos.line + (key.upArrow ? -1 : 1);
        if (target < 0 || target >= pos.lines.length) {
          const next = onHistory?.(target < 0 ? 'older' : 'newer');
          if (next !== undefined) latest.current = { value: next, cursor: next.length };
          return;
        }
        return move(offsetOf(pos.lines, target, pos.col), false);
      }
      if (key.leftArrow) return move(Math.max(0, at - 1), false);
      if (key.rightArrow) return move(Math.min(value.length, at + 1), false);
      if (key.home || (key.ctrl && input === 'a')) return move(at - pos.col, false);
      if (key.end || (key.ctrl && input === 'e')) return move(at - pos.col + pos.lines[pos.line]!.length, false);
      if (key.backspace || key.delete) {
        // A pasted run (or the marker before the caret) goes in one press; inside a run it is a normal character.
        if (key.backspace) {
          const target = backspaceTarget(chunksRef.current, value, at);
          if (target) return change(value.slice(0, target.start) + value.slice(target.end), target.start);
        }
        if (at > 0) change(value.slice(0, at - 1) + value.slice(at), at - 1);
        return;
      }
      if (key.ctrl && input === 'u') return change(value.slice(0, at - pos.col) + value.slice(at), at - pos.col);
      if (key.ctrl && input === 'k') {
        const end = at - pos.col + pos.lines[pos.line]!.length;
        return change(value.slice(0, at) + value.slice(end === at ? at + 1 : end), at);
      }
      if (key.ctrl && input === 'w') {
        const start = value.slice(0, at).replace(/\S+\s*$|\s+$/, '').length;
        return change(value.slice(0, start) + value.slice(at), start);
      }
      if (key.ctrl || key.meta || key.super || key.escape || key.tab) return;
      if (!input) return;
      // Several keys in one read (fast typing, or an IME committing a syllable together with Enter). Pastes arrive
      // through usePaste (bracketed paste), so a carriage return here is an Enter key: "\⏎" adds a newline,
      // otherwise it submits and typing continues in the emptied input.
      // Terminals without bracketed paste deliver drops/pastes as one burst of keys. Control characters inside a
      // burst are keys, not text: ctrl+v is forwarded, the rest dropped.
      if (input.includes('\x16')) onImagePaste?.();
      const keys = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      if (!keys) return;
      const asPaste = keys.length > 1 && !/\r/.test(keys) && Boolean(transformPaste);
      const burst = keys.length > 1 && !/\r/.test(keys) && transformPaste ? transformPaste(keys) : keys;
      const segments = burst.replace(/\r\n?/g, '\r').replace(/\t/g, '  ').split('\r');
      let before = value.slice(0, at);
      let after = value.slice(at);
      let submitted = false;
      for (const segment of segments.slice(0, -1)) {
        before += segment;
        if (before.endsWith('\\')) before = before.slice(0, -1) + '\n';
        else if (!menuOpen) {
          latest.current = { value: '', cursor: 0 };
          onSubmit(before + after);
          before = after = '';
          submitted = true;
        }
      }
      before += segments.at(-1)!;
      if (submitted && !before && !after) return;
      change(before + after, before.length);
      // One burst of keys without bracketed paste (dropped files, a long paste → placeholder) is a run too — but a
      // burst transformPaste left alone was fast typing, not a paste.
      if (asPaste && !submitted && !sel && burst !== keys && before.length > at) {
        chunksRef.current = [...chunksRef.current, { start: at, end: before.length }].sort((a, b) => a.start - b.start);
      }
    },
    { isActive: focus },
  );

  const at = Math.min(Math.max(cursor, 0), value.length);
  if (!value) {
    return focus && !realCursor ? (
      <Text wrap="truncate">
        <Text inverse>{placeholder?.[0] ?? ' '}</Text>
        <Text dimColor>{placeholder?.slice(1)}</Text>
      </Text>
    ) : (
      <Text dimColor wrap="truncate">
        {placeholder}
      </Text>
    );
  }
  // A mask keeps the length (the caret and selection index the real value), e.g. a typed API key drawn as dots.
  const { line: cursorLine, col, lines } = position(mask ? mask(value) : value, at);
  const sel = focus ? selectionRange(anchor, at) : undefined;
  const win = lineWindow(lines.length, cursorLine, maxLines);
  const above = win.start > 0 ? <Text dimColor>{`↑ ${win.start} more line${win.start === 1 ? '' : 's'}`}</Text> : null;
  const below = win.end < lines.length ? <Text dimColor>{`↓ ${lines.length - win.end} more line${lines.length - win.end === 1 ? '' : 's'}`}</Text> : null;
  const shown = (i: number) => i >= win.start && i < win.end;
  if (sel) {
    // Selected text drawn inverted; the caret is the terminal's own (or the selection edge).
    let offset = 0;
    return (
      <Box flexDirection="column">
        {above}
        {lines.map((l, i) => {
          const from = Math.max(0, sel.start - offset);
          const to = Math.min(l.length, sel.end - offset);
          // A selected line break shows as one inverted cell at the end of the line.
          const breakSelected = i < lines.length - 1 && sel.start <= offset + l.length && sel.end > offset + l.length;
          offset += l.length + 1;
          if (!shown(i)) return null;
          const f = folded(l, width);
          return (
            <Text key={i} wrap="hard">
              {from < to ? (
                <>
                  {f.text.slice(0, f.at(from))}
                  <Text inverse>{f.text.slice(f.at(from), f.at(to))}</Text>
                  {f.text.slice(f.at(to))}
                </>
              ) : (
                f.text
              )}
              {breakSelected ? <Text inverse> </Text> : !l ? ' ' : null}
            </Text>
          );
        })}
        {below}
      </Box>
    );
  }
  // Global offsets of each line, so runs and markers are found in the value's own coordinates.
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStarts.push(acc);
    acc += l.length + 1;
  }
  // mask is always passed (it is the identity on every line but a secret one): hide the paste colors only when it
  // actually rewrote the text — otherwise a masked line would draw pasted dots in color.
  const maskHidesPaste = mask ? mask(value) !== value : false;
  return (
    <Box flexDirection="column">
      {above}
      {lines.map((l, i) => {
        if (!shown(i)) return null;
        const f = folded(l, width);
        const spans = maskHidesPaste ? [] : pasteSpans(value, chunksRef.current, lineStarts[i]!, lineStarts[i]! + l.length);
        const cursorOn = focus && !realCursor && i === cursorLine;
        if (!spans.length) {
          // No paste on this line: exactly the drawing as before (caret inverse, plain text otherwise).
          return cursorOn ? (
            <Text key={i} wrap="hard">
              {f.text.slice(0, f.at(col))}
              <Text inverse>{l[col] ?? ' '}</Text>
              {col < l.length ? f.text.slice(f.at(col) + 1) : ''}
            </Text>
          ) : (
            <Text key={i} wrap="hard">
              {f.text || ' '}
            </Text>
          );
        }
        // A pasted run or marker sits on this line: draw it in colored pieces, split around the caret.
        const base = lineStarts[i]!;
        const edges = new Set<number>([0, l.length]);
        for (const sp of spans) {
          edges.add(sp.start - base);
          edges.add(sp.end - base);
        }
        if (cursorOn) edges.add(col);
        const xs = [...edges].filter((x) => x >= 0 && x <= l.length).sort((a, b) => a - b);
        const colorOf = (a: number, b: number) => spans.find((sp) => a >= sp.start - base && b <= sp.end - base)?.color;
        return (
          <Text key={i} wrap="hard">
            {xs.slice(0, -1).flatMap((a, k) => {
              const b = xs[k + 1]!;
              if (b <= a) return [];
              if (cursorOn && a <= col && col < b) {
                return [
                  a < col ? (
                    <Text key={`h${k}`} color={colorOf(a, col)}>
                      {f.text.slice(f.at(a), f.at(col))}
                    </Text>
                  ) : null,
                  <Text key={`c${k}`} inverse>
                    {l[col] ?? ' '}
                  </Text>,
                  col + 1 < b ? (
                    <Text key={`t${k}`} color={colorOf(col + 1, b)}>
                      {f.text.slice(f.at(col + 1), f.at(b))}
                    </Text>
                  ) : null,
                ];
              }
              return [
                <Text key={k} color={colorOf(a, b)}>
                  {f.text.slice(f.at(a), f.at(b))}
                </Text>,
              ];
            })}
            {cursorOn && col >= l.length ? <Text inverse> </Text> : null}
          </Text>
        );
      })}
      {below}
    </Box>
  );
}

/**
 * Where the caret is drawn, in cells relative to the input's top-left, given hard wrapping at `width` columns.
 * Wide (CJK) characters take two cells and never straddle a line break.
 */
export function caretOf(value: string, cursor: number, width: number): { x: number; row: number } {
  const w = Math.max(1, width);
  const lines = value.slice(0, cursor).split('\n');
  let row = 0;
  let x = 0;
  lines.forEach((line, i) => {
    x = 0;
    for (const ch of line) {
      const cw = stringWidth(ch);
      if (x + cw > w) {
        row++;
        x = 0;
      }
      x += cw;
    }
    if (i < lines.length - 1) row++;
  });
  if (x >= w) {
    row++;
    x = 0;
  }
  return { x, row };
}
