import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Version from the nearest package.json (works from src/ under tsx and from the dist/bundle/ build). */
export const VERSION: string = (() => {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dirname(dir) !== dir; dir = dirname(dir)) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'tessera-code') return pkg.version ?? '0.0.0';
    }
  }
  return '0.0.0';
})();
