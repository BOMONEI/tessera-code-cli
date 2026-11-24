import { describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { runCommand } from '../src/commands.js';

/** Bare /model and /mode open the argument selectbox (like /resume) instead of just printing; /think still toggles. */
const app = {
  ctx: { cwd: '/tmp/commands-test' },
  listSkills: async () => [],
  agent: {
    model: { id: 'mimo-v2.6-flash', format: 'chat', context: 500_000, output: 32_000, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0 } },
    sessionId: 's',
    messages: [],
    thinking: true,
    thinkingLevel: 'medium',
    thinkingAuto: false,
  },
  config: { showThinking: true },
  catalog: [],
  permissions: { mode: 'default' },
} as unknown as App;

describe('bare slash commands', () => {
  it('opens the selectbox for /mode instead of printing the current mode', async () => {
    const r = await runCommand(app, '/mode');
    expect(r.choose?.title).toContain('/mode');
    expect(r.choose?.options.map((o) => o.label)).toEqual(['default', 'acceptEdits', 'plan', 'bypass', 'dangerous']);
    expect(r.choose?.options[0]!.hint).toContain('current');
  });

  it('opens the selectbox for bare /think too, and ctrl+s (select with save) stores it as the default', async () => {
    const think = await runCommand(app, '/think');
    expect(think.choose?.title).toContain('/think');
    expect(think.choose?.canSave).toBe(true);
    expect(think.choose?.options.map((o) => o.label)).toContain('off');
    const off = think.choose!.options.findIndex((o) => o.label === 'off');
    const applied = await think.choose!.select(off, true);
    expect(applied.output).toContain('saved as the default for new sessions');
    const resume = await runCommand(app, '/resume'); // its own richer picker, no other session in the temp dir
    expect(resume.choose).toBeUndefined();
  });
});
