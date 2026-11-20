/**
 * End-to-end encryption between a paired browser and `tessera-code serve`, through a relay that only forwards
 * ciphertext. WebCrypto only (globalThis.crypto.subtle), so the same code runs in Node and in the browser bundle.
 *
 * Keys: each side has a long-term ECDH P-256 key pair. Pairing binds the device's public key to the daemon with a
 * one-time secret from the QR code (HMAC over both public keys), so the relay cannot substitute either key.
 *
 * Handshake per connection (both directions authenticated, forward secret):
 *   device → daemon  hello   { device public key, ephemeral public key, nonce, [pairing proof] }
 *   daemon → device  welcome { ephemeral public key, nonce, sealed "ready" }
 *   keys = HKDF-SHA-256(ECDH(static, static) ‖ ECDH(ephemeral, ephemeral),
 *                       salt = SHA-256(protocol ‖ both static keys ‖ both ephemeral keys ‖ both nonces), info = direction)
 * Only holders of both static private keys can derive them; the salt binds the keys to this exact handshake; past
 * traffic stays safe if a static key leaks later.
 *
 * Messages: AES-256-GCM, one key per direction, 96-bit nonce from a counter. Each direction travels in order over one
 * stream, so the next message must carry exactly the next counter: a replayed, reordered or dropped message (a relay
 * silently withholding an interrupt, say) breaks the channel instead of going unnoticed.
 */

const subtle = globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PROTOCOL = 'tessera-remote-1';

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A long-term key pair. `extractable` lets the daemon save its private key; the browser keeps its key unextractable. */
export function generateKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
  return subtle.generateKey(ECDH, extractable, ['deriveBits']) as Promise<CryptoKeyPair>;
}

/** The public key as base64url (raw uncompressed point, 65 bytes). */
export async function exportPublic(key: CryptoKey): Promise<string> {
  return toB64(await subtle.exportKey('raw', key));
}

export async function importPublic(b64: string): Promise<CryptoKey> {
  const raw = fromB64(b64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Not a P-256 public key');
  return subtle.importKey('raw', raw, ECDH, true, []);
}

export async function exportPrivate(pair: CryptoKeyPair): Promise<{ publicKey: string; privateKey: JsonWebKey }> {
  return { publicKey: await exportPublic(pair.publicKey), privateKey: await subtle.exportKey('jwk', pair.privateKey) };
}

export async function importPrivate(saved: { publicKey: string; privateKey: JsonWebKey }): Promise<CryptoKeyPair> {
  return { publicKey: await importPublic(saved.publicKey), privateKey: await subtle.importKey('jwk', saved.privateKey, ECDH, true, ['deriveBits']) };
}

/** A short public id for a key (the daemon's address on the relay, a device's id). */
export async function keyId(publicKeyB64: string): Promise<string> {
  return toB64(await subtle.digest('SHA-256', fromB64(publicKeyB64))).slice(0, 22);
}

async function hmac(secret: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}

/** Proof that the device holding `devicePub` (called `name`) read the pairing secret shown next to `daemonPub`. */
export async function pairingProof(secret: string, devicePub: string, daemonPub: string, name = ''): Promise<string> {
  return toB64(await hmac(secret, enc.encode(`${PROTOCOL}|pair|${devicePub}|${daemonPub}|${name}`)));
}

/** Constant-time comparison of two strings of the same alphabet. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function shared(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

async function directionKey(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${PROTOCOL}|${info}`) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** One direction-separated, counter-checked AES-GCM channel. */
export class Channel {
  private sendCounter = 0n;
  private recvCounter = -1n;

  constructor(
    private sendKey: CryptoKey,
    private recvKey: CryptoKey,
  ) {}

  /**
   * Derives the channel; `role` decides which derived key encrypts. `transcript`: the handshake's public values, in
   * the same order on both sides (see handshakeSalt).
   */
  static async derive(
    role: 'device' | 'daemon',
    own: { static: CryptoKey; ephemeral: CryptoKey },
    peer: { static: CryptoKey; ephemeral: CryptoKey },
    transcript: string[],
  ): Promise<Channel> {
    const ikm = concat(await shared(own.static, peer.static), await shared(own.ephemeral, peer.ephemeral));
    const salt = new Uint8Array(await subtle.digest('SHA-256', enc.encode([PROTOCOL, ...transcript].join('|'))));
    const toDaemon = await directionKey(ikm, salt, 'device->daemon');
    const toDevice = await directionKey(ikm, salt, 'daemon->device');
    return role === 'device' ? new Channel(toDaemon, toDevice) : new Channel(toDevice, toDaemon);
  }

  async seal(message: unknown): Promise<string> {
    const counter = this.sendCounter++;
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, counter);
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, this.sendKey, enc.encode(JSON.stringify(message)));
    return toB64(concat(iv, new Uint8Array(data)));
  }

  /** Decrypts and checks the order; throws on tampering, replay or reordering. */
  async open<T = unknown>(sealed: string): Promise<T> {
    const bytes = fromB64(sealed);
    if (bytes.length < 12 + 16) throw new Error('Message too short');
    const iv = bytes.slice(0, 12);
    const counter = new DataView(iv.buffer).getBigUint64(4);
    if (counter !== this.recvCounter + 1n) throw new Error(counter <= this.recvCounter ? 'Replayed or reordered message' : 'Missing message');
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, this.recvKey, bytes.slice(12));
    this.recvCounter = counter;
    return JSON.parse(dec.decode(plain)) as T;
  }
}

export interface Hello {
  type: 'hello';
  v: string;
  device: string;
  ephemeral: string;
  nonce: string;
  /** First connection only: binds `device` to the daemon (see pairingProof). */
  proof?: string;
  /** Shown in the device list. */
  name?: string;
}

export interface Welcome {
  type: 'welcome';
  ephemeral: string;
  nonce: string;
  /** "ready", sealed: proves the daemon derived the same keys (and holds its static key). */
  ready: string;
}

/** Device side: starts a connection. Call `finish` with the daemon's welcome to get the channel. */
export async function deviceHello(
  device: CryptoKeyPair,
  daemonPub: string,
  opts: { pairingSecret?: string; name?: string } = {},
): Promise<{ hello: Hello; finish: (w: Welcome) => Promise<Channel> }> {
  const ephemeral = await generateKeyPair(false);
  const nonce = random(16);
  const devicePub = await exportPublic(device.publicKey);
  const hello: Hello = {
    type: 'hello',
    v: PROTOCOL,
    device: devicePub,
    ephemeral: await exportPublic(ephemeral.publicKey),
    nonce: toB64(nonce),
    ...(opts.pairingSecret ? { proof: await pairingProof(opts.pairingSecret, devicePub, daemonPub, opts.name ?? '') } : {}),
    ...(opts.name ? { name: opts.name } : {}),
  };
  return {
    hello,
    finish: async (w) => {
      if (w.type !== 'welcome') throw new Error('Unexpected handshake message');
      const channel = await Channel.derive(
        'device',
        { static: device.privateKey, ephemeral: ephemeral.privateKey },
        { static: await importPublic(daemonPub), ephemeral: await importPublic(w.ephemeral) },
        [devicePub, daemonPub, hello.ephemeral, w.ephemeral, hello.nonce, w.nonce],
      );
      if ((await channel.open(w.ready)) !== 'ready') throw new Error('Handshake failed');
      return channel;
    },
  };
}

/** Daemon side: answers a hello from a device whose public key it accepted (already paired, or by its proof). */
export async function daemonWelcome(daemon: CryptoKeyPair, hello: Hello): Promise<{ welcome: Welcome; channel: Channel }> {
  if (hello.v !== PROTOCOL) throw new Error(`Unsupported protocol ${hello.v}`);
  const ephemeral = await generateKeyPair(false);
  const ephemeralPub = await exportPublic(ephemeral.publicKey);
  const nonce = toB64(random(16));
  const channel = await Channel.derive(
    'daemon',
    { static: daemon.privateKey, ephemeral: ephemeral.privateKey },
    { static: await importPublic(hello.device), ephemeral: await importPublic(hello.ephemeral) },
    [hello.device, await exportPublic(daemon.publicKey), hello.ephemeral, ephemeralPub, hello.nonce, nonce],
  );
  return { welcome: { type: 'welcome', ephemeral: ephemeralPub, nonce, ready: await channel.seal('ready') }, channel };
}
