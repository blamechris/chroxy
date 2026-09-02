import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  redactEnvironmentSessions,
  environmentsForClient,
  environmentForClient,
  broadcastEnvironmentList,
} from '../../src/environments/redact.js'

/**
 * #7576 — a pairing-bound (share-a-session) token must not learn the roster of
 * sibling sessions attached to each environment (`env.sessions`, wired #7552).
 * These pin the redaction helpers used by the list/get responses AND the three
 * `environment_list` broadcasts (create, destroy, the #7552 re-broadcast).
 */

const BOUND = { id: 'b', boundSessionId: 'sess-a', isPrimaryToken: false }
const UNBOUND = { id: 'h', isPrimaryToken: true }

function env(id, sessions) {
  return { id, name: id, status: 'running', sessions, containerId: 'ctr-' + id }
}

describe('#7576 environment session-roster redaction', () => {
  describe('redactEnvironmentSessions', () => {
    it('blanks the sessions roster on every descriptor', () => {
      const out = redactEnvironmentSessions([env('e1', ['s1', 's2']), env('e2', ['s3'])])
      assert.deepEqual(out.map((e) => e.sessions), [[], []])
    })

    it('preserves every OTHER field (only sessions is touched)', () => {
      const out = redactEnvironmentSessions([env('e1', ['s1'])])
      assert.equal(out[0].id, 'e1')
      assert.equal(out[0].name, 'e1')
      assert.equal(out[0].status, 'running')
      assert.equal(out[0].containerId, 'ctr-e1')
    })

    it('returns COPIES — the live manager objects are not mutated', () => {
      // EnvironmentManager.list()/get() hand out live objects by reference; an
      // in-place blank would corrupt the manager and blank the roster for the
      // next UNBOUND reader too. This is the load-bearing property.
      const live = env('e1', ['s1', 's2'])
      const out = redactEnvironmentSessions([live])
      assert.notEqual(out[0], live, 'redaction must not return the same object')
      assert.deepEqual(live.sessions, ['s1', 's2'], 'the source roster was mutated in place')
    })

    it('passes a non-array through unchanged', () => {
      assert.equal(redactEnvironmentSessions(undefined), undefined)
      assert.equal(redactEnvironmentSessions(null), null)
    })
  })

  describe('environmentsForClient', () => {
    it('redacts for a BOUND client', () => {
      const out = environmentsForClient([env('e1', ['s1', 's2'])], BOUND)
      assert.deepEqual(out[0].sessions, [])
    })

    it('passes the FULL roster through for an unbound client (same array, no copy)', () => {
      const input = [env('e1', ['s1', 's2'])]
      const out = environmentsForClient(input, UNBOUND)
      assert.equal(out, input, 'unbound is the fast path — no copy')
      assert.deepEqual(out[0].sessions, ['s1', 's2'])
    })
  })

  describe('environmentForClient', () => {
    it('redacts one descriptor for a BOUND client, copying it', () => {
      const live = env('e1', ['s1'])
      const out = environmentForClient(live, BOUND)
      assert.deepEqual(out.sessions, [])
      assert.notEqual(out, live)
      assert.deepEqual(live.sessions, ['s1'], 'the live object was mutated')
    })

    it('passes the full descriptor through for an unbound client', () => {
      const live = env('e1', ['s1'])
      assert.equal(environmentForClient(live, UNBOUND), live)
    })

    it('passes null/undefined through', () => {
      assert.equal(environmentForClient(null, BOUND), null)
      assert.equal(environmentForClient(undefined, BOUND), undefined)
    })
  })

  describe('broadcastEnvironmentList', () => {
    function capture() {
      const calls = []
      const broadcast = (msg, filter) => calls.push({ msg, filter })
      return { calls, broadcast }
    }

    // What a given client actually receives: the messages whose filter accepts it.
    function deliveredTo(calls, client) {
      return calls.filter((c) => c.filter(client)).map((c) => c.msg)
    }

    it('sends the full roster to unbound and the redacted roster to bound', () => {
      const { calls, broadcast } = capture()
      broadcastEnvironmentList(broadcast, [env('e1', ['s1', 's2'])])

      const forUnbound = deliveredTo(calls, UNBOUND)
      const forBound = deliveredTo(calls, BOUND)

      assert.equal(forUnbound.length, 1, 'unbound must receive exactly one environment_list')
      assert.equal(forBound.length, 1, 'bound must receive exactly one environment_list')
      assert.deepEqual(forUnbound[0].environments[0].sessions, ['s1', 's2'])
      assert.deepEqual(forBound[0].environments[0].sessions, [], 'bound received the sibling roster')
      assert.equal(forUnbound[0].type, 'environment_list')
      assert.equal(forBound[0].type, 'environment_list')
    })

    it('partitions clients — every client receives exactly one message', () => {
      const { calls, broadcast } = capture()
      broadcastEnvironmentList(broadcast, [env('e1', ['s1'])])
      // A client is either bound or unbound; the two filters must not overlap and
      // must not leave a gap (else a client is double-sent or dropped).
      for (const c of [UNBOUND, BOUND, { id: 'x' }, { id: 'y', boundSessionId: 'z' }]) {
        assert.equal(deliveredTo(calls, c).length, 1, `client ${c.id} did not receive exactly one`)
      }
    })

    it('does not mutate the source environments', () => {
      const { calls, broadcast } = capture()
      const input = [env('e1', ['s1', 's2'])]
      broadcastEnvironmentList(broadcast, input)
      assert.deepEqual(input[0].sessions, ['s1', 's2'], 'the source roster was mutated')
      // And the redacted copy really is a different object.
      const forBound = calls.find((c) => c.filter(BOUND)).msg.environments[0]
      assert.notEqual(forBound, input[0])
    })
  })
})
