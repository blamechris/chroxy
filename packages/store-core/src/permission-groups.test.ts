import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import {
  resolvedPermissionOutcome,
  resolvedPermissionGroupKey,
  findResolvedPermissionRuns,
} from './permission-groups'

/**
 * #6894 -- consecutive identical RESOLVED permission prompts group into one
 * compact line with a count. A pending prompt never groups: each pending
 * approval is its own actionable card.
 */

const NOW = 1_000_000

function resolved(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'prompt',
    content: 'shell: Do you want to allow npm registry lookup?',
    tool: 'shell',
    requestId: `req-${id}`,
    answered: 'allow',
    answeredAt: NOW,
    timestamp: NOW,
    ...over,
  } as ChatMessage
}

function pending(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return resolved(id, { answered: undefined, answeredAt: undefined, expiresAt: NOW + 60_000, ...over })
}

const lookup = (msgs: ChatMessage[]) => {
  const map = new Map(msgs.map((m) => [m.id, m]))
  return (row: { id: string }) => map.get(row.id)
}
const rowsOf = (msgs: ChatMessage[]) => msgs.map((m) => ({ id: m.id }))

describe('resolvedPermissionOutcome', () => {
  it('reads a user decision token as allowed / denied', () => {
    expect(resolvedPermissionOutcome(resolved('a', { answered: 'allow' }))).toBe('allowed')
    expect(resolvedPermissionOutcome(resolved('a', { answered: 'allowSession' }))).toBe('allowed')
    expect(resolvedPermissionOutcome(resolved('a', { answered: 'allowAlways' }))).toBe('allowed')
    expect(resolvedPermissionOutcome(resolved('a', { answered: 'deny' }))).toBe('denied')
  })

  it('reads a recorded permissionOutcome (replay, stop, abort) ahead of any token', () => {
    expect(resolvedPermissionOutcome(resolved('a', { answered: undefined, permissionOutcome: 'stopped' }))).toBe('stopped')
    expect(resolvedPermissionOutcome(resolved('a', { answered: undefined, permissionOutcome: 'expired' }))).toBe('expired')
    expect(resolvedPermissionOutcome(resolved('a', { answered: 'allow', permissionOutcome: 'allowed' }))).toBe('allowed')
  })

  it('is null for a pending prompt, the (resolved) placeholder, a question, and a non-prompt', () => {
    expect(resolvedPermissionOutcome(pending('a'))).toBeNull()
    expect(resolvedPermissionOutcome(resolved('a', { answered: '(resolved)' }))).toBeNull()
    // AskUserQuestion prompt: no requestId
    expect(resolvedPermissionOutcome(resolved('a', { requestId: undefined }))).toBeNull()
    expect(resolvedPermissionOutcome(resolved('a', { type: 'response' }))).toBeNull()
  })
})

describe('resolvedPermissionGroupKey', () => {
  it('is equal for prompts that differ only in id / requestId / timestamp', () => {
    const a = resolved('a', { timestamp: 1 })
    const b = resolved('b', { timestamp: 2 })
    expect(resolvedPermissionGroupKey(a)).not.toBeNull()
    expect(resolvedPermissionGroupKey(a)).toBe(resolvedPermissionGroupKey(b))
  })

  it('differs by session, tool, description, outcome and tool input', () => {
    const base = resolvedPermissionGroupKey(resolved('a'))
    expect(resolvedPermissionGroupKey(resolved('b', { originSessionId: 's2' }))).not.toBe(base)
    expect(resolvedPermissionGroupKey(resolved('b', { tool: 'Bash' }))).not.toBe(base)
    expect(resolvedPermissionGroupKey(resolved('b', { content: 'shell: another thing' }))).not.toBe(base)
    expect(resolvedPermissionGroupKey(resolved('b', { answered: 'deny' }))).not.toBe(base)
    expect(resolvedPermissionGroupKey(resolved('b', { toolInput: { command: 'rm -rf x' } }))).not.toBe(base)
  })

  it('treats the same tool input as equal regardless of key order', () => {
    const a = resolved('a', { toolInput: { command: 'ls', cwd: '/x' } })
    const b = resolved('b', { toolInput: { cwd: '/x', command: 'ls' } })
    expect(resolvedPermissionGroupKey(a)).toBe(resolvedPermissionGroupKey(b))
  })

  it('is null for a pending prompt', () => {
    expect(resolvedPermissionGroupKey(pending('a'))).toBeNull()
  })

  it('groups allow / allowSession decisions of one outcome together', () => {
    expect(resolvedPermissionGroupKey(resolved('a', { answered: 'allow' })))
      .toBe(resolvedPermissionGroupKey(resolved('b', { answered: 'allowSession' })))
  })
})

describe('findResolvedPermissionRuns', () => {
  it('groups consecutive identical resolved prompts into one run, in order', () => {
    const msgs = [resolved('a'), resolved('b'), resolved('c')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.items.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(runs[0]!.startIndex).toBe(0)
  })

  it('a single resolved prompt is not a run', () => {
    const msgs = [resolved('a')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a pending prompt never groups, even between two identical resolved ones', () => {
    const msgs = [resolved('a'), pending('p'), resolved('b')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('two identical PENDING prompts never group with each other', () => {
    const msgs = [pending('p1'), pending('p2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a pending prompt ends a run but the resolved prompts before it still group', () => {
    const msgs = [resolved('a'), resolved('b'), pending('p'), resolved('c')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.items.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('a different command breaks the group', () => {
    const msgs = [
      resolved('a'),
      resolved('b'),
      resolved('c', { content: 'shell: a different request' }),
      resolved('d', { content: 'shell: a different request' }),
      resolved('e'),
    ]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs.map((r) => r.items.map((i) => i.id))).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('a different outcome breaks the group (allowed then denied are not one line)', () => {
    const msgs = [resolved('a'), resolved('b', { answered: 'deny' })]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a row with no store message (a synthetic row, a response) breaks the run', () => {
    const msgs = [resolved('a'), resolved('b')]
    const rows = [{ id: 'a' }, { id: 'tool-group-1' }, { id: 'b' }]
    expect(findResolvedPermissionRuns(rows, lookup(msgs))).toEqual([])
  })

  it('reports each run with its start index', () => {
    const msgs = [resolved('x', { content: 'shell: other' }), resolved('a'), resolved('b')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.startIndex).toBe(1)
  })

  it('honours a larger minimum run length', () => {
    const msgs = [resolved('a'), resolved('b')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs), 3)).toEqual([])
  })

  it('groups replayed outcome records the same as live-answered prompts', () => {
    const msgs = [
      resolved('a', { answered: undefined, permissionOutcome: 'expired' }),
      resolved('b', { answered: undefined, permissionOutcome: 'expired' }),
    ]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.items).toHaveLength(2)
  })
})
