# Changelog

## 0.3.0 — 2026-10-14

### Added
- `/auth <key>` registers the OpenCode Go API key: it is verified against OpenCode Go (a rejected key is not saved),
  stored as `"apiKey"` in `~/.tessera-code/config.json` (mode 600) and used at once. While typed it is drawn as dots,
  the transcript shows `sk-…abcd`, and it is never kept in the prompt history. `/auth` alone shows the key in use;
  `tessera-code auth <key>` does the same from the shell.
- The exa web search MCP server (`https://mcp.exa.ai/mcp`) comes with every install, in `config.json`; turn it off
  with `"enabled": false`. MCP entries may use opencode's form (`"type"`, `"enabled"`).
- `/command` documents the bottom bar; the ctx gauge shows the limit, e.g. `38% (500k)`.
- One-line install from GitHub Releases: `curl -fsSL https://raw.githubusercontent.com/BOMONEI/tessera-code-cli/main/install.sh | bash`
  (checks Node 22+, verifies the SHA-256, installs with npm; run again to update).

### Changed
- **The API key now comes only from `config.json`** (or `OPENCODE_API_KEY` for one run). An opencode CLI login is no
  longer picked up: run `/auth <key>` once after updating. A key saved by an earlier `tessera-code auth` is moved
  into `config.json` automatically. Without a key the app starts and points to `/auth`.
- New installs start in `default` permission mode (ask before edits, commands and MCP calls) instead of `bypass`.
- Changing the mode with `shift+tab` or `/mode` saves it to `config.json`, so it applies to every project from then
  on. `--permission-mode` still applies to one run only.
- The default context limit is 500k tokens (was 300k).
- The packaged default instructions (`defaults/TESSERA.md`, copied to `~/.tessera-code/TESSERA.md` on first run) are
  general-purpose now: reply in the user's language, verify, no unsolicited commits, ask when unclear. An existing
  `~/.tessera-code/TESSERA.md` is never replaced.

## 0.2.5 — 2026-10-14

### Changed
- Bottom bar, first line: context and Go 5-hour spend are bar gauges (`ctx ▕███░░░░░░░▏ 38%  5h ▕█░░░░░░░░░▏ 1%`;
  green, yellow from 60%, red from 85%). The session's own cost is no longer shown there (`/cost` has it).
- Bottom bar, second line: just `model · thinking level · mode · mcp n/m`. The key hints that were there moved to
  the new `/command`.
- A turn that outgrows `contextLimit` is no longer compacted mid-task: it finishes, then the history is compacted
  right away (with progress), so the next prompt does not wait for it. Mid-turn compaction remains only near the
  model's real window (90%).

### Added
- `/command`: keyboard shortcuts and what each part of the bottom bar means.

## 0.2.4 — 2026-10-14

### Added
- `dangerous` permission mode: runs everything without asking, including destructive commands (`rm -rf`, `sudo`,
  `git push --force`, …) and edits outside the project or in `.git`/`.tessera`/`~/.tessera-code`. Choose it with
  `/mode dangerous`, `--permission-mode dangerous` or `"permissionMode": "dangerous"`; `shift+tab` never cycles into
  it. The bottom bar shows `⚠ dangerous` in bright red. `bypass` is unchanged.
- Line numbers in diffs (edit approvals, the transcript and `--repl`): removed lines carry their old number, added
  and unchanged lines their new one.
- The bottom bar shows MCP servers as `mcp connected/configured` (yellow while starting, red when one failed);
  `/mcp` lists the details.

### Changed
- The startup card and the conversation no longer list MCP servers.

### Fixed
- `bypass` asked for read-only `find … -exec cat {} +`: `find -exec` is now judged by the command it runs
  (`-exec rm -rf`, `-exec sh -c '…'` and `-delete` still ask).
- The spinner vanished once the answer started streaming, so a turn that went on to run tools looked finished. It
  now stays until the turn ends: `Writing`, `Preparing <tool>` while a tool call is written, `Thinking` between
  steps, `Working` for slash commands.

## 0.2.3 — 2026-10-14

### Fixed
- Stale copies of the input box (and of the startup card) piled up on screen in Ghostty-based terminals such as
  cmux when the pane width changed briefly and came back (e.g. 120 → 121 → 120 columns). Any width change now
  redraws the screen, also when the final width equals the one printed at.
- Long Korean (or other wide-character) input no longer covers the input box's right border when it wraps.
- `/model ` (and other argument menus): picking an entry with the arrows and pressing enter now runs it; enter
  without moving still runs the bare command (e.g. shows the current model).

### Added
- `ctrl+l` clears the screen and redraws the conversation, to recover from a terminal that left stale frames.

## 0.2.2 — 2026-10-14

### Added
- Release notes after an update: the first TUI run shows `✨ Updated to x.y.z (from …) · N changes`; `ctrl+o`
  expands the notes for every version since the one last seen. `/changelog [all|x.y.z]` shows them any time.
  A first install shows nothing; the last seen version is kept in `~/.tessera-code/state.json`.

## 0.2.1 — 2026-10-14

### Fixed
- Code blocks in languages the highlighter does not know (e.g. `mermaid`) flooded the TUI with
  "Could not find the language …" warnings while streaming; they now render as plain text.

## 0.2.0 — 2026-10-14

Changes since the 0.1.0 package (commit e004455).

### Changed (behavior)
- **ctrl+c**: copies the selected prompt text; otherwise clears the prompt. Only on an empty prompt does it interrupt
  the running turn or exit (it used to interrupt/exit right away).
- **Default permission mode comes from `~/.tessera-code/config.json`**. The file created on first run sets `bypass`
  (no approval prompts); set `"permissionMode": "default"` to be asked. Resuming a session restores only plan mode.
- **Thinking level is sent explicitly** (`thinkingLevel`, default `medium`) instead of the provider default, which
  started answering later on OpenCode Go (median 8.2s vs 5.2s).
- Startup card: version on its own row (version · model · cwd), fallback models no longer listed.

### Added
- First run creates `~/.tessera-code/config.json` (model, thinking, thinkingLevel, showThinking, permissionMode)
  and `~/.tessera-code/TESSERA.md` from the packaged `defaults/TESSERA.md`; existing files are never overwritten.
- `permissionMode` setting (`default` / `acceptEdits` or `edit` / `plan` / `bypass`); a project can set it only
  once trusted. `--permission-mode` accepts `edit`.
- `/think low|medium|high` and `/think show|hide`; the TUI streams thinking dimly, then folds it into one line.
- `ctrl+o` expands or folds tool output, diffs and thinking (folded by default).
- Prompt text selection with shift+arrows / shift+home/end; typing or backspace replaces it; cmd+c (kitty super+c)
  copies it.
- "✓ clipboard copied!" notice in the HUD after a copy.
- Compaction progress (estimated percentage) for `/compact` and automatic compaction.
- Response time after each turn (`⏱ total (first token …)`) and a live timer next to the spinner.
- `/doctor` reports whether the terminal copies selections (VS Code copyOnSelection, iTerm2, Ghostty, Terminal.app).
- User prompts on a gray band; diffs with full-width green/red backgrounds.

### Fixed
- `^[[?0u` printed above the startup card (and the card drawn one line off) in terminals that answer the kitty
  keyboard query immediately, such as VS Code.
- Clear messages when Node.js is older than 22 or the project has not been built.
- Review fixes from the performance pass: no double-counted spend, interruptible MCP wait, git status reported as
  unknown on failure, exact session ids preferred over prefixes, atomic index/cache writes.

### Performance
- Bundled build with lazy-loaded UI, markdown and providers (`-v` 0.41s → 0.07s, TUI ready 0.43s → 0.27s).
- Kept-alive connection pool warmed at startup; read-only tools start while the model is still streaming.
