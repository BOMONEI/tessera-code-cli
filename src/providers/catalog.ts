import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME_DIR } from '../config.js';

/** Which wire protocol a Go model speaks. */
export type ApiFormat = 'chat' | 'messages' | 'responses';

export interface ModelInfo {
  id: string;
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

export function parseCatalog(json: unknown): ModelInfo[] {
  const provider = (json as Record<string, { npm?: string; models?: Record<string, ModelsDevModel> }>)['opencode-go'];
  if (!provider?.models) return [];
  const defaultFormat = FORMAT_BY_NPM[provider.npm ?? ''] ?? 'chat';
  return Object.entries(provider.models)
    .filter(([, m]) => m.tool_call !== false)
    .map(([id, m]) => ({
      id,
      name: m.name ?? id,
      format: FORMAT_BY_NPM[m.provider?.npm ?? ''] ?? defaultFormat,
      context: m.limit?.context ?? 128_000,
      output: m.limit?.output ?? 32_000,
      reasoning: m.reasoning ?? false,
      images: m.modalities?.input?.includes('image') ?? false,
      cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cache_read ?? 0 },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function readCache(): Promise<{ models: ModelInfo[]; ageMs: number } | undefined> {
  try {
    const s = await stat(CACHE_FILE);
    const models = parseCatalog(JSON.parse(await readFile(CACHE_FILE, 'utf8')));
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
    await writeFile(tmp, JSON.stringify({ 'opencode-go': (json as Record<string, unknown>)['opencode-go'] }));
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
  return (await fetchCatalog()) ?? (await readCache())?.models ?? FALLBACK;
}

export function findModel(catalog: ModelInfo[], id: string): ModelInfo {
  const hit = catalog.find((m) => m.id === id);
  if (hit) return hit;
  // Unknown to the catalog: assume OpenAI-compatible chat with conservative limits.
  return { id, name: id, format: 'chat', context: 128_000, output: 32_000, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0 } };
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

