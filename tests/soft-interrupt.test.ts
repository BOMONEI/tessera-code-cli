import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ModelInfo } from '../src/providers/catalog.js';

// The first stream call hangs until its signal is aborted (the soft interrupt); later calls answer normally.
const prompts: unknown[] = [];

function mockModel(): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('unused');
    },
    async doStream({ prompt, abortSignal }) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            async start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] } as LanguageModelV4StreamPart);
              await new Promise<void>((r) => (abortSignal?.aborted ? r() : abortSignal!.addEventListener('abort', () => r(), { once: true })));
              c.close(); // the attempt ends without a finish part: the SDK reports an abort
            },
          }),
        };
      }
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'cut answer' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          finishReason: { unified: 'stop', raw: 'stop' },
        },
      ];
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
type AgentEvent = import('../src/agent/agent.js').AgentEvent;

const model: ModelInfo = { id: 'mock', name: 'mock', format: 'chat', context: 1_000_000, output: 1000, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0 } };
const agent = () => new Agent({ model, apiKey: 'k', sessionId: 's', system: 'sys', tools: {}, maxSteps: 10, thinking: false, contextLimit: 300_000 });

describe('soft interrupt (cut in)', () => {
  it('cancels the running step, injects the queued message and continues the turn', async () => {
    const a = agent();
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of a.run('do the task')) events.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 50)); // the first step is hanging
    a.interject('cut in please');
    a.interruptStep();
    await done;
    const types = events.map((e) => e.type);
    expect(types).toContain('interjection'); // the queued message was announced
    expect(types).not.toContain('error');
    const finish = events.findLast((e) => e.type === 'turn-finish') as { finishReason: string };
    expect(finish.finishReason).toBe('stop'); // the turn completed, it was not interrupted
    expect(events.some((e) => e.type === 'text' && e.text === 'cut answer')).toBe(true);
    // the second request carries the cut-in message
    expect(JSON.stringify(prompts[1])).toContain('cut in please');
    // the history is a finished turn: no interrupted/failed note was appended
    expect(JSON.stringify(a.messages)).not.toContain('[Interrupted');
  });

  it('esc still ends the whole turn', async () => {
    prompts.length = 0;
    const a = agent();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of a.run('task', controller.signal)) events.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await done;
    const finish = events.findLast((e) => e.type === 'turn-finish') as { finishReason: string };
    expect(finish.finishReason).toBe('interrupted');
  });
});
