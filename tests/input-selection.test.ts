import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createElement, useState } from 'react';
import { render } from 'ink';
import { Input, selectionRange } from '../src/ui/tui/Input.js';

/** Renders Input with its own state; `keys` writes raw terminal input, `state` reads the current value. */
function harness(initial: string) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { columns: 80, rows: 20 });
  let current = { value: initial, cursor: initial.length };
  const copied: string[] = [];
  function Harness() {
    const [s, set] = useState(current);
    current = s;
    return createElement(Input, { value: s.value, cursor: s.cursor, focus: true, onChange: (value, cursor) => set({ value, cursor }), onSubmit: () => {}, onCopy: (t) => copied.push(t) });
  }
  const app = render(createElement(Harness), { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  const keys = async (...seq: string[]) => {
    for (const k of seq) {
      stdin.write(k);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return { keys, state: () => current, copied, done: () => app.unmount() };
}

const SHIFT_LEFT = '\x1b[1;2D';
const SHIFT_HOME = '\x1b[1;2H';

describe('input selection and ctrl+c', () => {
  it('selectionRange orders the ends', () => {
    expect(selectionRange(5, 2)).toEqual({ start: 2, end: 5 });
    expect(selectionRange(3, 3)).toBeUndefined();
    expect(selectionRange(undefined, 3)).toBeUndefined();
  });

  it('shift+arrows select; ctrl+c copies the selection and keeps the text', async () => {
    const h = harness('hello world');
    await h.keys(SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, '\x03');
    expect(h.copied).toEqual(['world']);
    expect(h.state().value).toBe('hello world');
    h.done();
  });

  it('typing replaces the selection, backspace deletes it', async () => {
    const h = harness('hello world');
    await h.keys(SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, 'there');
    expect(h.state().value).toBe('hello there');
    await h.keys(SHIFT_HOME, '\x7f');
    expect(h.state().value).toBe('');
    h.done();
  });

  it('cmd+c (kitty super+c) copies the selection and never clears the input', async () => {
    const h = harness('hello world');
    await h.keys(SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, '\x1b[99;9u');
    expect(h.copied).toEqual(['world']);
    await h.keys('\x1b[D', '\x1b[99;9u'); // nothing selected: no copy, text kept
    expect(h.copied).toEqual(['world']);
    expect(h.state().value).toBe('hello world');
    h.done();
  });

  it('ctrl+c without a selection clears the input', async () => {
    const h = harness('draft prompt');
    await h.keys('\x03');
    expect(h.state()).toEqual({ value: '', cursor: 0 });
    expect(h.copied).toEqual([]);
    h.done();
  });

  it('a plain arrow drops the selection', async () => {
    const h = harness('abc');
    await h.keys(SHIFT_LEFT, SHIFT_LEFT, '\x1b[D', 'X');
    expect(h.state().value).toBe('aXbc');
    h.done();
  });
});

describe('copy on select hint', async () => {
  const { copyOnSelect } = await import('../src/doctor.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  it('reads the VS Code setting', () => {
    const home = mkdtempSync(join(tmpdir(), 'tessera-vsc-'));
    expect(copyOnSelect({ TERM_PROGRAM: 'vscode' }, home).ok).toBe('warn');
    mkdirSync(join(home, 'Library', 'Application Support', 'Code', 'User'), { recursive: true });
    writeFileSync(join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), '{\n  "terminal.integrated.copyOnSelection": true\n}');
    expect(copyOnSelect({ TERM_PROGRAM: 'vscode' }, home).ok).toBe(true);
    expect(copyOnSelect({ TERM_PROGRAM: 'Apple_Terminal' }, home).ok).toBe('warn');
  });
});
