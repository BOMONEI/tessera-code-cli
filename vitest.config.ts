import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests never touch the real ~/.tessera-code (sessions, history, usage ledger).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { TESSERA_HOME: mkdtempSync(join(tmpdir(), 'tessera-test-home-')) },
  },
});
