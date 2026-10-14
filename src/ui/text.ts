import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

// Light text helpers used on every render; kept apart from the markdown renderer, which loads after the first frame.

/**
 * Last lines of streaming text that fit in `rows` once wrapped at `width`. Ink can only erase what is still on
 * screen: a live area taller than the terminal scrolls its top into the scrollback, where it stays when the final
 * rendered message is printed (the raw text then appears twice).
 */
export function streamTail(text: string, width: number, rows: number): { text: string; hidden: number } {
  const lines = wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split('\n');
  const keep = Math.max(1, rows);
  if (lines.length <= keep) return { text, hidden: 0 };
  return { text: lines.slice(-keep).join('\n'), hidden: lines.length - keep };
}

/** Drops leading blank lines and trailing whitespace, keeping the indentation that is part of the markdown. */
export function trimBlock(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

/** Terminal rows `text` occupies when wrapped at `columns`. */
export function visualRows(text: string, columns: number): number {
  const width = Math.max(1, columns);
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(stringWidth(line) / width)), 0);
}
