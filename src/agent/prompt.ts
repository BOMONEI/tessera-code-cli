import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, release } from 'node:os';
import { execFile } from 'node:child_process';
import { HOME_DIR } from '../config.js';
import { primeProjectFiles, projectFileList } from './attachments.js';

import { skillsSection, type Skill } from '../skills.js';

const INSTRUCTION_FILES = ['TESSERA.md', 'AGENTS.md', 'CLAUDE.md'];

const BASE_PROMPT = `You are tessera-code, a fast and precise coding agent working in the user's repository through tools.

Principles: fast and accurate. Do the task with the fewest steps that are still correct.
- Act directly. Don't narrate, plan out loud, or ask questions you can answer by looking.
- Read only what you need: grep/glob to locate, read with offset/limit for large files. Batch independent tool calls in one response.
- Read a file before editing it. Make minimal, targeted edits that match the surrounding code's style.
- To look at images, slides (pptx/key), PDFs, Word or Excel files, use read: it shows them as they look, pictures and text drawn on them included. Never unzip office files or parse their XML to read them.
- Verify when it matters: run the relevant test, type check or build after non-trivial changes. Report failures honestly; never claim unverified success.
- Never commit, push or run destructive commands unless asked.
- Answer in the user's language. Reference code as path:line.

Response style: short and direct; the user reads in a terminal.
- Lead with the answer. A question gets a few sentences or a few bullets, not an article.
- No headings, tables, "summary"/"conclusion" sections or closing recap unless the user asks for a document or the content truly needs it. Never restate the question.
- At most one short code example, and only when it helps; no alternative variations.
- After a task: one to three lines on what changed and how it was verified. Do not list every file or repeat diffs the user already saw.
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
   Only notify the user once this final inspection is complete.`;

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
    '# Subagents',
    'The task tool hands a self-contained job to a subagent with its own context window and returns its report. Use it for broad research that needs many file reads ("explore", read-only) or for independent multi-step work ("general"), so this conversation stays focused. The subagent cannot see this conversation: put everything it needs in the prompt. Do small tasks yourself; delegating costs a round trip.',
    parallel > 1
      ? `Several task calls in one response run in parallel (up to ${parallel} at a time): split independent work that way, then combine the reports.`
      : 'Subagents run one at a time.',
  ].join('\n');
}

export async function buildSystemPrompt(cwd: string, modelId: string, skills: Skill[] = [], agents?: { parallel: number }): Promise<string> {
  // git status, the file listing and instruction files are read concurrently.
  const [gitBlock, , instructions] = await Promise.all([gitInfo(cwd), primeProjectFiles(cwd), loadProjectInstructions(cwd)]);
  const env = [
    `Working directory: ${cwd}`,
    `Platform: ${platform()} ${release()}`,
    `Shell: bash`,
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
  const agentsBlock = agents ? `\n\n${agentsSection(agents.parallel)}` : '';
  return `${BASE_PROMPT}\n\n${WORKING_RULES}${skillBlock}${agentsBlock}\n\n# Environment\n${env}${fileBlock}${instructionBlock}`;
}
