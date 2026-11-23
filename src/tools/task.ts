import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { Agent, errorMessage, type AgentOptions, type Usage } from '../agent/agent.js';
import type { ModelInfo } from '../providers/catalog.js';

/**
 * Subagents: the task tool hands a self-contained job to a fresh agent with its own context window. "explore" agents
 * only read (research, broad searches); "general" ones may edit and run commands, through the same permission checks
 * as the main agent. A subagent never gets the task or tasks tool itself.
 *
 * The task tool starts the subagent and returns at once: the report is delivered with the next prompt (or listed by
 * the tasks tool). `wait: true` blocks the call until the subagent finishes and returns the report directly. Several
 * calls run concurrently up to `parallel` (multi-agent); with 1 they run one after another.
 */
export type SubagentType = 'explore' | 'general';

/** Read-only tools an explore subagent gets (MCP tools excluded: they may change things elsewhere). */
const READ_ONLY = new Set(['read', 'grep', 'glob', 'skill']);

export const SUBAGENT_ROLES: Record<SubagentType, string> = {
  explore:
    'You are a read-only research subagent. Search and read to answer the task; you cannot modify anything. Your final message goes to ' +
    'the agent that delegated the task, verbatim: make it a concise, self-contained report with file paths and line numbers.',
  general:
    'You are a subagent handling a delegated task end to end. Do it, verify it, and finish with a concise report of what you did and ' +
    'found, with file paths. Your final message goes to the agent that delegated the task, verbatim.',
};

export interface SubagentProgress {
  /** The task call's id: tells concurrent subagents apart. */
  id: string;
  type: SubagentType;
  description: string;
  /** queued: waiting for a free slot; running: working (activity = its current tool call); done: finished. */
  state: 'queued' | 'running' | 'done';
  activity: string;
}

/** One block of a subagent's live tail (the viewer): its reasoning, an answer chunk, or a tool call. */
export interface SubagentBlock {
  kind: 'text' | 'reasoning' | 'tool';
  text: string;
}

/** A finished background subagent's report, delivered once (to the tasks tool or with the next prompt). */
export interface FinishedSubagent {
  id: string;
  type: SubagentType;
  description: string;
  report: string;
  errors: string[];
  toolCalls: number;
}

export interface TaskToolOptions {
  apiKey: string;
  /** The model the main agent is using right now; subagents use the same one. */
  model: () => ModelInfo;
  /** The main agent's current tools (already permission- and hook-guarded). */
  tools: () => ToolSet;
  system: (type: SubagentType) => Promise<string>;
  agentOptions: () => Pick<AgentOptions, 'maxSteps' | 'thinking' | 'thinkingLevel' | 'contextLimit'>;
  /** How many subagents may run at once (1 = one after another). */
  parallel: () => number;
  /** Progress for the UI, one event per change of each subagent (several may run at once). */
  onProgress?: (p: SubagentProgress) => void;
  /** Subagent spend, so the session's totals include it. */
  onUsage?: (usage: Usage) => void;
  /** A background subagent finished and its report was not collected: it goes out with the next prompt. */
  onFinished?: (t: FinishedSubagent) => void;
}

/** Limits how many subagents run at once; waiting ones start in call order. `onWait` runs only if a call has to wait. */
function semaphore(limit: () => number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    while (waiting.length && running < Math.max(1, limit())) {
      running++;
      waiting.shift()!();
    }
  };
  return async <T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> => {
    await new Promise<void>((resolve) => {
      let started = false;
      waiting.push(() => ((started = true), resolve()));
      next();
      if (!started) onWait?.();
    });
    try {
      return await fn();
    } finally {
      running--;
      next();
    }
  };
}

export function subagentTools(type: SubagentType, tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => name !== 'task' && name !== 'tasks' && (type === 'general' || READ_ONLY.has(name))));
}

interface Entry {
  id: string;
  type: SubagentType;
  description: string;
  prompt: string;
  state: SubagentProgress['state'];
  activity: string;
  /** Set when the run finished (or failed, or was interrupted). */
  result?: string;
  errors: string[];
  toolCalls: number;
  /** True once the report was handed out (tasks tool or onFinished); it is not delivered twice. */
  collected?: boolean;
  /** Background runs get their own signal, so they outlive the turn that spawned them. */
  ctrl: AbortController;
  /** Live tail for the viewer: the most recent blocks (reasoning, answer chunks, tool calls). */
  blocks: SubagentBlock[];
}

export function taskTool(opts: TaskToolOptions) {
  const limit = semaphore(opts.parallel);
  const background = new Map<string, Entry>();

  const runner = (t: Entry, abortSignal: AbortSignal | undefined) =>
    limit(
      async () => {
        const report = (state: SubagentProgress['state'], activity: string) => {
          t.state = state;
          t.activity = activity;
          opts.onProgress?.({ id: t.id, type: t.type, description: t.description, state, activity });
        };
        report('running', 'starting');
        const sub = new Agent({
          ...opts.agentOptions(),
          model: opts.model(),
          apiKey: opts.apiKey,
          sessionId: randomUUID(),
          system: await opts.system(t.type),
          tools: subagentTools(t.type, opts.tools()),
        });
        let text = '';
        t.errors = [];
        t.toolCalls = 0;
        // The live tail: reasoning and answer deltas are gathered into blocks, tool calls become one line each.
        let kind: SubagentBlock['kind'] | undefined;
        let buf = '';
        const pushBlock = (b: SubagentBlock) => {
          t.blocks.push(b);
          if (t.blocks.length > 60) t.blocks.splice(0, t.blocks.length - 60); // keep the recent tail only
        };
        const flushBuf = () => {
          if (kind && buf.trim()) pushBlock({ kind, text: buf });
          buf = '';
          kind = undefined;
        };
        for await (const ev of sub.run(t.prompt, abortSignal)) {
          if (ev.type === 'text') {
            if (kind !== 'text') {
              flushBuf();
              kind = 'text';
            }
            buf += ev.text;
            text += ev.text;
          } else if (ev.type === 'reasoning') {
            if (kind !== 'reasoning') {
              flushBuf();
              kind = 'reasoning';
            }
            buf += ev.text;
          } else if (ev.type === 'tool-call') {
            flushBuf();
            t.toolCalls++;
            text = ''; // only the text after the last tool call is the report
            const input = (ev.input ?? {}) as Record<string, unknown>;
            const raw = String(input.path ?? input.command ?? input.pattern ?? input.name ?? '').replace(/\s+/g, ' ');
            const arg = (isAbsolute(raw) && !relative(process.cwd(), raw).startsWith('..') ? relative(process.cwd(), raw) || '.' : raw).slice(0, 60);
            pushBlock({ kind: 'tool', text: `${ev.name}(${arg})` });
            report('running', `${ev.name}(${arg})`);
          } else if (ev.type === 'error') t.errors.push(ev.message);
        }
        flushBuf();
        opts.onUsage?.(sub.total);
        report('done', t.errors.length ? 'finished with errors' : 'finished — report ready');
        if (abortSignal?.aborted) throw new Error('Interrupted.');
        t.result = text.trim() || '(the subagent finished without a report)';
        // The blocking caller gets the decorated report; the background delivery carries the raw report.
        return (
          `${t.result}${t.errors.length ? `\n\n[subagent errors: ${t.errors.join('; ')}]` : ''}` +
          `\n\n[${t.type} subagent · ${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}]`
        );
      },
      () => {
        t.state = 'queued';
        t.activity = 'waiting for a free slot';
        opts.onProgress?.({ id: t.id, type: t.type, description: t.description, state: 'queued', activity: t.activity });
      },
    );

  /** Hands a finished entry's report out once (the tasks tool or the next prompt), then forgets it. */
  const deliver = (t: Entry) => {
    if (t.collected) return;
    t.collected = true;
    opts.onFinished?.({ id: t.id, type: t.type, description: t.description, report: t.result ?? '(no report)', errors: t.errors, toolCalls: t.toolCalls });
    background.delete(t.id);
  };

  return {
    task: tool({
      description:
        'Delegate a self-contained task to a subagent with its own context window. Use "explore" for broad research or searches that need ' +
        'many file reads (read-only), "general" for independent multi-step work. The subagent cannot see this conversation: the prompt must ' +
        'contain everything it needs. You are the orchestrator: past one or two tool calls, hand the job to a subagent instead of doing it ' +
        'here. It starts in the background and returns at once; collect its report with the tasks tool (or it arrives with your next ' +
        'prompt). Pass wait: true only when nothing else can proceed without the result.',
      inputSchema: z.object({
        description: z.string().describe('3-5 word summary of the task'),
        prompt: z.string().describe('Complete, self-contained instructions for the subagent'),
        subagent_type: z.enum(['explore', 'general']).default('explore'),
        wait: z.boolean().optional().describe('true: block until the subagent finishes and return its report now'),
      }),
      execute: async ({ description, prompt, subagent_type, wait }, { abortSignal, toolCallId }) => {
        const t: Entry = { id: toolCallId, type: subagent_type, description, prompt, state: 'queued', activity: 'starting', errors: [], toolCalls: 0, ctrl: new AbortController(), blocks: [] };
        if (wait) return runner(t, abortSignal);
        // Background: the run keeps its own signal, so it outlives the turn (esc and cut-in do not kill it); it is
        // cancelled when the session is replaced.
        background.set(t.id, t);
        runner(t, t.ctrl.signal)
          .then(() => deliver(t))
          .catch((e) => {
            t.state = 'done';
            t.activity = /Interrupted/.test(errorMessage(e)) ? 'interrupted' : 'failed';
            t.result = t.result ?? `(the subagent ${t.activity}: ${errorMessage(e)})`;
            deliver(t);
          });
        return `Background subagent started (${subagent_type}): ${description}. Collect its report with the tasks tool — anything uncollected also arrives with your next prompt.`;
      },
    }),
    tasks: tool({
      description:
        'Check on the background subagents and collect the reports of the finished ones right away (running and queued ones are listed). ' +
        'Anything left running arrives with your next prompt.',
      inputSchema: z.object({}),
      execute: async () => {
        const entries = [...background.values()];
        if (!entries.length) return 'No background subagents.';
        const parts: string[] = [];
        for (const t of entries) {
          if (t.state === 'done' && !t.collected) {
            t.collected = true;
            background.delete(t.id); // collected here: onFinished must not deliver it again
            parts.push(`[report] ${t.type}: ${t.description}\n${t.result ?? '(no report)'}`);
          } else {
            parts.push(`- [${t.state}] ${t.type}: ${t.description} — ${t.activity}`);
          }
        }
        return parts.join('\n\n');
      },
    }),
    /** The live tail of a background subagent (the viewer); undefined when the id is unknown. */
    tail: (id: string) => background.get(id)?.blocks,
    /** Cancels every still-running background subagent (the session is being replaced). */
    cancelAll: () => {
      for (const t of background.values()) if (t.state !== 'done') t.ctrl.abort();
    },
  };
}
