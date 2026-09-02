import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { featureHandlers as environmentHandlers } from '../../src/handlers/feature-handlers.js'
import { createSpy, nsCtx } from '../test-helpers.js'

function makeCtx(overrides = {}) {
  const sent = []
  const broadcasts = [] // { msg, filter } — the env broadcast passes an unbound-only filter (#7596)

  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg, filter) => { broadcasts.push({ msg, filter }) }),
    environmentManager: null,
    _sent: sent,
    _broadcasts: broadcasts,
    ...overrides,
  })
}

function makeWs() { return {} }
// Default: a host-level PRIMARY, unbound client — passes the create gate (#7576)
// and the list/get bound gate (#7596). Override for the bound / non-primary cases.
function makeClient(overrides = {}) { return { id: 'client-1', isPrimaryToken: true, ...overrides } }

// The env_list messages a given client actually receives from a broadcast:
// the ones whose filter accepts it.
function deliveredTo(broadcasts, client) {
  return broadcasts.filter((b) => b.filter(client)).map((b) => b.msg)
}

describe('environment-handlers', () => {
  describe('create_environment', () => {
    // ---- #7576 authority gate: strict-primary --------------------------------
    // create_environment spawns a HOST container from caller-supplied inputs, so
    // it takes the strictest bar (isPrimaryToken === true). These run FIRST —
    // before the feature-enabled check — so an unauthorised caller gets one
    // identical refusal regardless of feature/arg state (no existence oracle).

    it('#7576 rejects a NON-PRIMARY unbound token before the feature check', () => {
      // manager is null (feature off); a primary client would get "not enabled",
      // so a non-primary client getting the GATE code proves the gate runs first.
      const ctx = makeCtx()
      environmentHandlers.create_environment(
        makeWs(), makeClient({ isPrimaryToken: false }), { name: 'dev', cwd: '/tmp' }, ctx,
      )
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_CREATE_FORBIDDEN_NON_PRIMARY')
      assert.doesNotMatch(ctx._sent[0].error, /not enabled/, 'the gate must precede the feature check')
    })

    it('#7576 rejects a pairing-BOUND token', () => {
      const ctx = makeCtx()
      environmentHandlers.create_environment(
        makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: 'sess-1' }), { name: 'dev', cwd: '/tmp' }, ctx,
      )
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_CREATE_FORBIDDEN_NON_PRIMARY')
    })

    it('#7576 lets a PRIMARY token through the gate (reaches the feature check)', () => {
      // Negative control for the gate: the SAME manager-null path a non-primary
      // client is stopped at, a primary client passes — proving the gate is not
      // rejecting everyone (which would let the deny-all false-safety in, #7273).
      const ctx = makeCtx()
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev', cwd: '/tmp' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.notEqual(ctx._sent[0].code, 'ENVIRONMENT_CREATE_FORBIDDEN_NON_PRIMARY')
      assert.match(ctx._sent[0].error, /not enabled/)
    })

    it('sends environment_error when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev', cwd: '/tmp' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /not enabled/)
    })

    it('sends environment_error when name is missing', () => {
      const ctx = makeCtx({
        environmentManager: { create: createSpy(async () => ({})) },
      })
      environmentHandlers.create_environment(makeWs(), makeClient(), { cwd: '/tmp' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /name is required/)
    })

    it('sends environment_error when cwd is missing', () => {
      const ctx = makeCtx({
        environmentManager: { create: createSpy(async () => ({})) },
      })
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /cwd is required/)
    })

    it('sends environment_error when cwd is outside home directory', () => {
      const ctx = makeCtx({
        environmentManager: { create: createSpy(async () => ({})) },
      })
      // /etc is outside home directory
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev', cwd: '/etc' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
    })
  })

  describe('list_environments', () => {
    it('sends empty list when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.list_environments(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_list')
      assert.deepEqual(ctx._sent[0].environments, [])
    })

    it('sends environments from manager', () => {
      const ctx = makeCtx({
        environmentManager: {
          list: createSpy(() => [{ id: 'env-1', name: 'dev', status: 'running' }]),
        },
      })

      environmentHandlers.list_environments(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'environment_list')
      assert.equal(ctx._sent[0].environments.length, 1)
      assert.equal(ctx._sent[0].environments[0].id, 'env-1')
    })

    // ---- #7596 authority gate: refuse bound clients --------------------------

    it('#7596 refuses a BOUND client before any manager lookup', () => {
      const listed = createSpy(() => [{ id: 'env-1', name: 'dev', status: 'running', sessions: ['s1'] }])
      const ctx = makeCtx({ environmentManager: { list: listed } })
      environmentHandlers.list_environments(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: 'sess-1' }), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_LIST_FORBIDDEN_BOUND_CLIENT')
      // Gate runs before the lookup — no manager read, no oracle.
      assert.equal(listed.calls.length, 0, 'a bound client must not reach the manager')
    })

    it('#7596 refuses an EMPTY-STRING bound id (fail-safe)', () => {
      const ctx = makeCtx({ environmentManager: { list: createSpy(() => []) } })
      environmentHandlers.list_environments(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: '' }), {}, ctx)
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_LIST_FORBIDDEN_BOUND_CLIENT')
    })

    it('#7596 sends the full list to an unbound (host) client', () => {
      const live = [{ id: 'env-1', name: 'dev', status: 'running', sessions: ['s1', 's2'] }]
      const ctx = makeCtx({ environmentManager: { list: createSpy(() => live) } })
      environmentHandlers.list_environments(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_list')
      assert.deepEqual(ctx._sent[0].environments[0].sessions, ['s1', 's2'])
    })
  })

  describe('destroy_environment', () => {
    it('sends environment_error when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.destroy_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
    })

    it('sends environment_error when environmentId is missing', () => {
      const ctx = makeCtx({
        environmentManager: { destroy: createSpy(async () => {}) },
      })
      environmentHandlers.destroy_environment(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /environmentId is required/)
    })

    it('sends environment_destroyed and broadcasts on success', async () => {
      const ctx = makeCtx({
        environmentManager: {
          destroy: createSpy(async () => {}),
          list: createSpy(() => []),
        },
      })

      environmentHandlers.destroy_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      // Wait for async resolution
      await new Promise(r => setTimeout(r, 10))

      const destroyed = ctx._sent.find(m => m.type === 'environment_destroyed')
      assert.ok(destroyed, 'environment_destroyed not sent')
      assert.equal(destroyed.environmentId, 'env-1')
    })

    it('#7597 refuses an EMPTY-STRING bound id cleanly (no logger throw)', () => {
      // isBoundClient admits '' as bound, so it now enters the refuse branch —
      // whose warn log must NOT throw on an empty sessionId (loggerForSession
      // does; sessionLogger falls back to unscoped). A throw here would turn the
      // refusal into a handler crash for the exact case the fail-safe check exists
      // to catch.
      const destroyed = createSpy(async () => {})
      const ctx = makeCtx({ environmentManager: { destroy: destroyed, list: createSpy(() => []) } })
      assert.doesNotThrow(() => {
        environmentHandlers.destroy_environment(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: '' }), { environmentId: 'env-1' }, ctx)
      })
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT')
      assert.equal(destroyed.calls.length, 0, 'the environment must not be destroyed')
    })

    it('#7596 the post-destroy broadcast reaches unbound listeners only', async () => {
      const ctx = makeCtx({
        environmentManager: {
          destroy: createSpy(async () => {}),
          list: createSpy(() => [{ id: 'env-2', name: 'dev', status: 'running', sessions: ['s1', 's2'] }]),
        },
      })
      environmentHandlers.destroy_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      await new Promise(r => setTimeout(r, 10))

      const forBound = deliveredTo(ctx._broadcasts, { id: 'b', boundSessionId: 'sess-x' })
      const forUnbound = deliveredTo(ctx._broadcasts, { id: 'h', isPrimaryToken: true })
      assert.equal(forBound.length, 0, 'a bound listener must receive NO environment_list')
      assert.equal(forUnbound.length, 1, 'an unbound listener must receive exactly one environment_list')
      assert.deepEqual(forUnbound[0].environments[0].sessions, ['s1', 's2'])
    })
  })

  describe('get_environment', () => {
    it('sends environment_error when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
    })

    it('sends environment_error when environment not found', () => {
      const ctx = makeCtx({
        environmentManager: {
          get: createSpy(() => null),
        },
      })

      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)

      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /not found/)
    })

    it('sends environment_info when found', () => {
      const envData = { id: 'env-1', name: 'dev', status: 'running' }
      const ctx = makeCtx({
        environmentManager: {
          get: createSpy(() => envData),
        },
      })

      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)

      assert.equal(ctx._sent[0].type, 'environment_info')
      assert.deepEqual(ctx._sent[0].environment, envData)
    })

    // ---- #7596 authority gate: refuse bound clients --------------------------

    it('#7596 refuses a BOUND client before any lookup', () => {
      const got = createSpy(() => ({ id: 'env-1', name: 'dev', status: 'running', sessions: ['s1'] }))
      const ctx = makeCtx({ environmentManager: { get: got } })
      environmentHandlers.get_environment(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: 'sess-1' }), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_GET_FORBIDDEN_BOUND_CLIENT')
      // Gate before lookup — not an existence oracle.
      assert.equal(got.calls.length, 0, 'a bound client must not reach get()')
    })

    it('#7596 refuses an EMPTY-STRING bound id (fail-safe)', () => {
      const ctx = makeCtx({ environmentManager: { get: createSpy(() => null) } })
      environmentHandlers.get_environment(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: '' }), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].code, 'ENVIRONMENT_GET_FORBIDDEN_BOUND_CLIENT')
    })

    it('#7596 sends the full descriptor to an unbound (host) client', () => {
      const live = { id: 'env-1', name: 'dev', status: 'running', sessions: ['s1', 's2'] }
      const ctx = makeCtx({ environmentManager: { get: createSpy(() => live) } })
      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_info')
      assert.deepEqual(ctx._sent[0].environment.sessions, ['s1', 's2'])
    })
  })
})
