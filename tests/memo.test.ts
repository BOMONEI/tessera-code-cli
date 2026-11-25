import { describe, expect, it } from 'vitest';
import { memoTools } from '../src/tools/memo.js';
import type { ToolContext } from '../src/tools/context.js';

describe('memo tool', () => {
  const saved: string[] = [];
  const ctx = { addMemo: async (t: string) => void saved.push(t) } as ToolContext;

  it('saves a note and reports that it rides every prompt', async () => {
    const r = String(await memoTools(ctx).memo.execute!({ text: ' use pnpm, not npm ' }, { toolCallId: 'm1', messages: [] } as never));
    expect(r).toContain('Memorized for this session');
    expect(r).toContain('use pnpm, not npm');
    expect(saved).toEqual(['use pnpm, not npm']);
  });

  it('refuses empty notes and works without a memory backend', async () => {
    expect(String(await memoTools(ctx).memo.execute!({ text: '   ' }, { toolCallId: 'm2', messages: [] } as never))).toContain('nothing was saved');
    expect(String(await memoTools({} as ToolContext).memo.execute!({ text: 'x' }, { toolCallId: 'm3', messages: [] } as never))).toContain('unavailable');
  });
});
