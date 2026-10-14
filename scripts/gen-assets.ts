// Generates assets/icon.svg and assets/thumbnail.svg from src/ui/logo.ts, plus PNGs when headless Chrome is
// available (exact sizes, transparent corners). Usage: npm run assets
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { iconSvg, thumbnailSvg } from '../src/ui/logo.js';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.svg', iconSvg(512));
writeFileSync('assets/thumbnail.svg', thumbnailSvg(version));
console.log('wrote assets/icon.svg, assets/thumbnail.svg');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!CHROME) {
  console.log('skipped PNGs (no Chrome/Chromium found)');
} else {
  for (const [name, w, h] of [['icon', 512, 512], ['thumbnail', 1280, 640]] as const) {
    execFileSync(
      CHROME,
      ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${w},${h}`, `--screenshot=${resolve(`assets/${name}.png`)}`, `file://${resolve(`assets/${name}.svg`)}`],
      { stdio: 'ignore', timeout: 60_000 },
    );
    console.log(`wrote assets/${name}.png (${w}x${h})`);
  }
}
