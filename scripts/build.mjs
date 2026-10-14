// Bundles the CLI into dist/bundle with esbuild. One bundle loads in ~0.27s instead of ~0.43s for the
// unbundled output: ink alone pulls ~430 tiny es-toolkit modules, and resolving thousands of files dominates
// startup. React runs in its production build. Lazy imports (TUI, markdown, MCP, undici) stay separate chunks.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist/bundle', { recursive: true, force: true });
await build({
  entryPoints: ['src/cli.ts'],
  outdir: 'dist/bundle',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // Optional Ink devtools integration; only loaded when explicitly enabled.
  external: ['react-devtools-core'],
  // CommonJS dependencies inside the ESM bundle need `require`.
  banner: { js: "import { createRequire as __tesseraRequire } from 'node:module'; const require = __tesseraRequire(import.meta.url);" },
  logLevel: 'warning',
});
