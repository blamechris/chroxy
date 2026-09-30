import { describe, it, expect } from 'vitest'
import type { ChatMessage, ExpiredPermissionTurnSummary } from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'
import {
  insertPermissionExpiredSummaryRows,
  permissionExpiredSummaryRowId,
  resolveAnchorRowId,
} from './permissionExpiredSummaryRows'

function row(id: string, type: ChatViewMessage['type'], timestamp = 0): ChatViewMessage {
  return { id, type, content: '', timestamp }
}

function rawMsg(id: string, type: ChatMessage['type'] = 'response'): ChatMessage {
  return { id, type, content: '', timestamp: 0 }
}

function summary(over: Partial<ExpiredPermissionTurnSummary> = {}): ExpiredPermissionTurnSummary {
  return {
    turnEndMessageId: 'r1',
    requestIds: ['req-p1'],
    tools: ['Bash'],
    count: 1,
    ...over,
  }
}

describe('resolveAnchorRowId (#7365 review round 2)', () => {
  it('resolves directly when the raw message has its own row', () => {
    const storeMessages = [rawMsg('u1'), rawMsg('r1')]
    const rowIdSet = new Set(['u1', 'r1'])
    expect(resolveAnchorRowId('r1', storeMessages, rowIdSet, new Map())).toBe('r1')
  })

  it('resolves to the enclosing tool_group key when the raw message was absorbed into a group', () => {
    const storeMessages = [rawMsg('u1'), rawMsg('t1', 'tool_use'), rawMsg('t2', 'tool_use')]
    const rowIdSet = new Set(['u1', 'activity-t1'])
    const payloads = new Map([['activity-t1', { messages: [storeMessages[1]!, storeMessages[2]!], isActive: false }]])
    // t2 (the turn's actual last message) has no row of its own — it's inside the group.
    expect(resolveAnchorRowId('t2', storeMessages, rowIdSet, payloads)).toBe('activity-t1')
  })

  it('walks BACKWARD to the nearest resolvable row when the raw message itself was filtered (a system row)', () => {
    const storeMessages = [rawMsg('u1'), rawMsg('r1'), rawMsg('s1', 'system')]
    // s1 never gets a row (system events are filtered before the chat pipeline).
    const rowIdSet = new Set(['u1', 'r1'])
    expect(resolveAnchorRowId('s1', storeMessages, rowIdSet, new Map())).toBe('r1')
  })

  it('returns null when nothing in the prefix resolves (degenerate)', () => {
    const storeMessages = [rawMsg('s1', 'system')]
    const rowIdSet = new Set<string>()
    expect(resolveAnchorRowId('s1', storeMessages, rowIdSet, new Map())).toBeNull()
  })

  it('returns null when the raw id is not found in storeMessages at all', () => {
    expect(resolveAnchorRowId('missing', [rawMsg('u1')], new Set(['u1']), new Map())).toBeNull()
  })
})

describe('insertPermissionExpiredSummaryRows (#7365)', () => {
  it('returns rows unchanged and an empty payload map when there are no summaries', () => {
    const rows = [row('u1', 'user_input'), row('r1', 'response')]
    const result = insertPermissionExpiredSummaryRows(rows, [], [], new Map())
    expect(result.rows).toEqual(rows)
    expect(result.payloads.size).toBe(0)
  })

  it('inserts the summary row immediately after its anchor (exact match)', () => {
    const rows = [row('u1', 'user_input', 1), row('r1', 'response', 2), row('u2', 'user_input', 3)]
    const storeMessages = [rawMsg('u1', 'user_input'), rawMsg('r1'), rawMsg('u2', 'user_input')]
    const s = summary({ turnEndMessageId: 'r1' })
    const result = insertPermissionExpiredSummaryRows(rows, [s], storeMessages, new Map())
    const rowId = permissionExpiredSummaryRowId('r1')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', rowId, 'u2'])
    expect(result.payloads.get(rowId)).toEqual(s)
  })

  it('inserts after the enclosing tool_group row when the anchor message was collapsed into one', () => {
    const rows = [row('u1', 'user_input'), row('activity-t1', 'tool_group')]
    const t1 = rawMsg('t1', 'tool_use')
    const t2 = rawMsg('t2', 'tool_use')
    const storeMessages = [rawMsg('u1', 'user_input'), t1, t2]
    const chatToolGroupPayloads = new Map([['activity-t1', { messages: [t1, t2], isActive: false }]])
    const s = summary({ turnEndMessageId: 't2' })
    const result = insertPermissionExpiredSummaryRows(rows, [s], storeMessages, chatToolGroupPayloads)
    const rowId = permissionExpiredSummaryRowId('activity-t1')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'activity-t1', rowId])
  })

  it('inserts after the nearest preceding row when the anchor message itself was filtered (system)', () => {
    const rows = [row('u1', 'user_input'), row('r1', 'response')]
    const storeMessages = [rawMsg('u1', 'user_input'), rawMsg('r1'), rawMsg('s1', 'system')]
    const s = summary({ turnEndMessageId: 's1' })
    const result = insertPermissionExpiredSummaryRows(rows, [s], storeMessages, new Map())
    const rowId = permissionExpiredSummaryRowId('r1')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', rowId])
  })

  it('appends the trailing (still-open) turn\'s summary at the very end', () => {
    const rows = [row('u1', 'user_input', 1), row('r1', 'response', 2)]
    const storeMessages = [rawMsg('u1', 'user_input'), rawMsg('r1')]
    const s = summary({ turnEndMessageId: null })
    const result = insertPermissionExpiredSummaryRows(rows, [s], storeMessages, new Map())
    const rowId = permissionExpiredSummaryRowId('__current_turn__')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', rowId])
    expect(result.payloads.get(rowId)).toEqual(s)
  })

  it('supports one summary per completed turn plus a trailing one, each at its own anchor', () => {
    const rows = [row('u1', 'user_input'), row('r1', 'response'), row('u2', 'user_input'), row('r2', 'response')]
    const storeMessages = [rawMsg('u1', 'user_input'), rawMsg('r1'), rawMsg('u2', 'user_input'), rawMsg('r2')]
    const s1 = summary({ turnEndMessageId: 'r1', requestIds: ['req-a'] })
    const s2 = summary({ turnEndMessageId: null, requestIds: ['req-b'] })
    const result = insertPermissionExpiredSummaryRows(rows, [s1, s2], storeMessages, new Map())
    const id1 = permissionExpiredSummaryRowId('r1')
    const id2 = permissionExpiredSummaryRowId('__current_turn__')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', id1, 'u2', 'r2', id2])
    expect(result.payloads.get(id1)).toEqual(s1)
    expect(result.payloads.get(id2)).toEqual(s2)
  })

  it('drops (does not crash on) a summary whose anchor resolves to nothing at all', () => {
    const rows = [row('u1', 'user_input')]
    const storeMessages = [rawMsg('s1', 'system')] // the only raw message is filtered, never even a `u1` predecessor
    const s = summary({ turnEndMessageId: 's1' })
    const result = insertPermissionExpiredSummaryRows(rows, [s], storeMessages, new Map())
    expect(result.rows).toEqual(rows)
    expect(result.payloads.size).toBe(0)
  })
})
