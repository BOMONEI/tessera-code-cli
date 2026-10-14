import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { fitColumns, renderMarkdown, renderStreaming, stablePrefixLength, streamTail, trimBlock } from '../src/ui/markdown.js';

const TABLE = `| # | 영역 | 문제 | 개선안 |
|---|---|---|---|
| 1 | **player-provider.tsx** | 2253줄, \`useState\` 16개, \`useEffect\` 35개 — 전체 코드베이스에서 가장 취약한 지점 | 오디오 엔진 / 큐 관리 / 슬립타이머 / 진행률을 훅으로 분리 (\`useAudioEngine\`, \`useQueue\` …) |
| 2 | Rate limiting 없음 | \`/api/audio/[videoId]\` 프록시가 yt-dlp를 직접 호출 — 무제한 요청 시 YouTube 밴/머신 차단 위험 | 세션 기반 토큰 버킷 |
`;

const lines = (s: string) => s.split('\n');

describe('markdown tables', () => {
  for (const width of [120, 80, 50]) {
    it(`fit in ${width} columns with aligned borders (CJK aware)`, () => {
      const out = renderMarkdown(TABLE, width);
      const rows = lines(out).filter((l) => /[│┌├└]/.test(l));
      expect(rows.length).toBeGreaterThan(5);
      const widths = new Set(rows.map((l) => stringWidth(l)));
      expect(widths.size).toBe(1); // every border/row line has the same width
      expect([...widths][0]).toBeLessThanOrEqual(width);
    });
  }

  it('keeps narrow tables at their natural width and every cell visible', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| 1 | 둘 |\n', 100);
    expect(stringWidth(lines(out)[0]!)).toBe(stringWidth('┌───┬────┐'));
    expect(out).toContain('둘');
  });

  it('shrinks the widest columns first and respects minimums', () => {
    expect(fitColumns([3, 10, 40], [1, 6, 6], 40)).toEqual([3, 10, 17]);
    expect(fitColumns([30, 30], [6, 6], 20).reduce((a, b) => a + b)).toBe(13);
    expect(fitColumns([30, 30], [6, 6], 10)).toEqual([6, 6]); // cannot fit: stop at minimums
  });
});

describe('streamTail', () => {
  it('returns short text unchanged', () => {
    expect(streamTail('a\nb', 80, 10)).toEqual({ text: 'a\nb', hidden: 0 });
  });
  it('keeps only the last rows after wrapping', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n' + '가'.repeat(30);
    const r = streamTail(text, 20, 5);
    expect(lines(r.text)).toHaveLength(5);
    expect(r.text.endsWith('가'.repeat(10))).toBe(true); // 30 wide chars wrap into three 20-column lines
    expect(r.hidden).toBe(50 + 3 - 5);
  });
});

describe('stablePrefixLength', () => {
  it('keeps the block still being written out of the stable part', () => {
    const text = '# Title\n\nFirst paragraph.\n\nSecond para\nstill';
    const cut = stablePrefixLength(text);
    expect(text.slice(0, cut)).toBe('# Title\n\nFirst paragraph.\n\n');
  });
  it('never cuts inside an open code fence or a growing table', () => {
    expect(stablePrefixLength('```ts\nconst a = 1;\n\nconst b = 2;')).toBe(0);
    const table = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(table.slice(0, stablePrefixLength(table))).toBe('intro\n\n');
  });
  it('commits a finished table once the next block starts', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter\n';
    expect(text.slice(stablePrefixLength(text))).toBe('After\n');
  });
  it('streaming char by char commits every block exactly once, in order', () => {
    const text = '## H\n\n- one\n- two\n\nPara **bold**.\n\n| a |\n|---|\n| 1 |\n\n```\ncode\n\nmore\n```\n\nEnd.\n';
    const parts: string[] = [];
    let buffer = '';
    for (const ch of text) {
      buffer += ch;
      const cut = stablePrefixLength(buffer);
      if (cut > 0) {
        parts.push(buffer.slice(0, cut));
        buffer = buffer.slice(cut);
      }
    }
    parts.push(buffer);
    expect(parts.join('')).toBe(text);
    expect(parts.map((p) => p.trim().split('\n')[0])).toEqual(['## H', '- one', 'Para **bold**.', '| a |', '```', 'End.']);
  });
});

describe('renderStreaming', () => {
  it('holds back a table until its delimiter row is complete', () => {
    expect(renderStreaming('| a | b |\n|--', 80)).toBe('');
    expect(renderStreaming('Intro\n\n| a | b |\n|--', 80)).toContain('Intro');
    expect(renderStreaming('Intro\n\n| a | b |\n|--', 80)).not.toContain('|');
    expect(renderStreaming('| a | b |\n|---|---|\n| 1', 80)).toContain('┌');
  });
});

describe('streaming commit edge cases (review)', () => {
  it('does not treat a partial line that looks like a block start as a block boundary', () => {
    expect(stablePrefixLength('foo bar\n#')).toBe(0);
    expect(stablePrefixLength('foo bar\n***')).toBe(0);
    expect(stablePrefixLength('foo bar\n1.')).toBe(0);
  });
  it('keeps the indentation that belongs to the block', () => {
    expect(trimBlock('\n\n    code line\n    more\n\n')).toBe('    code line\n    more');
    expect(renderMarkdown(trimBlock('\n    code line\n    more'), 80)).toContain('more');
    expect(renderMarkdown(trimBlock('\n    code line\n    more'), 80)).not.toContain('code line more');
  });
});

describe('lists (backticks and code blocks)', () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  it('renders inline markup inside list items instead of raw symbols', () => {
    const out = plain(renderMarkdown('- `npm test` 와 **굵게**\n  - 중첩 `a`', 80));
    expect(out).toContain('npm test 와 굵게');
    expect(out).not.toContain('`');
    expect(out).not.toContain('**');
  });
  it('starts a code block inside a list item on its own line and keeps every line', () => {
    const out = plain(renderMarkdown('1. 설치:\n   ```bash\n   npm install\n   npm test\n   ```\n2. 끝', 80));
    const lines = out.split('\n');
    expect(lines.find((l) => l.includes('설치:'))!.trim()).toBe('1. 설치:');
    expect(out).toContain('npm install');
    expect(out).toContain('npm test');
  });
});

describe('code blocks in languages the highlighter does not know', () => {
  it('render as plain text without console warnings, also while streaming', async () => {
    // marked-terminal only highlights with colors on; force them for this test.
    const chalk = (await import('chalk')).default;
    const level = chalk.level;
    chalk.level = 3;
    const errors: unknown[] = [];
    const orig = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => void errors.push(a);
    console.log = (...a: unknown[]) => void errors.push(a);
    try {
      const md = '```mermaid\ngraph TD\n  A-->B\n```\n';
      const out = renderMarkdown(md, 80).replace(/\x1b\[[0-9;]*m/g, '');
      for (let i = 4; i < md.length; i += 3) renderStreaming(md.slice(0, i), 80);
      expect(out).toContain('A-->B');
      expect(errors).toEqual([]);
    } finally {
      console.error = orig;
      console.log = origLog;
      chalk.level = level;
    }
  });
});
