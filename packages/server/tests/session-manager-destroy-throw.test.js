import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import { SessionManager } from '../src/session-manager.js'

/**
 * #9034 — a throw inside destroySession (a session_event listener, or
 * closePendingStreams) used to leave the entry marked `_destroying`: it stayed
 * in the map, invisible to getSession(), and a second destroy could not finish it.
 */

const dirs = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }) })

function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-9034-'))
  dirs.push(dir)
  const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: join(dir, 'state.json') })
  const session = new EventEmitter()
  session.isRunning = false
  session.destroyCalls = 0
  session.destroy = () => { session.destroyCalls++ }
  mgr._sessions.set('s1', { session, type: 'cli', name: 'Original', cwd: '/tmp' })
  return { mgr, session }
}

describe('destroySession when a step throws (#9034)', () => {
  it('a throwing session_event listener does not strand the session', () => {
    const { mgr, session } = manager()
    mgr._history.closePendingStreams = () => ['m1']
    mgr.on('session_event', () => { throw new Error('listener boom') })
    mgr.destroySession('s1')
    assert.equal(mgr._sessions.has('s1'), false, 'cleanup completed')
    assert.equal(session.destroyCalls, 1)
  })

  it('a throwing closePendingStreams does not strand the session', () => {
    const { mgr, session } = manager()
    mgr._history.closePendingStreams = () => { throw new Error('history boom') }
    mgr.destroySession('s1')
    assert.equal(mgr._sessions.has('s1'), false)
    assert.equal(session.destroyCalls, 1)
  })

  it('a throw nothing absorbs leaves the session visible and destroyable', async () => {
    const { mgr, session } = manager()
    let fail = true
    const real = mgr._cleanupSessionMaps.bind(mgr)
    mgr._cleanupSessionMaps = (id) => { if (fail) throw new Error('cleanup boom'); return real(id) }
    await assert.rejects(mgr.destroySessionLocked('s1'), /cleanup boom/)
    assert.ok(mgr.getSession('s1'), 'still visible')
    fail = false
    await mgr.destroySessionLocked('s1')
    assert.equal(mgr._sessions.has('s1'), false)
    assert.equal(session.destroyCalls, 2)
  })
  it('direct destroySession: a throw nothing absorbs leaves the session visible and destroyable', () => {
    const { mgr, session } = manager()
    let fail = true
    const real = mgr._cleanupSessionMaps.bind(mgr)
    mgr._cleanupSessionMaps = (id) => { if (fail) throw new Error('cleanup boom'); return real(id) }
    assert.throws(() => mgr.destroySession('s1'), /cleanup boom/)
    assert.ok(mgr.getSession('s1'), 'visible again')
    assert.equal(mgr._sessions.get('s1')._destroying, false)
    fail = false
    assert.equal(mgr.destroySession('s1'), true)
    assert.equal(mgr._sessions.has('s1'), false)
    assert.equal(session.destroyCalls, 2)
  })

  it('a failed destroy keeps the session marked while another destroy is queued behind it', async () => {
    const { mgr } = manager()
    let fail = true
    const real = mgr._cleanupSessionMaps.bind(mgr)
    mgr._cleanupSessionMaps = (id) => { if (fail) { fail = false; throw new Error('cleanup boom') } return real(id) }
    let markedWhenSecondRuns
    const first = mgr.destroySessionLocked('s1')
    const second = mgr.destroySessionLocked('s1', { isAuthorized: () => { markedWhenSecondRuns = mgr._sessions.get('s1')?._destroying; return true } })
    await assert.rejects(first, /cleanup boom/)
    await second
    assert.equal(markedWhenSecondRuns, true, 'still marked when the queued destroy gets its turn')
    assert.equal(mgr._sessions.has('s1'), false)
  })

  it('each refused destroy gives back exactly one pending mark', async () => {
    const { mgr } = manager()
    const counts = []
    const refuse = () => { throw new Error('refused') }
    const a = mgr.destroySessionLocked('s1', { isAuthorized: refuse })
    const b = mgr.destroySessionLocked('s1', { isAuthorized: refuse })
    const c = mgr.destroySessionLocked('s1', { isAuthorized: () => { counts.push(mgr._sessions.get('s1')._pendingDestroys); return true } })
    assert.equal(mgr._sessions.get('s1')._pendingDestroys, 3)
    await assert.rejects(a)
    await assert.rejects(b)
    await c
    assert.deepEqual(counts, [1], 'only the running destroy is left counted')
  })

  it('a retry after a failed cleanup does not archive the session twice', async () => {
    const { mgr } = manager()
    mgr._history.setHistory('s1', [{ type: 'message', messageType: 'user_input', content: 'hi' }])
    let fail = true
    const real = mgr._cleanupSessionMaps.bind(mgr)
    mgr._cleanupSessionMaps = (id) => { if (fail) { fail = false; throw new Error('cleanup boom') } return real(id) }
    assert.throws(() => mgr.destroySession('s1'), /cleanup boom/)
    assert.equal(mgr.destroySession('s1'), true)
    await mgr.whenArchiveIdle()
    assert.equal(mgr.listArchivedSessions().sessions.length, 1)
  })
})
