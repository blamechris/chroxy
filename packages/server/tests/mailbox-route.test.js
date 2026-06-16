// Mailbox live-interrupt routes (agent-comm-system delivery layer).
//
// Pins:
//   - auth: ONLY the daemon-level ingest secret (constant-time); missing/wrong
//     token -> 401 with no body detail
//   - POST /api/mailbox: notifies via PushManager (category 'mailbox') and
//     injects a wakeup ONLY into a live, idle claude-tui recipient; busy /
//     non-tui / unknown / pty-dead recipients are notify-only with the right
//     reason
//   - POST /api/mailbox/register: maps agentCommId -> sessionId (404 unknown)
//   - SessionManager registry: register/resolve/unregister + cleanup on removal
//
// All SessionManager state paths are temp (#4633 sandbox guard applies).

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMailboxPing, handleMailboxRegister } from '../src/mailbox-route.js'
import { SessionManager } from '../src/session-manager.js'

const SECRET = 'test-ingest-secret-mailbox-0123456789'
const bearer = (t) => ({ authorization: `Bearer ${t}` })

function makeReq({ headers = {}, body = '' }) {
  const req = new Readable({ read() {} })
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    if (body) req.push(body)
    req.push(null)
  })
  return req
}

function invoke(handler, server, { headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const req = makeReq({ headers, body })
    const res = {
      statusCode: 0,
      _body: '',
      writeHead(status) {
        this.statusCode = status
      },
      end(payload) {
        if (payload !== undefined) this._body = payload
        let parsed = null
        try {
          parsed = this._body ? JSON.parse(this._body) : null
        } catch {
          parsed = this._body
        }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    handler(server, req, res)
  })
}

function makePushManager() {
  const calls = []
  return {
    calls,
    send: (category, title, body, data) => {
      calls.push({ category, title, body, data })
      return Promise.resolve(true)
    },
  }
}

function idleTuiSession() {
  return {
    isRunning: false,
    writes: [],
    writeTerminalInput(text) {
      this.writes.push(text)
      return true
    },
  }
}

function makeServer(sessionForId = {}, { pushManager = makePushManager() } = {}) {
  const recordedMailboxEvents = []
  return {
    _ingestSecret: SECRET,
    pushManager,
    sessionManager: {
      resolveSessionByAgentCommId: (id) => sessionForId[id] || null,
      registerAgentCommId: (sid) => sid !== 'no-such-session',
      recordMailboxEvent: (ev) => recordedMailboxEvents.push(ev),
      recordedMailboxEvents,
    },
  }
}

describe('POST /api/mailbox — auth', () => {
  it('rejects a missing bearer with 401', async () => {
    const res = await invoke(handleMailboxPing, makeServer(), { body: JSON.stringify({ to: 'coder' }) })
    assert.equal(res.status, 401)
    assert.equal(res.body, null)
  })

  it('rejects a wrong bearer with 401', async () => {
    const res = await invoke(handleMailboxPing, makeServer(), {
      headers: bearer('nope'),
      body: JSON.stringify({ to: 'coder' }),
    })
    assert.equal(res.status, 401)
  })
})

describe('POST /api/mailbox — ping behavior', () => {
  it('injects a wakeup into a live idle claude-tui recipient and notifies', async () => {
    const session = idleTuiSession()
    const push = makePushManager()
    const server = makeServer({ coder: session }, { pushManager: push })
    const res = await invoke(handleMailboxPing, server, {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'coder', from: 'alice', id: 'alice-1', unread_count: 3 }),
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.injected, true)
    assert.equal(res.body.reason, 'injected')
    assert.equal(session.writes.length, 1)
    assert.match(session.writes[0], /3 unread mailbox message\(s\)/)
    assert.match(session.writes[0], /receive_next/)
    assert.ok(session.writes[0].endsWith('\r'), 'submits with a carriage return')

    assert.equal(push.calls.length, 1)
    assert.equal(push.calls[0].category, 'mailbox')
    assert.equal(push.calls[0].data.to, 'coder')
    assert.equal(push.calls[0].data.unread_count, 3)

    // The delivery is recorded for the Control Room "Mailbox" tab.
    const recorded = server.sessionManager.recordedMailboxEvents
    assert.equal(recorded.length, 1)
    assert.deepEqual(recorded[0], { to: 'coder', from: 'alice', unreadCount: 3, outcome: 'injected' })
  })

  it('does NOT inject when the recipient is mid-turn (busy) but still notifies', async () => {
    const session = { isRunning: true, writes: [], writeTerminalInput(t) { this.writes.push(t); return true } }
    const push = makePushManager()
    const server = makeServer({ coder: session }, { pushManager: push })
    const res = await invoke(handleMailboxPing, server, {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'coder', unread_count: 1 }),
    })

    assert.equal(res.body.reason, 'busy')
    assert.equal(res.body.injected, false)
    assert.equal(session.writes.length, 0)
    assert.equal(push.calls.length, 1)
  })

  it('reports not-tui for a session without writeTerminalInput', async () => {
    const server = makeServer({ coder: { isRunning: false } })
    const res = await invoke(handleMailboxPing, server, {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'coder' }),
    })
    assert.equal(res.body.reason, 'not-tui')
    assert.equal(res.body.injected, false)
  })

  it('reports no-session for an unregistered recipient', async () => {
    const res = await invoke(handleMailboxPing, makeServer(), {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'ghost' }),
    })
    assert.equal(res.body.reason, 'no-session')
  })

  it('reports pty-dead when the PTY write fails', async () => {
    const session = { isRunning: false, writeTerminalInput: () => false }
    const res = await invoke(handleMailboxPing, makeServer({ coder: session }), {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'coder' }),
    })
    assert.equal(res.body.reason, 'pty-dead')
  })

  it('400s when `to` is missing', async () => {
    const res = await invoke(handleMailboxPing, makeServer(), {
      headers: bearer(SECRET),
      body: JSON.stringify({ from: 'alice' }),
    })
    assert.equal(res.status, 400)
  })

  it('400s when `to` contains control characters (injection guard)', async () => {
    const res = await invoke(handleMailboxPing, makeServer(), {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'co\nder' }),
    })
    assert.equal(res.status, 400)
  })

  it('treats a negative / fractional unread_count as null (no count in the prompt)', async () => {
    const session = idleTuiSession()
    const res = await invoke(handleMailboxPing, makeServer({ coder: session }), {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'coder', unread_count: -5 }),
    })
    assert.equal(res.body.reason, 'injected')
    assert.equal(session.writes.length, 1)
    // The fixed no-count wording, not "-5 unread".
    assert.match(session.writes[0], /unread mailbox messages —/)
    assert.doesNotMatch(session.writes[0], /-5/)
  })

  it('rejects when the pre-auth per-IP rate limit is exceeded (429)', async () => {
    const server = makeServer()
    server._mailboxIpRateLimiter = { check: () => ({ allowed: false, retryAfterMs: 1000 }) }
    const res = await invoke(handleMailboxPing, server, {
      headers: bearer(SECRET),
      body: JSON.stringify({ to: 'coder' }),
    })
    assert.equal(res.status, 429)
  })
})

describe('POST /api/mailbox/register', () => {
  it('registers a valid id -> session mapping', async () => {
    const res = await invoke(handleMailboxRegister, makeServer(), {
      headers: bearer(SECRET),
      body: JSON.stringify({ agentCommId: 'coder', sessionId: 'sid-1' }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
  })

  it('404s for an unknown session', async () => {
    const res = await invoke(handleMailboxRegister, makeServer(), {
      headers: bearer(SECRET),
      body: JSON.stringify({ agentCommId: 'coder', sessionId: 'no-such-session' }),
    })
    assert.equal(res.status, 404)
  })

  it('400s when fields are missing', async () => {
    const res = await invoke(handleMailboxRegister, makeServer(), {
      headers: bearer(SECRET),
      body: JSON.stringify({ agentCommId: 'coder' }),
    })
    assert.equal(res.status, 400)
  })

  it('rejects a missing bearer with 401', async () => {
    const res = await invoke(handleMailboxRegister, makeServer(), {
      body: JSON.stringify({ agentCommId: 'coder', sessionId: 'sid-1' }),
    })
    assert.equal(res.status, 401)
  })
})

describe('SessionManager agent-comm registry', () => {
  let mgr
  let tmpDir

  function makeMgr() {
    tmpDir = mkdtempSync(join(tmpdir(), 'sm-mailbox-'))
    mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: '/tmp',
      stateFilePath: join(tmpDir, 'state.json'),
    })
    return mgr
  }

  afterEach(() => {
    try {
      mgr?._sessions?.clear()
      mgr?.destroyAll?.()
    } catch {
      // teardown best-effort
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    mgr = null
    tmpDir = null
  })

  it('registers and resolves an id to the live session', () => {
    makeMgr()
    const session = idleTuiSession()
    mgr._sessions.set('sid-1', { session })

    assert.equal(mgr.registerAgentCommId('sid-1', 'coder'), true)
    assert.equal(mgr.resolveSessionByAgentCommId('coder'), session)
    assert.equal(mgr.resolveSessionByAgentCommId('unknown'), null)
  })

  it('rejects registering an unknown session', () => {
    makeMgr()
    assert.equal(mgr.registerAgentCommId('nope', 'coder'), false)
    assert.equal(mgr.resolveSessionByAgentCommId('coder'), null)
  })

  it('reassigning an id moves it to the new session and clears the old entry', () => {
    makeMgr()
    const s1 = idleTuiSession()
    const s2 = idleTuiSession()
    mgr._sessions.set('sid-1', { session: s1 })
    mgr._sessions.set('sid-2', { session: s2 })

    mgr.registerAgentCommId('sid-1', 'coder')
    mgr.registerAgentCommId('sid-2', 'coder')

    assert.equal(mgr.resolveSessionByAgentCommId('coder'), s2)
    assert.equal(mgr._sessions.get('sid-1').agentCommId, null)
    assert.equal(mgr._sessions.get('sid-2').agentCommId, 'coder')
  })

  it('giving a session a new id drops its previous id from the map', () => {
    makeMgr()
    const session = idleTuiSession()
    mgr._sessions.set('sid-1', { session })

    mgr.registerAgentCommId('sid-1', 'old')
    mgr.registerAgentCommId('sid-1', 'new')

    assert.equal(mgr.resolveSessionByAgentCommId('old'), null)
    assert.equal(mgr.resolveSessionByAgentCommId('new'), session)
  })

  it('clears the reverse map when the session is removed', () => {
    makeMgr()
    const session = idleTuiSession()
    mgr._sessions.set('sid-1', { session })
    mgr.registerAgentCommId('sid-1', 'coder')

    mgr._cleanupSessionMaps('sid-1')

    assert.equal(mgr.resolveSessionByAgentCommId('coder'), null)
    assert.equal(mgr._agentCommIds.has('coder'), false)
  })

  it('unregisterAgentCommId removes the mapping', () => {
    makeMgr()
    const session = idleTuiSession()
    mgr._sessions.set('sid-1', { session })
    mgr.registerAgentCommId('sid-1', 'coder')

    assert.equal(mgr.unregisterAgentCommId('coder'), true)
    assert.equal(mgr.resolveSessionByAgentCommId('coder'), null)
    assert.equal(mgr.unregisterAgentCommId('coder'), false)
  })

  it('rejects an id with control characters (hygiene / route parity)', () => {
    makeMgr()
    mgr._sessions.set('sid-1', { session: idleTuiSession() })
    // The id is only a routing key (never itself injected into the PTY — the
    // wakeup is a fixed template), but control chars are rejected for parity
    // with the route's cleanField contract and to keep ids well-formed.
    assert.equal(mgr.registerAgentCommId('sid-1', 'coder\r\nrm -rf'), false)
    assert.equal(mgr.registerAgentCommId('sid-1', 'tab\tid'), false)
    assert.equal(mgr.resolveSessionByAgentCommId('coder\r\nrm -rf'), null)
  })

  it('rejects an over-length id (>200 chars)', () => {
    makeMgr()
    mgr._sessions.set('sid-1', { session: idleTuiSession() })
    assert.equal(mgr.registerAgentCommId('sid-1', 'a'.repeat(201)), false)
    assert.equal(mgr.registerAgentCommId('sid-1', 'a'.repeat(200)), true)
  })

  it('trims the id and rejects whitespace-only (canonical stored key)', () => {
    makeMgr()
    mgr._sessions.set('sid-1', { session: idleTuiSession() })
    // Whitespace-only → rejected (no confusing empty-ish mapping).
    assert.equal(mgr.registerAgentCommId('sid-1', '   '), false)
    // Leading/trailing space is trimmed; the canonical 'coder' resolves.
    assert.equal(mgr.registerAgentCommId('sid-1', '  coder  '), true)
    assert.equal(mgr.resolveSessionByAgentCommId('coder'), mgr._sessions.get('sid-1').session)
  })
})

describe('createSession auto-registers AGENT_COMM_ID', () => {
  // createSession spawns a provider, so unit-test the auto-register seam at the
  // method level by stubbing the spawn: register through the SAME path
  // createSession uses (entry in _sessions, then registerAgentCommId).
  let mgr
  let tmpDir

  afterEach(() => {
    try {
      mgr?._sessions?.clear()
      mgr?.destroyAll?.()
    } catch {
      // best-effort teardown
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    mgr = null
    tmpDir = null
  })

  it('serializes agentCommId so it survives a restart, and skips it when absent', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sm-mailbox-persist-'))
    mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: '/tmp',
      stateFilePath: join(tmpDir, 'state.json'),
    })
    // Stand in for a created session entry, then register as createSession does.
    const session = idleTuiSession()
    session.resumeSessionId = undefined
    session.model = null
    mgr._sessions.set('sid-1', { session, name: 'Coder', cwd: '/tmp', createdAt: 1 })
    mgr.registerAgentCommId('sid-1', 'coder')

    const serialized = mgr._serializeSessionEntry('sid-1', mgr._sessions.get('sid-1'))
    assert.equal(serialized.agentCommId, 'coder', 'registered id must persist for restore')

    // A session with no mailbox identity serializes agentCommId: null.
    mgr._sessions.set('sid-2', { session: idleTuiSession(), name: 'Plain', cwd: '/tmp', createdAt: 2 })
    const plain = mgr._serializeSessionEntry('sid-2', mgr._sessions.get('sid-2'))
    assert.equal(plain.agentCommId, null)
  })
})

describe('SessionManager mailbox observability (Control Room snapshot)', () => {
  let mgr
  let tmpDir

  function makeMgr() {
    tmpDir = mkdtempSync(join(tmpdir(), 'sm-mailbox-obs-'))
    mgr = new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: '/tmp',
      stateFilePath: join(tmpDir, 'state.json'),
    })
    return mgr
  }

  afterEach(() => {
    try {
      mgr?._sessions?.clear()
      mgr?.destroyAll?.()
    } catch {
      // best-effort teardown
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    mgr = null
    tmpDir = null
  })

  it('records mailbox events newest-first and ignores malformed ones', () => {
    makeMgr()
    mgr.recordMailboxEvent({ to: 'coder', from: 'alice', unreadCount: 3, outcome: 'injected' })
    mgr.recordMailboxEvent({ to: 'coder', from: 'bob', unreadCount: 1, outcome: 'busy' })
    // Malformed (missing `to` / `outcome`) — ignored, no throw.
    mgr.recordMailboxEvent({ from: 'x' })
    mgr.recordMailboxEvent(null)
    // Negative/fractional unreadCount coerces to null.
    mgr.recordMailboxEvent({ to: 'coder', outcome: 'no-session', unreadCount: -2 })

    const events = mgr.getMailboxEvents()
    assert.equal(events.length, 3)
    assert.equal(events[0].outcome, 'no-session', 'newest first')
    assert.equal(events[0].unreadCount, null)
    assert.equal(events[0].from, 'unknown', 'missing from defaults to unknown')
    assert.equal(events[2].outcome, 'injected', 'oldest last')
    assert.ok(typeof events[0].at === 'number')
  })

  it('caps the ring buffer at MAILBOX_EVENT_LIMIT (oldest dropped)', () => {
    makeMgr()
    const limit = SessionManager.MAILBOX_EVENT_LIMIT
    for (let i = 0; i < limit + 10; i++) {
      mgr.recordMailboxEvent({ to: `m${i}`, outcome: 'injected' })
    }
    const events = mgr.getMailboxEvents()
    assert.equal(events.length, limit)
    // The 10 oldest were dropped; newest is the last recorded.
    assert.equal(events[0].to, `m${limit + 9}`)
    assert.equal(events[limit - 1].to, 'm10')
  })

  it('lists live agentCommId registrations with busy/tui flags, skipping dead sessions', () => {
    makeMgr()
    const tui = idleTuiSession()
    const busyTui = { isRunning: true, writeTerminalInput() { return true } }
    const nonTui = { isRunning: false }
    mgr._sessions.set('sid-1', { session: tui, name: 'Coder' })
    mgr._sessions.set('sid-2', { session: busyTui, name: 'Builder' })
    mgr._sessions.set('sid-3', { session: nonTui, name: 'Sdk' })
    mgr.registerAgentCommId('sid-1', 'coder')
    mgr.registerAgentCommId('sid-2', 'builder')
    mgr.registerAgentCommId('sid-3', 'sdk')
    // An id whose session has gone is skipped.
    mgr._agentCommIds.set('ghost', 'sid-gone')

    const regs = mgr.listAgentCommRegistrations()
    const byId = Object.fromEntries(regs.map((r) => [r.agentCommId, r]))
    assert.equal(regs.length, 3, 'ghost id skipped')
    assert.deepEqual(byId.coder, { agentCommId: 'coder', sessionId: 'sid-1', sessionName: 'Coder', isBusy: false, isTui: true })
    assert.equal(byId.builder.isBusy, true)
    assert.equal(byId.builder.isTui, true)
    assert.equal(byId.sdk.isTui, false)
    assert.equal(byId.sdk.isBusy, false)
  })
})
