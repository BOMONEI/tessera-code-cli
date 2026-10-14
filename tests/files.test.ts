import { describe, expect, it } from 'vitest';
import { findOccurrences } from '../src/tools/files.js';
import { parseCatalog } from '../src/providers/catalog.js';

describe('findOccurrences', () => {
  it('finds exact matches', () => {
    expect(findOccurrences('a b a', 'a')).toEqual([{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  });
  it('falls back to trailing-whitespace-insensitive line matching', () => {
    const content = 'function f() {  \n  return 1;\n}\n';
    const hits = findOccurrences(content, 'function f() {\n  return 1;');
    expect(hits).toHaveLength(1);
    expect(content.slice(hits[0]!.start, hits[0]!.end)).toBe('function f() {  \n  return 1;');
  });
  it('returns nothing when absent', () => expect(findOccurrences('abc', 'xyz')).toEqual([]));
});

describe('parseCatalog', () => {
  it('maps per-model npm packages to API formats', () => {
    const models = parseCatalog({
      'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        models: {
          'glm-5.2': { name: 'GLM', limit: { context: 1000, output: 100 }, cost: { input: 1, output: 2 } },
          'minimax-m3': { provider: { npm: '@ai-sdk/anthropic' } },
          'gpt-6-luna': { provider: { npm: '@ai-sdk/openai' } },
          'no-tools': { tool_call: false },
        },
      },
    });
    expect(Object.fromEntries(models.map((m) => [m.id, m.format]))).toEqual({ 'glm-5.2': 'chat', 'gpt-6-luna': 'responses', 'minimax-m3': 'messages' });
  });
});
