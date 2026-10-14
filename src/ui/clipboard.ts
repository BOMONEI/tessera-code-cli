import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';

const TOOLS: Record<string, Array<[string, string[]]>> = {
  darwin: [['pbcopy', []]],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ],
  win32: [['clip', []]],
};

function pipeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** OSC 52: asks the terminal itself to set the clipboard (works over SSH in most modern terminals). */
function osc52(text: string): boolean {
  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Copies text to the system clipboard; returns how, or undefined when nothing worked. */
export async function copyToClipboard(text: string): Promise<string | undefined> {
  if (!process.env.SSH_TTY) {
    for (const [cmd, args] of TOOLS[process.platform] ?? []) if (await pipeTo(cmd, args, text)) return cmd;
  }
  return osc52(text) ? 'terminal (OSC 52)' : undefined;
}

export interface CopyTarget {
  label: string;
  hint: string;
  text: string;
}

/** Copy choices for an answer: the whole answer, then each fenced code block in it. */
export function copyTargets(answer: string): CopyTarget[] {
  const lines = (s: string) => s.split('\n').length;
  const out: CopyTarget[] = [{ label: 'Whole response', hint: `${lines(answer)} lines`, text: answer }];
  let n = 0;
  for (const m of answer.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm)) {
    const code = m[3]!;
    const first = code.split('\n').find((l) => l.trim()) ?? '';
    out.push({ label: `Code block ${++n}${m[2]!.trim() ? ` (${m[2]!.trim()})` : ''}`, hint: `${lines(code)} lines · ${first.trim().slice(0, 50)}`, text: code });
  }
  return out;
}
