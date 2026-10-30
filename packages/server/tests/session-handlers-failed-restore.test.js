import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { nsCtx } from './test-helpers.js'
import { ServerFailedRestoresListSchema, ServerRetryFailedRestoreResultSchema, ServerFailedRestoreHistorySchema } from '@chroxy/protocol'

/**
 * #7625 — WS authority + wiring for the two failed-restore messages.
 *
 * The claims worth pinning here are the authority ones, and each is asserted
 * against the ORDER the bearer-token doc requires, not just the outcome: a
 * refusal that happens after the lookup is an existence oracle even when its
 * reply looks identical. Both tests below prove the refusal fired without the
 * SessionManager being consulted at all.
 */

const SAMPLE = [{
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Parked One',
  provider: 'claude',
  cwd: '/home/user/secret-project',
  model: null,
  permissionMode: null,
  errorCode: 'ENVIRONMENT_STOPPED',
  errorMessage: 'environment is not running',
  needsAttention: true,
  historyLength: 7,
}]

/** A ctx whose SessionManager RECORDS whether it was consulted. */
function makeCtx({
  restores = SAMPLE,
  retryResult = { ok: true, sessionId: 'x' },
  historyResult = { ok: true, total: 1, offset: 0, entries: [{ type: 'message', content: 'secret transcript' }] },
} = {}) {
  const sent = []
  const calls = { getFailedRestores: 0, retryFailedRestore: 0, broadcastSessionList: 0, getFailedRestoreHistory: 0, historyArgs: null }
  const ctx = nsCtx({
    sessionManager: {
      getFailedRestores: () => { calls.getFailedRestores++; return restores },
      getFailedRestoreHistory: (id, opts) => {
        calls.getFailedRestoreHistory++
        calls.historyArgs = { id, opts }
        return historyResult
      },
      retryFailedRestore: async (id) => { calls.retryFailedRestore++; return { ...retryResult, sessionId: retryResult.sessionId ?? id } },
    },
    transport: {
      send: (_ws, msg) => sent.push(msg),
      broadcastSessionList: () => { calls.broadcastSessionList++ },
    },
  })
  return { ctx, sent, calls }
}

const UNBOUND = { boundSessionId: null }
const BOUND = { boundSessionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }

describe('list_failed_restores (#7625)', () => {
  it('returns the roster to an unbound client', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.list_failed_restores({}, UNBOUND, { type: 'list_failed_restores' }, ctx)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'failed_restores_list')
    assert.equal(sent[0].restores.length, 1)
    assert.equal(sent[0].restores[0].cwd, '/home/user/secret-project')
    assert.equal(calls.getFailedRestores, 1, 'the manager WAS consulted for an allowed caller')
    assert.doesNotThrow(() => ServerFailedRestoresListSchema.parse(sent[0]))
  })

  it('refuses a bound client WITHOUT consulting the manager', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.list_failed_restores({}, BOUND, { type: 'list_failed_restores' }, ctx)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].refused, true)
    assert.equal(sent[0].code, 'FAILED_RESTORES_LIST_FORBIDDEN_BOUND_CLIENT')
    assert.deepEqual(sent[0].restores, [], 'no host metadata leaks in the refusal')
    // The ordering claim: refusing AFTER the lookup would answer identically
    // while still being an existence oracle. This is the assertion that makes
    // the gate's POSITION testable, not just its outcome.
    assert.equal(calls.getFailedRestores, 0, 'refused before any manager lookup')
    assert.doesNotThrow(() => ServerFailedRestoresListSchema.parse(sent[0]))
  })

  it('an empty roster is distinguishable from a refusal', async () => {
    const { ctx, sent } = makeCtx({ restores: [] })
    await sessionHandlers.list_failed_restores({}, UNBOUND, { type: 'list_failed_restores' }, ctx)

    assert.deepEqual(sent[0].restores, [])
    assert.notEqual(sent[0].refused, true, 'genuinely-empty must not look refused')
  })
})

describe('retry_failed_restore (#7625)', () => {
  it('retries for an unbound client and re-broadcasts the session list', async () => {
    const { ctx, sent, calls } = makeCtx({ retryResult: { ok: true } })
    await sessionHandlers.retry_failed_restore({}, UNBOUND, { type: 'retry_failed_restore', sessionId: 'abc' }, ctx)

    assert.equal(calls.retryFailedRestore, 1)
    // createSession does not emit a session list, so without this every OTHER
    // connected client keeps showing the session as failed.
    assert.equal(calls.broadcastSessionList, 1, 'success re-broadcasts session_list')
    assert.equal(sent[0].type, 'retry_failed_restore_result')
    assert.equal(sent[0].ok, true)
    assert.doesNotThrow(() => ServerRetryFailedRestoreResultSchema.parse(sent[0]))
  })

  it('refuses a bound client WITHOUT calling retry', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.retry_failed_restore({}, BOUND, { type: 'retry_failed_restore', sessionId: 'abc' }, ctx)

    assert.equal(calls.retryFailedRestore, 0, 'refused before the manager is called')
    assert.equal(calls.broadcastSessionList, 0)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'RETRY_FAILED_RESTORE_FORBIDDEN_BOUND_CLIENT')
    assert.doesNotThrow(() => ServerRetryFailedRestoreResultSchema.parse(sent[0]))
  })

  it('does NOT broadcast when the retry fails, and forwards the code', async () => {
    const { ctx, sent, calls } = makeCtx({ retryResult: { ok: false, code: 'ENVIRONMENT_STOPPED', message: 'still down' } })
    await sessionHandlers.retry_failed_restore({}, UNBOUND, { type: 'retry_failed_restore', sessionId: 'abc' }, ctx)

    assert.equal(calls.broadcastSessionList, 0, 'a failed retry must not advertise a live session')
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'ENVIRONMENT_STOPPED')
    assert.equal(sent[0].message, 'still down')
  })

  it('echoes the re-parked id when a retry\'s provider start fails under a different id (#8861)', async () => {
    // createSession can mint a fresh id (malformed / colliding preserveId); the
    // async start-failure re-park is keyed on THAT id, so the reply must name it.
    const reparkedId = 'f'.repeat(32)
    const { ctx, sent } = makeCtx({ retryResult: { ok: false, sessionId: reparkedId, code: 'START_FAILED', message: 'boom' } })
    await sessionHandlers.retry_failed_restore({}, UNBOUND, { type: 'retry_failed_restore', sessionId: 'abc' }, ctx)

    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].sessionId, reparkedId)
    assert.doesNotThrow(() => ServerRetryFailedRestoreResultSchema.parse(sent[0]))
  })

  it('rejects a missing sessionId without calling retry', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.retry_failed_restore({}, UNBOUND, { type: 'retry_failed_restore' }, ctx)

    assert.equal(calls.retryFailedRestore, 0)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'RETRY_FAILED_RESTORE_INVALID')
  })

  it('treats an empty-string boundSessionId as BOUND (fail-safe, #7595)', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.retry_failed_restore({}, { boundSessionId: '' }, { type: 'retry_failed_restore', sessionId: 'abc' }, ctx)

    // A truthy check would classify '' as unbound and let it through — the
    // exact leak #7595 fixed on the environment surface.
    assert.equal(calls.retryFailedRestore, 0, "'' must not be treated as unbound")
    assert.equal(sent[0].code, 'RETRY_FAILED_RESTORE_FORBIDDEN_BOUND_CLIENT')
  })
})

describe('get_failed_restore_history (#8860)', () => {
  const MSG = { type: 'get_failed_restore_history', sessionId: 'abc', offset: 50, limit: 25 }

  it('returns the page to an unbound client, forwarding offset and limit', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_failed_restore_history({}, UNBOUND, MSG, ctx)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'failed_restore_history')
    assert.equal(sent[0].sessionId, 'abc')
    assert.equal(sent[0].ok, true)
    assert.equal(sent[0].entries[0].content, 'secret transcript')
    assert.deepEqual(calls.historyArgs, { id: 'abc', opts: { offset: 50, limit: 25 } })
    assert.doesNotThrow(() => ServerFailedRestoreHistorySchema.parse(sent[0]))
  })

  it('refuses a bound client WITHOUT consulting the manager, and leaks no transcript', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_failed_restore_history({}, BOUND, MSG, ctx)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].refused, true)
    assert.equal(sent[0].code, 'FAILED_RESTORE_HISTORY_FORBIDDEN_BOUND_CLIENT')
    assert.equal(sent[0].entries, undefined, 'no transcript content in the refusal')
    assert.equal(JSON.stringify(sent[0]).includes('secret transcript'), false)
    // The ordering claim: a refusal after the lookup is an existence oracle.
    assert.equal(calls.getFailedRestoreHistory, 0, 'refused before any manager lookup')
    assert.doesNotThrow(() => ServerFailedRestoreHistorySchema.parse(sent[0]))
  })

  it('treats an empty-string boundSessionId as BOUND (fail-safe, #7595)', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_failed_restore_history({}, { boundSessionId: '' }, MSG, ctx)

    assert.equal(calls.getFailedRestoreHistory, 0, "'' must not be treated as unbound")
    assert.equal(sent[0].refused, true)
  })

  it('refuses a bound client even when the sessionId is missing (no validation oracle)', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_failed_restore_history({}, BOUND, { type: 'get_failed_restore_history' }, ctx)

    assert.equal(sent[0].code, 'FAILED_RESTORE_HISTORY_FORBIDDEN_BOUND_CLIENT')
    assert.equal(calls.getFailedRestoreHistory, 0)
    assert.doesNotThrow(() => ServerFailedRestoreHistorySchema.parse(sent[0]))
  })

  it('rejects a missing sessionId from an unbound client without a lookup', async () => {
    const { ctx, sent, calls } = makeCtx()
    await sessionHandlers.get_failed_restore_history({}, UNBOUND, { type: 'get_failed_restore_history' }, ctx)

    assert.equal(calls.getFailedRestoreHistory, 0)
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'FAILED_RESTORE_HISTORY_INVALID')
    assert.doesNotThrow(() => ServerFailedRestoreHistorySchema.parse(sent[0]))
  })

  it('forwards the manager not-found result as a schema-valid reply', async () => {
    const { ctx, sent } = makeCtx({ historyResult: { ok: false, code: 'FAILED_RESTORE_NOT_FOUND', message: 'gone' } })
    await sessionHandlers.get_failed_restore_history({}, UNBOUND, MSG, ctx)

    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'FAILED_RESTORE_NOT_FOUND')
    assert.notEqual(sent[0].refused, true, 'not-found is distinguishable from a refusal')
    assert.doesNotThrow(() => ServerFailedRestoreHistorySchema.parse(sent[0]))
  })
})
