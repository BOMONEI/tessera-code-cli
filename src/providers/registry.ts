/**
 * Model providers besides OpenCode Go. Models are named "<provider>/<model>" (e.g. "openai/gpt-5",
 * "openrouter/anthropic/claude-sonnet-4.5"); a bare id is an OpenCode Go model, as before.
 *
 * Model lists, limits and prices come from models.dev (its provider ids are used here). Keys come from
 * "providers": { "<id>": { "apiKey": … } } in ~/.tessera-code/config.json (/auth <provider> <key>) or the provider's
 * usual environment variable.
 *
 * Data retention: OpenCode Go models are limited to the zero-data-retention list. Other providers keep or may keep
 * prompts under their own terms, so their models are marked non-ZDR (with a warning) unless they run locally or the
 * config says `"zdr": true` (for an account with a ZDR agreement; for OpenRouter it also asks for ZDR endpoints only).
 */
export type Protocol = 'openai' | 'anthropic' | 'chat';

export interface ProviderDef {
  id: string;
  name: string;
  protocol: Protocol;
  baseURL: string;
  /** Environment variables that may hold the key, in order. */
  env: string[];
  /** Runs on this machine: nothing leaves it, and no key is needed. */
  local?: boolean;
}

export const OPENCODE_GO = 'opencode-go';

const P = (id: string, name: string, protocol: Protocol, baseURL: string, env: string[], local?: boolean): ProviderDef => ({ id, name, protocol, baseURL, env, local });

export const PROVIDERS: ProviderDef[] = [
  P('openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', ['OPENAI_API_KEY']),
  P('anthropic', 'Anthropic (Claude)', 'anthropic', 'https://api.anthropic.com/v1', ['ANTHROPIC_API_KEY']),
  P('openrouter', 'OpenRouter', 'chat', 'https://openrouter.ai/api/v1', ['OPENROUTER_API_KEY']),
  P('commandcode', 'Command Code', 'chat', 'https://api.commandcode.ai/provider/v1', ['CMD_API_KEY']),
  P('google', 'Google Gemini', 'chat', 'https://generativelanguage.googleapis.com/v1beta/openai', ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY']),
  P('xai', 'xAI (Grok)', 'chat', 'https://api.x.ai/v1', ['XAI_API_KEY']),
  P('deepseek', 'DeepSeek', 'chat', 'https://api.deepseek.com', ['DEEPSEEK_API_KEY']),
  P('mistral', 'Mistral', 'chat', 'https://api.mistral.ai/v1', ['MISTRAL_API_KEY']),
  P('cohere', 'Cohere', 'chat', 'https://api.cohere.ai/compatibility/v1', ['COHERE_API_KEY']),
  P('groq', 'Groq', 'chat', 'https://api.groq.com/openai/v1', ['GROQ_API_KEY']),
  P('cerebras', 'Cerebras', 'chat', 'https://api.cerebras.ai/v1', ['CEREBRAS_API_KEY']),
  P('togetherai', 'Together AI', 'chat', 'https://api.together.xyz/v1', ['TOGETHER_API_KEY']),
  P('fireworks-ai', 'Fireworks AI', 'chat', 'https://api.fireworks.ai/inference/v1', ['FIREWORKS_API_KEY']),
  P('deepinfra', 'DeepInfra', 'chat', 'https://api.deepinfra.com/v1/openai', ['DEEPINFRA_API_KEY']),
  P('perplexity', 'Perplexity', 'chat', 'https://api.perplexity.ai', ['PERPLEXITY_API_KEY']),
  P('moonshotai', 'Moonshot AI (Kimi)', 'chat', 'https://api.moonshot.ai/v1', ['MOONSHOT_API_KEY']),
  P('zai', 'Z.ai (GLM)', 'chat', 'https://api.z.ai/api/paas/v4', ['ZHIPU_API_KEY']),
  P('alibaba', 'Alibaba (Qwen)', 'chat', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', ['DASHSCOPE_API_KEY']),
  P('nvidia', 'NVIDIA NIM', 'chat', 'https://integrate.api.nvidia.com/v1', ['NVIDIA_API_KEY']),
  P('huggingface', 'Hugging Face', 'chat', 'https://router.huggingface.co/v1', ['HF_TOKEN']),
  P('baseten', 'Baseten', 'chat', 'https://inference.baseten.co/v1', ['BASETEN_API_KEY']),
  P('opencode', 'OpenCode Zen', 'chat', 'https://opencode.ai/zen/v1', ['OPENCODE_API_KEY']),
  P('ollama', 'Ollama (local)', 'chat', 'http://127.0.0.1:11434/v1', ['OLLAMA_API_KEY'], true),
  P('lmstudio', 'LM Studio (local)', 'chat', 'http://127.0.0.1:1234/v1', ['LMSTUDIO_API_KEY'], true),
];

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** "openai/gpt-5" → { provider: "openai", model: "gpt-5" }; a bare or unknown prefix is an OpenCode Go model. */
export function splitModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf('/');
  if (i > 0 && providerDef(id.slice(0, i))) return { provider: id.slice(0, i), model: id.slice(i + 1) };
  if (id.startsWith(`${OPENCODE_GO}/`)) return { provider: OPENCODE_GO, model: id.slice(OPENCODE_GO.length + 1) };
  return { provider: OPENCODE_GO, model: id };
}

export interface ProviderSettings {
  apiKey?: string;
  /** Overrides the provider's API address (a proxy, a self-hosted gateway, another port for a local server). */
  baseURL?: string;
  /** The account has a zero-data-retention agreement; OpenRouter is then asked to use ZDR endpoints only. */
  zdr?: boolean;
  /**
   * Models to list besides models.dev's (for a local server, also besides what its /models reports): ids, or ids with
   * their limits, e.g. ["qwen3:32b"] or { "qwen3:32b": { "context": 32768 } }. A listed model's limits override the catalog's.
   */
  models?: string[] | Record<string, ConfiguredModel>;
  /** A subscription sign-in (/login): the access token is used like a key and refreshed before it expires. */
  oauth?: { accessToken: string; refreshToken?: string; expiresAt: number; scope?: string; accountId?: string };
}

export interface ConfiguredModel {
  name?: string;
  context?: number;
  output?: number;
  reasoning?: boolean;
  images?: boolean;
}

/** "providers" from the config, set once at startup and updated by /auth <provider>. */
let settings: Record<string, ProviderSettings> = {};

export function setProviderSettings(next: Record<string, ProviderSettings> | undefined): void {
  settings = { ...(next ?? {}) };
}

export function providerSettings(id: string): ProviderSettings {
  return settings[id] ?? {};
}

/** The key for a provider and where it came from; undefined when there is none (local servers need none). */
export function providerKey(id: string, env: NodeJS.ProcessEnv = process.env): { key: string; source: string } | undefined {
  const own = providerSettings(id).apiKey?.trim();
  if (own) return { key: own, source: 'config.json' };
  const oauth = providerSettings(id).oauth;
  if (oauth?.accessToken) return { key: oauth.accessToken, source: 'subscription' };
  for (const name of providerDef(id)?.env ?? []) if (env[name]?.trim()) return { key: env[name]!.trim(), source: `env ${name}` };
  return undefined;
}

/** Whether a provider's models count as zero data retention (local, or declared in the config). */
export function providerIsZdr(id: string): boolean {
  return Boolean(providerDef(id)?.local || providerSettings(id).zdr);
}

/** Providers that can be used now: a key is set (config or env), or it runs locally. */
export function availableProviders(env: NodeJS.ProcessEnv = process.env): ProviderDef[] {
  return PROVIDERS.filter((p) => p.local || providerKey(p.id, env));
}

/**
 * Warnings for "providers" entries tessera does not know (they are ignored), with the id that was probably meant:
 * "lm-studio" → lmstudio, "open-ai" → openai, "olama" → ollama.
 */
export function unknownProviderWarnings(configured: Record<string, unknown> | undefined): string[] {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.keys(configured ?? {})
    .filter((id) => !providerDef(id))
    .map((id) => {
      const guess = PROVIDERS.find((p) => squash(p.id) === squash(id)) ?? PROVIDERS.find((p) => editDistance(squash(p.id), squash(id)) <= 2);
      const hint = id === OPENCODE_GO ? ' (the OpenCode Go key is the top-level "apiKey")' : guess ? ` Did you mean "${guess.id}"?` : ' See /providers for the names.';
      return `Unknown provider "${id}" in "providers" (config.json), ignored.${hint}`;
    });
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}
