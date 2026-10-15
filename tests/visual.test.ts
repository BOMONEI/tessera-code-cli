import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ModelInfo } from '../src/providers/catalog.js';

// Scripted model: 'look' calls the look tool, 'text' answers. Every request's prompt is kept.
const prompts: unknown[] = [];
const script: Array<'look' | 'text'> = [];
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
vi.mock('../src/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/index.js')>()),
  createModel: (): LanguageModelV4 =>
    ({
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('unused');
      },
      async doStream({ prompt }: { prompt: unknown }) {
        prompts.push(prompt);
        const step = script.shift() ?? 'text';
        const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (step === 'look') {
          parts.push({ type: 'tool-call', toolCallId: `c${prompts.length}`, toolName: 'look', input: '{}' });
          parts.push({ type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });
        } else {
          parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'seen' }, { type: 'text-end', id: 't' });
          parts.push({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } });
        }
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
      },
    }) as unknown as LanguageModelV4,
}));
vi.mock('../src/cost/ledger.js', () => ({ recordSpend: async () => {} }));

const { Agent } = await import('../src/agent/agent.js');
const { fileTools } = await import('../src/tools/files.js');
const { fileKind, parsePages, findSoffice, renderPages, MAX_PAGES } = await import('../src/tools/render.js');

const model: ModelInfo = { id: 'mock', name: 'mock', format: 'chat', context: 1_000_000, output: 1000, reasoning: false, images: true, cost: { input: 0, output: 0, cacheRead: 0 } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('read: which files are looked at', () => {
  it('sorts files into images, documents and text', () => {
    for (const f of ['a.png', 'b.JPG', 'c.webp']) expect(fileKind(f)).toBe('image');
    for (const f of ['deck.pptx', 'old.ppt', 'talk.key', 'x.pdf', 'memo.docx', 'sheet.xlsx', 'n.odt']) expect(fileKind(f)).toBe('document');
    for (const f of ['a.ts', 'README.md', 'data.csv', 'noext']) expect(fileKind(f)).toBe('text');
  });

  it('parses page ranges, capped at MAX_PAGES', () => {
    expect(parsePages(undefined)).toEqual({ first: 1, last: MAX_PAGES });
    expect(parsePages('3')).toEqual({ first: 3, last: 3 });
    expect(parsePages('11-20')).toEqual({ first: 11, last: 20 });
    expect(parsePages('5-')).toEqual({ first: 5, last: 4 + MAX_PAGES });
    expect(parsePages('1-50')).toEqual({ first: 1, last: MAX_PAGES });
    expect(() => parsePages('0')).toThrow(/Invalid pages/);
    expect(() => parsePages('5-2')).toThrow(/ends before it starts/);
    expect(() => parsePages('all')).toThrow(/Invalid pages/);
  });
});

describe('read tool', () => {
  function setup(canSee = true) {
    const cwd = mkdtempSync(join(tmpdir(), 'tessera-visual-'));
    const shown: Array<{ label: string; images: Array<{ data: string; mediaType: string }> }> = [];
    const ctx = { cwd, permissions: {} as never, readFiles: new Map(), showImages: (label: string, images: never[]) => void shown.push({ label, images }), canSeeImages: () => canSee };
    const read = fileTools(ctx as never).read as unknown as { execute: (input: object, opts: object) => Promise<string> };
    return { cwd, shown, read: (input: object) => read.execute(input, { abortSignal: undefined, toolCallId: 't', messages: [] }) };
  }

  it('shows an image file as an image instead of reading its bytes as text', async () => {
    const { cwd, shown, read } = setup();
    writeFileSync(join(cwd, 'shot.png'), PNG);
    expect(await read({ path: 'shot.png' })).toMatch(/shown to you as an image/);
    expect(shown).toEqual([{ label: 'Image shot.png:', images: [{ data: PNG.toString('base64'), mediaType: 'image/png' }] }]);
  });

  it('refuses a file with an image extension that is not an image', async () => {
    const { cwd, read } = setup();
    writeFileSync(join(cwd, 'fake.png'), 'not an image');
    await expect(read({ path: 'fake.png' })).rejects.toThrow(/not a PNG, JPEG, GIF or WebP/);
  });

  it('says so when the model cannot see images', async () => {
    const { cwd, shown, read } = setup(false);
    writeFileSync(join(cwd, 'shot.png'), PNG);
    await expect(read({ path: 'shot.png' })).rejects.toThrow(/cannot see images/);
    expect(shown).toEqual([]);
  });

  it('still reads text files as numbered lines', async () => {
    const { cwd, shown, read } = setup();
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo');
    expect(await read({ path: 'a.txt' })).toBe('     1\tone\n     2\ttwo');
    expect(shown).toEqual([]);
  });
});

describe('agent: images shown by tools', () => {
  function agentWithLook(images: number) {
    const a = new Agent({ model, apiKey: 'k', sessionId: 's', system: '', maxSteps: 5, thinking: false, contextLimit: 500_000, tools: {} });
    const look = tool({
      description: 'look',
      inputSchema: z.object({}),
      execute: async () => {
        a.attachImages('deck.pptx, pages 1-2 of 2:', Array.from({ length: images }, () => ({ data: PNG.toString('base64'), mediaType: 'image/png' })));
        return 'Rendered deck.pptx';
      },
    });
    a.tools = { look };
    return a;
  }

  it('sends them as a user message right after the tool result, and keeps them in the history', async () => {
    prompts.length = 0;
    script.push('look', 'text');
    const a = agentWithLook(2);
    for await (const _ of a.run('what is on the slides?')) void _;
    const second = prompts[1] as Array<{ role: string; content: unknown }>;
    const last = second.at(-1)!;
    expect(second.at(-2)!.role).toBe('tool');
    expect(last.role).toBe('user');
    const parts = last.content as Array<{ type: string; text?: string; mediaType?: string }>;
    expect(parts[0]).toMatchObject({ type: 'text', text: 'deck.pptx, pages 1-2 of 2:' });
    expect(parts.filter((p) => p.type === 'file').map((p) => p.mediaType)).toEqual(['image/png', 'image/png']);
    expect(a.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
  });

  it('puts a message typed meanwhile into the same user message', async () => {
    prompts.length = 0;
    script.push('look', 'text');
    const a = agentWithLook(1);
    a.interject('focus on slide 2');
    for await (const _ of a.run('look')) void _;
    const roles = a.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) expect(roles[i] === 'user' && roles[i - 1] === 'user').toBe(false);
    expect(JSON.stringify(a.messages[3])).toContain('focus on slide 2');
    expect(JSON.stringify(a.messages[3])).toContain('image/png');
  });

  it('drops images left over when a turn ended before another step', async () => {
    prompts.length = 0;
    const a = agentWithLook(1);
    a.attachImages('stale', [{ data: 'x', mediaType: 'image/png' }]);
    script.push('text');
    for await (const _ of a.run('hi')) void _;
    expect(JSON.stringify(prompts)).not.toContain('stale');
  });
});

// Real rendering needs LibreOffice; it runs wherever soffice is installed (the release CI has none).
const soffice = await findSoffice();
describe.runIf(soffice)('rendering with LibreOffice', () => {
  it('renders each slide of a presentation as a PNG, honoring the page range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-render-test-'));
    const page = (title: string) =>
      `<draw:page><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>${title}</text:p></draw:text-box></draw:frame></draw:page>`;
    writeFileSync(
      join(dir, 'deck.fodp'),
      `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation>${page('one')}${page('two')}${page('three')}</office:presentation></office:body></office:document>`,
    );
    execFileSync(soffice!, ['--headless', '--convert-to', 'pptx', '--outdir', dir, join(dir, 'deck.fodp')], { stdio: 'ignore' });
    const all = await renderPages(join(dir, 'deck.pptx'), parsePages(undefined));
    expect(all).toMatchObject({ total: 3, first: 1, last: 3 });
    expect(all.images.map((i) => Buffer.from(i.data, 'base64').subarray(1, 4).toString())).toEqual(['PNG', 'PNG', 'PNG']);
    const some = await renderPages(join(dir, 'deck.pptx'), parsePages('2-3'));
    expect(some).toMatchObject({ total: 3, first: 2, last: 3 });
    expect(some.images[0]!.data).toBe(all.images[1]!.data);
  }, 60_000);
});
