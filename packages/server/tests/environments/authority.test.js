import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isBoundClient, broadcastEnvironmentList } from '../../src/environments/authority.js'

/**
 * #7596 — bound (share-a-session) tokens are refused the environment surface.
 * These pin the fail-safe bound check and the unbound-only broadcast used by the
 * list/get gates and the three `environment_list` broadcast sites.
 */

const BOUND = { id: 'b', boundSessionId: 'sess-a', isPrimaryToken: false }
const UNBOUND = { id: 'h', isPrimaryToken: true }

function env(id, sessions) {
  return { id, name: id, status: 'running', sessions, containerId: 'ctr-' + id, cwd: '/home/u/' + id }
}

describe('#7596 environment-surface authority', () => {
  describe('isBoundClient (fail-safe bound check)', () => {
    it('an unbound host client (boundSessionId null/undefined) is NOT bound', () => {
      assert.equal(isBoundClient({ id: 'h', isPrimaryToken: true }), false)
      assert.equal(isBoundClient({ id: 'h', boundSessionId: null }), false)
      assert.equal(isBoundClient({ id: 'h', boundSessionId: undefined }), false)
    })

    it('a real session id is bound', () => {
      assert.equal(isBoundClient({ id: 'b', boundSessionId: 'sess-a' }), true)
    })

    it('an EMPTY-STRING boundSessionId is bound (fail-safe, Copilot #7595 review)', () => {
      assert.equal(isBoundClient({ id: 'b', boundSessionId: '' }), true)
    })

    it('a nullish client is bound (fails CLOSED)', () => {
      assert.equal(isBoundClient(null), true)
      assert.equal(isBoundClient(undefined), true)
    })
  })

  describe('broadcastEnvironmentList (unbound-only)', () => {
    function capture() {
      const calls = []
      const broadcast = (msg, filter) => calls.push({ msg, filter })
      return { calls, broadcast }
    }
    // Messages a given client actually receives: those whose filter accepts it.
    function deliveredTo(calls, client) {
      return calls.filter((c) => c.filter(client)).map((c) => c.msg)
    }

    it('emits exactly ONE broadcast (no per-recipient split)', () => {
      const { calls, broadcast } = capture()
      broadcastEnvironmentList(broadcast, [env('e1', ['s1'])])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].msg.type, 'environment_list')
    })

    it('delivers the full list to unbound clients, NOTHING to bound', () => {
      const { calls, broadcast } = capture()
      broadcastEnvironmentList(broadcast, [env('e1', ['s1', 's2'])])
      const forUnbound = deliveredTo(calls, UNBOUND)
      const forBound = deliveredTo(calls, BOUND)
      assert.equal(forUnbound.length, 1, 'unbound must receive the list')
      assert.deepEqual(forUnbound[0].environments[0].sessions, ['s1', 's2'])
      assert.equal(forBound.length, 0, 'a bound client must receive NO environment_list')
    })

    it('an EMPTY-STRING bound id receives nothing (no truthy hole)', () => {
      const { calls, broadcast } = capture()
      broadcastEnvironmentList(broadcast, [env('e1', ['s1'])])
      assert.equal(deliveredTo(calls, { id: 'b', boundSessionId: '' }).length, 0)
    })
  })
})
