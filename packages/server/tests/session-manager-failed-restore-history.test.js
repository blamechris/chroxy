import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionManager } from '../src/session-manager.js'
import { ServerFailedRestoreHistorySchema } from '@chroxy/protocol'

/**
 * #8860 — SessionManager.getFailedRestoreHistory(): a READ-ONLY page of a parked
 * failed restore's preserved history.
 *
 * It exists because a Codex session with no native resume locator can never be
 * restored (fail-closed, #8597) and the roster publishes only a count, so the
 * preserved transcript was unreachable. The claims pinned here:
 *   - paging is oldest-first and the limit/offset are clamped by the MANAGER
 *     (the enforcement point for any caller, not just the WS handler);
 *   - each entry is run through the persistence truncation, so a huge saved
 *     entry cannot make one reply unbounded, and `_seq` never leaves the server;
 *   - it is read-only: the parked entry, and the saved history, are untouched.
 */

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function makeHistory(n) {
  return Array.from({ length: n }, (_, i) => ({ type: 'message', messageType: 'user_input', content: `entry-${i}`, _seq: i + 1 }))
}

describe('SessionManager.getFailedRestoreHistory (#8860)', () => {
  let sm
  let dir

  afterEach(() => {
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function park(history) {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-failed-history-8860-'))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json'), providerType: 'claude-sdk' })
    const saved = { id: ID, name: 'Parked', cwd: dir, provider: 'codex', history }
    const err = new Error('native locator missing')
    err.code = 'CODEX_NATIVE_LOCATOR_MISSING'
    sm._failedRestores.set(ID, { saved, error: err })
    return saved
  }

  it('returns the first page oldest-first with the total, and a schema-valid shape', () => {
    park(makeHistory(120))
    const r = sm.getFailedRestoreHistory(ID)

    assert.equal(r.ok, true)
    assert.equal(r.total, 120)
    assert.equal(r.offset, 0)
    assert.equal(r.entries.length, 50, 'default page is 50')
    assert.equal(r.entries[0].content, 'entry-0', 'oldest first')
    assert.equal(r.entries[49].content, 'entry-49')
    assert.doesNotThrow(() => ServerFailedRestoreHistorySchema.parse({ type: 'failed_restore_history', sessionId: ID, ...r }))
  })

  it('pages with offset and returns a short final page', () => {
    park(makeHistory(120))
    const second = sm.getFailedRestoreHistory(ID, { offset: 50, limit: 50 })
    assert.equal(second.entries[0].content, 'entry-50')
    assert.equal(second.entries.length, 50)

    const last = sm.getFailedRestoreHistory(ID, { offset: 100, limit: 50 })
    assert.equal(last.entries.length, 20, 'short last page')
    assert.equal(last.entries[19].content, 'entry-119')

    const past = sm.getFailedRestoreHistory(ID, { offset: 500, limit: 50 })
    assert.equal(past.ok, true)
    assert.deepEqual(past.entries, [], 'an offset past the end is an empty page, not an error')
    assert.equal(past.total, 120)
  })

  it('clamps limit to 1..100 and offset to >= 0', () => {
    park(makeHistory(300))
    assert.equal(sm.getFailedRestoreHistory(ID, { limit: 100000 }).entries.length, 100, 'limit capped at 100')
    assert.equal(sm.getFailedRestoreHistory(ID, { limit: 0 }).entries.length, 1, 'limit floored at 1')
    assert.equal(sm.getFailedRestoreHistory(ID, { limit: -5 }).entries.length, 1)
    const neg = sm.getFailedRestoreHistory(ID, { offset: -10, limit: 2 })
    assert.equal(neg.offset, 0, 'negative offset clamps to 0')
    assert.equal(neg.entries[0].content, 'entry-0')
    // Non-numeric input takes the defaults rather than feeding NaN to slice.
    const junk = sm.getFailedRestoreHistory(ID, { offset: 'x', limit: 'y' })
    assert.equal(junk.offset, 0)
    assert.equal(junk.entries.length, 50)
    assert.equal(sm.getFailedRestoreHistory(ID, { limit: 2.9 }).entries.length, 2, 'fractional limit is truncated')
  })

  it('truncates a huge entry and drops _seq, without touching the saved history', () => {
    const huge = 'x'.repeat(120 * 1024)
    const saved = park([
      { type: 'message', messageType: 'response', content: huge, _seq: 7 },
      { type: 'tool_start', toolUseId: 't1', tool: 'Write', input: { content: huge }, _seq: 8 },
    ])
    const r = sm.getFailedRestoreHistory(ID)

    assert.ok(r.entries[0].content.length < 51 * 1024, 'string content is bounded')
    assert.ok(r.entries[0].content.endsWith('[truncated]'))
    assert.equal(r.entries[1].input._truncated, true, 'object input is bounded')
    for (const e of r.entries) assert.equal('_seq' in e, false, '_seq is server bookkeeping')
    // Read-only: the saved history still holds the full entry and its _seq.
    assert.equal(saved.history[0].content.length, huge.length)
    assert.equal(saved.history[0]._seq, 7)
  })

  // Codex review: a page goes out as ONE frame, and a page of large-but-valid
  // entries (50 x 50 KiB) buffered past ws-client-sender's 1 MiB eviction
  // threshold under permessage-deflate, closing the reader's own socket (4008).
  it('bounds a page by serialized size and still pages through every entry', () => {
    const big = 'y'.repeat(50 * 1024 - 64)
    park(Array.from({ length: 50 }, (_, i) => ({ type: 'message', messageType: 'response', content: `${i}:${big}` })))

    const first = sm.getFailedRestoreHistory(ID, { limit: 50 })
    assert.ok(first.entries.length >= 1 && first.entries.length < 50, `page stopped early (${first.entries.length})`)
    const pageBytes = Buffer.byteLength(JSON.stringify(first.entries))
    assert.ok(pageBytes <= 256 * 1024 + 1024, `page stays within the byte budget (${pageBytes})`)

    // Paging on `offset + entries.length`, as the dashboard does, reaches every entry once.
    const seen = []
    let offset = 0
    for (let guard = 0; guard < 100 && offset < 50; guard++) {
      const page = sm.getFailedRestoreHistory(ID, { offset, limit: 50 })
      assert.ok(page.entries.length >= 1, 'a page never comes back empty before the end')
      seen.push(...page.entries.map((e) => Number(e.content.split(':')[0])))
      offset += page.entries.length
    }
    assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => i))
  })

  it('shortens a single entry that is alone too big, and never returns an empty page for it', () => {
    // truncateEntry caps content and input, not a tool_result's `result`.
    park([{ type: 'tool_result', toolUseId: 't1', result: 'z'.repeat(2 * 1024 * 1024) }])
    const r = sm.getFailedRestoreHistory(ID)
    assert.equal(r.entries.length, 1)
    assert.ok(Buffer.byteLength(JSON.stringify(r.entries[0])) <= 64 * 1024, 'entry within the per-entry cap')
    assert.ok(r.entries[0].result.endsWith('[truncated]'))
  })

  it('strips the server-only fields that history replay strips', () => {
    park([{ type: 'user_question', toolUseId: 'q1', questions: [], sourceToolUseId: 'tool-1', answered: true }])
    const [entry] = sm.getFailedRestoreHistory(ID).entries
    assert.equal(entry.type, 'user_question')
    assert.equal('sourceToolUseId' in entry, false)
    assert.equal('answered' in entry, false)
  })

  it('keeps index alignment for a non-object slot instead of dropping it', () => {
    park([{ type: 'message', content: 'a' }, null, 'junk', { type: 'message', content: 'b' }])
    const r = sm.getFailedRestoreHistory(ID)
    assert.equal(r.total, 4)
    assert.equal(r.entries.length, 4, 'offset + entries.length stays the next page start')
    assert.deepEqual(r.entries[1], { type: 'unknown' })
    assert.deepEqual(r.entries[2], { type: 'unknown' })
  })

  it('returns an empty page for an entry with no history array', () => {
    park(undefined)
    const r = sm.getFailedRestoreHistory(ID)
    assert.equal(r.ok, true)
    assert.equal(r.total, 0)
    assert.deepEqual(r.entries, [])
  })

  it('returns FAILED_RESTORE_NOT_FOUND for an unknown id', () => {
    park(makeHistory(3))
    const r = sm.getFailedRestoreHistory('does-not-exist')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'FAILED_RESTORE_NOT_FOUND')
  })

  it('does not unpark or alter the entry', () => {
    park(makeHistory(3))
    sm.getFailedRestoreHistory(ID, { offset: 1, limit: 1 })
    assert.ok(sm._failedRestores.has(ID), 'still parked')
    assert.equal(sm._failedRestores.get(ID).saved.history.length, 3)
    assert.equal(sm.getFailedRestores()[0].historyLength, 3)
  })
})
