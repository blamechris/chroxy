/**
 * The pure history-view rules shared by the failed-restore and archive maps.
 * Each has a control so a guard that denies (or admits) everything cannot pass.
 */
import { describe, it, expect } from 'vitest'
import {
  applyHistoryReply, beginHistoryRequest, pruneHistoryViews, settleHistoryViewsOnDrop,
  type HistoryViewMap,
} from './history-views'

const e = (n: number) => ({ type: 'message', content: `m${n}` })
const waiting = (offset: number, entries: unknown[] = []): HistoryViewMap => ({
  a: { entries: entries as never, total: entries.length || null, loading: true, pendingOffset: offset },
})

describe('beginHistoryRequest', () => {
  it('starts at 0, extends from entries.length, and refuses while loading', () => {
    expect(beginHistoryRequest({}, 'a', false)?.offset).toBe(0)
    const done: HistoryViewMap = { a: { entries: [e(0), e(1)] as never, total: 9, loading: false, pendingOffset: null } }
    expect(beginHistoryRequest(done, 'a', true)?.offset).toBe(2)
    expect(beginHistoryRequest(done, 'a', false)?.views.a).toMatchObject({ entries: [], total: null })
    expect(beginHistoryRequest(waiting(0), 'a', true)).toBeNull()
  })
})

describe('applyHistoryReply', () => {
  it('applies a matching page; drops a mismatched offset, a missing view and a bad id', () => {
    expect(applyHistoryReply(waiting(0), 'a', { ok: true, offset: 0, total: 5, entries: [e(0)] })?.a?.entries).toHaveLength(1)
    expect(applyHistoryReply(waiting(0), 'a', { ok: true, offset: 3, entries: [e(0)] })).toBeNull()
    expect(applyHistoryReply(waiting(0), 'zzz', { ok: true, entries: [] })).toBeNull()
    expect(applyHistoryReply(waiting(0), '', { ok: true, entries: [] })).toBeNull()
    expect(applyHistoryReply(waiting(0), undefined, { ok: true, entries: [] })).toBeNull()
  })

  it('drops an offset-less reply to a view that is NOT waiting (the offset check cannot cover it)', () => {
    const idle: HistoryViewMap = { a: { entries: [e(0)] as never, total: 1, loading: false, pendingOffset: null } }
    expect(applyHistoryReply(idle, 'a', { ok: true, total: 2, entries: [e(1)] })).toBeNull()
    expect(applyHistoryReply(idle, 'a', { ok: false, code: 'X' })).toBeNull()
  })

  it('treats an absent offset as acceptable and captures a failure as an error', () => {
    expect(applyHistoryReply(waiting(0), 'a', { ok: true, total: 1, entries: [e(0)] })).not.toBeNull()
    const failed = applyHistoryReply(waiting(0), 'a', { ok: false, refused: true, code: 'C', message: 'm' })
    expect(failed?.a?.error).toEqual({ code: 'C', message: 'm', refused: true })
  })
})

describe('settleHistoryViewsOnDrop / pruneHistoryViews', () => {
  it('settles only pending views; null when nothing was pending', () => {
    const idle: HistoryViewMap = { a: { entries: [], total: 0, loading: false, pendingOffset: null } }
    expect(settleHistoryViewsOnDrop(idle)).toBeNull()
    expect(settleHistoryViewsOnDrop(waiting(0))?.a?.error?.code).toBe('CONNECTION_LOST')
  })

  it('prune keeps the same reference when nothing is dropped', () => {
    const v = waiting(0)
    expect(pruneHistoryViews(v, new Set(['a']))).toBe(v)
    expect(pruneHistoryViews(v, new Set(['b']))).toEqual({})
  })
})
