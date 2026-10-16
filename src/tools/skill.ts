import { tool } from 'ai';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { skillPrompt } from '../skills.js';

/** Loads a skill's instructions (and the list of its files) for the model; see src/skills.ts. */
export function skillTools(ctx: ToolContext) {
  return {
    skill: tool({
      description:
        'Load a skill: packaged instructions (often with scripts or reference files) for a specific kind of task. ' +
        'The available skills are listed in the system prompt under "Skills". Call this before doing a task a skill covers, then follow its instructions.',
      inputSchema: z.object({
        name: z.string().describe('Skill name, as listed under "Skills"'),
        args: z.string().optional().describe('Details of the task for the skill, if any'),
      }),
      execute: async ({ name, args }) => {
        const skills = (await ctx.skills?.()) ?? [];
        const skill = skills.find((s) => s.name === name.trim().toLowerCase());
        if (!skill) throw new Error(`No skill "${name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}.`);
        return skillPrompt(skill, args);
      },
    }),
  };
}
