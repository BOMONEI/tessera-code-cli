// Phase 1 PoC: verify streaming + tool calling across the three OpenCode Go API formats.
// Usage: OPENCODE_API_KEY=... npx tsx scripts/poc.ts [baseURL]
import { streamText, tool, isStepCount, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) throw new Error('OPENCODE_API_KEY is not set');
const baseURL = process.argv[2] ?? 'https://opencode.ai/zen/go/v1';

// Go requires a session header for routing (and prompt-cache affinity).
const headers = { 'x-opencode-session': randomUUID() };
const compat = createOpenAICompatible({ name: 'opencode-go', baseURL, apiKey, headers, includeUsage: true });
const anthropic = createAnthropic({ baseURL, apiKey, headers });
const openai = createOpenAI({ baseURL, apiKey, headers });

const cases: Array<{ format: string; id: string; model: LanguageModel }> = [
  { format: 'chat/completions', id: 'deepseek-v4-flash', model: compat.chatModel('deepseek-v4-flash') },
  { format: 'chat/completions', id: 'glm-5.2', model: compat.chatModel('glm-5.2') },
  { format: 'messages', id: 'minimax-m3', model: anthropic('minimax-m3') },
  { format: 'messages', id: 'qwen3.7-plus', model: anthropic('qwen3.7-plus') },
  { format: 'responses', id: 'gpt-6-luna', model: openai.responses('gpt-6-luna') },
];

const tools = {
  add: tool({
    description: 'Add two integers',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }) => ({ sum: a + b }),
  }),
};

for (const c of cases) {
  const started = Date.now();
  let text = '';
  let toolCalls = 0;
  let error: unknown;
  try {
    const result = streamText({
      model: c.model,
      tools,
      stopWhen: isStepCount(3),
      maxRetries: 0,
      onError: () => {},
      prompt: 'Use the add tool to compute 1234 + 5678, then reply with only the number.',
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text;
      else if (part.type === 'tool-call') toolCalls++;
      else if (part.type === 'error') error = part.error;
    }
    const usage = await result.totalUsage;
    const ok = !error && toolCalls > 0 && text.includes('6912');
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${c.format.padEnd(17)} ${c.id.padEnd(18)} ${Date.now() - started}ms`,
      `tools=${toolCalls} in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.inputTokenDetails?.cacheReadTokens}`,
      `text=${JSON.stringify(text.trim().slice(0, 60))}`,
    );
  } catch (e) {
    error = e;
  }
  if (error) console.log(`  error: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
}
