import { Marked, type Tokens } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import { supportsLanguage } from 'cli-highlight';

const MIN_COL = 6;


function terminalWidth(): number {
  return Math.max(40, (process.stdout.columns || 80) - 1);
}

function createMarked(width: () => number): Marked {
  const marked = new Marked();
  // marked-terminal's typings lag behind marked's extension type.
  marked.use(markedTerminal({ reflowText: false, tab: 2 }) as Parameters<typeof marked.use>[0]);
  // marked-terminal's cli-table3 tables never shrink: long cells make rows wider than the terminal, which then
  // hard-wraps every border line. Render tables ourselves, fitted to the width, wrapping text inside cells.
  // marked-terminal prints a list item's text without rendering its inline markup (`code`, **bold**, links show
  // as raw symbols) and glues a code block to the line before it. Render nested inline tokens, and start code
  // blocks inside list items on their own line.
  marked.use({
    walkTokens(token) {
      // highlight.js logs "Could not find the language 'mermaid'…" through console.error for every block in a
      // language it does not know, and a streaming block is rendered again on every update, so the warning
      // flooded the screen. Unknown languages are shown as plain text instead.
      if (token.type === 'code') {
        const code = token as Tokens.Code;
        const lang = code.lang?.trim().split(/\s+/)[0];
        if (lang && !supportsLanguage(lang)) code.lang = 'plaintext';
        return;
      }
      if (token.type !== 'list_item') return;
      const tokens = (token as Tokens.ListItem).tokens;
      for (let i = tokens.length - 1; i > 0; i--) {
        if (tokens[i]!.type === 'code' && tokens[i - 1]!.type !== 'space') tokens.splice(i, 0, { type: 'text', raw: '', text: '\n' } as Tokens.Text);
      }
    },
    renderer: {
      text(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Text | Tokens.Escape) {
        return 'tokens' in token && token.tokens?.length ? this.parser.parseInline(token.tokens) : token.text;
      },
    },
  });
  marked.use({
    renderer: {
      table(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Table) {
        // marked-terminal hides ":" behind a placeholder until its own post-processing, which this renderer skips;
        // models also use <br> for line breaks inside cells.
        const inline = (c: Tokens.TableCell) =>
          this.parser
            .parseInline(c.tokens)
            .replace(/\*#COLON\|\*/g, ':')
            .replace(/<br\s*\/?>/gi, '\n');
        const header = token.header.map(inline);
        const rows = token.rows.map((r) => r.map(inline));
        return renderTable(header, rows, token.align, width()) + '\n\n';
      },
    },
  });
  return marked;
}

const marked = createMarked(terminalWidth);

/** Column widths that fit `total`: natural widths when they fit, otherwise shrink the widest columns first. */
export function fitColumns(natural: number[], minWidths: number[], total: number): number[] {
  const widths = [...natural];
  let excess = widths.reduce((a, b) => a + b, 0) + 3 * widths.length + 1 - total; // "│ " + " │ " ... + " │"
  while (excess > 0) {
    let i = -1;
    for (let j = 0; j < widths.length; j++) if (widths[j]! > (minWidths[j] ?? 1) && (i < 0 || widths[j]! > widths[i]!)) i = j;
    if (i < 0) break; // every column is at its minimum; let it overflow rather than become unreadable
    widths[i]!--;
    excess--;
  }
  return widths;
}

function pad(text: string, width: number, align: 'left' | 'right' | 'center' | null): string {
  const space = Math.max(0, width - stringWidth(text));
  if (align === 'right') return ' '.repeat(space) + text;
  if (align === 'center') return ' '.repeat(Math.floor(space / 2)) + text + ' '.repeat(Math.ceil(space / 2));
  return text + ' '.repeat(space);
}

/** Box table with CJK-aware widths and wrapped cells; every line is at most `total` columns wide. */
export function renderTable(header: string[], rows: string[][], align: Array<'left' | 'right' | 'center' | null>, total: number): string {
  const cols = header.length;
  const all = [header, ...rows].map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  const natural = Array.from({ length: cols }, (_, i) => Math.max(1, ...all.map((r) => Math.max(...r[i]!.split('\n').map((l) => stringWidth(l))))));
  // Never squeeze a column below MIN_COL or its header (unless its content is narrower anyway).
  const minWidths = Array.from({ length: cols }, (_, i) => Math.min(natural[i]!, Math.max(MIN_COL, stringWidth(header[i]!))));
  const widths = fitColumns(natural, minWidths, total);
  const line = (l: string, m: string, r: string) => chalk.gray(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const renderRow = (cells: string[], style: (s: string) => string) => {
    const wrapped = cells.map((c, i) => wrapAnsi(c, widths[i]!, { hard: true, trim: true }).split('\n'));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let k = 0; k < height; k++) {
      out.push(
        chalk.gray('│ ') +
          wrapped.map((w, i) => style(pad(w[k] ?? '', widths[i]!, align[i] ?? null))).join(chalk.gray(' │ ')) +
          chalk.gray(' │'),
      );
    }
    return out;
  };
  const out = [line('┌', '┬', '┐'), ...renderRow(all[0]!, (s) => chalk.bold(s)), line('├', '┼', '┤')];
  all.slice(1).forEach((r, i) => {
    if (i > 0) out.push(line('├', '┼', '┤'));
    out.push(...renderRow(r, (s) => s));
  });
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

// Renderers per width: building one (marked-terminal + highlighter setup) costs far more than a render, and
// streaming renders the growing block every 50ms.
const byWidth = new Map<number, Marked>();

export function renderMarkdown(text: string, width?: number): string {
  try {
    let m = marked;
    if (width) {
      const w = Math.max(20, width);
      let hit = byWidth.get(w);
      if (!hit) {
        hit = createMarked(() => w);
        byWidth.set(w, hit);
        if (byWidth.size > 4) byWidth.delete(byWidth.keys().next().value!); // drag-resizing visits many widths
      }
      m = hit;
    }
    return (m.parse(text, { async: false }) as string).replace(/\n+$/, '');
  } catch {
    return text;
  }
}


const lexer = new Marked();

/**
 * Length of the leading part of streaming markdown made of finished blocks: every block but the last one, which
 * may still grow (an open code fence, a table gaining rows, a paragraph mid-sentence). Finished blocks can be
 * rendered once and printed for good while the rest keeps streaming.
 */
export function stablePrefixLength(text: string): number {
  // Ignore the line still being written: a partial line can look like a block start ("#", "***", "1.") and make
  // the paragraph before it seem finished.
  text = text.slice(0, text.lastIndexOf('\n') + 1);
  let tokens;
  try {
    tokens = lexer.lexer(text);
  } catch {
    return 0;
  }
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.type === 'space') last--;
  if (last <= 0) return 0;
  const prefix = tokens
    .slice(0, last)
    .map((t) => t.raw)
    .join('');
  // Reference-style link definitions are dropped from the token list; only cut where raw text lines up exactly.
  return text.startsWith(prefix) ? prefix.length : 0;
}

/**
 * Renders the block still being streamed. A table is only recognizable once its delimiter row ("|---|") is
 * complete; until then its header would flash as raw pipes, so a trailing pipe-row paragraph is held back.
 */
export function renderStreaming(text: string, width: number): string {
  let tokens;
  try {
    tokens = lexer.lexer(text);
  } catch {
    return renderMarkdown(text, width);
  }
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.type === 'space') last--;
  const tail = tokens[last];
  if (tail?.type === 'paragraph' && tail.raw.trimStart().startsWith('|')) {
    const idx = text.lastIndexOf(tail.raw);
    text = idx >= 0 ? text.slice(0, idx) : text;
  }
  return text.trim() ? renderMarkdown(text, width) : '';
}

export { streamTail, trimBlock, visualRows } from './text.js';
