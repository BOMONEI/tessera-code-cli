import { defineConfig } from 'vitest/config';

// Tests never touch the real ~/.tessera-code (sessions, history, usage ledger): each test file gets a fresh one.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/home.ts'],
  },
});
