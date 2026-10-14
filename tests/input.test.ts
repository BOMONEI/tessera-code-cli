import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { caretOf, wrapOffsets } from '../src/ui/tui/Input.js';
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
