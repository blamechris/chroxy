import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

/**
 * #7552 — the dashboard's copy of `EnvironmentInfo.sessions` must follow the
 * server's.
 *
 * The Environments panel RENDERS the tag ("N connected") and GATES its Destroy
 * button on it. Every `environment_list` emit site in feature-handlers.js is a
 * reply to an env list/create/destroy request — none is on a session opening or
 * closing — so a panel that stays mounted while a session comes or goes would
 * decide from a stale count. That is the same false safety by a different route,
 * which is why the re-broadcast is part of the fix and not a follow-up.
 *
 * #7596 — this is ALSO the most frequent leak path for the host-level
 * environment surface: it fires on every session open/close, so it fans out to
 * UNBOUND (host) clients only — a pairing-bound (share-a-session) token is
 * refused the surface, on this push as on a list/get pull. The spy is on
 * `_broadcast(msg, filter)` (the filtered workhorse), and each cell drives the
 * filter against a bound and an unbound client to prove the bound one gets
 * nothing.
 */
function makeEnvManager(environments = []) {
  const mgr = new EventEmitter()
  mgr.list = () => environments
  return mgr
}

const UNBOUND = { id: 'host', isPrimaryToken: true }
const BOUND = { id: 'phone', boundSessionId: 'sess-x', isPrimaryToken: false }

// The messages a given client receives: those whose per-client filter accepts it.
function deliveredTo(calls, client) {
  return calls.filter((c) => c.filter(client)).map((c) => c.msg)
}

describe('WsServer re-broadcasts environment_list on a session-tag change (#7552)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('re-broadcasts the CURRENT list to unbound clients only (#7596)', () => {
    const environments = [{ id: 'env-1', name: 'e', sessions: [] }]
    const envManager = makeEnvManager(environments)
    const { manager } = createMockSessionManager([])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: manager, environmentManager: envManager })

    const calls = []
    server._broadcast = (msg, filter) => { calls.push({ msg, filter }) }

    // The list the server reads is the LIVE one, so mutate it the way
    // EnvironmentManager.addSession does before announcing.
    environments[0].sessions = ['sess-1']
    envManager.emit('environment_sessions_changed', { id: 'env-1', sessions: ['sess-1'] })

    const forUnbound = deliveredTo(calls, UNBOUND)
    const forBound = deliveredTo(calls, BOUND)
    assert.equal(forUnbound.length, 1, 'an unbound (host) client must receive exactly one environment_list')
    assert.equal(forBound.length, 0, 'a bound client must receive NO environment_list')
    assert.equal(forUnbound[0].type, 'environment_list')
    assert.deepEqual(forUnbound[0].environments[0].sessions, ['sess-1'])
  })

  it('unsubscribes on close() so a torn-down server stops broadcasting', () => {
    const envManager = makeEnvManager([{ id: 'env-1', name: 'e', sessions: [] }])
    const { manager } = createMockSessionManager([])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: manager, environmentManager: envManager })

    const calls = []
    server._broadcast = (msg, filter) => { calls.push({ msg, filter }) }

    // Positive control: the subscription is live BEFORE close, so the zero
    // after it is a real unsubscribe and not a listener that never attached.
    // (One call per event now — a single unbound-only broadcast.)
    envManager.emit('environment_sessions_changed', { id: 'env-1', sessions: ['a'] })
    assert.equal(calls.length, 1)

    server.close()
    server = null
    envManager.emit('environment_sessions_changed', { id: 'env-1', sessions: [] })
    assert.equal(calls.length, 1, 'a closed WsServer must not broadcast')
    assert.equal(envManager.listenerCount('environment_sessions_changed'), 0)
  })

  it('constructs cleanly with NO environmentManager (feature off)', () => {
    const { manager } = createMockSessionManager([])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: manager })
    assert.equal(server.environmentManager, null)
    // close() must not throw on the null-manager path.
    server.close()
    server = null
  })

  it('a broadcast failure is contained, not thrown into the emitter', () => {
    const envManager = makeEnvManager([{ id: 'env-1', name: 'e', sessions: [] }])
    const { manager } = createMockSessionManager([])
    server = new WsServer({ port: 0, apiToken: 't', sessionManager: manager, environmentManager: envManager })
    server._broadcast = () => { throw new Error('socket set torn down') }

    // EnvironmentManager.addSession emits synchronously from inside
    // SessionManager.createSession; an unguarded throw here would unwind a
    // session create (or a shutdown loop) over a failed broadcast.
    assert.doesNotThrow(() => {
      envManager.emit('environment_sessions_changed', { id: 'env-1', sessions: ['a'] })
    })
  })
})
