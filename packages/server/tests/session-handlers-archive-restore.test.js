import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { nsCtx } from './test-helpers.js'
import { ServerRestoreArchivedSessionResultSchema, ClientMessageSchema } from '@chroxy/protocol'

/**
 * #8866 restore_archived_session: authority + wiring. As for the other archive
 * messages, the bound-client refusal is asserted against the ORDER the
 * bearer-token doc requires: it must happen before the manager is consulted (a
 * refusal after the lookup is an existence oracle even when the reply looks the same).
 */

const ID = 'a'.repeat(32)
const UNBOUND = { boundSessionId: null }
const BOUND = { boundSessionId: 'b'.repeat(32) }
const EMPTY_STRING_BOUND = { boundSessionId: '' }

function makeCtx(result = { ok: true, mode: 'native', sessionId: 'live-1' }) {
  const sent = []
  const calls = { restore: [], broadcast: 0 }
  const ctx = nsCtx({
    sessionManager: {
      restoreArchivedSession: async (archiveId, mode) => { calls.restore.push({ archiveId, mode }); return result },
    },
    transport: { send: (_ws, msg) => sent.push(msg), broadcastSessionList: () => { calls.broadcast++ } },
  })
  return { ctx, sent, calls }
}
const run = (client, msg, ctx) => sessionHandlers.restore_archived_session({}, client, { type: 'restore_archived_session', ...msg }, ctx)

describe('restore_archived_session', () => {
  it('refuses a bound client (an empty-string binding counts: fail-safe) WITHOUT consulting the manager, with a degraded schema-valid reply', async () => {
    for (const client of [BOUND, EMPTY_STRING_BOUND]) {
      const { ctx, sent, calls } = makeCtx()
      await run(client, { archiveId: ID, mode: 'native' }, ctx)
      assert.equal(calls.restore.length, 0, 'the manager was never consulted')
      assert.equal(calls.broadcast, 0)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'restore_archived_session_result')
      assert.equal(sent[0].ok, false)
      assert.equal(sent[0].refused, true)
      assert.equal(sent[0].code, 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT')
      assert.doesNotThrow(() => ServerRestoreArchivedSessionResultSchema.parse(sent[0]))
    }
  })

  it('refuses a bound client even when the id and mode are garbage (the gate runs before validation)', async () => {
    const { ctx, sent, calls } = makeCtx()
    await run(BOUND, { archiveId: 42, mode: 'fork' }, ctx)
    assert.equal(sent[0].code, 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT')
    assert.equal(calls.restore.length, 0)
  })

  it('an unbound client reaches the manager with exactly the archiveId and mode, and a success announces the new session', async () => {
    const { ctx, sent, calls } = makeCtx({ ok: true, mode: 'new_thread', sessionId: 'new-1', seed: { messagesIncluded: 2, messagesTotal: 3, bytes: 100 } })
    await run(UNBOUND, { archiveId: ID, mode: 'new_thread' }, ctx)
    assert.deepEqual(calls.restore, [{ archiveId: ID, mode: 'new_thread' }])
    assert.equal(calls.broadcast, 1, 'every client is told about the new session')
    assert.equal(sent[0].ok, true)
    assert.equal(sent[0].archiveId, ID)
    assert.equal(sent[0].mode, 'new_thread')
    assert.equal(sent[0].sessionId, 'new-1')
    assert.deepEqual(sent[0].seed, { messagesIncluded: 2, messagesTotal: 3, bytes: 100 })
    assert.doesNotThrow(() => ServerRestoreArchivedSessionResultSchema.parse(sent[0]))
  })

  it('a refusal from the manager is relayed with its code and message and announces nothing', async () => {
    const { ctx, sent, calls } = makeCtx({ ok: false, mode: 'native', code: 'ARCHIVE_RESTORE_LOCATOR_MISSING', message: 'no transcript' })
    await run(UNBOUND, { archiveId: ID, mode: 'native' }, ctx)
    assert.equal(calls.broadcast, 0)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'ARCHIVE_RESTORE_LOCATOR_MISSING')
    assert.equal(sent[0].message, 'no transcript')
    assert.equal(sent[0].sessionId, undefined)
  })

  it('a native restore whose start failed carries the re-parked id and still refreshes the list', async () => {
    const { ctx, sent, calls } = makeCtx({ ok: false, mode: 'native', code: 'START_FAILED', message: 'pty died', sessionId: 'parked-1' })
    await run(UNBOUND, { archiveId: ID, mode: 'native' }, ctx)
    assert.equal(sent[0].sessionId, 'parked-1')
    assert.equal(calls.broadcast, 1)
  })

  it('rejects a missing archiveId or an unknown mode without consulting the manager', async () => {
    for (const msg of [{ mode: 'native' }, { archiveId: ID }, { archiveId: ID, mode: 'fork' }, { archiveId: '', mode: 'native' }]) {
      const { ctx, sent, calls } = makeCtx()
      await run(UNBOUND, msg, ctx)
      assert.equal(calls.restore.length, 0)
      assert.equal(sent[0].code, 'ARCHIVED_SESSION_INVALID')
      assert.doesNotThrow(() => ServerRestoreArchivedSessionResultSchema.parse(sent[0]))
    }
  })

  it('the protocol schema accepts exactly the two modes', () => {
    assert.equal(ClientMessageSchema.safeParse({ type: 'restore_archived_session', archiveId: ID, mode: 'native' }).success, true)
    assert.equal(ClientMessageSchema.safeParse({ type: 'restore_archived_session', archiveId: ID, mode: 'new_thread' }).success, true)
    assert.equal(ClientMessageSchema.safeParse({ type: 'restore_archived_session', archiveId: ID, mode: 'fork' }).success, false)
    assert.equal(ClientMessageSchema.safeParse({ type: 'restore_archived_session', mode: 'native' }).success, false)
  })
})
