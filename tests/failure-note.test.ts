import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { ModelInfo } from '../src/providers/catalog.js';

// Each call streams the next script: text deltas, or an error before any output.
const scripts: Array<string[] | 'error'> = [];
const prompts: LanguageModelV4CallOptions['prompt'][] = [];
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
      async doStream(options: LanguageModelV4CallOptions) {
        prompts.push(options.prompt);
        const script = scripts.shift() ?? ['ok'];
        if (script === 'error') throw new Error('upstream 500');
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        const parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          ...script.map((delta) => ({ type: 'text-delta', id: 't', delta })),
          { type: 'text-end', id: 't' },
          { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
        ];
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
      },
    }) as unknown as LanguageModelV4,
}));
vi.mock('../src/cost/ledger.js', () => ({ recordSpend: async () => {} }));

const { Agent, cleanHistory, stripFailureNote } = await import('../src/agent/agent.js');

const model: ModelInfo = { id: 'mock', name: 'mock', format: 'chat', context: 100_000, output: 1000, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0 } };
const agent = (messages: ModelMessage[] = []) =>
  new Agent({ model, apiKey: 'k', sessionId: 's', system: '', tools: {}, maxSteps: 1, contextLimit: 50_000, thinking: false, messages });

async function answer(a: InstanceType<typeof Agent>, prompt: string): Promise<string> {
  let text = '';
  for await (const e of a.run(prompt)) if (e.type === 'text') text += e.text;
  return text;
}

describe('failure notes', () => {
  it('are removed from the start of an answer, even when streamed in pieces', async () => {
    scripts.push(['[assistant turn ', 'failed before producing content]', '\n\n안녕', '하세요']);
    const a = agent();
    expect(await answer(a, 'hi')).toBe('안녕하세요');
    expect(JSON.stringify(a.messages)).not.toContain('failed before');
    // Brackets that are not a note stay.
    scripts.push(['[1, 2]', ' is a list']);
    expect(await answer(a, 'list?')).toBe('[1, 2] is a list');
    scripts.push(['[link](x)']);
    expect(await answer(a, 'link?')).toBe('[link](x)');
  });

  it('a failed turn is recorded with a user note, never as assistant text', async () => {
    scripts.push('error');
    const a = agent();
    await answer(a, 'first');
    expect(a.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: '[The previous request failed]' },
    ]);
    scripts.push(['ok']);
    await answer(a, 'again');
    const sent = JSON.stringify(prompts.at(-1));
    expect(sent).toContain('previous request failed');
    expect(prompts.at(-1)!.filter((m) => m.role === 'assistant')).toEqual([]);
  });

  it('older histories are cleaned before sending', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '[Interrupted by user]' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: [{ type: 'text', text: '[assistant turn failed before producing content] fine' }] },
    ];
    expect(cleanHistory(history)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: '[Interrupted by user]' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: [{ type: 'text', text: 'fine' }] },
    ]);
    expect(stripFailureNote('[The previous request failed]\nok')).toBe('ok');
  });
});
