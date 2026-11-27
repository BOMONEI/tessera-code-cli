import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { adjustChunks, backspaceTarget, caretOf, pasteSpans, wrapOffsets } from '../src/ui/tui/Input.js';
import { mentionAt } from '../src/ui/completion.js';

describe('caretOf (real cursor position for IME composition)', () => {
  it('counts wide characters as two cells', () => {
    expect(caretOf('한글 입력', 5, 80)).toEqual({ x: 9, row: 0 });
    expect(caretOf('한글 입력', 3, 80)).toEqual({ x: 5, row: 0 });
  });
  it('follows explicit newlines', () => {
    expect(caretOf('첫줄\n둘', 4, 80)).toEqual({ x: 2, row: 1 });
    expect(caretOf('a\n', 2, 80)).toEqual({ x: 0, row: 1 });
  });
  it('wraps at the width without splitting a wide character', () => {
    expect(caretOf('abcde', 5, 5)).toEqual({ x: 0, row: 1 });
    expect(caretOf('abcd한', 5, 5)).toEqual({ x: 2, row: 1 });
  });
});

describe('mentionAt', () => {
  it('finds the @-token at the cursor', () => {
    expect(mentionAt('fix @src/ap', 11)).toEqual({ start: 4, query: 'src/ap' });
    expect(mentionAt('mail a@b', 8)).toBeUndefined();
  });
});

describe('wrapOffsets (input rows never cross the right border)', () => {
  it('moves a wide character that does not fit to the next row whole', () => {
    // 5 cells: "ab" (2) + "가" (2) = 4, the next "나" would need cells 5-6.
    expect(wrapOffsets('ab가나', 5)).toEqual([3]);
    expect(wrapOffsets('가나다', 4)).toEqual([2]);
    expect(wrapOffsets('abc', 10)).toEqual([]);
  });
  it('agrees with caretOf on where rows start', () => {
    const line = '이것은 아주 긴 입력입니다 줄바꿈이 여러번 일어나도록 길게';
    for (const width of [7, 13, 20, 33]) {
      // The character at a wrap offset starts a row: right after it, the caret sits one character in.
      for (const at of wrapOffsets(line, width)) expect(caretOf(line, at + 1, width).x).toBe(stringWidth(line[at]!));
    }
  });
});

describe('pasted runs (colored in the box, removed whole)', () => {
  it('keeps runs before an edit and shifts the ones after it', () => {
    const chunks = [
      { start: 0, end: 5 }, // "paste"
      { start: 9, end: 12 }, // "end"
    ];
    const moved = adjustChunks(chunks, 'go PASTE end', 'go PASTE gone end'); // inserted before "end"
    expect(moved[0]).toEqual({ start: 0, end: 5 }); // untouched
    expect(moved[1]!.start).toBeGreaterThan(5); // shifted right
  });

  it('keeps a run when typing right after it', () => {
    expect(adjustChunks([{ start: 0, end: 2 }], 'AB', 'ABcd')).toEqual([{ start: 0, end: 2 }]);
  });

  it('shifts a run when typing right before it', () => {
    expect(adjustChunks([{ start: 0, end: 5 }], 'hello', 'go hello')).toEqual([{ start: 3, end: 8 }]);
  });

  it('dissolves a run that was edited inside (it is ordinary text now)', () => {
    expect(adjustChunks([{ start: 0, end: 4 }], 'ABCD', 'ABxCD')).toEqual([]);
  });

  it('drops a run deleted wholesale and shifts the one after it', () => {
    const moved = adjustChunks(
      [
        { start: 3, end: 8 },
        { start: 9, end: 12 },
      ],
      'go PASTE end',
      'go end',
    );
    expect(moved).toEqual([{ start: 3, end: 6 }]); // "end" now at 3
  });

  it('a value set from outside moves runs the same way', () => {
    // An image tag inserted in front (ctrl+v) shifts everything after the caret.
    expect(adjustChunks([{ start: 0, end: 5 }], 'hello', '[Image #1] hello')).toEqual([{ start: 11, end: 16 }]);
  });
});

describe('backspaceTarget', () => {
  it('takes the whole run at the caret in one press', () => {
    expect(backspaceTarget([{ start: 0, end: 5 }], 'hello world', 5)).toEqual({ start: 0, end: 5 });
  });

  it('inside a run it is a normal character (nothing special)', () => {
    expect(backspaceTarget([{ start: 0, end: 5 }], 'hello world', 3)).toBeUndefined();
  });

  it('takes the marker before the caret with its trailing space, even without a run', () => {
    const img = 'see [Image #2] here';
    expect(backspaceTarget([], img, 'see [Image #2] '.length)).toEqual({ start: 4, end: 15 }); // 'see ' is 4
    const tag = '[Pasted text #1 +42 lines] next';
    expect(backspaceTarget([], tag, '[Pasted text #1 +42 lines] '.length)).toEqual({ start: 0, end: 27 });
  });

  it('leaves ordinary text alone', () => {
    expect(backspaceTarget([], 'plain', 5)).toBeUndefined();
    expect(backspaceTarget([], 'plain', 0)).toBeUndefined();
  });
});

describe('pasteSpans', () => {
  it('colors a run green over its range', () => {
    expect(pasteSpans('hello world', [{ start: 0, end: 5 }], 0, 11)).toEqual([{ start: 0, end: 5, color: 'green' }]);
  });

  it('colors image markers cyan and paste markers green', () => {
    expect(pasteSpans('[Image #1]', [], 0, 10)).toEqual([{ start: 0, end: 10, color: 'cyan' }]);
    expect(pasteSpans('[Pasted text #1 +2 lines]', [], 0, 25)).toEqual([{ start: 0, end: 25, color: 'green' }]);
  });

  it('lets a marker keep its color inside a run, and clips to the requested window', () => {
    const spans = pasteSpans('[Image #1] tail', [{ start: 0, end: 15 }], 0, 15);
    expect(spans).toEqual([
      { start: 0, end: 10, color: 'cyan' },
      { start: 10, end: 15, color: 'green' },
    ]);
    expect(pasteSpans('hello', [{ start: 0, end: 5 }], 2, 4)).toEqual([{ start: 2, end: 4, color: 'green' }]);
  });
});
