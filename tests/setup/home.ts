import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test file gets its own ~/.tessera-code: files run in parallel workers, and several of them write
// config.json, so a shared folder made them overwrite each other's files mid-test. Runs before the file's imports.
process.env.TESSERA_HOME = mkdtempSync(join(tmpdir(), 'tessera-test-home-'));
