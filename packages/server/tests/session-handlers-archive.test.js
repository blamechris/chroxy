import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { nsCtx } from './test-helpers.js'
import {
  ServerArchivedSessionsListSchema,
  ServerArchivedSessionHistorySchema,
  ServerDeleteArchivedSessionResultSchema,
  ClientMessageSchema,
} from '@chroxy/protocol'

/**
 * Session archive WS handlers: authority + wiring.
 *
 * As for the failed-restore handlers, each bound-client refusal is asserted
 * against the ORDER the bearer-token doc requires, not just the outcome: a
 * refusal after the lookup is an existence oracle even when its reply looks
 * identical. So every refusal below proves the SessionManager was never
 * consulted.
 */

const ID = 'a'.repeat(32)
const ROW = {
  archiveId: ID,
  sessionId: 'sess-1',
  name: 'Secret Project Session',
  provider: 'codex',
  cwd: '/home/user/secret-project',
  model: null,
  reason: 'closed',
  archivedAt: 1,
  lastActivityAt: 1,
  createdAt: 1,
  historyLength: 4,
  bytes: 100,
}
const POLICY = { enabled: true, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 }

function makeCtx({
  historyResult = { ok: true, total: 1, offset: 0, entries: [{ type: 'message', content: 'secret transcript' }] },
  deleteResult = 'deleted',
  deleteAllResult = { deleted: 3, failed: 0 },
} = {}) {
  const sent = []
  const calls = { list: 0, history: 0, historyArgs: null, delete: 0, deleteArgs: null, deleteAll: 0 }
  const ctx = nsCtx({
    sessionManager: {
      listArchivedSessions: () => { calls.list++; return { policy: POLICY, sessions: [ROW] } },
      getArchivedSessionHistory: (id, opts) => { calls.history++; calls.historyArgs = { id, opts }; return historyResult },
      deleteArchivedSession: (id) => { calls.delete++; calls.deleteArgs = id; return deleteResult },
      deleteAllArchivedSessions: () => { calls.deleteAll++; return deleteAllResult },
    },
    transport: { send: (_ws, msg) => sent.push(msg) },
  })
  return { ctx, sent, calls }
}

const UNBOUND = { boundSessionId: null }
const BOUND = { boundSessionId: 'b'.repeat(32) }
const EMPTY_STRING_BOUND = { boundSessionId: '' }

const consulted = (calls) => calls.list + calls.history + calls.delete + calls.deleteAll

describe('list_archived_sessions', () => {
  it('returns the roster and policy to an unbound client', async () => {
    const { ctx, sent, calls } = makeCtx()
    sessionHandlers.list_archived_sessions({}, UNBOUND, { type: 'list_archived_sessions' }, ctx)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'archived_sessions_list')
    assert.deepEqual(sent[0].sessions, [ROW])
    assert.deepEqual(sent[0].policy, POLICY)
    assert.equal(sent[0].refused, undefined)
    assert.equal(calls.list, 1)
    assert.doesNotThrow(() => ServerArchivedSessionsListSchema.parse(sent[0]))
  })

  it('refuses a bound client WITHOUT consulting the manager, and leaks no host metadata', async () => {
    for (const client of [BOUND, EMPTY_STRING_BOUND]) {
      const { ctx, sent, calls } = makeCtx()
      sessionHandlers.list_archived_sessions({}, client, { type: 'list_archived_sessions' }, ctx)

      assert.equal(sent.length, 1)
      assert.equal(sent[0].refused, true)
      assert.equal(sent[0].code, 'ARCHIVED_SESSIONS_LIST_FORBIDDEN_BOUND_CLIENT')
      assert.deepEqual(sent[0].sessions, [])
      assert.equal(JSON.stringify(sent[0]).includes('secret-project'), false)
      assert.equal(consulted(calls), 0, "refused before any manager lookup ('' counts as bound, #7595)")
      assert.doesNotThrow(() => ServerArchivedSessionsListSchema.parse(sent[0]))
    }
  })
})

describe('get_archived_session_history', () => {
  const MSG = { type: 'get_archived_session_history', archiveId: ID, offset: 50, limit: 25 }

  it('returns the page to an unbound client, forwarding offset and limit', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_archived_session_history({}, UNBOUND, MSG, ctx)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'archived_session_history')
    assert.equal(sent[0].archiveId, ID)
    assert.equal(sent[0].ok, true)
    assert.equal(sent[0].entries[0].content, 'secret transcript')
    assert.deepEqual(calls.historyArgs, { id: ID, opts: { offset: 50, limit: 25 } })
    assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse(sent[0]))
  })

  it('refuses a bound client WITHOUT consulting the manager, and leaks no transcript', async () => {
    for (const client of [BOUND, EMPTY_STRING_BOUND]) {
      const { ctx, sent, calls } = makeCtx()
      await sessionHandlers.get_archived_session_history({}, client, MSG, ctx)

      assert.equal(sent[0].ok, false)
      assert.equal(sent[0].refused, true)
      assert.equal(sent[0].code, 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT')
      assert.equal(sent[0].entries, undefined)
      assert.equal(JSON.stringify(sent[0]).includes('secret transcript'), false)
      assert.equal(consulted(calls), 0)
      assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse(sent[0]))
    }
  })

  it('refuses a bound client even when the archiveId is missing (no validation oracle)', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_archived_session_history({}, BOUND, { type: 'get_archived_session_history' }, ctx)
    assert.equal(sent[0].code, 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT')
    assert.equal(consulted(calls), 0)
    assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse(sent[0]))
  })

  it('rejects a missing archiveId from an unbound client without a lookup', async () => {
    for (const msg of [{ type: 'get_archived_session_history' }, { type: 'get_archived_session_history', archiveId: 42 }, { type: 'get_archived_session_history', archiveId: '' }]) {
      const { ctx, sent, calls } = makeCtx()
      await sessionHandlers.get_archived_session_history({}, UNBOUND, msg, ctx)
      assert.equal(sent[0].ok, false)
      assert.equal(sent[0].code, 'ARCHIVED_SESSION_INVALID')
      assert.equal(consulted(calls), 0)
      assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse(sent[0]))
    }
  })

  it('forwards the manager not-found result as a schema-valid reply', async () => {
    const { ctx, sent } = makeCtx({ historyResult: { ok: false, code: 'ARCHIVED_SESSION_NOT_FOUND', message: 'gone' } })
    await sessionHandlers.get_archived_session_history({}, UNBOUND, MSG, ctx)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'ARCHIVED_SESSION_NOT_FOUND')
    assert.doesNotThrow(() => ServerArchivedSessionHistorySchema.parse(sent[0]))
  })
})

describe('delete_archived_session', () => {
  it('deletes one record for an unbound client', async () => {
    const { ctx, sent, calls } = makeCtx()
    sessionHandlers.delete_archived_session({}, UNBOUND, { type: 'delete_archived_session', archiveId: ID }, ctx)

    assert.deepEqual(sent, [{ type: 'delete_archived_session_result', ok: true, deleted: 1, archiveId: ID }])
    assert.equal(calls.delete, 1)
    assert.equal(calls.deleteArgs, ID)
    assert.equal(calls.deleteAll, 0)
    assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
  })

  it('deletes everything for all: true and reports the count', async () => {
    const { ctx, sent, calls } = makeCtx()
    sessionHandlers.delete_archived_session({}, UNBOUND, { type: 'delete_archived_session', all: true }, ctx)

    assert.deepEqual(sent, [{ type: 'delete_archived_session_result', ok: true, deleted: 3 }])
    assert.equal(calls.deleteAll, 1)
    assert.equal(calls.delete, 0)
    assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
  })

  it('reports NOT_FOUND (ok: false, deleted: 0) for an unknown id', async () => {
    const { ctx, sent } = makeCtx({ deleteResult: 'not_found' })
    sessionHandlers.delete_archived_session({}, UNBOUND, { type: 'delete_archived_session', archiveId: ID }, ctx)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].deleted, 0)
    assert.equal(sent[0].code, 'ARCHIVED_SESSION_NOT_FOUND')
    assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
  })

  it('reports a FAILED single delete as ARCHIVED_SESSION_DELETE_FAILED, not NOT_FOUND', async () => {
    const { ctx, sent } = makeCtx({ deleteResult: 'failed' })
    sessionHandlers.delete_archived_session({}, UNBOUND, { type: 'delete_archived_session', archiveId: ID }, ctx)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].deleted, 0)
    assert.equal(sent[0].archiveId, ID)
    assert.equal(sent[0].code, 'ARCHIVED_SESSION_DELETE_FAILED')
    assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
  })

  it('reports a PARTIAL delete-all as ok:false with the count that did go', async () => {
    const { ctx, sent } = makeCtx({ deleteAllResult: { deleted: 2, failed: 1 } })
    sessionHandlers.delete_archived_session({}, UNBOUND, { type: 'delete_archived_session', all: true }, ctx)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].deleted, 2)
    assert.equal(sent[0].code, 'ARCHIVED_SESSIONS_DELETE_PARTIAL')
    assert.ok(/1 could not be removed/.test(sent[0].message))
    assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
  })

  it('a delete-all where EVERY unlink failed is ok:false too (deleted: 0)', async () => {
    const { ctx, sent } = makeCtx({ deleteAllResult: { deleted: 0, failed: 4 } })
    sessionHandlers.delete_archived_session({}, UNBOUND, { type: 'delete_archived_session', all: true }, ctx)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].deleted, 0)
    assert.equal(sent[0].code, 'ARCHIVED_SESSIONS_DELETE_PARTIAL')
  })

  it('refuses a bound client WITHOUT consulting the manager — for an id AND for all: true', async () => {
    for (const client of [BOUND, EMPTY_STRING_BOUND]) {
      for (const msg of [{ type: 'delete_archived_session', archiveId: ID }, { type: 'delete_archived_session', all: true }, { type: 'delete_archived_session' }]) {
        const { ctx, sent, calls } = makeCtx()
        sessionHandlers.delete_archived_session({}, client, msg, ctx)

        assert.equal(sent.length, 1)
        assert.equal(sent[0].ok, false)
        assert.equal(sent[0].deleted, 0)
        assert.equal(sent[0].refused, true)
        assert.equal(sent[0].code, 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT')
        assert.equal(consulted(calls), 0, `a bound client's ${JSON.stringify(msg)} deleted nothing`)
        assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
      }
    }
  })

  it('requires exactly one of archiveId / all: true, and deletes nothing otherwise', async () => {
    for (const msg of [
      { type: 'delete_archived_session' },
      { type: 'delete_archived_session', all: false },
      { type: 'delete_archived_session', archiveId: ID, all: true },
      { type: 'delete_archived_session', archiveId: '' },
      { type: 'delete_archived_session', archiveId: 5 },
    ]) {
      const { ctx, sent, calls } = makeCtx()
      sessionHandlers.delete_archived_session({}, UNBOUND, msg, ctx)
      assert.equal(sent[0].ok, false, JSON.stringify(msg))
      assert.equal(sent[0].code, 'ARCHIVED_SESSION_INVALID')
      assert.equal(consulted(calls), 0, `${JSON.stringify(msg)} reached the manager`)
      assert.doesNotThrow(() => ServerDeleteArchivedSessionResultSchema.parse(sent[0]))
    }
  })
})

describe('archive client message schemas', () => {
  it('accepts the three requests and bounds offset/limit like the failed-restore read', async () => {
    const ok = (m) => ClientMessageSchema.safeParse(m).success
    assert.ok(ok({ type: 'list_archived_sessions' }))
    assert.ok(ok({ type: 'get_archived_session_history', archiveId: ID }))
    assert.ok(ok({ type: 'get_archived_session_history', archiveId: ID, offset: 0, limit: 100 }))
    assert.equal(ok({ type: 'get_archived_session_history', archiveId: ID, limit: 101 }), false)
    assert.equal(ok({ type: 'get_archived_session_history', archiveId: ID, limit: 0 }), false)
    assert.equal(ok({ type: 'get_archived_session_history', archiveId: ID, offset: -1 }), false)
    assert.equal(ok({ type: 'get_archived_session_history' }), false)
    assert.ok(ok({ type: 'delete_archived_session', archiveId: ID }))
    assert.ok(ok({ type: 'delete_archived_session', all: true }))
    assert.equal(ok({ type: 'delete_archived_session' }), false)
    assert.equal(ok({ type: 'delete_archived_session', all: false }), false)
    assert.equal(ok({ type: 'delete_archived_session', archiveId: ID, all: true }), false)
  })
})
