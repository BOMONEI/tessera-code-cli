import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import stripAnsi from 'strip-ansi';

process.env.FORCE_COLOR = '3';
const { splitMouse, mouseInput, MOUSE_ON, MOUSE_OFF } = await import('../src/ui/tui/mouse.js');
const { buildTranscript, highlight, selectedColumns, selectedText } = await import('../src/ui/tui/viewport.js');
const { isExpandable } = await import('../src/ui/tui/components.js');
type HistoryItem = import('../src/ui/tui/components.js').HistoryItem;

describe('mouse input', () => {
  it('takes clicks, drags and the wheel out of the input and leaves keys alone', () => {
    const r = splitMouse('a\x1b[<0;5;10Mb\x1b[<32;7;10M\x1b[<0;7;10m\x1b[<64;1;1M\x1b[<65;1;1Mc\x1b[A');
    expect(r.rest).toBe('abc\x1b[A');
    expect(r.events).toEqual([
      { kind: 'press', x: 5, y: 10 },
      { kind: 'drag', x: 7, y: 10 },
      { kind: 'release', x: 7, y: 10 },
      { kind: 'wheel', dir: 'up', x: 1, y: 1 },
      { kind: 'wheel', dir: 'down', x: 1, y: 1 },
    ]);
    // Right and middle buttons and the sideways wheel are dropped; a sequence cut off at the end is kept for the next chunk.
    expect(splitMouse('\x1b[<2;1;1M\x1b[<1;1;1m\x1b[<66;1;1M\x1b[<67;1;1M').events).toEqual([]);
    expect(splitMouse('x\x1b[<0;12')).toEqual({ events: [], rest: 'x', carry: '\x1b[<0;12' });
    expect(splitMouse('x\x1b[')).toEqual({ events: [], rest: 'x', carry: '\x1b[' });
    expect(splitMouse('\x1b')).toEqual({ events: [], rest: '', carry: '\x1b' });
  });

  it('wraps stdin: Ink reads the keys, the app gets the mouse, and the editor gets the terminal back', async () => {
    const real = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => real, ref: () => real, unref: () => real }) as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    const out = { write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream;
    const m = mouseInput(real, out);
    const events: unknown[] = [];
    m.onEvent((e) => events.push(e));
    let read = '';
    m.stdin.on('data', (d) => (read += String(d)));
    (real as unknown as PassThrough).write('hi\x1b[<0;3;');
    (real as unknown as PassThrough).write('4M!');
    await new Promise((r) => setTimeout(r, 10));
    expect(read).toBe('hi!');
    expect(events).toEqual([{ kind: 'press', x: 3, y: 4 }]);
    // Split right after the ESC: still a click. A lone ESC (the esc key) goes through once nothing follows.
    (real as unknown as PassThrough).write('\x1b');
    (real as unknown as PassThrough).write('[<0;1;2m');
    (real as unknown as PassThrough).write('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    expect(events.at(-1)).toEqual({ kind: 'release', x: 1, y: 2 });
    expect(read).toBe('hi!\x1b');
    m.hold(true);
    expect(real.isPaused()).toBe(true);
    m.hold(false);
    expect(real.isPaused()).toBe(false);
    expect(written).toEqual([MOUSE_OFF, MOUSE_ON]);
  });
});

describe('transcript viewport', () => {
  it("shows a tool's output even when its running state was drawn first (cache key collision)", () => {
    const running = { id: 901, kind: 'tool', label: 'bash(echo hi)', fullLabel: 'bash(echo hi)', running: true, rev: 0 } as HistoryItem;
    const before = buildTranscript([running], { width: 60, showThinking: true, isExpanded: () => false });
    expect(stripAnsi(before.lines.join('\n'))).not.toContain('line-one'); // no result yet
    const done = { ...running, running: false, output: 'line-one\nline-two', rev: 1 } as HistoryItem;
    const after = buildTranscript([done], { width: 60, showThinking: true, isExpanded: () => false });
    expect(stripAnsi(after.lines.join('\n'))).toContain('line-one'); // not the cached pre-result drawing
  });

  const tool: HistoryItem = { id: 1, kind: 'tool', label: '$ seq 1 40', output: Array.from({ length: 40 }, (_, i) => String(i + 1)).join('\n'), lines: 12 };
  const items: HistoryItem[] = [{ id: 0, kind: 'info', text: 'hello' }, tool, { id: 2, kind: 'reasoning', text: 'step one\nstep two', ms: 2000 }];

  it('draws items to lines, knows which item each line is, and expands only the chosen ones', () => {
    const folded = buildTranscript(items, { width: 60, showThinking: true, isExpanded: () => false });
    const plain = folded.lines.map((l) => stripAnsi(l));
    expect(plain[0]).toBe('hello');
    expect(plain).toContain('    (click to expand)');
    expect(plain.some((l) => l.includes('∴ Thought for 2s (click to expand)'))).toBe(true);
    expect(folded.owner[plain.indexOf('● $ seq 1 40')]).toBe(1);
    const one = buildTranscript(items, { width: 60, showThinking: true, isExpanded: (i) => i.id === 1 });
    const onePlain = one.lines.map((l) => stripAnsi(l));
    expect(onePlain).toContain('● $ seq 1 40 (click to fold)');
    expect(onePlain).toContain('  ⎿ 40');
    expect(onePlain.some((l) => l.includes('step two'))).toBe(false); // the thinking stays folded
    expect(one.lines.length).toBeGreaterThan(folded.lines.length);
  });

  it('tells which items have more to show', () => {
    expect(isExpandable(tool)).toBe(true);
    expect(isExpandable({ ...tool, output: 'short' })).toBe(false);
    expect(isExpandable(items[0]!)).toBe(false);
    expect(isExpandable(items[2]!)).toBe(true);
  });

  it('selects across lines in either direction, inverts it on screen and copies plain text', () => {
    const lines = ['\x1b[36mfirst line\x1b[39m   ', 'second', '한글 third'];
    const sel = { anchor: { line: 2, col: 4 }, head: { line: 0, col: 6 } };
    expect(selectedColumns(sel, 0)).toEqual([6, Infinity]);
    expect(selectedColumns(sel, 1)).toEqual([0, Infinity]);
    expect(selectedColumns(sel, 2)).toEqual([0, 5]);
    expect(selectedColumns(sel, 3)).toBeUndefined();
    expect(selectedText(lines, sel)).toBe('line\nsecond\n한글');
    const h = highlight(lines[0]!, 6, Infinity);
    expect(stripAnsi(h)).toBe('first line   ');
    expect(h).toContain('\x1b[7mline   \x1b[27m');
  });
});
