import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { BASE_URL } from '../config.js';
import { isAllowedModel, isThinkingOnly, isThinkingOnlyError, markThinkingOnly, type ModelInfo } from './catalog.js';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { providerDef, providerKey, providerSettings, splitModelId } from './registry.js';
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

/** A provider is selected but has no key. */
export class MissingProviderKeyError extends Error {}

/** OpenRouter with "zdr": true: every request asks for zero-data-retention endpoints only. */
function withOpenRouterZdr(): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body.provider = { ...(body.provider as object), zdr: true, data_collection: 'deny' };
        return apiFetch(input, { ...init, body: JSON.stringify(body) });
      } catch {
        // not JSON: send as is
      }
    }
    return apiFetch(input, init);
  };
}

/** A model of another provider (registry.ts), with that provider's key and protocol. */
function otherProviderModel(info: ModelInfo): LanguageModel {
  const def = providerDef(info.provider!)!;
  const settings = providerSettings(def.id);
  const key = providerKey(def.id)?.key ?? (def.local ? 'local' : undefined);
  if (!key) throw new MissingProviderKeyError(`No API key for ${def.name}. Run /auth ${def.id} <key> (or set ${def.env[0]}).`);
  const baseURL = (settings.baseURL ?? def.baseURL).replace(/\/$/, '');
  const { model } = splitModelId(info.id);
  const headers = { 'user-agent': 'tessera-code' };
  switch (def.protocol) {
    case 'openai':
      return createOpenAI({ baseURL, apiKey: key, headers, fetch: apiFetch }).responses(model);
    case 'anthropic':
      return createAnthropic({ baseURL, apiKey: key, headers, fetch: apiFetch })(model);
    case 'chat':
      return createOpenAICompatible({
        name: def.id,
        baseURL,
        apiKey: key,
        headers,
        includeUsage: true,
        fetch: def.id === 'openrouter' && settings.zdr ? withOpenRouterZdr() : apiFetch,
      }).chatModel(model);
  }
}

/**
 * Every request goes through here, so this is where the model policy is enforced: OpenCode Go only with ZDR models;
 * other providers with their own key (non-ZDR ones are allowed, and flagged in the UI).
 */
export function createModel(info: ModelInfo, opts: ProviderOptions): LanguageModel {
  if (!isAllowedModel(info)) throw new NonZdrModelError(info.id);
  return keepReasoningOn(info, info.provider ? otherProviderModel(info) : openCodeGoModel(info, opts));
}

/**
 * Callers turn reasoning off ("none") for compaction, titles and ctrl+t. A thinking-only model rejects that, so it
 * gets the lowest level instead; one not known yet is learned from its 400 and the call is retried once.
 */
function keepReasoningOn(info: ModelInfo, model: LanguageModel): LanguageModel {
  if (!info.reasoning || typeof model === 'string') return model;
  const target = model as LanguageModelV4;
  const adjust = (o: LanguageModelV4CallOptions): LanguageModelV4CallOptions => (o.reasoning === 'none' && isThinkingOnly(info.id) ? { ...o, reasoning: 'low' } : o);
  const call = async <T>(fn: (o: LanguageModelV4CallOptions) => PromiseLike<T>, o: LanguageModelV4CallOptions): Promise<T> => {
    try {
      return await fn(adjust(o));
    } catch (e) {
      if (o.reasoning !== 'none' || isThinkingOnly(info.id) || !isThinkingOnlyError(e)) throw e;
      markThinkingOnly(info.id);
      return fn(adjust(o));
    }
  };
  return new Proxy(target, {
    get(t, p, r) {
      if (p === 'doStream') return (o: LanguageModelV4CallOptions) => call((x) => t.doStream(x), o);
      if (p === 'doGenerate') return (o: LanguageModelV4CallOptions) => call((x) => t.doGenerate(x), o);
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function openCodeGoModel(info: ModelInfo, opts: ProviderOptions): LanguageModel {
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
