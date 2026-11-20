import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exportPrivate, generateKeyPair, importPrivate, keyId, pairingProof, sameString } from './e2e.js';

/** How long a pairing link works, and how many devices it can pair (one). */
const PAIRING_MS = 10 * 60_000;

export interface Device {
  id: string;
  name: string;
  /** Paired on this computer (127.0.0.1): SHA-256 of the device's token secret; the secret is kept only by the device. */
  hash?: string;
  /** Paired through the relay: the device's public key (end-to-end encryption). */
  key?: string;
  createdAt: string;
  lastSeen?: string;
}

interface SavedKey {
  publicKey: string;
  privateKey: JsonWebKey;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

/**
 * Paired browsers and this computer's own key, kept in ~/.tessera-code/remote.json (readable by the user only).
 * A device pairs once with a one-time code printed by `tessera-code serve` (as a link on this computer, as a QR code
 * for the relay); from then on its token (local) or its public key (relay) identifies it.
 */
export class Devices {
  private list: Device[] = [];
  /** The one-time code itself stays in memory: the relay pairing proof is an HMAC keyed by it. */
  private pairing?: { code: string; until: number };
  private seenWrite = 0;
  private daemon?: SavedKey;
  /** Told when a device is unpaired, so its open connections end at once. */
  onRevoke?: (id: string) => void;

  private constructor(private file: string) {}

  static async load(file: string): Promise<Devices> {
    const d = new Devices(file);
    if (existsSync(file)) {
      const data = JSON.parse(await readFile(file, 'utf8')) as { devices?: Device[]; daemonKey?: SavedKey };
      d.list = Array.isArray(data.devices) ? data.devices : [];
      d.daemon = data.daemonKey;
    }
    return d;
  }

  /** This computer's long-term key pair for the relay (created and saved on first use). */
  async daemonKey(): Promise<CryptoKeyPair> {
    if (!this.daemon) {
      this.daemon = await exportPrivate(await generateKeyPair(true));
      await this.save();
    }
    return importPrivate(this.daemon);
  }

  get all(): readonly Device[] {
    return this.list;
  }

  /** Whether `id` is still paired. */
  has(id: string): boolean {
    return this.list.some((d) => d.id === id);
  }

  /** A new one-time pairing code (the previous one stops working). */
  newPairingCode(now = Date.now()): string {
    const code = token();
    this.pairing = { code, until: now + PAIRING_MS };
    return code;
  }

  /** Pairs a device with the current code; returns its token, or undefined for a wrong or used code. */
  async pair(code: string, name: string, now = Date.now()): Promise<string | undefined> {
    const p = this.pairing;
    if (!p || now > p.until || !same(sha256(code), sha256(p.code))) return undefined;
    this.pairing = undefined;
    const id = randomBytes(6).toString('hex');
    const secret = token();
    this.list.push({ id, name: printable(name), hash: sha256(secret), createdAt: new Date(now).toISOString() });
    await this.save();
    return `${id}.${secret}`;
  }

  /** The paired device a token belongs to. */
  async verify(value: string | undefined): Promise<string | undefined> {
    const [id, secret] = (value ?? '').split('.');
    const d = id && secret ? this.list.find((x) => x.id === id && x.hash) : undefined;
    if (!d || !same(sha256(secret!), d.hash!)) return undefined;
    await this.seen(d);
    return d.id;
  }

  /**
   * The device a relay connection comes from: a key paired before, or a new one with a valid proof for the current
   * pairing code (which it then uses up). Undefined: not paired.
   */
  async verifyKey(publicKey: string, daemonPub: string, proof: string | undefined, name: string, now = Date.now()): Promise<string | undefined> {
    const known = this.list.find((x) => x.key === publicKey);
    if (known) {
      await this.seen(known);
      return known.id;
    }
    const p = this.pairing;
    if (!proof || !p || now > p.until || !sameString(proof, await pairingProof(p.code, publicKey, daemonPub, name))) return undefined;
    this.pairing = undefined;
    const id = await keyId(publicKey);
    this.list.push({ id, name: printable(name), key: publicKey, createdAt: new Date(now).toISOString() });
    await this.save();
    return id;
  }

  /** Last use, for the device list; written at most once a minute. */
  private async seen(d: Device): Promise<void> {
    d.lastSeen = new Date().toISOString();
    if (Date.now() - this.seenWrite > 60_000) {
      this.seenWrite = Date.now();
      await this.save().catch(() => {});
    }
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.list.length;
    this.list = this.list.filter((d) => d.id !== id);
    if (this.list.length === before) return false;
    await this.save();
    this.onRevoke?.(id);
    return true;
  }

  async revokeAll(): Promise<void> {
    const ids = this.list.map((d) => d.id);
    this.list = [];
    await this.save();
    for (const id of ids) this.onRevoke?.(id);
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ devices: this.list, ...(this.daemon ? { daemonKey: this.daemon } : {}) }, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}

/** A device name as shown in the terminal and the device list: no control characters (escape sequences). */
export function printable(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80) || 'browser';
}

function same(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
