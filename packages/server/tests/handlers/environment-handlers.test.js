import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { featureHandlers as environmentHandlers } from '../../src/handlers/feature-handlers.js'
import { createSpy, nsCtx } from '../test-helpers.js'

function makeCtx(overrides = {}) {
  const sent = []
  const broadcasts = [] // { msg, filter } — the #7576 env broadcast passes a per-client filter

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
// Default: a host-level PRIMARY, unbound client — passes the #7576 create gate
// and receives unredacted rosters. Override for the bound / non-primary cases.
function makeClient(overrides = {}) { return { id: 'client-1', isPrimaryToken: true, ...overrides } }

// The env_list messages a given client actually receives from a #7576 broadcast:
// the ones whose per-client filter accepts it.
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

    // ---- #7576 roster redaction ---------------------------------------------

    it('#7576 blanks the sessions roster for a BOUND client', () => {
      const ctx = makeCtx({
        environmentManager: {
          list: createSpy(() => [{ id: 'env-1', name: 'dev', status: 'running', sessions: ['s1', 's2'] }]),
        },
      })
      environmentHandlers.list_environments(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: 'sess-1' }), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_list')
      assert.deepEqual(ctx._sent[0].environments[0].sessions, [], 'bound client received the sibling roster')
      // The rest of the descriptor is intact — the picker still works.
      assert.equal(ctx._sent[0].environments[0].id, 'env-1')
    })

    it('#7576 sends the FULL roster to an unbound (host) client', () => {
      const live = [{ id: 'env-1', name: 'dev', status: 'running', sessions: ['s1', 's2'] }]
      const ctx = makeCtx({ environmentManager: { list: createSpy(() => live) } })
      environmentHandlers.list_environments(makeWs(), makeClient(), {}, ctx)
      assert.deepEqual(ctx._sent[0].environments[0].sessions, ['s1', 's2'])
      // Positive control: the redaction did not mutate the manager's live objects.
      assert.deepEqual(live[0].sessions, ['s1', 's2'])
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

    it('#7576 the post-destroy broadcast redacts the roster for bound listeners', async () => {
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
      assert.equal(forBound.length, 1, 'a bound listener must receive exactly one environment_list')
      assert.equal(forUnbound.length, 1, 'an unbound listener must receive exactly one environment_list')
      assert.deepEqual(forBound[0].environments[0].sessions, [], 'bound listener received the sibling roster over a broadcast')
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

    // ---- #7576 roster redaction ---------------------------------------------

    it('#7576 blanks the roster for a BOUND client, without mutating the live object', () => {
      const live = { id: 'env-1', name: 'dev', status: 'running', sessions: ['s1', 's2'] }
      const ctx = makeCtx({ environmentManager: { get: createSpy(() => live) } })
      environmentHandlers.get_environment(makeWs(), makeClient({ isPrimaryToken: false, boundSessionId: 'sess-1' }), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_info')
      assert.deepEqual(ctx._sent[0].environment.sessions, [], 'bound client received the sibling roster')
      assert.equal(ctx._sent[0].environment.id, 'env-1')
      assert.deepEqual(live.sessions, ['s1', 's2'], 'the manager\'s live object was mutated')
    })

    it('#7576 sends the full roster to an unbound (host) client', () => {
      const live = { id: 'env-1', name: 'dev', status: 'running', sessions: ['s1', 's2'] }
      const ctx = makeCtx({ environmentManager: { get: createSpy(() => live) } })
      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      assert.deepEqual(ctx._sent[0].environment.sessions, ['s1', 's2'])
    })
  })
})
