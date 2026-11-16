/**
 * `resolvedBy` on `permission_resolved` (docs/security/agent-principals.md section 9;
 * #9119, S4 of #9112): WHO or WHAT resolved a prompt, as a class.
 *
 * Every resolution path of both pipelines is driven for real (a real PermissionManager, the
 * real EventNormalizer, the real legacy resolver and a real WsServer for the hook-routed
 * answer) and each case has a POSITIVE control: the expected kind is asserted on the frame a
 * client receives, and the same frame is searched for anything that identifies a client, a
 * device or a credential. The oracle is the literal below, not the module's own table.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { PermissionManager } from '../src/permission-manager.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { buildLegacyResolvedBroadcast, createPermissionResolver } from '../src/permission-resolver.js'
import { EditedInputRefusedError } from '../src/edited-input.js'
import {
  RESOLVED_BY_KINDS, RESOLVED_BY_LABEL_MAX, RESOLVED_BY, normalizeResolvedBy, resolvedByForReason,
} from '../src/permission-resolved-by.js'
import { PERMISSION_RESOLVED_BY_KIND_VALUES, ServerPermissionResolvedSchema } from '@chroxy/protocol'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

const silentLog = { info() {}, warn() {} }
const mk = (opts = {}) => new PermissionManager({ log: silentLog, ...opts })
const CTX = { sessionId: 'sess-1', mode: 'multi', getSessionEntry: () => null }

/** What a client receives for one manager event, through the real normalizer. */
function wire(event) {
  const normalizer = new EventNormalizer()
  try {
    const result = normalizer.normalize('permission_resolved', event, CTX)
    return result.messages.map((m) => m.msg)
  } finally { normalizer.destroy() }
}

/** Collect every permission_resolved a manager emits. */
function collect(pm) {
  const events = []
  pm.on('permission_resolved', (e) => events.push(e))
  return events
}

const SECRETS = ['client-', 'device', 'token', 'Bearer', 'clientId', 'deviceName', 'principalId']
function assertIdentifiesNobody(frame) {
  const text = JSON.stringify(frame)
  for (const needle of SECRETS) assert.equal(text.includes(needle), false, `${needle} must not appear in ${text}`)
}

describe('the vocabulary', () => {
  it('is exactly the contract list, and the protocol and the daemon agree on it', () => {
    const ORACLE = ['user', 'agent', 'rule', 'timeout', 'auto_mode', 'abort', 'cleared']
    assert.deepEqual([...RESOLVED_BY_KINDS], ORACLE)
    assert.deepEqual([...PERMISSION_RESOLVED_BY_KIND_VALUES], ORACLE)
  })

  it('normalizeResolvedBy keeps a kind, drops every other key and every unknown kind', () => {
    assert.deepEqual(normalizeResolvedBy({ kind: 'user' }), { kind: 'user' })
    assert.deepEqual(normalizeResolvedBy({ kind: 'user', clientId: 'client-1', deviceName: 'iPhone', token: 'tok', principalId: 'pr-1', label: 'x' }), { kind: 'user' })
    for (const bad of [undefined, null, 'user', 7, [], { kind: 'root' }, { kind: 1 }, {}, { label: 'x' }]) {
      assert.equal(normalizeResolvedBy(bad), undefined, JSON.stringify(bad))
    }
  })

  it('a label survives only on an agent, bounded and free of control characters', () => {
    assert.deepEqual(normalizeResolvedBy({ kind: 'agent', label: 'supervisor' }), { kind: 'agent', label: 'supervisor' })
    for (const kind of RESOLVED_BY_KINDS.filter((k) => k !== 'agent')) {
      assert.deepEqual(normalizeResolvedBy({ kind, label: 'supervisor' }), { kind }, kind)
    }
    assert.deepEqual(normalizeResolvedBy({ kind: 'agent', label: 'x'.repeat(RESOLVED_BY_LABEL_MAX + 1) }), { kind: 'agent' })
    assert.deepEqual(normalizeResolvedBy({ kind: 'agent', label: 'a\nb' }), { kind: 'agent' })
    assert.deepEqual(normalizeResolvedBy({ kind: 'agent', label: '' }), { kind: 'agent' })
    assert.deepEqual(normalizeResolvedBy({ kind: 'agent' }), { kind: 'agent' })
  })

  it('the shared constants hold nothing but their kind, and cannot be mutated', () => {
    for (const [kind, value] of Object.entries(RESOLVED_BY)) {
      assert.deepEqual(value, { kind })
      assert.equal(Object.isFrozen(value), true, kind)
    }
    assert.equal(Object.hasOwn(RESOLVED_BY, 'agent'), false, 'agent needs a label and nothing produces it yet')
  })

  it('maps the manager reasons to a kind, and anything unknown to cleared (never to a person)', () => {
    const ORACLE = {
      user: 'user', timeout: 'timeout', stopped: 'abort', aborted: 'abort', cancelled: 'abort',
      auto_mode: 'auto_mode', auto_mode_mcp_trust_bypass: 'auto_mode', cleared: 'cleared', superseded: 'cleared',
    }
    for (const [reason, kind] of Object.entries(ORACLE)) assert.equal(resolvedByForReason(reason).kind, kind, reason)
    for (const odd of [undefined, null, '', 'someone-new', 42]) assert.equal(resolvedByForReason(odd).kind, 'cleared')
  })
})

describe('every resolution path says who resolved it (real manager, real normalizer)', () => {
  it('user: an answer, allow and deny, scoped or not', async () => {
    for (const [decision, scope] of [['allow', undefined], ['allow', 'session'], ['deny', undefined], ['allowAlways', undefined]]) {
      const pm = mk()
      const events = collect(pm)
      const p = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.respondToPermission([...pm._pendingPermissions.keys()][0], decision, undefined, undefined, scope, RESOLVED_BY.user)
      await p
      assert.deepEqual(events.map((e) => e.resolvedBy), [{ kind: 'user' }], `${decision}/${scope}`)
      const [frame] = wire(events[0])
      assert.equal(frame.type, 'permission_resolved')
      assert.deepEqual(frame.resolvedBy, { kind: 'user' })
      assertIdentifiesNobody(frame)
      pm.destroy()
    }
  })

  it('user: an answered AskUserQuestion carries it on the event (no wire frame exists for it)', async () => {
    const pm = mk()
    const events = collect(pm)
    const p = pm._handleAskUserQuestion({ questions: [{ question: 'go?' }] }, null)
    pm.respondToQuestion('yes')
    await p
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [['answered', { kind: 'user' }]])
    assert.deepEqual(wire(events[0]), [], 'the answered question announces nothing on the wire, as before')
    pm.destroy()
  })

  it('timeout: a prompt, an MCP trust prompt and a question that nobody answered', async () => {
    const pm = mk({ timeoutMs: 5 })
    const events = collect(pm)
    assert.equal((await pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')).behavior, 'deny')
    assert.equal(await pm.requestMcpTrust({ name: 'slow', command: '/usr/bin/true', args: [], envKeys: [] }), false)
    await pm._handleAskUserQuestion({ questions: [{ question: 'go?' }] }, null)
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [
      ['timeout', { kind: 'timeout' }], ['timeout', { kind: 'timeout' }], ['timeout', { kind: 'timeout' }],
    ])
    const [frame] = wire(events[0])
    assert.deepEqual(frame.resolvedBy, { kind: 'timeout' })
    assert.equal(frame.reason, 'timeout')
    assertIdentifiesNobody(frame)
    pm.destroy()
  })

  it('auto_mode: an allow on a mode switch, and the MCP-trust deny the switch forces', async () => {
    const pm = mk()
    const events = collect(pm)
    const prompt = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
    const trust = pm.requestMcpTrust({ name: 'srv', command: '/usr/bin/true', args: [], envKeys: [] })
    pm.autoAllowPending()
    assert.equal((await prompt).behavior, 'allow')
    assert.equal(await trust, false)
    assert.deepEqual(events.map((e) => [e.decision, e.reason, e.resolvedBy]).sort(), [
      ['allow', 'auto_mode', { kind: 'auto_mode' }],
      ['deny', 'auto_mode_mcp_trust_bypass', { kind: 'auto_mode' }],
    ])
    assert.deepEqual(wire(events[0])[0].resolvedBy, { kind: 'auto_mode' })
    pm.destroy()
  })

  it('abort: an aborted turn and a user Stop are both an abort (the reason still tells them apart)', async () => {
    const pm = mk()
    const events = collect(pm)
    const turn = new AbortController()
    const aborted = pm.handlePermission('Bash', { command: 'ls' }, turn.signal, 'approve')
    turn.abort()
    await aborted
    const stop = new AbortController()
    const stopped = pm.handlePermission('Bash', { command: 'pwd' }, stop.signal, 'approve')
    pm.markUserStopInFlight()
    stop.abort()
    await stopped
    const question = new AbortController()
    const asked = pm._handleAskUserQuestion({ questions: [{ question: 'go?' }] }, question.signal)
    question.abort()
    await asked
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [
      ['aborted', { kind: 'abort' }], ['stopped', { kind: 'abort' }], ['stopped', { kind: 'abort' }],
    ])
    const [frame] = wire(events[0])
    assert.deepEqual([frame.reason, frame.resolvedBy], ['aborted', { kind: 'abort' }])
    pm.destroy()
  })

  it('abort: an explicit-consent request cancelled by its signal', async () => {
    const pm = mk()
    const events = collect(pm)
    const controller = new AbortController()
    const consent = pm.requestExplicitConsent({
      requestId: 'consent-1', clientId: 'client-9', tool: 'dev_preview', signal: controller.signal,
      input: { target: 'x' }, description: 'Publish a preview',
    })
    controller.abort()
    assert.equal(await consent, false)
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [['cancelled', { kind: 'abort' }]])
    assertIdentifiesNobody(events[0])
    pm.destroy()
  })

  it('user (explicit consent): the answer of the bound client names the class, never the client', async () => {
    const pm = mk()
    const events = collect(pm)
    const consent = pm.requestExplicitConsent({
      requestId: 'consent-2', clientId: 'client-9', tool: 'dev_preview', input: { target: 'x' }, description: 'Publish a preview',
    })
    assert.equal(pm.respondToExplicitConsent('consent-2', 'allow', { clientId: 'client-9' }), true)
    assert.equal(await consent, true)
    assert.deepEqual(events.map((e) => [e.decision, e.reason, e.resolvedBy]), [['allow', 'user', { kind: 'user' }]])
    assertIdentifiesNobody(events[0])
    pm.destroy()
  })

  it('cleared: message completion drains the prompt and the question; a newer question supersedes an older one', async () => {
    const pm = mk()
    const events = collect(pm)
    const prompt = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
    const question = pm._handleAskUserQuestion({ questions: [{ question: 'first?' }] }, null)
    pm.clearAll({ userStop: false })
    await prompt
    await question
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [['cleared', { kind: 'cleared' }], ['cleared', { kind: 'cleared' }]])
    events.length = 0

    const older = pm._handleAskUserQuestion({ questions: [{ question: 'older?' }] }, null)
    const newer = pm._handleAskUserQuestion({ questions: [{ question: 'newer?' }] }, null)
    await older
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [['superseded', { kind: 'cleared' }]])
    const [frame] = wire(events[0])
    assert.deepEqual([frame.reason, frame.resolvedBy], ['superseded', { kind: 'cleared' }], 'the one question frame on the wire carries it')
    pm.clearAll({ userStop: false })
    await newer
    pm.destroy()
  })

  it('cleared vs abort: draining on a Stop is an abort', async () => {
    const pm = mk()
    const events = collect(pm)
    const prompt = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
    pm.clearAll({ userStop: true })
    await prompt
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [['stopped', { kind: 'abort' }]])
    pm.destroy()
  })

  it('rule: a rule decides before any prompt exists, so NOTHING is announced, and the wire would carry rule faithfully', async () => {
    const pm = mk()
    const events = collect(pm)
    pm.setRules([{ tool: 'Read', decision: 'allow' }, { tool: 'Glob', decision: 'deny' }])
    assert.equal((await pm.handlePermission('Read', { file_path: '/tmp/notes.txt' }, null, 'approve')).behavior, 'allow')
    assert.equal((await pm.handlePermission('Glob', { pattern: '*.txt' }, null, 'approve')).behavior, 'deny')
    assert.deepEqual(events, [], 'a rule-matched call emits no permission_resolved (#6842): there is no frame to attribute')
    // The vocabulary is ready for the day a rule resolves a pending prompt.
    const [frame] = wire({ requestId: 'r', decision: 'allow', reason: 'rule', resolvedBy: { kind: 'rule' } })
    assert.deepEqual(frame.resolvedBy, { kind: 'rule' })
    pm.destroy()
  })
})

describe('who answered: only a client is a person (#9119 review)', () => {
  it('an answer with no stated source is never a person: it reads as cleared', async () => {
    const pm = mk()
    const events = collect(pm)
    const p = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
    pm.respondToPermission([...pm._pendingPermissions.keys()][0], 'allow')
    await p
    assert.deepEqual(events.map((e) => [e.reason, e.resolvedBy]), [['user', { kind: 'cleared' }]], 'reason is unchanged; the class is not a claim about a person')
    pm.destroy()
  })

  it('the stated source is honoured, and is rebuilt (nothing but the class survives)', async () => {
    for (const [given, want] of [[{ kind: 'rule' }, 'rule'], [{ kind: 'user', clientId: 'client-1' }, 'user'], [{ kind: 'root' }, 'cleared']]) {
      const pm = mk()
      const events = collect(pm)
      const p = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.respondToPermission([...pm._pendingPermissions.keys()][0], 'deny', undefined, undefined, undefined, given)
      await p
      assert.deepEqual(events[0].resolvedBy, { kind: want })
      pm.destroy()
    }
  })

  function resolverFor(session) {
    return createPermissionResolver({
      permissionSessionMap: new Map([['r1', 's1']]), pendingPermissions: new Map(),
      getSessionManager: () => ({ getSession: () => ({ session }) }), resolveLegacyPermission() {}, getPermissionAudit: () => null,
    })
  }

  it("the resolver's client answer is a user; the deny after a refused edit is the daemon's (rule)", () => {
    const calls = []
    const session = { respondToPermission: (...a) => { calls.push(a); return true } }
    resolverFor(session).resolve('r1', 'allow', null, { clientId: 'c1' })
    assert.deepEqual(calls[0][5], { kind: 'user' })

    const refusing = []
    const edited = {
      respondToPermission: (...a) => {
        refusing.push(a)
        if (refusing.length === 1) throw new EditedInputRefusedError('no placeholder writes')
        return true
      },
    }
    const out = resolverFor(edited).resolve('r1', 'allow', null, { clientId: 'c1', editedInput: { x: 1 } })
    assert.equal(out.kind, 'edit_refused')
    assert.deepEqual(refusing[1][5], { kind: 'rule' }, 'the follow-up deny is not the person who edited')
    assert.equal(refusing[1][1], 'deny')
  })
})

describe('the wire value is rebuilt, so nothing identifying can ride', () => {
  it('an emitter that put identifiers on resolvedBy still sends only the class', () => {
    const poisoned = { kind: 'user', clientId: 'client-1', deviceName: "Chris's iPhone", token: 'tok-secret', principalId: 'pr-1' }
    const [frame] = wire({ requestId: 'r', decision: 'allow', reason: 'user', resolvedBy: poisoned })
    assert.deepEqual(frame.resolvedBy, { kind: 'user' })
    assertIdentifiesNobody(frame)
  })

  it('no resolvedBy, or an unusable one, leaves the field off (additive and optional)', () => {
    for (const resolvedBy of [undefined, null, 'user', { kind: 'root' }, []]) {
      const [frame] = wire({ requestId: 'r', decision: 'allow', reason: 'user', ...(resolvedBy === undefined ? {} : { resolvedBy }) })
      assert.equal('resolvedBy' in frame, false, JSON.stringify(resolvedBy))
    }
  })

  it('every kind passes the protocol schema once on the wire', () => {
    for (const kind of RESOLVED_BY_KINDS) {
      const [frame] = wire({ requestId: 'r', decision: 'deny', reason: kind, resolvedBy: kind === 'agent' ? { kind, label: 'supervisor' } : { kind } })
      assert.equal(ServerPermissionResolvedSchema.safeParse(frame).success, true, kind)
    }
  })
})

describe('the legacy (hook-routed) answer, announced for WS and HTTP alike', () => {
  const resolved = { kind: 'resolved', via: 'legacy', sessionId: 'sess-1', mapped: true }

  it('is a user answer, mapped or not, with or without a scope', () => {
    for (const result of [resolved, { ...resolved, mapped: false }, { ...resolved, scope: 'session' }]) {
      const built = buildLegacyResolvedBroadcast(result, 'perm-1', 'allow')
      assert.deepEqual(built.frame.resolvedBy, { kind: 'user' })
      assertIdentifiesNobody(built.frame)
    }
  })

  it('announces nothing for an in-process answer (the manager already did)', () => {
    assert.equal(buildLegacyResolvedBroadcast({ ...resolved, via: 'sdk' }, 'perm-1', 'allow'), null)
  })
})

describe('a hook-routed answer over a real server', () => {
  class WsServer extends _WsServer {
    constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
    start(...args) { super.start(...args); setLogListener(null) }
  }
  const TOKEN = 'primary-tok'
  let server
  const sockets = []
  afterEach(() => {
    for (const ws of sockets.splice(0)) { try { ws.terminate() } catch { /* closed */ } }
    if (server) { server.close(); server = null }
  })

  async function boot() {
    const { manager, sessionsMap } = createMockSessionManager([{ id: 'sess-1', name: 'One', cwd: '/tmp/one' }])
    manager._sessions = sessionsMap
    sessionsMap.get('sess-1').session._hookSecret = 'hook-secret-1'
    // A hook-routed (CLI / TUI) session has no in-process PermissionManager to answer with.
    sessionsMap.get('sess-1').session.respondToPermission = undefined
    server = new WsServer({ port: 0, apiToken: TOKEN, sessionManager: manager, defaultSessionId: 'sess-1', authRequired: true })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    const port = server.httpServer.address().port
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN, deviceInfo: { deviceName: 'Chris iPhone', deviceId: 'dev-77' } }))
    const ok = await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return { port, ws, messages, clientId: ok.clientId }
  }

  // NOT async: the returned fetch resolves only when the prompt is answered, so awaiting it here would deadlock.
  function raise(port, command) {
    const held = fetch(`http://127.0.0.1:${port}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hook-secret-1' },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    })
    return held
  }

  it('a WebSocket answer: every client sees resolvedBy user and no client or device identity', async () => {
    const { port, ws, messages, clientId } = await boot()
    const held = raise(port, 'ls')
    const req = await waitFor(() => messages.find((m) => m.type === 'permission_request'), { label: 'permission_request' })
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'allow' }))
    const resolved = await waitFor(() => messages.find((m) => m.type === 'permission_resolved'), { label: 'permission_resolved' })
    assert.equal((await held.then((r) => r.json())).decision, 'allow')
    assert.deepEqual(resolved.resolvedBy, { kind: 'user' })
    assert.equal(resolved.requestId, req.requestId)
    const text = JSON.stringify(resolved)
    for (const needle of [clientId, 'Chris iPhone', 'dev-77', TOKEN, 'hook-secret-1']) {
      assert.equal(text.includes(needle), false, `${needle} must not appear on the frame`)
    }
  })

  it('the HTTP fallback answer says the same', async () => {
    const { port, messages } = await boot()
    const held = raise(port, 'pwd')
    const req = await waitFor(() => messages.find((m) => m.type === 'permission_request'), { label: 'permission_request' })
    const answered = await fetch(`http://127.0.0.1:${port}/permission-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ requestId: req.requestId, decision: 'deny' }),
    })
    assert.equal(answered.status, 200)
    await held.then((r) => r.json())
    const resolved = await waitFor(() => messages.find((m) => m.type === 'permission_resolved'), { label: 'permission_resolved' })
    assert.deepEqual(resolved.resolvedBy, { kind: 'user' })
    assert.equal(resolved.decision, 'deny')
    assertIdentifiesNobody({ ...resolved, requestId: undefined, sessionId: undefined })
  })
})
