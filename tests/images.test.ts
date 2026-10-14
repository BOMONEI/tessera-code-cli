import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imagesFromPaths, sniffMediaType } from '../src/ui/images.js';
import { estimateTokens } from '../src/agent/agent.js';
import { promptText } from '../src/session/store.js';
import { renderMarkdown } from '../src/ui/markdown.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe('image input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tessera-img-'));
  const spaced = join(dir, 'Screen Shot 1.png');
  const plain = join(dir, 'a.png');
  const fake = join(dir, 'not-really.png');
  writeFileSync(spaced, PNG);
  writeFileSync(plain, PNG);
  writeFileSync(fake, 'hello');

  it('detects image types from file signatures', () => {
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(Buffer.from('plain text'))).toBeUndefined();
  });

  it('reads dropped paths: escaped spaces, quotes, file:// URLs, several at once', () => {
    expect(imagesFromPaths(spaced.replace(/ /g, '\\ ') + ' ')?.map((i) => i.name)).toEqual(['Screen Shot 1.png']);
    expect(imagesFromPaths(`'${spaced}' ${plain}`)?.map((i) => i.mediaType)).toEqual(['image/png', 'image/png']);
    expect(imagesFromPaths(`file://${encodeURI(plain)}`)).toHaveLength(1);
  });

  it('never swallows ordinary text or non-images', () => {
    expect(imagesFromPaths('look at a.png please')).toBeUndefined();
    expect(imagesFromPaths(fake)).toBeUndefined();
    expect(imagesFromPaths(join(dir, 'missing.png'))).toBeUndefined();
  });

  it('counts images at a fixed cost instead of their base64 size', () => {
    const big = 'A'.repeat(400_000);
    const tokens = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', image: big, mediaType: 'image/png' }] }]);
    expect(tokens).toBeLessThan(2_000);
  });

  it('shows images in replayed prompts', () => {
    expect(promptText({ role: 'user', content: [{ type: 'text', text: 'what is this?\n\n<context>x</context>' }, { type: 'image', image: 'AA', mediaType: 'image/png' }] })).toBe(
      'what is this? [Image]',
    );
    expect(promptText({ role: 'user', content: [{ type: 'text', text: 'see [Image #1]' }, { type: 'image', image: 'AA', mediaType: 'image/png' }] })).toBe('see [Image #1]');
  });
});

describe('table cells', () => {
  it('restores colons and turns <br> into line breaks', () => {
    const out = renderMarkdown('| a | b |\n|---|---|\n| `x: 1` | one<br>two |\n', 80);
    expect(out).not.toContain('COLON');
    expect(out).toContain('x: 1');
    expect(out).not.toContain('<br>');
    expect(out.split('\n').some((l) => l.includes('two') && !l.includes('one'))).toBe(true);
  });
});

describe('images across models and sessions (review)', async () => {
  const { withoutImages, hasImages } = await import('../src/agent/agent.js');
  const { SessionStore } = await import('../src/session/store.js');
  const { readFileSync } = await import('node:fs');
  const msg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'see' }, { type: 'file' as const, data: 'A'.repeat(5000), mediaType: 'image/png' }] };

  it('replaces images with a note for text-only models', () => {
    const out = withoutImages([msg]);
    expect(hasImages(out)).toBe(false);
    expect(JSON.stringify(out)).toContain('image omitted');
  });

  it('keeps image data out of the session file and restores it on load', async () => {
    process.env.TESSERA_HOME ??= mkdtempSync(join(tmpdir(), 'tessera-home-'));
    const store = new SessionStore(mkdtempSync(join(tmpdir(), 'proj-')), 'img');
    await store.sync({ messages: [msg], generation: 0 });
    expect(readFileSync(store.path, 'utf8')).not.toContain('AAAAAAAAAA');
    const loaded = await new SessionStore(store.cwd, 'img').load();
    expect(JSON.stringify(loaded.messages)).toContain('A'.repeat(5000));
  });

  it('leaves relative paths as text', () => {
    expect(imagesFromPaths('assets/logo.png')).toBeUndefined();
  });
});
