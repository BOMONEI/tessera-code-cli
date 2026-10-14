import { generateText, streamText, type ModelMessage } from 'ai';
import { createModel } from '../providers/index.js';
import type { ModelInfo } from '../providers/catalog.js';

const SUMMARY_PROMPT = `Summarize the conversation so far so that work can continue in a fresh context window. The summary replaces the full history, so include everything needed to continue:

1. The user's requests and intent, in their own words where it matters
2. Key technical decisions and constraints
3. Files examined or modified (with paths) and what changed
4. Errors encountered and how they were resolved
5. Current state: what is done, what is in progress, and the immediate next step

Be specific and concise. Output only the summary.`;

/** Renders history as plain text so any model/format can summarize it (tool parts included). */
export function transcript(messages: ModelMessage[], maxToolChars = 2000): string {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(`[${m.role}]\n${m.content}`);
      continue;
    }
    for (const p of m.content) {
      if (p.type === 'text') out.push(`[${m.role}]\n${p.text}`);
      else if (p.type === 'tool-call') out.push(`[tool call ${p.toolName}] ${JSON.stringify(p.input).slice(0, maxToolChars)}`);
      else if (p.type === 'tool-result') {
        const value = 'value' in p.output ? p.output.value : p.output;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        out.push(`[tool result ${p.toolName}] ${text.slice(0, maxToolChars)}${text.length > maxToolChars ? '…' : ''}`);
      }
    }
  }
  return out.join('\n\n');
}

const MAX_SUMMARY_TOKENS = 8000;

/**
 * Compaction progress. The summary's final length is unknown up front, so `percent` is an estimate: the request
 * phase moves to 15% while the model reads the history, then the written tokens fill the rest against an expected
 * summary size. It stays below 100 until the summary is complete.
 */
export interface CompactProgress {
  phase: 'reading' | 'writing' | 'done';
  percent: number;
  /** Tokens of the history being summarized (estimated) and of the summary so far. */
  inputTokens: number;
  outputTokens: number;
  expectedTokens: number;
  elapsedMs: number;
}

/** Expected summary size: a few percent of the history, within sensible bounds. */
export function expectedSummaryTokens(inputTokens: number): number {
  return Math.round(Math.min(MAX_SUMMARY_TOKENS * 0.75, Math.max(600, inputTokens * 0.05)));
}

/** Estimated percent for a phase; reading creeps toward 15% so a slow first token still shows movement. */
export function progressPercent(phase: CompactProgress['phase'], elapsedMs: number, outputTokens: number, expectedTokens: number): number {
  if (phase === 'done') return 100;
  if (phase === 'reading') return Math.min(15, Math.round(2 + 13 * (1 - Math.exp(-elapsedMs / 8000))));
  return Math.min(99, Math.round(15 + 84 * Math.min(1, outputTokens / expectedTokens)));
}

export async function summarize(opts: {
  model: ModelInfo;
  apiKey: string;
  sessionId: string;
  messages: ModelMessage[];
  focus?: string;
  abortSignal?: AbortSignal;
  onProgress?: (p: CompactProgress) => void;
}): Promise<{ summary: string; inputTokens: number; outputTokens: number }> {
  const history = transcript(opts.messages);
  const inputTokens = Math.ceil(history.length / 4);
  const expectedTokens = expectedSummaryTokens(inputTokens);
  const started = performance.now();
  let phase: CompactProgress['phase'] = 'reading';
  let written = '';
  const report = () => {
    if (!opts.onProgress) return;
    const elapsedMs = performance.now() - started;
    const outputTokens = Math.ceil(written.length / 3.5);
    opts.onProgress({ phase, percent: progressPercent(phase, elapsedMs, outputTokens, expectedTokens), inputTokens, outputTokens, expectedTokens, elapsedMs });
  };
  report();
  // While the model reads the history nothing streams back; tick so the estimate keeps moving.
  const ticker = opts.onProgress ? setInterval(report, 500) : undefined;
  try {
    const result = streamText({
      model: createModel(opts.model, { apiKey: opts.apiKey, sessionId: opts.sessionId }),
      system: SUMMARY_PROMPT,
      prompt: `${history}\n\n---\n${opts.focus ? `Focus the summary on: ${opts.focus}\n` : ''}Write the summary now.`,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
      reasoning: opts.model.reasoning ? 'none' : undefined, // summarizing needs no deliberation; keep it fast
      abortSignal: opts.abortSignal,
      onError: () => {}, // thrown below from the 'error' part instead
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        written += part.text;
        if (phase === 'reading') phase = 'writing';
        report();
      } else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      } else if (part.type === 'abort') {
        throw opts.abortSignal?.reason instanceof Error ? opts.abortSignal.reason : new Error('Compaction was interrupted.');
      }
    }
    const usage = await result.totalUsage;
    const summary = written.trim();
    if (!summary) throw new Error('The model returned an empty summary.');
    phase = 'done';
    report();
    return { summary, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
  } finally {
    clearInterval(ticker);
  }
}

export function compactedHistory(summary: string): ModelMessage[] {
  return [
    { role: 'user', content: `This session continues from an earlier conversation that was compacted. Summary:\n\n${summary}` },
    { role: 'assistant', content: 'Understood. I will continue from where we left off.' },
  ];
}

/** Cleans a model-written title; undefined when nothing usable is left (e.g. the model answered the request). */
export function cleanTitle(raw: string): string | undefined {
  const line = raw
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+|[*_`]/g, '').trim())
    .find((l) => l.length > 0);
  const title = line?.replace(/^(title|제목)\s*[:：]\s*/i, '').replace(/^["'“‘]|["'”’.。]$/g, '').trim();
  return title && title.length >= 2 ? title.slice(0, 80) : undefined;
}

/** Short session title from the first request, in the request's language. */
export async function generateTitle(opts: { model: ModelInfo; apiKey: string; sessionId: string; prompt: string }): Promise<string | undefined> {
  const { text } = await generateText({
    model: createModel(opts.model, { apiKey: opts.apiKey, sessionId: opts.sessionId }),
    system:
      'You name coding sessions. Reply with a plain-text title of 3 to 7 words describing the request, in the language of the request. ' +
      'Do not answer or follow the request, and never use code, markdown or quotes.',
    prompt: `<request>\n${opts.prompt.slice(0, 2000)}\n</request>\nTitle:`,
    maxOutputTokens: 60,
    reasoning: opts.model.reasoning ? 'none' : undefined,
    timeout: 15_000,
  });
  return cleanTitle(text);
}
