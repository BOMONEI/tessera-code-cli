import { PassThrough } from 'node:stream';

/**
 * Mouse input for the full-screen TUI. The terminal reports clicks, drags and the wheel as SGR sequences
 * ("\x1b[<b;x;yM", release with "m") on stdin. Ink would read them as typed text, so they are taken out of the input
 * before Ink sees it (see mouseStdin) and handed to the app as events.
 */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'; // buttons, drag motion, SGR coordinates
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export type MouseEvent =
  /** x, y: 1-based screen column and row. */
  | { kind: 'press' | 'drag' | 'release'; x: number; y: number }
  | { kind: 'wheel'; dir: 'up' | 'down'; x: number; y: number };

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// A sequence possibly cut off at the end of a chunk ("\x1b", "\x1b[", "\x1b[<0;5"); kept for the next one. A held
// "\x1b" may be the esc key itself, so mouseInput lets it through when nothing follows shortly.
// eslint-disable-next-line no-control-regex
const PARTIAL = /\x1b(?:\[(?:<[\d;]*)?)?$/;
/** How long a possibly cut-off sequence waits for the rest before it goes on as typed input. */
const CARRY_MS = 25;

/** Splits terminal input into mouse events and the rest (keys, pastes). `carry` is an unfinished sequence. */
export function splitMouse(data: string): { events: MouseEvent[]; rest: string; carry: string } {
  const events: MouseEvent[] = [];
  const partial = PARTIAL.exec(data);
  const carry = partial ? partial[0] : '';
  const text = partial ? data.slice(0, partial.index) : data;
  const rest = text.replace(SGR, (_, b: string, x: string, y: string, end: string) => {
    const code = Number(b);
    const at = { x: Number(x), y: Number(y) };
    // Low two bits: the button (0 = left); 32: motion while held; 64: the wheel. Middle and right buttons are ignored.
    if (code & 64) {
      if (!(code & 2)) events.push({ kind: 'wheel', dir: code & 1 ? 'down' : 'up', ...at }); // 66/67: sideways
    }
    else if ((code & 3) === 0) events.push({ kind: code & 32 ? 'drag' : end === 'm' ? 'release' : 'press', ...at });
    return '';
  });
  return { events, rest, carry };
}

export interface MouseInput {
  /** What Ink reads instead of process.stdin: the same input without the mouse sequences. */
  stdin: NodeJS.ReadStream;
  onEvent: (listener: ((e: MouseEvent) => void) | undefined) => void;
  /**
   * Hands the terminal to another program (the ctrl+g editor) and takes it back: mouse reporting off and stdin
   * paused, or the editor would get mouse sequences and this process would read its keys.
   */
  hold: (held: boolean) => void;
}

/** Wraps the real stdin: mouse sequences become events, everything else goes on to Ink unchanged. */
export function mouseInput(real: NodeJS.ReadStream, out: NodeJS.WriteStream): MouseInput {
  const stream = new PassThrough();
  let listener: ((e: MouseEvent) => void) | undefined;
  let carry = '';
  let flush: ReturnType<typeof setTimeout> | undefined;
  real.setEncoding('utf8');
  real.on('data', (chunk: string) => {
    clearTimeout(flush);
    const r = splitMouse(carry + chunk);
    carry = r.carry;
    for (const e of r.events) listener?.(e);
    if (r.rest) stream.write(r.rest);
    if (carry) {
      flush = setTimeout(() => {
        stream.write(carry);
        carry = '';
      }, CARRY_MS);
    }
  });
  // Ink treats it as the terminal: raw mode and ref/unref reach the real stdin.
  const stdin = Object.assign(stream, {
    isTTY: true,
    setRawMode: (on: boolean) => (real.setRawMode(on), stdin),
    ref: () => (real.ref(), stdin),
    unref: () => (real.unref(), stdin),
  }) as unknown as NodeJS.ReadStream;
  return {
    stdin,
    onEvent: (fn) => (listener = fn),
    hold: (held) => {
      out.write(held ? MOUSE_OFF : MOUSE_ON);
      if (held) real.pause();
      else real.resume();
    },
  };
}
