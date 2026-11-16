/**
 * The agent principal's session roster snapshot (`principal_sessions_snapshot`;
 * docs/security/agent-principals.md sections 4 and 7.3; #9120, S5 of #9112).
 *
 * The sessions are real: a real SessionManager over fixture providers (a BaseSession subclass
 * with a real PermissionManager, the way sdk / byok / codex own one), so each handoff-blocker
 * state is produced by the real session machinery. The oracle for `blockers` is
 * `SessionManager.getHandoffBlockers` itself, read by the test and projected by a table
 * spelled out HERE, never by the module under test. The handler is called directly (dispatch
 * bypassed, as principal-handlers.test.js does), and one case goes over a real socket.
 */
import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BaseSession } from '../src/base-session.js'
import { PermissionManager } from '../src/permission-manager.js'
import { SessionManager } from '../src/session-manager.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { setLogListener } from '../src/logger.js'
import { collectSessionsSnapshot, PRINCIPAL_SESSIONS_SNAPSHOT_MAX } from '../src/principal-sessions-snapshot.js'
import {
  frameForPrincipal, principalDispatchRefusal, PRINCIPAL_SESSION_ROW_FIELDS, PRINCIPAL_BLOCKER_DETAIL_FIELDS,
} from '../src/principal-policy.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'
import { REAL_HANDLERS, principalClient, hostClient, recordingCtx } from './principal-test-helpers.js'
import { waitFor } from './test-helpers.js'
import {
  ServerPrincipalSessionsSnapshotResultSchema, PRINCIPAL_SESSIONS_SNAPSHOT_MAX as PROTOCOL_MAX,
} from '@chroxy/protocol'

const snapshotHandler = REAL_HANDLERS.principal_sessions_snapshot

class RosterProvider extends BaseSession {
  constructor(opts = {}) {
    super({ cwd: opts.cwd })
    this._permissions = new PermissionManager({ cwd: opts.cwd || '/tmp' })
    this._processReady = true
    this.resumeSessionId = null
    this.model = opts.model ?? null
  }
  static get capabilities() { return {} }
  start() {}
  destroy() { this._destroying = true; this._permissions.clearAll() }
  sendMessage() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
  getPendingQuestions() { return this._permissions.getPendingQuestions() }
}

// Spelled out here, not read from the code under test: which detail fields each code keeps.
const ORACLE_DETAIL = {
  queued_prompts: ['count'],
  pending_permission: ['requestIds'],
  pending_question: ['count'],
  active_agents: ['count'],
  background_shells: ['count', 'soft'],
  automation_owned: ['scheduledTaskId', 'orchestrationRunId'],
}
function oracleBlockers(accessorResult) {
  return accessorResult.map((b) => {
    const keys = ORACLE_DETAIL[b.code]
    if (!keys || !b.detail) return { code: b.code }
    const detail = {}
    for (const k of keys) if (Object.hasOwn(b.detail, k)) detail[k] = b.detail[k]
    return Object.keys(detail).length > 0 ? { code: b.code, detail } : { code: b.code }
  })
}

describe('principal_sessions_snapshot', () => {
  let mgr
  let dir
  before(async () => {
    const { registerProvider } = await import('../src/providers.js')
    declareUnknownCustomization(RosterProvider)
    registerProvider('test-principal-roster', RosterProvider)
  })
  afterEach(() => {
    if (mgr) { mgr.destroyAll(); mgr = null }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
  })

  function makeManager(maxSessions = 10) {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-roster-'))
    mgr = new SessionManager({ skipPreflight: true, maxSessions, defaultCwd: '/tmp', stateFilePath: join(dir, 'state.json') })
    return mgr
  }
  const create = (over = {}) => mgr.createSession({ cwd: '/tmp', provider: 'test-principal-roster', ...over })
  const sessionOf = (id) => mgr.getSession(id).session

  function ctxFor(manager, { pending = new Map() } = {}) {
    const sent = []
    const ctx = {
      transport: { send: (_ws, m) => { sent.push(m) } },
      sessions: { sessionManager: manager },
      services: {},
      runtime: { pendingEvaluatorAwaits: pending },
      permissions: {},
      correlationId: 'corr-1',
    }
    return { ctx, sent }
  }
  const principal = (ids, tier = 'observe') => principalClient({ principal: { tier, scope: tier, constraints: { sessionIds: ids } } })
  const ask = (client, ctx, msg) => snapshotHandler({}, client, { type: 'principal_sessions_snapshot', requestId: 'req-1', ...msg }, ctx)

  describe('only granted sessions appear, and a refusal looks like absence', () => {
    it('with explicit ids, a non-granted id and a nonexistent id are refused with byte-identical frames and nothing else', () => {
      makeManager()
      const a = create()
      const b = create()
      const client = principal([a])
      const notGranted = ctxFor(mgr)
      ask(client, notGranted.ctx, { sessionIds: [a, b] })
      const nonexistent = ctxFor(mgr)
      ask(client, nonexistent.ctx, { sessionIds: [a, 'no-such-session'] })
      assert.equal(notGranted.sent.length, 1)
      assert.equal(nonexistent.sent.length, 1)
      assert.equal(notGranted.sent[0].type, 'session_error')
      assert.equal(notGranted.sent[0].code, 'scope_denied')
      assert.equal(JSON.stringify(notGranted.sent[0]), JSON.stringify(nonexistent.sent[0]))
      // the refusal names no session and carries no row
      assert.equal(JSON.stringify(notGranted.sent[0]).includes(b), false)
    })

    it('a granted id that is listed LAST still refuses the whole request when an earlier one is not granted, and the reverse order does too', () => {
      makeManager()
      const a = create()
      const b = create()
      const c = create()
      const client = principal([a, c])
      for (const order of [[b, a, c], [a, c, b], [a, b, c]]) {
        const { ctx, sent } = ctxFor(mgr)
        ask(client, ctx, { sessionIds: order })
        assert.deepEqual(sent.map((m) => m.type), ['session_error'], order.join())
      }
    })

    it('every explicit id is checked, with no early exit', () => {
      makeManager()
      const a = create()
      // A cwd-root grant asks the manager about EVERY id it is given (an id grant would stop at the list).
      const client = principalClient({ principal: { tier: 'observe', scope: 'observe', constraints: { cwdRoots: ['/tmp/no-session-lives-here'] } } })
      const asked = []
      const { ctx } = ctxFor(mgr)
      const real = mgr.getSession.bind(mgr)
      mgr.getSession = (id) => { asked.push(id); return real(id) }
      ask(client, ctx, { sessionIds: ['nope-1', a, 'nope-2', 'nope-3'] })
      for (const id of ['nope-1', a, 'nope-2', 'nope-3']) assert.ok(asked.includes(id), `${id} was checked`)
    })

    it('a cwd-root grant covers the sessions under the root and no others', () => {
      makeManager()
      mkdirSync(join(dir, 'in'))
      mkdirSync(join(dir, 'out'))
      const inside = create({ cwd: join(dir, 'in') })
      const outside = create({ cwd: join(dir, 'out') })
      const { ctx, sent } = ctxFor(mgr)
      ask(principalClient({ principal: { tier: 'observe', scope: 'observe', constraints: { cwdRoots: [join(dir, 'in')] } } }), ctx, {})
      assert.deepEqual(sent[0].sessions.map((r) => r.sessionId), [inside])
      assert.equal(JSON.stringify(sent[0]).includes(outside), false)
    })

    it('with ids omitted, only the granted sessions appear, in listing order', () => {
      makeManager()
      const a = create({ name: 'A' })
      create({ name: 'B (not granted)' })
      const c = create({ name: 'C' })
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([c, a]), ctx, {})
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'principal_sessions_snapshot_result')
      assert.deepEqual(sent[0].sessions.map((r) => r.sessionId), [a, c])
      assert.equal(sent[0].truncated, false)
      assert.equal(sent[0].requestId, 'req-1')
    })

    it('an empty grant gets an empty list, not a refusal', () => {
      makeManager()
      create()
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([]), ctx, {})
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'principal_sessions_snapshot_result')
      assert.deepEqual(sent[0].sessions, [])
      assert.equal(sent[0].truncated, false)
    })

    it('a client that is not a principal is refused without touching anything', () => {
      const { ctx, sent, touched } = recordingCtx()
      snapshotHandler({}, hostClient(), { type: 'principal_sessions_snapshot', requestId: 'r1' }, ctx)
      assert.deepEqual(sent.map((m) => [m.type, m.code]), [['session_error', 'scope_denied']])
      assert.deepEqual(touched, [])
    })
  })

  describe('blockers match getHandoffBlockers for each fixture state (oracle)', () => {
    const states = {
      idle: () => {},
      turn_active: (id) => { sessionOf(id)._isBusy = true },
      queued_prompts: (id) => { const s = sessionOf(id); s._isBusy = true; s.enqueueOutgoingMessage({ prompt: 'a' }); s.enqueueOutgoingMessage({ prompt: 'b' }) },
      pending_permission_in_process: (id) => { sessionOf(id)._permissions.handlePermission('Bash', { command: 'ls' }, undefined, 'approve').catch(() => {}) },
      pending_permission_hook_routed: (id) => { sessionOf(id).notifyPermissionPending('hook-req-1') },
      pending_question: (id) => { sessionOf(id)._permissions.handlePermission('AskUserQuestion', { questions: [{ question: 'q?', options: [] }] }, undefined, 'approve').catch(() => {}) },
      active_agents: (id) => { sessionOf(id)._activeAgents.set('tool-1', { toolUseId: 'tool-1', description: 'd', startedAt: 1 }) },
      background_shells_soft: (id) => { sessionOf(id).trackBackgroundShell({ shellId: 'sh-1', command: 'sleep 99' }) },
      not_ready: (id) => { sessionOf(id)._processReady = false },
    }
    const expectCode = {
      turn_active: 'turn_active', queued_prompts: 'queued_prompts', pending_permission_in_process: 'pending_permission',
      pending_permission_hook_routed: 'pending_permission', pending_question: 'pending_question', active_agents: 'active_agents',
      background_shells_soft: 'background_shells', not_ready: 'not_ready',
    }

    for (const [state, arrange] of Object.entries(states)) {
      it(`${state}: the row's blockers equal the accessor's, projected`, () => {
        makeManager()
        const id = create()
        arrange(id)
        const accessor = mgr.getHandoffBlockers(id, { evaluatorPending: false })
        if (state === 'idle') assert.deepEqual(accessor, [], 'precondition: idle has no blocker')
        else assert.ok(accessor.some((b) => b.code === expectCode[state]), `precondition: the accessor sees ${expectCode[state]} (not a vacuous comparison)`)
        const { ctx, sent } = ctxFor(mgr)
        ask(principal([id]), ctx, { sessionIds: [id] })
        assert.equal(sent[0].type, 'principal_sessions_snapshot_result')
        assert.equal(sent[0].sessions.length, 1)
        assert.deepEqual(sent[0].sessions[0].blockers, oracleBlockers(accessor))
      })
    }

    it('destroying: the accessor says so, the row says so, and a session already destroying reads as absent to a principal', () => {
      makeManager()
      const id = create()
      mgr._sessions.get(id)._destroying = true
      const accessor = mgr.getHandoffBlockers(id)
      assert.ok(accessor.some((b) => b.code === 'destroying'), 'precondition: the accessor sees destroying')
      // teardown began AFTER the grant check passed: the manager still holds the entry
      const racing = { getSession: (sid) => mgr._sessions.get(sid), getHandoffBlockers: (sid, o) => mgr.getHandoffBlockers(sid, o), providerType: 'p' }
      const out = collectSessionsSnapshot({ sessionIds: [id], sessionManager: racing, evaluatorPending: () => false })
      assert.deepEqual(out.sessions[0].blockers, oracleBlockers(accessor))
      assert.ok(out.sessions[0].blockers.some((b) => b.code === 'destroying'))
      // teardown began BEFORE the request: not listed, and an explicit id is refused like a nonexistent one
      const listed = ctxFor(mgr)
      ask(principal([id]), listed.ctx, {})
      assert.deepEqual(listed.sent[0].sessions, [])
      const explicit = ctxFor(mgr)
      ask(principal([id]), explicit.ctx, { sessionIds: [id] })
      const absent = ctxFor(mgr)
      ask(principal([id]), absent.ctx, { sessionIds: ['no-such'] })
      assert.equal(JSON.stringify(explicit.sent[0]), JSON.stringify(absent.sent[0]))
    })

    it('automation_owned: a session owned by a scheduled task and one owned by an orchestration run', () => {
      makeManager()
      const task = create({ metadata: { scheduledTaskId: 'task-1' } })
      const run = create({ metadata: { orchestrationRunId: 'run_1', orchestrationRole: 'worker' } })
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([task, run]), ctx, { sessionIds: [task, run] })
      for (const [i, id] of [task, run].entries()) {
        const accessor = mgr.getHandoffBlockers(id)
        assert.equal(accessor[0].code, 'automation_owned', 'precondition')
        assert.deepEqual(sent[0].sessions[i].blockers, oracleBlockers(accessor))
      }
      assert.deepEqual(sent[0].sessions[0].blockers, [{ code: 'automation_owned', detail: { scheduledTaskId: 'task-1' } }])
      assert.deepEqual(sent[0].sessions[1].blockers, [{ code: 'automation_owned', detail: { orchestrationRunId: 'run_1' } }])
    })

    it('evaluator_pending: the WS layer lock is passed through to the accessor', () => {
      makeManager()
      const held = create()
      const free = create()
      const pending = new Map([[held, Promise.resolve()]])
      const { ctx, sent } = ctxFor(mgr, { pending })
      ask(principal([held, free]), ctx, { sessionIds: [held, free] })
      const [heldRow, freeRow] = sent[0].sessions
      assert.deepEqual(mgr.getHandoffBlockers(held, { evaluatorPending: true }), [{ code: 'evaluator_pending' }], 'precondition')
      assert.deepEqual(heldRow.blockers, oracleBlockers(mgr.getHandoffBlockers(held, { evaluatorPending: true })))
      assert.deepEqual(heldRow.blockers, [{ code: 'evaluator_pending' }])
      assert.deepEqual(freeRow.blockers, [])
    })

    it('evaluator state that the WS layer cannot report reads as pending, never as clear', () => {
      makeManager()
      const id = create()
      const { ctx, sent } = ctxFor(mgr)
      ctx.runtime = {}
      ask(principal([id]), ctx, { sessionIds: [id] })
      assert.deepEqual(sent[0].sessions[0].blockers, [{ code: 'evaluator_pending' }])
    })

    it('several blockers at once keep the accessor order', () => {
      makeManager()
      const id = create()
      sessionOf(id)._isBusy = true
      sessionOf(id).trackBackgroundShell({ shellId: 'sh-1', command: 'x' })
      sessionOf(id).notifyPermissionPending('hook-9')
      const accessor = mgr.getHandoffBlockers(id, { evaluatorPending: true })
      assert.ok(accessor.length >= 4)
      const { ctx, sent } = ctxFor(mgr, { pending: new Map([[id, Promise.resolve()]]) })
      ask(principal([id]), ctx, { sessionIds: [id] })
      assert.deepEqual(sent[0].sessions[0].blockers, oracleBlockers(accessor))
    })

    it('a code the daemon does not know is still a blocker, delivered with no detail; a known one loses detail fields that are not whitelisted', () => {
      makeManager()
      const id = create()
      sessionOf(id).getHandoffBlockers = () => [
        { code: 'quorum_pending', detail: { secret: 'S3CRET' } },
        { code: 'background_shells', detail: { count: 2, soft: true, command: 'rm -rf /' } },
        { code: 'pending_permission', detail: { requestIds: ['r1', 'r2'], tool: 'Bash' } },
        { code: 'queued_prompts', detail: { count: 'many' } },
      ]
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([id]), ctx, { sessionIds: [id] })
      assert.deepEqual(sent[0].sessions[0].blockers, [
        { code: 'quorum_pending' },
        { code: 'background_shells', detail: { count: 2, soft: true } },
        { code: 'pending_permission', detail: { requestIds: ['r1', 'r2'] } },
        { code: 'queued_prompts' },
      ])
      assert.equal(JSON.stringify(sent[0]).includes('S3CRET'), false)
      assert.equal(JSON.stringify(sent[0]).includes('rm -rf'), false)
    })
  })

  describe('fail safe: an unreadable session is never reported as clear', () => {
    it('a session whose blocker read throws gets [{ code: unavailable }]; the other rows are unchanged', () => {
      makeManager()
      const good = create({ name: 'good' })
      const bad = create({ name: 'bad' })
      const other = create({ name: 'other' })
      const baseline = ctxFor(mgr)
      ask(principal([good, bad, other]), baseline.ctx, { sessionIds: [good, bad, other] })
      sessionOf(bad).getHandoffBlockers = () => { throw new Error('boom') }
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([good, bad, other]), ctx, { sessionIds: [good, bad, other] })
      const rows = sent[0].sessions
      assert.deepEqual(rows[1].blockers, [{ code: 'unavailable' }])
      assert.equal(rows[1].sessionId, bad)
      assert.deepEqual(rows[0], baseline.sent[0].sessions[0])
      assert.deepEqual(rows[2], baseline.sent[0].sessions[2])
    })

    it('a session whose status getter throws still appears, with null status and an unavailable blocker', () => {
      makeManager()
      const bad = create({ name: 'bad' })
      Object.defineProperty(sessionOf(bad), 'isRunning', { get() { throw new Error('getter boom') } })
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([bad]), ctx, { sessionIds: [bad] })
      const row = sent[0].sessions[0]
      assert.equal(row.status, null)
      assert.deepEqual(row.blockers, [{ code: 'unavailable' }])
      assert.equal(row.name, 'bad')
    })

    it('a blocker list that is not a list is unavailable, not empty', () => {
      makeManager()
      const id = create()
      sessionOf(id).getHandoffBlockers = () => ({ not: 'a list' })
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([id]), ctx, { sessionIds: [id] })
      // the manager returns whatever the provider gave; the module must not read that as "no blockers"
      assert.deepEqual(sent[0].sessions[0].blockers, [{ code: 'unavailable' }])
    })

    it('a session the accessor does not know (not_found) is omitted', () => {
      const fake = {
        getSession: (id) => (id === 'gone' ? { name: 'gone', session: {} } : null),
        getHandoffBlockers: () => [{ code: 'not_found' }],
        providerType: 'x',
      }
      const out = collectSessionsSnapshot({ sessionIds: ['gone', 'never'], sessionManager: fake, evaluatorPending: () => false })
      assert.deepEqual(out.sessions, [])
    })

    it('a throwing getter in a session that is NOT granted does not change the reply, and listSessions is never called', () => {
      makeManager()
      const a = create({ name: 'A' })
      const hidden = create({ name: 'hidden' })
      const client = principal([a])
      const baseline = ctxFor(mgr)
      ask(client, baseline.ctx, {})
      // now break everything about the session that is not granted, and make the full listing fatal
      const hiddenSession = sessionOf(hidden)
      Object.defineProperty(hiddenSession, 'isRunning', { get() { throw new Error('hidden getter') } })
      Object.defineProperty(hiddenSession, 'busyReason', { get() { throw new Error('hidden getter') } })
      hiddenSession.getHandoffBlockers = () => { throw new Error('hidden blockers') }
      let listed = 0
      mgr.listSessions = () => { listed++; throw new Error('listSessions must not be called') }
      for (const msg of [{}, { sessionIds: [a] }]) {
        const { ctx, sent } = ctxFor(mgr)
        ask(client, ctx, msg)
        assert.equal(sent.length, 1)
        assert.equal(sent[0].type, 'principal_sessions_snapshot_result')
        assert.deepEqual(sent[0].sessions, baseline.sent[0].sessions)
      }
      assert.equal(listed, 0)
    })
  })

  describe('what a row says', () => {
    it('a row has exactly the documented fields and nothing else (no cwd, history, cost)', () => {
      makeManager()
      const id = create({ name: 'Row' })
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([id]), ctx, { sessionIds: [id] })
      const row = sent[0].sessions[0]
      assert.deepEqual(Object.keys(row).sort(), ['blockers', 'declaredStatus', 'lastActivityAt', 'leaseHolder', 'model', 'name', 'provider', 'sessionId', 'status'])
      assert.equal(row.name, 'Row')
      assert.equal(row.provider, 'test-principal-roster')
      assert.equal(row.leaseHolder, null)
      assert.equal(typeof row.lastActivityAt, 'number')
      assert.equal(JSON.stringify(sent[0]).includes('/tmp'), false, 'no cwd anywhere in the reply')
    })

    it('the observed status: idle, mid-turn, held only by a background shell, and still starting', () => {
      makeManager()
      const idle = create()
      const turn = create()
      const shell = create()
      const starting = create()
      sessionOf(turn)._isBusy = true
      sessionOf(shell).trackBackgroundShell({ shellId: 'sh-1', command: 'x' })
      mgr._sessions.get(starting)._starting = true
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([idle, turn, shell, starting]), ctx, { sessionIds: [idle, turn, shell, starting] })
      const statuses = sent[0].sessions.map((r) => r.status)
      assert.deepEqual(statuses[0], { isBusy: false, busyReason: null, starting: false })
      assert.deepEqual(statuses[1], { isBusy: true, busyReason: 'turn', starting: false })
      assert.deepEqual(statuses[2], { isBusy: true, busyReason: 'background-shells', starting: false })
      assert.deepEqual(statuses[3], { isBusy: false, busyReason: null, starting: true })
      // agrees with what the listing derives for the same sessions
      const listing = new Map(mgr.listSessions().map((r) => [r.sessionId, r]))
      for (const row of sent[0].sessions) {
        assert.equal(row.status.isBusy, listing.get(row.sessionId).isBusy)
        assert.equal(row.status.busyReason, listing.get(row.sessionId).busyReason)
        assert.equal(row.status.starting, listing.get(row.sessionId).starting)
      }
    })

    it('declared status: present is relayed (validated), absent is null', () => {
      makeManager()
      const declared = create()
      const silent = create()
      const stored = mgr.setDeclaredStatus(declared, { state: 'blocked', summary: 'waiting on review', blockedOn: 'PR 12', next: 'merge', etaMinutes: 5 })
      assert.ok(stored, 'precondition: the declaration was accepted')
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([declared, silent]), ctx, { sessionIds: [declared, silent] })
      assert.deepEqual(sent[0].sessions[0].declaredStatus, {
        state: 'blocked', summary: 'waiting on review', next: 'merge', blockedOn: 'PR 12', etaMinutes: 5, updatedAt: stored.updatedAt, source: 'api',
      })
      assert.equal(sent[0].sessions[1].declaredStatus, null)
    })

    it('declared status that does not validate is not relayed, and secrets in its text are redacted', () => {
      makeManager()
      const id = create()
      mgr._sessions.get(id).declaredStatus = { state: 'not-a-state', summary: 'x', updatedAt: 1, source: 'api' }
      const bad = ctxFor(mgr)
      ask(principal([id]), bad.ctx, { sessionIds: [id] })
      assert.equal(bad.sent[0].sessions[0].declaredStatus, null)
      mgr._sessions.get(id).declaredStatus = { state: 'running', summary: 'using key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now', updatedAt: 1, source: 'api' }
      const secret = ctxFor(mgr)
      ask(principal([id]), secret.ctx, { sessionIds: [id] })
      assert.equal(JSON.stringify(secret.sent[0]).includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), false)
    })

    it('model: requested is the explicit override, observed is what is running; each may be null', () => {
      makeManager()
      const both = create({ model: 'claude-opus-4' })
      const followDefault = create()
      const neither = create()
      sessionOf(both).bootedModel = 'claude-sonnet-4'
      sessionOf(followDefault).bootedModel = 'claude-haiku-4'
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([both, followDefault, neither]), ctx, { sessionIds: [both, followDefault, neither] })
      assert.deepEqual(sent[0].sessions.map((r) => r.model), [
        { requested: 'claude-opus-4', observed: 'claude-sonnet-4' },
        { requested: null, observed: 'claude-haiku-4' },
        { requested: null, observed: null },
      ])
    })
  })

  describe('bounds', () => {
    function stubManager(n) {
      const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(3, '0')}`)
      return {
        ids,
        manager: {
          providerType: 'p',
          getSession: (id) => (ids.includes(id) ? { name: id, session: { isRunning: false } } : null),
          getHandoffBlockers: () => [],
        },
      }
    }

    it('is capped at 100 rows in the order given, with truncated set', () => {
      assert.equal(PRINCIPAL_SESSIONS_SNAPSHOT_MAX, 100)
      assert.equal(PRINCIPAL_SESSIONS_SNAPSHOT_MAX, PROTOCOL_MAX)
      const { ids, manager } = stubManager(101)
      const out = collectSessionsSnapshot({ sessionIds: ids, sessionManager: manager, evaluatorPending: () => false })
      assert.equal(out.sessions.length, 100)
      assert.deepEqual(out.sessions.map((r) => r.sessionId), ids.slice(0, 100))
      assert.equal(out.truncated, true)
      const exact = collectSessionsSnapshot({ sessionIds: ids.slice(0, 100), sessionManager: manager, evaluatorPending: () => false })
      assert.equal(exact.sessions.length, 100)
      assert.equal(exact.truncated, false)
    })

    it('explicit ids keep the order the request gave', () => {
      makeManager()
      const a = create()
      const b = create()
      const c = create()
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([a, b, c]), ctx, { sessionIds: [c, a, b] })
      assert.deepEqual(sent[0].sessions.map((r) => r.sessionId), [c, a, b])
    })

    it('the reply validates against the protocol schema', () => {
      makeManager()
      const a = create({ name: 'A', model: 'm' })
      mgr.setDeclaredStatus(a, { state: 'idle', summary: 's' })
      sessionOf(a)._isBusy = true
      const { ctx, sent } = ctxFor(mgr)
      ask(principal([a]), ctx, {})
      const parsed = ServerPrincipalSessionsSnapshotResultSchema.safeParse(frameForPrincipal(principal([a]), sent[0], {}))
      assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues))
    })
  })

  describe('the request envelope', () => {
    it('an extra field, a non-array or empty sessionIds, a non-string id or a missing requestId is refused at dispatch', () => {
      const client = principal(['s1'])
      assert.equal(principalDispatchRefusal(client, { type: 'principal_sessions_snapshot', requestId: 'r' }), null)
      assert.equal(principalDispatchRefusal(client, { type: 'principal_sessions_snapshot', requestId: 'r', sessionIds: ['s1'] }), null)
      assert.equal(principalDispatchRefusal(client, { type: 'principal_sessions_snapshot', requestId: 'r', cwd: '/x' }), 'envelope')
      assert.equal(principalDispatchRefusal(client, { type: 'principal_sessions_snapshot', requestId: 'r', limit: 5 }), 'envelope')
    })

    it('the handler refuses malformed ids and a missing requestId on its own', () => {
      makeManager()
      const a = create()
      const client = principal([a])
      for (const msg of [{ sessionIds: 'x' }, { sessionIds: [] }, { sessionIds: [a, a] }, { sessionIds: [1] }, { sessionIds: [''] }, { requestId: '' }, { requestId: 7 }]) {
        const { ctx, sent } = ctxFor(mgr)
        snapshotHandler({}, client, { type: 'principal_sessions_snapshot', requestId: 'r1', ...msg }, ctx)
        assert.deepEqual(sent.map((m) => m.type), ['session_error'], JSON.stringify(msg))
      }
    })
  })

  describe('frameForPrincipal rebuilds every row from its whitelists', () => {
    const client = principalClient({ principal: { tier: 'observe', constraints: { sessionIds: ['sess-1'] } } })
    const opts = { sessionExists: (id) => id === 'sess-1' || id === 'sess-2' }
    const goodRow = () => ({
      sessionId: 'sess-1', name: 'One', provider: 'claude-sdk',
      status: { isBusy: true, busyReason: 'turn', starting: false },
      declaredStatus: { state: 'running', summary: 'working', updatedAt: 5, source: 'api' },
      model: { requested: null, observed: 'm' },
      blockers: [{ code: 'background_shells', detail: { count: 1, soft: true } }],
      leaseHolder: null, lastActivityAt: 9,
    })
    const frame = (rows) => ({ type: 'principal_sessions_snapshot_result', requestId: 'r', generatedAt: 1, sessions: rows, truncated: false })

    it('a well-formed row passes through unchanged', () => {
      assert.deepEqual(frameForPrincipal(client, frame([goodRow()]), opts), frame([goodRow()]))
    })

    it('an extra field on a row, on status, on model, on declaredStatus or in a blocker detail is stripped', () => {
      const row = goodRow()
      row.cwd = '/Users/x/secret-project'
      row.status.pid = 4242
      row.model.apiKey = 'sk-leak'
      row.declaredStatus.internal = 'leak'
      row.blockers[0].detail.command = 'rm -rf /'
      row.blockers[0].extra = 'leak'
      const out = frameForPrincipal(client, frame([row]), opts)
      assert.deepEqual(out, frame([goodRow()]))
      const text = JSON.stringify(out)
      for (const leak of ['secret-project', '4242', 'sk-leak', 'rm -rf', '"internal"']) assert.equal(text.includes(leak), false, leak)
    })

    it('a row for a session that is not granted makes the whole frame refused', () => {
      assert.equal(frameForPrincipal(client, frame([goodRow(), { ...goodRow(), sessionId: 'sess-2' }]), opts), null)
      assert.equal(frameForPrincipal(client, frame([{ ...goodRow(), sessionId: 'nonexistent' }]), opts), null)
      assert.equal(frameForPrincipal(client, frame([goodRow(), null]), opts), null)
    })

    it('a row that is not a list of blockers is delivered as unavailable, never as an empty list', () => {
      for (const blockers of [undefined, null, 'none', { code: 'x' }]) {
        const out = frameForPrincipal(client, frame([{ ...goodRow(), blockers }]), opts)
        assert.deepEqual(out.sessions[0].blockers, [{ code: 'unavailable' }], String(blockers))
      }
      const empty = frameForPrincipal(client, frame([{ ...goodRow(), blockers: [] }]), opts)
      assert.deepEqual(empty.sessions[0].blockers, [], 'a real empty list stays empty')
    })

    it('a blocker detail value of the wrong kind is dropped, and an unknown code carries no detail', () => {
      const row = { ...goodRow(), blockers: [
        { code: 'queued_prompts', detail: { count: { nested: 'object' } } },
        { code: 'future_code', detail: { anything: 1 } },
        'not-an-object',
      ] }
      const out = frameForPrincipal(client, frame([row]), opts)
      assert.deepEqual(out.sessions[0].blockers, [{ code: 'queued_prompts' }, { code: 'future_code' }, { code: 'unavailable' }])
    })

    it('more than 100 rows is refused; the whitelists name nothing outside the contract', () => {
      assert.equal(frameForPrincipal(client, frame(new Array(101).fill(goodRow())), opts), null)
      assert.equal(frameForPrincipal(client, frame(new Array(100).fill(goodRow())), opts).sessions.length, 100)
      assert.deepEqual([...PRINCIPAL_SESSION_ROW_FIELDS].sort(), ['blockers', 'declaredStatus', 'lastActivityAt', 'leaseHolder', 'model', 'name', 'provider', 'sessionId', 'status'])
      assert.deepEqual(Object.keys(PRINCIPAL_BLOCKER_DETAIL_FIELDS).sort(), Object.keys(ORACLE_DETAIL).sort())
      for (const [code, spec] of Object.entries(PRINCIPAL_BLOCKER_DETAIL_FIELDS)) assert.deepEqual(Object.keys(spec).sort(), [...ORACLE_DETAIL[code]].sort(), code)
    })
  })

  describe('over a real socket', () => {
    class WsServer extends _WsServer {
      constructor(o = {}) { super({ noEncrypt: true, ...o }) }
      start(...args) { super.start(...args); setLogListener(null) }
    }
    let server
    const sockets = []
    const cleanups = []
    afterEach(() => {
      for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
      if (server) { server.close(); server = null }
      while (cleanups.length) cleanups.pop()()
    })

    async function connect(token, port) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(ws)
      const messages = []
      ws.on('message', (d) => { try { const { seq: _s, ...frame } = JSON.parse(d.toString()); messages.push(frame) } catch { /* ignore */ } })
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      ws.send(JSON.stringify({ type: 'auth', token }))
      await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
      messages.length = 0
      return { messages, send: (m) => ws.send(JSON.stringify(m)) }
    }

    it('a principal reads its granted sessions; an ungranted and a nonexistent id are refused with identical bytes', async () => {
      makeManager()
      const a = create({ name: 'Granted' })
      const hidden = create({ name: 'Hidden' })
      mgr.setDeclaredStatus(a, { state: 'idle', summary: 'ready' })
      const fixture = tempPrincipalDir()
      cleanups.push(fixture.cleanup)
      const store = testPrincipalStore(fixture.path)
      const { token } = insertPrincipal(store, { principalId: 'pr-1', label: 'planner', scope: 'observe', constraints: { sessionIds: [a] } })
      server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: mgr, authRequired: true, principalStore: store })
      server.start('127.0.0.1')
      await new Promise((resolve) => server.httpServer.once('listening', resolve))
      const c = await connect(token, server.httpServer.address().port)
      const reply = async (requestId, extra) => {
        c.send({ type: 'principal_sessions_snapshot', requestId, ...extra })
        return waitFor(() => c.messages.find((m) => m.requestId === requestId && (m.type === 'principal_sessions_snapshot_result' || m.type === 'session_error')), { label: requestId })
      }
      const all = await reply('q1', {})
      assert.equal(all.type, 'principal_sessions_snapshot_result')
      assert.deepEqual(all.sessions.map((r) => r.sessionId), [a])
      assert.equal(all.sessions[0].declaredStatus.summary, 'ready')
      assert.equal(ServerPrincipalSessionsSnapshotResultSchema.safeParse(all).success, true)
      assert.equal(JSON.stringify(all).includes(hidden), false)
      assert.equal(JSON.stringify(all).includes('Hidden'), false)
      const denied = await reply('q2', { sessionIds: [a, hidden] })
      const absent = await reply('q2', { sessionIds: [a, 'no-such-session'] })
      assert.equal(denied.type, 'session_error')
      assert.equal(JSON.stringify(denied), JSON.stringify(absent))
    })
  })
})
