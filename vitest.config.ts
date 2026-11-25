import { defineConfig } from 'vitest/config';

// Tests never touch the real ~/.tessera-code (sessions, history, usage ledger): each test file gets a fresh one.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/home.ts'],
    // The streaming tests assert on 100-300ms timings; on a loaded CI runner one can fire late. Retry once
    // before failing — a real regression fails both attempts.
    retry: process.env.CI ? 1 : 0,
  },
});
