import stringWidth from 'string-width';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Decision, PermissionRequest } from '../../permissions.js';
import { colorDiff, toolPreview } from '../format.js';
import { iconCells } from '../logo.js';
import { markdown } from '../lazy-markdown.js';

export type HistoryItem =
  | { id: number; kind: 'banner'; card: WelcomeInfo }
  | { id: number; kind: 'user'; text: string }
  /** Raw markdown, rendered at the current width each time the history is drawn (so resizes reflow it). */
  | { id: number; kind: 'assistant'; markdown: string }
  /** `output`: the full result, shown with ctrl+o (expanded view); otherwise the first `lines` lines. */
  | { id: number; kind: 'tool'; label: string; preview?: string; output?: string; lines?: number; isError?: boolean }
  /** First run after an update: one line when collapsed, the release notes in the expanded view (ctrl+o). */
  | { id: number; kind: 'changelog'; version: string; from: string; count: number; markdown: string }
  /** The model's thinking: one line when collapsed, the full text in the expanded view. */
  | { id: number; kind: 'reasoning'; text: string; ms?: number }
  | { id: number; kind: 'diff'; path: string; diff: string; maxLines?: number }
  | { id: number; kind: 'info'; text: string }
  | { id: number; kind: 'error'; text: string };

/** HistoryItem without its id, kept as a discriminated union. */
export type NewHistoryItem = HistoryItem extends infer T ? (T extends HistoryItem ? Omit<T, 'id'> : never) : never;

/** Lines shown in the expanded view before a long output is cut (the full text stays in the session). */
const EXPANDED_MAX_LINES = 400;

function capLines(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length > max ? [...lines.slice(0, max), `… +${lines.length - max} lines`].join('\n') : text;
}

/** Background of the user's prompts: a gray band that sets them apart from answers (light text on it, any theme). */
export const USER_BG = '#3a3d42';

export function HistoryView({ item, width, expanded = false, showThinking = true }: { item: HistoryItem; width: number; expanded?: boolean; showThinking?: boolean }) {
  switch (item.kind) {
    case 'banner':
      return <WelcomeCard info={item.card} />;
    case 'user': {
      const shell = item.text.startsWith('!');
      return (
        <Box marginTop={1} width={width} backgroundColor={USER_BG} paddingX={1}>
          <Text color={shell ? '#f0abfc' : '#67e8f9'} bold>
            {shell ? '!' : '›'}
          </Text>
          {/* A column of its own, so wrapped lines stay indented under the text. */}
          <Box paddingLeft={1} flexGrow={1} flexShrink={1}>
            <Text color="#f1f5f9">{shell ? item.text.slice(1).trimStart() : item.text}</Text>
          </Box>
        </Box>
      );
    }
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text>{markdown()?.renderMarkdown(item.markdown, width - 1) ?? item.markdown}</Text>
        </Box>
      );
    case 'changelog':
      return expanded ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="#facc15" bold>
            ✨ Updated {item.from} → {item.version}
          </Text>
          <Text>{markdown()?.renderMarkdown(item.markdown, width - 1) ?? item.markdown}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text>
            <Text color="#facc15" bold>
              ✨ Updated to {item.version}
            </Text>
            <Text dimColor>
              {' '}
              (from {item.from}) · {item.count} change{item.count === 1 ? '' : 's'} · <Text italic>ctrl+o to expand · /changelog</Text>
            </Text>
          </Text>
        </Box>
      );
    case 'reasoning': {
      if (!showThinking && !expanded) return null; // hidden; ctrl+o still shows it
      const seconds = item.ms !== undefined ? ` for ${Math.max(1, Math.round(item.ms / 1000))}s` : '';
      return expanded ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta">∴ Thinking{seconds}</Text>
          <Text dimColor italic>
            {capLines(item.text.trim(), EXPANDED_MAX_LINES).replace(/^/gm, '  ')}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            ∴ Thought{seconds} <Text italic>(ctrl+o to expand)</Text>
          </Text>
        </Box>
      );
    }
    case 'tool': {
      const full = item.output ?? item.preview ?? '';
      const preview = item.output !== undefined ? toolPreview(item.output, item.lines) : item.preview;
      const more = item.output !== undefined && preview !== item.output;
      const shown = expanded && item.output !== undefined ? capLines(full, EXPANDED_MAX_LINES) : preview;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={item.isError ? 'red' : 'cyan'}>● </Text>
            <Text bold>{item.label}</Text>
          </Text>
          {shown ? <Text dimColor>{shown.replace(/^/gm, '  ⎿ ')}</Text> : null}
          {more && !expanded ? <Text dimColor italic>    (ctrl+o to expand)</Text> : null}
        </Box>
      );
    }
    case 'diff': {
      const lines = item.diff.split('\n').filter((l) => !l.startsWith('\\'));
      const limit = expanded ? Math.max(item.maxLines ?? 0, EXPANDED_MAX_LINES) : (item.maxLines ?? 30);
      const shown = lines.slice(0, limit);
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {item.maxLines ? <Text bold>{item.path}</Text> : null}
          <Text>{colorDiff(shown.join('\n'), width - 2)}</Text>
          {lines.length > shown.length ? (
            <Text dimColor>
              … +{lines.length - shown.length} lines{expanded ? '' : <Text italic> (ctrl+o to expand)</Text>}
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'info':
      return <Text dimColor>{item.text}</Text>;
    case 'error':
      return <Text color="red">✗ {item.text}</Text>;
  }
}

const OPTIONS: Array<{ key: string; decision: Decision; label: (rule: string) => string }> = [
  { key: 'y', decision: 'allow-once', label: () => 'Yes' },
  { key: 's', decision: 'allow-session', label: (r) => `Yes, for this session (${r})` },
  { key: 'a', decision: 'allow-always', label: (r) => `Yes, always in this project (${r})` },
  { key: 'n', decision: 'deny', label: () => 'No, tell the agent what to do differently' },
];

export function PermissionPrompt({ req, onDecide, onInterrupt }: { req: PermissionRequest; onDecide: (d: Decision) => void; onInterrupt: () => void }) {
  const [index, setIndex] = useState(0);
  const rule = req.saveRule ?? req.rule;
  // Sensitive requests cannot be remembered, so only offer once/deny. Index, wrap-around and keys all use this list.
  const options = req.sensitive ? OPTIONS.filter((o) => o.decision === 'allow-once' || o.decision === 'deny') : OPTIONS;
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onDecide('deny');
      onInterrupt();
    } else if (key.upArrow) setIndex((i) => (i + options.length - 1) % options.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
    else if (key.return) onDecide(options[index]!.decision);
    else if (key.escape) onDecide('deny');
    else {
      const hit = options.find((o) => o.key === input.toLowerCase());
      if (hit) onDecide(hit.decision);
    }
  });
  const columns = process.stdout.columns ?? 80;
  const detail = req.detail ? (req.tool === 'edit' ? colorDiff(req.detail, columns - 4) : req.detail) : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        {req.tool === 'bash' ? 'Run command?' : req.tool === 'edit' ? 'Apply change?' : 'Allow?'}
      </Text>
      <Text bold>{req.title}</Text>
      {detail ? <Text>{detail.split('\n').slice(0, 40).join('\n')}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((o, i) => (
          <Text key={o.key} color={i === index ? 'cyan' : undefined}>
            {i === index ? '❯ ' : '  '}
            {o.key}. {o.label(rule)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export interface WelcomeInfo {
  version: string;
  model: string;
  thinking?: boolean;
  cwd: string;
  session: string;
  /** Extra lines: MCP status, warnings, resume info. */
  notes: string[];
}

/** The app icon, drawn with half-block characters (two pixels per cell, truecolor). */
export function Icon() {
  return (
    <Box flexDirection="column">
      {iconCells().map((row, y) => (
        <Text key={y}>
          {row.map((cell, x) =>
            cell.fg ? (
              <Text key={x} color={cell.fg} backgroundColor={cell.bg}>
                {cell.char}
              </Text>
            ) : (
              <Text key={x}>{cell.char}</Text>
            ),
          )}
        </Text>
      ))}
    </Box>
  );
}

/** Shortens `text` to `max` display columns (CJK counts double) by cutting out its middle. */
export function middleEllipsis(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  const chars = [...text];
  const take = (budget: number, from: string[]) => {
    const out: string[] = [];
    for (const ch of from) {
      budget -= stringWidth(ch);
      if (budget < 0) break;
      out.push(ch);
    }
    return out;
  };
  if (max < 8) return take(Math.max(1, max), chars).join('');
  const keep = max - 1;
  const head = take(Math.ceil(keep / 3), chars);
  const tail = take(keep - stringWidth(head.join('')), [...chars].reverse()).reverse();
  return `${head.join('')}…${tail.join('')}`;
}

/** Startup card ("thumbnail"): icon plus name, version, model and key hints. */
export function WelcomeCard({ info }: { info: WelcomeInfo }) {
  const columns = process.stdout.columns ?? 80;
  const wide = columns >= 64;
  const home = process.env.HOME ?? '';
  // Fit on one line: border+padding (6) + icon and gap (15 when shown) + label (8).
  const cwd = middleEllipsis(home && info.cwd.startsWith(home) ? '~' + info.cwd.slice(home.length) : info.cwd, columns - (wide ? 29 : 14));
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="#6366f1" paddingX={2} paddingY={0} gap={3}>
        {wide ? <Icon /> : null}
        <Box flexDirection="column" justifyContent="center">
          <Text>
            <Text bold color="#f8fafc">
              tessera-code
            </Text>
          </Text>
          <Text color="#a5b4fc">Fast, precise coding agent</Text>
          <Text> </Text>
          <Text>
            <Text color="#64748b">version </Text>
            <Text color="#facc15">{info.version}</Text>
          </Text>
          <Text>
            <Text color="#64748b">model   </Text>
            {middleEllipsis(info.model, 40)}
            {info.thinking === undefined ? '' : <Text color={info.thinking ? '#c084fc' : '#64748b'}>{info.thinking ? ' · thinking' : ' · fast'}</Text>}
          </Text>
          <Text>
            <Text color="#64748b">cwd     </Text>
            {cwd}
          </Text>
        </Box>
      </Box>
      <Text color="#64748b">
        {'  '}@ attach files · / commands · /command keys · ctrl+t thinking · shift+tab mode · esc interrupt
      </Text>
      {info.notes.map((n, i) => (
        <Text key={i} color={n.startsWith('⚠') ? 'yellow' : '#64748b'}>
          {'  '}
          {n}
        </Text>
      ))}
    </Box>
  );
}

/** Single-choice list (↑↓ / number keys, enter, esc). Shows a window of `height` options around the selection. */
export function Picker({
  title,
  options,
  onSelect,
  onCancel,
  height = 10,
}: {
  title: string;
  options: Array<{ label: string; hint?: string }>;
  onSelect: (index: number) => void;
  onCancel: () => void;
  height?: number;
}) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) onCancel();
    else if (key.upArrow) setIndex((i) => (i + options.length - 1) % options.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
    else if (key.pageUp) setIndex((i) => Math.max(0, i - height));
    else if (key.pageDown) setIndex((i) => Math.min(options.length - 1, i + height));
    else if (key.return) onSelect(index);
    else if (/^[1-9]$/.test(input) && Number(input) <= options.length) onSelect(Number(input) - 1);
  });
  const start = Math.min(Math.max(0, index - Math.floor(height / 2)), Math.max(0, options.length - height));
  const shown = options.slice(start, start + height);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
      {shown.map((o, k) => {
        const i = start + k;
        const selected = i === index;
        return (
          <Text key={i} wrap="truncate">
            <Text color={selected ? 'cyan' : undefined}>
              {selected ? '❯ ' : '  '}
              {i < 9 ? `${i + 1}. ` : '   '}
              {o.label}
            </Text>
            {o.hint ? <Text dimColor>  {o.hint}</Text> : null}
          </Text>
        );
      })}
      {start + height < options.length ? <Text dimColor>  ↓ {options.length - start - height} more</Text> : null}
      <Text dimColor>↑↓ select · enter confirm · esc cancel</Text>
    </Box>
  );
}
