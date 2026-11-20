# Remote control

Drive tessera-code sessions from a browser (and, from stage 2 on, a phone anywhere) while the agent keeps running on
your own computer: code, tools, MCP servers and keys never leave it.

| Stage | Scope | Status |
|---|---|---|
| 1 | Headless daemon (`tessera-code serve`), session controller, HTTP/SSE API, web app, pairing — on `127.0.0.1` | implemented |
| 2 | Relay on a personal VPS, end-to-end encryption, QR pairing — reachable from anywhere without a VPN | implemented |
| 3 | Web push (approval needed / turn done), start at login (launchd), image upload | planned |

Constraints that shaped the design:

- Organization policy forbids putting confidential data into third-party services: whatever sits between the phone and
  the computer may see only ciphertext and metadata.
- The CLI ships as one bundle with no runtime dependencies: Node built-ins only on the server side
  (`node:http`, `node:crypto`), WebCrypto in the browser.
- The remote side must not be able to change how the computer itself is set up (keys, global settings, trust).

---

## 1. Stage 1: what is implemented

### 1.1 Overview

```
browser (web app) ── HTTP: GET /api/…, POST /api/… ──▶ tessera-code serve ──▶ SessionController ──▶ App (core.run)
                  ◀── SSE: numbered events ───────────            (127.0.0.1)        one per open session
```

`tessera-code serve` runs without a terminal UI. It keeps several sessions open, and each one is driven by a
`SessionController`, which does for the remote app what `App.tsx` does for the TUI. The browser reads a session's
events as a Server-Sent Events stream and sends prompts, interrupts and answers as JSON POSTs.

### 1.2 Files

| File | Role |
|---|---|
| `src/remote/protocol.ts` | Types shared by server and browser: `RemoteEvent`, `SessionState`, list payloads |
| `src/remote/controller.ts` | `SessionController`: runs turns, `!` shell lines and `/` commands; records numbered events; permission prompts and pickers; command restrictions |
| `src/remote/server.ts` | `startServer(hub, devices, {port})`: HTTP API, SSE streams, static web app, host/origin/token checks |
| `src/remote/devices.ts` | `Devices`: one-time pairing codes, paired device tokens (hashed in `~/.tessera-code/remote.json`) |
| `src/remote/daemon.ts` | `Daemon` (the `Hub`: open/close/list sessions, allowed roots), `remoteSettings()`, `serve()` |
| `src/remote/web/` | Web app: `client.ts` (bundled to `app.js`), `index.html`, `app.css`, `icon.svg` |
| `src/cli.ts` | `serve` command (`--port`, `--forget-devices`) |
| `scripts/build.mjs` | Second esbuild pass: `client.ts` → `dist/bundle/web/app.js` (browser, minified), static files copied |
| `tests/remote.test.ts` | Controller, server security, pairing, SSE resume, roots |

The server finds the web app next to its bundle chunk (`dist/bundle/web/`) or, when run from source, in the build
output; without a build the API still works and `/` answers 500.

### 1.3 Session controller

`SessionController` wraps one `App` (the same core the TUI uses) and is UI-independent.

- **Event record.** Every event gets a sequence number (`seq`) and is kept (last 5000). A client asks for the
  events after the last `seq` it saw; when older ones were dropped it gets `reset` first. State changes (`busy`
  label, queue, model, mode) are not recorded: they are pushed live, and a client gets the current state first on
  every connection.
- **Streaming text.** Text and thinking deltas are merged and recorded at most every 80 ms; any other event flushes
  them first, so order is preserved.
- **Sending while busy.** A plain message during a turn steers it (`agent.interject`); `!` and `/` lines and messages
  during a shell command or command wait in a queue and run in order once idle. Interjections the agent never read
  run next as a new turn (or, after an interrupt, are reported as not delivered).
- **Cancel before any answer.** If a turn is interrupted before the model produced anything, the agent leaves it out
  of the history (see `turn-finish.discarded`), the controller deletes the events from the user's message on and
  sends `discard {from, text}`; clients remove those lines and put the text back in the input.
- **Permissions.** The app's permission prompt (`PromptFn`) becomes a `permission` event; the first client to answer
  wins (`permission-done` closes it everywhere); an interrupted turn denies it.
- **Pickers.** A command result with `choose` becomes a `choose` event; the client answers with an index (or -1).
- **Command results.** `reload` (resume, clear, rewind) sends `reset` and the restored history; `output`,
  `markdown` and `diffs` become events; `prompt` runs a turn.

### 1.4 HTTP API

All JSON. Every `/api` route except pairing needs `Authorization: Bearer <id>.<secret>`; every POST needs
`X-Tessera: 1` and, when the browser sends an `Origin`, the server's own.

| Method | Path | Body / query | Result |
|---|---|---|---|
| POST | `/api/pair` | `{code, name}` | `{token}` |
| POST | `/api/logout` | | unpairs this device |
| GET | `/api/sessions` | | `{open: SessionState[], roots}` |
| POST | `/api/sessions` | `{cwd?, resume?}` | `SessionState` (an already-open session with that stored id is joined, not reopened) |
| GET | `/api/stored` | `?cwd=` | saved sessions of that directory |
| GET | `/api/sessions/:id/events` | `Last-Event-ID` or `?after=` | SSE: `state`, then recorded events, then live ones; `: ping` every 25 s |
| POST | `/api/sessions/:id/send` | `{text}` | |
| POST | `/api/sessions/:id/interrupt` | | |
| POST | `/api/sessions/:id/permission` | `{id, decision}` | `{ok}` (false: already answered) |
| POST | `/api/sessions/:id/choose` | `{id, index}` | `{ok}` |
| POST | `/api/sessions/:id/close` | | closes the session (it stays saved) |

`:id` is the daemon's handle for a session, which stays the same across `/clear`, `/new` and `/resume` (the stored
session id is `SessionState.session`).

Events (`RemoteEvent.kind`): `state`, `reset`, `user`, `text`, `reasoning`, `tool`, `tool-result`, `diff`, `markdown`,
`info`, `error`, `turn-finish`, `discard`, `permission`, `permission-done`, `choose`, `choose-done`.

### 1.5 Pairing and devices

1. `serve` prints `http://127.0.0.1:<port>/#pair=<code>`: 256-bit random code, single use, valid 10 minutes;
   pressing `p` replaces it.
2. The page reads the code from the URL fragment (never sent in a request line or logged), removes it from the
   address bar and POSTs it to `/api/pair`.
3. The server returns a device token `<id>.<secret>`; `remote.json` (mode 0600, atomic write) keeps only
   SHA-256 of the secret. Comparisons are constant-time.
4. The page keeps the token in `localStorage` and sends it as a bearer token, also for the event stream (read with
   `fetch`, since `EventSource` cannot send headers).

Not a cookie: browsers send cookies to every port of `127.0.0.1`, so any other local server the browser visits
(a dev server, a Docker port) would receive it. `localStorage` is per origin, port included.

### 1.6 Security model

A paired device can do whatever the user can do in a terminal on that computer (`!` runs any shell line). Pairing is
the boundary; everything below keeps that boundary tight and keeps the computer's own setup out of reach.

| Threat | Defense |
|---|---|
| Other machines on the network | Listens on `127.0.0.1` only |
| DNS rebinding (a web page resolving its name to 127.0.0.1) | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, else 421 |
| CSRF from other sites | Bearer token (not ambient); POSTs need `X-Tessera: 1` (forces a CORS preflight the server never allows) and a matching `Origin` |
| Token theft by other local servers | Token in `localStorage`, not a cookie |
| XSS through model output | Markdown rendered with raw HTML escaped, links only `http(s):`/`mailto:`, images as text; everything else via `textContent`; CSP `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:` |
| Opening sessions anywhere | `remote.roots` (realpath, symlinks resolved); default the directory `serve` started in, with a warning when that is `~` or `/` |
| Escalating permissions | `dangerous` falls back to `bypass`; `/mode` switches only the session and only to `default`/`acceptEdits`/`plan`; permission answers at most `allow-session` (no rules saved), sensitive ones `allow-once` |
| Changing the computer's setup | Refused remotely: `/auth`, `/prompt`, `/providers`, `/permissions`, `/agents`, `/copy`, `/command`, `/exit`, `/skill new\|install\|remove`, `/mcp reload` |
| Untrusted project settings | `confirmTrust` answers no: hooks and MCP servers run only if trusted at the computer before |
| Secrets in the record | `/auth <key>` is stored redacted; blocked-command errors never echo arguments |
| Resource exhaustion | 8 open sessions, 32 open streams, 1 MB request bodies, tool output cut at 20,000 characters for display |

The design and code were reviewed by a separate security pass; its findings (cookie scope, global `/mode`,
`allow-always`, re-trust through `/skill`/`/mcp reload`, limits) are fixed above.

### 1.7 Configuration

`~/.tessera-code/config.json` only (a project's settings cannot enable or widen remote access):

```json
{ "remote": { "port": 8723, "roots": ["~/work"] } }
```

### 1.8 Tests

- `tests/remote.test.ts`: turn recording and ordering; discard; interrupted turn kept once answered; permission
  first-answer-wins, interrupt denies, no `always` rules; interjection and queue; blocked commands and session-only
  `/mode`; replay after a `seq` and `reset`; pairing once, bearer only (cookies ignored), logout; host, origin and
  header checks; SSE stream and `Last-Event-ID` resume; CSP; roots including symlink escape.
- End to end (scripts kept outside the repo): real `serve` with a fake OpenAI-compatible model server, driven through
  the API and through headless Chrome at phone size — pairing, opening, streaming, permission card, approval, reload
  restore, cancel before answer, dark/light, injected HTML not executed.

---

## 2. Stage 2: relay and end-to-end encryption

### 2.1 Overview

```
phone browser ──HTTPS──▶ relay (personal VPS) ◀──HTTPS── tessera-code serve (computer, outbound only)
      └──────────── end-to-end encrypted channel: the relay forwards ciphertext ─────────────┘
```

- The computer opens only outbound connections: no port forwarding, no inbound firewall rule.
- The relay pairs connections and forwards opaque envelopes; it stores nothing and cannot read or forge messages.
- Inside the encrypted channel the browser speaks the stage-1 API, so the controller, events and web app stay the
  same.

### 2.2 Files

| File | Role |
|---|---|
| `src/remote/api.ts` | Routes shared by both transports: `callApi`, `eventsRoute`, `streamEvents`, `Hub`, `ApiError` (moved out of `server.ts`) |
| `src/remote/e2e.ts` | WebCrypto-only crypto, used by Node and the browser bundle: keys, pairing proof, handshake, `Channel` |
| `src/remote/relay.ts` | `startRelay({port, host, token})`: the relay server (also serves the web app) |
| `src/remote/link.ts` | `startLink(…)`: the daemon's outbound connection to the relay; handshake per browser; requests → `api.ts` |
| `src/remote/devices.ts` | Also: relay devices by public key (`verifyKey`), the daemon's long-term key (`daemonKey`) |
| `src/remote/daemon.ts` | `remote.relay` settings (https only, except a relay on this computer); QR code (`uqr`, bundled) |
| `src/remote/web/transport.ts` | Browser transports: `LocalTransport` (127.0.0.1, bearer token) and `RelayTransport` (E2E, IndexedDB keys, reconnect + resubscribe) |
| `src/cli.ts` | `relay` command (`--port`, `--host`; token from `TESSERA_RELAY_TOKEN`) |
| `tests/remote-relay.test.ts` | Crypto (keys per direction, tamper/replay/reorder, wrong daemon key, proof binding); relay + link + device client end to end, ciphertext only on the relay; refusals; relay token |

### 2.3 Relay

- Ships in the same package: `tessera-code relay --port 8080` on the VPS (Node 22), behind Caddy or nginx for TLS
  (Caddy gets certificates automatically).
- Access token (`TESSERA_RELAY_TOKEN` on the VPS, `remote.relay.token` on the computer): only your daemons can
  register, so the relay is not open to others.
- Transport: HTTP only, no WebSocket dependency — the same SSE + POST pattern as stage 1:
  - daemon: `GET /relay/d/:daemon/stream` (SSE of `{conn, type: open|msg|close, data}`), `POST /relay/d/:daemon/send`
    (`{conn, data}` or `{conn, close: true}`)
  - browser: `GET /relay/c/:daemon/stream?conn=…` (SSE of the daemon's messages), `POST /relay/c/:daemon/send`
- Serves the web app (the same bundle). Because the page that holds the keys comes from the relay, the relay operator
  is trusted to serve unmodified code; with a personal VPS that is you. (Pinning with Subresource Integrity from a
  page installed once is a possible later hardening.)
- Limits: 2 MB per message, 16 daemons, 16 connections per daemon; nothing written to disk; logs only daemon
  connects and disconnects (no bodies, no addresses).
- A daemon that reconnects replaces its previous stream; its browser connections are closed and shake hands again.

### 2.4 Keys and pairing

- The daemon has a long-term ECDH P-256 key pair (`remote.json`, mode 0600). Its id on the relay is derived from the
  public key.
- `serve` shows a QR code (and the link) with the relay URL, daemon id, daemon public key and a one-time pairing
  secret, all in the URL fragment so the relay never sees them.
- The phone creates its own long-term key pair (WebCrypto, non-extractable, kept in IndexedDB) and sends its public
  key with an HMAC over both public keys keyed by the pairing secret. The daemon checks it and stores the device key.
  The relay cannot substitute keys: the phone got the daemon's key through the QR code, and the daemon accepts only a
  key bound to the pairing secret.

### 2.5 Encrypted channel

- Per connection, both sides create ephemeral ECDH keys. Session keys come from HKDF-SHA-256 over
  ECDH(static, static) ‖ ECDH(ephemeral, ephemeral), salted with a hash of the whole handshake (protocol, both static
  and both ephemeral keys, both nonces): only the paired device and daemon can derive them (mutual authentication),
  they belong to this exact handshake, and recorded traffic cannot be decrypted later even if a long-term key leaks
  (forward secrecy).
- Messages: AES-256-GCM, separate keys per direction, nonce = 64-bit counter. Each direction travels in order over one
  stream, so a message must carry exactly the next counter: a replayed, reordered or **dropped** message (a relay
  withholding an interrupt or a "deny") breaks the connection instead of going unnoticed. A message that could not be
  delivered also ends the connection on the sending side; the browser then reconnects.
- Inside: browser → daemon `{id, method, path, body?, after?}` and `{id, cancel: true}`; daemon → browser
  `{id, status, body | error}` per request and `{id, seq, event}` per streamed event. Both sides queue their messages
  so they leave in counter order. A message that fails to decrypt ends the connection.
- The browser reconnects by itself (new connection id, new handshake) and re-subscribes its event streams after the
  last `seq` each one saw.
- Everything uses `node:crypto` WebCrypto on the computer and WebCrypto in the browser (P-256, HKDF, AES-GCM are
  available in all current browsers including iOS Safari).

### 2.6 Configuration

On the computer, `~/.tessera-code/config.json`:

```json
{ "remote": { "roots": ["~/work"], "relay": { "url": "https://relay.example.com", "token": "…" } } }
```

`url` must be `https://` (plain `http://` only for a relay on this computer, for testing). Local access on
`127.0.0.1` stays available alongside the relay; one pairing code serves both (the link for this computer, the QR
code for a phone), whichever is used first.

### 2.7 Deploying the relay on a VPS

Needs a domain name pointing at the VPS (e.g. `relay.example.com`), Node.js 22+, and ports 80/443 open.

1. Install tessera-code on the VPS (same installer; only the `relay` command is used there):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/BOMONEI/tessera-code-cli/main/install.sh | bash
   ```

2. Create the token (once) and keep it for step 5:

   ```sh
   sudo install -d -m 700 /etc/tessera-relay
   echo "TESSERA_RELAY_TOKEN=$(openssl rand -base64 32)" | sudo tee /etc/tessera-relay/env >/dev/null
   sudo chmod 600 /etc/tessera-relay/env
   ```

3. Run it as a service, `/etc/systemd/system/tessera-relay.service` (adjust the path from `which tessera-code`):

   ```ini
   [Unit]
   Description=tessera-code relay
   After=network-online.target

   [Service]
   EnvironmentFile=/etc/tessera-relay/env
   ExecStart=/usr/local/bin/tessera-code relay --port 8080
   DynamicUser=yes
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now tessera-relay`

4. TLS with Caddy, `/etc/caddy/Caddyfile` (certificates are obtained automatically):

   ```
   relay.example.com {
       reverse_proxy 127.0.0.1:8080 {
           flush_interval -1
       }
   }
   ```

   `flush_interval -1` passes event streams through without buffering. `sudo systemctl reload caddy`.

5. On the computer, add `"relay": { "url": "https://relay.example.com", "token": "<the token>" }` under `"remote"`
   and run `tessera-code serve`: it says `Connected to the relay` and prints a QR code. Scan it with the phone; add
   the page to the home screen to open it like an app.

Updating the relay: `tessera-code update` on the VPS, then `sudo systemctl restart tessera-relay` (browsers and the
daemon reconnect by themselves).

### 2.8 Verification

- `tests/remote-relay.test.ts` (see the files table).
- End to end: a relay and `serve` on this computer with a fake model server, the phone page in headless Chrome:
  QR printed with key and code only in the fragment, pairing, session, permission card and approval, answer,
  reload (key from IndexedDB, no new pairing), relay restarted mid-session (page reconnects and continues).

### 2.9 Security review

A separate review of stage 2 found no way for the relay or anyone else to read or forge traffic, impersonate a side,
or pair without the QR secret. Its findings were fixed:

| Finding | Fix |
|---|---|
| A dropped message went unnoticed (gaps in the counter were allowed) | Exactly the next counter is required; a failed send ends the connection |
| An unauthenticated refusal made the browser delete its key | The key is kept; the refusal is shown with a "Forget this pairing" button |
| Idle connections could fill the relay's slots for a daemon | The daemon closes connections without a handshake after 10 s, the relay after 15 s without an answer; 32 slots |
| No backpressure (relay buffers, daemon send queue) | Streams that stop reading are ended (8 MB buffered); at most 8 KB before the handshake; at most 1000 queued messages per connection |
| An unpaired device kept its open connection | Revoking ends its connections at once; every request checks the device is still paired |
| Device name not covered by the pairing proof; control characters reached the terminal | The name is part of the proof; control characters are stripped |
| One malformed relay message dropped every connection; unbounded connection map | Skipped instead; at most 32 connections |
| Handshake transcript not bound into the keys | The salt hashes the whole handshake |
| Multi-line data could inject events into a stream | The relay accepts only single-line data |

Remaining limitations (by design for a personal relay):

- The relay serves the web app, so its operator is trusted for the page's code (you, on your own VPS). A dedicated
  origin with a service worker pinning the code by hash would remove that trust after the first load.
- Someone who knows the daemon id (it is in the QR code) can keep opening connections and slow the phone down; there
  are no per-address limits yet (behind a proxy the relay sees one address). Keep the QR code private.
- Connection ids appear in the reverse proxy's access log (they carry no secret).

### 2.10 Open points

- Device list and revocation from the web app (today: `tessera-code serve --forget-devices` unpairs all).
- Per-address rate limits on the relay (trusting the proxy's `X-Forwarded-For`).

## 3. Stage 3 (planned)

- Web push when approval is needed or a long turn ends; the notification carries no content.
  iOS needs the web app added to the home screen.
- `tessera-code serve --install` to start at login (launchd on macOS).
- Images from the phone (camera, screenshots) as prompt attachments.
