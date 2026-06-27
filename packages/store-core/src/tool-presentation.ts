/**
 * Canonical tool-presentation registry (chat redesign epic #6389, Phase 0 #6390).
 *
 * Both the dashboard and the mobile op-card renderers need to agree on
 * how a tool is presented: which *kind* it is (read / edit / exec / …),
 * which icon glyph stands for it, which color token tints it, and the
 * human verb label. Today each client re-derives icon + color inline, so
 * "Read = blue book" can drift between web and React Native. This module
 * defines that mapping ONCE — pure data, no DOM / React Native deps —
 * the same way {@link ./tool-summary} centralised the collapsed-preview
 * extraction.
 *
 * The `label` reuses {@link formatToolName} so per-row labels keep
 * matching the grouped-header breakdown (no second naming scheme).
 *
 * Consumers (Phase 2 op-card grammar) map the platform-neutral fields to
 * their own primitives:
 *   - `icon`       → a Tabler icon name (web) / an icon component (mobile)
 *   - `colorToken` → `var(--<colorToken>)` (web) / the matching `COLORS`
 *                    entry (mobile). These are the existing dashboard
 *                    accent token names; Phase 0's `@chroxy/design-tokens`
 *                    package (#6390) keeps them as the canonical
 *                    cross-surface keys.
 */

import { formatToolName } from './group-messages'

/** Coarse classification of a tool by what it does. `other` is the
 *  catch-all for MCP tools, ToolSearch, custom/unknown tools, etc. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'exec'
  | 'search'
  | 'web'
  | 'task'
  | 'todo'
  | 'question'
  | 'other'

export interface ToolPresentation {
  kind: ToolKind
  /** Semantic icon key — each client maps it to its own icon set. */
  icon: string
  /** Theme color token name (no `--` prefix) the client resolves. */
  colorToken: string
  /** Human-facing label — `formatToolName(name, serverName)`. */
  label: string
}

/** Per-kind icon + color. Color tokens are the existing dashboard accent
 *  tokens (see theme.css); the icon keys are semantic and platform-neutral. */
export const TOOL_KIND_META: Readonly<Record<ToolKind, { icon: string; colorToken: string }>> = {
  // #6426: read/search/web use accent-CYAN, not accent-blue — the latter is the
  // presence rail's "thinking" colour, so the rail looked identical whether
  // Claude was thinking or running a Read (the most common tool). Cyan keeps the
  // cool/retrieval feel while reading as distinct from thinking-blue.
  read: { icon: 'file-text', colorToken: 'accent-cyan' },
  edit: { icon: 'pencil', colorToken: 'accent-orange' },
  write: { icon: 'file-plus', colorToken: 'accent-green' },
  exec: { icon: 'terminal', colorToken: 'accent-purple' },
  search: { icon: 'search', colorToken: 'accent-cyan' },
  web: { icon: 'world', colorToken: 'accent-cyan' },
  task: { icon: 'subtask', colorToken: 'accent-purple' },
  todo: { icon: 'checklist', colorToken: 'accent-green' },
  question: { icon: 'help', colorToken: 'accent-orange' },
  other: { icon: 'tool', colorToken: 'text-muted' },
}

// Canonical name → kind. Keys are the tool name lower-cased with `_`/`-`
// stripped, so `Read`, `read_file`, and `read-file` all resolve to the
// same entry. Covers the Claude Code core tools plus common synonyms from
// other providers (Codex/Gemini/MCP-shaped names).
const KIND_BY_NORMALIZED_NAME: Readonly<Record<string, ToolKind>> = {
  read: 'read',
  readfile: 'read',
  notebookread: 'read',
  ls: 'read',
  cat: 'read',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  applypatch: 'edit',
  update: 'edit',
  write: 'write',
  writefile: 'write',
  createfile: 'write',
  bash: 'exec',
  bashoutput: 'exec',
  shell: 'exec',
  execute: 'exec',
  killbash: 'exec',
  killshell: 'exec',
  grep: 'search',
  glob: 'search',
  search: 'search',
  find: 'search',
  websearch: 'web',
  webfetch: 'web',
  fetch: 'web',
  task: 'task',
  agent: 'task',
  todowrite: 'todo',
  todoread: 'todo',
  askuserquestion: 'question',
}

const MCP_PREFIX = 'mcp__'

/** Classify a tool name into a {@link ToolKind}. MCP tools (`mcp__…`) and
 *  anything unrecognised fall back to `other` — never throws. */
export function getToolKind(name: string | undefined | null): ToolKind {
  if (!name) return 'other'
  // MCP tools carry a server-qualified shape (`mcp__github__list_repos`)
  // whose intent we can't reliably infer — classify as `other` rather
  // than guessing off the trailing verb.
  if (name.startsWith(MCP_PREFIX)) return 'other'
  const normalized = name.toLowerCase().replace(/[_-]/g, '')
  return KIND_BY_NORMALIZED_NAME[normalized] ?? 'other'
}

/** Full presentation descriptor for a tool: kind + icon + color token +
 *  display label. `serverName` is forwarded to {@link formatToolName} so
 *  MCP/server-prefixed labels match the rest of the chat surface. */
export function getToolPresentation(
  name: string | undefined | null,
  serverName?: string,
): ToolPresentation {
  const kind = getToolKind(name)
  const meta = TOOL_KIND_META[kind]
  return {
    kind,
    icon: meta.icon,
    colorToken: meta.colorToken,
    label: formatToolName(name ?? '', serverName),
  }
}
