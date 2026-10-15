import { streamText, isStepCount, type ModelMessage, type ToolSet, type LanguageModelUsage } from 'ai';
import { createModel, costOf } from '../providers/index.js';
import { isZdr, type ModelInfo } from '../providers/catalog.js';
import { withFallback, type FallbackState } from '../providers/fallback.js';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { recordSpend } from '../cost/ledger.js';
import { summarize, compactedHistory, type CompactProgress } from './compact.js';
import type { ThinkingLevel } from '../config.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** The model started writing a tool call's arguments (a large write can take a while before 'tool-call'). */
  | { type: 'tool-input-start'; id: string; name: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'step-finish'; usage: Usage }
  /** `elapsedMs`: whole turn; `firstOutputMs`: until the model's first output (text, thinking or tool call). */
  | { type: 'turn-finish'; usage: Usage; finishReason: string; elapsedMs: number; firstOutputMs?: number }
  | { type: 'compacted'; before: number; summary: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'info'; text: string }
  /** A message the user sent mid-turn was handed to the model. */
  | { type: 'interjection'; text: string }
  | { type: 'error'; message: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface AgentOptions {
  model: ModelInfo;
  apiKey: string;
  sessionId: string;
  system: string;
  tools: ToolSet;
  maxSteps: number;
  /** Reasoning on/off for models that support it. */
  thinking: boolean;
  /** Reasoning effort when thinking is on (default medium). */
  thinkingLevel?: ThinkingLevel;
  /** Models to retry on when the main model is silent too long (non-ZDR entries are ignored). */
  fallback?: { models: ModelInfo[]; firstTokenTimeoutMs: number; stickyMs: number };
  /** Context window cap: history is compacted automatically before a request would exceed it. */
  contextLimit: number;
  messages?: ModelMessage[];
  /** UserPromptSubmit hook: may block the prompt or add context to it. */
  beforeTurn?: (prompt: string) => Promise<{ blocked?: string; context?: string; notes?: string[] }>;
  /** Start read-only tools before the model's response is complete (default true; off when hooks are configured). */
  earlyTools?: boolean;
  /** Stop hook: runs after a turn completes successfully. */
  afterTurn?: () => Promise<void>;
}

/** An image attached to a prompt: base64 data (stored as-is in the session) and its media type. */
export interface ImageInput {
  data: string;
  mediaType: string;
}

/** Tools without side effects or approval prompts, safe to start before the model's response is complete. */
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);

/**
 * Read-only tools that start in the SDK's onInputAvailable callback (fired inside the SDK's stream pipeline as soon
 * as a valid call is parsed) and share that run with the SDK's later execute call: whichever comes first starts it,
 * so each call runs exactly once regardless of how fast the UI consumes events.
 */
export function speculative(tools: ToolSet): ToolSet {
  const runs = new Map<string, Promise<unknown>>();
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (!READ_ONLY_TOOLS.has(name) || !execute) {
      out[name] = t;
      continue;
    }
    const once = (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal; messages?: unknown }) => {
      let run = runs.get(options.toolCallId);
      if (!run) {
        run = Promise.resolve().then(() => execute(input as never, { messages: [], ...options } as never));
        runs.set(options.toolCallId, run);
      }
      return run;
    };
    out[name] = {
      ...t,
      onInputAvailable: (o: { input: unknown; toolCallId: string; abortSignal?: AbortSignal }) => {
        void once(o.input, { toolCallId: o.toolCallId, abortSignal: o.abortSignal }).catch(() => {}); // reported by execute
      },
      execute: once,
    } as typeof t;
  }
  return out;
}

/** An image content part: `image` parts, or `file` parts with an image media type. */
export function isImagePart(p: unknown): boolean {
  const part = p as { type?: string; mediaType?: string } | null;
  return Boolean(part && typeof part === 'object' && (part.type === 'image' || (part.type === 'file' && part.mediaType?.startsWith('image/'))));
}

export function hasImages(messages: ModelMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && (m.content as unknown[]).some(isImagePart));
}

/** History for a text-only model: each image becomes a short note. */
export function withoutImages(messages: ModelMessage[]): ModelMessage[] {
  if (!hasImages(messages)) return messages;
  return messages.map((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? { ...m, content: m.content.map((p) => (isImagePart(p) ? { type: 'text' as const, text: '[image omitted: the current model cannot read images]' } : p)) }
      : m,
  );
}

/** Typical vision-token cost of one image, for context estimates. */
const IMAGE_TOKENS = 1_500;

export const INTERJECTION_PREFIX = '[Sent by the user while you were working — take it into account from now on]';

const CONTINUE_AFTER_COMPACTION =
  'The context was compacted mid-task to stay under the context limit. Continue the current task from where it left off; re-read files before editing them.';

// Output cap per step; also sidesteps the Anthropic SDK's 4096 default for models it does not recognize.
const MAX_OUTPUT_TOKENS = 32_000;

function toUsage(info: ModelInfo, u: LanguageModelUsage): Usage {
  const usage = {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
  };
  return { ...usage, cost: costOf(info, usage) };
}

export function errorMessage(e: unknown): string {
  const err = e as { responseBody?: string; message?: string; statusCode?: number };
  if (err?.responseBody) {
    try {
      const body = JSON.parse(err.responseBody);
      const msg = body?.error?.message ?? body?.message;
      if (msg) return `${err.statusCode ?? ''} ${msg}`.trim();
    } catch {
      // not JSON; use the raw body below
    }
    return `${err.statusCode ?? ''} ${err.responseBody.slice(0, 500)}`.trim();
  }
  return err?.message ?? String(e);
}

export class Agent {
  messages: ModelMessage[];
  model: ModelInfo;
  system: string;
  tools: ToolSet;
  readonly total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };
  /** Prompt size of the most recent LLM call: the current context window usage. */
  contextTokens = 0;
  /** Reasoning on/off; applies from the next LLM call. */
  thinking: boolean;
  /** Reasoning effort when thinking is on; applies from the next LLM call. */
  thinkingLevel: ThinkingLevel;
  private fallbackState: FallbackState = { start: 0, until: 0 };
  /** Progress of a running compaction (manual, before a turn or between steps), for the UI. */
  onCompactProgress?: (p: CompactProgress) => void;
  /** Incremented whenever history is replaced rather than appended to (compaction, clear). */
  generation = 0;
  /** Provider clients per model and session, built once instead of every turn. */
  private models = new Map<string, LanguageModelV4>();
  /** Messages sent during a turn, delivered before its next step. */
  private interjections: string[] = [];
  /** Images tools asked to show (read of an image or document), sent with the next step's request. */
  private toolImages: Array<{ label: string; images: ImageInput[] }> = [];

  constructor(private opts: AgentOptions) {
    this.messages = opts.messages ?? [];
    this.model = opts.model;
    this.system = opts.system;
    this.tools = opts.tools;
    this.thinking = opts.thinking;
    this.thinkingLevel = opts.thinkingLevel ?? 'medium';
    // Resumed sessions have no usage data yet; estimate so auto-compaction can still trigger.
    this.contextTokens = estimateTokens(this.messages);
  }

  /** Replaces the whole history (not an append); session stores must rewrite rather than append. */
  replaceHistory(messages: ModelMessage[]): void {
    this.messages = messages;
    this.generation++;
    this.contextTokens = estimateTokens(messages);
  }

  /** Forget a sticky fallback, e.g. after the user picks a model explicitly. */
  resetFallback(): void {
    this.fallbackState = { start: 0, until: 0 };
  }

  /** Fallback models actually used after the main one (ZDR only, main model excluded). */
  private fallbackChain(): ModelInfo[] {
    return (this.opts.fallback?.models ?? []).filter((m) => m.id !== this.model.id && isZdr(m.id));
  }

  /** Main model wrapped with the ZDR fallback chain; reports which model served and any switch. */
  private languageModel(onServed: (m: ModelInfo) => void, onFallback: (e: { from: string; to: string; reason: string }) => void, needsImages = false) {
    const mk = (info: ModelInfo) => {
      const key = `${info.id}:${info.format}:${this.opts.sessionId}`;
      let model = this.models.get(key);
      if (!model) this.models.set(key, (model = createModel(info, { apiKey: this.opts.apiKey, sessionId: this.opts.sessionId }) as LanguageModelV4));
      return { info, model };
    };
    const fb = this.opts.fallback;
    // A conversation with images only falls back to models that can read them.
    const extra = this.fallbackChain().filter((m) => !needsImages || m.images);
    return withFallback([mk(this.model), ...extra.map(mk)], {
      firstTokenTimeoutMs: fb?.firstTokenTimeoutMs ?? Number.POSITIVE_INFINITY,
      stickyMs: fb?.stickyMs ?? 0,
      onServed,
      onFallback,
    }, this.fallbackState);
  }

  private spend(cost: number): void {
    this.spendOn(this.model.id, cost);
  }

  private spendOn(model: string, cost: number): void {
    recordSpend(model, cost).catch(() => {}); // the ledger is best effort; never fail a turn over it
  }


  get sessionId(): string {
    return this.opts.sessionId;
  }

  /** Delivers `text` to the running turn before its next step (after the current tool calls finish). */
  interject(text: string): void {
    this.interjections.push(text);
  }

  /** Interjections the turn ended without reading (it was already answering); run them as the next prompts. */
  takeInterjections(): string[] {
    return this.interjections.splice(0);
  }

  /** Continues as another session (resume/fork): its id, history and usage totals. */
  switchSession(id: string, messages: ModelMessage[], total?: Usage): void {
    this.opts.sessionId = id;
    this.interjections = [];
    this.replaceHistory(messages);
    this.resetFallback();
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cost'] as const) this.total[k] = total?.[k] ?? 0;
  }

  get apiKey(): string {
    return this.opts.apiKey;
  }

  /**
   * Shows images to the model: they go out as a user message right after the tool results of the current step.
   * Tool results themselves carry only text, since OpenAI-compatible APIs do not reliably accept images there.
   */
  attachImages(label: string, images: ImageInput[]): void {
    if (images.length) this.toolImages.push({ label, images });
  }

  /** A new key (/auth): models created with the old one are dropped. */
  set apiKey(key: string) {
    this.opts.apiKey = key;
    this.models.clear();
  }

  private addUsage(target: Usage, u: Usage): void {
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cost'] as const) target[k] += u[k];
  }

  /** Effective cap: the configured limit, or 80% of the smallest window in the fallback chain if that is lower. */
  get contextLimit(): number {
    const chain = [this.model, ...this.fallbackChain()];
    const windows = chain.map((m) => m.context).filter((c) => c > 0);
    return Math.min(this.opts.contextLimit, ...windows.map((c) => Math.floor(c * 0.8)));
  }

  /**
   * Where a turn must compact mid-task: 90% of the smallest window in the fallback chain. Between contextLimit and
   * this, a running turn keeps going and compacts once it has finished.
   */
  get hardContextLimit(): number {
    const windows = [this.model, ...this.fallbackChain()].map((m) => m.context).filter((c) => c > 0);
    return windows.length ? Math.max(this.contextLimit, Math.floor(Math.min(...windows) * 0.9)) : this.contextLimit;
  }

  /** Replaces history with a model-written summary. Returns the summary. */
  async compact(focus?: string, abortSignal?: AbortSignal): Promise<string> {
    if (this.messages.length === 0) throw new Error('Nothing to compact.');
    const r = await summarize({ model: this.model, apiKey: this.opts.apiKey, sessionId: this.opts.sessionId, messages: this.messages, focus, abortSignal, onProgress: this.onCompactProgress });
    const u = toUsage(this.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens } as LanguageModelUsage);
    this.addUsage(this.total, u);
    this.spend(u.cost);
    this.replaceHistory(compactedHistory(r.summary));
    return r.summary;
  }

  /** Runs one user turn: LLM calls and tool executions until the model stops or maxSteps is reached. */
  async *run(input: string | ModelMessage[], signal?: AbortSignal, images: ImageInput[] = []): AsyncGenerator<AgentEvent> {
    const startedAt = performance.now();
    let firstOutputAt: number | undefined;
    this.toolImages = []; // anything left from an earlier turn (it ended before another step) is stale
    if (images.length && !this.model.images) {
      yield { type: 'error', message: `${this.model.id} cannot read images. Switch to a model that can (e.g. /model mimo-v2.6-flash) or remove the image.` };
      return;
    }
    const incoming = (typeof input === 'string' ? Math.ceil(input.length / 4) : estimateTokens(input)) + images.length * IMAGE_TOKENS;
    if (this.messages.length && this.contextTokens + incoming >= this.contextLimit) {
      const before = this.contextTokens;
      try {
        const summary = await this.compact(undefined, signal);
        yield { type: 'compacted', before, summary };
      } catch (e) {
        yield { type: 'error', message: `Auto-compaction failed: ${errorMessage(e)}` };
      }
    }
    if (typeof input === 'string' && this.opts.beforeTurn) {
      const r = await this.opts.beforeTurn(input);
      if (r.blocked) {
        yield { type: 'error', message: `Prompt blocked by hook: ${r.blocked}` };
        return;
      }
      for (const text of r.notes ?? []) yield { type: 'info', text };
      if (r.context) input = `${input}\n\n<context>\n${r.context}\n</context>`;
    }
    const added: ModelMessage[] =
      typeof input !== 'string'
        ? input
        : images.length
          ? [{ role: 'user', content: [{ type: 'text', text: input }, ...images.map((i) => ({ type: 'file' as const, data: i.data, mediaType: i.mediaType }))] }]
          : [{ role: 'user', content: input }];
    let history = [...this.messages, ...added];
    const turn: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };
    let failed = false;
    let finished = false;
    // Messages of fully completed steps (assistant + matching tool results); kept even if a later step fails.
    let completed: ModelMessage[] = [];

    let compactionFailed = false;
    let served = this.model;
    const notices: AgentEvent[] = [];
    // Read-only tools start as soon as their call has streamed in, instead of after the model finished its whole
    // response (the SDK runs tools only then). Off when hooks are configured: a call the SDK ends up not running
    // (truncated step) must not fire hooks.
    const tools = this.opts.earlyTools === false ? this.tools : speculative(this.tools);
    const result = streamText({
      model: this.languageModel(
        (m) => (served = m),
        (e) => notices.push({ type: 'fallback', ...e }),
        hasImages(history),
      ),
      system: this.system,
      // Images from earlier turns are replaced by a note when the current model cannot read them.
      messages: this.model.images ? history : withoutImages(history),
      tools,
      stopWhen: isStepCount(this.opts.maxSteps),
      maxOutputTokens: Math.min(this.model.output, MAX_OUTPUT_TOKENS),
      // Mapped to reasoning_effort / thinking budgets per provider; non-reasoning models get no parameter. The level is
      // always explicit: leaving it to the provider default answered noticeably later on OpenCode Go.
      reasoning: this.model.reasoning ? (this.thinking ? this.thinkingLevel : 'none') : undefined,
      maxRetries: (this.opts.fallback?.models.length ?? 0) > 0 ? 0 : 2, // the fallback chain is the retry policy
      abortSignal: signal,
      onError: () => {}, // surfaced through the 'error' stream part instead
      onStepEnd: (step) => {
        completed.push(...step.response.messages);
      },
      // Between steps: compact when a long tool loop outgrew the limit, and hand over messages the user sent
      // while the agent was working (they steer the rest of this turn instead of waiting for it to end).
      prepareStep: async ({ steps, messages }) => {
        let next: ModelMessage[] | undefined;
        const last = steps.at(-1);
        const toolOutput = last ? estimateTokens(last.response.messages.filter((m) => m.role === 'tool')) : 0;
        const estimate = last ? (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0) + toolOutput : 0;
        // Over contextLimit the turn goes on (it compacts after finishing); only the model's real window forces it now.
        if (last && estimate >= this.hardContextLimit && !compactionFailed) {
          try {
            const r = await summarize({ model: this.model, apiKey: this.opts.apiKey, sessionId: this.opts.sessionId, messages, abortSignal: signal, onProgress: this.onCompactProgress });
            const u = toUsage(this.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens } as LanguageModelUsage);
            this.addUsage(turn, u);
            this.addUsage(this.total, u);
            this.spend(u.cost);
            history = [...compactedHistory(r.summary), { role: 'user', content: CONTINUE_AFTER_COMPACTION }];
            completed = [];
            this.replaceHistory(history);
            notices.push({ type: 'compacted', before: estimate, summary: r.summary });
            next = history;
          } catch (e) {
            if (signal?.aborted) throw e;
            compactionFailed = true; // the context will not shrink; do not retry (and pay) on every remaining step
            notices.push({ type: 'error', message: `Auto-compaction failed: ${errorMessage(e)}` });
          }
        }
        // One user message after the tool results: images the tools showed, then messages the user typed meanwhile.
        const parts: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> = [];
        if (last) {
          for (const { label, images } of this.toolImages.splice(0)) {
            parts.push({ type: 'text', text: label }, ...images.map((i) => ({ type: 'file' as const, data: i.data, mediaType: i.mediaType })));
          }
        }
        const texts = last ? this.interjections.splice(0) : [];
        if (texts.length) parts.push({ type: 'text', text: `${INTERJECTION_PREFIX}\n${texts.join('\n\n')}` });
        if (parts.length) {
          if (next) {
            // Just compacted: the history ends with the "continue" user message; fold these into it rather than
            // sending two user messages in a row.
            const merged: ModelMessage = { role: 'user', content: [{ type: 'text', text: CONTINUE_AFTER_COMPACTION }, ...parts] };
            next = [...next.slice(0, -1), merged];
            history = next;
            this.replaceHistory(history);
          } else {
            const message: ModelMessage = { role: 'user', content: parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts };
            completed.push(message); // part of the turn's history, in order after the steps so far
            next = [...messages, message];
          }
          for (const text of texts) notices.push({ type: 'interjection', text });
        }
        return next ? { messages: next } : undefined;
      },
    });

    try {
      for await (const part of result.fullStream) {
        while (notices.length) yield notices.shift()!;
        if (firstOutputAt === undefined && (part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-call')) firstOutputAt = performance.now();
        switch (part.type) {
          case 'text-delta':
            yield { type: 'text', text: part.text };
            break;
          case 'reasoning-delta':
            yield { type: 'reasoning', text: part.text };
            break;
          case 'tool-input-start':
            yield { type: 'tool-input-start', id: part.id, name: part.toolName };
            break;
          case 'tool-call':
            yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case 'tool-result':
            yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: part.output, isError: false };
            break;
          case 'tool-error':
            yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: errorMessage(part.error), isError: true };
            break;
          case 'finish-step': {
            const u = toUsage(served, part.usage);
            this.contextTokens = u.inputTokens + u.outputTokens;
            this.addUsage(turn, u);
            this.addUsage(this.total, u);
            this.spendOn(served.id, u.cost);
            yield { type: 'step-finish', usage: u };
            break;
          }
          case 'finish':
            finished = true;
            yield {
              type: 'turn-finish',
              usage: turn,
              finishReason: part.finishReason,
              elapsedMs: performance.now() - startedAt,
              firstOutputMs: firstOutputAt === undefined ? undefined : firstOutputAt - startedAt,
            };
            break;
          case 'error':
            failed = true;
            if (!signal?.aborted) yield { type: 'error', message: errorMessage(part.error) };
            break;
          case 'abort':
            failed = true;
            break;
        }
      }
    } catch (e) {
      failed = true;
      if (!signal?.aborted) yield { type: 'error', message: errorMessage(e) };
    }
    while (notices.length) yield notices.shift()!;

    if (finished && !failed) {
      // Completed normally (an interrupt arriving after the final step does not discard the answer).
      this.messages = [...history, ...completed];
      // The context outgrew the limit during this turn: compact now, while the user reads the answer, instead of
      // making the next prompt wait for it.
      if (this.contextTokens >= this.contextLimit && !signal?.aborted) {
        const before = this.contextTokens;
        try {
          const summary = await this.compact(undefined, signal);
          yield { type: 'compacted', before, summary };
        } catch (e) {
          if (!signal?.aborted) yield { type: 'error', message: `Auto-compaction failed: ${errorMessage(e)}` };
        }
      }
      await this.opts.afterTurn?.();
      return;
    }
    // Keep finished steps so the model remembers edits already applied; drop only the partial last step
    // (a tool call without its result would make the next request invalid).
    this.messages = [
      ...history,
      ...completed,
      { role: 'assistant', content: signal?.aborted ? '[Interrupted by user]' : '[The previous request failed]' },
    ];
    if (completed.at(-1)?.role === 'assistant') {
      // Two assistant messages in a row are rejected by some providers; merge the note into a user turn instead.
      this.messages[this.messages.length - 1] = { role: 'user', content: signal?.aborted ? '[Interrupted by user]' : '[The previous request failed]' };
    }
  }
}

/** Rough token estimate (~4 chars per token) for histories without usage data; images count a fixed amount. */
export function estimateTokens(messages: ModelMessage[]): number {
  if (!messages.length) return 0;
  let images = 0;
  const json = JSON.stringify(messages, (key, value) => {
    if (isImagePart(value)) {
      images++;
      return '[image]';
    }
    return value;
  });
  return Math.ceil(json.length / 4) + images * IMAGE_TOKENS;
}
