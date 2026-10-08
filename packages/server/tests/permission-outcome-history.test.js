import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import {
  SessionMessageHistory,
  PERMISSION_OUTCOME_DESCRIPTION_MAX,
  PERMISSION_OUTCOME_TOOL_MAX,
} from '../src/session-message-history.js'
import { PermissionManager, wirePermissionManager } from '../src/permission-manager.js'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { createPermissionResolver } from '../src/permission-resolver.js'
import { sendHistoryEntry, replayHistory } from '../src/ws-history.js'
import { flattenHistory } from '../src/summarize-session.js'

/**
 * #8348 -- a permission prompt's outcome is part of the session's DURABLE
 * transcript.
 *
 * `permission_request` / `permission_resolved` / `permission_expired` are
 * transient (never in the history ring buffer), so a full-rebuild replay -- a
 * session switch, a reload -- rebuilt the transcript without any prompt that had
 * already ended. The server now records ONE `permission_outcome` history entry
 * per prompt, on both pipelines:
 *
 *   - the in-process providers (claude-sdk, byok, codex): PermissionManager ->
 *     session event -> SessionManager's transient-event listener;
 *   - the hook-routed providers (claude-tui, claude-cli): ws-permissions.js and
 *     permission-resolver.js, which never pass through a session event.
 *
 * Every SessionManager here uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpStateFile() {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'perm-outcome-'))
  return join(tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

const outcomes = (mgr, sid) => mgr.getHistory(sid).filter((e) => e.type === 'permission_outcome')

describe('SessionMessageHistory permission_outcome (#8348)', () => {
  it('records one entry carrying the id, tool, description and outcome', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', {
      requestId: 'perm-1', tool: 'Bash', description: 'ls -la', outcome: 'expired',
    })
    const entries = h.getHistory('s1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'permission_outcome')
    assert.equal(entries[0].requestId, 'perm-1')
    assert.equal(entries[0].tool, 'Bash')
    assert.equal(entries[0].description, 'ls -la')
    assert.equal(entries[0].outcome, 'expired')
    assert.equal(typeof entries[0].timestamp, 'number')
    assert.equal(typeof entries[0]._seq, 'number', 'it is a numbered entry: a delta replay can reach it')
  })

  it('#8374: records a "stopped" outcome (a prompt the Stop button cancelled)', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', {
      requestId: 'perm-1', tool: 'Bash', description: 'ls -la', outcome: 'stopped',
    })
    const entries = h.getHistory('s1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].outcome, 'stopped')
  })

  it('persists a state-file write for it (a debounced save is scheduled)', () => {
    const h = new SessionMessageHistory()
    const r = h.recordHistory('s1', 'permission_outcome', { requestId: 'p', tool: 'Bash', description: 'x', outcome: 'allowed' })
    assert.equal(r.persistNeeded, true)
  })

  it('never records a second outcome for the same requestId', () => {
    const h = new SessionMessageHistory()
    const data = { requestId: 'perm-1', tool: 'Bash', description: 'x', outcome: 'allowed' }
    h.recordHistory('s1', 'permission_outcome', data)
    const second = h.recordHistory('s1', 'permission_outcome', { ...data, outcome: 'expired' })
    assert.equal(second.persistNeeded, false)
    const entries = h.getHistory('s1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].outcome, 'allowed', 'the first outcome stands')
  })

  it('refuses an entry with no requestId or an unknown outcome', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', { tool: 'Bash', description: 'x', outcome: 'allowed' })
    h.recordHistory('s1', 'permission_outcome', { requestId: '', tool: 'Bash', description: 'x', outcome: 'allowed' })
    h.recordHistory('s1', 'permission_outcome', { requestId: 'p', tool: 'Bash', description: 'x', outcome: 'maybe' })
    assert.equal(h.getHistory('s1').length, 0)
  })

  it('bounds the free-text fields it keeps', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', {
      requestId: 'p', tool: 'T'.repeat(5000), description: 'd'.repeat(50_000), outcome: 'denied',
    })
    const [e] = h.getHistory('s1')
    assert.ok(e.tool.length <= PERMISSION_OUTCOME_TOOL_MAX)
    assert.ok(e.description.length <= PERMISSION_OUTCOME_DESCRIPTION_MAX)
  })

  it('fails closed on oversized text: a JWT-shaped value crossing the scan bound leaves no prefix behind', () => {
    const h = new SessionMessageHistory()
    const jwt = `eyJ${'A'.repeat(20)}.${'B'.repeat(9000)}.${'C'.repeat(20)}`
    h.recordHistory('s1', 'permission_outcome', {
      requestId: 'p', tool: 'Bash', description: `curl -H ${jwt}`, outcome: 'allowed',
    })
    const [e] = h.getHistory('s1')
    assert.equal(e.description.includes('eyJ'), false)
    assert.equal(e.description.includes('BBBB'), false)
  })

  it('oversized text with no whitespace is redacted whole, then clipped: it keeps its beginning', () => {
    const h = new SessionMessageHistory()
    const text = `eyJ${'A'.repeat(20)}.${'B'.repeat(20000)}`
    h.recordHistory('s1', 'permission_outcome', {
      requestId: 'p', tool: 'Bash', description: text, outcome: 'allowed',
    })
    const description = h.getHistory('s1')[0].description
    assert.ok(description.startsWith(text.slice(0, 40)), 'nothing in it is secret-shaped, so the beginning is kept')
    assert.ok(description.length <= PERMISSION_OUTCOME_DESCRIPTION_MAX)
  })

  it('keeps no tool input: only the fields the clients were shown', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', {
      requestId: 'p', tool: 'Write', description: 'Write a file', outcome: 'allowed',
      input: { file_path: '/etc/passwd', content: 'SECRET' }, toolInput: { token: 'x' },
    })
    const [e] = h.getHistory('s1')
    assert.deepEqual(Object.keys(e).sort(), ['_seq', 'description', 'outcome', 'requestId', 'timestamp', 'tool', 'type'])
  })

  it('shares the ring buffer cap: the oldest entry goes first and the buffer reports truncation', () => {
    const h = new SessionMessageHistory({ maxMessages: 3 })
    for (let i = 0; i < 5; i++) {
      h.recordHistory('s1', 'permission_outcome', { requestId: `p${i}`, tool: 'Bash', description: String(i), outcome: 'allowed' })
    }
    const kept = h.getHistory('s1').map((e) => e.requestId)
    assert.deepEqual(kept, ['p2', 'p3', 'p4'])
    assert.equal(h.isHistoryTruncated('s1'), true)
  })

  it('survives truncateEntry (the state-file serializer) unchanged apart from _seq', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', { requestId: 'p', tool: 'Bash', description: 'ls', outcome: 'expired' })
    const [e] = h.getHistory('s1')
    const persisted = h.truncateEntry(e)
    assert.equal(persisted._seq, undefined)
    assert.deepEqual({ ...persisted }, { type: 'permission_outcome', requestId: 'p', tool: 'Bash', description: 'ls', outcome: 'expired', timestamp: e.timestamp })
  })

  it('replays as a permission_outcome frame with the session id and the history seq', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', { requestId: 'p', tool: 'Bash', description: 'ls', outcome: 'expired' })
    const frames = []
    sendHistoryEntry((_ws, payload) => frames.push(payload), null, 's1', h.getHistory('s1')[0])
    assert.equal(frames.length, 1)
    assert.equal(frames[0].type, 'permission_outcome')
    assert.equal(frames[0].requestId, 'p')
    assert.equal(frames[0].outcome, 'expired')
    assert.equal(frames[0].sessionId, 's1')
    assert.equal(typeof frames[0].historySeq, 'number')
    assert.equal(frames[0]._seq, undefined)
  })

  it('is left out of a session summary transcript (a marker, not conversation)', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s1', 'permission_outcome', { requestId: 'p', tool: 'Bash', description: 'ls', outcome: 'expired' })
    assert.equal(flattenHistory(h.getHistory('s1')), '')
  })
})

/**
 * Wire a PermissionManager to a stand-in session the way SdkSession / ByokSession
 * do, and put the session under a real SessionManager so its events take the
 * production path (`_wireSessionEvents`).
 */
function makeInProcessSession(mgr, sid, pmOpts = {}) {
  const session = new EventEmitter()
  session.isRunning = false
  session.destroy = () => {}
  const pm = new PermissionManager({ log: { info() {}, warn() {}, error() {} }, ...pmOpts })
  wirePermissionManager(session, pm)
  mgr._sessions.set(sid, { session, name: sid, cwd: '/tmp' })
  mgr._wireSessionEvents(sid, session)
  return { session, pm }
}

describe('SessionManager records permission outcomes: in-process providers (#8348)', () => {
  let mgr
  let pms
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    pms = []
  })
  afterEach(() => {
    for (const pm of pms) pm.clearAll()
    mgr.destroyAll()
  })

  function raise(sid, tool = 'Bash', input = { command: 'ls -la' }, opts) {
    const { session, pm } = makeInProcessSession(mgr, sid, opts)
    pms.push(pm)
    let requestId
    session.once('permission_request', (d) => { requestId = d.requestId })
    const decided = pm.handlePermission(tool, input, null, 'approve')
    return { session, pm, requestId, decided }
  }

  it('records "allowed" when the user allows', async () => {
    const { pm, requestId, decided } = raise('s1')
    assert.ok(requestId)
    assert.equal(outcomes(mgr, 's1').length, 0, 'nothing is recorded while the prompt is open')
    pm.respondToPermission(requestId, 'allow')
    await decided
    const [e, ...rest] = outcomes(mgr, 's1')
    assert.equal(rest.length, 0)
    assert.equal(e.requestId, requestId)
    assert.equal(e.tool, 'Bash')
    assert.equal(e.description, 'ls -la')
    assert.equal(e.outcome, 'allowed')
  })

  it('records "allowed" for allowAlways, "denied" for deny', async () => {
    const a = raise('s1')
    a.pm.respondToPermission(a.requestId, 'allowAlways')
    await a.decided
    const b = raise('s2')
    b.pm.respondToPermission(b.requestId, 'deny')
    await b.decided
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'allowed')
    assert.equal(outcomes(mgr, 's2')[0].outcome, 'denied')
  })

  it('records "expired" when the prompt times out (a deny nobody chose)', async () => {
    const { requestId, decided } = raise('s1', 'Bash', { command: 'sleep 9' }, { timeoutMs: 15 })
    await decided
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.requestId, requestId)
    assert.equal(e.outcome, 'expired', 'a timeout is not a refusal')
  })

  it('records "expired" when the prompt is cleared (the turn ended with it open)', async () => {
    const { pm, requestId, decided } = raise('s1')
    pm.clearAll()
    await decided
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'expired')
    assert.equal(outcomes(mgr, 's1')[0].requestId, requestId)
  })

  it('records "expired" when the prompt is aborted with no user Stop behind it (a failed turn, a teardown) (#8374)', async () => {
    const { session, pm } = makeInProcessSession(mgr, 's1')
    pms.push(pm)
    const ac = new AbortController()
    let requestId
    session.once('permission_request', (d) => { requestId = d.requestId })
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    ac.abort()
    await decided
    assert.equal(outcomes(mgr, 's1')[0].requestId, requestId)
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'expired')
  })

  it('records "stopped" when the user pressed Stop on the open prompt (#8374)', async () => {
    const { session, pm } = makeInProcessSession(mgr, 's1')
    pms.push(pm)
    const ac = new AbortController()
    let requestId
    session.once('permission_request', (d) => { requestId = d.requestId })
    const decided = pm.handlePermission('Bash', { command: 'ls' }, ac.signal, 'approve')
    pm.markPendingStopped()
    ac.abort()
    await decided
    assert.equal(outcomes(mgr, 's1')[0].requestId, requestId)
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'stopped')
  })

  it('records "expired" for a session-level permission_expired event', () => {
    const { session, requestId } = raise('s1')
    session.emit('permission_expired', { requestId, message: 'Permission request expired (session timeout)' })
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'expired')
  })

  it('records exactly one outcome when a prompt is reported ended twice', async () => {
    const { session, pm, requestId, decided } = raise('s1')
    pm.respondToPermission(requestId, 'allow')
    await decided
    // The turn then dies and reports the (already answered) prompt expired.
    session.emit('permission_expired', { requestId, message: 'late' })
    session.emit('permission_resolved', { requestId, decision: 'deny', reason: 'cleared' })
    const all = outcomes(mgr, 's1')
    assert.equal(all.length, 1)
    assert.equal(all[0].outcome, 'allowed', 'the first ending is the true one')
  })

  it('records nothing for a prompt it never saw raised (auto-resolved, or from before a restart)', () => {
    const { session } = makeInProcessSession(mgr, 's1')
    session.emit('permission_resolved', { requestId: 'perm-unknown', decision: 'allow', reason: 'auto_mode' })
    session.emit('permission_expired', { requestId: 'perm-unknown-2', message: 'x' })
    assert.equal(outcomes(mgr, 's1').length, 0)
  })

  it('ignores an AskUserQuestion resolution (it carries a toolUseId, not a requestId)', () => {
    const { session } = makeInProcessSession(mgr, 's1')
    session.emit('permission_resolved', { toolUseId: 'ask-1', reason: 'timeout' })
    assert.equal(outcomes(mgr, 's1').length, 0)
  })

  it('names an AskUserQuestion prompt by its question, not its raw JSON', async () => {
    const { session, pm } = makeInProcessSession(mgr, 's1')
    pms.push(pm)
    session.emit('permission_request', {
      requestId: 'perm-ask', tool: 'AskUserQuestion',
      description: '{"questions":[{"question":"Which shape?","options":[]}]}',
      input: { questions: [{ question: 'Which shape?', options: [] }] },
    })
    session.emit('permission_expired', { requestId: 'perm-ask', message: 'x' })
    assert.equal(outcomes(mgr, 's1')[0].description, 'Which shape?')
  })

  it('keeps values under sensitive keys out of the recorded description and the serialized state', async () => {
    const { pm, requestId, decided } = raise('s1', 'mcp__svc__call', {
      password: 'ordinarySecret123', config: { api_key: 'nestedSecret456' }, region: 'eu-west-1',
    })
    pm.respondToPermission(requestId, 'deny')
    await decided
    const [e] = outcomes(mgr, 's1')
    assert.ok(e, 'an outcome was recorded')
    assert.ok(e.description.includes('eu-west-1'), 'the non-sensitive input is still described')
    assert.equal(e.description.includes('ordinarySecret123'), false)
    assert.equal(e.description.includes('nestedSecret456'), false)
    assert.ok(e.description.includes('[REDACTED]'))
    const serialized = JSON.stringify(mgr.serializeState())
    assert.equal(serialized.includes('ordinarySecret123'), false, 'not in the state file payload')
    assert.equal(serialized.includes('nestedSecret456'), false)
  })

  it('records the file path of a LARGE Write (input past the broadcast cap), not the truncation wrapper', async () => {
    const { pm, requestId, decided } = raise('s1', 'Write', {
      content: 'x'.repeat(20_000), file_path: '/Users/me/proj/src/big-file.ts',
    })
    pm.respondToPermission(requestId, 'allow')
    await decided
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description, '/Users/me/proj/src/big-file.ts')
    assert.equal(e.description.includes('_truncated'), false)
  })

  it('a large input with a credential under a sensitive key still records the path and not the credential', async () => {
    const { pm, requestId, decided } = raise('s1', 'Write', {
      content: 'x'.repeat(20_000), file_path: '/srv/app/config.ts', password: 'ordinarySecret123',
    })
    pm.respondToPermission(requestId, 'deny')
    await decided
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description, '/srv/app/config.ts')
    assert.equal(JSON.stringify(mgr.serializeState()).includes('ordinarySecret123'), false)
  })

  it('a large input with no identifying field records the tool only, never the truncation wrapper', async () => {
    const { pm, requestId, decided } = raise('s1', 'mcp__svc__call', { blob: 'lorem ipsum '.repeat(2000), password: 'ordinarySecret123' })
    pm.respondToPermission(requestId, 'deny')
    await decided
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description, '')
    assert.equal(JSON.stringify(mgr.serializeState()).includes('ordinarySecret123'), false)
  })

  it('does not journal a Task subagent prompt relayed as agent_event (the client cannot reconcile nested cards yet)', () => {
    const { session } = makeInProcessSession(mgr, 's1')
    session.emit('agent_event', {
      parentToolUseId: 'tu_task', type: 'permission_request',
      payload: { requestId: 'perm-child', tool: 'mcp__foo__bar', description: 'x', input: {} },
    })
    assert.equal(mgr._permissionRequests.has('perm-child'), false, 'not tracked')
    session.emit('agent_event', {
      parentToolUseId: 'tu_task', type: 'permission_resolved',
      payload: { requestId: 'perm-child', decision: 'allow', reason: 'user' },
    })
    assert.equal(outcomes(mgr, 's1').length, 0)
  })

  it('redacts before it clips: a key straddling the length cap is not left as an unmatched partial', () => {
    // The key starts ~29 characters before the cap, so only a prefix of it survives
    // clipping; a pattern with a length floor no longer matches that prefix.
    mgr.notePermissionRequest('s1', {
      requestId: 'perm-cap', tool: 'Bash',
      description: `${'x'.repeat(470)} sk-${'A'.repeat(45)}`,
    })
    mgr._sessions.set('s1', mgr._sessions.get('s1') || { session: new EventEmitter(), name: 's1', cwd: '/tmp' })
    mgr.recordPermissionOutcome('perm-cap', 'allowed')
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description.includes('sk-AAAA'), false)
    assert.ok(e.description.length <= PERMISSION_OUTCOME_DESCRIPTION_MAX)
  })

  it('records into the OWNING session only', async () => {
    const a = raise('s1')
    const b = raise('s2')
    a.pm.respondToPermission(a.requestId, 'allow')
    await a.decided
    assert.equal(outcomes(mgr, 's1').length, 1)
    assert.equal(outcomes(mgr, 's2').length, 0, 'the other session\'s open prompt is untouched')
    b.pm.respondToPermission(b.requestId, 'deny')
    await b.decided
    assert.equal(outcomes(mgr, 's2')[0].outcome, 'denied')
  })

  it('schedules a persist, so the outcome reaches the state file', async () => {
    const spy = mock.method(mgr, '_schedulePersist')
    const { pm, requestId, decided } = raise('s1')
    pm.respondToPermission(requestId, 'allow')
    await decided
    assert.ok(spy.mock.calls.length >= 1)
  })

  it('does not record into a session that is being torn down', async () => {
    const { pm, requestId, decided } = raise('s1')
    mgr._sessions.get('s1')._destroying = true
    pm.respondToPermission(requestId, 'allow')
    await decided
    assert.equal(outcomes(mgr, 's1').length, 0)
  })

  it('releases a prompt from the registry the moment its outcome is recorded', async () => {
    const { pm, requestId, decided } = raise('s1')
    assert.ok(mgr._permissionRequests.has(requestId), 'tracked while open')
    pm.respondToPermission(requestId, 'allow')
    await decided
    assert.equal(mgr._permissionRequests.has(requestId), false, 'released once recorded')
  })

  it('forgets the open prompts of a session that is removed', () => {
    const { requestId } = raise('s1')
    assert.ok(mgr._permissionRequests.has(requestId))
    mgr._cleanupSessionMaps('s1')
    assert.equal(mgr._permissionRequests.has(requestId), false)
  })

  it('bounds the registry of open prompts', () => {
    for (let i = 0; i < 400; i++) mgr.notePermissionRequest('s1', { requestId: `perm-${i}`, tool: 'Bash', description: 'x' })
    assert.ok(mgr._permissionRequests.size <= 256)
    assert.equal(mgr._permissionRequests.has('perm-399'), true, 'the newest are kept')
    assert.equal(mgr._permissionRequests.has('perm-0'), false, 'the stalest are evicted')
  })
})

/** The hook-routed pipeline: a real ws-permissions handler over a real SessionManager. */
describe('SessionManager records permission outcomes: hook-routed providers (#8348)', () => {
  let mgr
  let handler
  let pendingPermissions
  let permissionSessionMap
  let resolver
  const SECRET = 'hook-secret-1'

  function makeReq(body, headers = {}) {
    const emitter = new EventEmitter()
    emitter.method = 'POST'
    emitter.headers = headers
    emitter.socket = { remoteAddress: '127.0.0.1' }
    process.nextTick(() => {
      emitter.emit('data', Buffer.from(body))
      emitter.emit('end')
    })
    emitter.destroy = mock.fn()
    emitter.setEncoding = mock.fn()
    emitter.pause = mock.fn()
    return emitter
  }
  function makeRes() {
    const listeners = {}
    return {
      statusCode: null,
      body: null,
      headersSent: false,
      writeHead: mock.fn(function (code) { this.statusCode = code; this.headersSent = true }),
      end: mock.fn(function (b) { this.body = b }),
      on(event, cb) { listeners[event] = cb; return this },
      emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
    }
  }

  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    const session = new EventEmitter()
    session.isRunning = false
    session.destroy = () => {}
    session.cwd = '/tmp'
    mgr._sessions.set('s1', { session, name: 's1', cwd: '/tmp' })
    mgr._wireSessionEvents('s1', session)
    pendingPermissions = new Map()
    permissionSessionMap = new Map()
    handler = createPermissionHandler({
      sendFn: mock.fn(),
      broadcastFn: mock.fn(),
      validateBearerAuth: mock.fn(() => true),
      pushManager: null,
      pendingPermissions,
      permissionSessionMap,
      getSessionManager: () => mgr,
      findSessionByHookSecret: (token) => (token === SECRET ? { session, sessionId: 's1' } : null),
    })
    resolver = createPermissionResolver({
      permissionSessionMap,
      pendingPermissions,
      getSessionManager: () => mgr,
      resolveLegacyPermission: handler.resolvePermission,
      getPermissionAudit: () => null,
    })
  })
  afterEach(() => {
    mock.timers.reset()
    handler.destroy()
    mgr.destroyAll()
  })

  async function raise(body = { tool_name: 'Bash', tool_input: { command: 'git status' } }) {
    const res = makeRes()
    handler.handlePermissionRequest(makeReq(JSON.stringify(body), { authorization: `Bearer ${SECRET}` }), res)
    await new Promise((r) => setImmediate(r))
    const [requestId] = [...pendingPermissions.keys()]
    assert.ok(requestId, 'the hook request is held pending')
    return { res, requestId }
  }

  it('records "allowed" when the user allows (WS or HTTP, via the resolver)', async () => {
    const { requestId } = await raise()
    assert.equal(outcomes(mgr, 's1').length, 0)
    const result = resolver.resolve(requestId, 'allow', null, { clientId: 'c1' })
    assert.equal(result.kind, 'resolved')
    const [e, ...rest] = outcomes(mgr, 's1')
    assert.equal(rest.length, 0)
    assert.equal(e.requestId, requestId)
    assert.equal(e.tool, 'Bash')
    assert.equal(e.description, 'git status')
    assert.equal(e.outcome, 'allowed')
  })

  it('records "denied" when the user denies', async () => {
    const { requestId } = await raise()
    resolver.resolve(requestId, 'deny', null, { clientId: 'c1' })
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'denied')
  })

  it('records "expired" when the hook goes away with no answer', async () => {
    const { res, requestId } = await raise()
    res.emit('close')
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.requestId, requestId)
    assert.equal(e.outcome, 'expired')
  })

  it('records "expired" when the 5-minute timer auto-denies', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { requestId } = await raise()
    mock.timers.tick(300_000)
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.requestId, requestId)
    assert.equal(e.outcome, 'expired')
  })

  it('records "expired" when the session reports the turn dead (permission_expired)', async () => {
    const { requestId } = await raise()
    mgr.getSession('s1').session.emit('permission_expired', { requestId, message: 'turn ended' })
    assert.equal(outcomes(mgr, 's1')[0].outcome, 'expired')
  })

  it('never records two outcomes: answered, then the turn dies and the hook closes', async () => {
    const { res, requestId } = await raise()
    resolver.resolve(requestId, 'allow', null, { clientId: 'c1' })
    mgr.getSession('s1').session.emit('permission_expired', { requestId, message: 'late' })
    res.emit('close')
    const all = outcomes(mgr, 's1')
    assert.equal(all.length, 1)
    assert.equal(all[0].outcome, 'allowed')
  })

  it('names an AskUserQuestion hook prompt by its question', async () => {
    const { res } = await raise({
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which shape?', options: [{ label: 'Round' }] }] },
    })
    res.emit('close')
    assert.equal(outcomes(mgr, 's1')[0].description, 'Which shape?')
  })

  it('records nothing for a prompt no session owns (the hook secret maps to nothing)', async () => {
    const res = makeRes()
    handler.handlePermissionRequest(makeReq(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {}), res)
    await new Promise((r) => setImmediate(r))
    const [requestId] = [...pendingPermissions.keys()]
    resolver.resolve(requestId, 'allow', null, { clientId: 'c1' })
    assert.equal(outcomes(mgr, 's1').length, 0)
    assert.equal(mgr._permissionRequests.size, 0)
  })

  // The recording is best-effort: whatever the session manager does (no such
  // methods, or methods that throw), the hook is still answered and cleaned up.
  // The answer goes through the REAL resolver, because that is where a user's
  // answer is journaled.
  for (const [label, makeManager] of [
    ['lacks the recording methods', () => ({ calls: { note: 0, record: 0 }, sm: { getSession: () => null } })],
    ['throws from the recording methods', () => {
      const calls = { note: 0, record: 0 }
      return {
        calls,
        sm: {
          getSession: () => null,
          notePermissionRequest() { calls.note++; throw new Error('boom') },
          recordPermissionOutcome() { calls.record++; throw new Error('boom') },
        },
      }
    }],
  ]) {
    it(`still answers the hook when the session manager ${label}`, async () => {
      const { calls, sm } = makeManager()
      const pending = new Map()
      const routes = new Map()
      const stubbed = createPermissionHandler({
        sendFn: mock.fn(),
        broadcastFn: mock.fn(),
        validateBearerAuth: mock.fn(() => true),
        pushManager: null,
        pendingPermissions: pending,
        permissionSessionMap: routes,
        getSessionManager: () => sm,
        findSessionByHookSecret: () => ({ session: {}, sessionId: 's1' }),
      })
      const realResolver = createPermissionResolver({
        permissionSessionMap: routes,
        pendingPermissions: pending,
        getSessionManager: () => sm,
        resolveLegacyPermission: stubbed.resolvePermission,
        getPermissionAudit: () => null,
      })
      try {
        const res = makeRes()
        stubbed.handlePermissionRequest(makeReq(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { authorization: 'Bearer x' }), res)
        await new Promise((r) => setImmediate(r))
        assert.equal(pending.size, 1, 'the request became pending')
        const [requestId] = [...pending.keys()]
        assert.equal(routes.get(requestId), 's1', 'and is routed to its session')
        assert.equal(res.statusCode, null, 'nothing is written until it is answered')

        const result = realResolver.resolve(requestId, 'allow', null, { clientId: 'c1' })

        assert.equal(result.kind, 'resolved')
        assert.equal(res.statusCode, 200)
        assert.deepEqual(JSON.parse(res.body), { decision: 'allow' })
        assert.equal(pending.size, 0, 'the pending entry is cleaned up')
        assert.equal(routes.size, 0, 'and so is its route')
        if (label.startsWith('throws')) {
          assert.equal(calls.note, 1, 'the request was reported to the (throwing) recorder')
          assert.equal(calls.record, 1, 'and so was the answer: the containment really was exercised')
        }
      } finally {
        stubbed.destroy()
      }
    })
  }

  it('records the file path of a LARGE Write (input past the broadcast cap), not the truncation wrapper', async () => {
    const { res, requestId } = await raise({
      tool_name: 'Write',
      tool_input: { content: 'x'.repeat(20_000), file_path: '/Users/me/proj/src/big-file.ts' },
    })
    resolver.resolve(requestId, 'allow', null, { clientId: 'c1' })
    res.emit('close')
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description, '/Users/me/proj/src/big-file.ts')
    assert.equal(e.description.includes('_truncated'), false)
  })

  it('a large input with a credential under a sensitive key still records the path and not the credential', async () => {
    const { requestId } = await raise({
      tool_name: 'Write',
      tool_input: { content: 'x'.repeat(20_000), file_path: '/srv/app/config.ts', password: 'ordinarySecret123' },
    })
    resolver.resolve(requestId, 'deny', null, { clientId: 'c1' })
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description, '/srv/app/config.ts')
    assert.equal(JSON.stringify(mgr.serializeState()).includes('ordinarySecret123'), false)
  })

  it('a large input with no identifying field records the tool only, never the truncation wrapper', async () => {
    const { requestId } = await raise({
      tool_name: 'mcp__svc__call',
      tool_input: { blob: 'lorem ipsum '.repeat(2000), password: 'ordinarySecret123' },
    })
    resolver.resolve(requestId, 'deny', null, { clientId: 'c1' })
    const [e] = outcomes(mgr, 's1')
    assert.equal(e.description, '')
    assert.equal(e.tool, 'mcp__svc__call')
  })

  // #8348 -- the description the transcript keeps is built from the SANITIZED
  // input, so a value under a sensitive key never reaches history or the state file.
  it('keeps values under sensitive keys out of the recorded description and the serialized state', async () => {
    const { res, requestId } = await raise({
      tool_name: 'mcp__svc__call',
      tool_input: { password: 'ordinarySecret123', config: { api_key: 'nestedSecret456' }, region: 'eu-west-1' },
    })
    resolver.resolve(requestId, 'deny', null, { clientId: 'c1' })
    res.emit('close')
    const [e] = outcomes(mgr, 's1')
    assert.ok(e, 'an outcome was recorded')
    assert.ok(e.description.includes('eu-west-1'), 'the non-sensitive input is still described')
    assert.equal(e.description.includes('ordinarySecret123'), false)
    assert.equal(e.description.includes('nestedSecret456'), false)
    assert.ok(e.description.includes('[REDACTED]'))
    const serialized = JSON.stringify(mgr.serializeState())
    assert.equal(serialized.includes('ordinarySecret123'), false, 'not in the state file payload')
    assert.equal(serialized.includes('nestedSecret456'), false)
  })
})

describe('the replay a session switch triggers delivers the outcome (#8348)', () => {
  it('a forceFull switch replay carries the expired prompt that no live frame can', async () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    try {
      const { session, pm } = makeInProcessSession(mgr, 's1')
      session.getActiveAgents = () => [] // read by the replay's re-seed step
      let requestId
      session.once('permission_request', (d) => { requestId = d.requestId })
      const decided = pm.handlePermission('Bash', { command: 'git push' }, null, 'approve')
      mgr._recordHistory('s1', 'message', { type: 'user_input', content: 'push it', timestamp: 1 })
      pm.clearAll() // the turn ended with the prompt open
      await decided

      const sent = []
      const ws = { readyState: 1, send() {}, close() {} }
      const ctx = {
        sessionManager: mgr,
        clients: new Map([[ws, { id: 'c1', activeSessionId: 's1', historyCursors: { s1: 99 } }]]),
        send: (_ws, payload) => sent.push(payload),
        permissions: null,
      }
      replayHistory(ctx, ws, 's1', { forceFull: true })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      const types = sent.map((m) => m.type)
      assert.equal(types[0], 'history_replay_start')
      assert.equal(sent[0].fullHistory, true)
      assert.equal(types.at(-1), 'history_replay_end')
      const frames = sent.filter((m) => m.type === 'permission_outcome')
      assert.equal(frames.length, 1)
      assert.equal(frames[0].requestId, requestId)
      assert.equal(frames[0].tool, 'Bash')
      assert.equal(frames[0].description, 'git push')
      assert.equal(frames[0].outcome, 'expired')
      assert.equal(frames[0].sessionId, 's1')
      assert.equal(typeof frames[0].historySeq, 'number')
      // The live frames themselves are still never replayed.
      assert.equal(types.some((t) => t === 'permission_request' || t === 'permission_resolved' || t === 'permission_expired'), false)
    } finally {
      mgr.destroyAll()
    }
  })
})

describe('a prompt still open at shutdown (#8348)', () => {
  it('is recorded as expired in the final state write, so the restarted daemon replays it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-outcome-shutdown-'))
    const stateFile = join(dir, 'state.json')
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    let restored
    try {
      const session = new EventEmitter()
      session.isRunning = false
      session.destroy = () => {}
      session.cwd = '/tmp'
      const pm = new PermissionManager({ log: { info() {}, warn() {}, error() {} } })
      wirePermissionManager(session, pm)
      mgr._sessions.set('s1', { session, name: 's1', cwd: '/tmp' })
      mgr._wireSessionEvents('s1', session)
      let requestId
      session.once('permission_request', (d) => { requestId = d.requestId })
      const decided = pm.handlePermission('Bash', { command: 'make deploy' }, null, 'approve')
      assert.ok(requestId)
      assert.equal(outcomes(mgr, 's1').length, 0, 'open: nothing recorded yet')

      mgr.destroyAll()
      pm.clearAll()
      await decided

      const written = JSON.parse(readFileSync(stateFile, 'utf8'))
      const history = written.sessions[0].history
      assert.deepEqual(
        history.filter((e) => e.type === 'permission_outcome').map((e) => [e.requestId, e.tool, e.description, e.outcome]),
        [[requestId, 'Bash', 'make deploy', 'expired']],
      )

      // ...and the next daemon replays it.
      restored = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
      const sid = restored.restoreState()
      assert.deepEqual(outcomes(restored, sid).map((e) => e.outcome), ['expired'])
    } finally {
      restored?.destroyAll()
      mgr.destroyAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records nothing at shutdown for a prompt that already ended', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-outcome-shutdown2-'))
    const stateFile = join(dir, 'state.json')
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    try {
      const session = new EventEmitter()
      session.isRunning = false
      session.destroy = () => {}
      session.cwd = '/tmp'
      const pm = new PermissionManager({ log: { info() {}, warn() {}, error() {} } })
      wirePermissionManager(session, pm)
      mgr._sessions.set('s1', { session, name: 's1', cwd: '/tmp' })
      mgr._wireSessionEvents('s1', session)
      let requestId
      session.once('permission_request', (d) => { requestId = d.requestId })
      const decided = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.respondToPermission(requestId, 'deny')
      await decided
      mgr.destroyAll()
      const history = JSON.parse(readFileSync(stateFile, 'utf8')).sessions[0].history
      assert.deepEqual(history.filter((e) => e.type === 'permission_outcome').map((e) => e.outcome), ['denied'])
    } finally {
      mgr.destroyAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('permission outcomes survive a daemon restart (#8348)', () => {
  const managers = []
  afterEach(() => { for (const m of managers.splice(0)) m.destroyAll() })

  function boot(stateFile) {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile })
    managers.push(mgr)
    const sid = mgr.restoreState()
    assert.ok(sid, 'a session was restored')
    return { mgr, sid }
  }

  const persisted = () => ([
    { type: 'message', messageType: 'user_input', content: 'run it', timestamp: 1 },
    { type: 'tool_start', toolUseId: 'toolu_1', tool: 'Bash', input: { command: 'ls' }, timestamp: 2 },
    { type: 'permission_outcome', requestId: 'perm-1', tool: 'Bash', description: 'ls', outcome: 'expired', timestamp: 3 },
    { type: 'tool_result', toolUseId: 'toolu_1', result: 'denied', timestamp: 4 },
    { type: 'permission_outcome', requestId: 'perm-2', tool: 'Write', description: 'notes.txt', outcome: 'allowed', timestamp: 5 },
  ])

  it('restores the entries, saves them again, and restores them a second time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-outcome-rt-'))
    try {
      const file1 = join(dir, 'state1.json')
      writeFileSync(file1, JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        sessions: [{ name: 'S', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history: persisted() }],
      }))
      const first = boot(file1)
      const restored = outcomes(first.mgr, first.sid)
      assert.deepEqual(restored.map((e) => [e.requestId, e.outcome]), [['perm-1', 'expired'], ['perm-2', 'allowed']])

      // Save: the serializer keeps the entries (and only strips the internal _seq).
      const saved = first.mgr.serializeState().sessions.find((s) => s.id === first.sid)
      const savedOutcomes = saved.history.filter((e) => e.type === 'permission_outcome')
      assert.deepEqual(savedOutcomes.map((e) => e.requestId), ['perm-1', 'perm-2'])
      assert.ok(savedOutcomes.every((e) => e._seq === undefined))
      assert.deepEqual(savedOutcomes[0], persisted()[2])

      // ...and a second restore from what was just saved.
      const file2 = join(dir, 'state2.json')
      writeFileSync(file2, JSON.stringify({ version: 1, timestamp: Date.now(), sessions: [saved] }))
      const second = boot(file2)
      assert.deepEqual(
        outcomes(second.mgr, second.sid).map((e) => [e.requestId, e.tool, e.description, e.outcome]),
        [['perm-1', 'Bash', 'ls', 'expired'], ['perm-2', 'Write', 'notes.txt', 'allowed']],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not record a second outcome for a prompt whose outcome was restored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-outcome-dedupe-'))
    try {
      const file = join(dir, 'state.json')
      writeFileSync(file, JSON.stringify({
        version: 1, timestamp: Date.now(),
        sessions: [{ name: 'S', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, history: persisted() }],
      }))
      const { mgr, sid } = boot(file)
      // A late report for the same prompt (the registry knows it again): the
      // history layer's own guard keeps the transcript at one record.
      mgr.notePermissionRequest(sid, { requestId: 'perm-1', tool: 'Bash', description: 'ls' })
      mgr.recordPermissionOutcome('perm-1', 'denied')
      const all = outcomes(mgr, sid).filter((e) => e.requestId === 'perm-1')
      assert.equal(all.length, 1)
      assert.equal(all[0].outcome, 'expired')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
