type Markdown = typeof import('./markdown.js');

let loaded: Markdown | undefined;
let loading: Promise<Markdown> | undefined;

/**
 * The markdown renderer (marked-terminal + syntax highlighting) takes ~120ms to load, so the TUI draws its first
 * frame without it and loads it right after; answers arrive long after that.
 */
export function loadMarkdown(): Promise<Markdown> {
  loading ??= import('./markdown.js').then(
    (m) => (loaded = m),
    (e: unknown) => {
      loading = undefined; // retry on the next call; until then text stays raw
      throw e;
    },
  );
  return loading;
}

/** The renderer when loaded; until then callers show raw text. */
export function markdown(): Markdown | undefined {
  return loaded;
}
