/**
 * The remote web app (bundled for the browser into app.js by scripts/build.mjs). Shows one session's events as they
 * stream in, and sends prompts, interrupts, permission answers and picker choices back.
 *
 * Model output is untrusted: markdown is rendered with raw HTML escaped and only http(s)/mailto links, and the page's
 * Content-Security-Policy lets it load nothing from elsewhere.
 */
import { Marked, type Tokens } from 'marked';
import type { Decision, RemoteEvent, SessionList, SessionState, StoredSession } from '../protocol.js';
import { forgetPairing, LocalTransport, RelayTransport, storedPairing, TransportError, type Transport } from './transport.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const logEl = $<HTMLDivElement>('#log');
const input = $<HTMLTextAreaElement>('#input');
const sendBtn = $<HTMLButtonElement>('#send');
const stopBtn = $<HTMLButtonElement>('#stop');
const statusEl = $<HTMLDivElement>('#status');
const queuedEl = $<HTMLDivElement>('#queued');
const sessionSel = $<HTMLSelectElement>('#session');
const metaEl = $<HTMLDivElement>('#meta');
const dialog = $<HTMLDialogElement>('#open-dialog');
const cwdInput = $<HTMLInputElement>('#cwd');
const rootsList = $<HTMLDataListElement>('#roots');
const storedEl = $<HTMLDivElement>('#stored');
const noticeEl = $<HTMLDivElement>('#notice');

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SAFE_URL = /^(https?:|mailto:)/i;

const md = new Marked({ gfm: true });
md.use({
  tokenizer: {
    // Like the terminal: only ~~text~~ is strikethrough (Korean ranges such as 1~3 use single tildes).
    del(this: { lexer: { inlineTokens: (src: string) => Tokens.Generic[] } }, src: string) {
      const m = /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/.exec(src);
      if (m) return { type: 'del', raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
      const tildes = /^~+/.exec(src)?.[0];
      return tildes ? ({ type: 'text', raw: tildes, text: tildes } as unknown as Tokens.Del) : undefined;
    },
  },
  renderer: {
    html: (token: Tokens.HTML | Tokens.Tag) => escapeHtml(token.text),
    link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      return SAFE_URL.test(token.href) ? `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image: (token: Tokens.Image) => escapeHtml(`[${token.text}]`),
  },
});
const markdown = (text: string) => md.parse(text, { async: false }) as string;

/** Set by start(): this computer directly, or the relay. */
let transport: Transport = new LocalTransport();

function api<T>(path: string, body?: unknown): Promise<T> {
  return transport.request<T>(body === undefined ? 'GET' : 'POST', path, body);
}

function notice(text: string, error = true): void {
  noticeEl.textContent = text;
  noticeEl.className = error ? 'notice error' : 'notice';
  noticeEl.hidden = !text;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function diffEl(diff: string): HTMLElement {
  const pre = el('pre', 'diff');
  for (const line of diff.split('\n')) {
    if (line.startsWith('\\')) continue;
    const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'file' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    pre.append(el('span', cls, line + '\n'));
  }
  return pre;
}

// --- The conversation -----------------------------------------------------------------------------------------------

let current: string | undefined; // session handle
let source: AbortController | undefined; // the open event stream
let state: SessionState | undefined;
/** The block streamed text goes to, while text keeps coming. */
let streaming: { kind: 'text' | 'reasoning'; el: HTMLElement; body: HTMLElement; text: string } | undefined;
const tools = new Map<string, HTMLDetailsElement>();
let renderQueued = false;

function nearBottom(): boolean {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
}

function add(seq: number, node: HTMLElement): void {
  const stick = nearBottom();
  node.dataset.seq = String(seq);
  logEl.append(node);
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function draw(s: NonNullable<typeof streaming>): void {
  const stick = nearBottom();
  if (s.kind === 'text') s.body.innerHTML = markdown(s.text);
  else s.body.textContent = s.text;
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

/** Streamed text is drawn once per frame; a replay delivers many events in one frame. */
function renderStreaming(): void {
  renderQueued = false;
  if (streaming) draw(streaming);
}

/** The streamed block is complete: draw what the next frame would have drawn, then stop adding to it. */
function endStreaming(): void {
  if (streaming) draw(streaming);
  streaming = undefined;
}

function apply(seq: number, ev: RemoteEvent): void {
  if (ev.kind !== 'text' && ev.kind !== 'reasoning' && ev.kind !== 'state') endStreaming();
  switch (ev.kind) {
    case 'state':
      return showState(ev.state);
    case 'reset':
      logEl.replaceChildren();
      tools.clear();
      streaming = undefined;
      return;
    case 'user':
      return add(seq, el('div', 'user', ev.text));
    case 'text':
    case 'reasoning': {
      if (streaming?.kind !== ev.kind) {
        endStreaming();
        if (ev.kind === 'text') {
          const block = el('div', 'answer md');
          streaming = { kind: 'text', el: block, body: block, text: '' };
        } else {
          const block = el('details', 'reasoning') as HTMLDetailsElement;
          block.append(el('summary', '', 'Thinking'));
          const body = el('div', 'reasoning-body');
          block.append(body);
          streaming = { kind: 'reasoning', el: block, body, text: '' };
        }
        add(seq, streaming.el);
      }
      streaming.text += ev.text;
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(renderStreaming);
      }
      return;
    }
    case 'markdown': {
      const block = el('div', 'answer md');
      block.innerHTML = markdown(ev.text);
      return add(seq, block);
    }
    case 'tool': {
      const block = el('details', 'tool') as HTMLDetailsElement;
      block.append(el('summary', '', `● ${ev.label}`));
      tools.set(ev.id, block);
      return add(seq, block);
    }
    case 'tool-result': {
      let block = ev.id ? tools.get(ev.id) : undefined;
      if (!block) {
        block = el('details', 'tool') as HTMLDetailsElement;
        block.append(el('summary', '', `● ${ev.label}`));
        add(seq, block);
      }
      if (ev.isError) block.classList.add('error');
      const lines = ev.output.split('\n');
      block.querySelector('summary')!.append(el('span', 'hint', ` ${lines.length} line${lines.length === 1 ? '' : 's'}`));
      block.append(el('pre', 'output', ev.output));
      return;
    }
    case 'diff': {
      const block = el('div', 'diff-block');
      block.append(el('div', 'path', ev.path), diffEl(ev.diff));
      return add(seq, block);
    }
    case 'info':
      return add(seq, el('div', 'info', ev.text));
    case 'error':
      return add(seq, el('div', 'error-line', `✗ ${ev.text}`));
    case 'turn-finish':
      return add(seq, el('div', 'summary', ev.summary));
    case 'discard': {
      for (const node of [...logEl.children] as HTMLElement[]) if (Number(node.dataset.seq) >= ev.from) node.remove();
      // Only the device that sent it would know it was its own: offer it back wherever the input is empty.
      if (!input.value.trim()) input.value = ev.text;
      notice('Cancelled before an answer: the message is back in the input.', false);
      return;
    }
    case 'permission':
      return add(seq, permissionCard(ev));
    case 'permission-done': {
      const card = logEl.querySelector<HTMLElement>(`[data-permission="${CSS.escape(ev.id)}"]`);
      if (card) {
        card.querySelector('.actions')?.remove();
        card.classList.add('done');
        card.append(el('div', 'decision', ev.decision === 'deny' ? 'Denied' : ev.decision === 'allow-once' ? 'Allowed once' : 'Allowed (remembered)'));
      }
      return;
    }
    case 'choose':
      return add(seq, chooseCard(ev));
    case 'choose-done':
      logEl.querySelector(`[data-choose="${CSS.escape(ev.id)}"] .actions`)?.remove();
      return;
  }
}

function permissionCard(ev: Extract<RemoteEvent, { kind: 'permission' }>): HTMLElement {
  const card = el('div', 'card permission');
  card.dataset.permission = ev.id;
  card.append(el('div', 'title', ev.title));
  if (ev.detail) card.append(ev.tool === 'edit' ? diffEl(ev.detail) : el('pre', 'output', ev.detail));
  const actions = el('div', 'actions');
  const choices: Array<[string, Decision, string]> = [
    ['Allow', 'allow-once', 'primary'],
    ...(ev.rememberable ? ([['Allow for this session', 'allow-session', '']] as Array<[string, Decision, string]>) : []),
    ['Deny', 'deny', 'danger'],
  ];
  for (const [label, decision, cls] of choices) {
    const b = el('button', cls, label) as HTMLButtonElement;
    b.onclick = () => void act(`/api/sessions/${current}/permission`, { id: ev.id, decision });
    actions.append(b);
  }
  card.append(actions);
  return card;
}

function chooseCard(ev: Extract<RemoteEvent, { kind: 'choose' }>): HTMLElement {
  const card = el('div', 'card choose');
  card.dataset.choose = ev.id;
  card.append(el('div', 'title', ev.title));
  const actions = el('div', 'actions column');
  ev.options.forEach((o, index) => {
    const b = el('button', '', o.label) as HTMLButtonElement;
    if (o.hint) b.append(el('span', 'hint', ` ${o.hint}`));
    b.onclick = () => void act(`/api/sessions/${current}/choose`, { id: ev.id, index });
    actions.append(b);
  });
  const cancel = el('button', 'quiet', 'Cancel') as HTMLButtonElement;
  cancel.onclick = () => void act(`/api/sessions/${current}/choose`, { id: ev.id, index: -1 });
  actions.append(cancel);
  card.append(actions);
  return card;
}

async function act(path: string, body: unknown): Promise<void> {
  try {
    await api(path, body);
  } catch (e) {
    notice((e as Error).message);
  }
}

function showState(s: SessionState): void {
  state = s;
  metaEl.textContent = `${s.title ?? s.session.slice(0, 8)} · ${s.cwd} · ${s.model}${s.thinking === undefined ? '' : s.thinking ? (s.thinkingAuto ? ' · thinking auto' : ' · thinking') : ''} · ${s.mode}`;
  statusEl.hidden = !s.busy;
  statusEl.textContent = s.busy ? `${s.busy}…` : '';
  stopBtn.hidden = !s.busy;
  input.placeholder = s.busy ? 'Steer the agent (delivered after the current step)' : 'Ask anything · ! shell · / commands';
  queuedEl.replaceChildren(...s.queued.map((q) => el('div', '', q)));
  queuedEl.hidden = !s.queued.length;
  const opt = [...sessionSel.options].find((o) => o.value === s.id);
  if (opt) opt.textContent = label(s);
}

const label = (s: SessionState) => `${s.title ?? s.session.slice(0, 8)} — ${s.cwd.split('/').pop() || s.cwd}`;

function connect(id: string): void {
  source?.abort();
  current = id;
  try {
    localStorage.setItem('tessera.session', id);
  } catch {
    // private mode: nothing to remember
  }
  logEl.replaceChildren();
  tools.clear();
  streaming = undefined;
  notice('');
  const ac = new AbortController();
  source = ac;
  void listen(id, ac.signal);
}

/** Follows the session's events (the transport reconnects and resumes by itself) until it is gone or switched away. */
async function listen(id: string, signal: AbortSignal): Promise<void> {
  const end = await transport.events(id, apply, signal);
  if (signal.aborted) return;
  if (source?.signal === signal) source = undefined;
  if (end === 'unpaired') showUnpaired();
  else void refresh(); // the session was closed (or the server restarted): show what is there now
}

function showUnpaired(message?: string): void {
  document.body.classList.add('unpaired');
  if (message) $<HTMLParagraphElement>('#unpaired-detail').textContent = message;
  // Pairing through the relay: the key stays until the user drops it (a refusal could be forged by the relay).
  const forget = $<HTMLButtonElement>('#forget');
  forget.hidden = !(transport instanceof RelayTransport);
  forget.onclick = async () => {
    if (!confirm('Delete this browser\'s key for your computer? You will need to scan a new QR code.')) return;
    await forgetPairing();
    location.reload();
  };
}

async function refresh(select?: string): Promise<void> {
  let list: SessionList;
  try {
    list = await api<SessionList>('/api/sessions');
  } catch (e) {
    if ((e as TransportError).status === 401) {
      showUnpaired(transport instanceof RelayTransport ? transport.refusal : undefined);
      return;
    }
    notice((e as Error).message);
    return;
  }
  document.body.classList.remove('unpaired');
  rootsList.replaceChildren(...list.roots.map((r) => Object.assign(document.createElement('option'), { value: r })));
  if (!cwdInput.value) cwdInput.value = list.roots[0] ?? '';
  sessionSel.replaceChildren(...list.open.map((s) => Object.assign(document.createElement('option'), { value: s.id, textContent: label(s) })));
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem('tessera.session');
  } catch {
    // ignore
  }
  const target = [select, current, remembered].find((id) => id && list.open.some((s) => s.id === id)) ?? list.open[0]?.id;
  if (!target) {
    source?.abort();
    source = undefined;
    current = undefined;
    logEl.replaceChildren(el('div', 'empty', 'No session is open. Open one with ＋.'));
    metaEl.textContent = '';
    return;
  }
  sessionSel.value = target;
  if (target !== current || !source) connect(target);
}

// --- Controls -------------------------------------------------------------------------------------------------------

async function submit(): Promise<void> {
  const text = input.value;
  if (!text.trim() || !current) return;
  input.value = '';
  notice('');
  try {
    await api(`/api/sessions/${current}/send`, { text });
  } catch (e) {
    input.value = text;
    notice((e as Error).message);
  }
}

const touch = matchMedia('(pointer: coarse)').matches;
input.addEventListener('keydown', (e) => {
  // On a phone enter makes a new line (the send button sends); with a keyboard enter sends and shift+enter is a newline.
  if (e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (!touch && !e.shiftKey))) {
    e.preventDefault();
    void submit();
  }
});
sendBtn.onclick = () => void submit();
stopBtn.onclick = () => current && void act(`/api/sessions/${current}/interrupt`, {});
sessionSel.onchange = () => connect(sessionSel.value);

$<HTMLButtonElement>('#open').onclick = () => {
  void loadStored();
  dialog.showModal();
};
$<HTMLButtonElement>('#close-session').onclick = async () => {
  if (!current || !confirm('Close this session? (It stays saved and can be resumed.)')) return;
  await act(`/api/sessions/${current}/close`, {});
  current = undefined;
  await refresh();
};
$<HTMLButtonElement>('#dialog-cancel').onclick = () => dialog.close();
$<HTMLButtonElement>('#new-session').onclick = () => void openSession();
cwdInput.onchange = () => void loadStored();

async function loadStored(): Promise<void> {
  storedEl.replaceChildren();
  if (!cwdInput.value) return;
  try {
    const list = await api<StoredSession[]>(`/api/stored?cwd=${encodeURIComponent(cwdInput.value)}`);
    for (const s of list) {
      const b = el('button', 'stored-item') as HTMLButtonElement;
      b.append(el('span', '', s.title), el('span', 'hint', ` ${new Date(s.updatedAt).toLocaleString()} · ${s.messages} msgs`));
      b.onclick = () => void openSession(s.id);
      storedEl.append(b);
    }
    if (!list.length) storedEl.append(el('div', 'hint', 'No saved sessions here.'));
  } catch (e) {
    storedEl.append(el('div', 'error-line', (e as Error).message));
  }
}

async function openSession(resume?: string): Promise<void> {
  try {
    const s = await api<SessionState>('/api/sessions', { cwd: cwdInput.value, resume });
    dialog.close();
    await refresh(s.id);
  } catch (e) {
    storedEl.prepend(el('div', 'error-line', (e as Error).message));
  }
}

// --- Start ----------------------------------------------------------------------------------------------------------

async function start(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  // Single-use codes and keys: out of the address bar and the history at once.
  if (location.hash) history.replaceState(null, '', location.pathname);
  const name = navigator.userAgent.replace(/^Mozilla\/5\.0 \(([^)]*)\).*$/, '$1').slice(0, 80);
  try {
    const [daemon, key, secret, code] = [params.get('d'), params.get('k'), params.get('p'), params.get('pair')];
    if (daemon && key && secret) {
      // Scanned the QR code: pair through the relay (end-to-end encrypted from here on).
      transport = await RelayTransport.pair(daemon, key, secret, name);
      notice('Paired with your computer.', false);
    } else {
      const stored = await storedPairing();
      if (stored) transport = RelayTransport.fromStored(stored);
      else if (code) await (transport as LocalTransport).pair(code, name);
      else if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return showUnpaired(); // the relay's page, not paired yet
    }
  } catch (e) {
    if (params.get('d')) return showUnpaired((e as Error).message);
    notice((e as Error).message);
  }
  transport.onReconnecting = () => {
    statusEl.hidden = false;
    statusEl.textContent = 'Reconnecting…';
  };
  await refresh();
}

void start();
