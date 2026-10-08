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
    // A LIVE prompt carries the tool input the server broadcast; a record rebuilt
    // from history does not (see `replayedRecord`).
    toolInput: { command: 'npm view @chroxy/server version' },
    answered: 'allow',
    answeredAt: NOW,
    timestamp: NOW,
    ...over,
  } as ChatMessage
}

/** A record as `buildPermissionOutcomeMessage` rebuilds it from a replayed `permission_outcome`: no tool input. */
function replayedRecord(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  const { toolInput: _toolInput, ...rest } = resolved(id, over)
  void _toolInput
  return rest as ChatMessage
}

function pending(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return resolved(id, { answered: undefined, answeredAt: undefined, expiresAt: NOW + 60_000, ...over })
}

/** A tool bubble as `handleToolStart` records it (type tool_use, tool name, structured input). */
function toolUse(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'tool_use',
    content: 'touch smoke-perm.txt',
    tool: 'shell',
    toolUseId: `tu-${id}`,
    toolInput: { command: 'touch smoke-perm.txt' },
    timestamp: NOW,
    ...over,
  } as ChatMessage
}

const lookup = (msgs: ChatMessage[], groups: Record<string, ChatMessage[]> = {}) => {
  const map = new Map(msgs.map((m) => [m.id, m]))
  return (row: { id: string }): ChatMessage[] => {
    if (groups[row.id]) return groups[row.id]!
    const m = map.get(row.id)
    return m ? [m] : []
  }
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

  it('keeps allow, allowSession and allowAlways apart: a persistent rule is not a one-time allow', () => {
    const key = (answered: string) => resolvedPermissionGroupKey(resolved('x', { answered }))
    expect(new Set([key('allow'), key('allowSession'), key('allowAlways')]).size).toBe(3)
    expect(key('allow')).toBe(resolvedPermissionGroupKey(resolved('y', { answered: 'allow' })))
  })

  it('a record whose tool input was NOT recorded keys on its own requestId: it never matches another', () => {
    const a = replayedRecord('a')
    const b = replayedRecord('b') // same session, tool, description, outcome
    expect(resolvedPermissionGroupKey(a)).not.toBeNull()
    expect(resolvedPermissionGroupKey(a)).not.toBe(resolvedPermissionGroupKey(b))
    // ... and the same record keys the same every time (a stable group id)
    expect(resolvedPermissionGroupKey(a)).toBe(resolvedPermissionGroupKey(replayedRecord('a')))
  })

  it('an empty recorded input still counts as recorded (a tool with no arguments)', () => {
    const a = resolved('a', { toolInput: {} })
    const b = resolved('b', { toolInput: {} })
    expect(resolvedPermissionGroupKey(a)).toBe(resolvedPermissionGroupKey(b))
  })

  it('a live record and an unrecorded one never share a key', () => {
    expect(resolvedPermissionGroupKey(resolved('a'))).not.toBe(resolvedPermissionGroupKey(replayedRecord('a')))
  })
})

describe('findResolvedPermissionRuns', () => {
  it('groups consecutive identical resolved prompts into one run, in order', () => {
    const msgs = [resolved('a'), resolved('b'), resolved('c')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.items.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(runs[0]!.startIndex).toBe(0)
    expect(runs[0]!.indices).toEqual([0, 1, 2])
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

  it('a live group of three still forms', () => {
    const msgs = [resolved('a'), resolved('b'), resolved('c')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.items).toHaveLength(3)
  })

  // The server journals a prompt's DESCRIPTION, not its input (#8503), and the
  // description is chosen by the agent (redaction.js prefers `input.description`
  // over `input.command`). Two commands under one rationale are indistinguishable
  // in a replayed record, so those never fold. Until #8503 journals the input,
  // grouping happens only where the input is known: live.
  it('replayed records of the same description (different, unknown commands) do NOT group', () => {
    const msgs = [
      replayedRecord('a', { tool: 'Bash', content: 'Bash: Clean up', answered: 'allow', permissionOutcome: 'allowed' }),
      replayedRecord('b', { tool: 'Bash', content: 'Bash: Clean up', answered: 'allow', permissionOutcome: 'allowed' }),
    ]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('replayed expired / stopped records do not group either', () => {
    for (const permissionOutcome of ['expired', 'stopped'] as const) {
      const msgs = [
        replayedRecord('a', { answered: undefined, permissionOutcome }),
        replayedRecord('b', { answered: undefined, permissionOutcome }),
      ]
      expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
    }
  })

  it('a live prompt that was aborted or stopped (it still holds its input) groups', () => {
    const msgs = [
      resolved('a', { answered: undefined, permissionOutcome: 'stopped' }),
      resolved('b', { answered: undefined, permissionOutcome: 'stopped' }),
    ]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toHaveLength(1)
  })

  it('allow, allowAlways and allowSession prompts stay in separate runs', () => {
    const msgs = [
      resolved('a', { answered: 'allow' }),
      resolved('b', { answered: 'allowAlways' }),
      resolved('c', { answered: 'allowAlways' }),
      resolved('d', { answered: 'allowSession' }),
    ]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs.map((r) => r.items.map((i) => i.id))).toEqual([['b', 'c']])
  })

  it('a hidden message carrying a turn boundary (a filtered system row) ends the run', () => {
    const hidden = { id: 'sys', type: 'system', content: 'turn ended', turnBoundary: true, timestamp: NOW } as ChatMessage
    const msgs = [resolved('p1'), toolUse('t1'), hidden, resolved('p2'), toolUse('t2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })
})

/**
 * The shape a real turn is recorded in (#6894 smoke): every approved prompt is
 * accompanied by the tool run it gated, so identical prompts from one turn are
 * SEPARATED by tool bubbles, never adjacent. Built from the message shapes the
 * live handlers produce (`handleToolStart` -> `tool_use`, `handlePermissionRequest`
 * + `permission_resolved` -> an answered `prompt`).
 */
describe('findResolvedPermissionRuns -- the real interleaving of a turn (#6894)', () => {
  const ids = (run: { items: { id: string }[] }) => run.items.map((i) => i.id)

  it('groups prompt / tool-bubble pairs: P T P T P', () => {
    const msgs = [resolved('p1', { tool: 'shell' }), toolUse('t1'), resolved('p2', { tool: 'shell' }), toolUse('t2'), resolved('p3', { tool: 'shell' })]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(ids(runs[0]!)).toEqual(['p1', 'p2', 'p3'])
    expect(runs[0]!.indices).toEqual([0, 2, 4])
  })

  it('groups tool-bubble / prompt pairs: T P T P T P (tool first, as the SDK emits it)', () => {
    const msgs = [toolUse('t1'), resolved('p1'), toolUse('t2'), resolved('p2'), toolUse('t3'), resolved('p3')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(ids(runs[0]!)).toEqual(['p1', 'p2', 'p3'])
    expect(runs[0]!.indices).toEqual([1, 3, 5])
  })

  it('a collapsed tool_group of the same tool between two prompts does not break the run', () => {
    const msgs = [resolved('p1'), toolUse('t1'), toolUse('t2'), resolved('p2')]
    const rows = [{ id: 'p1' }, { id: 'activity-t1' }, { id: 'p2' }]
    const runs = findResolvedPermissionRuns(rows, lookup(msgs, { 'activity-t1': [msgs[1]!, msgs[2]!] }))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.indices).toEqual([0, 2])
  })

  it('a tool bubble of a DIFFERENT tool breaks the run', () => {
    const msgs = [resolved('p1'), toolUse('t1', { tool: 'Read' }), resolved('p2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a tool_group that mixes in another tool breaks the run', () => {
    const msgs = [resolved('p1'), toolUse('t1'), toolUse('t2', { tool: 'Read' }), resolved('p2')]
    const rows = [{ id: 'p1' }, { id: 'activity-t1' }, { id: 'p2' }]
    expect(findResolvedPermissionRuns(rows, lookup(msgs, { 'activity-t1': [msgs[1]!, msgs[2]!] }))).toEqual([])
  })

  it.each([
    ['an assistant text block', { id: 'x', type: 'response', content: 'working on it' }],
    ['a user message', { id: 'x', type: 'user_input', content: 'continue' }],
    ['an error', { id: 'x', type: 'error', content: 'boom' }],
  ] as const)('%s between two prompts breaks the run', (_label, over) => {
    const msgs = [resolved('p1'), toolUse('t1'), { ...toolUse('x'), ...over } as ChatMessage, resolved('p2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  // The real order of a Haiku / Sonnet turn (#6894 smoke): the model reasons between
  // tool calls, so `thinking` rows sit among the prompts and tool bubbles.
  const thinking = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id, type: 'thinking', content: 'Let me touch the file.', thinkingStreaming: false, thinkingDurationMs: 300, timestamp: NOW, ...over,
  } as ChatMessage)

  it('a thinking row is transparent: P, thinking, T, P, T, P, T is ONE run of three', () => {
    const msgs = [resolved('p1'), thinking('k1'), toolUse('t1'), resolved('p2'), toolUse('t2'), resolved('p3'), toolUse('t3')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs).toHaveLength(1)
    expect(ids(runs[0]!)).toEqual(['p1', 'p2', 'p3'])
    expect(runs[0]!.indices).toEqual([0, 3, 5])
  })

  it('thinking rows between prompts with no tool bubble at all, and several in a row, do not end it', () => {
    const msgs = [resolved('p1'), thinking('k1'), thinking('k2'), resolved('p2')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs.map(ids)).toEqual([['p1', 'p2']])
  })

  it('a thinking row inside a collapsed tool group payload is transparent too', () => {
    const msgs = [resolved('p1'), thinking('k1'), toolUse('t1'), resolved('p2')]
    const rows = [{ id: 'p1' }, { id: 'activity-k1' }, { id: 'p2' }]
    const runs = findResolvedPermissionRuns(rows, lookup(msgs, { 'activity-k1': [msgs[1]!, msgs[2]!] }))
    expect(runs).toHaveLength(1)
  })

  it('thinking does not rescue a break: thinking + assistant text still ends the run', () => {
    const text = { ...toolUse('x'), type: 'response', content: 'done' } as ChatMessage
    const msgs = [resolved('p1'), thinking('k1'), text, resolved('p2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('thinking does not rescue a pending prompt, a different tool, or a different request', () => {
    const cases = [
      [resolved('p1'), thinking('k1'), pending('p2'), resolved('p3')],
      [resolved('p1'), thinking('k1'), toolUse('t1', { tool: 'Read' }), resolved('p2')],
      [resolved('p1'), thinking('k1'), resolved('p2', { content: 'shell: other' })],
    ]
    for (const msgs of cases) expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a turn boundary on a thinking row ends the run (the next prompt is another turn)', () => {
    const msgs = [resolved('p1'), thinking('k1', { turnBoundary: true } as Partial<ChatMessage>), resolved('p2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a PENDING prompt between two resolved ones breaks the run, tool bubbles or not', () => {
    const msgs = [resolved('p1'), toolUse('t1'), pending('p2'), toolUse('t2'), resolved('p3')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a prompt with a different description breaks the run and starts its own', () => {
    const other = { content: 'shell: something else' }
    const msgs = [resolved('p1'), toolUse('t1'), resolved('p2'), toolUse('t2'), resolved('p3', other), toolUse('t3'), resolved('p4', other)]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs.map(ids)).toEqual([['p1', 'p2'], ['p3', 'p4']])
  })

  it('a turn boundary on a tool bubble between two prompts splits them into different turns', () => {
    const msgs = [resolved('p1'), toolUse('t1', { turnBoundary: true } as Partial<ChatMessage>), resolved('p2')]
    expect(findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))).toEqual([])
  })

  it('a turn boundary on a prompt ends the run after it', () => {
    const msgs = [resolved('p1'), toolUse('t1'), resolved('p2', { turnBoundary: true } as Partial<ChatMessage>), toolUse('t2'), resolved('p3')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs.map(ids)).toEqual([['p1', 'p2']])
  })

  it('a prompt that names no tool groups with adjacent prompts or across thinking, never across a tool bubble', () => {
    const noTool = { tool: undefined, content: 'Permission required' }
    const apart = [resolved('p1', noTool), toolUse('t1', { tool: undefined }), resolved('p2', noTool)]
    expect(findResolvedPermissionRuns(rowsOf(apart), lookup(apart))).toEqual([])
    const adjacent = [resolved('p1', noTool), resolved('p2', noTool)]
    expect(findResolvedPermissionRuns(rowsOf(adjacent), lookup(adjacent))).toHaveLength(1)
    const thought = [resolved('p1', noTool), thinking('k1'), resolved('p2', noTool)]
    expect(findResolvedPermissionRuns(rowsOf(thought), lookup(thought))).toHaveLength(1)
  })

  it('tool bubbles before the first and after the last prompt are not part of the run', () => {
    const msgs = [toolUse('t0'), resolved('p1'), toolUse('t1'), resolved('p2'), toolUse('t2')]
    const runs = findResolvedPermissionRuns(rowsOf(msgs), lookup(msgs))
    expect(runs[0]!.indices).toEqual([1, 3])
  })

  it('an empty item (a synthetic row) between prompts breaks the run', () => {
    const msgs = [resolved('p1'), resolved('p2')]
    const rows = [{ id: 'p1' }, { id: 'summary' }, { id: 'p2' }]
    expect(findResolvedPermissionRuns(rows, lookup(msgs))).toEqual([])
  })
})
