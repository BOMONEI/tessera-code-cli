import { describe, expect, it } from 'vitest';
import { applyCompletion, complete, rank, type CompletionSources } from '../src/ui/completion.js';

const src: CompletionSources = {
  commands: [
    { name: 'help', description: 'list commands' },
    { name: 'model', description: 'show or switch the model', argHint: '[id]' },
    { name: 'mode', description: 'permission mode', argHint: '[mode]' },
    { name: 'resume', description: 'continue a session', argHint: '[id]' },
  ],
  args: (name) => (name === 'model' ? [{ value: 'mimo-v2.6-flash' }, { value: 'glm-5.3-flash' }, { value: 'qwen3.8-flash' }] : undefined),
  files: (q) => ['src/app.ts', 'src/'].filter((f) => f.includes(q)),
  history: ['!git status', 'fix the median bug', '!git log --oneline', 'run the tests'],
};

describe('slash command completion', () => {
  it('lists all commands for "/" and ranks prefix matches first', () => {
    expect(complete('/', 1, src)!.items).toHaveLength(4);
    const c = complete('/mo', 3, src)!;
    expect(c.kind).toBe('command');
    expect(c.items.map((i) => i.value)).toEqual(['/model', '/mode']);
    expect(c.items[0]!.hint).toBe('show or switch the model');
  });
  it('matches subsequences ("/rsm" -> /resume)', () => {
    expect(complete('/rsm', 4, src)!.items[0]!.value).toBe('/resume');
  });
  it('completes arguments of the command being typed', () => {
    const c = complete('/model gl', 9, src)!;
    expect(c.kind).toBe('argument');
    expect(c.items.map((i) => i.value)).toEqual(['glm-5.3-flash']);
    expect(applyCompletion('/model gl', c, c.items[0]!).value).toBe('/model glm-5.3-flash');
  });
  it('closes once the argument is complete, and for commands without candidates', () => {
    expect(complete('/model glm-5.3-flash', 20, src)).toBeUndefined();
    expect(complete('/resume ', 8, src)).toBeUndefined();
  });
  it('adds a space after a completed command name', () => {
    const c = complete('/mod', 4, src)!;
    expect(applyCompletion('/mod', c, c.items[0]!)).toEqual({ value: '/model ', cursor: 7 });
  });
});

describe('other completions', () => {
  it('@files: directories keep the menu open, files get a space', () => {
    const c = complete('look at @src', 12, src)!;
    expect(c.kind).toBe('file');
    const dir = c.items.find((i) => i.value === '@src/')!;
    expect(applyCompletion('look at @src', c, dir).value).toBe('look at @src/');
    const file = c.items.find((i) => i.value === '@src/app.ts')!;
    expect(applyCompletion('look at @src', c, file).value).toBe('look at @src/app.ts ');
  });
  it('!commands: earlier shell commands with the same prefix, never auto-run', () => {
    const c = complete('!git', 4, src)!;
    expect(c.items.map((i) => i.value)).toEqual(['!git status', '!git log --oneline']);
  });
  it('rank keeps the input order for equal scores', () => {
    expect(rank(['b-x', 'a-x'], 'x', (s) => s)).toEqual(['b-x', 'a-x']);
  });
});

describe('enter in menus (review)', async () => {
  const { enterAction } = await import('../src/ui/completion.js');
  it('runs what was typed for shell lines, never the longer suggestion', () => {
    const c = complete('!git', 4, src)!;
    expect(enterAction('!git', 4, c, c.items[0]!)).toBe('typed');
  });
  it('runs the bare command when no argument was typed yet (its picker/toggle runs)', () => {
    const c = complete('/model ', 7, { ...src, args: () => [{ value: 'glm-5.3-flash' }] })!;
    expect(enterAction('/model ', 7, c, c.items[0]!)).toBe('typed');
    // Picked with the arrows: run the highlighted model.
    expect(enterAction('/model ', 7, c, c.items[0]!, true)).toBe('complete-and-run');
    const typed = complete('/model gl', 9, src)!;
    expect(enterAction('/model gl', 9, typed, typed.items[0]!)).toBe('complete-and-run');
  });
  it('does not swap the command when the cursor is inside it', () => {
    const c = complete('/model x', 2, src)!;
    expect(enterAction('/model x', 2, c, c.items[0]!)).toBe('typed');
  });
  it('submits an already complete @dir/ instead of trapping enter', () => {
    const c = complete('see @src/', 9, { ...src, files: () => ['src/', 'src/app.ts'] })!;
    expect(enterAction('see @src/', 9, c, c.items[0]!)).toBe('typed');
  });
});
