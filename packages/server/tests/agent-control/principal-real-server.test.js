/**
 * agent-control `--principal` against a REAL, encrypted WsServer (#9121 acceptance:
 * "a principal-mode MCP client reads events and the roster, and every mutation tool
 * is refused"; docs/security/agent-principals.md sections 4.1 and 7).
 *
 * The principal is a real credential: a token inserted into a TEMP store by the S1
 * fixture (no production path can mint one yet), written to a 0600 temp token file
 * and read by the MCP server through CHROXY_AGENT_TOKEN_FILE's resolver. The journal
 * is fed by real broadcasts (`_broadcastToSession`), the tap production uses; the
 * oracle is what the test broadcast. Nothing here reads the real config directory.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { setLogListener } from '../../src/logger.js'
import { PrincipalJournal } from '../../src/principal-journal.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'
import { createMockSessionManager } from '../test-helpers.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from '../helpers/principal-store-fixture.js'

class EncryptedWsServer extends _WsServer {
  constructor(opts = {}) { super({ localhostBypass: false, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const SESSIONS = [
  { id: 'sess-1', name: 'One', cwd: '/tmp/project-1' },
  { id: 'sess-2', name: 'Two', cwd: '/tmp/project-2' },
  { id: 'sess-3', name: 'Three (not granted)', cwd: '/tmp/project-3' },
]
const PRIMARY = 'primary-token-fixture-never-used-by-principal-mode'
const MUTATIONS = [
  ['chroxy_create_session', {}],
  ['chroxy_send_input', { sessionId: 'sess-1', data: 'hello' }],
  ['chroxy_interrupt_session', { sessionId: 'sess-1' }],
  ['chroxy_respond_permission', { sessionId: 'sess-1', requestId: 'r', decision: 'deny' }],
]

describe('agent-control --principal over a real encrypted server', () => {
  let server
  // Teardown runs in three ordered stages, never as one stack: the MCP client side,
  // then the server, then the temp directories. `WsServer.close()` closes the principal
  // journal, which flushes its window and writes the clean meta into `journalDir`; the
  // journal creates that directory once (`_dirMade`) and does not recreate it, so
  // removing the directory BEFORE `server.close()` turns those writes into ENOENT.
  const clientClosers = []
  const tempDirs = []
  let journalWarnings = []
  let stderrLines = []
  let restoreConsole = null

  afterEach(async () => {
    for (const fn of clientClosers.splice(0).reverse()) {
      try { await fn() } catch { /* best effort */ }
    }
    if (server) { server.close(); server = null }
    for (const fn of tempDirs.splice(0).reverse()) {
      try { fn() } catch { /* best effort */ }
    }
    setLogListener(null)
    if (restoreConsole) { restoreConsole(); restoreConsole = null }
    // The shutdown-ordering guard: a journal write that failed during this test or its
    // teardown fails the test. Mutation: move `server.close()` after the temp-dir
    // removal -> 'Principal journal write failed (ENOENT)' is recorded and this throws.
    const failures = journalWarnings.splice(0)
    assert.deepEqual(failures, [], 'no principal journal write failed, teardown included')
  })

  async function boot() {
    // Capture the MCP layer's stderr (console.error) so the token check covers logs too.
    stderrLines = []
    const original = console.error
    console.error = (...args) => { stderrLines.push(args.map(String).join(' ')) }
    restoreConsole = () => { console.error = original }

    const fixture = tempPrincipalDir()
    tempDirs.push(fixture.cleanup)
    const store = testPrincipalStore(fixture.path)
    const { token } = insertPrincipal(store, { principalId: 'pr-1', label: 'indi', scope: 'observe', constraints: { sessionIds: ['sess-1', 'sess-2'] } })
    const journalDir = mkdtempSync(join(tmpdir(), 'chroxy-principal-mcp-journal-'))
    tempDirs.push(() => rmSync(journalDir, { recursive: true, force: true }))
    const journal = new PrincipalJournal({ dir: journalDir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    const { manager } = createMockSessionManager(SESSIONS)
    server = new EncryptedWsServer({ port: 0, apiToken: PRIMARY, sessionManager: manager, authRequired: true, principalStore: store, principalJournal: journal })
    server.start('127.0.0.1')
    await once(server.httpServer, 'listening')
    // After start() (which clears the listeners): record any journal write failure, for
    // the shutdown-ordering assertion in afterEach.
    journalWarnings = []
    setLogListener((entry) => {
      if (entry?.component === 'principal-journal' && /write failed/.test(String(entry.message))) {
        journalWarnings.push(String(entry.message).slice(0, 120))
      }
    })
    const port = server.httpServer.address().port

    const tokenDir = mkdtempSync(join(tmpdir(), 'chroxy-principal-token-'))
    tempDirs.push(() => rmSync(tokenDir, { recursive: true, force: true }))
    const tokenFile = join(tokenDir, 'indi.token')
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    chmodSync(tokenFile, 0o600)

    const { mcp, clientManager } = createAgentControlMcpServer({ principal: true, url: `ws://127.0.0.1:${port}`, tokenFile })
    const sdk = new Client({ name: 'principal-acceptance', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    await sdk.connect(clientTransport)
    clientClosers.push(async () => { await sdk.close(); await mcp.close(); await clientManager.close() })

    const results = []
    const call = async (name, args = {}) => {
      const r = await sdk.callTool({ name, arguments: args })
      results.push(r)
      return r
    }
    return { token, store, call, results, sdk }
  }

  const say = (sid, n) => server._broadcastToSession(sid, { type: 'message', messageType: 'response', content: `m${n}` })
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  it('reads the granted roster and journal, waits for events instead of polling, and refuses every mutation', async () => {
    const { token, call, results, sdk } = await boot()

    const { tools } = await sdk.listTools()
    for (const [name] of MUTATIONS) assert.equal(tools.some((t) => t.name === name), false, `${name} is not advertised`)

    const roster = await call('chroxy_list_sessions')
    assert.equal(roster.isError, undefined, JSON.stringify(roster.structuredContent).slice(0, 300))
    assert.deepEqual(roster.structuredContent.sessions.map((s) => s.sessionId).sort(), ['sess-1', 'sess-2'], 'only granted sessions')

    for (let i = 1; i <= 3; i++) say('sess-1', i)
    const page = await call('chroxy_get_events', { sessionId: 'sess-1' })
    assert.deepEqual(page.structuredContent.events.map((e) => e.seq), [1, 2, 3])
    assert.deepEqual(page.structuredContent.events.map((e) => e.data.content), ['m1', 'm2', 'm3'])
    const cursor = page.structuredContent.cursor
    assert.equal(typeof cursor, 'string')

    // A wait wakes on an event emitted while it is blocked.
    const started = Date.now()
    const waiting = call('chroxy_wait_events', { sessionIds: ['sess-1'], cursors: [cursor], timeoutMs: 10_000 })
    await delay(150)
    say('sess-1', 4)
    const woke = await waiting
    assert.equal(woke.structuredContent.timedOut, false)
    assert.deepEqual(woke.structuredContent.events.map((e) => e.seq), [4])
    assert.ok(Date.now() - started < 5_000, 'woke on the event, not at the timeout')

    // With nothing new, it times out with no events and the cursor unchanged. The
    // returned `cursors` array is passed back verbatim (the round trip a supervisor does).
    assert.ok(Array.isArray(woke.structuredContent.cursors))
    const idle = await call('chroxy_wait_events', { sessionIds: ['sess-1'], cursors: woke.structuredContent.cursors, timeoutMs: 300 })
    assert.equal(idle.structuredContent.timedOut, true)
    assert.deepEqual(idle.structuredContent.events, [])
    assert.deepEqual(idle.structuredContent.cursors, woke.structuredContent.cursors)

    const pending = await call('chroxy_pending_permissions')
    assert.equal(pending.isError, undefined)
    assert.ok(Array.isArray(pending.structuredContent.permissions))

    // Scope is the daemon's: a non-granted session is refused, not read.
    const denied = await call('chroxy_get_events', { sessionId: 'sess-3' })
    assert.equal(denied.isError, true)
    assert.equal(denied.structuredContent.code, 'scope_denied')

    for (const [name, args] of MUTATIONS) {
      const r = await call(name, args)
      assert.equal(r.structuredContent.code, 'READ_ONLY_MODE', name)
    }

    const everything = JSON.stringify(results) + '\n' + stderrLines.join('\n')
    assert.equal(everything.includes(token), false, 'the principal token is in no tool result or log line')
    assert.equal(everything.includes(PRIMARY), false, 'the primary token never appears either')
  })

  // Revocation is not pushed to an idle connection: the daemon cuts a revoked principal
  // (4401) the next time it checks that connection, on the next frame the principal
  // sends or at the keepalive sweep. This test drives that check with a probe call; a
  // wait with no other traffic would instead end at the sweep or at its own timeout.
  it('after revocation, the next frame the principal sends ends a blocked wait with an error, and the next call cannot authenticate', async () => {
    const { token, store, call, results } = await boot()
    say('sess-1', 1)
    const first = await call('chroxy_get_events', { sessionId: 'sess-1' })
    const waiting = call('chroxy_wait_events', { sessionIds: ['sess-1'], cursors: [first.structuredContent.cursor], timeoutMs: 60_000 })
    await delay(150)
    const started = Date.now()
    store.revoke({ principalId: 'pr-1' })
    // The probe: the next inbound frame on the connection is re-checked and ends it 4401.
    const probe = await call('chroxy_list_sessions')
    assert.equal(probe.isError, true)
    const ended = await waiting
    assert.equal(ended.isError, true, 'the wait ends with an error, not a hang or a fake timeout')
    assert.ok(Date.now() - started < 10_000, 'well before the 60 s wait timeout')

    const after = await call('chroxy_list_sessions')
    assert.equal(after.isError, true)
    assert.equal(after.structuredContent.code, 'AUTH_FAILED', 'a revoked token cannot reconnect')

    const everything = JSON.stringify(results) + '\n' + stderrLines.join('\n')
    assert.equal(everything.includes(token), false, 'no token on any failure path')
  })
})
