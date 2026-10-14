import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { BASE_URL } from '../config.js';
import { isZdr, type ModelInfo } from './catalog.js';
import { apiFetch } from './net.js';

export interface ProviderOptions {
  apiKey: string;
  /** Sent as x-opencode-session; Go rejects requests without it and uses it for cache affinity. */
  sessionId: string;
  baseURL?: string;
}

export class NonZdrModelError extends Error {
  constructor(id: string) {
    super(`${id} is not a zero-data-retention model and cannot be used. See \`tessera-code models\` for allowed models.`);
  }
}

/** Every request goes through here, so this is where the ZDR-only policy is enforced. */
export function createModel(info: ModelInfo, opts: ProviderOptions): LanguageModel {
  if (!isZdr(info.id)) throw new NonZdrModelError(info.id);
  const baseURL = opts.baseURL ?? BASE_URL;
  const headers = { 'x-opencode-session': opts.sessionId, 'user-agent': 'tessera-code' };
  switch (info.format) {
    case 'messages':
      return createAnthropic({ baseURL, apiKey: opts.apiKey, headers, fetch: apiFetch })(info.id);
    case 'responses':
      return createOpenAI({ baseURL, apiKey: opts.apiKey, headers, fetch: apiFetch }).responses(info.id);
    case 'chat':
      return createOpenAICompatible({ name: 'opencode-go', baseURL, apiKey: opts.apiKey, headers, includeUsage: true, fetch: apiFetch }).chatModel(info.id);
  }
}

export function costOf(info: ModelInfo, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const freshInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead);
  return (freshInput * info.cost.input + cacheRead * info.cost.cacheRead + (usage.outputTokens ?? 0) * info.cost.output) / 1_000_000;
}
