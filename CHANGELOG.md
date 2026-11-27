# Changelog

## 0.7.33 — 2026-11-27

### Added
- **`/account push` and `/account pull` now carry the secrets too — encrypted.** `providers` (API keys and
  subscription tokens) and `mcpServers` (headers, env tokens) travel in a `secrets` field as **AES-256-GCM**
  ciphertext; the key is derived from a sync passphrase with scrypt (a fresh salt every push) and the passphrase
  never leaves the machine — the server stores only what it cannot read. The transport was already TLS; this closes
  the storage side. The passphrase is typed into the same masked box as `/auth` (8+ characters, memory only, never
  written to disk or config), a wrong passphrase or a tampered blob fails the GCM tag check and applies nothing,
  and a pull merges per provider/server id so machines keep what only they have. `hooks` (machine commands) and the
  account's own tokens still never leave the machine, and a plaintext `providers` payload from the server is still
  refused. The KeyPrompt hint reads "type or paste it" now, fitting a passphrase as well as a key.

## 0.7.32 — 2026-11-27

### Fixed
- One criterion decides what a paste is: **only a paste transformPaste rewrote** — the collapsed long-paste
  placeholder or dropped image paths, both carrying a marker — becomes a run (colored, one backspace whole).
  A short paste goes in exactly as typed — plain text, a character at a time — and newline/tab normalization on
  the way in (CRLF line endings, tabs) no longer makes it look like a long one: it used to be recorded as a run,
  so a short paste with Windows line endings was removed whole.

## 0.7.31 — 2026-11-27

### Fixed
- **Pasted content never showed its color** (the fix that landed in 0.7.30 never reached the screen): the input
  always receives a `mask` function — the identity on every line but a secret one — and the renderer skipped the
  colors whenever a mask was present at all. It now compares the masked text with the original and hides colors
  only when the line really was rewritten. While at it: a **short paste is plain text again**, exactly like typing
  (no color, deleted a character at a time); only a collapsed long paste (`[Pasted text …]`, yellow) and an image
  (`[Image #1]`, magenta) are marked, and one backspace still removes either whole.

### Changed
- The default `contextLimit` is **350k** tokens (was 500k): requests read half the context on average, so the
  first token arrives sooner — the trade is that history is summarized earlier.
- The free pass that clears old tool results (no model call) now starts at **80% of the limit** instead of only at
  it: the history hovers under the cap instead of being cut at it, and the summary still happens only at the limit
  when the free pass was not enough.
- While the model is being asked for a step, the busy line says what it is reading:
  `Thinking · reading 298k… 12s (esc interrupt · ctrl+enter cut in)`.

## 0.7.30 — 2026-11-27

### Added
- **`/update [version]`** — installs the latest release, or the named one (`v` prefix ok; a downgrade only when
  asked, `Already on …` when it is the current one) — but only while no task is running. After a **successful**
  install the TUI closes the session and reopens it in the new version, resuming the same session: the terminal is
  restored first, then a fresh process takes over with `-r <sessionId>`. A failed install, a source checkout or an
  up-to-date version just reports and stays put.
- **`/account`** — sign in with your AI Chat account (Google, loopback `http://127.0.0.1:38471/callback`, strict
  state check; the backend holds the client secret). `push`/`pull` move a **whitelist of 16 non-secret settings**
  between machines — providers (keys), mcp, hooks and the tokens never leave the machine, `pull` copies
  `config.json` aside first, and the session renews ten minutes before expiry like provider tokens. Without
  signing in, everything works exactly as before. (Backend side: `user_settings` table + `GET/PUT /api/settings`
  in the ai-chat project.)
- The input box colors what you paste, codex style: **pasted text in green**, **image markers (`[Image #1]`) in
  cyan** — and one backspace at the end of a pasted run or marker removes it whole (typing inside a paste turns
  it into ordinary text).

## 0.7.29 — 2026-11-20 — 2026-11-20

### Changed
- The `task`, `tasks` and `tail` tool calls no longer draw a line in the conversation: subagent plumbing stays out
  of the chat and the bottom panel shows its progress, as before. The report-arrival note, the auto-continue note
  and the status line are unchanged.

## 0.7.28 — 2026-11-20

### Fixed
- ChatGPT (Codex) sign-in stored no `accountId` when the token response carried it in neither the body nor the
  id_token, so every call went out without `chatgpt-account-id` and came back `401 {"detail":"Unauthorized"}`. The
  account id is now read from the body, the id_token claim and the access-token claim; a sign-in that still has
  none says so instead of failing later. An automatic renewal also keeps fields the refresh response omits (it
  returns no account id — it used to wipe the stored one).
- The model list fetched after a ChatGPT sign-in no longer offers internal slugs (`codex-*`, visibility `hide`).

## 0.7.27 — 2026-11-20

### Fixed
- Pickers drew a number only for the first nine rows (the digits double as shortcuts) and blanked the rest, so
  row 10 onward lost its number — every row shows one now.
- `/auth` no longer stuffs `/auth <provider> ` into the main input: picking a provider opens its own masked box
  (dots only, enter sends, esc cancels) and continues into the save and that provider's model picker. The OpenCode
  Go key path uses the same box; `--repl` prints a hint instead (it has no hidden input).

## 0.7.26 — 2026-11-20

### Added
- **Subscription sign-in: `/login`.** Pick a provider, the browser does the rest (loopback PKCE), and the tokens
  live in `config.json` — renewed automatically ten minutes before they expire. Four providers: **Anthropic**
  (Claude Pro/Max; Bearer + the oauth beta header), **OpenRouter** (issues a permanent personal key),
  **xAI** (Grok; the registered port 56121, the token drives the Grok CLI proxy), **OpenAI** (ChatGPT/Codex; the
  registered port 1455, the token drives chatgpt.com/backend-api/codex — after sign-in the plan's own model slugs
  are fetched and offered in the model picker). `/logout <provider>` forgets the credentials; both drop the cached
  model clients at once. The system prompt names the model's provider instead of always saying "via OpenCode Go".
- A background subagent's report now wakes the agent on its own when no turn is running (claude-code style): it
  continues the task with the report folded in, instead of waiting for you to ask.

### Changed
- Non-ZDR OpenCode Go models are allowed again — the picker, the fallback chain and `/model` all take them; the
  "not zero-data-retention" warning stays in the UI.

### Fixed
- A turn that hit the provider's context limit (HTTP 400 "too long") died; it now summarizes the history and
  continues instead. The summarizer's own request is capped to the head and tail of the conversation, so
  compaction can no longer overflow the window it is trying to free. A connection that dropped mid-answer no
  longer ends the turn silently.

## 0.7.25 — 2026-11-20

### Fixed
- In the full-screen view a completed tool line could stay a bare `● bash(...) (click to expand)`: the transcript
  cache keyed a tool by id+rev, and both its first painting (running, rev 0) and its completed state resolved to
  rev 0, so the finished output hit the pre-result cache and never appeared. The key now marks whether an output
  exists, so the result always fills the line (older lines that a click or a renderer flip had already repainted
  looked fine — only recent ones were affected).

## 0.7.24 — 2026-11-20

### Added
- **Session retention.** The new `sessionRetentionDays` in `config.json` deletes sessions untouched for that many
  days; `0` (the default) keeps everything forever, so nothing changes until you set it. Applied at startup and
  when `/sessions` is listed — never the current or resumed session, never blocking startup.
- `/sessions` numbers its rows (the current one marked) and `/sessions remove <n>` deletes one.
- The turn summary shows the prompt-cache share of the input (`5.7M in (5.7M cached · 100%)`): a turn that went
  cold shows up in the line instead of being felt as unexplained slowness.
- `/doctor` reports the compaction-quality log (count, average and max reads after each compaction) and how many
  memos the current session holds.

## 0.7.23 — 2026-11-20

### Added
- **Session memory.** `/memo <text>` saves a note to the current session (persisted with the session file, kept
  across history resets, restored on resume), `/memo` lists, `/memo remove <n>` deletes — and saved notes ride
  every prompt of the session. The agent itself can save: when you ask it to remember something ("remember this",
  "메모리에 저장해줘"), it calls the new memo tool, and the note comes back with every later prompt.
- The test suite now runs on GitHub Actions on every push, on Linux and Windows — and it is green on both.

### Fixed
- Windows CI: the runner's 8.3 short cwd refused every @-attachment as outside the project (the symlink-escape
  check compared two path spellings); dragged-path unescaping ate Windows backslashes; skill file lists use
  forward slashes; the update tests no longer spawn a real npm install on the tarball path.

## 0.7.22 — 2026-11-20

### Added
- `/stats` summarizes the compaction-quality log (how many reads followed each compaction, distribution, average,
  the five most recent); `/resume <query>` falls back to a case-insensitive title search when the id prefix does
  not match — one hit resumes, several open a picker.
- A friendlier empty state: one static hint line under the banner on a brand-new session, and an inviting input
  placeholder. No timers: the IME protection is untouched.

### Changed
- Thinking is brief and iterative now: the system prompt asks for short thinking before each action, verified by
  tools, instead of one long deliberation. And in auto mode the agent re-judges the level between steps — an edit
  or a failed tool call raises it to low, a long loop or huge tool output to medium, capped at the configured
  level, escalation only. The conversation shows the switch.

### Fixed
- A model stream that died mid-turn (network drop) failed the turn; transport-level errors now retry the attempt
  once, announced in the conversation. An HTTP error with a body still reports at once.
- The four Windows CI test failures: the runner's 8.3 short cwd made every @-attachment be refused as outside the
  project (symlink-escape check compared two path spellings); dragged-path unescaping ate Windows backslashes;
  skill file lists now use forward slashes; the update tarball path is injectable and the fixtures carry it.

## 0.7.21 — 2026-11-20

### Fixed
- A turn that hit the step limit mid-task no longer ends silently (it read like the agent just stopping): it
  auto-continues up to twice with a fresh 50-step budget and a "continue where it left off" note, announcing each
  continuation in the conversation. When the cap is spent, the summary line says why the turn stopped
  ("step limit (50) reached after 3 × 50 steps — send any prompt to continue"), as does an answer cut at the
  32k output cap ("output limit reached").

## 0.7.20 — 2026-11-20

### Added
- **parallel-search** (`https://search.parallel.ai/mcp`) ships as a second built-in search MCP server next to exa;
  the system prompt says to retry a search there when exa fails, times out or is not connected. A user's own
  config entry wins, `"enabled": false` turns it off.
- **Windows finishing touches**: `/doctor` says which interpreter the bash tool resolved (Git Bash path, or the
  `cmd.exe` fallback with a pointer to Git for Windows); config.json is restricted to its owner with icacls where
  chmod is ignored; the README gains a Windows section (npm install from the release tarball, winget LibreOffice
  and ripgrep, Windows Terminal recommended).
- Compaction quality is logged: a turn that compacted reports how many `read` calls followed, appended to
  `~/.tessera-code/compaction-log.jsonl` — data for tuning the verbatim-tail budget.

### Fixed
- The VS Code copy-on-select check no longer fails on Linux (it looked in the macOS settings folder) — this broke
  the 0.7.18 release build.

## 0.7.19 — 2026-11-20

### Changed
- With subagents on, delegating is the default, not the fallback: the orchestrator is told to hand out anything
  past one or two tool calls in its first response — research, search, every multi-step job — and to send several
  independent jobs together. Working a multi-step job alone is named as the failure mode.

### Added
- Markdown emphasis colors in the answers, Codex-like: headings in the app's cyan, links bright blue and
  underlined, dim rules. Light backgrounds (`COLORFGBG`, best effort) get darker shades of the same hues so the
  colors do not wash out on white.

## 0.7.18 — 2026-11-20

### Added
- The shorter alias `tessera` runs the tool too (both commands are installed; `tessera-code` keeps working).
- **Windows support.** The bash tool and hooks resolve their interpreter once per process: `/bin/bash` on
  macOS/Linux as before; on Windows Git Bash keeps bash semantics (System32's WSL launcher excluded), falling back
  to `cmd.exe`. Process kills use `taskkill /T /F` there, and a spawn failure reports as a result instead of
  crashing. The system prompt names the actual shell, so the model uses Windows syntax when that is what runs.

### Changed
- Windows: `tessera-code update` installs the SHA-verified release tarball through npm (install.sh is bash-only);
  ctrl+g runs the editor through cmd (notepad as the default); /doctor uses `where`, recognizes `clip` and Windows
  Terminal; clipboard image paste reads via PowerShell `Get-Clipboard`; large images shrink through System.Drawing;
  dragged `C:\...` paths attach; `clip.exe` receives UTF-16LE so `/copy` keeps non-ASCII; the grep fallback names
  `winget install BurntSushi.ripgrep.MSVC`; `tildePath`, the tab title, web session labels and @-file grouping
  handle both separators; remote roots warn about drive roots; `powershell`, `reg`, `schtasks`, `setx`, `rundll32`,
  `msiexec` are ungeneralizable permission rules; the LibreOffice hint names winget. MCP stdio servers needed no
  change (their transport spawns through cross-spawn).

## 0.7.17 — 2026-11-20

### Changed
- `/model`, `/mode` and `/think` with enter open the selectbox now (like `/resume`), instead of just printing — pick
  from the same candidates tab completion shows. `/resume` and `/agents` keep their own pickers.

### Added
- ctrl+s in a picker applies the choice and also saves it as the default for new sessions: `/model` saves the model,
  `/think` saves the thinking mode (`thinking`, `thinkingAuto`, `thinkingLevel`) in `~/.tessera-code/config.json`.
  Enter stays session-only. The picker shows the hint: "enter apply · ctrl+s also save as the default · esc cancel".

## 0.7.16 — 2026-11-20

### Changed
- Compaction is claude-code style now: the last ~25% of the history stays verbatim (it always starts at a user
  message, so a tool call is never cut from its result) and only the older part is summarized. Before any summary,
  a free LLM-less pass clears the tool results of older turns (the most recent three stay intact) — often enough
  that no summary is needed. After a compaction, the current heads of recently edited files (up to 5) are
  re-injected, so the model does not spend round trips re-reading what it just wrote.

### Added
- The update check now runs hourly while a session is open (one HEAD request per hour, no API rate limit), not only
  at startup. The info line appears once per version; the bottom bar keeps showing the notice.

## 0.7.15 — 2026-11-20

### Added
- A running tool call is drawn into the conversation as soon as it starts (claude-code style): the dot blinks while
  it executes, and the result fills the same line in place when it arrives — so you can see what the agent is doing
  without waiting for the tool to finish. A turn that ends without the results fixes those lines as (interrupted).

## 0.7.14 — 2026-11-20

### Added
- Inspect a running subagent: `ctrl+b` opens its live tail (recent reasoning, answers and tool calls), `↑↓` switches,
  `esc` closes.
- The session title shows in the terminal tab: the folder until the first turn generates the title, then the title
  (`/rename`, `/resume`, `/fork` and `/new` update it).
- Subagents follow the parent's thinking mode in `/think auto` too: they pick their own level per task under the same
  cap (they used to always think at the cap).
- The `tasks` tool collects the finished reports right away, so the agent can use them in the same turn; uncollected
  ones still arrive with the next prompt, announced by a note.

## 0.7.13 — 2026-11-20

### Fixed
- Korean (and other IME) typing broke mid-composition. The gauges are refreshed only at turn boundaries — the
  once-a-minute idle timer is gone, unchanged values cause no re-render, and subagent progress is coalesced in a
  400ms debounce instead of one redraw per tool call. The idle input is never redrawn by itself any more; the
  trade-off is that the gauges update at the next response, not while idle.

## 0.7.12 — 2026-11-20

### Fixed
- A finished subagent's line in the panel lingered until the turn ended. It now leaves after 5s (report ready) or
  30s (failed or interrupted, so the cause stays readable). The report itself still arrives with the next prompt.

## 0.7.11 — 2026-11-20

### Added
- The 5h/week/month gauges end with the time left until each window resets, e.g. `5h ▕█░░░░░░░░░▏ 5% (2h 15m)`. On Go
  models the server's reset time is used; the local estimate falls back to 5 hours after the window's first spend and
  next Monday 00:00 UTC (the billing period is unknown, so the month gauge shows no reset there).

## 0.7.10 — 2026-11-20

### Added
- The task tool starts a subagent in the background and returns at once, so the main agent keeps working while it
  runs. Reports arrive with the next prompt (a completion notification); the new `tasks` tool lists progress, and
  `wait: true` blocks for the result instead. Background subagents survive `esc` and are stopped when the session is
  replaced (`/clear`, `/resume`, `/fork`).
- Subagent reports are treated as claims: the orchestrator spot-checks the load-bearing parts before passing them on.

### Changed
- The subagent panel stays after the turn ends, so background work remains visible.

## 0.7.9 — 2026-11-20

### Added
- `ctrl+enter` while the agent works: cut in immediately. The running step is cancelled and what you typed goes out
  at once — the turn continues (a running command is killed; steps still count against the turn's step budget).
  `esc` still ends the whole turn.

### Changed
- Subagents and multi-agent now cast the agent as the orchestrator, in the system prompt (right after the working
  rules) and in the `task` tool: past one or two tool calls, work is handed to a subagent by default. Single-agent
  sessions are unchanged.
- The context gauge is restored from the session's last real request size on resume, and the estimator weights
  Hangul/Han/kana per character (Korean histories were under-counted) and drops JSON overhead, so auto-compaction
  triggers accurately on Korean-heavy sessions.

## 0.7.8 — 2026-11-20

### Changed
- The footer is three lines: the path with the context gauge at its right end, the model line, and the Go spend
  gauges (5h/week/month) on their own last line, right-aligned. This also fixes the missing gap between the context
  and 5-hour gauges, and narrow terminals no longer fold the footer.

## 0.7.7 — 2026-11-20

### Changed
- The footer is three lines: path, model, and the usage gauges on their own last line (context, then the Go spend
  windows 5h/week/month). This also fixes the missing gap between the context and 5-hour gauges, and narrow terminals
  no longer fold the footer.

## 0.7.6 — 2026-11-20

### Added
- The bottom bar shows week and month gauges next to the 5-hour one, and every turn (plus once a minute while idle)
  re-checks them. On Go models the gauges show the server's own usage percentages (`/zen/go/v1/usage`), with this
  machine's estimate filling in elsewhere; `/cost` labels the two sources apart.
- A finished turn's timing line (`⏱ … · … · 2026.11.20 5:55 PM`) is stored with the session and shown again when the
  session is resumed, in the TUI and over remote control.
- Subagents and multi-agent: the agent is told to hand multi-step work to a subagent by default. Single-agent sessions
  are unchanged.

### Fixed
- The remote turn summary shows the date and time too.

## 0.7.5 — 2026-11-20

### Added
- The turn summary line at the end of a turn now ends with the local date and time it finished, e.g.
  `⏱ 24m 16s (…) · 5.7M in (5.7M cached) · 9.7k out · $0.0212 · 2026.11.20 12:20 PM`, in the TUI, the REPL,
  print mode and the remote turn-finish summary.

## 0.7.4 — 2026-11-20

### Fixed
- `/think low` (or `medium`/`high`) in auto mode only lowered the auto cap. A level alone now means "always this
  level" and turns auto off; `/think auto low|medium|high` sets the most auto may think.

## 0.7.3 — 2026-11-20

### Changed
- Expanding a tool call (click or `ctrl+o`) now shows its whole command too, with its line breaks (heredocs, long
  `&&` chains), not only its full output. A command that was cut can be expanded even when its output is short.

## 0.7.2 — 2026-11-20

### Fixed
- Answers (mostly with thinking off) no longer start with `[assistant turn failed before producing content]` or a
  similar note. A failed or interrupted turn is remembered as a note from the user instead of the model's own text,
  steps without visible output are left out of the history, and a note the model still writes is removed. Existing
  sessions are cleaned when they are continued.

## 0.7.1 — 2026-11-20

### Changed
- Thinking auto picks a level per prompt instead of just on/off, and `thinkingLevel` is the most it may use:
  `/think auto low|medium|high` sets that cap. Questions and confirmations get no
  thinking, small changes `low`, debugging, building and reviewing `medium`, design, performance, security,
  refactoring and root causes `high`. The status line shows the cap (`auto ≤high`) and each turn's level.

## 0.7.0 — 2026-11-20

### Added
- Remote control (preview): `tessera-code serve` runs sessions headless and serves a web app to drive them from a
  phone (send prompts, interrupt, answer permission prompts, start sessions in allowed folders). With
  `"remote": {"relay": …}` it connects out to your own `tessera-code relay` (e.g. on a VPS) and pairs a phone by QR
  code; everything between phone and computer is end-to-end encrypted, the relay only forwards ciphertext. See
  `docs/remote-control.md`.
- Thinking auto: `/think auto` (or `ctrl+t`, which now cycles on → auto → off, or `"thinkingAuto": true`) skips
  thinking for short plain prompts (questions, confirmations) and keeps it for debugging, building, reviewing, long
  prompts, code or images. The status line shows each turn's choice (`auto: medium` / `auto: fast`).

## 0.6.3 — 2026-11-19

### Fixed
- Text between two single tildes in an answer (Korean ranges such as `1~3줄 … 5~6개`) no longer shows struck through
  with the tildes missing; only `~~text~~` is strikethrough.

## 0.6.2 — 2026-11-18

### Changed
- Faster turns: the system prompt asks the model for fewer tool round trips (lookups and edits batched in one
  response, nothing re-read that is already known, checks run once at the end) and for no narration between tool
  calls. Takes effect in new sessions.

## 0.6.1 — 2026-11-18

### Changed
- Diffs of `edit` sit on a shaded panel across the full width, with stronger added/removed backgrounds, so the
  changed code stands out from the conversation.
- A message cancelled (`esc`) before the model answered anything leaves no trace: it is removed from the conversation
  (on screen and in the model's history) and put back in the input to edit or send again. Once any answer arrived,
  the interrupted turn stays as before.

## 0.6.0 — 2026-11-18

### Added
- Full-screen TUI (default): click a folded tool output, diff or thinking line to expand just that item (click again to
  fold; `ctrl+o` still expands everything), scroll with the wheel or `PgUp`/`PgDn`, and drag over the conversation to
  select and copy it. `"fullscreen": false` in the config keeps the previous view in the terminal's scrollback.
- The release notes shown after an update open expanded.

### Fixed
- Release notes no longer break mid-sentence where the CHANGELOG source wraps a line.

## 0.5.3 — 2026-11-18

### Added
- A provider name tessera does not know under `"providers"` (e.g. `lm-studio` for `lmstudio`) is no longer ignored
  silently: a startup warning names it and the provider probably meant.

### Fixed
- A model listed under `"models"` without `"output"` may use at most a quarter of its window for an answer, so a
  small local window (16k, 32k) keeps room for the input; servers like vLLM rejected the old 32k default there.

## 0.5.2 — 2026-11-18

### Added
- `"models"` under a provider in `~/.tessera-code/config.json` lists models models.dev does not know (fine-tunes,
  models on a self-hosted server), as ids or with `name`, `context`, `output`, `reasoning`, `images`; set values also
  override models.dev's for a listed model.
- The summary after each answer shows the writing speed (`tok/s`, the model's writing time only).

### Changed
- The answer's summary includes subagents' tokens and cost, and an interrupted or failed answer also shows its time
  and usage so far.

## 0.5.1 — 2026-10-21

### Added
- While the agent works, ↑ on an empty input takes back the newest waiting message (queued command or steering
  message) to edit it, or cancel it with ctrl+c.

### Fixed
- Long pastes no longer fill the screen with copies of the input box: they show as `[Pasted text #n +L lines]` and
  are sent in full; a long prompt scrolls inside the box (at most a third of the screen).
- GLM-5.3 (thinking-only) no longer fails compaction, titles or thinking-off turns: it gets the lowest reasoning
  level instead of "none", and other such models are recognized from the same error.

## 0.5.0 — 2026-10-21

### Added
- **Other model providers**: OpenAI, Anthropic (Claude), OpenRouter, Command Code, Google Gemini, xAI, DeepSeek,
  Mistral, Cohere, Groq, Cerebras, Together, Fireworks, DeepInfra, Perplexity, Moonshot, Z.ai, Alibaba, NVIDIA,
  Hugging Face, Baseten, OpenCode Zen, and local Ollama / LM Studio. `/auth <provider> <key>`, then
  `/model <provider>/<model>`; `/providers` and `/models` show what is available. OpenCode Go stays ZDR-only; other
  providers' models are marked non-ZDR with a warning unless declared `"zdr": true` (or local).
- `/mcp reload` re-reads MCP servers from the config and reconnects without restarting the conversation.

## 0.4.3 — 2026-10-21

### Fixed
- Local MCP servers in opencode's form (`"command": ["npx", "-y", "pkg"]`, `"environment"`) now start; before, only
  `"command": "npx", "args": [...]` worked, so such servers (e.g. an MSSQL MCP server) never connected.

## 0.4.2 — 2026-10-16

### Fixed
- Multi-agent: each running subagent now has its own line under the spinner (type, task, current step, time), and
  ones waiting for a free slot say so. Before, one line showed whichever subagent moved last. `-p` prints the steps
  on stderr.

## 0.4.1 — 2026-10-16

### Fixed
- The new-version notice could lag a release by up to a day (the check was cached for 24 h). It now checks at every
  start, in the background, so a new release shows up at the next start.

## 0.4.0 — 2026-10-16

### Added
- **Skills**: folders with a `SKILL.md` (the Claude Code format; `~/.claude/skills` is read too). The agent loads a
  skill when a task fits, `/<name> [task]` runs one directly, `/skills` lists them and `/skill install|new|remove`
  manages them. A project's own skills are used only once the project is trusted.
- **Subagents and multi-agent**, off by default: `/agents subagents` lets the agent delegate self-contained tasks to
  subagents (`explore` read-only or `general`), `/agents multi` runs up to 4 in parallel, `/agents single` turns it
  off. Saved as `"subagents"` / `"multiAgent"` in `config.json`; the bottom bar shows the mode.

### Removed
- The dimmed suggestion from earlier prompts while typing (↑/↓ and ctrl+r still recall them).

## 0.3.4 — 2026-10-16

### Added
- `/prompt` adds your own instructions: `/prompt global <text>` for every project (`~/.tessera-code/TESSERA.md`),
  `/prompt project <text>` for this project (`.tessera/TESSERA.md`); `/prompt` lists them, `/prompt remove g1`
  deletes one. They apply from the next message.
- A notice when a newer release is out (`↑ x.y.z is available`, also in the bottom bar), checked at most once a day;
  `"updateCheck": false` turns it off.

### Changed
- The default working rules are built into the system prompt instead of being copied to
  `~/.tessera-code/TESSERA.md`; an unedited copy from an earlier version is removed, an edited one is kept.
- In `-p` mode, a command that needs a choice says so instead of doing nothing.

## 0.3.3 — 2026-10-16

### Changed
- Shorter answers: the agent leads with the answer and skips headings, tables, repeated summaries and extra code
  variants unless asked (about 30% fewer characters and half the lines on typical questions).
- A slow or unreachable MCP server no longer delays the first answer: a prompt waits at most 1.5 s, each server's
  tools are usable as soon as it connects, and one still connecting joins from the next prompt.
- The default instructions gain a final-inspection rule (requirements, edge cases, regressions checked before
  reporting). Existing `~/.tessera-code/TESSERA.md` files are not changed.

## 0.3.2 — 2026-10-15

### Added
- The agent looks at files as they are: `read` shows images (png, jpg, gif, webp) to the model, and renders
  documents page by page as images — slides (pptx, ppt, key, odp), PDFs, Word (docx, doc, odt, rtf) and Excel
  (xlsx, xls, ods) — so pictures, text drawn over pictures, charts and layout are seen instead of guessed from the
  file's XML. Up to 10 pages per read (`pages: "11-20"` for more). Rendering uses LibreOffice when installed
  (`brew install --cask libreoffice`); without it the agent says it is needed.

### Fixed
- The test suite no longer fails intermittently: each test file has its own temporary home folder.

## 0.3.1 — 2026-10-15

### Added
- `tessera-code update` installs the latest release; `tessera-code update --check` only says whether one is available.
  It runs the new release's `install.sh` after checking it against that release's `SHA256SUMS`, so updates take the
  same verified path as the first install. A source checkout (`npm link`) is told to update with git instead.
  Coming from 0.3.0, run the curl installer once more; from then on `tessera-code update` does it.

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
