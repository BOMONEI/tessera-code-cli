import { tool } from 'ai';
import { z } from 'zod';
import { type ToolContext } from './context.js';

/** The session-memory tool: the user says "remember this" and the note rides every later prompt of the session. */
export function memoTools(ctx: ToolContext) {
  return {
    memo: tool({
      description:
        "Save a note to this session's memory. Use it when the user asks you to remember something (\"remember this\", \"save to memory\", \"메모리에 저장해줘\"), or when they state a lasting preference or constraint worth keeping. The note is sent back to you with every prompt of this session. Keep each note self-contained in one sentence; never store secrets (keys, tokens).",
      inputSchema: z.object({
        text: z.string().describe('The note itself, self-contained, one sentence'),
      }),
      execute: async ({ text }) => {
        if (!ctx.addMemo) return 'Session memories are unavailable here.';
        const note = text.trim().slice(0, 2_000);
        if (!note) return 'The note is empty; nothing was saved.';
        await ctx.addMemo(note);
        return `Memorized for this session: "${note}" — it rides every prompt of this session, so you will see it again.`;
      },
    }),
  };
}
