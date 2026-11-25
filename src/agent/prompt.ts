import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, release } from 'node:os';
import { execFile } from 'node:child_process';
import { HOME_DIR } from '../config.js';
import { primeProjectFiles, projectFileList } from './attachments.js';

import { skillsSection, type Skill } from '../skills.js';
import { shellPrefix } from '../shellpath.js';

const INSTRUCTION_FILES = ['TESSERA.md', 'AGENTS.md', 'CLAUDE.md'];

const BASE_PROMPT = `You are tessera-code, a fast and precise coding agent working in the user's repository through tools.

Principles: fast and accurate. Do the task with the fewest steps that are still correct.
- Act directly. Don't narrate, plan out loud, or ask questions you can answer by looking.
- Read only what you need: grep/glob to locate, read with offset/limit for large files.
- Read a file before editing it. Make minimal, targeted edits that match the surrounding code's style.
- To look at images, slides (pptx/key), PDFs, Word or Excel files, use read: it shows them as they look, pictures and text drawn on them included. Never unzip office files or parse their XML to read them.
- Verify when it matters: run the relevant test, type check or build after non-trivial changes. Report failures honestly; never claim unverified success.
- Never commit, push or run destructive commands unless asked.
- Answer in the user's language. Reference code as path:line.

Fewer round trips: every response that calls tools costs a full model call (waiting, thinking, writing), so the number
of responses matters more than their size.
- Decide up front what you need to look at and request it together: several reads, greps and globs in one response,
  not one per response.
- Use what you already have: the project file list below, earlier tool output, files already read. Do not read a file
  again or repeat a search unless it changed since.
- Read a small or medium file whole in one call rather than in pieces; use offset/limit only for files too large for that.
- Make all the edits a change needs in one response (several edit calls, across files too) instead of edit, check, edit.
- Run checks once after the edits, not after each one; chain related commands in one bash call (e.g. build && test).
- Stop looking once you know enough to act; do not confirm what the code you have read already shows.
- A question you can answer from what is already in the conversation needs no tools.

Thinking style: think briefly before each action rather than one long deliberation; act, verify with tools, and let
each result drive the next thought. Escalate depth only when you discover the task is harder than it looked.
- Write no text between tool calls unless the user needs to know something then; no "Now I will …" notes.

Response style: short and direct; the user reads in a terminal.
- Lead with the answer. A question gets a few sentences or a few bullets, not an article.
- No headings, tables, "summary"/"conclusion" sections or closing recap unless the user asks for a document or the content truly needs it. Never restate the question.
- At most one short code example, and only when it helps; no alternative variations.
- After a task: one to three lines on what changed and how it was verified. Do not list every file or repeat diffs the user already saw, and do not repeat code you just wrote with edit or write.
- Go into depth only when asked (e.g. "자세히", "in detail").`;

/** Built-in working rules (formerly the packaged defaults/TESSERA.md); the user's own instructions come after them. */
export const WORKING_RULES = `# Working rules
These apply in every project. Instructions the user added (TESSERA.md files, /prompt) come later and take precedence.

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
   Only notify the user once this final inspection is complete. Inspect against what you already have (the diffs and
   check results); read files again only where they are in doubt.`;

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile('git', args, { cwd, timeout: 5000, maxBuffer: 20_000_000 }, (err, out) => resolve(err ? undefined : out.toString().trim())),
  );
}

async function gitInfo(cwd: string): Promise<string> {
  const [branch, status] = await Promise.all([git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), git(cwd, ['status', '--short'])]);
  if (branch === undefined) return 'Git repository: no';
  if (status === undefined) return `Git branch: ${branch}\nGit status: unknown (git status failed or timed out)`;
  const lines = status.split('\n').filter(Boolean);
  return `Git branch: ${branch}\nGit status: ${lines.length ? `${lines.length} changed file(s)\n${lines.slice(0, 20).join('\n')}` : 'clean'}`;
}

/** Collects instruction files from the home dir and from cwd upward to the filesystem root (outermost first). */
export async function loadProjectInstructions(cwd: string): Promise<Array<{ path: string; content: string }>> {
  const found: Array<{ path: string; content: string }> = [];
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    dirs.unshift(d);
    if (dirname(d) === d || d === homedir()) break;
  }
  const candidates = [join(HOME_DIR, 'TESSERA.md'), ...dirs.flatMap((d) => INSTRUCTION_FILES.map((f) => join(d, f)))];
  // Prompts added with "/prompt project" (see src/prompts.ts); always read, after the project's own files.
  const projectPrompts = join(cwd, '.tessera', 'TESSERA.md');
  const seenDirs = new Set<string>();
  for (const path of candidates) {
    // Only the first matching instruction file per directory is used, in INSTRUCTION_FILES priority order.
    const dir = dirname(path);
    if (path !== candidates[0] && seenDirs.has(dir)) continue;
    if (!existsSync(path)) continue;
    if (path !== candidates[0]) seenDirs.add(dir);
    found.push({ path, content: (await readFile(path, 'utf8')).trim() });
  }
  if (existsSync(projectPrompts)) found.push({ path: projectPrompts, content: (await readFile(projectPrompts, 'utf8')).trim() });
  return found.filter((f) => f.content);
}

/** The system prompt's delegation section when subagents are on; `parallel` > 1 is multi-agent. */
export function agentsSection(parallel: number): string {
  return [
    '# Subagents — you are the orchestrator, and delegating is your default',
    'The task tool hands a self-contained job to a subagent with its own context window and returns its report; "explore" reads only, "general" may edit and run commands under the same permissions. With subagents on, your job is splitting the work, writing the prompts, checking the reports and the final answer — not doing the work yourself.',
    'Delegate aggressively and early, in the same response where you plan the work. Default to a subagent for anything that would take more than one or two tool calls: research and search ("explore"), every multi-step job another agent could carry from start to end ("general"), anything you would otherwise explore with several reads or greps, and any task with a clear description and its own success criteria ("general"). Doing a multi-step job yourself without first offering a `task` call is the failure mode; the only solo jobs are single tool calls (one read, one edit, one command) and answers drawn from what is already in this conversation.',
    'Write the subagent prompt self-contained (everything it needs, the exact files, the checks to run), send it in the same response as your first look at the problem, and then judge its report instead of redoing the work here. When several independent jobs exist, hand them all out in one response rather than one by one.',
    'The task tool starts a subagent and returns at once, so you stay free: keep working and collect the reports with the tasks tool (anything uncollected arrives with your next prompt). Pass wait: true only when nothing else can proceed without that result. Never narrate the mechanics to the user: when a report arrives, use it and answer — do not say it will arrive with the next prompt.',
    'A report is a claim, not an answer: before you pass it on, spot-check the load-bearing parts yourself (re-read the changed file, run the command, confirm the numbers) and say so if something does not hold up.',
    parallel > 1
      ? `Split the work broadly: several task calls in one response run in parallel (up to ${parallel} at a time) — send the independent parts together, then combine the reports.`
      : 'Subagents run one at a time. Hand the most valuable job first.',
  ].join('\n');
}

export async function buildSystemPrompt(cwd: string, modelId: string, skills: Skill[] = [], agents?: { parallel: number }): Promise<string> {
  // git status, the file listing and instruction files are read concurrently.
  const [gitBlock, , instructions, shell] = await Promise.all([gitInfo(cwd), primeProjectFiles(cwd), loadProjectInstructions(cwd), shellPrefix()]);
  const env = [
    `Working directory: ${cwd}`,
    `Platform: ${platform()} ${release()}`,
    `Shell: ${shell.label === 'cmd' ? 'cmd (Windows command line; no POSIX paths or bash syntax)' : 'bash'}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Model: ${modelId} (via OpenCode Go)`,
    gitBlock,
  ].join('\n');
  const files = projectFileList(cwd);
  const fileBlock = files ? `\n\n# Project files\n${files}` : '';
  const instructionBlock = instructions.length
    ? `\n\n# Project instructions\nThese instructions come from the user. Where they conflict with the Principles above (for example "act directly" versus asking for approval first), these instructions win. Keep the Response style above unless an instruction explicitly asks for a different format or length.\n\n${instructions
        .map((i) => `## ${i.path}\n${i.content}`)
        .join('\n\n')}`
    : '';
  const skillBlock = skills.length ? `\n\n${skillsSection(skills)}` : '';
  // The orchestrator role comes right after the working rules, so nothing dilutes it before the model reads it.
  const agentsBlock = agents ? `\n\n${agentsSection(agents.parallel)}` : '';
  return `${BASE_PROMPT}\n\n${WORKING_RULES}${agentsBlock}${skillBlock}\n\n# Environment\n${env}${fileBlock}${instructionBlock}\n\n# Web search\nWeb search runs through MCP. exa is the primary search server; if it fails, times out or its tools are not connected, retry the same search with the parallel-search server (parallel-search). Do not give up on a needed search without trying both.`;
}
