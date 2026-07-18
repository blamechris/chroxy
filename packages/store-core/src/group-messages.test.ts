/**
 * Tests for the shared message grouping selector (#3747).
 */
import { describe, it, expect } from 'vitest'
import {
  groupMessages,
  applyStreamingOverlay,
  countToolUses,
  summarizeToolCounts,
  formatToolBreakdown,
} from './group-messages'
import type { ChatMessage } from './types'

function msg(
  id: string,
  type: ChatMessage['type'],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    type,
    content: '',
    timestamp: 0,
    ...extra,
  }
}

describe('groupMessages', () => {
  it('returns empty array for no messages', () => {
    expect(groupMessages([])).toEqual([])
  })

  it('wraps a single non-tool message as { type: "single" }', () => {
    const a = msg('a', 'response', { content: 'hi' })
    const groups = groupMessages([a])
    expect(groups).toEqual([{ type: 'single', message: a }])
  })

  it('wraps a lone tool_use as a 1-item activity group', () => {
    const t = msg('t1', 'tool_use', { tool: 'Bash' })
    const groups = groupMessages([t])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('activity')
    if (groups[0].type === 'activity') {
      expect(groups[0].messages).toEqual([t])
      expect(groups[0].key).toBe('activity-t1')
      expect(groups[0].isActive).toBe(false)
    }
  })

  it('groups consecutive tool_use messages into one activity', () => {
    const a = msg('1', 'tool_use', { tool: 'Bash' })
    const b = msg('2', 'tool_use', { tool: 'Read' })
    const c = msg('3', 'tool_use', { tool: 'Bash' })
    const groups = groupMessages([a, b, c])
    expect(groups).toHaveLength(1)
    if (groups[0].type === 'activity') {
      expect(groups[0].messages).toEqual([a, b, c])
      expect(groups[0].key).toBe('activity-1')
    }
  })

  it('keeps thinking standalone, breaking a tool run (#6756)', () => {
    // Thinking now carries real reasoning content, so each thinking bubble is
    // its own `single` row (reaching the content-capable disclosure) instead of
    // collapsing into the tool activity group.
    const t1 = msg('1', 'thinking')
    const u = msg('2', 'tool_use', { tool: 'Bash' })
    const t2 = msg('3', 'thinking')
    const groups = groupMessages([t1, u, t2])
    expect(groups).toHaveLength(3)
    expect(groups[0].type).toBe('single')
    expect(groups[1].type).toBe('activity')
    expect(groups[2].type).toBe('single')
    if (groups[1].type === 'activity') {
      expect(groups[1].messages).toHaveLength(1)
    }
  })

  it('breaks a run when an assistant response appears mid-stream', () => {
    const t1 = msg('1', 'tool_use', { tool: 'Bash' })
    const r = msg('2', 'response', { content: 'thinking out loud' })
    const t2 = msg('3', 'tool_use', { tool: 'Read' })
    const groups = groupMessages([t1, r, t2])
    expect(groups).toHaveLength(3)
    expect(groups[0].type).toBe('activity')
    expect(groups[1]).toEqual({ type: 'single', message: r })
    expect(groups[2].type).toBe('activity')
  })

  it('breaks a run on prompt (permission/question) messages', () => {
    const t = msg('1', 'tool_use', { tool: 'Bash' })
    const p = msg('2', 'prompt', { requestId: 'req-1' })
    const t2 = msg('3', 'tool_use', { tool: 'Bash' })
    const groups = groupMessages([t, p, t2])
    expect(groups).toHaveLength(3)
    expect(groups[1]).toEqual({ type: 'single', message: p })
  })

  it('breaks a run on user_input, error, and system messages', () => {
    const tool = msg('1', 'tool_use', { tool: 'Bash' })
    const user = msg('2', 'user_input', { content: 'go' })
    const err = msg('3', 'error', { content: 'boom' })
    const sys = msg('4', 'system', { content: 'restarted' })
    const groups = groupMessages([tool, user, err, sys])
    expect(groups.map((g) => g.type)).toEqual(['activity', 'single', 'single', 'single'])
  })

  it('uses the first message id as the stable group key', () => {
    const a = msg('first', 'tool_use', { tool: 'Bash' })
    const b = msg('second', 'tool_use', { tool: 'Read' })
    const groups = groupMessages([a, b])
    if (groups[0].type === 'activity') {
      expect(groups[0].key).toBe('activity-first')
    }
  })
})

describe('applyStreamingOverlay', () => {
  it('returns base groups unchanged when streaming id is null', () => {
    const messages = [msg('1', 'tool_use', { tool: 'Bash' })]
    const base = groupMessages(messages)
    const result = applyStreamingOverlay(base, messages, null)
    expect(result).toBe(base)
  })

  it('returns base groups unchanged when there are no groups', () => {
    const result = applyStreamingOverlay([], [], 'streaming-1')
    expect(result).toEqual([])
  })

  it('marks the last activity group active when it contains the last message', () => {
    const a = msg('1', 'tool_use', { tool: 'Bash' })
    const b = msg('2', 'tool_use', { tool: 'Read' })
    const messages = [a, b]
    const base = groupMessages(messages)
    const result = applyStreamingOverlay(base, messages, 'streaming-1')
    expect(result).toHaveLength(1)
    if (result[0].type === 'activity') {
      expect(result[0].isActive).toBe(true)
    }
  })

  it('does not mark the group active when the last message is not in it', () => {
    const a = msg('1', 'tool_use', { tool: 'Bash' })
    const r = msg('2', 'response', { content: 'ok' })
    const messages = [a, r]
    const base = groupMessages(messages)
    const result = applyStreamingOverlay(base, messages, 'streaming-1')
    // The last group is now a single (response), not activity — base is
    // returned unchanged by reference.
    expect(result).toBe(base)
  })

  it('returns the same reference when the last group is not activity', () => {
    const messages = [msg('1', 'response', { content: 'just text' })]
    const base = groupMessages(messages)
    const result = applyStreamingOverlay(base, messages, 'streaming-1')
    expect(result).toBe(base)
  })

  it('does not mutate the original baseGroups array', () => {
    const a = msg('1', 'tool_use', { tool: 'Bash' })
    const messages = [a]
    const base = groupMessages(messages)
    const originalLength = base.length
    applyStreamingOverlay(base, messages, 'streaming-1')
    expect(base.length).toBe(originalLength)
    if (base[0].type === 'activity') {
      expect(base[0].isActive).toBe(false)
    }
  })

  it('with multiple activity groups only the last gets the overlay', () => {
    const messages = [
      msg('1', 'tool_use', { tool: 'Bash' }),
      msg('2', 'response', { content: 'ok' }),
      msg('3', 'tool_use', { tool: 'Read' }),
      msg('4', 'tool_use', { tool: 'Grep' }),
    ]
    const base = groupMessages(messages)
    expect(base).toHaveLength(3)
    const result = applyStreamingOverlay(base, messages, 'streaming-1')
    if (result[0].type === 'activity') {
      expect(result[0].isActive).toBe(false)
    }
    const last = result[result.length - 1]
    if (last.type === 'activity') {
      expect(last.isActive).toBe(true)
    }
  })
})

describe('countToolUses', () => {
  it('counts tool_use only, ignoring thinking', () => {
    const messages = [
      msg('1', 'tool_use', { tool: 'Bash' }),
      msg('2', 'thinking'),
      msg('3', 'tool_use', { tool: 'Read' }),
    ]
    expect(countToolUses(messages)).toBe(2)
  })

  it('returns 0 for empty input', () => {
    expect(countToolUses([])).toBe(0)
  })
})

describe('summarizeToolCounts', () => {
  it('returns per-tool counts sorted by count desc then name asc', () => {
    const messages = [
      msg('1', 'tool_use', { tool: 'Bash' }),
      msg('2', 'tool_use', { tool: 'Bash' }),
      msg('3', 'tool_use', { tool: 'Bash' }),
      msg('4', 'tool_use', { tool: 'Read' }),
      msg('5', 'tool_use', { tool: 'Read' }),
      msg('6', 'tool_use', { tool: 'Grep' }),
    ]
    expect(summarizeToolCounts(messages)).toEqual([
      { name: 'Bash', count: 3 },
      { name: 'Read', count: 2 },
      { name: 'Grep', count: 1 },
    ])
  })

  it('ignores thinking messages', () => {
    const messages = [
      msg('1', 'thinking'),
      msg('2', 'tool_use', { tool: 'Bash' }),
    ]
    expect(summarizeToolCounts(messages)).toEqual([{ name: 'Bash', count: 1 }])
  })

  it('formats snake_case tool names with capitalised words', () => {
    const messages = [msg('1', 'tool_use', { tool: 'read_file' })]
    expect(summarizeToolCounts(messages)).toEqual([{ name: 'Read File', count: 1 }])
  })

  it('expands MCP-prefixed tool names to "Server: Tool"', () => {
    const messages = [
      msg('1', 'tool_use', { tool: 'mcp__github__list_repos' }),
      msg('2', 'tool_use', { tool: 'mcp__github__list_repos' }),
    ]
    expect(summarizeToolCounts(messages)).toEqual([
      { name: 'Github: List Repos', count: 2 },
    ])
  })

  it('returns [] when no tool messages exist', () => {
    expect(summarizeToolCounts([msg('1', 'thinking')])).toEqual([])
  })

  it('uses a stable order for entries that have equal counts', () => {
    const messages = [
      msg('1', 'tool_use', { tool: 'Read' }),
      msg('2', 'tool_use', { tool: 'Bash' }),
    ]
    expect(summarizeToolCounts(messages)).toEqual([
      { name: 'Bash', count: 1 },
      { name: 'Read', count: 1 },
    ])
  })
})

describe('formatToolBreakdown', () => {
  it('formats a list of counts as "N Name, N Name"', () => {
    expect(
      formatToolBreakdown([
        { name: 'Bash', count: 10 },
        { name: 'Read', count: 2 },
      ]),
    ).toBe('10 Bash, 2 Read')
  })

  it('returns empty string for empty counts', () => {
    expect(formatToolBreakdown([])).toBe('')
  })

  it('handles a single entry without a trailing comma', () => {
    expect(formatToolBreakdown([{ name: 'Bash', count: 3 }])).toBe('3 Bash')
  })
})
