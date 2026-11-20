/**
 * What the remote web app and `tessera-code serve` exchange. Types only: the browser bundle imports this file too.
 *
 * Server → app: Server-Sent Events, one RemoteEvent per message, `id:` = its seq. A reconnect sends Last-Event-ID and
 * gets only what came after. App → server: JSON POSTs (see server.ts).
 */

export type Decision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export type RemoteEvent =
  /** The session as it is now; sent first on every connection. */
  | { kind: 'state'; state: SessionState }
  /** The conversation was replaced (/clear, /resume, /rewind): drop everything before this event. */
  | { kind: 'reset' }
  | { kind: 'user'; text: string }
  /** A piece of the answer (several streamed deltas merged). */
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; id: string; label: string }
  | { kind: 'tool-result'; id: string; label: string; output: string; isError: boolean }
  | { kind: 'diff'; path: string; diff: string }
  /** Markdown to show like an answer (command output such as release notes). */
  | { kind: 'markdown'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'turn-finish'; summary: string }
  /**
   * The turn was cancelled before the model answered: remove the events from `from` (the user's message) on, and put
   * `text` back in the input.
   */
  | { kind: 'discard'; from: number; text: string }
  | { kind: 'permission'; id: string; title: string; detail?: string; tool: string; rememberable: boolean }
  | { kind: 'permission-done'; id: string; decision: Decision }
  /** A command asks to pick one option (answered with POST …/choose). */
  | { kind: 'choose'; id: string; title: string; options: Array<{ label: string; hint?: string }> }
  | { kind: 'choose-done'; id: string };

export interface SessionState {
  /** The daemon's handle for this session (stays the same across /clear, /new and /resume). */
  id: string;
  /** The stored session's id (changes with /clear, /new and /resume). */
  session: string;
  cwd: string;
  title?: string;
  model: string;
  thinking?: boolean;
  /** With thinking on: only for prompts that need it. */
  thinkingAuto?: boolean;
  mode: string;
  /** What the agent is doing ("Thinking", "Running bash(npm test)"), or undefined when idle. */
  busy?: string;
  /** Messages typed while busy, waiting for the turn to end. */
  queued: string[];
}

export interface Sequenced {
  seq: number;
  event: RemoteEvent;
}

/** GET /api/sessions */
export interface SessionList {
  open: SessionState[];
  /** Directories new sessions may be started in. */
  roots: string[];
}

/** GET /api/stored?cwd=… */
export interface StoredSession {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}
