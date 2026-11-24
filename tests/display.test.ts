import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import type { HistoryItem } from '../src/ui/tui/components.js';

// Ink picks its color level when loaded; force colors so backgrounds show up in the captured output.
process.env.FORCE_COLOR = '3';
const { render } = await import('ink');
const { HistoryView } = await import('../src/ui/tui/components.js');
const { colorDiff, diffLineNumbers, formatClock, formatTiming, outputText } = await import('../src/ui/format.js');
const { transcriptOf } = await import('../src/ui/transcript.js');

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Renders one history item to text (ANSI kept) at the given width. */
async function draw(item: HistoryItem, expanded: boolean, columns = 60): Promise<string> {
  const out = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
  Object.assign(out, { columns, rows: 40, isTTY: false });
  let text = '';
  out.on('data', (d: Buffer) => (text += d.toString()));
  const app = render(createElement(HistoryView, { item, width: columns, expanded }), { stdout: out, debug: true, patchConsole: false });
  await new Promise((r) => setTimeout(r, 20));
  app.unmount();
  return text;
}

describe('colorDiff', () => {
  it('pads changed lines to the width so the background forms a band', () => {
    const prev = process.env.COLORTERM;
    process.env.COLORTERM = 'truecolor';
    try {
      const raw = colorDiff('@@ -1 +1 @@\n-old\n+새 줄\n same', 20);
      const lines = strip(raw).split('\n');
      expect(lines[0]).toBe('@@ -1 +1 @@'.padEnd(20)); // the hunk and context lines sit on the shaded panel too
      expect(lines[1]).toBe('1 -old'.padEnd(20));
      expect(lines[2]).toBe('1 +새 줄' + ' '.repeat(12)); // 8 columns: Korean syllables count two
      expect(lines[3]).toBe('2  same'.padEnd(20));
      expect(raw).toContain('\x1b[48;2;28;80;44m'); // added: green band
      expect(raw).toContain('\x1b[48;2;98;34;42m'); // removed: red band
      expect(raw).toContain('\x1b[48;2;40;42;48m'); // context: panel
    } finally {
      if (prev === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = prev;
    }
  });

  it('treats ---/+++ file headers as headers, not changes', () => {
    expect(strip(colorDiff('--- a\n+++ a', 20))).toBe('--- a\n+++ a');
  });

  it('numbers removed lines by the old file and the rest by the new file, per hunk', () => {
    const diff = ['--- a', '+++ a', '@@ -8,4 +8,5 @@', ' ctx', '-gone', '+one', '+two', ' ctx', '\\ No newline at end of file', '@@ -98,2 +99,2 @@', '-x', '+y', ' z'];
    expect(diffLineNumbers(diff)).toEqual(['', '', '', '  8', '  9', '  9', ' 10', ' 11', '', '', ' 98', ' 99', '100']);
    // A removed line that looks like a file header is still a change inside a hunk.
    expect(diffLineNumbers(['@@ -1 +1 @@', '--- x', '+y'])).toEqual(['', '1', '1']);
  });
});

describe('folded and expanded history', () => {
  const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const tool: HistoryItem = { id: 1, kind: 'tool', label: 'read(a.ts)', output };

  it('folds tool output to a preview with a ctrl+o hint', async () => {
    const text = strip(await draw(tool, false));
    expect(text).toContain('line 4');
    expect(text).not.toContain('line 5');
    expect(text).toContain('+6 lines');
    expect(text).toContain('ctrl+o to expand');
  });

  it('shows the whole output when expanded', async () => {
    const text = strip(await draw(tool, true));
    expect(text).toContain('line 10');
    expect(text).not.toContain('ctrl+o');
  });

  it('folds thinking to one line', async () => {
    const item: HistoryItem = { id: 2, kind: 'reasoning', text: 'secret plan\nstep two', ms: 2400 };
    expect(strip(await draw(item, false))).toContain('Thought for 2s');
    expect(strip(await draw(item, false))).not.toContain('secret plan');
    expect(strip(await draw(item, true))).toContain('step two');
  });

  it('hides thinking when turned off, unless expanded', async () => {
    const item: HistoryItem = { id: 4, kind: 'reasoning', text: 'secret plan', ms: 1000 };
    const draw2 = async (expanded: boolean) => {
      const out = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
      Object.assign(out, { columns: 60, rows: 40 });
      let text = '';
      out.on('data', (d: Buffer) => (text += d.toString()));
      const app = render(createElement(HistoryView, { item, width: 60, expanded, showThinking: false }), { stdout: out, debug: true, patchConsole: false });
      await new Promise((r) => setTimeout(r, 20));
      app.unmount();
      return strip(text);
    };
    expect(await draw2(false)).not.toContain('Thought');
    expect(await draw2(true)).toContain('secret plan');
  });

  it('draws user prompts on a gray background', async () => {
    const raw = await draw({ id: 3, kind: 'user', text: '안녕' }, false);
    expect(raw).toMatch(/\x1b\[48;2;58;61;66m/);
    expect(strip(raw)).toContain('› 안녕');
  });
});

describe('transcript', () => {
  it('keeps the full tool output for the expanded view', () => {
    const t = transcriptOf([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'a' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'text', value: 'a\nb\nc' } }] },
    ]);
    expect(t[1]).toMatchObject({ kind: 'tool', output: 'a\nb\nc', lines: 2 });
    expect(outputText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('UsageBar', () => {
  it('draws a ten-cell gauge whose plain width matches usageBarWidth', async () => {
    const { renderToString } = await import('ink');
    const { UsageBar, usageBarWidth } = await import('../src/ui/tui/App.js');
    const bar = (percent: number) => renderToString(createElement(UsageBar, { label: 'ctx', percent }));
    expect(strip(bar(38))).toBe('ctx ▕████░░░░░░▏ 38%');
    expect(strip(bar(0))).toBe('ctx ▕░░░░░░░░░░▏ 0%');
    expect(strip(bar(0.4))).toBe('ctx ▕█░░░░░░░░░▏ 0%'); // any use shows
    expect(strip(bar(140))).toBe('ctx ▕██████████▏ 100%');
    expect(usageBarWidth('ctx', 38)).toBe(strip(bar(38)).length);
    const withLimit = strip(renderToString(createElement(UsageBar, { label: 'ctx', percent: 38, suffix: '(300k)' })));
    expect(withLimit).toBe('ctx ▕████░░░░░░▏ 38% (300k)');
    expect(usageBarWidth('ctx', 38, '(300k)')).toBe(withLimit.length);
    const withReset = strip(renderToString(createElement(UsageBar, { label: '5h', percent: 5, reset: '2h 15m' })));
    expect(withReset).toBe('5h ▕█░░░░░░░░░▏ 5% (2h 15m)');
    expect(usageBarWidth('5h', 5, undefined, '2h 15m')).toBe(withReset.length);
    expect(bar(90)).toContain('\x1b[31m'); // red from 85%
    expect(bar(70)).toContain('\x1b[33m'); // yellow from 60%
    expect(bar(10)).toContain('\x1b[32m');
  });

  it('draws a live subagent line in the conversation: running with its tool call, then finished', async () => {
    const { HistoryView } = await import('../src/ui/tui/components.js');
    const { renderToString } = await import('ink');
    const running = strip(
      renderToString(
        createElement(HistoryView, {
          item: { id: 1, kind: 'task', taskId: 't1', type: 'explore', description: 'study refunds', state: 'running', activity: 'bash(npm test)', since: Date.now() - 8_000, rev: 3 },
          width: 100,
        }),
      ),
    );
    expect(running).toContain('◷ explore study refunds');
    expect(running).toContain('bash(npm test)');
    expect(running).toContain('8s');
    const done = strip(
      renderToString(
        createElement(HistoryView, {
          item: { id: 2, kind: 'task', taskId: 't1', type: 'explore', description: 'study refunds', state: 'done', activity: 'finished — report ready', since: Date.now() - 8_000, endedAt: Date.now(), rev: 4 },
          width: 100,
        }),
      ),
    );
    expect(done).toContain('✔ explore study refunds');
    expect(done).toContain('finished — report ready');
  });

  it('a running tool call shows a blinking line with no result yet', async () => {
    const { HistoryView } = await import('../src/ui/tui/components.js');
    const { renderToString } = await import('ink');
    const run = strip(renderToString(createElement(HistoryView, { item: { id: 3, kind: 'tool', label: 'bash(npm test)', running: true, rev: 1 }, width: 80 })));
    expect(run).toContain('bash(npm test)');
    expect(run).not.toContain('⎿'); // no result while it is running
    const done = strip(renderToString(createElement(HistoryView, { item: { id: 4, kind: 'tool', label: 'bash(npm test)', output: 'ok', isError: false }, width: 80 })));
    expect(done).toContain('⎿ ok');
  });
});

describe('/command', () => {
  it('lists the keys the bottom bar no longer shows', async () => {
    const { KEYS_HELP } = await import('../src/commands.js');
    for (const k of ['ctrl+t', 'shift+tab', 'ctrl+o', 'ctrl+v', 'ctrl+r', 'ctrl+g', '/mcp']) expect(KEYS_HELP).toContain(k);
  });
});

describe('turn summary', () => {
  it('shows the time, the first token and the writing speed', () => {
    expect(formatTiming({ elapsedMs: 12_300, firstOutputMs: 1_200, outputMs: 4_000, usage: { outputTokens: 800 } })).toBe('⏱ 12.3s (first token 1.2s · 200 tok/s)');
    // Too short to measure a rate, or nothing written yet.
    expect(formatTiming({ elapsedMs: 900, firstOutputMs: 800, outputMs: 100, usage: { outputTokens: 5 } })).toBe('⏱ 900ms (first token 800ms)');
    expect(formatTiming({ elapsedMs: 2_000 })).toBe('⏱ 2.0s');
  });

  it('appends the local date and time as "2026.11.20 12:20 PM"', () => {
    expect(formatClock(new Date(2026, 10, 20, 12, 20))).toBe('2026.11.20 12:20 PM');
    expect(formatClock(new Date(2026, 0, 5, 9, 5))).toBe('2026.01.05 9:05 AM');
    expect(formatClock(new Date(2026, 11, 31, 0, 0))).toBe('2026.12.31 12:00 AM');
  });
});

describe('tool call label', () => {
  it('shows a long or multi-line command in full when expanded', async () => {
    const { toolLabel, toolLabelFull } = await import('../src/ui/format.js');
    const command = `cd /repo && cat > notes.txt <<'X'\nfirst line\nsecond line\nX\nnpm test -- --reporter verbose ${'--flag '.repeat(12)}`;
    const item: HistoryItem = { id: 1, kind: 'tool', label: toolLabel('bash', { command }), fullLabel: toolLabelFull('bash', { command }), output: 'ok' };
    const folded = strip(await draw(item, false, 200));
    expect(folded).toContain('…');
    expect(folded).toContain('ctrl+o to expand');
    expect(folded).not.toContain('\n  second line'); // one line, cut at 80 characters
    const open = strip(await draw(item, true, 200));
    expect(open).toContain('  first line\n  second line'); // line breaks kept, indented under the bullet
    expect(open).toContain('--flag --flag)'); // the end, which the folded label cut off
    // A short call has nothing more to show.
    expect(toolLabelFull('bash', { command: 'npm test' })).toBeUndefined();
    const { isExpandable } = await import('../src/ui/tui/components.js');
    expect(isExpandable({ id: 2, kind: 'tool', label: 'bash(npm test)', output: 'ok' })).toBe(false);
    expect(isExpandable(item)).toBe(true);
  });
});
