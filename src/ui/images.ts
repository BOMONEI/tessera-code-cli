import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { ImageInput } from '../agent/agent.js';

const MAX_BYTES = 10 * 1024 * 1024;
/** Larger images are scaled down first (providers commonly cap images around 5 MB). */
const SHRINK_ABOVE = 4 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Media type from the file signature (more reliable than the extension). */
export function sniffMediaType(buf: Buffer): string | undefined {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

function toImage(buf: Buffer): ImageInput | undefined {
  const mediaType = sniffMediaType(buf);
  if (!mediaType || buf.length > MAX_BYTES) return undefined;
  return { data: buf.toString('base64'), mediaType };
}

function run(cmd: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: MAX_BYTES * 2, timeout: 5000 }, (err, out) => resolve(err ? undefined : out));
  });
}

/** Scales a large image file down (macOS `sips`); returns the file to use. */
async function shrink(file: string): Promise<string> {
  if (process.platform !== 'darwin' || statSync(file).size <= SHRINK_ABOVE) return file;
  const out = file.replace(/(\.\w+)?$/, '-small.jpg');
  await run('sips', ['-Z', '2048', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out]);
  return existsSync(out) ? out : file;
}

export type ClipboardImage = { image: ImageInput } | { error: string } | undefined;

/** The image currently on the system clipboard (screenshots, copied images); undefined when there is none. */
export async function readClipboardImage(): Promise<ClipboardImage> {
  const dir = mkdtempSync(join(tmpdir(), 'tessera-clip-'));
  const file = join(dir, 'clip.png');
  try {
    if (process.platform === 'darwin') {
      // The path goes in as an argument, never into the script text.
      const script = [
        'on run argv',
        'set png to (the clipboard as «class PNGf»)',
        'set f to open for access POSIX file (item 1 of argv) with write permission',
        'write png to f',
        'close access f',
        'end run',
      ];
      await run('osascript', [...script.flatMap((line) => ['-e', line]), file]);
    } else if (process.platform === 'linux') {
      const out = (await run('wl-paste', ['--no-newline', '--type', 'image/png'])) ?? (await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']));
      if (out?.length) writeFileSync(file, out);
    }
    if (!existsSync(file) || statSync(file).size === 0) return undefined;
    const buf = readFileSync(await shrink(file));
    if (buf.length > MAX_BYTES) return { error: `The clipboard image is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${MAX_BYTES / 1048576} MB.` };
    const image = toImage(buf);
    return image ? { image } : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Image files in dropped or pasted text: one or more absolute paths (quoted, backslash-escaped spaces, ~/ or
 * file:// URLs), which is what dragging files into a terminal produces. Relative paths stay text ("optimize
 * assets/logo.png" is about the file, not its pixels). Returns undefined unless every token is an existing image.
 */
export function imagesFromPaths(text: string): Array<ImageInput & { name: string }> | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return undefined;
  const tokens = trimmed.match(/'[^']+'|"[^"]+"|(?:\\.|[^\s\\])+/g) ?? [];
  const out: Array<ImageInput & { name: string }> = [];
  for (const token of tokens) {
    let path = token.replace(/^(['"])(.*)\1$/, '$2').replace(/\\(.)/g, '$1');
    if (path.startsWith('file://')) path = decodeURIComponent(path.slice('file://'.length));
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
    if (!path.startsWith('/') || !MEDIA_TYPES[extname(path).toLowerCase()] || !existsSync(path)) return undefined;
    if (statSync(path).size > MAX_BYTES) return undefined;
    const image = toImage(readFileSync(path));
    if (!image) return undefined;
    out.push({ ...image, name: path.split('/').pop() ?? path });
  }
  return out.length ? out : undefined;
}
