import type { SessionController } from './controller.js';
import type { Devices } from './devices.js';
import type { Decision, Sequenced, SessionList, SessionState, StoredSession } from './protocol.js';

/**
 * The remote API's routes, independent of how requests arrive: the local HTTP server (server.ts) and the end-to-end
 * encrypted channel through the relay (link.ts) both call these after authenticating the device their own way.
 */

/** What the API serves: the daemon's open sessions. */
export interface Hub {
  list(): SessionList;
  get(id: string): SessionController | undefined;
  /** Opens a session in `cwd` (must be under a root), resuming `resume` when given. */
  open(cwd: string | undefined, resume?: string): Promise<SessionState>;
  close(id: string): Promise<void>;
  stored(cwd: string): Promise<StoredSession[]>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiRequest {
  method: string;
  /** Path and query, e.g. "/api/stored?cwd=/work". */
  path: string;
  body: Record<string, unknown>;
  /** The authenticated device. */
  device: string;
}

const DECISIONS: Decision[] = ['allow-once', 'allow-session', 'allow-always', 'deny'];
const SESSION_ROUTE = /^\/api\/sessions\/([\w-]+)\/(events|send|interrupt|permission|choose|close)$/;

/** The session whose event stream `path` asks for (GET /api/sessions/:id/events), or undefined for other routes. */
export function eventsRoute(hub: Hub, method: string, path: string): SessionController | undefined {
  const m = SESSION_ROUTE.exec(new URL(path, 'http://x').pathname);
  if (method !== 'GET' || m?.[2] !== 'events') return undefined;
  const session = hub.get(m[1]!);
  if (!session) throw new ApiError(404, 'No such session (it was closed or the server restarted).');
  return session;
}

/** Handles every route but pairing and the event stream; resolves with the JSON body to return. */
export async function callApi(hub: Hub, devices: Devices, req: ApiRequest): Promise<unknown> {
  const url = new URL(req.path, 'http://x');
  const path = url.pathname;
  const { method, body } = req;
  if (method === 'GET' && path === '/api/sessions') return hub.list();
  if (method === 'POST' && path === '/api/sessions') {
    return badRequest(hub.open(typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined, typeof body.resume === 'string' ? body.resume : undefined));
  }
  if (method === 'GET' && path === '/api/stored') return badRequest(hub.stored(url.searchParams.get('cwd') ?? ''));
  if (method === 'POST' && path === '/api/logout') {
    await devices.revoke(req.device);
    return {};
  }
  const m = SESSION_ROUTE.exec(path);
  if (!m) throw new ApiError(404, 'Not found');
  const [, id, action] = m as unknown as [string, string, string];
  if (method !== 'POST') throw new ApiError(405, 'Method not allowed');
  if (action === 'close') {
    await hub.close(id);
    return {};
  }
  const session = hub.get(id);
  if (!session) throw new ApiError(404, 'No such session (it was closed or the server restarted).');
  switch (action) {
    case 'send':
      if (typeof body.text !== 'string') throw new ApiError(400, 'text is required');
      session.send(body.text);
      return {};
    case 'interrupt':
      session.interrupt();
      return {};
    case 'permission': {
      const decision = body.decision as Decision;
      if (!DECISIONS.includes(decision)) throw new ApiError(400, `decision must be one of ${DECISIONS.join(', ')}`);
      return { ok: session.answer(String(body.id), decision) };
    }
    case 'choose':
      return { ok: await session.choose(String(body.id), Number(body.index)) };
    default:
      throw new ApiError(405, 'Method not allowed');
  }
}

/**
 * Sends a session's stream to `write`: the current state, the recorded events after `after` (with `reset` first when
 * older ones were dropped), then live events. Returns the function that stops it.
 */
export function streamEvents(session: SessionController, after: number | undefined, write: (e: Sequenced) => void): () => void {
  // Subscribe before reading the record so nothing falls between the two; drop duplicates by seq.
  let sent = after ?? 0;
  const live: Sequenced[] = [];
  let replaying = true;
  const unsubscribe = session.subscribe((e) => {
    if (replaying) live.push(e);
    else if (!e.seq || e.seq > sent) {
      write(e);
      if (e.seq) sent = e.seq;
    }
  });
  write({ seq: 0, event: { kind: 'state', state: session.state() } });
  const { events, reset } = session.events(after !== undefined && Number.isFinite(after) ? after : undefined);
  if (reset) write({ seq: 0, event: { kind: 'reset' } });
  for (const e of [...events, ...live]) {
    if (e.seq && e.seq <= sent) continue;
    write(e);
    if (e.seq) sent = e.seq;
  }
  replaying = false;
  return unsubscribe;
}

/** A directory the client named that is missing or not allowed is the client's error, not the server's. */
function badRequest<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    throw new ApiError(400, e instanceof Error ? e.message : String(e));
  });
}
