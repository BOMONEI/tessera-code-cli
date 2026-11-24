import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** The interpreter that runs shell commands, resolved once per process.
 *  - macOS/Linux: `/bin/bash -c` (as always).
 *  - Windows: Git Bash keeps bash semantics (permissions parsing and the agent's shell habits assume bash);
 *    System32's bash.exe is the WSL launcher (its commands would run in Linux), so it is skipped; without any
 *    bash, cmd.exe runs the command. */
export interface ShellPrefix {
  /** spawn argv0 and its flags; the command string is appended as the last argument. */
  argv: string[];
  label: 'bash' | 'cmd';
}

let cached: Promise<ShellPrefix> | undefined;

export function shellPrefix(): Promise<ShellPrefix> {
  cached ??= (async (): Promise<ShellPrefix> => {
    if (process.platform !== 'win32') return { argv: ['/bin/bash', '-c'], label: 'bash' };
    for (const c of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']) {
      if (existsSync(c)) return { argv: [c, '-c'], label: 'bash' };
    }
    const found = await new Promise<string | undefined>((resolve) =>
      execFile('where', ['bash'], (err, out) => resolve(err ? undefined : out.toString().split('\n')[0]?.trim() || undefined)),
    );
    if (found && !/windows[\\/]system32/i.test(found) && existsSync(found)) return { argv: [found, '-c'], label: 'bash' };
    return { argv: [process.env.COMSPEC ?? 'cmd.exe', '/d', '/s', '/c'], label: 'cmd' };
  })();
  return cached;
}

/** Kills a spawned child and its children (the process group on macOS/Linux, taskkill's tree on Windows). */
export function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean }): void {
  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      } catch {
        child.kill();
      }
      return;
    }
  }
  try {
    process.kill(-child.pid!, 'SIGKILL'); // kill the whole process group
  } catch {
    child.kill('SIGKILL');
  }
}
