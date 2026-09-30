import { describe, it, expect } from 'vitest'
import type { ExpiredPermissionTurnSummary } from '@chroxy/store-core'
import type { ChatViewMessage } from '../components/ChatView'
import {
  insertPermissionExpiredSummaryRows,
  permissionExpiredSummaryRowId,
} from './permissionExpiredSummaryRows'

function row(id: string, type: ChatViewMessage['type'], timestamp = 0): ChatViewMessage {
  return { id, type, content: '', timestamp }
}

function summary(over: Partial<ExpiredPermissionTurnSummary> = {}): ExpiredPermissionTurnSummary {
  return {
    turnStartMessageId: 'u1',
    requestIds: ['req-p1'],
    tools: ['Bash'],
    count: 1,
    ...over,
  }
}

describe('insertPermissionExpiredSummaryRows (#7365)', () => {
  it('returns rows unchanged and an empty payload map when there are no summaries', () => {
    const rows = [row('u1', 'user_input'), row('r1', 'response')]
    const result = insertPermissionExpiredSummaryRows(rows, [])
    expect(result.rows).toEqual(rows)
    expect(result.payloads.size).toBe(0)
  })

  it('appends the summary row at the end when the summarised turn is the last one', () => {
    const rows = [row('u1', 'user_input', 1), row('r1', 'response', 2)]
    const s = summary()
    const result = insertPermissionExpiredSummaryRows(rows, [s])
    const rowId = permissionExpiredSummaryRowId('u1')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', rowId])
    expect(result.rows[2]).toMatchObject({ type: 'permission-expired-summary', id: rowId })
    expect(result.payloads.get(rowId)).toEqual(s)
  })

  it('inserts the summary row BEFORE the next turn, not at the very end of the list', () => {
    const rows = [
      row('u1', 'user_input'),
      row('r1', 'response'),
      row('u2', 'user_input'),
      row('r2', 'response'),
    ]
    const s = summary({ turnStartMessageId: 'u1' })
    const result = insertPermissionExpiredSummaryRows(rows, [s])
    const rowId = permissionExpiredSummaryRowId('u1')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', rowId, 'u2', 'r2'])
  })

  it('supports one summary per qualifying turn, each attached to its own turn', () => {
    const rows = [
      row('u1', 'user_input'),
      row('r1', 'response'),
      row('u2', 'user_input'),
      row('r2', 'response'),
    ]
    const s1 = summary({ turnStartMessageId: 'u1', requestIds: ['req-a'] })
    const s2 = summary({ turnStartMessageId: 'u2', requestIds: ['req-b'] })
    const result = insertPermissionExpiredSummaryRows(rows, [s1, s2])
    const id1 = permissionExpiredSummaryRowId('u1')
    const id2 = permissionExpiredSummaryRowId('u2')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'r1', id1, 'u2', 'r2', id2])
    expect(result.payloads.get(id1)).toEqual(s1)
    expect(result.payloads.get(id2)).toEqual(s2)
  })

  it('inserts nothing for a turn with no matching summary', () => {
    const rows = [row('u1', 'user_input'), row('u2', 'user_input')]
    const s = summary({ turnStartMessageId: 'u2' })
    const result = insertPermissionExpiredSummaryRows(rows, [s])
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'u2', permissionExpiredSummaryRowId('u2')])
  })

  // #7365 review (Critical #1 follow-up) — a still-queued `user_input` must
  // not flush the currently-pending turn's summary early, or it would be
  // visually inserted BEFORE that turn's later content (which the aggregator
  // still, correctly, attributes to it).
  it('does not flush the pending summary at a still-queued user_input — it stays attached to the running turn\'s real end', () => {
    const rows = [
      row('u1', 'user_input'),
      row('p1', 'response'),
      row('u2', 'user_input'), // queued follow-up, not yet dequeued
      row('p2', 'response'),   // still turn 1's content
    ]
    const s = summary({ turnStartMessageId: 'u1', requestIds: ['req-p1', 'req-p2'], count: 2 })
    const result = insertPermissionExpiredSummaryRows(rows, [s], new Set(['u2']))
    const rowId = permissionExpiredSummaryRowId('u1')
    // The summary lands AFTER p2 (the turn's actual last content), not
    // squeezed in between p1 and the queued u2 row.
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'p1', 'u2', 'p2', rowId])
  })

  it('once the queued user_input is no longer in the still-queued set, it resumes acting as a real boundary', () => {
    const rows = [
      row('u1', 'user_input'),
      row('p1', 'response'),
      row('u2', 'user_input'), // now dequeued — a real turn boundary
      row('p2', 'response'),
    ]
    const s1 = summary({ turnStartMessageId: 'u1', requestIds: ['req-p1'] })
    const s2 = summary({ turnStartMessageId: 'u2', requestIds: ['req-p2'] })
    const result = insertPermissionExpiredSummaryRows(rows, [s1, s2], new Set())
    const id1 = permissionExpiredSummaryRowId('u1')
    const id2 = permissionExpiredSummaryRowId('u2')
    expect(result.rows.map((r) => r.id)).toEqual(['u1', 'p1', id1, 'u2', 'p2', id2])
  })
})
