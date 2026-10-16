import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { Agent, type AgentOptions, type Usage } from '../agent/agent.js';
import type { ModelInfo } from '../providers/catalog.js';

/**
 * Subagents: the task tool hands a self-contained job to a fresh agent with its own context window and returns its
 * final report. "explore" agents only read (research, broad searches); "general" ones may edit and run commands,
 * through the same permission checks as the main agent. A subagent never gets the task tool itself.
 *
 * Several task calls in one step run concurrently up to `parallel` (multi-agent); with 1 they run one after another.
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
  return Object.fromEntries(Object.entries(tools).filter(([name]) => name !== 'task' && (type === 'general' || READ_ONLY.has(name))));
}

export function taskTool(opts: TaskToolOptions) {
  const limit = semaphore(opts.parallel);
  return {
    task: tool({
      description:
        'Delegate a self-contained task to a subagent with its own context window; you get back its final report. Use "explore" for broad ' +
        'research or searches that need many file reads (read-only), "general" for independent multi-step work. The subagent cannot see ' +
        'this conversation: the prompt must contain everything it needs. Do small tasks yourself instead.',
      inputSchema: z.object({
        description: z.string().describe('3-5 word summary of the task'),
        prompt: z.string().describe('Complete, self-contained instructions for the subagent'),
        subagent_type: z.enum(['explore', 'general']).default('explore'),
      }),
      execute: async ({ description, prompt, subagent_type }, { abortSignal, toolCallId }) => {
        const report = (state: SubagentProgress['state'], activity: string) =>
          opts.onProgress?.({ id: toolCallId, type: subagent_type, description, state, activity });
        return limit(async () => {
          report('running', 'starting');
          const sub = new Agent({
            ...opts.agentOptions(),
            model: opts.model(),
            apiKey: opts.apiKey,
            sessionId: randomUUID(),
            system: await opts.system(subagent_type),
            tools: subagentTools(subagent_type, opts.tools()),
          });
          let text = '';
          const errors: string[] = [];
          let toolCalls = 0;
          for await (const ev of sub.run(prompt, abortSignal)) {
            if (ev.type === 'text') text += ev.text;
            else if (ev.type === 'tool-call') {
              toolCalls++;
              text = ''; // only the text after the last tool call is the report
              const input = (ev.input ?? {}) as Record<string, unknown>;
              const raw = String(input.path ?? input.command ?? input.pattern ?? input.name ?? '').replace(/\s+/g, ' ');
              const arg = (isAbsolute(raw) && !relative(process.cwd(), raw).startsWith('..') ? relative(process.cwd(), raw) || '.' : raw).slice(0, 60);
              report('running', `${ev.name}(${arg})`);
            } else if (ev.type === 'error') errors.push(ev.message);
          }
          opts.onUsage?.(sub.total);
          report('done', errors.length ? 'finished with errors' : 'finished');
          if (abortSignal?.aborted) throw new Error('Interrupted.');
          const result = text.trim() || '(the subagent finished without a report)';
          return `${result}${errors.length ? `\n\n[subagent errors: ${errors.join('; ')}]` : ''}\n\n[${subagent_type} subagent · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}]`;
        }, () => report('queued', 'waiting for a free slot'));
      },
    }),
  };
}
