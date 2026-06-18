import { describe, it, before, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { removeLogListener } from '../src/logger.js'

/**
 * Regression test for #4787 — scope log_entry broadcasts to unbound clients.
 *
 * Before the fix, the `_logListener` in ws-server.js fell back to
 * `_broadcast()` for any log entry lacking an `entry.sessionId`, sending
 * unscoped server logs (PTY hex dumps, toolUseIds, prompt sizes, attachment
 * names) to EVERY authenticated WS client — including a mobile device paired
 * to a single per-task session, which would receive log lines from other
 * sessions running on the same daemon.
 *
 * After the fix:
 *  - Unscoped log entries (no entry.sessionId) are only sent to clients with
 *    `boundSessionId == null` (operator dashboards) — bound mobile clients no
 *    longer leak cross-session logs.
 *  - Scoped log entries (entry.sessionId set) continue to use
 *    `_broadcastToSession`, which already filters by activeSessionId /
 *    subscribedSessionIds — so bound clients on a different session still
 *    don't see them, and an unbound dashboard sees them only if subscribed.
 */
describe('WsServer._logListener session scoping (#4787)', () => {
  let WsServer
  let server

  before(async () => {
    ;({ WsServer } = await import('../src/ws-server.js'))
  })

  afterEach(() => {
    if (server) {
      try { server.close() } catch {}
      server = null
    }
  })

  function createServer(opts = {}) {
    const mockSessionManager = new EventEmitter()
    mockSessionManager.sessions = new Map()
    mockSessionManager.getSessions = () => []
    mockSessionManager.getSession = () => null
    mockSessionManager.listSessions = () => []

    return new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockSessionManager,
      authRequired: false,
      noEncrypt: true,
      ...opts,
    })
  }

  function createMockWs() {
    return {
      readyState: 1, // OPEN
      bufferedAmount: 0,
      send: mock.fn(),
      close: mock.fn(),
    }
  }

  /**
   * Build a server, run start() to register the real _logListener, then
   * stuff fake clients into server.clients. Returns a helper that returns
   * the list of sent messages keyed by client id.
   *
   * We unregister the global log listener right after start() so that
   * background async logs (e.g. Claude Code Web feature detection) cannot
   * race with the test and inflate `delivered`. The test invokes
   * `server._logListener(...)` directly anyway — the global path is not
   * needed for the assertions and only introduces flake.
   */
  async function setup(clients) {
    server = createServer()
    server.start('127.0.0.1')
    // Wait briefly for HTTP listen — log listener is registered synchronously
    // inside start(), so it's already wired by the time start() returns.
    await new Promise((resolve, reject) => {
      server.httpServer.once('listening', resolve)
      server.httpServer.once('error', reject)
    })

    // Detach from the global log bus so unrelated async logs cannot bleed
    // into the captured deliveries. We still hold the reference on
    // `server._logListener` and call it directly below.
    removeLogListener(server._logListener)

    // Replace _send so we can capture deliveries by client id without going
    // through the encryption / WS wire path.
    const delivered = new Map() // clientId -> [messages]
    server._send = (ws, msg) => {
      const client = server.clients.get(ws)
      if (!client) return
      const list = delivered.get(client.id) || []
      list.push(msg)
      delivered.set(client.id, list)
    }

    for (const c of clients) {
      const ws = createMockWs()
      // #5563: register through the client manager so the sessionId→clients
      // reverse index is seeded. These fixtures pre-set `activeSessionId` /
      // `subscribedSessionIds` on the literal, so after insertion we replay
      // those memberships through the index-maintaining helpers (a fresh
      // `activeSessionId` is detected as a transition from null only if the
      // field starts null — so we seed explicitly).
      c._ws = ws
      const active = c.activeSessionId
      const subs = c.subscribedSessionIds ? [...c.subscribedSessionIds] : []
      c.activeSessionId = null
      c.subscribedSessionIds = new Set()
      server._clientManager.addClient(ws, c)
      if (active) server._clientManager.setActiveSession(c, active)
      for (const sid of subs) server._clientManager.subscribe(c, sid)
    }
    return delivered
  }

  it('drops unscoped log entries for bound clients (does not leak across sessions)', async () => {
    const bound = {
      id: 'mobile-bound-to-sess-1',
      authenticated: true,
      boundSessionId: 'sess-1',
      activeSessionId: 'sess-1',
      subscribedSessionIds: new Set(),
      _backpressureDrops: 0,
    }
    const unboundDashboard = {
      id: 'dashboard-operator',
      authenticated: true,
      boundSessionId: null,
      activeSessionId: null,
      subscribedSessionIds: new Set(),
      _backpressureDrops: 0,
    }

    const delivered = await setup([bound, unboundDashboard])

    // Unscoped entry — no sessionId attached. Pre-fix this fanned out to ALL
    // clients via _broadcast, leaking PTY hex dumps / toolUseIds to the bound
    // mobile client. Post-fix it must reach only unbound clients.
    server._logListener({
      ts: Date.now(),
      level: 'info',
      tag: 'claude-tui-session',
      message: '[pty-tail] aa55bb66cc77 (raw ANSI sequence)',
    })

    const boundMsgs = delivered.get(bound.id) || []
    const dashMsgs = delivered.get(unboundDashboard.id) || []

    const boundLogEntries = boundMsgs.filter((m) => m.type === 'log_entry')
    const dashLogEntries = dashMsgs.filter((m) => m.type === 'log_entry')

    assert.equal(
      boundLogEntries.length,
      0,
      'bound client must NOT receive unscoped log entries (cross-session leak)'
    )
    assert.equal(
      dashLogEntries.length,
      1,
      'unbound dashboard SHOULD still receive unscoped log entries'
    )
    assert.equal(dashLogEntries[0].message, '[pty-tail] aa55bb66cc77 (raw ANSI sequence)')
  })

  it('still routes scoped log entries through _broadcastToSession (session mismatch blocks bound clients on other sessions)', async () => {
    const boundToSess1 = {
      id: 'mobile-bound-to-sess-1',
      authenticated: true,
      boundSessionId: 'sess-1',
      activeSessionId: 'sess-1',
      subscribedSessionIds: new Set(),
      _backpressureDrops: 0,
    }
    const unboundDashboard = {
      id: 'dashboard-operator',
      authenticated: true,
      boundSessionId: null,
      // dashboard happens to be viewing sess-2 right now
      activeSessionId: 'sess-2',
      subscribedSessionIds: new Set(),
      _backpressureDrops: 0,
    }

    const delivered = await setup([boundToSess1, unboundDashboard])

    // Scoped log entry FROM sess-2 (e.g. via withSession('sess-2'))
    server._logListener({
      ts: Date.now(),
      level: 'info',
      tag: 'session-manager',
      message: 'persisted sess-2 state',
      sessionId: 'sess-2',
    })

    const boundMsgs = delivered.get(boundToSess1.id) || []
    const dashMsgs = delivered.get(unboundDashboard.id) || []

    const boundLogEntries = boundMsgs.filter((m) => m.type === 'log_entry')
    const dashLogEntries = dashMsgs.filter((m) => m.type === 'log_entry')

    assert.equal(
      boundLogEntries.length,
      0,
      'bound-to-sess-1 client must not see sess-2 scoped log entries'
    )
    assert.equal(
      dashLogEntries.length,
      1,
      'dashboard with activeSessionId=sess-2 should receive sess-2 scoped log entries'
    )
    assert.equal(dashLogEntries[0].sessionId, 'sess-2')
  })

  it('delivers scoped log entries to bound clients on the matching session', async () => {
    const boundToSess1 = {
      id: 'mobile-bound-to-sess-1',
      authenticated: true,
      boundSessionId: 'sess-1',
      activeSessionId: 'sess-1',
      subscribedSessionIds: new Set(),
      _backpressureDrops: 0,
    }

    const delivered = await setup([boundToSess1])

    server._logListener({
      ts: Date.now(),
      level: 'info',
      tag: 'session-manager',
      message: 'persisted sess-1 state',
      sessionId: 'sess-1',
    })

    const msgs = (delivered.get(boundToSess1.id) || []).filter((m) => m.type === 'log_entry')
    assert.equal(msgs.length, 1, 'bound client should receive scoped log entries for its own session')
    assert.equal(msgs[0].sessionId, 'sess-1')
  })
})
