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

/** The selected range [start, end) between the anchor and the caret, or undefined when nothing is selected. */
export function selectionRange(anchor: number | undefined, cursor: number): { start: number; end: number } | undefined {
  if (anchor === undefined || anchor === cursor) return undefined;
  return { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) };
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
  onHistory,
  focus,
  menuOpen,
  placeholder,
  realCursor,
  ghost,
  transformPaste,
  onImagePaste,
  onCopy,
  width,
  mask,
}: {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (v: string) => void;
  /** ↑ on the first line / ↓ on the last line: browse earlier prompts. */
  onHistory?: (direction: 'older' | 'newer') => string | undefined;
  focus: boolean;
  /** While a completion menu is open, Enter and arrows belong to the menu. */
  menuOpen?: boolean;
  placeholder?: string;
  /** The terminal's own cursor is placed at the caret (for IME composition), so no drawn cursor is needed. */
  realCursor?: boolean;
  /** Drawn instead of the value; must keep its length. */
  mask?: (value: string) => string;
  /** Suggested continuation shown dimmed after the caret (accepted by the parent with → or tab). */
  ghost?: string;
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
  const change = (v: string, c: number) => {
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
  if (sel) {
    // Selected text drawn inverted; the caret is the terminal's own (or the selection edge).
    let offset = 0;
    return (
      <Box flexDirection="column">
        {lines.map((l, i) => {
          const from = Math.max(0, sel.start - offset);
          const to = Math.min(l.length, sel.end - offset);
          // A selected line break shows as one inverted cell at the end of the line.
          const breakSelected = i < lines.length - 1 && sel.start <= offset + l.length && sel.end > offset + l.length;
          offset += l.length + 1;
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
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => {
        const f = folded(l, width);
        return focus && !realCursor && i === cursorLine ? (
          <Text key={i} wrap="hard">
            {f.text.slice(0, f.at(col))}
            <Text inverse>{l[col] ?? ghost?.[0] ?? ' '}</Text>
            {col < l.length ? f.text.slice(f.at(col) + 1) : ''}
            {ghost && col >= l.length ? <Text dimColor>{ghost.slice(1)}</Text> : null}
          </Text>
        ) : (
          <Text key={i} wrap="hard">
            {f.text || (ghost ? '' : ' ')}
            {ghost && focus && i === cursorLine ? <Text dimColor>{ghost}</Text> : null}
          </Text>
        );
      })}
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
