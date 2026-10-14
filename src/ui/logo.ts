/**
 * tessera-code icon: a "T" laid in mosaic tiles (tessera = a mosaic tile). One pixel map drives the terminal
 * icon (half-block characters, two pixels per cell) and the SVG/PNG assets (scripts/gen-assets.ts).
 *
 *   .  transparent      t  mosaic tile (color varies per position)      W  letter
 */
export const ICON_MAP = [
  '..tttttttt..',
  '.tttttttttt.',
  'ttWWWWWWWWtt',
  'ttWWWWWWWWtt',
  'tttttWWttttt',
  'tttttWWttttt',
  'tttttWWttttt',
  'tttttWWttttt',
  'tttttWWttttt',
  'tttttWWttttt',
  '.tttttttttt.',
  '..tttttttt..',
];

const TILES = ['#0ea5e9', '#14b8a6', '#6366f1', '#8b5cf6', '#0891b2', '#7c3aed', '#2563eb', '#0d9488'];
const LETTER = ['#fefce8', '#fde68a'];

/** Deterministic per-pixel color, so the mosaic looks hand-laid but never changes. */
export function pixelColor(x: number, y: number): string | undefined {
  const c = ICON_MAP[y]?.[x];
  if (c === undefined || c === '.') return undefined;
  const h = (x * 73856093) ^ (y * 19349663);
  if (c === 'W') return LETTER[Math.abs(h) % LETTER.length];
  return TILES[Math.abs(h) % TILES.length];
}

export const ICON_WIDTH = ICON_MAP[0]!.length;
export const ICON_HEIGHT = ICON_MAP.length;

export interface IconCell {
  char: string;
  fg?: string;
  bg?: string;
}

/** Icon as terminal cells: each cell is "▀" with the top pixel as foreground and the bottom one as background. */
export function iconCells(): IconCell[][] {
  const rows: IconCell[][] = [];
  for (let y = 0; y < ICON_HEIGHT; y += 2) {
    const row: IconCell[] = [];
    for (let x = 0; x < ICON_WIDTH; x++) {
      const top = pixelColor(x, y);
      const bottom = pixelColor(x, y + 1);
      if (top && bottom) row.push({ char: '▀', fg: top, bg: bottom });
      else if (top) row.push({ char: '▀', fg: top });
      else if (bottom) row.push({ char: '▄', fg: bottom });
      else row.push({ char: ' ' });
    }
    rows.push(row);
  }
  return rows;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Truecolor ANSI rendering for non-Ink output (REPL / print banners). */
export function iconAnsi(): string[] {
  return iconCells().map((row) =>
    row
      .map((cell) => {
        if (!cell.fg) return cell.char;
        const [r, g, b] = hexToRgb(cell.fg);
        const bg = cell.bg ? `\x1b[48;2;${hexToRgb(cell.bg).join(';')}m` : '';
        return `\x1b[38;2;${r};${g};${b}m${bg}${cell.char}\x1b[0m`;
      })
      .join(''),
  );
}

/** SVG icon: rounded mosaic tiles with grout gaps, optionally on a dark app-icon plate. */
export function iconSvg(size = 512, plate = true): string {
  const inset = plate ? size * 0.12 : 0;
  const cell = (size - inset * 2) / ICON_WIDTH;
  const gap = cell * 0.1;
  const tiles: string[] = [];
  for (let y = 0; y < ICON_HEIGHT; y++) {
    for (let x = 0; x < ICON_WIDTH; x++) {
      const color = pixelColor(x, y);
      if (!color) continue;
      tiles.push(
 `<rect x="${(inset + x * cell + gap / 2).toFixed(2)}" y="${(inset + y * cell + gap / 2).toFixed(2)}" width="${(cell - gap).toFixed(2)}" height="${(cell - gap).toFixed(2)}" rx="${(cell * 0.18).toFixed(2)}" fill="${color}"/>`,
      );
    }
  }
  const bg = plate
    ? `<defs><linearGradient id="plate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#1e1b4b"/></linearGradient></defs>\n<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="url(#plate)"/>\n`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n<title>tessera-code</title>\n${bg}${tiles.join('\n')}\n</svg>\n`;
}

/** Social/preview thumbnail (1280x640): icon, name and tagline on a dark background. */
export function thumbnailSvg(version: string): string {
  const icon = iconSvg(360, false).replace(/^<svg[^>]*>\n<title>[^<]*<\/title>\n/, '').replace(/<\/svg>\n$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
<title>tessera-code</title>
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#1e1b4b"/></linearGradient></defs>
<rect width="1280" height="640" fill="url(#bg)"/>
<g transform="translate(110 140)">${icon}</g>
<text x="540" y="290" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="84" font-weight="700" fill="#f8fafc">tessera-code</text>
<text x="544" y="352" font-family="ui-sans-serif, -apple-system, Helvetica, sans-serif" font-size="34" fill="#a5b4fc">Fast, precise coding agent in your terminal</text>
<text x="544" y="410" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26" fill="#64748b">$ tessera-code · v${version} · OpenCode Go</text>
</svg>
`;
}
