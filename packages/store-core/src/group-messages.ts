/**
 * Shared message grouping selector (#3747).
 *
 * Groups consecutive tool_use and thinking messages into a single activity
 * group so chat surfaces can render them as one collapsible block instead
 * of a wall of individual bubbles. Pure structural grouping with no React
 * or platform dependencies — both the mobile app and the desktop dashboard
 * consume the same DisplayGroup output.
 *
 * Boundary rule: any non-tool, non-thinking message (assistant text, user
 * input, prompts, errors, system events) ends the current group. Permission
 * prompts and question prompts are `type: 'prompt'`, so they break runs and
 * stay as standalone rows.
 */
import type { ChatMessage } from './types'

export type DisplayGroup =
  | { type: 'single'; message: ChatMessage }
  | { type: 'activity'; messages: ChatMessage[]; isActive: boolean; key: string }

/** Group consecutive tool_use and thinking messages into ActivityGroups.
 *  Pure structural grouping — does not depend on streaming state. */
export function groupMessages(messages: ChatMessage[]): DisplayGroup[] {
  const groups: DisplayGroup[] = []
  let activityBuf: ChatMessage[] = []

  const flushActivity = () => {
    const first = activityBuf[0]
    if (!first) return
    groups.push({
      type: 'activity',
      messages: [...activityBuf],
      isActive: false,
      key: `activity-${first.id}`,
    })
    activityBuf = []
  }

  for (const msg of messages) {
    if (msg.type === 'tool_use' || msg.type === 'thinking') {
      activityBuf.push(msg)
    } else {
      flushActivity()
      groups.push({ type: 'single', message: msg })
    }
  }
  flushActivity()

  return groups
}

/** Apply streaming isActive overlay — marks the last activity group as
 *  active when streaming is in progress and that group includes the
 *  most-recent message. `streamingMessageId` is used as a truthy flag. */
export function applyStreamingOverlay(
  baseGroups: DisplayGroup[],
  messages: ChatMessage[],
  streamingMessageId: string | null,
): DisplayGroup[] {
  if (!streamingMessageId || baseGroups.length === 0) return baseGroups
  const last = baseGroups[baseGroups.length - 1]
  if (!last || last.type !== 'activity') return baseGroups
  const lastMsg = last.messages[last.messages.length - 1]
  const tail = messages[messages.length - 1]
  if (!lastMsg || !tail || lastMsg !== tail) return baseGroups
  const result = baseGroups.slice(0, -1)
  result.push({
    type: 'activity',
    messages: last.messages,
    isActive: true,
    key: last.key,
  })
  return result
}

/** Count of tool_use messages in a group (thinking messages are excluded). */
export function countToolUses(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) if (m.type === 'tool_use') n++
  return n
}

/** Per-tool counts sorted by count desc, then name asc. Each entry uses the
 *  formatted display name so the header text matches the row labels. */
export function summarizeToolCounts(
  messages: ChatMessage[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const m of messages) {
    if (m.type !== 'tool_use') continue
    const name = formatToolName(m.tool ?? 'Tool', m.serverName)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
}

/** Render counts as "10 Bash, 2 Read". Returns empty string when there are
 *  no tool messages (e.g. a thinking-only group). */
export function formatToolBreakdown(
  counts: { name: string; count: number }[],
): string {
  return counts.map(({ name, count }) => `${count} ${name}`).join(', ')
}

/** Format a tool name for display:
 *  - `Bash` → `Bash`
 *  - `mcp__github__list_repos` → `Github: List Repos`
 *  - `read_file` → `Read File`
 *  - `Read` + serverName `gh` → `gh Read` (MCP server prefix preserved)
 */
function formatToolName(name: string, serverName?: string): string {
  const MCP_PREFIX = 'mcp__'
  if (name.startsWith(MCP_PREFIX)) {
    const withoutPrefix = name.slice(MCP_PREFIX.length)
    const sep = withoutPrefix.indexOf('__')
    if (sep > 0) {
      const server = withoutPrefix.slice(0, sep).split('_').filter(Boolean).map(capitalize).join(' ')
      const tool = withoutPrefix.slice(sep + 2).split('_').filter(Boolean).map(capitalize).join(' ')
      return tool ? `${server}: ${tool}` : server
    }
  }
  const formatted = name.split('_').filter(Boolean).map(capitalize).join(' ')
  return serverName ? `${serverName} ${formatted}` : formatted
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''
}
