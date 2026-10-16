import stringWidth from 'string-width';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useBoxMetrics, useCursor, useInput, useStdout, type DOMElement } from 'ink';
import Spinner from 'ink-spinner';
import type { App as Core } from '../../app.js';
import type { Decision, PermissionMode, PermissionRequest } from '../../permissions.js';
import { loadCommands, runCommand, type Choice, type CommandResult } from '../../commands.js';
import { GO_LIMITS, spendWindows, type SpendWindows } from '../../cost/ledger.js';
import { formatTiming, formatTokens, formatUsage, gitBranch, hasSecret, maskSecretInput, notify, outputText, redactSecret, tildePath, toolLabel } from '../format.js';
import { streamTail, trimBlock, visualRows } from '../text.js';
import { loadMarkdown, markdown } from '../lazy-markdown.js';
import { appendInputHistory, loadInputHistory, searchHistory } from '../history.js';
import { transcriptOf } from '../transcript.js';
import { imagesFromPaths, readClipboardImage } from '../images.js';
import { copyToClipboard } from '../clipboard.js';
import type { ImageInput } from '../../agent/agent.js';
import type { CompactProgress } from '../../agent/compact.js';
import type { SubagentProgress } from '../../tools/task.js';
import type { WhatsNew } from '../../changelog.js';
import { Input, caretOf } from './Input.js';
import { applyCompletion, complete, enterAction, type CommandInfo, type CompletionItem } from '../completion.js';
import { VERSION } from '../../version.js';
import { suggestFiles } from '../../agent/attachments.js';
import { HistoryView, PermissionPrompt, Picker, middleEllipsis, type HistoryItem, type NewHistoryItem } from './components.js';

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

/** A usage gauge for the HUD: "ctx ▕███░░░░░░░▏ 38%", green → yellow (60%) → red (85%). */
export function UsageBar({ label, percent, suffix }: { label: string; percent: number; suffix?: string }) {
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
    </Text>
  );
}

/** Plain-text width of a UsageBar, for layout. */
export const usageBarWidth = (label: string, percent: number, suffix?: string) =>
  stringWidth(`${label} ▕${'░'.repeat(BAR_CELLS)}▏ ${Math.max(0, Math.min(100, Math.round(percent)))}%${suffix ? ` ${suffix}` : ''}`);

/** Live timer next to the spinner: whole seconds, then minutes. */
function elapsedLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// shift+tab cycle. 'dangerous' (never asks) is left out so it is never reached by accident: /mode, config or flag only.
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];
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
}: {
  core: Core;
  bridge: TuiBridge;
  initialPrompt?: string;
  initialCommand?: string;
  /** Release notes for the first run after an update; shown once, folded. */
  whatsNew?: WhatsNew;
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
      onReload={(notices, input, queue) => {
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
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
  for (const e of transcriptOf(agent.messages)) {
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
}) {
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
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setStaticKey((k) => k + 1);
  }, [stdout]);
  const toggleExpanded = () => {
    setExpanded((e) => !e);
    redraw();
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
      if (width !== lastWidth) widthChanged = true;
      lastWidth = width;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!widthChanged) return;
        widthChanged = false;
        redraw();
      }, 150);
    };
    stdout.on('resize', onResize);
    return () => {
      clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout, redraw]);
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
  const [thinking, setThinking] = useState(agent.thinking);
  const [mode, setMode] = useState<PermissionMode>(core.permissions.mode);
  const [spend, setSpend] = useState<SpendWindows | undefined>();
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
  const transformPaste = (text: string): string => {
    const images = imagesFromPaths(text);
    return images ? images.map((i) => attachImage(i)).join(' ') + ' ' : text;
  };
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

  const push = useCallback((item: NewHistoryItem) => setItems((prev) => [...prev, { ...item, id: nextId++ } as HistoryItem]), []);

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
    // Each subagent gets its own line (several run at once in multi-agent mode); a finished one leaves the list.
    core.onTaskProgress = (p) =>
      setSubagents((list) => {
        if (p.state === 'done') return list.filter((s) => s.id !== p.id);
        const i = list.findIndex((s) => s.id === p.id);
        if (i < 0) return [...list, { ...p, since: Date.now() }];
        const next = [...list];
        next[i] = { ...next[i]!, ...p, since: next[i]!.state === 'queued' && p.state === 'running' ? Date.now() : next[i]!.since };
        return next;
      });
    agent.onCompactProgress = (p) => setStatus(p.phase === 'done' ? (turnRef.current ? 'Thinking' : undefined) : compactLabel(p));
    bridge.ask = (req) => new Promise<Decision>((resolve) => setPending({ req, resolve }));
    bridge.onDiff = (path, diff) => pendingDiffs.current.push({ path, diff });
    void spendWindows().then(setSpend);
    void gitBranch(core.ctx.cwd).then(setBranch);
    void loadInputHistory(core.ctx.cwd).then((h) => (historyRef.current = h));
    loadMarkdown().catch(() => {}); // after the first frame; needed only once answers arrive (raw text until then)
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
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };
  const endBusy = () => {
    setSubagents([]); // an interrupted turn leaves no subagent lines behind
    abortRef.current = undefined;
    busyRef.current = false;
    setBusy(false);
    setStatus(undefined);
    setBusySince(undefined);
  };

  const runTurn = useCallback(
    async (prompt: string, images: ImageInput[] = []) => {
      const controller = startBusy('Thinking');
      turnRef.current = true;
      const started = Date.now();
      const labels = new Map<string, string>();
      let failed = false;
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
              labels.set(ev.id, toolLabel(ev.name, ev.input));
              setStatus(`Running ${toolLabel(ev.name, ev.input)}`);
              break;
            case 'tool-result':
              push({ kind: 'tool', label: labels.get(ev.id) ?? ev.name, output: outputText(ev.output), isError: ev.isError });
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
              flushReasoning();
              flushStream();
              push({ kind: 'info', text: `${formatTiming(ev)} · ${formatUsage(ev.usage)}` });
              break;
            case 'error':
              failed = true;
              flushReasoning();
              flushStream();
              push({ kind: 'error', text: ev.message });
              break;
          }
        }
        if (controller.signal.aborted) {
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
        if (unread.length && controller.signal.aborted) {
          // Interrupted: hand the unsent messages back for editing instead of starting a new turn on its own.
          setInput([inputRef.current.input, ...unread].filter(Boolean).join('\n'));
        } else if (unread.length) {
          queueRef.current.push(...unread);
          setQueued(queueRef.current.map(redactSecret));
        }
        endBusy();
        const seconds = (Date.now() - started) / 1000;
        const after = core.config.notifyAfterSeconds;
        if (after > 0 && seconds >= after && !controller.signal.aborted) notify(`tessera-code: ${failed ? 'stopped with an error' : 'done'} (${Math.round(seconds)}s)`);
        setSpend(await spendWindows());
        setBranch(await gitBranch(core.ctx.cwd)); // the agent may have switched branches
      }
    },
    [core, flushReasoning, flushStream, push, scheduleRender],
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
      setThinking(agent.thinking);
      setAgentsModeState(core.agentsMode());
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
      const text = raw.trim();
      setInput('');
      if (!text) return;
      if (busyRef.current) {
        if (turnRef.current && !/^[/!]/.test(text) && !/\[Image #\d+\]/.test(text)) {
          // Typed while the agent works: steer the running turn (delivered after the current step).
          core.agent.interject(text);
          setInterjecting((list) => [...list, text]);
          historyRef.current = [text, ...historyRef.current.filter((h) => h !== text)];
          void appendInputHistory(core.ctx.cwd, text);
          return;
        }
        // Commands and shell lines wait for the turn to end.
        queueRef.current.push(text);
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
      push({ kind: 'user', text: redactSecret(text) });
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
        await runTurn(text, takeImages(text));
      }
      // Images whose tags were deleted or never sent are dropped (each can be megabytes).
      const referenced = new Set([...queueRef.current, input].flatMap((q) => [...q.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]))));
      for (const n of imagesRef.current.keys()) if (!referenced.has(n)) imagesRef.current.delete(n);
      await drainRef.current();
    },
    [applyResult, core, push, runShell, runTurn, setInput],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;

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
    if (key.ctrl && ch === 't') {
      agent.thinking = !agent.thinking;
      setThinking(agent.thinking);
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
        const edited = editInEditor(input);
        setInput(edited);
      });
    }
  });

  // Keep the live area shorter than the screen (input box, status, footer, menu, picker and queue take the rest).
  const inputRows = visualRows(input || ' ', size.columns - 7); // border, padding and prompt
  const queuedRows = [...queued, ...interjecting].reduce((n, q) => n + visualRows(`↳ will be sent after the current step: ${q}`, size.columns), 0);
  const pickerRows = choice ? Math.min(choice.options.length, 10) + 5 : 0;
  const MENU_ROWS = 8;
  const menuStart = menu ? Math.min(Math.max(0, selected - MENU_ROWS + 1), Math.max(0, menu.items.length - MENU_ROWS)) : 0;
  const menuShown = menu ? menu.items.slice(menuStart, menuStart + MENU_ROWS) : [];
  const labelWidth = Math.min(32, Math.max(0, ...menuShown.map((m) => stringWidth(m.label))));

  const ctxPct = Math.round((agent.contextTokens / agent.contextLimit) * 100);
  const where = tildePath(core.ctx.cwd);
  const fiveHourPct = spend ? (spend.fiveHour / GO_LIMITS.fiveHour) * 100 : undefined;
  // Gauges only: the session's own spend is in /cost; the details of both are in /context and /cost.
  const ctxLimit = `(${formatTokens(agent.contextLimit)})`;
  const meterWidth = usageBarWidth('ctx', ctxPct, ctxLimit) + (fiveHourPct !== undefined ? 2 + usageBarWidth('5h', fiveHourPct) : 0);
  const shellMode = input.startsWith('!');
  const hudSplit = size.columns < meterWidth + 30;
  const subagentRows = busy && !pending ? Math.min(subagents.length, MAX_SUBAGENT_ROWS + 1) : 0;
  const liveRows = size.rows - 9 - (hudSplit ? 1 : 0) - inputRows - queuedRows - pickerRows - subagentRows - (menu ? menuShown.length + 1 : 0);
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
  const caret = caretActive ? caretOf(input, cursor, inputBox.width - innerLeft - 2) : undefined;
  setCursorPosition(caret ? { x: inputBox.left + innerLeft + caret.x, y: frame.top + inputBox.top + 1 + caret.row } : undefined);

  return (
    <>
      <Static key={staticKey} items={items}>
        {(item) => <HistoryView key={item.id} item={item} width={size.columns} expanded={expanded} showThinking={core.config.showThinking} />}
      </Static>
      <Box flexDirection="column" ref={frameRef}>
        {thinkingTail ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="magenta" dimColor>
              ∴ Thinking…
            </Text>
            <Text dimColor italic>
              {thinkingTail.text.replace(/^/gm, '  ')}
            </Text>
          </Box>
        ) : null}
        {live ? (
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
        {busy && !pending ? (
          <Box marginTop={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor>
              {' '}
              {subagents.length ? `${subagents.filter((s) => s.state === 'running').length} subagent${subagents.length === 1 ? '' : 's'} working` : (status ?? 'Working')}…{' '}
              {busySince !== undefined ? `${elapsedLabel(Date.now() - busySince)} ` : ''}(esc to interrupt)
            </Text>
          </Box>
        ) : null}
        {busy && !pending && subagents.length ? (
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
                onHistory={(d) => (busy ? undefined : browseHistory(d))}
                focus={!overlay}
                menuOpen={menuOpen}
                realCursor={Boolean(caret)}
                transformPaste={transformPaste}
                onImagePaste={pasteImage}
                width={inputBox.hasMeasured ? inputBox.width - innerLeft - 2 : size.columns - 6}
                mask={maskSecretInput}
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
        {/* Path and usage share a line when there is room; narrow terminals get one line each. */}
        <Box justifyContent="space-between" paddingX={1} flexDirection={hudSplit ? 'column' : 'row'}>
          <Text wrap="truncate">
            <Text color="blue">{middleEllipsis(where, Math.max(12, size.columns - 4 - (hudSplit ? 0 : meterWidth + 1) - (branch ? stringWidth(branch) + 4 : 0) - (flash ? stringWidth(flash.text) + 2 : 0)))}</Text>
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
            {fiveHourPct !== undefined ? (
              <>
                {'  '}
                <UsageBar label="5h" percent={fiveHourPct} />
              </>
            ) : null}
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor wrap="truncate">
            {/* Keys and what each item means: /command. */}
            {agent.model.id}
            {agent.model.reasoning ? (
              <>
                {' · '}
                <Text color={thinking ? 'magenta' : undefined}>{thinking ? agent.thinkingLevel : 'thinking off'}</Text>
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
      </Box>
    </>
  );
}
