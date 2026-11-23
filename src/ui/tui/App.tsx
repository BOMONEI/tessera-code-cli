import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useBoxMetrics, useCursor, useInput, useStdout, type DOMElement } from 'ink';
import Spinner from 'ink-spinner';
import type { App as Core } from '../../app.js';
import type { Decision, PermissionMode, PermissionRequest } from '../../permissions.js';
import { loadCommands, runCommand, type Choice, type CommandResult } from '../../commands.js';
import { GO_LIMITS, spendWindows, type SpendWindows } from '../../cost/ledger.js';
import type { GoUsage } from '../../cost/go.js';
import { formatClock, formatTiming, formatTokens, formatUsage, gitBranch, hasSecret, maskSecretInput, notify, outputText, redactSecret, tildePath, toolLabel, toolLabelFull } from '../format.js';
import { streamTail, trimBlock, visualRows } from '../text.js';
import { loadMarkdown, markdown } from '../lazy-markdown.js';
import { appendInputHistory, loadInputHistory, searchHistory } from '../history.js';
import { transcriptOf } from '../transcript.js';
import { imagesFromPaths, readClipboardImage } from '../images.js';
import { copyToClipboard } from '../clipboard.js';
import type { Agent, ImageInput } from '../../agent/agent.js';
import type { CompactProgress } from '../../agent/compact.js';
import { modelIsZdr } from '../../providers/catalog.js';
import type { SubagentProgress } from '../../tools/task.js';
import type { WhatsNew } from '../../changelog.js';
import { Input, inputRows as inputRowsOf, visibleCaret } from './Input.js';
import { applyCompletion, complete, enterAction, type CommandInfo, type CompletionItem } from '../completion.js';
import { VERSION } from '../../version.js';
import { suggestFiles } from '../../agent/attachments.js';
import { HistoryView, PermissionPrompt, Picker, isExpandable, middleEllipsis, type HistoryItem, type NewHistoryItem } from './components.js';
import type { MouseEvent, MouseInput } from './mouse.js';
import { buildTranscript, highlight, selectedColumns, selectedText, type Point, type Selection, type Transcript } from './viewport.js';

export interface TuiBridge {
  /** Set by the TUI; the permission manager forwards prompts here. */
  ask?: (req: PermissionRequest) => Promise<Decision>;
  onDiff?: (path: string, diff: string) => void;
}

/** "Compacting context ▕████░░░░░░▏ 42% · 1.2k/~3k tokens" */
export function compactLabel(p: CompactProgress): string {
  const cells = 10;
  const filled = Math.round((p.percent / 100) * cells);
  const detail = p.phase === 'reading' ? `reading ${formatTokens(p.inputTokens)} tokens` : `${formatTokens(p.outputTokens)}/~${formatTokens(p.expectedTokens)} tokens`;
  return `Compacting context ▕${'█'.repeat(filled)}${'░'.repeat(cells - filled)}▏ ${p.percent}% · ${detail}`;
}

const BAR_CELLS = 10;

/** A usage gauge for the HUD: "ctx ▕███░░░░░░░▏ 38% (500k)", green → yellow (60%) → red (85%). */
export function UsageBar({ label, percent, suffix, reset }: { label: string; percent: number; suffix?: string; reset?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.min(BAR_CELLS, Math.round((p / 100) * BAR_CELLS)) || (percent > 0 ? 1 : 0); // any use shows a cell
  const color = p >= 85 ? 'red' : p >= 60 ? 'yellow' : 'green';
  return (
    <Text>
      <Text dimColor>{label} ▕</Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}▏ </Text>
      <Text color={p >= 60 ? color : undefined} dimColor={p < 60}>
        {p}%
      </Text>
      {suffix ? <Text dimColor> {suffix}</Text> : null}
      {reset ? <Text dimColor> ({reset})</Text> : null}
    </Text>
  );
}

/** Plain-text width of a UsageBar, for layout. */
export const usageBarWidth = (label: string, percent: number, suffix?: string, reset?: string) =>
  stringWidth(
    `${label} ▕${'░'.repeat(BAR_CELLS)}▏ ${Math.max(0, Math.min(100, Math.round(percent)))}%${suffix ? ` ${suffix}` : ''}${reset ? ` (${reset})` : ''}`,
  );

/** Live timer next to the spinner: whole seconds, then minutes. */
/** Thinking as ctrl+t cycles it. */
export function thinkingMode(agent: Pick<Agent, 'thinking' | 'thinkingAuto'>): 'on' | 'auto' | 'off' {
  return !agent.thinking ? 'off' : agent.thinkingAuto ? 'auto' : 'on';
}

function elapsedLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Time until a spend window resets, compact: 45m, 3h 05m, 2d 04h. */
function untilLabel(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}

// shift+tab cycle. 'dangerous' (never asks) is left out so it is never reached by accident: /mode, config or flag only.
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];
/** A paste longer than this is shown as "[Pasted text #n +L lines]" in the input. */
const PASTE_COLLAPSE_LINES = 5;
const PASTE_COLLAPSE_CHARS = 1_500;
/** Subagent lines shown under the spinner before "… N more". */
const MAX_SUBAGENT_ROWS = 6;

/** HUD counts for the MCP indicator: connected out of configured, and whether any are still starting. */
export function mcpCounts(status: ReadonlyArray<{ ok: boolean; error?: string }>): { ok: number; total: number; connecting: boolean } {
  return { ok: status.filter((m) => m.ok).length, total: status.length, connecting: status.some((m) => m.error === 'connecting…') };
}
const MENU_HINT = {
  command: 'tab complete · enter run',
  argument: 'tab complete · enter run',
  file: 'tab/enter insert',
  shell: 'tab insert · enter runs what you typed',
} as const;
let nextId = 0;

/** Whether an item is drawn expanded before any click: the release notes after an update always, the rest with ctrl+o. */
const openByDefault = (item: HistoryItem, expanded: boolean) => item.kind === 'changelog' || expanded;

interface Mount {
  key: number;
  /** Lines to show after the redrawn conversation (e.g. "Resumed …"). */
  notices: string[];
  input: string;
  /** Prompts queued before the redraw; the new view runs them. */
  queue: string[];
}

/**
 * Remounts the TUI when the conversation is replaced (/resume, /rewind, /clear): <Static> output cannot be taken
 * back, so the screen is cleared and the new conversation is drawn from scratch.
 */
export function TuiRoot({
  core,
  bridge,
  initialPrompt,
  initialCommand,
  whatsNew,
  mouse,
}: {
  core: Core;
  bridge: TuiBridge;
  initialPrompt?: string;
  initialCommand?: string;
  /** Release notes for the first run after an update; shown once, folded. */
  whatsNew?: WhatsNew;
  /** Set for the full-screen view (see TuiApp). */
  mouse?: MouseInput;
}) {
  const [mount, setMount] = useState<Mount>({ key: 0, notices: [], input: '', queue: [] });
  const stdout = useStdout().stdout;
  return (
    <TuiApp
      key={mount.key}
      core={core}
      bridge={bridge}
      initialPrompt={mount.key === 0 ? initialPrompt : undefined}
      whatsNew={mount.key === 0 ? whatsNew : undefined}
      initialCommand={mount.key === 0 ? initialCommand : undefined}
      notices={mount.notices}
      initialInput={mount.input}
      initialQueue={mount.queue}
      mouse={mouse}
      onReload={(notices, input, queue) => {
        if (!mouse) stdout.write('\x1b[2J\x1b[3J\x1b[H'); // full screen: the new frame replaces the old one
        setMount((m) => ({ key: m.key + 1, notices, input: input ?? '', queue }));
      }}
    />
  );
}

function initialItems(core: Core, width: number, notices: string[], whatsNew?: WhatsNew): HistoryItem[] {
  const { agent } = core;
  const items: HistoryItem[] = [
    {
      id: nextId++,
      kind: 'banner',
      card: {
        version: VERSION,
        model: agent.model.id,
        thinking: agent.model.reasoning ? agent.thinking : undefined,
        cwd: core.ctx.cwd,
        session: agent.sessionId,
        notes: [
          ...core.warnings.map((w) => `⚠ ${w}`),
          ...(agent.messages.length ? [`session: ${core.title ?? agent.sessionId.slice(0, 8)} (${agent.messages.length} messages)`] : []),
        ],
      },
    },
  ];
  if (whatsNew) {
    items.push({ id: nextId++, kind: 'changelog', version: whatsNew.version, from: whatsNew.from, count: whatsNew.count, markdown: whatsNew.sections.map((s) => s.markdown).join('\n\n') });
  }
  for (const e of transcriptOf(agent.messages, 30, core.summaries())) {
    items.push(e.kind === 'assistant' ? { id: nextId++, kind: 'assistant', markdown: e.text } : { id: nextId++, ...e });
  }
  for (const text of notices) items.push({ id: nextId++, kind: 'info', text });
  return items;
}

/** Opens $VISUAL/$EDITOR on `text` and returns the edited text (unchanged if the editor failed). */
function editInEditor(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tessera-'));
  const file = join(dir, 'prompt.md');
  try {
    writeFileSync(file, text);
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const r = spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'editor', file], { stdio: 'inherit' });
    return r.status === 0 ? readFileSync(file, 'utf8').replace(/\n+$/, '') : text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function TuiApp({
  core,
  bridge,
  initialPrompt,
  initialCommand,
  whatsNew,
  notices,
  initialInput,
  initialQueue,
  onReload,
  mouse,
}: {
  core: Core;
  bridge: TuiBridge;
  initialPrompt?: string;
  initialCommand?: string;
  whatsNew?: WhatsNew;
  notices: string[];
  initialInput: string;
  initialQueue: string[];
  onReload: (notices: string[], input: string | undefined, queue: string[]) => void;
  /**
   * Full screen (alternate screen, mouse on): the app draws the transcript itself in a scrollable viewport, so a
   * click expands or folds one item, the wheel and PgUp/PgDn scroll, and a drag selects and copies. Without it the
   * transcript is printed to the terminal's scrollback (<Static>) and only ctrl+o expands, everything at once.
   */
  mouse?: MouseInput;
}) {
  const fullscreen = Boolean(mouse);
  const { exit, suspendTerminal } = useApp();
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  // Printed history (<Static>) is laid out for the width at print time; the terminal's own reflow breaks tables
  // and boxes after a resize. When the width settles, clear the screen and print the history again at the new width.
  const [staticKey, setStaticKey] = useState(0);
  // ctrl+o: tool output, diffs and thinking in full instead of folded (default). Printed history cannot change in
  // place, so toggling clears the screen and prints it again in the other form.
  const [expanded, setExpanded] = useState(false);
  /** Clears the screen and prints the history and the live frame again (ctrl+l, ctrl+o, width changes). */
  const redraw = useCallback(() => {
    // Full screen: Ink only redraws what changed, so leave the terminal and come back for a complete repaint.
    if (mouse) {
      return void suspendTerminal(() => mouse.hold(true))
        .finally(() => mouse.hold(false))
        .catch(() => {}); // already suspended (two ctrl+l in one burst)
    }
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setStaticKey((k) => k + 1);
  }, [stdout, mouse, suspendTerminal]);
  // Full screen: items expanded or folded by a click, against the ctrl+o state (ctrl+o resets them).
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => new Set());
  // Full screen: a dragged selection of transcript lines (copied on release).
  const [selection, setSelection] = useState<Selection | undefined>();
  const toggleExpanded = () => {
    setExpanded((e) => !e);
    setToggled(new Set());
    setSelection(undefined); // the lines move
    if (!mouse) redraw();
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWidth = stdout.columns || 80;
    let widthChanged = false;
    const onResize = () => {
      const width = stdout.columns || 80;
      setSize({ columns: width, rows: stdout.rows || 24 });
      // Any width change counts, even one undone within the debounce window (a pane jiggling 120 → 119 → 120):
      // the terminal rewrapped full-width lines in between, so what is on screen no longer matches the frame Ink
      // erases, and stale copies of the input box piled up.
      if (width !== lastWidth) {
        widthChanged = true;
        setSelection(undefined); // the lines are laid out again
      }
      lastWidth = width;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!widthChanged || mouse) return; // full screen: the transcript is laid out again at the new width
        widthChanged = false;
        redraw();
      }, 150);
    };
    stdout.on('resize', onResize);
    return () => {
      clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout, redraw, mouse]);
  const widthRef = useRef(size.columns);
  widthRef.current = size.columns;
  const { agent } = core;
  const [items, setItems] = useState<HistoryItem[]>(() => initialItems(core, size.columns, notices, whatsNew));
  const [input, setInputValue] = useState(initialInput);
  const [cursor, setCursor] = useState(initialInput.length);
  const setInput = useCallback((v: string, c = v.length) => {
    setInputValue(v);
    setCursor(c);
  }, []);

  const [streaming, setStreaming] = useState('');
  // Thinking as it streams (dim, in the live area); folded into one history line when the step moves on.
  const [thinkingLive, setThinkingLive] = useState('');
  // Short-lived notice in the HUD ("clipboard copied!"), cleared by a timer.
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | undefined>();
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showFlash = useCallback((text: string, ok = true) => {
    clearTimeout(flashTimer.current);
    setFlash({ text, ok });
    flashTimer.current = setTimeout(() => setFlash(undefined), 2000);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const [branch, setBranch] = useState<string | undefined>();
  const [markdownReady, setMarkdownReady] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  // Start of the running turn/command, for the live elapsed time next to the spinner.
  const [busySince, setBusySince] = useState<number | undefined>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (busySince === undefined) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busySince]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ req: PermissionRequest; resolve: (d: Decision) => void } | undefined>();
  const [choice, setChoiceState] = useState<Choice | undefined>();
  // Mirrors `choice` synchronously: queued prompts must wait while a picker is open.
  const choiceRef = useRef<Choice | undefined>(undefined);
  const setChoice = (c: Choice | undefined) => {
    choiceRef.current = c;
    setChoiceState(c);
  };
  // Set once this view handed over to a remounted one; it must not run anything else.
  const supersededRef = useRef(false);
  const [search, setSearch] = useState<{ query: string; index: number } | undefined>();
  const [thinking, setThinking] = useState(thinkingMode(agent));
  const [mode, setMode] = useState<PermissionMode>(core.permissions.mode);
  const [spend, setSpend] = useState<SpendWindows | undefined>();
  /** The Go server's own usage when this is a Go model; the gauges prefer it over the local estimate. */
  const [go, setGo] = useState<GoUsage | undefined>();
  /** Re-reads the gauges: the local ledger always, plus the Go server's own numbers when this is a Go model. */
  const refreshSpend = useCallback(() => {
    void spendWindows().then(setSpend);
    void core.goUsage().then(setGo);
  }, [core]);
  const [mcp, setMcp] = useState(() => mcpCounts(core.mcpStatus));
  /** A newer release, when there is one (checked in the background at most once a day). */
  const [update, setUpdate] = useState<string | undefined>();
  const [agentsMode, setAgentsModeState] = useState(() => core.agentsMode());
  /** Subagents running or waiting for a slot, in start order: one line each under the spinner. */
  const [subagents, setSubagents] = useState<Array<SubagentProgress & { since: number }>>([]);
  const [, forceRender] = useState(0);
  // Prompts typed in this directory, newest first (persisted across sessions).
  const historyRef = useRef<string[]>([]);
  // Completion menu for the token at the cursor: /commands and their arguments, @files, earlier !commands.
  const [menuIndex, setMenuIndexState] = useState(0);
  // Whether the highlighted item was picked with the arrows (enter then runs it) rather than just shown first.
  const [menuChosen, setMenuChosen] = useState(false);
  const setMenuIndex = useCallback((i: number) => {
    setMenuIndexState(i);
    setMenuChosen(false);
  }, []);
  const [menuDismissed, setMenuDismissed] = useState<string | undefined>();
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  // Argument candidates per command, loaded on first use and dropped after each submit (sessions, models change).
  const [argCache, setArgCache] = useState<Record<string, Array<{ value: string; hint?: string }>>>({});
  const overlay = Boolean(pending || choice || search);
  // Computed only when the input changes (not on every streamed token), and not at all after esc dismissed it.
  const typedKey = `${cursor}:${input}`;
  const completion = useMemo(
    () =>
      overlay || menuDismissed === typedKey
        ? undefined
        : complete(input, cursor, {
            commands,
            args: (name) => argCache[name],
            files: (q) => suggestFiles(core.ctx.cwd, q, 30),
            history: historyRef.current,
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typedKey, overlay, menuDismissed, commands, argCache],
  );
  const menu = completion;
  const menuOpen = Boolean(menu);
  const selected = menu ? Math.min(menuIndex, menu.items.length - 1) : 0;
  const acceptCompletion = (item: CompletionItem, run: boolean) => {
    if (!menu) return;
    const next = applyCompletion(input, menu, item);
    setMenuIndex(0);
    if (run) void submit(next.value);
    else setInput(next.value, next.cursor);
  };
  const abortRef = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  // True while the agent is running a turn (not a command or shell): messages typed then steer that turn.
  const turnRef = useRef(false);
  const [interjecting, setInterjecting] = useState<string[]>([]);
  const queueRef = useRef<string[]>([...initialQueue]);
  /** Messages waiting while the agent works, newest last: ↑ on an empty input takes the newest back for editing. */
  const pendingOrder = useRef<Array<{ kind: 'interjection' | 'queued'; text: string }>>(initialQueue.map((text) => ({ kind: 'queued' as const, text })));
  const [queued, setQueued] = useState<string[]>(initialQueue);
  const slashCommand = /^\/(\S+)\s/.exec(input)?.[1];
  useEffect(() => {
    if (!slashCommand || slashCommand in argCache) return;
    let live = true;
    void core.listSkills().then((skills) => loadCommands(core.ctx.cwd, skills))
      .then((all) => all.find((c) => c.name === slashCommand)?.suggest?.(core) ?? [])
      .then((items) => live && setArgCache((c) => ({ ...c, [slashCommand]: items })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slashCommand, argCache, core]);

  const historyPos = useRef(-1);
  const draftRef = useRef('');
  // Pasted images by number; the prompt refers to them as "[Image #n]" and they are sent with it.
  const imagesRef = useRef(new Map<number, ImageInput>());
  const imageCount = useRef(0);
  const attachImage = (image: ImageInput): string => {
    imagesRef.current.set(++imageCount.current, image);
    return `[Image #${imageCount.current}]`;
  };
  // Long pastes stay out of the input box: "[Pasted text #1 +42 lines]" stands in for them and is expanded on submit.
  // Drawn in full, a paste taller than the terminal pushed the box's top off screen, and every chunk of the paste
  // left a stale copy of the box behind (the top of the screen cannot be erased once it has scrolled away).
  const pastesRef = useRef(new Map<number, string>());
  const pasteCount = useRef(0);
  const transformPaste = (text: string): string => {
    const images = imagesFromPaths(text);
    if (images) return images.map((i) => attachImage(i)).join(' ') + ' ';
    const lines = text.replace(/\r\n?/g, '\n').split('\n').length;
    if (lines <= PASTE_COLLAPSE_LINES && text.length <= PASTE_COLLAPSE_CHARS) return text;
    pastesRef.current.set(++pasteCount.current, text);
    return `[Pasted text #${pasteCount.current} +${lines} lines] `;
  };
  /** The prompt with "[Pasted text #n …]" replaced by what was pasted. */
  const expandPastes = (text: string): string =>
    text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (tag, n: string) => pastesRef.current.get(Number(n))?.replace(/\r\n?/g, '\n') ?? tag);
  // Terminals paste text themselves (cmd+v / ctrl+shift+v); ctrl+v reads an image from the clipboard.
  const inputRef = useRef({ input, cursor });
  inputRef.current = { input, cursor };
  const pasteImage = () => {
    void readClipboardImage().then((clip) => {
      if (!clip) return push({ kind: 'info', text: 'No image on the clipboard. Copy a screenshot or image first, or drag an image file into the terminal.' });
      if ('error' in clip) return push({ kind: 'error', text: clip.error });
      const { input: value, cursor: at } = inputRef.current; // the prompt may have changed while reading
      const tag = attachImage(clip.image) + ' ';
      setInput(value.slice(0, at) + tag + value.slice(at), at + tag.length);
    });
  };
  /** Images referenced by the prompt (removed from the pending set). */
  const takeImages = (text: string): ImageInput[] => {
    const out: ImageInput[] = [];
    for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
      const image = imagesRef.current.get(Number(m[1]));
      if (image) out.push(image);
      imagesRef.current.delete(Number(m[1]));
    }
    return out;
  };
  const streamRef = useRef('');
  // Diffs arrive from inside tool execution; show them right after the tool line.
  const pendingDiffs = useRef<Array<{ path: string; diff: string }>>([]);

  const push = useCallback((item: NewHistoryItem) => {
    const id = nextId++;
    setItems((prev) => [...prev, { ...item, id } as HistoryItem]);
    return id;
  }, []);

  // Thinking of the current step, printed (folded) once the model moves on to text or a tool call.
  const reasoningRef = useRef<{ text: string; since: number } | undefined>(undefined);
  const flushReasoning = useCallback(() => {
    const r = reasoningRef.current;
    reasoningRef.current = undefined;
    setThinkingLive('');
    if (r?.text.trim()) push({ kind: 'reasoning', text: r.text, ms: Date.now() - r.since });
  }, [push]);

  useEffect(() => {
    // Compaction (auto or /compact) reports an estimated percentage; it replaces the spinner label meanwhile.
    // Each subagent gets its own line (several run at once in multi-agent mode); a finished one stays until the
    // turn's end shows its report is ready — background ones keep their line even after the turn ended.
    core.onTaskProgress = (p) =>
      setSubagents((list) => {
        const i = list.findIndex((s) => s.id === p.id);
        if (i < 0) return [...list, { ...p, since: Date.now() }];
        if (i < 0) return [...list, { ...p, since: Date.now() }];
        const next = [...list];
        next[i] = { ...next[i]!, ...p, since: next[i]!.state === 'queued' && p.state === 'running' ? Date.now() : next[i]!.since };
        return next;
      });
    agent.onCompactProgress = (p) => setStatus(p.phase === 'done' ? (turnRef.current ? 'Thinking' : undefined) : compactLabel(p));
    bridge.ask = (req) => new Promise<Decision>((resolve) => setPending({ req, resolve }));
    bridge.onDiff = (path, diff) => pendingDiffs.current.push({ path, diff });
    refreshSpend();
    void gitBranch(core.ctx.cwd).then(setBranch);
    void loadInputHistory(core.ctx.cwd).then((h) => (historyRef.current = h));
    // After the first frame; needed only once answers arrive (raw text until then; full screen redraws them).
    loadMarkdown().then(() => setMarkdownReady(true)).catch(() => {});
    // MCP status lives in the HUD (connected/configured); /mcp lists the servers and their errors.
    void core.mcpReady.then(() => setMcp(mcpCounts(core.mcpStatus)));
    if (core.config.updateCheck !== false) {
      void import('../../update.js')
        .then(({ availableUpdate }) => availableUpdate(VERSION))
        .then((latest) => {
          if (!latest) return;
          setUpdate(latest);
          push({ kind: 'info', text: `↑ tessera-code ${latest} is available (you have ${VERSION}). Update: tessera-code update` });
        });
    }
    void core.listSkills().then((skills) => loadCommands(core.ctx.cwd, skills)).then((all) => setCommands(all.map(({ name, description, argHint }) => ({ name, description, argHint }))));
  }, [bridge, core.ctx.cwd]);

  // Spend windows roll with time, so an idle session re-checks them now and then (each turn refreshes them too).
  useEffect(() => {
    const timer = setInterval(refreshSpend, 60_000);
    return () => clearInterval(timer);
  }, [refreshSpend]);

  // Streaming markdown: finished blocks are rendered and printed for good; only the block still being written
  // stays in the live area (re-rendered as it grows, throttled).
  const renderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const renderLive = useCallback(() => {
    renderTimer.current = undefined;
    const md = markdown();
    const cut = md ? md.stablePrefixLength(streamRef.current) : 0;
    if (cut > 0) {
      const done = trimBlock(streamRef.current.slice(0, cut));
      streamRef.current = streamRef.current.slice(cut);
      if (done) push({ kind: 'assistant', markdown: done });
    }
    const rest = trimBlock(streamRef.current);
    setStreaming(rest ? (md ? md.renderStreaming(rest, widthRef.current - 1) : rest) : '');
    setThinkingLive(reasoningRef.current?.text.trim() ?? '');
  }, [push]);
  const scheduleRender = useCallback(() => {
    renderTimer.current ??= setTimeout(renderLive, 50);
  }, [renderLive]);
  useEffect(() => () => clearTimeout(renderTimer.current), []);

  const flushStream = useCallback(() => {
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = undefined;
    const text = trimBlock(streamRef.current);
    streamRef.current = '';
    setStreaming('');
    if (text) push({ kind: 'assistant', markdown: text });
  }, [push]);

  const startBusy = (label: string) => {
    busyRef.current = true;
    setBusy(true);
    setStatus(label);
    setBusySince(Date.now());
    refreshSpend(); // a new turn re-checks the gauges
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };
  const endBusy = () => {
    abortRef.current = undefined;
    busyRef.current = false;
    setBusy(false);
    setStatus(undefined);
    setBusySince(undefined);
  };

  /**
   * Runs one turn; `origin` is the prompt's history line and its text as typed. Interrupted before the model answered
   * anything, the turn leaves no trace: its lines are removed and the text goes back to the input (returns true).
   */
  const runTurn = useCallback(
    async (prompt: string, images: ImageInput[] = [], origin?: { id: number; text: string }): Promise<boolean> => {
      const controller = startBusy('Thinking');
      turnRef.current = true;
      const started = Date.now();
      const labels = new Map<string, { label: string; fullLabel?: string }>();
      let failed = false;
      let discarded = false;
      try {
        for await (const ev of core.run(prompt, controller.signal, images)) {
          switch (ev.type) {
            case 'text':
              flushReasoning();
              streamRef.current += ev.text;
              scheduleRender();
              setStatus('Writing');
              break;
            case 'reasoning':
              if (!reasoningRef.current) {
                flushStream();
                reasoningRef.current = { text: '', since: Date.now() };
              }
              reasoningRef.current.text += ev.text;
              scheduleRender();
              setStatus('Reasoning');
              break;
            case 'tool-input-start':
              flushReasoning();
              flushStream();
              setStatus(`Preparing ${ev.name}`);
              break;
            case 'step-finish':
              // The answer so far is done but the turn is not: the next request (often seconds) follows.
              setStatus('Thinking');
              break;
            case 'tool-call':
              flushReasoning();
              flushStream();
              labels.set(ev.id, { label: toolLabel(ev.name, ev.input), fullLabel: toolLabelFull(ev.name, ev.input) });
              setStatus(`Running ${toolLabel(ev.name, ev.input)}`);
              break;
            case 'tool-result':
              push({ kind: 'tool', label: ev.name, ...labels.get(ev.id), output: outputText(ev.output), isError: ev.isError });
              for (const d of pendingDiffs.current.splice(0)) push({ kind: 'diff', ...d });
              setStatus('Thinking');
              break;
            case 'info':
              push({ kind: 'info', text: ev.text });
              break;
            case 'interjection':
              flushStream();
              setInterjecting((list) => {
                const i = list.indexOf(ev.text);
                return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
              });
              push({ kind: 'user', text: `↳ ${ev.text}` });
              break;
            case 'fallback':
              push({ kind: 'info', text: `↪ ${ev.from} ${ev.reason}; switched to ${ev.to}` });
              break;
            case 'compacted':
              push({ kind: 'info', text: `(context compacted from ${formatTokens(ev.before)} tokens)` });
              break;
            case 'turn-finish':
              if (ev.discarded && origin) {
                discarded = true;
                break;
              }
              flushReasoning();
              flushStream();
              push({ kind: 'info', text: `${formatTiming(ev)} · ${formatUsage(ev.usage)} · ${formatClock()}` });
              break;
            case 'error':
              failed = true;
              flushReasoning();
              flushStream();
              push({ kind: 'error', text: ev.message });
              break;
          }
        }
        if (controller.signal.aborted && !discarded) {
          flushStream();
          push({ kind: 'info', text: 'Interrupted.' });
        }
      } catch (e) {
        failed = true;
        flushStream();
        push({ kind: 'error', text: (e as Error).message });
      } finally {
        flushReasoning();
        flushStream(); // no-op normally; keeps leftovers out of the next turn if the run threw
        turnRef.current = false;
        // Messages the turn ended without reading (it was already writing its answer) run next.
        const unread = core.agent.takeInterjections();
        setInterjecting([]);
        if (discarded && origin) {
          setItems((prev) => prev.filter((i) => i.id < origin.id));
          setInput([origin.text, inputRef.current.input, ...unread].filter(Boolean).join('\n'));
          showFlash('Cancelled: the message is back in the input');
        } else if (unread.length && controller.signal.aborted) {
          // Interrupted: hand the unsent messages back for editing instead of starting a new turn on its own.
          setInput([inputRef.current.input, ...unread].filter(Boolean).join('\n'));
        } else if (unread.length) {
          queueRef.current.push(...unread);
          setQueued(queueRef.current.map(redactSecret));
          // They wait in the queue now: ↑ takes them back from there.
          for (const p of pendingOrder.current) if (p.kind === 'interjection' && unread.includes(p.text)) p.kind = 'queued';
        }
        if (controller.signal.aborted) pendingOrder.current = pendingOrder.current.filter((p) => p.kind === 'queued');
        endBusy();
        const seconds = (Date.now() - started) / 1000;
        const after = core.config.notifyAfterSeconds;
        if (after > 0 && seconds >= after && !controller.signal.aborted) notify(`tessera-code: ${failed ? 'stopped with an error' : 'done'} (${Math.round(seconds)}s)`);
        refreshSpend();
        setBranch(await gitBranch(core.ctx.cwd)); // the agent may have switched branches
      }
      return discarded;
    },
    [core, flushReasoning, flushStream, push, scheduleRender, setInput, showFlash],
  );

  /** "!cmd": runs in the shell directly (the user typed it, so no approval); the output goes to the next prompt. */
  const runShell = useCallback(
    async (command: string) => {
      const controller = startBusy(`Running ${command}`);
      try {
        const { output, code } = await core.shell(command, controller.signal);
        push({ kind: 'tool', label: `$ ${command}`, output: output || '(no output)', lines: 12, isError: code !== 0 && !controller.signal.aborted });
        push({ kind: 'info', text: 'Output will be shared with the model along with your next message.' });
      } finally {
        endBusy();
        setBranch(await gitBranch(core.ctx.cwd));
      }
    },
    [core, push],
  );

  /** Shows a command's result; `choose` opens a picker whose selection is handled the same way. */
  const applyResult = useCallback(
    async (r: CommandResult): Promise<void> => {
      setMode(core.permissions.mode);
      setThinking(thinkingMode(agent));
      setAgentsModeState(core.agentsMode());
      setMcp(mcpCounts(core.mcpStatus)); // /mcp reload changes the servers
      forceRender((n) => n + 1);
      void core.saveState().catch(() => {});
      if (r.exit) return exit();
      if (r.reload) {
        supersededRef.current = true;
        return onReload(r.output ? [r.output] : [], r.input, queueRef.current.splice(0));
      }
      if (r.copied) showFlash('✓ clipboard copied!');
      if (r.output) push({ kind: 'info', text: r.output });
      if (r.markdown) push({ kind: 'assistant', markdown: r.markdown });
      for (const d of r.diffs ?? []) push({ kind: 'diff', path: d.path, diff: d.diff, maxLines: 400 });
      if (r.input !== undefined) setInput(r.input);
      if (r.choose) setChoice(r.choose);
      if (r.prompt) await runTurn(r.prompt);
    },
    [agent, core, exit, onReload, push, runTurn, setInput, showFlash],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = expandPastes(raw).trim();
      setInput('');
      if (!text) return;
      setScroll({ follow: true, top: 0 }); // back to the newest output
      setSelection(undefined);
      if (busyRef.current) {
        if (turnRef.current && !/^[/!]/.test(text) && !/\[Image #\d+\]/.test(text)) {
          // Typed while the agent works: steer the running turn (delivered after the current step).
          core.agent.interject(text);
          pendingOrder.current.push({ kind: 'interjection', text });
          setInterjecting((list) => [...list, text]);
          historyRef.current = [text, ...historyRef.current.filter((h) => h !== text)];
          void appendInputHistory(core.ctx.cwd, text);
          return;
        }
        // Commands and shell lines wait for the turn to end.
        queueRef.current.push(text);
        pendingOrder.current.push({ kind: 'queued', text });
        setQueued(queueRef.current.map(redactSecret));
        return;
      }
      setArgCache({});
      // "/auth <key>" is neither kept in the history (it is saved to disk) nor drawn with the key.
      if (!hasSecret(text)) {
        if (historyRef.current[0] !== text) void appendInputHistory(core.ctx.cwd, text); // unread interjections come back here
        historyRef.current = [text, ...historyRef.current.filter((h) => h !== text)];
      }
      historyPos.current = -1;
      const userItem = push({ kind: 'user', text: redactSecret(text) });
      let restored = '';
      if (text.startsWith('!')) {
        await runShell(text.slice(1).trim());
      } else if (text.startsWith('/')) {
        busyRef.current = true;
        setBusy(true);
        try {
          const r = await runCommand(core, text);
          busyRef.current = false;
          setBusy(false);
          await applyResult(r);
        } catch (e) {
          push({ kind: 'error', text: (e as Error).message });
        } finally {
          busyRef.current = false;
          setBusy(false);
          setStatus(undefined);
        }
      } else {
        const tags = [...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]));
        if (tags.length && !agent.model.images) {
          // Keep the prompt and its images: the user can switch models and send again.
          push({ kind: 'error', text: `${agent.model.id} cannot read images. Switch with /model (e.g. mimo-v2.6-flash) and send again.` });
          setInput(text);
          return;
        }
        const missing = tags.filter((n) => !imagesRef.current.has(n));
        if (missing.length) push({ kind: 'info', text: `${missing.map((n) => `[Image #${n}]`).join(' ')} is no longer attached (recalled from history); paste the image again to send it.` });
        const attached = [...imagesRef.current].filter(([n]) => tags.includes(n));
        if (await runTurn(text, takeImages(text), { id: userItem, text: raw.trim() })) {
          restored = raw;
          for (const [n, image] of attached) imagesRef.current.set(n, image); // back with their tags in the input
        }
      }
      // Images whose tags were deleted or never sent are dropped (each can be megabytes).
      const referenced = new Set([...queueRef.current, input, restored].flatMap((q) => [...q.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]))));
      for (const n of imagesRef.current.keys()) if (!referenced.has(n)) imagesRef.current.delete(n);
      await drainRef.current();
    },
    [applyResult, core, push, runShell, runTurn, setInput],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;
  /** ctrl+enter while the agent works: send what is typed and cut in immediately (the running step is cancelled). */
  const cutIn = useCallback(() => {
    if (!turnRef.current) return;
    if (input.trim()) void submitRef.current(input);
    core.agent.interruptStep();
  }, [core, input]);

  /** Runs the next queued prompt, unless a picker is open, something is running, or this view was replaced. */
  const drain = async () => {
    if (supersededRef.current || choiceRef.current || busyRef.current) return;
    const next = queueRef.current.shift();
    setQueued(queueRef.current.map(redactSecret));
    if (next !== undefined) await submitRef.current(next);
  };
  const drainRef = useRef(drain);
  drainRef.current = drain;

  useEffect(() => {
    if (initialCommand) void submit(initialCommand);
    else if (initialPrompt) void submit(initialPrompt);
    else void drain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Returns the new input value, so the Input can keep building on it within the same batch of keys. */
  /**
   * ↑ on an empty input while the agent works: the newest waiting message comes back into the input and leaves the
   * queue, to be edited and sent again, or cleared with ctrl+c. A message the turn has already read cannot be taken
   * back; the next older one is tried.
   */
  const takeBackPending = (): string | undefined => {
    while (pendingOrder.current.length) {
      const last = pendingOrder.current.pop()!;
      if (last.kind === 'queued') {
        const i = queueRef.current.lastIndexOf(last.text);
        if (i < 0) continue; // already ran
        queueRef.current.splice(i, 1);
        setQueued(queueRef.current.map(redactSecret));
        return last.text;
      }
      if (core.agent.withdrawInterjection(last.text)) {
        setInterjecting((list) => {
          const i = list.lastIndexOf(last.text);
          return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
        });
        return last.text;
      }
    }
    return undefined;
  };

  const browseHistory = (direction: 'older' | 'newer'): string | undefined => {
    const h = historyRef.current;
    let next: string | undefined;
    if (direction === 'older') {
      if (!h.length) return undefined;
      if (historyPos.current === -1) draftRef.current = input;
      historyPos.current = Math.min(historyPos.current + 1, h.length - 1);
      next = h[historyPos.current]!;
    } else if (historyPos.current >= 0) {
      historyPos.current--;
      next = historyPos.current === -1 ? draftRef.current : h[historyPos.current]!;
    }
    if (next !== undefined) setInput(next);
    return next;
  };

  const searchMatch = search ? searchHistory(historyRef.current, search.query, search.index) : -1;

  useInput((ch, key) => {
    if (pending || choice) return;
    if (search) {
      const match = searchMatch >= 0 ? historyRef.current[searchMatch]! : undefined;
      if (key.escape || (key.ctrl && (ch === 'g' || ch === 'c'))) setSearch(undefined);
      else if (key.ctrl && ch === 'r') {
        const older = searchHistory(historyRef.current, search.query, (searchMatch >= 0 ? searchMatch : search.index) + 1);
        if (older >= 0) setSearch({ ...search, index: older });
      } else if (key.return || key.tab || key.rightArrow || key.leftArrow) {
        if (match !== undefined) setInput(match);
        setSearch(undefined);
      } else if (key.backspace || key.delete) setSearch({ query: search.query.slice(0, -1), index: 0 });
      else if (ch && !key.ctrl && !key.meta) setSearch({ query: search.query + ch, index: 0 });
      return;
    }
    if (key.ctrl && ch === 'c') {
      // With text in the prompt, ctrl+c belongs to the input (copy the selection, or clear it). Only an empty
      // prompt interrupts the running turn, or exits when idle.
      if (inputRef.current.input) return;
      if (abortRef.current) abortRef.current.abort();
      else exit();
      return;
    }
    if (menu) {
      const n = menu.items.length;
      if (key.upArrow || key.downArrow) {
        setMenuIndexState((selected + (key.upArrow ? n - 1 : 1)) % n);
        return setMenuChosen(true);
      }
      if (key.tab) return acceptCompletion(menu.items[selected]!, false);
      if (key.return) {
        const item = menu.items[selected]!;
        const action = enterAction(input, cursor, menu, item, menuChosen);
        if (action === 'typed') return void submit(input);
        return acceptCompletion(item, action === 'complete-and-run' && !busy);
      }
      if (key.escape) return setMenuDismissed(typedKey);
    }
    if (key.escape && abortRef.current) {
      abortRef.current.abort();
      return;
    }
    if (mouse && (key.pageUp || key.pageDown)) return scrollBy((key.pageUp ? -1 : 1) * Math.max(1, viewH - 2));
    if (key.ctrl && ch === 't') {
      // on → auto → off → on
      if (!agent.thinking) [agent.thinking, agent.thinkingAuto] = [true, false];
      else if (!agent.thinkingAuto) agent.thinkingAuto = true;
      else agent.thinking = false;
      setThinking(thinkingMode(agent));
      void core.saveState().catch(() => {});
      return;
    }
    if (key.shift && key.tab) {
      const next = MODES[(MODES.indexOf(core.permissions.mode) + 1) % MODES.length]!;
      setMode(next);
      // Global: the next start (any project) uses it too.
      void core.setPermissionMode(next).catch((e: Error) => showFlash(`✗ could not save the mode: ${e.message}`, false));
      void core.saveState().catch(() => {});
      return;
    }
    if (key.ctrl && ch === 'r') {
      setSearch({ query: '', index: 0 });
      return;
    }
    if (key.ctrl && ch === 'v') return pasteImage();
    if (key.ctrl && ch === 'o') return toggleExpanded();
    if (key.ctrl && ch === 'l') return redraw();
    if (key.ctrl && ch === 'g' && !busy) {
      // The editor runs synchronously; while a turn streams that would stall it, so only when idle.
      void suspendTerminal(() => {
        mouse?.hold(true);
        try {
          setInput(editInEditor(input));
        } finally {
          mouse?.hold(false);
        }
      });
    }
  });

  // Keep the live area shorter than the screen (input box, status, footer, menu, picker and queue take the rest).
  // A long prompt scrolls inside the box: at most a third of the screen (see lineWindow in Input.tsx).
  const inputMaxLines = Math.max(3, Math.floor(size.rows / 3));
  const inputRows = inputRowsOf(input || ' ', cursor, size.columns - 7, inputMaxLines); // border, padding and prompt
  const queuedRows =
    [...queued, ...interjecting].reduce((n, q) => n + visualRows(`↳ will be sent after the current step: ${q}`, size.columns), 0) + (queued.length + interjecting.length ? 1 : 0);
  const pickerRows = choice ? Math.min(choice.options.length, 10) + 5 : 0;
  const MENU_ROWS = 8;
  const menuStart = menu ? Math.min(Math.max(0, selected - MENU_ROWS + 1), Math.max(0, menu.items.length - MENU_ROWS)) : 0;
  const menuShown = menu ? menu.items.slice(menuStart, menuStart + MENU_ROWS) : [];
  const labelWidth = Math.min(32, Math.max(0, ...menuShown.map((m) => stringWidth(m.label))));

  const ctxPct = Math.round((agent.contextTokens / agent.contextLimit) * 100);
  const where = tildePath(core.ctx.cwd);
  // The Go server's own numbers win; the local estimate fills the windows it does not report.
  const local = spend
    ? {
        fiveHour: (spend.fiveHour / GO_LIMITS.fiveHour) * 100,
        week: (spend.week / GO_LIMITS.week) * 100,
        month: (spend.month / GO_LIMITS.month) * 100,
        fiveHourReset: spend.fiveHourReset,
        weekReset: spend.weekReset,
      }
    : undefined;
  const pcts = go || local
    ? {
        fiveHour: go?.fiveHour ?? local?.fiveHour,
        week: go?.week ?? local?.week,
        month: go?.month ?? local?.month,
        fiveHourReset: go?.fiveHourReset ?? local?.fiveHourReset,
        weekReset: go?.weekReset ?? local?.weekReset,
        monthReset: go?.monthReset,
      }
    : undefined;
  const bars: Array<{ label: string; percent: number; reset?: string }> = [];
  if (pcts) {
    if (pcts.fiveHour !== undefined) bars.push({ label: '5h', percent: pcts.fiveHour, reset: pcts.fiveHourReset !== undefined ? untilLabel(pcts.fiveHourReset - Date.now()) : undefined });
    if (pcts.week !== undefined) bars.push({ label: 'wk', percent: pcts.week, reset: pcts.weekReset !== undefined ? untilLabel(pcts.weekReset - Date.now()) : undefined });
    if (pcts.month !== undefined) bars.push({ label: 'mo', percent: pcts.month, reset: pcts.monthReset !== undefined ? untilLabel(pcts.monthReset - Date.now()) : undefined });
  }
  // Gauges only: the session's own spend is in /cost; the details of both are in /context and /cost.
  const ctxLimit = `(${formatTokens(agent.contextLimit)})`;
  const shellMode = input.startsWith('!');
  const subagentRows = busy && !pending ? Math.min(subagents.length, MAX_SUBAGENT_ROWS + 1) : 0;
  // The footer is three lines: path, model and the usage gauges.
  const liveRows = size.rows - 10 - inputRows - queuedRows - pickerRows - subagentRows - (menu ? menuShown.length + 1 : 0);
  const live = streaming ? streamTail(streaming, size.columns - 1, liveRows - 1) : undefined;
  // A short rolling window: enough to see it working without pushing the input box around.
  const thinkingTail = thinkingLive && !streaming && core.config.showThinking ? streamTail(thinkingLive, size.columns - 3, Math.min(6, Math.max(1, liveRows - 2))) : undefined;

  // Put the terminal's real cursor at the caret: IMEs (Korean, Japanese, Chinese) draw the syllable being composed
  // at the real cursor, which Ink otherwise parks below its output, so the text seemed to lag one character.
  const { setCursorPosition } = useCursor();
  const frameRef = useRef<DOMElement>(null);
  const inputBoxRef = useRef<DOMElement>(null);
  const frame = useBoxMetrics(frameRef);
  const inputBox = useBoxMetrics(inputBoxRef);
  const promptWidth = 2; // "› "
  const innerLeft = 2 + promptWidth; // border + padding
  const caretActive = !overlay && inputBox.hasMeasured && frame.hasMeasured;
  const caret = caretActive ? visibleCaret(input, cursor, inputBox.width - innerLeft - 2, inputMaxLines) : undefined;
  setCursorPosition(caret ? { x: inputBox.left + innerLeft + caret.x, y: frame.top + inputBox.top + 1 + caret.row } : undefined);

  // Full screen: the transcript as lines, the window of them on screen, and mouse selection (see `mouse` above).
  const [built, setBuilt] = useState<{ transcript: Transcript; items: HistoryItem[] }>({ transcript: { lines: [], owner: [] }, items: [] });
  const transcript = built.transcript;
  const isItemExpanded = useCallback((item: HistoryItem) => openByDefault(item, expanded) !== toggled.has(item.id), [expanded, toggled]);
  useEffect(() => {
    if (!mouse) return;
    // From a timer: renderToString must not run inside React's render or commit (see viewport.ts).
    const timer = setTimeout(() => setBuilt({ transcript: buildTranscript(items, { width: size.columns, showThinking: core.config.showThinking, isExpanded: isItemExpanded }), items }), 0);
    return () => clearTimeout(timer);
  }, [mouse, items, size.columns, isItemExpanded, core.config.showThinking, markdownReady]);
  // What is still being written follows the transcript: the thinking's last lines, then the answer so far.
  const liveLines = useMemo(() => {
    if (!mouse) return [];
    const out: string[] = [];
    if (thinkingLive && !streaming && core.config.showThinking) {
      const tail = streamTail(thinkingLive, size.columns - 3, 6);
      out.push('', '\x1b[2;35m∴ Thinking…\x1b[0m', ...tail.text.split('\n').map((l) => `\x1b[2;3m  ${l}\x1b[0m`));
    }
    // Hard-wrapped: one line must be one screen row (before markdown loads, a paragraph is a single long line).
    if (streaming) out.push('', ...wrapAnsi(streaming, size.columns, { hard: true, trim: false }).split('\n'));
    return out;
  }, [mouse, thinkingLive, streaming, size.columns, core.config.showThinking]);
  // Until the transcript has caught up with the items (a timer away), the text just moved into them stays on
  // screen as live lines; otherwise a finished answer would vanish for a frame.
  const lastLive = useRef<string[]>([]);
  const current = built.items === items;
  if (current) lastLive.current = liveLines;
  const tail = current ? liveLines : lastLive.current;
  const allLines = mouse ? (tail.length ? [...transcript.lines, ...tail] : transcript.lines) : [];
  const viewH = mouse ? Math.max(1, size.rows - (frame.hasMeasured ? frame.height : 8)) : 0;
  const maxTop = Math.max(0, allLines.length - viewH);
  // `follow`: stay at the bottom as output arrives; otherwise `top` (first line shown) holds still.
  const [scroll, setScroll] = useState({ follow: true, top: 0 });
  const top = scroll.follow ? maxTop : Math.min(scroll.top, maxTop);
  const below = Math.max(0, allLines.length - top - viewH);
  const viewRef = useRef({ top, maxTop, viewH, lines: allLines, owner: transcript.owner });
  viewRef.current = { top, maxTop, viewH, lines: allLines, owner: transcript.owner };
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const scrollBy = useCallback((n: number) => {
    setScroll((sc) => {
      const v = viewRef.current;
      const next = Math.max(0, Math.min(v.maxTop, (sc.follow ? v.maxTop : Math.min(sc.top, v.maxTop)) + n));
      return { follow: next >= v.maxTop, top: next };
    });
  }, []);
  const dragRef = useRef<{ anchor: Point; moved: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!mouse) return;
    const onMouse = (e: MouseEvent) => {
      if (e.kind === 'wheel') return scrollBy(e.dir === 'up' ? -3 : 3);
      const v = viewRef.current;
      const row = e.y - 1;
      const point = { line: v.top + Math.max(0, Math.min(row, v.viewH - 1)), col: Math.max(0, e.x - 1) };
      if (e.kind === 'press') {
        // Only the transcript: the input box and the bars below it are not selectable.
        dragRef.current = row < v.viewH ? { anchor: point, moved: false } : undefined;
        setSelection(undefined);
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      if (e.kind === 'drag') {
        if (row <= 0) scrollBy(-1);
        else if (row >= v.viewH) scrollBy(1);
        drag.moved ||= point.line !== drag.anchor.line || point.col !== drag.anchor.col;
        if (drag.moved) setSelection({ anchor: drag.anchor, head: point });
        return;
      }
      dragRef.current = undefined;
      if (drag.moved) {
        const text = selectedText(v.lines, { anchor: drag.anchor, head: point });
        if (text.trim()) void copyToClipboard(text).then((via) => (via ? showFlash('✓ clipboard copied!') : showFlash('✗ clipboard unavailable', false)));
        return;
      }
      // A click: expand or fold the item under it, keeping the view where it is (the item stays under the mouse).
      const id = v.owner[point.line];
      const item = id === undefined ? undefined : itemsRef.current.find((i) => i.id === id);
      if (!item || !isExpandable(item)) return;
      setToggled((t) => {
        const next = new Set(t);
        if (!next.delete(item.id)) next.add(item.id);
        return next;
      });
      setScroll({ follow: false, top: v.top });
    };
    mouse.onEvent(onMouse);
    return () => mouse.onEvent(undefined);
  }, [mouse, scrollBy, showFlash]);
  const shownRows = mouse
    ? allLines.slice(top, top + viewH).map((line, i) => {
        const cols = selection && selectedColumns(selection, top + i);
        return cols ? highlight(line, cols[0], cols[1]) : line;
      })
    : [];

  const bottom = (
      <Box flexDirection="column" ref={frameRef} flexShrink={0}>
        {mouse && below > 0 ? <Text dimColor>{`  ↓ ${below} more line${below === 1 ? '' : 's'} · wheel or PgDn`}</Text> : null}
        {thinkingTail && !mouse ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="magenta" dimColor>
              ∴ Thinking…
            </Text>
            <Text dimColor italic>
              {thinkingTail.text.replace(/^/gm, '  ')}
            </Text>
          </Box>
        ) : null}
        {live && !mouse ? (
          <Box marginTop={1} flexDirection="column">
            {live.hidden ? <Text dimColor>… {live.hidden} more lines above</Text> : null}
            <Text>{live.text}</Text>
          </Box>
        ) : null}
        {pending ? (
          <PermissionPrompt
            req={pending.req}
            onDecide={(d) => {
              pending.resolve(d);
              setPending(undefined);
            }}
            onInterrupt={() => abortRef.current?.abort()}
          />
        ) : null}
        {choice ? (
          <Picker
            title={choice.title}
            options={choice.options}
            onCancel={() => {
              setChoice(undefined);
              void drain();
            }}
            onSelect={(i) => {
              const current = choice;
              setChoice(undefined);
              // Busy until the selection is applied: a prompt sent meanwhile is queued, not run alongside it.
              busyRef.current = true;
              setBusy(true);
              void (async () => {
                try {
                  const r = await current.select(i);
                  busyRef.current = false;
                  setBusy(false);
                  await applyResult(r);
                } catch (e) {
                  push({ kind: 'error', text: (e as Error).message });
                } finally {
                  busyRef.current = false;
                  setBusy(false);
                }
                await drain();
              })();
            }}
          />
        ) : null}
        {interjecting.map((q, i) => (
          <Text key={`i${i}`} color="yellow" dimColor>
            ↳ will be sent after the current step: {q}
          </Text>
        ))}
        {queued.map((q, i) => (
          <Text key={i} dimColor>
            ⧗ queued: {q}
          </Text>
        ))}
        {queued.length + interjecting.length ? <Text dimColor italic>{'  ↑ on an empty input takes the last one back (edit, or ctrl+c to cancel it)'}</Text> : null}
        {busy && !pending ? (
          <Box marginTop={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor>
              {' '}
              {subagents.length ? `${subagents.filter((s) => s.state === 'running').length} subagent${subagents.length === 1 ? '' : 's'} working` : (status ?? 'Working')}…{' '}
              {busySince !== undefined ? `${elapsedLabel(Date.now() - busySince)} ` : ''}(esc interrupt · ctrl+enter cut in)
            </Text>
          </Box>
        ) : null}
        {subagents.length ? (
          <Box flexDirection="column">
            {subagents.slice(0, MAX_SUBAGENT_ROWS).map((s, i, shown) => (
              <Text key={s.id} wrap="truncate">
                <Text dimColor>{`  ${i === shown.length - 1 && subagents.length <= MAX_SUBAGENT_ROWS ? '└' : '├'} `}</Text>
                <Text color={s.state === 'queued' ? undefined : 'cyan'} dimColor={s.state === 'queued'}>
                  {s.type}
                </Text>
                <Text> {middleEllipsis(s.description, 32)}</Text>
                <Text dimColor>
                  {'  › '}
                  {s.activity}
                  {s.state === 'running' ? `  ${elapsedLabel(Date.now() - s.since)}` : ''}
                </Text>
              </Text>
            ))}
            {subagents.length > MAX_SUBAGENT_ROWS ? <Text dimColor>{`  └ … ${subagents.length - MAX_SUBAGENT_ROWS} more`}</Text> : null}
          </Box>
        ) : null}
        <Box ref={inputBoxRef} borderStyle="round" borderColor={busy || overlay ? 'gray' : shellMode ? 'magenta' : 'cyan'} paddingX={1} marginTop={1}>
          {search ? (
            <Text>
              <Text color="yellow">(reverse-i-search)</Text>`{search.query}`:{' '}
              {searchMatch >= 0 ? historyRef.current[searchMatch]!.split('\n')[0] : <Text dimColor>{search.query ? 'no match' : 'type to search earlier prompts'}</Text>}
            </Text>
          ) : (
            <>
              <Text color={shellMode ? 'magenta' : 'cyan'}>{shellMode ? '! ' : '› '}</Text>
              <Input
                value={input}
                cursor={cursor}
                onChange={(v, c) => {
                  setInput(v, c);
                  setMenuIndex(0);
                  historyPos.current = -1;
                }}
                onSubmit={(v) => void submit(v)}
                onImmediate={cutIn}
                onHistory={(d) => {
                  if (!busy) return browseHistory(d);
                  if (d !== 'older' || input) return undefined;
                  const back = takeBackPending();
                  if (back !== undefined) setInput(back);
                  return back;
                }}
                focus={!overlay}
                menuOpen={menuOpen}
                realCursor={Boolean(caret)}
                transformPaste={transformPaste}
                onImagePaste={pasteImage}
                width={inputBox.hasMeasured ? inputBox.width - innerLeft - 2 : size.columns - 6}
                mask={maskSecretInput}
                maxLines={inputMaxLines}
                onCopy={(text) => void copyToClipboard(text).then((via) => (via ? showFlash('✓ clipboard copied!') : showFlash('✗ clipboard unavailable', false)))}
                placeholder={busy ? (turnRef.current ? 'Type to steer the agent (delivered after the current step)' : '') : 'Ask anything · @ files · ! shell · / commands · \\⏎ newline'}
              />
            </>
          )}
        </Box>
        {menu ? (
          <Box flexDirection="column" paddingX={2}>
            {menuShown.map((item, k) => {
              const active = menuStart + k === selected;
              return (
                <Text key={item.value} wrap="truncate">
                  <Text color={active ? 'cyan' : undefined} bold={active}>
                    {active ? '❯ ' : '  '}
                    {item.label + ' '.repeat(Math.max(0, labelWidth - stringWidth(item.label)))}
                  </Text>
                  {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
                </Text>
              );
            })}
            <Text dimColor>
              {'  '}
              {menu.items.length > MENU_ROWS ? `${selected + 1}/${menu.items.length} · ` : ''}↑↓ select · {MENU_HINT[menu.kind]}
              {' · esc close'}
            </Text>
          </Box>
        ) : null}
        <Box justifyContent="space-between" paddingX={1}>
          <Text wrap="truncate">
            <Text color="blue">{middleEllipsis(where, Math.max(12, size.columns - 4 - (branch ? stringWidth(branch) + 4 : 0) - (flash ? stringWidth(flash.text) + 2 : 0) - (usageBarWidth('ctx', ctxPct, ctxLimit) + 1)))}</Text>
            {branch ? <Text color="green">{'  ⎇ '}{branch}</Text> : null}
            {flash ? (
              <Text color={flash.ok ? 'greenBright' : 'red'} bold>
                {'  '}
                {flash.text}
              </Text>
            ) : null}
          </Text>
          <Text wrap="truncate">
            <UsageBar label="ctx" percent={ctxPct} suffix={ctxLimit} />
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor wrap="truncate">
            {/* Keys and what each item means: /command. */}
            {agent.model.id}
            {modelIsZdr(agent.model) ? null : <Text color="red"> non-ZDR</Text>}
            {agent.model.reasoning ? (
              <>
                {' · '}
                <Text color={thinking === 'off' ? undefined : 'magenta'}>
                  {thinking === 'off' ? 'thinking off' : thinking === 'on' ? agent.thinkingLevel : busy && agent.turnLevel ? `auto: ${agent.turnLevel === 'none' ? 'fast' : agent.turnLevel}` : `auto ≤${agent.thinkingLevel}`}
                </Text>
              </>
            ) : null}
            {' · '}
            <Text color={mode === 'default' ? undefined : mode === 'dangerous' ? 'redBright' : mode === 'bypass' ? 'red' : 'yellow'} bold={mode === 'dangerous'}>
              {mode === 'dangerous' ? '⚠ dangerous' : mode}
            </Text>
            {mcp.total ? (
              <>
                {' · '}
                <Text color={mcp.connecting ? 'yellow' : mcp.ok < mcp.total ? 'red' : 'green'}>
                  mcp {mcp.connecting ? '…' : mcp.ok}/{mcp.total}
                </Text>
              </>
            ) : null}
            {agentsMode !== 'single' ? <Text color="cyan">{` · agents: ${agentsMode === 'multi' ? 'multi' : 'sub'}`}</Text> : null}
            {update ? <Text color="yellow">{` · ↑ ${update} (tessera-code update)`}</Text> : null}
          </Text>
        </Box>
        {/* The Go spend gauges get their own last line, right-aligned; context stays on the path line. */}
        <Box paddingX={1} justifyContent="flex-end">
          <Text wrap="truncate">
            {bars.map((b, i) => (
              <Fragment key={b.label}>
                {i > 0 ? '  ' : ''}
                <UsageBar label={b.label} percent={b.percent} reset={b.reset} />
              </Fragment>
            ))}
          </Text>
        </Box>
      </Box>
  );
  if (mouse) {
    return (
      <Box flexDirection="column" height={size.rows} overflow="hidden">
        <Box height={viewH} flexShrink={1} minHeight={0} overflow="hidden">
          <Text>{shownRows.join('\n')}</Text>
        </Box>
        {bottom}
      </Box>
    );
  }
  return (
    <>
      <Static key={staticKey} items={items}>
        {(item) => <HistoryView key={item.id} item={item} width={size.columns} expanded={openByDefault(item, expanded)} showThinking={core.config.showThinking} />}
      </Static>
      {bottom}
    </>
  );
}
