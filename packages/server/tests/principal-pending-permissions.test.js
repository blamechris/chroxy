/**
 * The agent principal's pending-permission snapshot (`principal_pending_permissions`;
 * docs/security/agent-principals.md section 7.3; #9119, S4 of #9112; advances #7860).
 *
 * The pipelines are real: an in-process PermissionManager wired onto a session exactly as the
 * SDK / BYOK / Codex sessions wire theirs (`wirePermissionManager`), and hook-routed prompts
 * raised by POSTing to the real server's `/permission` with a session's hook secret. The
 * principal is a real credential from the S1 fixture, presented at `auth` over a real socket.
 * The oracle is what the test itself raised, never what the module reports.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PermissionManager, wirePermissionManager } from '../src/permission-manager.js'
import { PrincipalJournal } from '../src/principal-journal.js'
import { collectPendingPermissions, PRINCIPAL_PENDING_PERMISSIONS_MAX, PENDING_DESCRIPTION_MAX } from '../src/principal-pending-permissions.js'
import { frameForPrincipal, PRINCIPAL_OUTGOING_DENIED, PRINCIPAL_PENDING_PERMISSION_FIELDS } from '../src/principal-policy.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'
import { PRINCIPAL_PENDING_PERMISSIONS_MAX as PROTOCOL_MAX, ServerPrincipalPendingPermissionsResultSchema } from '@chroxy/protocol'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const silentLog = { info() {}, warn() {} }
const PRIMARY = 'primary-tok'
const SESSIONS = [
  { id: 'sess-1', name: 'One (in-process)', cwd: '/tmp/project-1' },
  { id: 'sess-2', name: 'Two (hook-routed)', cwd: '/tmp/project-2' },
  { id: 'sess-3', name: 'Three (not granted)', cwd: '/tmp/project-3' },
]
const HOOK_SECRETS = { 'sess-2': 'hook-secret-2', 'sess-3': 'hook-secret-3' }
const FLOORED_INPUT_MARK = 'FLOORED-INPUT-MARKER-8841'

describe('principal_pending_permissions over a real server', () => {
  let server
  let journalDir
  const cleanups = []
  const sockets = []
  const managers = []
  const held = []
  afterEach(async () => {
    for (const pm of managers.splice(0)) pm.destroy()
    // Release every hook-held request so the HTTP calls end, pass or fail.
    if (server) for (const pending of [...server._pendingPermissions.values()]) { try { pending.resolve('deny') } catch { /* gone */ } }
    await Promise.allSettled(held.splice(0))
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
    while (cleanups.length) cleanups.pop()()
  })

  async function boot({ constraints = { sessionIds: ['sess-1', 'sess-2'] }, scope = 'observe', second = null, withJournal = false } = {}) {
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const store = testPrincipalStore(fixture.path)
    const { token } = insertPrincipal(store, { principalId: 'pr-1', label: 'planner', scope, constraints })
    const other = second ? insertPrincipal(store, { principalId: 'pr-2', label: 'sibling-planner', scope: 'observe', constraints: second }) : null
    let journal = null
    if (withJournal) {
      journalDir = mkdtempSync(join(tmpdir(), 'chroxy-pending-journal-'))
      cleanups.push(() => rmSync(journalDir, { recursive: true, force: true }))
      journal = new PrincipalJournal({ dir: journalDir, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    }
    const { manager, sessionsMap } = createMockSessionManager(SESSIONS)
    manager._sessions = sessionsMap
    for (const [id, secret] of Object.entries(HOOK_SECRETS)) {
      // A hook-routed (CLI / TUI) session has no in-process PermissionManager to answer with.
      sessionsMap.get(id).session._hookSecret = secret
      sessionsMap.get(id).session.respondToPermission = undefined
    }
    server = new WsServer({ port: 0, apiToken: PRIMARY, sessionManager: manager, authRequired: true, principalStore: store, principalJournal: journal })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return { port: server.httpServer.address().port, token, otherToken: other?.token, store, sessionsMap, journal }
  }

  /** A real PermissionManager wired onto a session the way the SDK session wires its own. */
  function attach(sessionsMap, sessionId, opts = {}) {
    const session = sessionsMap.get(sessionId).session
    const pm = new PermissionManager({ log: silentLog, cwd: session.cwd, ...opts })
    wirePermissionManager(session, pm)
    managers.push(pm)
    return pm
  }

  /** Raise an in-process prompt and return its request id (the promise is left pending). */
  function raiseInProcess(pm, tool, input) {
    const before = new Set(pm._pendingPermissions.keys())
    const decision = pm.handlePermission(tool, input, null, 'approve')
    decision.catch(() => {})
    const requestId = [...pm._pendingPermissions.keys()].find((id) => !before.has(id))
    assert.ok(requestId, `precondition: ${tool} prompt is pending`)
    return requestId
  }

  /** Raise a hook-routed prompt through the real HTTP handler; resolves with its request id. */
  async function raiseHook(port, sessionId, toolName, toolInput) {
    const before = new Set(server._pendingPermissions.keys())
    held.push(fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HOOK_SECRETS[sessionId]}` },
      body: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    }).catch(() => {}))
    return waitFor(() => [...server._pendingPermissions.keys()].find((id) => !before.has(id)), { label: `hook prompt on ${sessionId}` })
  }

  async function open(port, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    const messages = []
    ws.on('message', (d) => { try { const { seq: _s, ...frame } = JSON.parse(d.toString()); messages.push(frame) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    messages.length = 0
    return { ws, messages, send: (m) => ws.send(JSON.stringify(m)) }
  }

  let nextRequest = 0
  /** Ask for a snapshot; returns the reply (the result frame, or the refusal that carries the requestId). */
  async function snapshot(c, sessionIds) {
    const requestId = `snap-${++nextRequest}`
    c.send({ type: 'principal_pending_permissions', requestId, ...(sessionIds === undefined ? {} : { sessionIds }) })
    return waitFor(() => c.messages.find((m) => m.requestId === requestId && (m.type === 'principal_pending_permissions_result' || m.type === 'session_error')), { label: `reply to ${requestId}` })
  }
  const idsOf = (reply) => reply.permissions.map((p) => p.requestId).sort()

  describe('both pipelines, canonical state', () => {
    it('lists an in-process request and a hook-routed one, each with its verdicts and a real deadline', async () => {
      const { port, token, sessionsMap } = await boot()
      const pm = attach(sessionsMap, 'sess-1', { timeoutMs: 120_000 })
      const inProcess = raiseInProcess(pm, 'Bash', { command: 'ls -la' })
      const hook = await raiseHook(port, 'sess-2', 'Bash', { command: 'echo hello' })
      const c = await open(port, token)
      const before = Date.now()
      const reply = await snapshot(c)
      const after = Date.now()

      assert.equal(reply.type, 'principal_pending_permissions_result')
      assert.equal(reply.truncated, false)
      assert.ok(reply.generatedAt >= before && reply.generatedAt <= after, 'generatedAt is the read time')
      assert.deepEqual(idsOf(reply), [inProcess, hook].sort())
      const a = reply.permissions.find((p) => p.requestId === inProcess)
      const b = reply.permissions.find((p) => p.requestId === hook)
      assert.deepEqual(
        { sessionId: a.sessionId, tool: a.tool, floored: a.floored, explicitConsent: a.explicitConsent, nonDelegable: a.nonDelegable, origin: a.origin },
        { sessionId: 'sess-1', tool: 'Bash', floored: false, explicitConsent: false, nonDelegable: false, origin: 'in_process' },
      )
      assert.deepEqual(
        { sessionId: b.sessionId, tool: b.tool, floored: b.floored, explicitConsent: b.explicitConsent, nonDelegable: b.nonDelegable, origin: b.origin },
        { sessionId: 'sess-2', tool: 'Bash', floored: false, explicitConsent: false, nonDelegable: false, origin: 'hook' },
      )
      // the real deadline: created + the request's own window (in-process: the manager's 120 s; hook: its 300 s decision window)
      assert.equal(a.expiresAt - a.createdAt, 120_000)
      assert.equal(b.expiresAt - b.createdAt, 300_000)
      for (const p of [a, b]) {
        assert.ok(p.createdAt <= reply.generatedAt, 'raised before the read')
        assert.ok(p.expiresAt > reply.generatedAt, 'and not yet expired at the read')
      }
      assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse(reply).success, true, 'the frame passes its protocol schema')
    })

    it('a floored request carries NO description and NO input; an ordinary one a bounded, sanitised description and still no input', async () => {
      const { port, token, sessionsMap } = await boot()
      const pm = attach(sessionsMap, 'sess-1')
      const longCommand = `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" ${'x'.repeat(400)}`
      const flooredIn = raiseInProcess(pm, 'Write', { file_path: '/tmp/project-1/.git/config', content: FLOORED_INPUT_MARK })
      const plainIn = raiseInProcess(pm, 'Bash', { command: longCommand })
      const flooredHook = await raiseHook(port, 'sess-2', 'Write', { file_path: '/tmp/project-2/.git/config', content: `${FLOORED_INPUT_MARK}-hook` })
      const plainHook = await raiseHook(port, 'sess-2', 'Bash', { command: longCommand })
      const c = await open(port, token)
      const reply = await snapshot(c)
      const by = (id) => reply.permissions.find((p) => p.requestId === id)

      for (const id of [flooredIn, flooredHook]) {
        assert.equal(by(id).floored, true, `${id} is floored`)
        assert.equal('description' in by(id), false, 'a floored request has no description')
      }
      for (const id of [plainIn, plainHook]) {
        assert.equal(by(id).floored, false)
        const d = by(id).description
        assert.equal(typeof d, 'string')
        assert.ok(d.length > 0 && d.length <= PENDING_DESCRIPTION_MAX, `bounded (${d.length})`)
        assert.equal(d.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false, 'the credential in the command is redacted')
      }
      // Never the input, in any form, for any request.
      const wireText = JSON.stringify(reply)
      assert.equal(wireText.includes(FLOORED_INPUT_MARK), false, 'the floored input never reaches the principal')
      for (const p of reply.permissions) {
        for (const key of ['input', 'toolInput', 'tool_input', 'recordDescription', 'suggestions', 'editedInput']) assert.equal(key in p, false, `${key} on ${p.requestId}`)
        for (const key of Object.keys(p)) assert.ok(PRINCIPAL_PENDING_PERMISSION_FIELDS.includes(key), `unexpected field ${key}`)
      }
    })

    it('an explicit-consent request is listed as consent-gated, floored, not delegable, with no description', async () => {
      const { port, token, sessionsMap } = await boot()
      const pm = attach(sessionsMap, 'sess-1')
      const consent = pm.requestExplicitConsent({
        requestId: 'consent-1', clientId: 'client-9', tool: 'dev_preview', input: { target: FLOORED_INPUT_MARK }, description: 'Publish a preview on port 3000',
      })
      consent.catch(() => {})
      const c = await open(port, token)
      const reply = await snapshot(c)
      const p = reply.permissions.find((x) => x.requestId === 'consent-1')
      assert.deepEqual(
        { floored: p.floored, explicitConsent: p.explicitConsent, nonDelegable: p.nonDelegable, tool: p.tool, origin: p.origin },
        { floored: true, explicitConsent: true, nonDelegable: true, tool: 'dev_preview', origin: 'in_process' },
      )
      assert.equal('description' in p, false)
      assert.equal(JSON.stringify(reply).includes(FLOORED_INPUT_MARK), false)
      assert.equal(JSON.stringify(reply).includes('client-9'), false, 'the bound client is not named')
    })

    it('resolved requests are excluded, in both pipelines', async () => {
      const { port, token, sessionsMap } = await boot()
      const pm = attach(sessionsMap, 'sess-1')
      const a = raiseInProcess(pm, 'Bash', { command: 'ls' })
      const b = raiseInProcess(pm, 'Bash', { command: 'pwd' })
      const h1 = await raiseHook(port, 'sess-2', 'Bash', { command: 'ls' })
      const h2 = await raiseHook(port, 'sess-2', 'Bash', { command: 'pwd' })
      const c = await open(port, token)
      assert.deepEqual(idsOf(await snapshot(c)), [a, b, h1, h2].sort())

      assert.equal(pm.respondToPermission(a, 'allow'), true)
      server._pendingPermissions.get(h1).resolve('deny')
      assert.deepEqual(idsOf(await snapshot(c)), [b, h2].sort(), 'what was answered is gone from both')

      pm.clearAll()
      await waitFor(() => !server._pendingPermissions.has(h2) || (server._pendingPermissions.get(h2).resolve('deny'), true), { label: 'release hook' })
      assert.deepEqual((await snapshot(c)).permissions, [])
    })

    it('an expired request is excluded: once its timer fires, and BEFORE it fires when its own deadline has passed', async () => {
      const { port, token, sessionsMap } = await boot()
      const pm = attach(sessionsMap, 'sess-1', { timeoutMs: 150 })
      const fast = raiseInProcess(pm, 'Bash', { command: 'ls' })
      const c = await open(port, token)
      const first = await snapshot(c)
      assert.deepEqual(idsOf(first), [fast])
      assert.ok(first.permissions[0].expiresAt > first.generatedAt)
      await waitFor(() => !pm._pendingPermissions.has(fast), { label: 'timer expiry', timeoutMs: 3000 })
      assert.deepEqual((await snapshot(c)).permissions, [], 'expired during the gap between two reads: not offered')

      // The timer has not fired yet but the deadline is behind us (a stalled event loop): still excluded.
      const pm2 = attach(sessionsMap, 'sess-2', { timeoutMs: 120_000 })
      const late = raiseInProcess(pm2, 'Bash', { command: 'ls' })
      pm2._lastPermissionData.get(late).createdAt -= 120_001
      assert.equal(pm2._pendingPermissions.has(late), true, 'precondition: still pending in the manager')
      assert.deepEqual((await snapshot(c)).permissions, [], 'a request past its own deadline is not pending')
    })
  })

  describe('scope: every id granted, or nothing', () => {
    it('a sibling session is refused scope_denied, exactly as a session that does not exist is', async () => {
      const { port, token, sessionsMap } = await boot()
      raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      await raiseHook(port, 'sess-3', 'Bash', { command: 'echo sibling' })
      const c = await open(port, token)

      const sibling = await snapshot(c, ['sess-3'])
      const nowhere = await snapshot(c, ['no-such-session'])
      assert.equal(sibling.type, 'session_error')
      assert.equal(sibling.code, 'scope_denied')
      const strip = ({ requestId: _r, ...rest }) => rest
      assert.deepEqual(strip(sibling), strip(nowhere), 'a refusal is indistinguishable from a nonexistent session')
      assert.equal(JSON.stringify(sibling).includes('sess-3'), false, 'the refused id is not echoed')
    })

    it('a multi-id request is all-or-nothing: one id not granted refuses the whole thing and returns nothing', async () => {
      const { port, token, sessionsMap } = await boot()
      const granted = raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      const c = await open(port, token)
      assert.deepEqual(idsOf(await snapshot(c, ['sess-1'])), [granted], 'precondition: the granted one alone is served')
      for (const ids of [['sess-1', 'sess-3'], ['sess-3', 'sess-1'], ['sess-1', 'no-such-session']]) {
        c.messages.length = 0
        const reply = await snapshot(c, ids)
        assert.equal(reply.type, 'session_error', ids.join())
        assert.equal(reply.code, 'scope_denied')
        assert.equal(c.messages.some((m) => m.type === 'principal_pending_permissions_result'), false, 'no partial result')
      }
    })

    it('with no sessionIds the reply covers only the granted sessions, never a sibling', async () => {
      const { port, token, sessionsMap } = await boot()
      const a = raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      const b = await raiseHook(port, 'sess-2', 'Bash', { command: 'ls' })
      const sibling = await raiseHook(port, 'sess-3', 'Bash', { command: 'echo sibling' })
      const c = await open(port, token)
      const reply = await snapshot(c)
      assert.deepEqual(idsOf(reply), [a, b].sort())
      assert.equal(idsOf(reply).includes(sibling), false)
      assert.equal(JSON.stringify(reply).includes('sess-3'), false)
    })

    it('a cwd-root grant covers the sessions under it, and an empty grant gets an empty snapshot, not a refusal', async () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-pending-root-'))
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      const under = join(root, 'project')
      mkdirSync(under)
      const { port, token, sessionsMap } = await boot({ constraints: { cwdRoots: [root] } })
      sessionsMap.get('sess-2').cwd = under // the grant is by directory: only this session lives under the root
      raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      const hook = await raiseHook(port, 'sess-2', 'Bash', { command: 'ls' })
      const c = await open(port, token)
      assert.deepEqual(idsOf(await snapshot(c)), [hook])
      assert.equal((await snapshot(c, ['sess-1'])).code, 'scope_denied', 'a session outside the root is refused by id')
    })

    it('a grant that covers no live session gets an empty snapshot, not a refusal', async () => {
      const { port, token, sessionsMap } = await boot({ constraints: { sessionIds: ['not-a-session'] } })
      raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      const c = await open(port, token)
      const reply = await snapshot(c)
      assert.equal(reply.type, 'principal_pending_permissions_result')
      assert.deepEqual(reply.permissions, [])
      assert.equal(reply.truncated, false)
    })

    it('the observe tier suffices; a client that is not a principal is refused, bound or not', async () => {
      const { port, token, sessionsMap } = await boot({ scope: 'observe' })
      raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      const principal = await open(port, token)
      assert.equal((await snapshot(principal)).type, 'principal_pending_permissions_result')

      const primary = await open(port, PRIMARY)
      const refused = await snapshot(primary, ['sess-1'])
      assert.equal(refused.type, 'session_error')
      assert.equal(refused.code, 'scope_denied')
      assert.equal(primary.messages.some((m) => m.type === 'principal_pending_permissions_result'), false)
    })

    it('the closed envelope: any extra field, an empty list, or no requestId is refused at dispatch', async () => {
      const { port, token, sessionsMap } = await boot()
      raiseInProcess(attach(sessionsMap, 'sess-1'), 'Bash', { command: 'ls' })
      const c = await open(port, token)
      const bad = [
        { type: 'principal_pending_permissions', requestId: 'e1', includeInput: true },
        { type: 'principal_pending_permissions', requestId: 'e2', input: true },
        { type: 'principal_pending_permissions', requestId: 'e3', sessionIds: [] },
        { type: 'principal_pending_permissions', sessionIds: ['sess-1'] },
        { type: 'principal_pending_permissions', requestId: 'e5', sessionIds: ['sess-1', 'sess-1'] },
      ]
      for (const m of bad) {
        c.messages.length = 0
        c.send(m)
        // A round trip on the same socket: once the pong is back, anything the daemon was going
        // to answer with has been answered. (A message the schema rejects gets an `error` frame
        // a principal is never sent, so a refusal is the absence of any result, not a reply.)
        c.send({ type: 'ping' })
        await waitFor(() => c.messages.find((x) => x.type === 'pong'), { label: `pong after ${JSON.stringify(m)}` })
        assert.equal(c.messages.some((x) => x.type === 'principal_pending_permissions_result'), false, JSON.stringify(m))
      }
    })
  })

  describe('recovery (#7860): the snapshot restores what an event-only reader lost', () => {
    it('a principal that connects AFTER the prompts were raised recovers them from the snapshot; the events alone cannot', async () => {
      const { port, token, sessionsMap, journal } = await boot({ withJournal: true })
      const pm = attach(sessionsMap, 'sess-1')
      const a = raiseInProcess(pm, 'Bash', { command: 'ls' })
      const b = await raiseHook(port, 'sess-2', 'Write', { file_path: '/tmp/project-2/.git/config', content: 'x' })

      // The principal was not around (or its cursor was evicted, or its process restarted):
      // the journal never saw these prompts as events, so no replay can name them.
      const c = await open(port, token)
      c.send({ type: 'principal_events_read', requestId: 'ev', sessionId: 'sess-1' })
      const page = await waitFor(() => c.messages.find((m) => m.type === 'principal_events_page'), { label: 'events page' })
      assert.equal(page.events.some((e) => e.eventType === 'permission_request'), false, 'precondition: the journal holds no permission_request')
      assert.equal(journal.head('sess-1').headSeq, 0)

      const reply = await snapshot(c)
      assert.deepEqual(idsOf(reply), [a, b].sort(), 'the canonical-state read recovers both')
      assert.equal(reply.permissions.find((p) => p.requestId === b).floored, true)
    })

    it('ordinary event delivery still works beside it (the snapshot replaces nothing)', async () => {
      const { port, token, sessionsMap } = await boot({ withJournal: true })
      const pm = attach(sessionsMap, 'sess-1')
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'sub', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'), { label: 'fence' })
      const id = raiseInProcess(pm, 'Bash', { command: 'ls' })
      server._broadcastToSession('sess-1', { type: 'permission_request', requestId: id, tool: 'Bash', description: 'ls', input: { command: 'ls' }, remainingMs: 1, floored: false, explicitConsent: false, nonDelegable: false })
      const ev = await waitFor(() => c.messages.find((m) => m.type === 'principal_event' && m.eventType === 'permission_request'), { label: 'permission_request event' })
      assert.equal(ev.data.requestId, id)
      assert.equal('input' in ev.data, false, 'the journal never carries the input')
      assert.deepEqual(idsOf(await snapshot(c)), [id])
    })

    it('two simultaneous forks of one planner, and a sibling planner, each read the same canonical state without touching it', async () => {
      // #7860: "two simultaneous forks". A planner that forks (a second process holding the same
      // credential) must not be able to race the first one into a different view, consume
      // the pending state by reading it, or fork the decision authority.
      const { port, token, otherToken, sessionsMap } = await boot({ second: { sessionIds: ['sess-2'] } })
      const pm = attach(sessionsMap, 'sess-1')
      const a = raiseInProcess(pm, 'Bash', { command: 'ls' })
      const b = await raiseHook(port, 'sess-2', 'Bash', { command: 'ls' })
      const stateBefore = () => JSON.stringify({
        inProcess: [...pm._pendingPermissions.keys()], timers: pm._permissionTimers.size,
        hook: [...server._pendingPermissions.keys()], routes: [...server._permissionSessionMap.entries()],
      })
      const before = stateBefore()

      const forkA = await open(port, token)
      const forkB = await open(port, token)
      const sibling = await open(port, otherToken)
      const [ra, rb, rs] = await Promise.all([snapshot(forkA), snapshot(forkB), snapshot(sibling)])
      assert.deepEqual(idsOf(ra), [a, b].sort())
      assert.deepEqual(idsOf(rb), idsOf(ra), 'both forks see the same requests')
      assert.deepEqual(rb.permissions, ra.permissions, 'and the same description of each')
      assert.deepEqual(idsOf(rs), [b], 'the sibling planner sees only the session it was granted')
      assert.equal(stateBefore(), before, 'reading changed nothing: no request was consumed, extended or rerouted')

      // One fork acts on what it saw; the other converges on the new truth.
      pm.respondToPermission(a, 'deny')
      const [ra2, rb2] = await Promise.all([snapshot(forkA), snapshot(forkB)])
      assert.deepEqual(idsOf(ra2), [b])
      assert.deepEqual(idsOf(rb2), [b])
    })

    it('the snapshot grants no decision authority: an answer from the principal is refused and the request stays pending', async () => {
      const { port, token, sessionsMap } = await boot({ scope: 'answer' })
      const pm = attach(sessionsMap, 'sess-1')
      const a = raiseInProcess(pm, 'Bash', { command: 'ls' })
      const b = await raiseHook(port, 'sess-2', 'Bash', { command: 'ls' })
      const c = await open(port, token)
      assert.deepEqual(idsOf(await snapshot(c)), [a, b].sort(), 'it can see both')

      for (const requestId of [a, b]) {
        c.messages.length = 0
        c.send({ type: 'permission_response', sessionId: requestId === a ? 'sess-1' : 'sess-2', requestId, decision: 'deny', leaseId: 'L1', gen: 1 })
        const refusal = await waitFor(() => c.messages.find((m) => m.type === 'session_error'), { label: `answer refusal for ${requestId}` })
        assert.equal(refusal.code, 'scope_denied')
      }
      assert.equal(pm._pendingPermissions.has(a), true, 'the in-process request was not answered')
      assert.equal(server._pendingPermissions.has(b), true, 'the hook-routed request was not answered')
      assert.deepEqual(idsOf(await snapshot(c)), [a, b].sort(), 'both are still pending')
    })
  })

  describe('bounds', () => {
    it('a reply carries at most the cap, oldest first, and says it was cut', async () => {
      assert.equal(PRINCIPAL_PENDING_PERMISSIONS_MAX, 100)
      assert.equal(PROTOCOL_MAX, PRINCIPAL_PENDING_PERMISSIONS_MAX, 'the daemon and the protocol schema share one cap')
      const { port, token, sessionsMap } = await boot()
      const pm = attach(sessionsMap, 'sess-1', { timeoutMs: 120_000 })
      const raised = []
      for (let i = 0; i < PRINCIPAL_PENDING_PERMISSIONS_MAX + 5; i++) raised.push(raiseInProcess(pm, 'Bash', { command: `echo ${i}` }))
      // distinct, ordered creation times (the oracle is the order the test raised them in)
      raised.forEach((id, i) => { pm._lastPermissionData.get(id).createdAt = Date.now() - 100_000 + i })
      const c = await open(port, token)
      const reply = await snapshot(c)
      assert.equal(reply.permissions.length, PRINCIPAL_PENDING_PERMISSIONS_MAX)
      assert.equal(reply.truncated, true)
      assert.deepEqual(reply.permissions.map((p) => p.requestId), raised.slice(0, PRINCIPAL_PENDING_PERMISSIONS_MAX), 'oldest first, the newest five are the ones cut')
      assert.equal(ServerPrincipalPendingPermissionsResultSchema.safeParse(reply).success, true)

      // exactly at the cap is not truncated
      for (const id of raised.slice(PRINCIPAL_PENDING_PERMISSIONS_MAX)) pm.respondToPermission(id, 'deny')
      const exact = await snapshot(c)
      assert.equal(exact.permissions.length, PRINCIPAL_PENDING_PERMISSIONS_MAX)
      assert.equal(exact.truncated, false)
    })
  })

  describe('permission_resolved reaches a principal only through the journal, carrying resolvedBy', () => {
    it('permission_resolved is not a direct principal frame, and the journal keeps resolvedBy and no input', async () => {
      assert.ok(PRINCIPAL_OUTGOING_DENIED.includes('permission_resolved'))
      const granted = { id: 'p', principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } }, boundSessionId: 'sentinel' }
      assert.equal(frameForPrincipal(granted, { type: 'permission_resolved', requestId: 'r', decision: 'allow', sessionId: 'sess-1', resolvedBy: { kind: 'user' } }, { sessionExists: () => true }), null)

      const { port, token } = await boot({ withJournal: true })
      const c = await open(port, token)
      c.send({ type: 'principal_subscribe', requestId: 'sub', sessionIds: ['sess-1'] })
      await waitFor(() => c.messages.find((m) => m.type === 'principal_live_fence'), { label: 'fence' })
      server._broadcastToSession('sess-1', { type: 'permission_resolved', requestId: 'perm-x', decision: 'deny', reason: 'timeout', resolvedBy: { kind: 'timeout' }, sessionId: 'sess-1' })
      const ev = await waitFor(() => c.messages.find((m) => m.type === 'principal_event' && m.eventType === 'permission_resolved'), { label: 'permission_resolved event' })
      assert.deepEqual(ev.data.resolvedBy, { kind: 'timeout' })
      assert.equal(ev.data.decision, 'deny')
      assert.equal('input' in ev.data, false)
    })
  })
})

describe('collectPendingPermissions (unit, over the real stores)', () => {
  const managers = []
  afterEach(() => { for (const pm of managers.splice(0)) pm.destroy() })
  const mgr = (opts = {}) => { const pm = new PermissionManager({ log: silentLog, cwd: '/tmp/p', ...opts }); managers.push(pm); return pm }
  const holder = (pm) => { const h = new EventEmitter(); wirePermissionManager(h, pm); return h }
  const manager = (map) => ({ getSession: (id) => (map[id] ? { session: map[id] } : null) })

  it('reads the pending requests of exactly the sessions it is given', () => {
    const pm1 = mgr(); const pm2 = mgr()
    pm1.handlePermission('Bash', { command: 'a' }, null, 'approve')
    pm2.handlePermission('Bash', { command: 'b' }, null, 'approve')
    const sm = manager({ s1: holder(pm1), s2: holder(pm2) })
    const one = collectPendingPermissions({ sessionIds: ['s1'], sessionManager: sm })
    assert.deepEqual(one.permissions.map((p) => p.sessionId), ['s1'])
    const both = collectPendingPermissions({ sessionIds: ['s1', 's2'], sessionManager: sm })
    assert.deepEqual(both.permissions.map((p) => p.sessionId).sort(), ['s1', 's2'])
    assert.deepEqual(collectPendingPermissions({ sessionIds: [], sessionManager: sm }).permissions, [])
  })

  it('describes a request by its whitelisted fields only: never the tool input, whatever the pipeline held', () => {
    const pm = mgr()
    pm.handlePermission('Write', { file_path: '/tmp/p/.git/config', content: FLOORED_INPUT_MARK }, null, 'approve')
    pm.handlePermission('Bash', { command: `echo ${FLOORED_INPUT_MARK}` }, null, 'approve')
    const hookData = { requestId: 'h-1', tool: 'Bash', description: 'ls', input: { command: FLOORED_INPUT_MARK }, remainingMs: 300_000, createdAt: Date.now(), floored: false, explicitConsent: false, nonDelegable: false }
    const { permissions } = collectPendingPermissions({
      sessionIds: ['s1'], sessionManager: manager({ s1: holder(pm) }),
      pendingPermissions: new Map([['h-1', { data: hookData }]]), permissionSessionMap: new Map([['h-1', 's1']]),
    })
    assert.equal(permissions.length, 3, 'both pipelines were read')
    for (const p of permissions) {
      for (const key of Object.keys(p)) assert.ok(PRINCIPAL_PENDING_PERMISSION_FIELDS.includes(key), `unexpected field ${key}`)
      for (const key of ['input', 'toolInput', 'tool_input', 'suggestions', 'recordDescription']) assert.equal(key in p, false, key)
      if (p.floored) assert.equal('description' in p, false, 'a floored request has no description')
    }
    assert.equal(permissions.some((p) => p.floored), true)
    assert.equal(permissions.some((p) => !p.floored && typeof p.description === 'string'), true)
    // the marker may appear only inside an ordinary request's description (the command text), never in a floored one
    assert.equal(JSON.stringify(permissions.filter((p) => p.floored)).includes(FLOORED_INPUT_MARK), false)
  })

  it('fails closed on missing metadata: a pending request with no payload reads as floored, consent-gated and not delegable, with no description', () => {
    const pm = mgr()
    pm.handlePermission('Bash', { command: 'a' }, null, 'approve')
    const [id] = pm._pendingPermissions.keys()
    pm._lastPermissionData.delete(id) // the invariant the manager keeps in lockstep, broken on purpose
    const [p] = collectPendingPermissions({ sessionIds: ['s1'], sessionManager: manager({ s1: holder(pm) }) }).permissions
    assert.deepEqual(
      { requestId: p.requestId, tool: p.tool, floored: p.floored, explicitConsent: p.explicitConsent, nonDelegable: p.nonDelegable, createdAt: p.createdAt, expiresAt: p.expiresAt },
      { requestId: id, tool: 'unknown', floored: true, explicitConsent: true, nonDelegable: true, createdAt: null, expiresAt: null },
    )
    assert.equal('description' in p, false)
    // and a payload that says nothing about the floor reads as floored too
    const pm2 = mgr()
    pm2.handlePermission('Bash', { command: 'a' }, null, 'approve')
    const [id2] = pm2._pendingPermissions.keys()
    delete pm2._lastPermissionData.get(id2).floored
    const [q] = collectPendingPermissions({ sessionIds: ['s1'], sessionManager: manager({ s1: holder(pm2) }) }).permissions
    assert.equal(q.floored, true)
    assert.equal('description' in q, false)
  })

  it('excludes a request at or before its deadline, and keeps one a millisecond inside it', () => {
    const pm = mgr({ timeoutMs: 60_000 })
    pm.handlePermission('Bash', { command: 'a' }, null, 'approve')
    const [id] = pm._pendingPermissions.keys()
    const { createdAt } = pm._lastPermissionData.get(id)
    const sm = manager({ s1: holder(pm) })
    const at = (now) => collectPendingPermissions({ sessionIds: ['s1'], sessionManager: sm, now }).permissions.length
    assert.equal(at(createdAt + 59_999), 1)
    assert.equal(at(createdAt + 60_000), 0, 'the deadline itself is expired')
    assert.equal(at(createdAt + 60_001), 0)
  })

  it('follows a BYOK parent to its subagents, and does not loop on a cycle', () => {
    const parentPm = mgr(); const childPm = mgr(); const grandPm = mgr()
    const parent = holder(parentPm); const child = holder(childPm); const grand = holder(grandPm)
    parentPm.handlePermission('Bash', { command: 'p' }, null, 'approve')
    childPm.handlePermission('Bash', { command: 'c' }, null, 'approve')
    grandPm.handlePermission('Bash', { command: 'g' }, null, 'approve')
    const grandId = [...grandPm._pendingPermissions.keys()][0]
    const childId = [...childPm._pendingPermissions.keys()][0]
    parent._subagentPermissionRouting = new Map([[childId, child]])
    child._subagentPermissionRouting = new Map([[grandId, grand], ['loop', parent]])
    const got = collectPendingPermissions({ sessionIds: ['s1'], sessionManager: manager({ s1: parent }) }).permissions
    assert.equal(got.length, 3)
    assert.deepEqual([...new Set(got.map((p) => p.sessionId))], ['s1'], 'the subagents prompts belong to the parent session')
  })

  it('a hook-routed entry is listed only under its owner, and an ownerless one under nobody', () => {
    const data = (id) => ({ requestId: id, tool: 'Bash', description: 'ls', input: { command: 'ls' }, remainingMs: 300_000, createdAt: 1000, floored: false, explicitConsent: false, nonDelegable: false })
    const pending = new Map([['h-1', { data: data('h-1') }], ['h-2', { data: data('h-2') }], ['h-3', { data: data('h-3') }]])
    const owners = new Map([['h-1', 's1'], ['h-2', 's2']])
    const got = (ids) => collectPendingPermissions({ sessionIds: ids, sessionManager: manager({}), pendingPermissions: pending, permissionSessionMap: owners, now: 2000 }).permissions
    assert.deepEqual(got(['s1']).map((p) => p.requestId), ['h-1'])
    assert.deepEqual(got(['s1', 's2']).map((p) => p.requestId), ['h-1', 'h-2'])
    assert.deepEqual(got(['s3']), [])
    for (const p of got(['s1', 's2'])) assert.equal('input' in p, false)
  })
})

describe('frameForPrincipal on the snapshot frame (the last line of defence)', () => {
  const client = { id: 'p', boundSessionId: 'sentinel', principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } }
  const opts = { sessionExists: (id) => id === 'sess-1' || id === 'sess-2' }
  const req = (over = {}) => ({
    requestId: 'r1', sessionId: 'sess-1', tool: 'Bash', floored: false, explicitConsent: false, nonDelegable: false,
    origin: 'in_process', createdAt: 1, expiresAt: 2, description: 'ls', ...over,
  })
  const frame = (permissions) => ({ type: 'principal_pending_permissions_result', requestId: 'q', generatedAt: 5, permissions, truncated: false })

  it('rebuilds each request from its whitelist: a stray input, a floored description or an unknown field never survive', () => {
    const out = frameForPrincipal(client, frame([
      req({ input: { command: 'rm -rf /' }, toolInput: { x: 1 }, suggestions: [1], extra: 'x' }),
      req({ requestId: 'r2', floored: true, description: 'must not be shown' }),
      req({ requestId: 'r3', floored: undefined, description: 'no verdict: floored' }),
    ]), opts)
    assert.ok(out)
    const [a, b, c] = out.permissions
    assert.deepEqual(Object.keys(a).sort(), ['createdAt', 'description', 'expiresAt', 'explicitConsent', 'floored', 'nonDelegable', 'origin', 'requestId', 'sessionId', 'tool'])
    assert.equal('description' in b, false)
    assert.equal('description' in c, false)
    assert.equal(JSON.stringify(out).includes('rm -rf'), false)
  })

  it('drops the whole frame when any request names a session the principal cannot see', () => {
    assert.equal(frameForPrincipal(client, frame([req(), req({ requestId: 'r9', sessionId: 'sess-2' })]), opts), null)
    assert.equal(frameForPrincipal(client, frame([req({ sessionId: 'unknown' })]), opts), null)
    assert.equal(frameForPrincipal(client, frame('not-an-array'), opts), null)
    assert.notEqual(frameForPrincipal(client, frame([]), opts), null)
  })

  it('is delivered to a principal and to nobody else', () => {
    assert.notEqual(frameForPrincipal(client, frame([req()]), opts), null)
    assert.equal(frameForPrincipal({ id: 'u', boundSessionId: null }, frame([req()]), opts), null)
  })
})
