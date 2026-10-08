import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'
import { collapseResolvedPermissionRuns, permissionGroupRowId } from './permissionGroupRows'

/**
 * #6894 -- splice a synthetic `permission-group` row in place of each run of
 * adjacent identical RESOLVED permission prompt rows. Pending prompts and every
 * other row are untouched.
 */

function resolved(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'prompt',
    content: 'shell: Do you want to allow npm registry lookup?',
    tool: 'shell',
    requestId: `req-${id}`,
    answered: 'allow',
    answeredAt: 1,
    timestamp: Number(id.replace(/\D/g, '')) || 0,
    ...over,
  } as ChatMessage
}
const pending = (id: string) => resolved(id, { answered: undefined, answeredAt: undefined, expiresAt: Date.now() + 60_000 })

const rowOf = (m: ChatMessage): ChatViewMessage => ({ id: m.id, type: 'response', content: m.content, timestamp: m.timestamp })
const mapOf = (msgs: ChatMessage[]) => new Map(msgs.map((m) => [m.id, m]))

describe('collapseResolvedPermissionRuns (#6894)', () => {
  it('replaces a run of identical resolved prompts with one group row', () => {
    const msgs = [resolved('p1'), resolved('p2'), resolved('p3')]
    const { rows, groups } = collapseResolvedPermissionRuns(msgs.map(rowOf), mapOf(msgs))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.type).toBe('permission-group')
    expect(row.id).toBe(permissionGroupRowId('p1'))
    expect(groups.get(row.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('gives the group row the description text (so in-session find matches it) and the first member timestamp (its position)', () => {
    const msgs = [resolved('p1'), resolved('p9')]
    const { rows } = collapseResolvedPermissionRuns(msgs.map(rowOf), mapOf(msgs))
    expect(rows[0]!.content).toBe(msgs[0]!.content)
    expect(rows[0]!.timestamp).toBe(msgs[0]!.timestamp)
  })

  it('leaves a lone resolved prompt as its own row', () => {
    const msgs = [resolved('p1')]
    const { rows, groups } = collapseResolvedPermissionRuns(msgs.map(rowOf), mapOf(msgs))
    expect(rows.map((r) => r.id)).toEqual(['p1'])
    expect(groups.size).toBe(0)
  })

  it('never folds a PENDING prompt into a group; every pending approval stays its own row', () => {
    const msgs = [resolved('p1'), resolved('p2'), pending('p3'), pending('p4'), resolved('p5')]
    const { rows, groups } = collapseResolvedPermissionRuns(msgs.map(rowOf), mapOf(msgs))
    expect(rows.map((r) => r.id)).toEqual([permissionGroupRowId('p1'), 'p3', 'p4', 'p5'])
    expect(groups.get(permissionGroupRowId('p1'))).toEqual(['p1', 'p2'])
  })

  it('a different command breaks the group into two', () => {
    const other = { content: 'shell: a different request' }
    const msgs = [resolved('p1'), resolved('p2'), resolved('p3', other), resolved('p4', other)]
    const { rows, groups } = collapseResolvedPermissionRuns(msgs.map(rowOf), mapOf(msgs))
    expect(rows.map((r) => r.id)).toEqual([permissionGroupRowId('p1'), permissionGroupRowId('p3')])
    expect(groups.get(permissionGroupRowId('p3'))).toEqual(['p3', 'p4'])
  })

  it('keeps unrelated rows around a run in order', () => {
    const msgs = [resolved('p1'), resolved('p2')]
    const before: ChatViewMessage = { id: 'u1', type: 'user_input', content: 'go', timestamp: 0 }
    const after: ChatViewMessage = { id: 'r1', type: 'response', content: 'done', timestamp: 9 }
    const map = mapOf(msgs)
    map.set('u1', { id: 'u1', type: 'user_input', content: 'go', timestamp: 0 } as ChatMessage)
    map.set('r1', { id: 'r1', type: 'response', content: 'done', timestamp: 9 } as ChatMessage)
    const { rows } = collapseResolvedPermissionRuns([before, ...msgs.map(rowOf), after], map)
    expect(rows.map((r) => r.id)).toEqual(['u1', permissionGroupRowId('p1'), 'r1'])
  })

  it('a synthetic row between two identical prompts (a turn summary) separates them', () => {
    const msgs = [resolved('p1'), resolved('p2')]
    const summary: ChatViewMessage = { id: 'permission-expired-summary-r1', type: 'permission-expired-summary', content: '', timestamp: 0 }
    const { rows, groups } = collapseResolvedPermissionRuns([rowOf(msgs[0]!), summary, rowOf(msgs[1]!)], mapOf(msgs))
    expect(rows.map((r) => r.id)).toEqual(['p1', 'permission-expired-summary-r1', 'p2'])
    expect(groups.size).toBe(0)
  })

  it('returns the SAME array when nothing groups (referential stability for memoised callers)', () => {
    const msgs = [resolved('p1'), pending('p2')]
    const input = msgs.map(rowOf)
    const { rows } = collapseResolvedPermissionRuns(input, mapOf(msgs))
    expect(rows).toBe(input)
  })

  it('the group row id is stable when later identical prompts join the run', () => {
    const two = [resolved('p1'), resolved('p2')]
    const three = [...two, resolved('p3')]
    const a = collapseResolvedPermissionRuns(two.map(rowOf), mapOf(two)).rows[0]!.id
    const b = collapseResolvedPermissionRuns(three.map(rowOf), mapOf(three)).rows[0]!.id
    expect(a).toBe(b)
  })
})

// #6894 smoke: a real turn is `tool bubble / permission record` pairs, so the
// identical prompts are separated by the tool runs they approved.
describe('collapseResolvedPermissionRuns -- interleaved with tool bubbles (#6894)', () => {
  const tool = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    type: 'tool_use',
    content: 'touch smoke-perm.txt',
    tool: 'shell',
    toolUseId: `tu-${id}`,
    timestamp: Number(id.replace(/\D/g, '')) || 0,
    ...over,
  } as ChatMessage)
  const toolRow = (m: ChatMessage): ChatViewMessage => ({ id: m.id, type: 'tool_use', content: m.content, timestamp: m.timestamp })

  it('puts the group at the FIRST prompt, drops the later prompts and leaves every tool bubble in place', () => {
    const msgs = [tool('t1'), resolved('p2'), tool('t3'), resolved('p4'), tool('t5'), resolved('p6')]
    const input = msgs.map((m) => (m.type === 'tool_use' ? toolRow(m) : rowOf(m)))
    const { rows, groups } = collapseResolvedPermissionRuns(input, mapOf(msgs))
    expect(rows.map((r) => r.id)).toEqual(['t1', permissionGroupRowId('p2'), 't3', 't5'])
    expect(groups.get(permissionGroupRowId('p2'))).toEqual(['p2', 'p4', 'p6'])
  })

  it('works prompt-first too (P T P T P) and keeps the trailing tool bubble', () => {
    const msgs = [resolved('p1'), tool('t2'), resolved('p3'), tool('t4'), resolved('p5'), tool('t6')]
    const input = msgs.map((m) => (m.type === 'tool_use' ? toolRow(m) : rowOf(m)))
    const { rows } = collapseResolvedPermissionRuns(input, mapOf(msgs))
    expect(rows.map((r) => r.id)).toEqual([permissionGroupRowId('p1'), 't2', 't4', 't6'])
  })

  it('sees through a collapsed tool_group row of the same tool via its payload', () => {
    const t2 = tool('t2')
    const t3 = tool('t3')
    const msgs = [resolved('p1'), t2, t3, resolved('p4')]
    const input: ChatViewMessage[] = [
      rowOf(msgs[0]!),
      { id: 'activity-t2', type: 'tool_group', content: '', timestamp: 3 },
      rowOf(msgs[3]!),
    ]
    const payloads = new Map([['activity-t2', { messages: [t2, t3], isActive: false }]])
    const { rows } = collapseResolvedPermissionRuns(input, mapOf(msgs), payloads)
    expect(rows.map((r) => r.id)).toEqual([permissionGroupRowId('p1'), 'activity-t2'])
  })

  it('an assistant text block, a pending prompt, a different tool or a different command keeps the prompts apart', () => {
    const text = { id: 'r1', type: 'response', content: 'ok', timestamp: 0 } as ChatMessage
    const cases: ChatMessage[][] = [
      [resolved('p1'), tool('t2'), text, tool('t3'), resolved('p4')],
      [resolved('p1'), tool('t2'), pending('p3'), tool('t4'), resolved('p5')],
      [resolved('p1'), tool('t2', { tool: 'Read' }), resolved('p3')],
      [resolved('p1'), tool('t2'), resolved('p3', { content: 'shell: another request' })],
    ]
    for (const msgs of cases) {
      const input = msgs.map((m) => (m.type === 'tool_use' ? toolRow(m) : rowOf(m)))
      const { rows, groups } = collapseResolvedPermissionRuns(input, mapOf(msgs))
      expect(groups.size, msgs.map((m) => m.id).join(',')).toBe(0)
      expect(rows).toBe(input)
    }
  })
})
