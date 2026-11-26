import { streamText, isStepCount, type ModelMessage, type ToolSet, type LanguageModelUsage } from 'ai';
import { createModel, costOf } from '../providers/index.js';
import type { ModelInfo } from '../providers/catalog.js';
import { withFallback, type FallbackState } from '../providers/fallback.js';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { recordSpend } from '../cost/ledger.js';
import { OPENCODE_GO, splitModelId } from '../providers/registry.js';
import { pruneToolResults, splitForCompaction, summarize, compactedHistory, textTokens, estimateMessagesTokens, type CompactProgress } from './compact.js';
import type { ThinkingLevel } from '../config.js';
import { autoLevel, escalateLevel, type AutoLevel } from './effort.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** The model started writing a tool call's arguments (a large write can take a while before 'tool-call'). */
  | { type: 'tool-input-start'; id: string; name: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'step-finish'; usage: Usage }
  /**
   * Also sent when a turn is interrupted or fails (finishReason 'interrupted' / 'error'), with what it used so far.
   * `elapsedMs`: whole turn; `firstOutputMs`: until the model's first output (text, thinking or tool call);
   * `outputMs`: time the model spent writing, summed over the steps (output tokens / outputMs = generation speed).
   * `discarded`: interrupted before the model answered anything; the prompt was left out of the history.
   */
  | { type: 'turn-finish'; usage: Usage; finishReason: string; elapsedMs: number; firstOutputMs?: number; outputMs?: number; discarded?: boolean; readsAfterCompaction?: number; stopNote?: string }
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
  /** With thinking on: skip it for turns whose prompt does not need it (effort.ts). */
  thinkingAuto?: boolean;
  /** Models to retry on when the main model is silent too long (non-ZDR entries are ignored). */
  fallback?: { models: ModelInfo[]; firstTokenTimeoutMs: number; stickyMs: number };
  /** Context window cap: history is compacted automatically before a request would exceed it. */
  contextLimit: number;
  /** Current heads of recently edited files; after a compaction they are re-injected (claude-code restores them). */
  recentFiles?: () => Promise<Array<{ path: string; content: string }>>;
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

/**
 * A bracketed "this turn failed" note at the start of an answer: our own failure notes, and the marker some providers
 * put in place of an empty assistant turn. Models (thinking off especially) copy such notes from the history into the
 * start of their next answer, so the history never shows them as assistant text and answers are cleaned of them.
 */
const FAILURE_NOTE = /^\s*\[(assistant turn failed[^\]\n]*|the previous request failed|interrupted by user)\]\s*/i;
const INTERRUPTED_NOTE = '[Interrupted by user]';
const FAILED_NOTE = '[The previous request failed]';

/** Removes a failure note from the start of an answer. */
export function stripFailureNote(text: string): string {
  return text.replace(FAILURE_NOTE, '');
}

/**
 * History as sent to (and kept for) the model: assistant text starting with a failure note loses it; an assistant
 * message left with nothing visible (no text, no tool call: a reasoning-only step, or a note written as assistant
 * text by older versions) becomes a user note or is dropped, since providers render it as a failure marker.
 */
export function cleanHistory(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') {
      out.push(m);
      continue;
    }
    const note = typeof m.content === 'string' ? m.content.trim() : '';
    if (note === INTERRUPTED_NOTE || note === FAILED_NOTE) {
      out.push({ role: 'user', content: note });
      continue;
    }
    const content = typeof m.content === 'string' ? stripFailureNote(m.content) : m.content.map((p) => (p.type === 'text' ? { ...p, text: stripFailureNote(p.text) } : p));
    const visible = typeof content === 'string' ? content.trim() !== '' : content.some((p) => (p.type === 'text' && p.text.trim() !== '') || p.type === 'tool-call');
    if (visible) out.push({ ...m, content } as ModelMessage);
  }
  return out;
}

/** Drops a trailing assistant whose tool calls never got their results (the step was soft-interrupted mid-run). */
function dropPartialStep(messages: ModelMessage[]): ModelMessage[] {
  const out = [...messages];
  while (out.length) {
    const last = out.at(-1)!;
    if (last.role !== 'assistant') break;
    const calls = Array.isArray(last.content) ? last.content.filter((p) => p.type === 'tool-call') : [];
    const results = new Set(
      out
        .slice(out.indexOf(last) + 1)
        .flatMap((m) => (m.role === 'tool' && Array.isArray(m.content) ? m.content.map((p) => (p.type === 'tool-result' ? p.toolCallId : '')) : [])),
    );
    if (!calls.length || calls.every((c) => results.has(c.toolCallId))) break;
    out.pop();
  }
  return out;
}

/** Typical vision-token cost of one image, for context estimates. */
const IMAGE_TOKENS = 1_500;

export const INTERJECTION_PREFIX = '[Sent by the user while you were working — take it into account from now on]';

const CONTINUE_AFTER_COMPACTION =
  'The context was compacted mid-task to stay under the context limit. Continue the current task from where it left off; re-read files before editing them.';

/** Appended to the history when the step budget ran out mid-task: the turn continues from there, not over. */
const STEP_LIMIT_NOTE =
  '[The turn stopped at the step limit mid-task. Continue the task exactly where it left off — do not redo completed steps.]';
const MAX_STEP_LIMIT_CONTINUES = 2;

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

/** The provider rejected the request because the context no longer fits: the turn must compact and go on. */
function isContextOverflow(e: unknown): boolean {
  const err = e as { statusCode?: number; message?: string; responseBody?: string };
  const text = `${err?.message ?? ''} ${err?.responseBody ?? ''}`.toLowerCase();
  if (err?.statusCode !== 400 && err?.statusCode !== 413) return false;
  return /context|too many (tokens|messages)|prompt is too long|input length|maximum .{0,30}tokens|reduce the length|exceeds/.test(text);
}

/** Transport-level failure (network drop, socket, timeout) rather than an HTTP response with a body. */
function isTransportError(e: unknown): boolean {
  const err = e as { statusCode?: number; responseBody?: string; message?: string };
  if (err?.statusCode || err?.responseBody) return false; // a real HTTP answer: report it, do not retry
  return !err?.message || /network|socket|ECONN|timeout|terminated|fetch failed/i.test(err.message);
}

export class Agent {
  messages: ModelMessage[];
  model: ModelInfo;
  system: string;
  tools: ToolSet;
  readonly total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };
  /** The running turn's usage, so subagents' spend shows in the turn's summary too. */
  private turnUsage?: Usage;
  /** Compaction-quality sample of the running turn: compactions it had and `read` calls that followed each. */
  private compactionSample = { compactions: 0, reads: 0 };
  /** Prompt size of the most recent LLM call: the current context window usage. */
  contextTokens = 0;
  /** Reasoning on/off; applies from the next LLM call. */
  thinking: boolean;
  /** Reasoning effort when thinking is on; applies from the next LLM call. */
  thinkingLevel: ThinkingLevel;
  /** With thinking on: pick the level per turn from the prompt, `thinkingLevel` at most (effort.ts). */
  thinkingAuto: boolean;
  /** The running (or last) turn's reasoning level: in auto, what was picked for it. */
  turnLevel?: AutoLevel;
  private fallbackState: FallbackState = { start: 0, until: 0 };
  /** Progress of a running compaction (manual, before a turn or between steps), for the UI. */
  onCompactProgress?: (p: CompactProgress) => void;
  /** Incremented whenever history is replaced rather than appended to (compaction, clear). */
  generation = 0;
  /** Provider clients per model and session, built once instead of every turn. */
  private models = new Map<string, LanguageModelV4>();
  /** Messages sent during a turn, delivered before its next step. */
  private interjections: string[] = [];
  /** The running attempt's abort; interruptStep() cancels it to cut in without ending the turn. */
  private stepAbort?: AbortController;
  /** Images tools asked to show (read of an image or document), sent with the next step's request. */
  private toolImages: Array<{ label: string; images: ImageInput[] }> = [];

  constructor(private opts: AgentOptions) {
    this.messages = opts.messages ?? [];
    this.model = opts.model;
    this.system = opts.system;
    this.tools = opts.tools;
    this.thinking = opts.thinking;
    this.thinkingLevel = opts.thinkingLevel ?? 'medium';
    this.thinkingAuto = opts.thinkingAuto ?? false;
    // Resumed sessions have no usage data yet; estimate so auto-compaction can still trigger.
    this.contextTokens = estimateTokens(this.messages);
  }

  /** Replaces the whole history (not an append); session stores must rewrite rather than append. */
  replaceHistory(messages: ModelMessage[]): void {
    this.messages = messages;
    this.generation++;
    this.contextTokens = estimateTokens(messages);
  }

  /** Drops the cached provider clients (a refreshed token or a removed key must take effect at once). */
  invalidateModels(): void {
    this.models.clear();
  }

  /** Forget a sticky fallback, e.g. after the user picks a model explicitly. */
  resetFallback(): void {
    this.fallbackState = { start: 0, until: 0 };
  }

  /** Fallback models actually used after the main one (ZDR only, main model excluded). */
  private fallbackChain(): ModelInfo[] {
    // The fallback chain is OpenCode Go's: a model the user picked from another provider is not swapped silently.
    if (this.model.provider) return [];
    return (this.opts.fallback?.models ?? []).filter((m) => m.id !== this.model.id);
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
    // The ledger estimates OpenCode Go's 5-hour/weekly/monthly caps: other providers bill on their own.
    if (splitModelId(model).provider !== OPENCODE_GO) return;
    recordSpend(model, cost).catch(() => {}); // the ledger is best effort; never fail a turn over it
  }


  get sessionId(): string {
    return this.opts.sessionId;
  }

  /** Delivers `text` to the running turn before its next step (after the current tool calls finish). */
  interject(text: string): void {
    this.interjections.push(text);
  }

  /** Soft-interrupt (ctrl+enter): cancels only the running step. The turn goes on and queued messages are injected at once. */
  interruptStep(): void {
    this.stepAbort?.abort();
  }

  /** Takes back a message sent with interject() that the turn has not read yet; false once it was delivered. */
  withdrawInterjection(text: string): boolean {
    const i = this.interjections.lastIndexOf(text);
    if (i < 0) return false;
    this.interjections.splice(i, 1);
    return true;
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

  /** Adds usage spent elsewhere for this session (subagents) to its totals; their spend is already recorded. */
  absorbUsage(u: Usage): void {
    this.addUsage(this.total, u);
    if (this.turnUsage) this.addUsage(this.turnUsage, u);
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

  /** Replaces history with a model-written summary of the older part; a recent tail (kept verbatim) and the
   *  current heads of recently edited files follow it (claude-code restores what it compacted away). Returns the
   *  summary. */
  async compact(focus?: string, abortSignal?: AbortSignal): Promise<string> {
    if (this.messages.length === 0) throw new Error('Nothing to compact.');
    const [toCompress, tail] = splitForCompaction(this.messages);
    const r = await summarize({
      model: this.model,
      apiKey: this.opts.apiKey,
      sessionId: this.opts.sessionId,
      messages: toCompress.length ? toCompress : this.messages,
      focus,
      abortSignal,
      onProgress: this.onCompactProgress,
    });
    const u = toUsage(this.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens } as LanguageModelUsage);
    this.addUsage(this.total, u);
    this.spend(u.cost);
    const history = [...compactedHistory(r.summary), ...(toCompress.length ? tail : [])];
    const files = this.opts.recentFiles ? await this.opts.recentFiles() : [];
    if (files.length) {
      history.push({
        role: 'user',
        content: `Current contents of the files you recently edited (verbatim, may be truncated):\n\n${files
          .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
          .join('\n\n')}`,
      });
    }
    this.replaceHistory(history);
    return r.summary;
  }

  /** Runs one user turn: LLM calls and tool executions until the model stops or maxSteps is reached. */
  async *run(input: string | ModelMessage[], signal?: AbortSignal, images: ImageInput[] = []): AsyncGenerator<AgentEvent> {
    const startedAt = performance.now();
    let firstOutputAt: number | undefined;
    this.toolImages = []; // anything left from an earlier turn (it ended before another step) is stale
    // Compaction-quality sample: how often the model reaches for `read` in the turn right after a compaction.
    // A high number says the tail/summary did not carry enough context; logged by the app for tuning.
    this.compactionSample = { compactions: 0, reads: 0 };
    if (images.length && !this.model.images) {
      yield { type: 'error', message: `${this.model.id} cannot read images. Switch to a model that can (e.g. /model mimo-v2.6-flash) or remove the image.` };
      return;
    }
    const incoming = (typeof input === 'string' ? textTokens(input) : estimateTokens(input)) + images.length * IMAGE_TOKENS;
    if (this.messages.length && this.contextTokens + incoming >= this.contextLimit) {
      const before = this.contextTokens;
      // The free pass first (claude-code's microcompact): clear old tool results — often enough without a summary.
      const pruned = pruneToolResults(this.messages);
      if (pruned) {
        this.replaceHistory(pruned);
        this.contextTokens = estimateTokens(pruned);
        yield { type: 'info', text: 'older tool results cleared to save context' };
      }
      if (this.contextTokens + incoming >= this.contextLimit) {
        try {
          const summary = await this.compact(undefined, signal);
          this.compactionSample.compactions++;          yield { type: 'compacted', before, summary };
        } catch (e) {
          yield { type: 'error', message: `Auto-compaction failed: ${errorMessage(e)}` };
        }
      }
    }
    // Picked on the prompt as typed (before hook context); a resent history (no prompt) thinks at the level.
    this.turnLevel = !this.thinking
      ? 'none'
      : this.thinkingAuto && typeof input === 'string'
        ? autoLevel(input, this.thinkingLevel, { images: images.length > 0, previous: this.turnLevel })
        : this.thinkingLevel;
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
    let history = cleanHistory([...this.messages, ...added]);
    const turn: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };
    this.turnUsage = turn;
    // Writing time: from a step's first output to its end (tool runs and waiting for the first token excluded).
    let outputMs = 0;
    let stepOutputAt: number | undefined;
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
    // The start of each text block is held back while it could still be a failure note (stripFailureNote), and the
    // blank lines after a removed note with it.
    let lead: string | undefined;
    let noteRemoved = false;
    const flushLead = (): AgentEvent | undefined => {
      const text = lead === undefined ? '' : noteRemoved ? lead.trimStart() : lead;
      lead = undefined;
      noteRemoved = false;
      return text ? { type: 'text', text } : undefined;
    };
    // The attempt loop: one streamText call runs the steps (the SDK drives them). A soft interrupt (interruptStep)
    // cancels only the running attempt: the turn restarts with the history so far and the queued messages are
    // injected at once. Steps finished so far count against maxSteps across restarts.
    let stepsSoFar = 0;
    let afterInterrupt = false;
    let stepLimitContinues = 0;
    let streamRetries = 0; // one mid-stream network retry per turn, not per step
    let contextRetried = false; // one compact-and-continue when the provider rejects the context
    // On a context overflow the history (plus this turn's steps) is summarized and the attempt restarts — the
    // provider, not our estimate, is the authority on when the window is full.
    const compactAfterOverflow = async (): Promise<boolean> => {
      try {
        const attempted = completed.length ? [...history, ...completed] : history;
        const [toCompress, tail] = splitForCompaction(attempted);
        const r = await summarize({
          model: this.model,
          apiKey: this.opts.apiKey,
          sessionId: this.opts.sessionId,
          messages: toCompress.length ? toCompress : attempted,
          abortSignal: signal,
          onProgress: this.onCompactProgress,
        });
        const u = toUsage(this.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens } as LanguageModelUsage);
        this.addUsage(turn, u);
        this.addUsage(this.total, u);
        this.spend(u.cost);
        history = [...compactedHistory(r.summary), ...(toCompress.length ? tail : [])];
        completed = [];
        this.replaceHistory(history);
        notices.push({ type: 'compacted', before: estimateMessagesTokens(attempted), summary: r.summary });
        return true;
      } catch {
        return false;
      }
    };
    for (;;) {
      let cutIn = false;
      let retryPending = false; // the attempt died on a network error and a retry cut-in is queued
      let escalated = false; // auto re-judged the thinking level mid-attempt; later steps go out at the new level
      const attempt = new AbortController();
      this.stepAbort = attempt;
      const attempted = (stepsSoFar || afterInterrupt) && completed.length ? [...history, ...completed] : history;
      const result = streamText({
        model: this.languageModel(
          (m) => (served = m),
          (e) => notices.push({ type: 'fallback', ...e }),
          hasImages(attempted),
        ),
        system: this.system,
        // Images from earlier turns are replaced by a note when the current model cannot read them.
        messages: this.model.images ? attempted : withoutImages(attempted),
        tools,
        stopWhen: isStepCount(Math.max(1, this.opts.maxSteps - stepsSoFar)), // a restart must not buy extra steps
        maxOutputTokens: Math.min(this.model.output, MAX_OUTPUT_TOKENS),
        // Mapped to reasoning_effort / thinking budgets per provider; non-reasoning models get no parameter. The level is
        // always explicit: leaving it to the provider default answered noticeably later on OpenCode Go.
        reasoning: this.model.reasoning ? this.turnLevel : undefined,
        maxRetries: 0, // the fallback chain and the turn-level stream retry (below) are the retry policy
        abortSignal: signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal,
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
          // Auto may re-judge between steps: what the tools found (edits, errors, a long loop) says more about the
          // task's difficulty than the prompt did. Escalation only — the earlier steps cannot be un-thought — and
          // capped at the configured level.
          if (this.thinkingAuto && this.model.reasoning && last) {
            const floors: AutoLevel[] = [];
            if (last.toolCalls.some((c) => c.toolName === 'edit' || c.toolName === 'write') || JSON.stringify(last.response.messages).includes('"isError":true')) floors.push('low');
            if (steps.length >= 8 || toolOutput > 50_000) floors.push('medium');
            if (floors.length) {
              const target = escalateLevel(this.turnLevel ?? 'none', floors[floors.length - 1]!, this.thinkingLevel);
              if (target !== this.turnLevel) {
                notices.push({ type: 'info', text: `thinking auto: ${this.turnLevel} → ${target} (the task turned out bigger)` });
                this.turnLevel = target;
                escalated = true;
              }
            }
          }
          // Over contextLimit the turn goes on (it compacts after finishing); only the model's real window forces it now.
          if (last && estimate >= this.hardContextLimit && !compactionFailed) {
            try {
              // The free pass first (claude-code's microcompact); when the context still does not fit, summarize
              // the older part and keep a verbatim tail.
              let rebuilt = messages;
              const pruned = pruneToolResults(messages);
              if (pruned) {
                messages = pruned;
                rebuilt = pruned;
                notices.push({ type: 'info', text: 'older tool results cleared to save context' });
              }
              if (!pruned || estimateMessagesTokens(messages) >= this.hardContextLimit) {
                const [toCompress, tail] = splitForCompaction(messages);
                const r = await summarize({
                  model: this.model,
                  apiKey: this.opts.apiKey,
                  sessionId: this.opts.sessionId,
                  messages: toCompress.length ? toCompress : messages,
                  abortSignal: signal,
                  onProgress: this.onCompactProgress,
                });
                const u = toUsage(this.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens } as LanguageModelUsage);
                this.addUsage(turn, u);
                this.addUsage(this.total, u);
                this.spend(u.cost);
                rebuilt = toCompress.length
                  ? [...compactedHistory(r.summary), ...tail]
                  : [...compactedHistory(r.summary), { role: 'user', content: CONTINUE_AFTER_COMPACTION }];
                notices.push({ type: 'compacted', before: estimate, summary: r.summary });
                this.compactionSample.compactions++;
              }
              history = rebuilt;
              completed = [];
              this.replaceHistory(history);
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
          // A restart's first step has no `last`, but the queued messages must go out just the same.
          const texts = last || afterInterrupt ? this.interjections.splice(0) : [];
          afterInterrupt = false;
          if (texts.length) parts.push({ type: 'text', text: `${INTERJECTION_PREFIX}\n${texts.join('\n\n')}` });
          if (parts.length) {
            const lastNext = next?.at(-1);
            const onContinue = lastNext !== undefined && lastNext.role === 'user' && lastNext.content === CONTINUE_AFTER_COMPACTION;
            if (next && onContinue) {
              // Just compacted without a tail: the history ends with the "continue" user message; fold these into it
              // rather than sending two user messages in a row.
              const merged: ModelMessage = { role: 'user', content: [{ type: 'text', text: CONTINUE_AFTER_COMPACTION }, ...parts] };
              next = [...next.slice(0, -1), merged];
              history = next;
              this.replaceHistory(history);
            } else if (next) {
              // Compacted with a verbatim tail: it ends like normal conversation, so the message just appends.
              const message: ModelMessage = { role: 'user', content: parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts };
              completed.push(message);
              next = [...next, message];
              history = next;
              this.replaceHistory(history);
            } else {
              const message: ModelMessage = { role: 'user', content: parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts };
              completed.push(message); // part of the turn's history, in order after the steps so far
              next = [...messages, message];
            }
            for (const text of texts) notices.push({ type: 'interjection', text });
          }
          // The per-step reasoning override: once auto has re-judged, the later steps of this attempt go out at the
          // new level (the SDK reads `reasoning` from the prepareStep result even though its type omits it).
          if (this.model.reasoning && escalated) return { messages: next ?? messages, reasoning: this.turnLevel } as never;
          return next ? { messages: next } : undefined;
        },
      });
      try {
        for await (const part of result.fullStream) {
          while (notices.length) yield notices.shift()!;
          if (part.type === 'text-start') lead = '';
          else if (lead !== undefined && part.type !== 'text-delta') {
            const e = flushLead();
            if (e) yield e;
          }
          if (part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-start' || part.type === 'tool-call') {
            firstOutputAt ??= performance.now();
            stepOutputAt ??= performance.now();
          }
          switch (part.type) {
            case 'text-delta': {
              if (lead === undefined) {
                yield { type: 'text', text: part.text };
                break;
              }
              lead += part.text;
              const head = lead.trimStart();
              // Undecided while it is a "[" not yet closed (a note is short), or only whitespace so far.
              if (head === '' || (head.startsWith('[') && !head.includes(']') && head.length < 80)) break;
              const stripped = stripFailureNote(lead);
              if (stripped !== lead) {
                lead = stripped;
                noteRemoved = true;
                if (!stripped.trim()) break; // the answer itself has not started yet
              }
              const e = flushLead();
              if (e) yield e;
              break;
            }
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
              if (this.compactionSample.compactions && part.toolName === 'read') this.compactionSample.reads++;
              yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: part.output, isError: false };
              break;
            case 'tool-error':
              yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: errorMessage(part.error), isError: true };
              break;
            case 'finish-step': {
              if (retryPending) break; // bookkeeping for the dead attempt: its partial step is dropped
              stepsSoFar++;
              if (stepOutputAt !== undefined) outputMs += performance.now() - stepOutputAt;
              stepOutputAt = undefined;
              const u = toUsage(served, part.usage);
              this.contextTokens = u.inputTokens + u.outputTokens;
              this.addUsage(turn, u);
              this.addUsage(this.total, u);
              this.spendOn(served.id, u.cost);
              yield { type: 'step-finish', usage: u };
              break;
            }
            case 'finish': {
              // The SDK still sends a trailing finish after a mid-stream error; it belongs to the dead attempt,
              // the retry restarts the turn, so do not end the turn with it.
              if (retryPending) break;
              // The loop stopped at the step budget mid-task (the model's last step wanted tools): auto-continue
              // with a fresh budget and a note, instead of ending the turn as if the model had answered.
              const stepLimit = stepsSoFar >= this.opts.maxSteps && part.finishReason === 'tool-calls';
              if (stepLimit && stepLimitContinues < MAX_STEP_LIMIT_CONTINUES && !signal?.aborted) {
                stepLimitContinues++;
                stepsSoFar = 0; // the continuation gets its own budget; the cap bounds the total
                completed.push({ role: 'user', content: STEP_LIMIT_NOTE });
                afterInterrupt = true; // the note rides the restart: attempted = [...history, ...completed]
                yield { type: 'info', text: `step limit (${this.opts.maxSteps}) reached — continuing automatically (${stepLimitContinues}/${MAX_STEP_LIMIT_CONTINUES})` };
                cutIn = true;
                break;
              }
              finished = true;
              yield {
                type: 'turn-finish',
                usage: turn,
                finishReason: part.finishReason,
                elapsedMs: performance.now() - startedAt,
                firstOutputMs: firstOutputAt === undefined ? undefined : firstOutputAt - startedAt,
                outputMs,
                ...(part.finishReason === 'length'
                  ? { stopNote: 'output limit reached — the answer was cut; send any prompt to continue' }
                  : stepLimit
                    ? { stopNote: `step limit (${this.opts.maxSteps}) reached after ${MAX_STEP_LIMIT_CONTINUES + 1} × ${this.opts.maxSteps} steps — send any prompt to continue` }
                    : {}),
                ...(this.compactionSample.compactions ? { readsAfterCompaction: this.compactionSample.reads } : {}),
              };
              break;
            }
            case 'error':
              // A soft interrupt can surface as an error part; it ends the attempt, not the turn.
              if (attempt.signal.aborted && !signal?.aborted) cutIn = true;
              else if (!signal?.aborted && !contextRetried && isContextOverflow(part.error)) {
                // The context outgrew the window: summarize and continue instead of dying at 100%.
                contextRetried = true;
                retryPending = true; // the trailing finish of the dead attempt must not end the turn
                notices.push({ type: 'info', text: 'context limit reached — compacting and continuing' });
                if (await compactAfterOverflow()) cutIn = true;
                else {
                  failed = true;
                  yield { type: 'error', message: errorMessage(part.error) };
                }
              } else if (streamRetries < 1 && !signal?.aborted && isTransportError(part.error)) {
                // The stream died mid-turn (network): restart the attempt once instead of failing the turn.
                streamRetries++;
                retryPending = true;
                yield { type: 'info', text: 'stream dropped — retrying once (network)' };
                cutIn = true;
              } else {
                failed = true;
                if (!signal?.aborted) yield { type: 'error', message: errorMessage(part.error) };
              }
              break;
            case 'abort':
              // A soft interrupt ends the attempt, not the turn; the user's own interrupt still ends it.
              if (attempt.signal.aborted && !signal?.aborted) cutIn = true;
              else {
                failed = true;
                // Never die silently: the user sees why the turn stopped (network deaths arrive as 'error' parts).
                if (!signal?.aborted) yield { type: 'error', message: 'The connection dropped mid-answer.' };
              }
              break;
          }
        }
      } catch (e) {
        if (attempt.signal.aborted && !signal?.aborted) cutIn = true;
        else if (!signal?.aborted && !contextRetried && isContextOverflow(e)) {
          contextRetried = true;
          retryPending = true;
          notices.push({ type: 'info', text: 'context limit reached — compacting and continuing' });
          if (await compactAfterOverflow()) cutIn = true;
          else {
            failed = true;
            yield { type: 'error', message: errorMessage(e) };
          }
        } else if (streamRetries < 1 && !signal?.aborted && isTransportError(e)) {
          streamRetries++;
          retryPending = true;
          yield { type: 'info', text: 'stream dropped — retrying once (network)' };
          cutIn = true;
        } else {
          failed = true;
          if (!signal?.aborted) yield { type: 'error', message: errorMessage(e) };
        }
      }
      if (cutIn) {
        // Soft interrupt: drop the partial step (its tool calls never got results), hand the queued messages to the
        // next attempt's first step, and continue the turn right away.
        lead = undefined;
        noteRemoved = false;
        completed = dropPartialStep(completed);
        afterInterrupt = true;
        continue;
      }
      break;
    }
    this.stepAbort = undefined;
    const rest = flushLead();
    if (rest) yield rest;
    completed = cleanHistory(completed);
    while (notices.length) yield notices.shift()!;
    this.turnUsage = undefined;
    // Interrupted before any output: the turn never happened (the UI hands the prompt back for editing).
    const discarded = !finished && !!signal?.aborted && firstOutputAt === undefined && completed.length === 0;
    if (!finished) {
      yield {
        type: 'turn-finish',
        usage: turn,
        finishReason: signal?.aborted ? 'interrupted' : 'error',
        elapsedMs: performance.now() - startedAt,
        firstOutputMs: firstOutputAt === undefined ? undefined : firstOutputAt - startedAt,
        outputMs,
        ...(discarded ? { discarded } : {}),
        ...(this.compactionSample.compactions ? { readsAfterCompaction: this.compactionSample.reads } : {}),
      };
    }
    if (discarded) return;

    if (finished && !failed) {
      // Completed normally (an interrupt arriving after the final step does not discard the answer).
      this.messages = [...history, ...completed];
      // The context outgrew the limit during this turn: compact now, while the user reads the answer, instead of
      // making the next prompt wait for it.
      if (this.contextTokens >= this.contextLimit && !signal?.aborted) {
        const before = this.contextTokens;
        const pruned = pruneToolResults(this.messages);
        if (pruned) {
          this.replaceHistory(pruned);
          this.contextTokens = estimateTokens(pruned);
          yield { type: 'info', text: 'older tool results cleared to save context' };
        }
        if (this.contextTokens >= this.contextLimit) {
          try {
            const summary = await this.compact(undefined, signal);
            this.compactionSample.compactions++;
            yield { type: 'compacted', before, summary };
          } catch (e) {
            if (!signal?.aborted) yield { type: 'error', message: `Auto-compaction failed: ${errorMessage(e)}` };
          }
        }
      }
      await this.opts.afterTurn?.();
      return;
    }
    // Keep finished steps so the model remembers edits already applied; drop only the partial last step
    // (a tool call without its result would make the next request invalid).
    // The note is a user message, never assistant text: the model would copy it into its next answer.
    this.messages = [...history, ...completed, { role: 'user', content: signal?.aborted ? INTERRUPTED_NOTE : FAILED_NOTE }];
  }
}

/** Tool results carry their text in `value` when structured; anything else counts as its JSON. */
function outputTextOf(output: unknown): string {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (o && typeof o === 'object' && 'type' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value ?? '');
  return typeof output === 'string' ? output : JSON.stringify(output ?? '');
}

/** Rough token estimate for histories without usage data: text content only (no JSON overhead), CJK weighted per
 *  character so Korean histories are not under-counted, and images at a fixed cost. */
export function estimateTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  let images = 0;
  for (const m of messages) {
    tokens += 8; // roles, ids and the like
    const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    for (const p of parts) {
      if (isImagePart(p)) {
        images++;
      } else if ('text' in p && typeof p.text === 'string') {
        tokens += textTokens(p.text);
      } else if (p.type === 'tool-call') {
        tokens += textTokens(JSON.stringify(p.input ?? ''));
      } else if (p.type === 'tool-result') {
        tokens += textTokens(outputTextOf(p.output));
      } else {
        tokens += textTokens(JSON.stringify(p));
      }
    }
  }
  return tokens + images * IMAGE_TOKENS;
}
