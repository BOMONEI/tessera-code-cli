import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImageInput } from '../agent/agent.js';

/** Pages (slides) shown to the model per read call; `pages` selects a later range. */
export const MAX_PAGES = 10;
/** Longest side of a rendered page, in pixels: slide text stays legible at ~1.5k tokens per image. */
const RENDER_SIZE = 1400;
const RENDER_TIMEOUT_MS = 120_000;
/** Largest image file shown as is (bigger ones are refused rather than blowing up the request). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Opened directly as pages (slides, or PDF pages via LibreOffice's PDF import in Draw). */
const PAGED = new Set(['.pptx', '.ppt', '.pps', '.ppsx', '.pptm', '.potx', '.odp', '.key', '.pdf', '.odg', '.vsdx']);
/** Text documents and spreadsheets: converted to PDF first, so pages look as they print. */
const FLOWING = new Set(['.docx', '.doc', '.docm', '.odt', '.rtf', '.xlsx', '.xls', '.xlsm', '.ods', '.hwp']);

export type FileKind = 'image' | 'document' | 'text';

/** How read shows a file: as an image, as rendered pages, or as text. */
export function fileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (ext in IMAGE_TYPES) return 'image';
  if (PAGED.has(ext) || FLOWING.has(ext)) return 'document';
  return 'text';
}

/** Media type from the file signature. */
export function sniffImage(buf: Buffer): string | undefined {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

export async function loadImage(abs: string): Promise<ImageInput> {
  const buf = await readFile(abs);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${basename(abs)} is ${(buf.length / 1048576).toFixed(1)} MB; images over 5 MB are not sent to the model.`);
  const mediaType = sniffImage(buf);
  if (!mediaType) throw new Error(`${basename(abs)} is not a PNG, JPEG, GIF or WebP image.`);
  return { data: buf.toString('base64'), mediaType };
}

/** "3" → [3, 3]; "2-5" → [2, 5]; "4-" → [4, ∞); undefined → [1, MAX_PAGES]. Ranges longer than MAX_PAGES are cut. */
export function parsePages(spec: string | undefined): { first: number; last: number } {
  if (!spec?.trim()) return { first: 1, last: MAX_PAGES };
  const m = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(spec);
  if (!m || Number(m[1]) < 1) throw new Error(`Invalid pages "${spec}": use a page number ("3") or a range ("11-20").`);
  const first = Number(m[1]);
  const last = m[2] === undefined ? first : m[2] === '' ? first + MAX_PAGES - 1 : Number(m[2]);
  if (last < first) throw new Error(`Invalid pages "${spec}": the range ends before it starts.`);
  return { first, last: Math.min(last, first + MAX_PAGES - 1) };
}

/** LibreOffice's soffice: TESSERA_SOFFICE, then PATH, then the usual install locations. */
export async function findSoffice(): Promise<string | undefined> {
  const env = process.env.TESSERA_SOFFICE;
  if (env) return existsSync(env) ? env : undefined;
  for (const name of ['soffice', 'libreoffice']) {
    const found = await new Promise<string | undefined>((resolve) =>
      execFile(process.platform === 'win32' ? 'where' : 'which', [name], (err, out) => resolve(err ? undefined : out.toString().split('\n')[0]?.trim() || undefined)),
    );
    if (found) return found;
  }
  return [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    '/opt/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  ].find((p) => existsSync(p));
}

export const NO_LIBREOFFICE =
  'Viewing documents needs LibreOffice (free), which was not found. Install it — macOS: brew install --cask libreoffice; ' +
  'Debian/Ubuntu: sudo apt install libreoffice-impress libreoffice-writer libreoffice-calc — or set TESSERA_SOFFICE to its soffice binary. ' +
  'Do not unzip the file to read its XML: that loses images and layout. Tell the user LibreOffice is needed.';

// Runs inside soffice (LibreOffice's embedded Python; its standalone python is often blocked by macOS). Opens the
// document hidden and read-only and exports each requested page with the GraphicExportFilter. Arguments come in
// through the environment; results go to pages.txt: "COUNT n", one "PAGE i path" per image, or "ERROR ...".
const MACRO = `import os, uno
from com.sun.star.beans import PropertyValue

def _p(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p

def export_pages(*args):
    src, out = os.environ['TESSERA_SRC'], os.environ['TESSERA_OUT']
    size, first, last = int(os.environ['TESSERA_SIZE']), int(os.environ['TESSERA_FIRST']), int(os.environ['TESSERA_LAST'])
    desktop = XSCRIPTCONTEXT.getDesktop()
    ctx = XSCRIPTCONTEXT.getComponentContext()
    log = open(os.path.join(out, 'pages.txt'), 'w')
    doc = None
    try:
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(src), '_blank', 0, (_p('Hidden', True), _p('ReadOnly', True)))
        if doc is None or not hasattr(doc, 'getDrawPages'):
            raise Exception('not a presentation or drawing')
        pages = doc.getDrawPages()
        count = pages.getCount()
        log.write('COUNT %d\\n' % count)
        flt = ctx.ServiceManager.createInstanceWithContext('com.sun.star.drawing.GraphicExportFilter', ctx)
        for i in range(first - 1, min(last, count)):
            page = pages.getByIndex(i)
            w, h = page.Width, page.Height
            pw, ph = (size, max(1, round(size * h / w))) if w >= h else (max(1, round(size * w / h)), size)
            path = os.path.join(out, 'page-%04d.png' % (i + 1))
            data = uno.Any('[]com.sun.star.beans.PropertyValue', (_p('PixelWidth', pw), _p('PixelHeight', ph)))
            flt.setSourceDocument(page)
            uno.invoke(flt, 'filter', ((_p('URL', uno.systemPathToFileUrl(path)), _p('MediaType', 'image/png'), _p('FilterData', data)),))
            log.write('PAGE %d %s\\n' % (i + 1, path))
            log.flush()
    except Exception as e:
        log.write('ERROR %s\\n' % e)
    finally:
        log.close()
        try:
            if doc is not None:
                doc.close(True)
        except Exception:
            pass
        desktop.terminate()

g_exportedScripts = (export_pages,)
`;

function runSoffice(soffice: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(soffice, args, { env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), RENDER_TIMEOUT_MS);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Interrupted.'));
      else if (sig === 'SIGKILL') reject(new Error(`LibreOffice took longer than ${RENDER_TIMEOUT_MS / 1000}s and was stopped.`));
      else if (code !== 0) reject(new Error(`LibreOffice exited with code ${code}.`));
      else resolve();
    });
  });
}

export interface RenderedPages {
  /** Pages (slides) in the document. */
  total: number;
  first: number;
  last: number;
  images: ImageInput[];
}

/**
 * Renders pages first..last of a document to PNG with LibreOffice, as they look (images, shapes, text drawn over
 * images). Text documents and spreadsheets are converted to PDF first. Each call uses its own LibreOffice profile in
 * a temp folder, so renders never conflict with each other or with a LibreOffice the user has open.
 */
export async function renderPages(abs: string, range: { first: number; last: number }, signal?: AbortSignal): Promise<RenderedPages> {
  const soffice = await findSoffice();
  if (!soffice) throw new Error(NO_LIBREOFFICE);
  const work = await mkdtemp(join(tmpdir(), 'tessera-render-'));
  try {
    const profile = join(work, 'profile');
    await mkdir(join(profile, 'user', 'Scripts', 'python'), { recursive: true });
    await writeFile(join(profile, 'user', 'Scripts', 'python', 'tessera_render.py'), MACRO);
    const base = ['--headless', '--invisible', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(profile).href}`];
    let src = abs;
    if (FLOWING.has(extname(abs).toLowerCase())) {
      await runSoffice(soffice, [...base, '--convert-to', 'pdf', '--outdir', work, abs], process.env, signal);
      src = join(work, basename(abs).replace(/\.[^.]+$/, '') + '.pdf');
      if (!existsSync(src)) throw new Error(`LibreOffice could not convert ${basename(abs)} to PDF.`);
    }
    const out = join(work, 'out');
    await mkdir(out);
    const env = { ...process.env, TESSERA_SRC: src, TESSERA_OUT: out, TESSERA_SIZE: String(RENDER_SIZE), TESSERA_FIRST: String(range.first), TESSERA_LAST: String(range.last) };
    await runSoffice(soffice, [...base, 'vnd.sun.star.script:tessera_render.py$export_pages?language=Python&location=user'], env, signal);
    const log = existsSync(join(out, 'pages.txt')) ? await readFile(join(out, 'pages.txt'), 'utf8') : '';
    const error = /^ERROR (.*)$/m.exec(log)?.[1];
    const total = Number(/^COUNT (\d+)$/m.exec(log)?.[1] ?? NaN);
    if (error || Number.isNaN(total)) throw new Error(`LibreOffice could not open ${basename(abs)}${error ? `: ${error}` : ''}.`);
    const paths = [...log.matchAll(/^PAGE \d+ (.+)$/gm)].map((m) => m[1]!);
    const images = await Promise.all(paths.map(async (p) => ({ data: (await readFile(p)).toString('base64'), mediaType: 'image/png' })));
    return { total, first: range.first, last: range.first + images.length - 1, images };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
