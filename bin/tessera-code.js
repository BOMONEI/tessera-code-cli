#!/usr/bin/env node
// Plain JS that runs on old Node versions too, so setup problems get a clear message instead of a stack trace.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`tessera-code requires Node.js 22 or newer (current: ${process.version}).`);
  console.error('With nvm: nvm install 22 && nvm alias default 22 && nvm use 22, then run npm link again in the project folder.');
  process.exit(1);
}

const cli = new URL('../dist/bundle/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(cli))) {
  console.error('tessera-code is not built yet. In the project folder run:');
  console.error(`  cd ${fileURLToPath(new URL('..', import.meta.url))} && npm ci && npm run build`);
  process.exit(1);
}

await import(cli.href);
