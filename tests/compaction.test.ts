import { describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ModelInfo } from '../src/providers/catalog.js';

// Scripted model: stream calls follow `script`; generate calls (the summarizer) return a fixed summary.
const prompts: unknown[] = [];
let failSummary = false;
const script: Array<'tool' | 'text' | 'slow' | 'bigtext'> = [];
let slowToolStream: ((c: ReadableStreamDefaultController<LanguageModelV4StreamPart>) => Promise<void>) | undefined;
const usage = (input: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
});

function mockModel(): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    async doGenerate() {
      if (failSummary) throw new Error('summary failed');
      return { content: [{ type: 'text', text: 'SUMMARY-OF-WORK' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(100), warnings: [] };
    },
    async doStream({ prompt }) {
      // The summarizer streams too: answer it with the fixed summary, outside the scripted steps.
      if (JSON.stringify(prompt).includes('Summarize the conversation so far')) {
        if (failSummary) throw new Error('summary failed');
        const parts: LanguageModelV4StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 's' },
          { type: 'text-delta', id: 's', delta: 'SUMMARY-' },
          { type: 'text-delta', id: 's', delta: 'OF-WORK' },
          { type: 'text-end', id: 's' },
          { type: 'finish', usage: usage(100), finishReason: { unified: 'stop', raw: 'stop' } },
        ];
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
      }
      prompts.push(prompt);
      const step = script.shift() ?? 'text';
      if (step === 'slow' && slowToolStream) {
        const run = slowToolStream;
        return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start: (c) => run(c) }) };
      }
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (step === 'tool') {
        parts.push({ type: 'tool-call', toolCallId: `c${prompts.length}`, toolName: 'big', input: '{}' });
        parts.push({ type: 'finish', usage: usage(900), finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });
      } else {
        parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' });
        // 'bigtext': a final answer whose request already carried a context over the limit.
        parts.push({ type: 'finish', usage: usage(step === 'bigtext' ? 1500 : 200), finishReason: { unified: 'stop', raw: 'stop' } });
      }
      return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
    },
  } as LanguageModelV4;
}

vi.mock('../src/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/index.js')>()),
  createModel: () => mockModel(),
}));
vi.mock('../src/cost/ledger.js', () => ({ recordSpend: async () => {} }));

const { Agent } = await import('../src/agent/agent.js');

const model: ModelInfo = { id: 'mock', name: 'mock', format: 'chat', context: 1_000_000, output: 1000, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0 } };
const big = tool({ description: 'big output', inputSchema: z.object({}), execute: async () => 'x'.repeat(2000) });

/** `window`: the model's context window. Mid-turn compaction happens only near it (90%); see the tests below. */
function agent(contextLimit: number, window = model.context) {
  return new Agent({ model: { ...model, context: window }, apiKey: 'k', sessionId: 's', system: 'sys', tools: { big }, maxSteps: 10, thinking: false, contextLimit });
}

describe('context limit', () => {
  it('lets a turn that outgrows the limit finish, then compacts', async () => {
    prompts.length = 0;
    script.push('tool', 'tool', 'bigtext');
    const a = agent(1000); // 1M window: far from the hard limit
    const events = [];
    for await (const ev of a.run('do the task')) events.push(ev);
    const types = events.map((e) => e.type);
    // No compaction between steps: every step still sees the original prompt.
    for (const p of prompts) expect(JSON.stringify(p)).toContain('do the task');
    expect(types.filter((t) => t === 'compacted')).toHaveLength(1);
    expect(types.indexOf('compacted')).toBeGreaterThan(types.indexOf('turn-finish'));
    expect(JSON.stringify(a.messages[0])).toContain('SUMMARY-OF-WORK');
    expect(JSON.stringify(a.messages)).not.toContain('do the task'); // the history is just the summary now
  });

  it('does not compact after an interrupted turn', async () => {
    script.push('tool', 'text');
    const a = agent(1000);
    const controller = new AbortController();
    const events = [];
    for await (const ev of a.run('task', controller.signal)) {
      events.push(ev);
      if (ev.type === 'tool-result') controller.abort();
    }
    expect(events.some((e) => e.type === 'compacted')).toBe(false);
  });

  it('compacts between steps when a tool loop nears the model window, then continues the task', async () => {
    prompts.length = 0;
    script.push('tool', 'tool', 'text');
    const a = agent(1000, 1100);
    const events = [];
    for await (const ev of a.run('do the task')) events.push(ev);

    const compacted = events.filter((e) => e.type === 'compacted');
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)?.type).toBe('turn-finish');
    // The step after compaction sees the summary, not the original prompt.
    const after = JSON.stringify(prompts[1]);
    expect(after).toContain('SUMMARY-OF-WORK');
    expect(after).not.toContain('do the task');
    // History restarts from the summary and keeps the steps that ran afterwards.
    expect(JSON.stringify(a.messages[0])).toContain('SUMMARY-OF-WORK');
    expect(a.messages.at(-1)?.role).toBe('assistant');
    expect(a.generation).toBeGreaterThan(0);
  });

  it('does not compact under the limit', async () => {
    prompts.length = 0;
    script.push('tool', 'text');
    const a = agent(300_000);
    const events = [];
    for await (const ev of a.run('small task')) events.push(ev);
    expect(events.some((e) => e.type === 'compacted')).toBe(false);
    expect(JSON.stringify(prompts[1])).toContain('small task');
  });

  it('compacts before a turn when the new prompt would cross the limit', async () => {
    script.push('text');
    const a = agent(1000);
    a.replaceHistory([{ role: 'user', content: 'old '.repeat(1000) }, { role: 'assistant', content: 'ok' }]);
    const events = [];
    for await (const ev of a.run('next')) events.push(ev);
    expect(events[0]?.type).toBe('compacted');
  });

  it('gives up compacting for the rest of the turn after a failure', async () => {
    prompts.length = 0;
    script.push('tool', 'tool', 'tool', 'text');
    failSummary = true;
    const a = agent(1000, 1100);
    const events = [];
    for await (const ev of a.run('task')) events.push(ev);
    failSummary = false;
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('turn-finish');
  });

  it('delivers a mid-turn message before the next step, in order in the history', async () => {
    prompts.length = 0;
    script.push('tool', 'text');
    const a = agent(300_000);
    a.interject('use the other file instead');
    const events = [];
    for await (const ev of a.run('do the task')) events.push(ev);
    expect(events.filter((e) => e.type === 'interjection')).toEqual([{ type: 'interjection', text: 'use the other file instead' }]);
    expect(JSON.stringify(prompts[0])).not.toContain('use the other file'); // the first step had already started
    expect(JSON.stringify(prompts[1])).toContain('use the other file instead');
    const roles = a.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(JSON.stringify(a.messages[3])).toContain('use the other file instead');
    expect(a.takeInterjections()).toEqual([]);
  });

  it('leaves a message unread when the turn had no further step', async () => {
    script.push('text');
    const a = agent(300_000);
    a.interject('too late');
    for await (const _ of a.run('quick question')) void _;
    expect(a.takeInterjections()).toEqual(['too late']);
  });

  it('sends images as image parts, and refuses them for text-only models', async () => {
    prompts.length = 0;
    script.push('text');
    const a = agent(300_000);
    a.model = { ...model, images: true };
    for await (const _ of a.run('what is this?', undefined, [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }])) void _;
    expect(JSON.stringify(prompts[0])).toContain('"type":"file"');
    expect(JSON.stringify(prompts[0])).toContain('image/png');

    const b = agent(300_000);
    const events = [];
    for await (const ev of b.run('what is this?', undefined, [{ data: 'AA', mediaType: 'image/png' }])) events.push(ev);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(b.messages).toHaveLength(0);
  });

  it('folds an interjection into the continue message after a mid-turn compaction', async () => {
    prompts.length = 0;
    script.push('tool', 'text');
    const a = agent(1000, 1100);
    a.interject('also update the docs');
    for await (const _ of a.run('do the task')) void _;
    const users = a.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2); // summary + one merged continue/interjection message
    expect(JSON.stringify(users[1])).toContain('also update the docs');
    for (let i = 1; i < a.messages.length; i++) expect(a.messages[i]!.role === 'user' && a.messages[i - 1]!.role === 'user').toBe(false);
  });

  it('starts read-only tools while the model is still streaming further calls, and runs each once', async () => {
    const started: Array<[string, number]> = [];
    let secondCallAt = 0;
    let runs = 0;
    const read = tool({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        runs++;
        started.push([path, Date.now()]);
        return `content of ${path}`;
      },
    });
    const a = new Agent({ model, apiKey: 'k', sessionId: 's', system: '', tools: { read }, maxSteps: 2, thinking: false, contextLimit: 300_000 });
    slowToolStream = async (c) => {
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'tool-call', toolCallId: 'r1', toolName: 'read', input: '{"path":"a.ts"}' });
      await new Promise((r) => setTimeout(r, 150)); // the model is still writing the next call
      secondCallAt = Date.now();
      c.enqueue({ type: 'tool-call', toolCallId: 'r2', toolName: 'read', input: '{"path":"b.ts"}' });
      c.enqueue({ type: 'finish', usage: usage(10), finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });
      c.close();
    };
    script.push('slow', 'text');
    const results: unknown[] = [];
    // Consume like the app does: through nested generators (agent → app → UI) with a slow consumer.
    async function* layer<T>(g: AsyncIterable<T>): AsyncGenerator<T> {
      for await (const e of g) {
        await new Promise((r) => setTimeout(r, 10));
        yield e;
      }
    }
    for await (const ev of layer(layer(layer(a.run('read both'))))) if (ev.type === 'tool-result') results.push(ev.output);
    slowToolStream = undefined;
    expect(started[0]![0]).toBe('a.ts');
    expect(started[0]![1]).toBeLessThan(secondCallAt); // began before the response was complete
    expect(runs).toBe(2); // each call ran exactly once
    expect(results).toEqual(['content of a.ts', 'content of b.ts']);
  });

  it('waits for the full response when early execution is off (hooks configured)', async () => {
    const started: number[] = [];
    let secondCallAt = 0;
    const read = tool({ description: 'read', inputSchema: z.object({ path: z.string() }), execute: async () => (started.push(Date.now()), 'x') });
    const a = new Agent({ model, apiKey: 'k', sessionId: 's', system: '', tools: { read }, maxSteps: 2, thinking: false, contextLimit: 300_000, earlyTools: false });
    slowToolStream = async (c) => {
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'tool-call', toolCallId: 'r1', toolName: 'read', input: '{"path":"a.ts"}' });
      await new Promise((r) => setTimeout(r, 100));
      secondCallAt = Date.now();
      c.enqueue({ type: 'tool-call', toolCallId: 'r2', toolName: 'read', input: '{"path":"b.ts"}' });
      c.enqueue({ type: 'finish', usage: usage(10), finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });
      c.close();
    };
    script.push('slow', 'text');
    for await (const _ of a.run('go')) void _;
    slowToolStream = undefined;
    expect(started).toHaveLength(2);
    expect(Math.min(...started)).toBeGreaterThanOrEqual(secondCallAt);
  });

  it('caps the limit at 80% of the smallest model window', () => {
    const a = new Agent({ model: { ...model, context: 100_000 }, apiKey: 'k', sessionId: 's', system: '', tools: {}, maxSteps: 1, thinking: false, contextLimit: 300_000 });
    expect(a.contextLimit).toBe(80_000);
  });
});

describe('compaction progress', async () => {
  const { progressPercent, expectedSummaryTokens } = await import('../src/agent/compact.js');

  it('estimates: reading creeps to 15%, writing fills to 99%, done is 100%', () => {
    expect(progressPercent('reading', 0, 0, 1000)).toBe(2);
    expect(progressPercent('reading', 60_000, 0, 1000)).toBeLessThanOrEqual(15);
    expect(progressPercent('writing', 0, 500, 1000)).toBe(57);
    expect(progressPercent('writing', 0, 5000, 1000)).toBe(99); // a longer summary than expected never shows 100
    expect(progressPercent('done', 0, 0, 1000)).toBe(100);
    expect(expectedSummaryTokens(1000)).toBe(600);
    expect(expectedSummaryTokens(10_000_000)).toBe(6000);
  });

  it('reports rising progress that ends at 100 for /compact', async () => {
    const a = agent(1_000_000);
    script.push('text');
    for await (const _ of a.run('hello')) void _;
    const seen: number[] = [];
    a.onCompactProgress = (p) => seen.push(p.percent);
    await a.compact();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)).toBe(100);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
  });

  it('never reports done when the summary fails', async () => {
    const a = agent(1_000_000);
    script.push('text');
    for await (const _ of a.run('hello')) void _;
    const seen: string[] = [];
    a.onCompactProgress = (p) => seen.push(p.phase);
    failSummary = true;
    await expect(a.compact()).rejects.toThrow(/summary failed/);
    failSummary = false;
    expect(seen).not.toContain('done');
  });
});
