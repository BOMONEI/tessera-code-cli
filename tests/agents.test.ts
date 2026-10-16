import { describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ModelInfo } from '../src/providers/catalog.js';

// Every request answers after 100 ms with a report naming its prompt; `active`/`peak` count concurrent requests.
let active = 0;
let peak = 0;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
vi.mock('../src/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/index.js')>()),
  createModel: (): LanguageModelV4 =>
    ({
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('unused');
      },
      async doStream({ prompt }: { prompt: Array<{ role: string; content: unknown }> }) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 100));
        active--;
        const asked = JSON.stringify(prompt.at(-1)?.content);
        const parts: LanguageModelV4StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: `REPORT for ${asked.includes('alpha') ? 'alpha' : 'beta'}` },
          { type: 'text-end', id: 't' },
          { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
        ];
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
      },
    }) as unknown as LanguageModelV4,
}));
vi.mock('../src/cost/ledger.js', () => ({ recordSpend: async () => {} }));

const { taskTool, subagentTools } = await import('../src/tools/task.js');
const { agentsSection, buildSystemPrompt } = await import('../src/agent/prompt.js');
const { runCommand } = await import('../src/commands.js');

const model: ModelInfo = { id: 'mock', name: 'mock', format: 'chat', context: 1_000_000, output: 1000, reasoning: false, cost: { input: 1, output: 1, cacheRead: 0 } };
const dummy = (name: string) => tool({ description: name, inputSchema: z.object({}), execute: async () => name });
const parentTools = { read: dummy('read'), grep: dummy('grep'), glob: dummy('glob'), skill: dummy('skill'), edit: dummy('edit'), bash: dummy('bash'), mcp__x__y: dummy('mcp'), task: dummy('task') };

function makeTask(parallel: number) {
  const absorbed: number[] = [];
  const progress: string[] = [];
  const t = taskTool({
    apiKey: 'k',
    model: () => model,
    tools: () => parentTools,
    system: async (type) => `system for ${type}`,
    agentOptions: () => ({ maxSteps: 5, thinking: false, contextLimit: 500_000 }),
    parallel: () => parallel,
    onProgress: (p) => progress.push(`${p.id}:${p.description}:${p.state}:${p.activity}`),
    onUsage: (u) => absorbed.push(u.inputTokens),
  }).task as unknown as { execute: (i: object, o: object) => Promise<string> };
  let n = 0;
  const run = (prompt: string) => t.execute({ description: prompt, prompt, subagent_type: 'explore' }, { abortSignal: undefined, toolCallId: `call${++n}`, messages: [] });
  return { run, absorbed, progress };
}

describe('subagents', () => {
  it('explore subagents get read-only tools; none get the task tool', () => {
    expect(Object.keys(subagentTools('explore', parentTools)).sort()).toEqual(['glob', 'grep', 'read', 'skill']);
    expect(Object.keys(subagentTools('general', parentTools)).sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'mcp__x__y', 'read', 'skill']);
  });

  it('returns the subagent\'s final report and adds its usage to the session', async () => {
    const { run, absorbed, progress } = makeTask(1);
    const out = await run('look at alpha');
    expect(out).toMatch(/^REPORT for alpha/);
    expect(out).toContain('[explore subagent · 0 tool calls]');
    expect(absorbed).toEqual([100]);
    expect(progress).toEqual(['call1:look at alpha:running:starting', 'call1:look at alpha:done:finished']); // a free slot: never reported as queued
  });

  it('runs one at a time with subagents, in parallel with multi-agent', async () => {
    peak = 0;
    const serial = makeTask(1);
    let t = Date.now();
    const a = await Promise.all([serial.run('alpha'), serial.run('beta')]);
    expect(peak).toBe(1);
    expect(Date.now() - t).toBeGreaterThanOrEqual(190);
    expect(a.map((r) => r.split('\n')[0])).toEqual(['REPORT for alpha', 'REPORT for beta']);

    peak = 0;
    const multi = makeTask(4);
    t = Date.now();
    await Promise.all([multi.run('alpha'), multi.run('beta'), multi.run('alpha'), multi.run('beta')]);
    expect(peak).toBe(4);
    expect(Date.now() - t).toBeLessThan(190);
  });

  it('reports each concurrent subagent separately, with the ones over the limit queued', async () => {
    const { run, progress } = makeTask(1);
    await Promise.all([run('alpha'), run('beta')]);
    // One slot: alpha runs at once, beta waits and starts only after alpha is done.
    expect(progress).toContain('call2:beta:queued:waiting for a free slot');
    expect(progress).not.toContain('call1:alpha:queued:waiting for a free slot');
    expect(progress.indexOf('call2:beta:running:starting')).toBeGreaterThan(progress.indexOf('call1:alpha:done:finished'));
    // With free slots nobody is reported as waiting.
    const multi = makeTask(4);
    await Promise.all([multi.run('alpha'), multi.run('beta')]);
    expect(multi.progress.filter((p) => p.includes(':queued:'))).toEqual([]);
  });
});

describe('system prompt', () => {
  it('describes delegation only when subagents are on, and parallelism for multi-agent', async () => {
    expect(await buildSystemPrompt(process.cwd(), 'm')).not.toContain('# Subagents');
    expect(await buildSystemPrompt(process.cwd(), 'm', [], { parallel: 1 })).toContain('Subagents run one at a time.');
    expect(agentsSection(4)).toContain('run in parallel (up to 4 at a time)');
  });
});

describe('/agents', () => {
  it('switches and saves the mode, by name or from the picker', async () => {
    let mode: 'single' | 'subagents' | 'multi' = 'single';
    const app = { ctx: { cwd: process.cwd() }, listSkills: async () => [], agentsMode: () => mode, setAgentsMode: async (m: typeof mode) => void (mode = m) };
    expect((await runCommand(app as never, '/agents multi')).output).toMatch(/multi-agent[\s\S]*multiAgent: true/);
    expect(mode).toBe('multi');
    const picker = (await runCommand(app as never, '/agents')).choose!;
    expect(picker.options.map((o) => o.label)).toEqual(['  single', '  subagents', '● multi']);
    await picker.select(0);
    expect(mode).toBe('single');
    expect((await runCommand(app as never, '/agents many')).output).toMatch(/^Usage/);
  });
});
