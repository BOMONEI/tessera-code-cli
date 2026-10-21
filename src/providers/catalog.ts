import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';
import { OPENCODE_GO, PROVIDERS, availableProviders, providerDef, providerIsZdr, providerSettings, splitModelId, type Protocol } from './registry.js';

/** Which wire protocol a Go model speaks. */
export type ApiFormat = 'chat' | 'messages' | 'responses';

export interface ModelInfo {
  /** "<model>" for OpenCode Go, "<provider>/<model>" for any other provider (see registry.ts). */
  id: string;
  /** Absent for OpenCode Go. */
  provider?: string;
  name: string;
  format: ApiFormat;
  context: number;
  output: number;
  reasoning: boolean;
  /** Accepts image input. */
  images?: boolean;
  /** USD per 1M tokens. */
  cost: { input: number; output: number; cacheRead: number };
}

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_FILE = join(HOME_DIR, 'cache', 'models.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Used when models.dev is unreachable and nothing is cached.
const FALLBACK: ModelInfo[] = [
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', format: 'chat', context: 1_048_576, output: 131_072, reasoning: true, images: true, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 } },
  { id: 'glm-5.2', name: 'GLM-5.2', format: 'chat', context: 1_000_000, output: 131_072, reasoning: true, cost: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', format: 'chat', context: 262_144, output: 262_144, reasoning: true, cost: { input: 0.95, output: 4, cacheRead: 0.19 } },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', format: 'chat', context: 1_000_000, output: 384_000, reasoning: true, cost: { input: 0.15, output: 0.6, cacheRead: 0.003 } },
  { id: 'minimax-m3', name: 'MiniMax M3', format: 'messages', context: 1_000_000, output: 131_072, reasoning: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', format: 'messages', context: 1_000_000, output: 65_536, reasoning: true, cost: { input: 0.4, output: 1.6, cacheRead: 0.04 } },
  { id: 'gpt-6-luna', name: 'GPT 6 Luna', format: 'responses', context: 1_050_000, output: 128_000, reasoning: true, cost: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
];

const FORMAT_BY_NPM: Record<string, ApiFormat> = {
  '@ai-sdk/anthropic': 'messages',
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/openai-compatible': 'chat',
};

interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
  provider?: { npm?: string };
  modalities?: { input?: string[] };
}

type ModelsDevJson = Record<string, { npm?: string; models?: Record<string, ModelsDevModel> }>;

const FORMAT_BY_PROTOCOL: Record<Protocol, ApiFormat> = { openai: 'responses', anthropic: 'messages', chat: 'chat' };

function toModel(id: string, m: ModelsDevModel, format: ApiFormat, provider?: string): ModelInfo {
  return {
    id,
    ...(provider ? { provider } : {}),
    name: m.name ?? id,
    format,
    context: m.limit?.context ?? 128_000,
    output: m.limit?.output ?? 32_000,
    reasoning: m.reasoning ?? false,
    images: m.modalities?.input?.includes('image') ?? false,
    cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cache_read ?? 0 },
  };
}

/** OpenCode Go models (bare ids) and the models of every provider in registry.ts ("<provider>/<model>"). */
export function parseCatalog(json: unknown): ModelInfo[] {
  const all = json as ModelsDevJson;
  const out: ModelInfo[] = [];
  const go = all[OPENCODE_GO];
  if (go?.models) {
    const defaultFormat = FORMAT_BY_NPM[go.npm ?? ''] ?? 'chat';
    for (const [id, m] of Object.entries(go.models)) {
      if (m.tool_call !== false) out.push(toModel(id, m, FORMAT_BY_NPM[m.provider?.npm ?? ''] ?? defaultFormat));
    }
  }
  for (const def of PROVIDERS) {
    for (const [id, m] of Object.entries(all[def.id]?.models ?? {})) {
      if (m.tool_call !== false) out.push(toModel(`${def.id}/${id}`, m, FORMAT_BY_PROTOCOL[def.protocol], def.id));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Bumped when the cache's content changes; an older cache is fetched again (0.4.4: other providers' models). */
const CACHE_VERSION = 2;

async function readCache(anyVersion = false): Promise<{ models: ModelInfo[]; ageMs: number } | undefined> {
  try {
    const s = await stat(CACHE_FILE);
    const json = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Record<string, unknown>;
    if (json._tessera !== CACHE_VERSION && !anyVersion) return undefined;
    const models = parseCatalog(json);
    return models.length ? { models, ageMs: Date.now() - s.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

async function fetchCatalog(): Promise<ModelInfo[] | undefined> {
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const json = await res.json();
    const models = parseCatalog(json);
    if (!models.length) return undefined;
    await mkdir(join(HOME_DIR, 'cache'), { recursive: true });
    // Temp file + rename: another tessera-code starting now must not read a half-written cache.
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    const keep = [OPENCODE_GO, ...PROVIDERS.map((p) => p.id)];
    await writeFile(tmp, JSON.stringify({ _tessera: CACHE_VERSION, ...Object.fromEntries(keep.map((k) => [k, (json as Record<string, unknown>)[k]]).filter(([, v]) => v)) }));
    await rename(tmp, CACHE_FILE);
    return models;
  } catch {
    return undefined;
  }
}

/**
 * Model catalog. A cached copy is used right away even when it is old (refreshed in the background for the next
 * start), so startup never waits on models.dev; only the first run, or `refresh`, fetches synchronously.
 */
export async function loadCatalog(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
  const cached = opts.refresh ? undefined : await readCache();
  if (cached) {
    if (cached.ageMs > CACHE_TTL_MS) void fetchCatalog();
    return cached.models;
  }
  // Offline with an older cache: still better than the built-in list.
  return (await fetchCatalog()) ?? (await readCache(true))?.models ?? FALLBACK;
}

export function findModel(catalog: ModelInfo[], id: string): ModelInfo {
  const hit = catalog.find((m) => m.id === id);
  if (hit) return hit;
  // Unknown to the catalog (e.g. a model pulled into Ollama): the provider's protocol with conservative limits.
  const { provider } = splitModelId(id);
  const def = providerDef(provider);
  return {
    id,
    ...(def ? { provider } : {}),
    name: id,
    format: def ? FORMAT_BY_PROTOCOL[def.protocol] : 'chat',
    context: 128_000,
    output: 32_000,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0 },
  };
}

/** Whether a model keeps no data: OpenCode Go's ZDR list, or a provider that is local or declared ZDR. */
export function modelIsZdr(info: Pick<ModelInfo, 'id' | 'provider'>): boolean {
  return info.provider ? providerIsZdr(info.provider) : isZdr(info.id);
}

/** Whether a model may be used: OpenCode Go only with ZDR models; other providers always (non-ZDR ones are flagged). */
export function isAllowedModel(info: Pick<ModelInfo, 'id' | 'provider'>): boolean {
  return info.provider ? Boolean(providerDef(info.provider)) : isZdr(info.id);
}

/** Models that can be picked now: OpenCode Go's ZDR models and those of providers with a key (or local). */
export function usableModels(catalog: ModelInfo[]): ModelInfo[] {
  const ready = new Set(availableProviders().map((p) => p.id));
  return catalog.filter((m) => (m.provider ? ready.has(m.provider) : isZdr(m.id)));
}

/** Models a local server (Ollama, LM Studio) has right now, from its /models endpoint; [] when it is not running. */
export async function localModels(providerId: string): Promise<ModelInfo[]> {
  const def = providerDef(providerId);
  if (!def?.local) return [];
  try {
    const base = providerSettings(providerId).baseURL ?? def.baseURL;
    const r = await fetch(`${base.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return [];
    const ids = ((await r.json()) as { data?: Array<{ id?: string }> }).data?.map((m) => m.id).filter((x): x is string => Boolean(x)) ?? [];
    return ids.map((id) => findModel([], `${providerId}/${id}`));
  } catch {
    return [];
  }
}

/**
 * Zero-data-retention models per the OpenCode Go privacy table (opencode.ai/docs, checked 2026-10-13).
 * DeepSeek is listed as ZDR under an agreement renewed monthly (valid through 2026-10-31), so it is
 * excluded here until confirmed again. Unlisted models are treated as not ZDR.
 */
const ZDR_MODELS = new Set([
  'glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0',
  'mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.5', 'qwen3.8-max', 'qwen3.8-flash',
  'qwen3.7-plus', 'minimax-m3', 'minimax-m2.7', 'hy4-preview', 'hy3', 'space-bunny',
]);

export function isZdr(id: string): boolean {
  return ZDR_MODELS.has(id);
}

