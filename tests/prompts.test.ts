import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { GLOBAL_INSTRUCTIONS, HOME_DIR, ensureGlobalDefaults } = await import('../src/config.js');
const { SECTION, addPrompt, listPrompts, promptFile, removePrompt } = await import('../src/prompts.js');
const { buildSystemPrompt, loadProjectInstructions, WORKING_RULES } = await import('../src/agent/prompt.js');
const { runCommand } = await import('../src/commands.js');

const project = () => mkdtempSync(join(tmpdir(), 'tessera-prompt-'));

beforeEach(() => {
  mkdirSync(HOME_DIR, { recursive: true });
  rmSync(GLOBAL_INSTRUCTIONS, { force: true });
});

describe('prompt files', () => {
  it('global prompts go to ~/.tessera-code/TESSERA.md, project ones to <project>/.tessera/TESSERA.md', () => {
    const cwd = project();
    expect(promptFile('global', cwd)).toBe(GLOBAL_INSTRUCTIONS);
    expect(promptFile('project', cwd)).toBe(join(cwd, '.tessera', 'TESSERA.md'));
  });

  it('adds, lists and removes prompts in their own section, keeping the rest of the file', async () => {
    const file = GLOBAL_INSTRUCTIONS;
    writeFileSync(file, 'My own rules\n\n1. Be careful.\n');
    expect(await addPrompt(file, 'Use pnpm, not npm.')).toBe(1);
    expect(await addPrompt(file, 'Write tests first.\nThen the code.')).toBe(2);
    expect(await listPrompts(file)).toEqual(['Use pnpm, not npm.', 'Write tests first.\nThen the code.']);
    expect(readFileSync(file, 'utf8')).toBe(`My own rules\n\n1. Be careful.\n\n${SECTION}\n\n- Use pnpm, not npm.\n- Write tests first.\n  Then the code.\n`);
    expect(await removePrompt(file, 1)).toBe('Use pnpm, not npm.');
    expect(await listPrompts(file)).toEqual(['Write tests first.\nThen the code.']);
    await removePrompt(file, 1);
    expect(readFileSync(file, 'utf8')).toBe('My own rules\n\n1. Be careful.\n'); // the empty section goes away
    await expect(removePrompt(file, 1)).rejects.toThrow(/no prompt 1/);
  });

  it('keeps sections that follow the added prompts', async () => {
    const file = join(project(), '.tessera', 'TESSERA.md');
    await addPrompt(file, 'one');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n## Later notes\nkeep me\n');
    await addPrompt(file, 'two');
    expect(await listPrompts(file)).toEqual(['one', 'two']);
    expect(readFileSync(file, 'utf8')).toContain('## Later notes\nkeep me');
  });

  it('refuses an empty prompt', async () => {
    await expect(addPrompt(GLOBAL_INSTRUCTIONS, '   ')).rejects.toThrow(/empty/);
  });
});

describe('system prompt', () => {
  it('has the working rules built in, followed by the user\'s global and project prompts', async () => {
    const cwd = project();
    await addPrompt(GLOBAL_INSTRUCTIONS, 'GLOBAL-RULE-X');
    await addPrompt(promptFile('project', cwd), 'PROJECT-RULE-Y');
    const system = await buildSystemPrompt(cwd, 'm');
    expect(system).toContain(WORKING_RULES);
    expect(WORKING_RULES).toContain('FINAL INSPECTION');
    const [rules, global, local] = ['# Working rules', 'GLOBAL-RULE-X', 'PROJECT-RULE-Y'].map((s) => system.indexOf(s)) as [number, number, number];
    expect(rules).toBeGreaterThan(-1);
    expect(global).toBeGreaterThan(rules);
    expect(local).toBeGreaterThan(global);
  });

  it('reads the project prompt file next to a root TESSERA.md, without hiding it', async () => {
    const cwd = project();
    writeFileSync(join(cwd, 'AGENTS.md'), 'team rules');
    await addPrompt(promptFile('project', cwd), 'mine');
    const files = (await loadProjectInstructions(cwd)).map((f) => f.content);
    expect(files).toContain('team rules');
    expect(files.some((c) => c.includes('mine'))).toBe(true);
  });
});

describe('/prompt', () => {
  function fakeApp(cwd = project()) {
    let reloads = 0;
    const app = { ctx: { cwd }, reloadInstructions: async () => void reloads++ };
    return { app: app as never, cwd, reloads: () => reloads };
  }

  it('adds to the chosen scope and reloads the instructions', async () => {
    const { app, cwd, reloads } = fakeApp();
    expect((await runCommand(app, '/prompt global Always use pnpm')).output).toMatch(/~\/\.tessera-code\/TESSERA\.md as g1/);
    expect((await runCommand(app, '/prompt project Run make lint first')).output).toMatch(/\.tessera\/TESSERA\.md as p1/);
    expect(await listPrompts(GLOBAL_INSTRUCTIONS)).toEqual(['Always use pnpm']);
    expect(await listPrompts(promptFile('project', cwd))).toEqual(['Run make lint first']);
    expect(reloads()).toBe(2);
    const listing = (await runCommand(app, '/prompt')).output!;
    expect(listing).toContain('g1. Always use pnpm');
    expect(listing).toContain('p1. Run make lint first');
  });

  it('asks for the scope when none is given', async () => {
    const { app, cwd } = fakeApp();
    const r = await runCommand(app, '/prompt Prefer small functions');
    expect(r.choose?.options.map((o) => o.label)).toEqual(['Every project (global)', 'This project only']);
    await r.choose!.select(1);
    expect(await listPrompts(promptFile('project', cwd))).toEqual(['Prefer small functions']);
    expect(existsSync(GLOBAL_INSTRUCTIONS)).toBe(false);
  });

  it('removes by key, and explains its usage', async () => {
    const { app } = fakeApp();
    await runCommand(app, '/prompt global first');
    await runCommand(app, '/prompt global second');
    expect((await runCommand(app, '/prompt remove g1')).output).toBe('Removed from ~/.tessera-code/TESSERA.md: first');
    expect(await listPrompts(GLOBAL_INSTRUCTIONS)).toEqual(['second']);
    expect((await runCommand(app, '/prompt project')).output).toMatch(/^Usage/);
    await expect(runCommand(app, '/prompt remove p9')).rejects.toThrow(/no prompt 9/);
  });
});

describe('old default instructions', () => {
  // The default rules copied to ~/.tessera-code/TESSERA.md by 0.3.3 (now built into the system prompt).
  const OLD_033 = `These instructions apply to every project. Edit ~/.tessera-code/TESSERA.md to change them; a TESSERA.md (or AGENTS.md / CLAUDE.md) in a project adds that project's own rules.

1. LANGUAGE: Reply in the language the user writes in. Keep code, identifiers and technical terms as they are.

2. VERIFY: After a change, check that it works — build, run the relevant tests, or run the code — and say what you checked. If you could not verify something, say so instead of assuming it works.

3. NO UNSOLICITED COMMITS: Do not git commit or git push unless the user asks for it.

4. FOLLOW THE PROJECT: Match the existing code style, naming, structure and commit conventions. Read the surrounding code before changing it.

5. ASK WHEN UNCLEAR: If a requirement is ambiguous or needs a design decision, ask before acting. When there are several reasonable approaches, recommend one and say why.

6. KEEP CHANGES FOCUSED: Change only what the task needs. Do not refactor unrelated code or add features that were not requested. Preserve existing behavior unless asked to change it.

7. SECURITY: Never put secrets (API keys, tokens, passwords) in code, logs or commits. Validate untrusted input. Be careful with destructive commands (deleting files, force pushes, database changes) and confirm before running them.

8. ERRORS: Handle errors where they can occur, with messages that say what went wrong and what to do. Do not silently swallow failures.

9. DEPENDENCIES: Before adding a new library or tool, say why it is needed and what the alternatives are.

10. FINAL INSPECTION: After completing any modification, perform a final inspection before reporting to the user. Confirm that:
   - All requirements are fully satisfied.
   - No edge cases have been overlooked.
   - No side effects or unintended regressions have been introduced.
   Only notify the user once this final inspection is complete.
`;

  it('removes an unedited copy (the rules are built in now) and keeps an edited one', async () => {
    writeFileSync(GLOBAL_INSTRUCTIONS, OLD_033);
    await ensureGlobalDefaults();
    expect(existsSync(GLOBAL_INSTRUCTIONS)).toBe(false);
    writeFileSync(GLOBAL_INSTRUCTIONS, OLD_033 + '\n11. My own rule.\n');
    await ensureGlobalDefaults();
    expect(readFileSync(GLOBAL_INSTRUCTIONS, 'utf8')).toContain('11. My own rule.');
  });
});
