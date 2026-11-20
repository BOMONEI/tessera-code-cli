import type { ModelMessage } from 'ai';
import { promptText } from '../session/store.js';
import { outputText, toolLabel, toolLabelFull } from './format.js';
import { INTERJECTION_PREFIX } from '../agent/agent.js';

/** A past conversation entry for display (rendering is left to the UI). */
export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; label: string; fullLabel?: string; output: string; lines?: number; isError?: boolean }
  | { kind: 'info'; text: string };

const COMPACTED = 'This session continues from an earlier conversation that was compacted.';
const INTERRUPTED = '[Interrupted by user]';
const FAILED = '[The previous request failed]';

function outputValue(output: unknown): { text: unknown; isError: boolean } {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (o && typeof o === 'object' && 'type' in o) return { text: o.value ?? '', isError: String(o.type).startsWith('error') };
  return { text: output, isError: false };
}

/**
 * Rebuilds what the user saw from stored messages; shows only the last `maxTurns` prompts. `summaries` are finished
 * turns' timing lines (⏱ …), inserted after the turn they describe (`index` is the history length after that turn).
 */
export function transcriptOf(messages: ModelMessage[], maxTurns = 30, summaries: ReadonlyArray<{ index: number; text: string }> = []): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const labels = new Map<string, { label: string; fullLabel?: string }>();
  let turns = 0;
  let skipAck = false;
  let pos = 0; // position in `messages`: a summary whose index is reached sits before the next message
  let si = 0;
  const flushSummaries = () => {
    while (si < summaries.length && summaries[si]!.index <= pos) out.push({ kind: 'info', text: summaries[si++]!.text });
  };
  for (const m of messages) {
    flushSummaries();
    pos++;
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const text = promptText(m).trim();
      if (text.startsWith(COMPACTED)) {
        out.push({ kind: 'info', text: '(earlier conversation was compacted into a summary)' });
        skipAck = true;
        continue;
      }
      if (text.startsWith('The context was compacted mid-task')) continue;
      if (text === INTERRUPTED || text === FAILED) {
        out.push({ kind: 'info', text: text === INTERRUPTED ? 'Interrupted.' : 'The request failed.' });
        continue;
      }
      if (text.startsWith(INTERJECTION_PREFIX)) {
        out.push({ kind: 'user', text: `↳ ${text.slice(INTERJECTION_PREFIX.length).trim()}` });
        continue;
      }
      turns++;
      out.push({ kind: 'user', text });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
      for (const p of parts) {
        if (p.type === 'text' && p.text.trim()) {
          if (skipAck) {
            skipAck = false;
            continue;
          }
          if (p.text.trim() === INTERRUPTED || p.text.trim() === FAILED) out.push({ kind: 'info', text: p.text.trim() === INTERRUPTED ? 'Interrupted.' : 'The request failed.' });
          else out.push({ kind: 'assistant', text: p.text.trim() });
        } else if (p.type === 'tool-call') {
          labels.set(p.toolCallId, { label: toolLabel(p.toolName, p.input), fullLabel: toolLabelFull(p.toolName, p.input) });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        const { text, isError } = outputValue(p.output);
        out.push({ kind: 'tool', label: p.toolName, ...labels.get(p.toolCallId), output: outputText(text), lines: 2, isError });
      }
    }
  }
  flushSummaries(); // a summary of the last turn, and any left over (defensive)
  if (turns <= maxTurns) return out;
  // Cut before the (turns - maxTurns + 1)-th user prompt.
  let seen = 0;
  const start = out.findIndex((e) => e.kind === 'user' && ++seen > turns - maxTurns);
  return [{ kind: 'info', text: `… ${turns - maxTurns} earlier prompts not shown` }, ...out.slice(start)];
}
