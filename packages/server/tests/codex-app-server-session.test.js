import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { CodexAppServerClient } from '../src/codex-app-server-client.js'

// #6605 Phase 1 — the codex app-server DRIVING layer. These pin the JSON-RPC
// transport routing and the app-server-notification → Chroxy-event mapping
// WITHOUT spawning a real `codex app-server` (the live end-to-end round-trip is
// validated separately).

function mkSession() {
  const sk = mkdtempSync(join(tmpdir(), 'chroxy-cas-'))
  const s = new CodexAppServerSession({ cwd: '/tmp', skillsDir: sk, repoSkillsDir: null })
  return { s, cleanup: () => rmSync(sk, { recursive: true, force: true }) }
}
function capture(s, events) {
  const out = []
  events.forEach((e) => s.on(e, (p) => out.push([e, p])))
  return out
}

describe('CodexAppServerClient (JSON-RPC transport)', () => {
  it('resolves a pending request when its response arrives', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } } // stub the writer, no real child
    const p = c.request('initialize', {})
    c._dispatch({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    assert.deepEqual(await p, { ok: true })
  })

  it('rejects a pending request on an error response', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } }
    const p = c.request('x', {})
    c._dispatch({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } })
    await assert.rejects(p, /boom/)
  })

  it('emits serverRequest for a server→client request (approval)', () => {
    const c = new CodexAppServerClient({})
    let got = null
    c.on('serverRequest', (r) => (got = r))
    c._dispatch({ jsonrpc: '2.0', id: 7, method: 'item/commandExecution/requestApproval', params: { reason: 'x' } })
    assert.equal(got.id, 7)
    assert.match(got.method, /requestApproval/)
  })

  it('emits notification for a server notification (no id)', () => {
    const c = new CodexAppServerClient({})
    let got = null
    c.on('notification', (n) => (got = n))
    c._dispatch({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: 't' } } })
    assert.equal(got.method, 'turn/started')
  })

  it('buffers newline-delimited JSON split across stdout chunks', () => {
    const c = new CodexAppServerClient({})
    const notes = []
    c.on('notification', (n) => notes.push(n.method))
    c._onData('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","meth')
    c._onData('od":"b"}\n')
    assert.deepEqual(notes, ['a', 'b'])
  })

  it('parses CRLF-framed lines (a trailing \\r does not break JSON.parse) (#6606)', () => {
    const c = new CodexAppServerClient({})
    const notes = []
    c.on('notification', (n) => notes.push(n.method))
    c._onData('{"jsonrpc":"2.0","method":"crlf"}\r\n')
    assert.deepEqual(notes, ['crlf'])
  })

  it('rejects all in-flight requests on kill()', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } }
    const p = c.request('x', {})
    c.kill()
    await assert.rejects(p, /killed/)
  })
})

describe('CodexAppServerSession — app-server → Chroxy event mapping', () => {
  it('maps agentMessage deltas to a single stream_start + stream_delta stream', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } })
    s._onNotification({ method: 'item/agentMessage/delta', params: { delta: '!' } })
    assert.deepEqual(ev.map(([e]) => e), ['stream_start', 'stream_delta', 'stream_delta'])
    assert.equal(ev[1][1].delta, 'Hi')
    assert.equal(ev[1][1].messageId, 'm1')
    cleanup()
  })

  it('maps a commandExecution item to tool_start / tool_result', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_start', 'tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'echo hi', cwd: '/tmp' } } })
    s._onNotification({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', aggregatedOutput: 'hi\n' } } })
    assert.equal(ev[0][0], 'tool_start')
    assert.equal(ev[0][1].tool, 'shell')
    assert.equal(ev[0][1].input.command, 'echo hi')
    assert.equal(ev[1][0], 'tool_result')
    assert.equal(ev[1][1].result, 'hi\n')
    assert.equal(ev[1][1].toolUseId, 'c1')
    cleanup()
  })

  it('turn/completed emits stream_end + result and clears busy', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_end', 'result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 42 } } })
    assert.deepEqual(ev.map(([e]) => e), ['stream_end', 'result'])
    assert.equal(ev[1][1].duration, 42)
    assert.equal(s._isBusy, false, 'busy cleared after turn')
    assert.equal(s._activeTurn, null, 'active turn cleared')
    cleanup()
  })

  it('a short agentMessage with no prior deltas still emits its text (fallback)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'short' } } })
    assert.deepEqual(ev.map(([e, p]) => [e, p.delta]), [['stream_start', undefined], ['stream_delta', 'short']])
    cleanup()
  })

  it('ignores the userMessage echo item (no spurious events)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta', 'tool_start', 'tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/started', params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] } } })
    s._onNotification({ method: 'item/completed', params: { item: { type: 'userMessage', id: 'u1' } } })
    assert.equal(ev.length, 0, 'the input echo produces no Chroxy events')
    cleanup()
  })
})

describe('CodexAppServerSession — lifecycle guards', () => {
  it('sendMessage while busy enqueues instead of starting a turn', async () => {
    const { s, cleanup } = mkSession()
    let queued = null
    s.on('message_queued', (p) => (queued = p))
    s._isBusy = true
    await s.sendMessage('hello')
    assert.ok(queued, 'busy send was queued')
    cleanup()
  })

  it('sendMessage before start() emits a not-started error', async () => {
    const { s, cleanup } = mkSession()
    let err = null
    s.on('error', (e) => (err = e))
    await s.sendMessage('hello')
    assert.match(err.message, /not started/)
    cleanup()
  })

  it('prepends the skills prefix on the FIRST turn only, and the current model (#6606)', async () => {
    const { s, cleanup } = mkSession()
    s._processReady = true
    s._threadId = 't'
    s.model = 'gpt-5-codex'
    const captured = []
    s._client = { request: async (_m, p) => { captured.push(p); return { turn: { id: 'tt' } } } }
    s._buildCombinedSkillsPrefix = () => 'SKILLZ'
    await s.sendMessage('hello')
    s._isBusy = false // simulate turn completion so the next send isn't queued
    s._activeTurn = null
    await s.sendMessage('again')
    assert.match(captured[0].input[0].text, /SKILLZ[\s\S]*hello/, 'first turn carries the skills prefix')
    assert.equal(captured[0].model, 'gpt-5-codex', 'turn/start carries the current model')
    assert.equal(captured[1].input[0].text, 'again', 'second turn has no skills prefix')
    cleanup()
  })

  it('capabilities: streaming + modelSwitch on, approvals surfaced (Phase 2)', () => {
    const c = CodexAppServerSession.capabilities
    assert.equal(c.permissions, true)
    assert.equal(c.inProcessPermissions, true)
    assert.equal(c.streaming, true)
    assert.equal(c.modelSwitch, true)
  })

  it('delegates codex provider identity to CodexSession statics', () => {
    assert.equal(CodexAppServerSession.providerName, 'codex')
    assert.equal(CodexAppServerSession.apiKeyEnv, 'OPENAI_API_KEY')
    assert.ok(CodexAppServerSession.resolvedBinary, 'resolvedBinary delegates')
    assert.ok(Array.isArray(CodexAppServerSession.getAllowedModels()))
  })
})

describe('CodexAppServerSession — crash / stop paths (#6607)', () => {
  it('a NORMAL completion disarms intentional-stop so a LATER failure reports as error (#6606 C1)', () => {
    const { s, cleanup } = mkSession()
    // interrupt() armed the intentional-stop flag, but the turn then finished cleanly.
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s.markIntentionalStop()
    s._onNotification({ method: 'turn/completed', params: { turn: {} } })
    // A subsequent GENUINE failure must surface as `error`, not a stale `stopped`.
    const ev = capture(s, ['error', 'stopped'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm2', turnId: 't2', didStreamStart: false }
    s._failTurn('genuine failure')
    assert.deepEqual(ev.map(([e]) => e), ['error'], 'later failure is error, not a stale stopped')
    cleanup()
  })

  it('client exit during a turn fails the turn and clears busy', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onClientExit({ code: 1, signal: null })
    assert.equal(ev[0][0], 'error')
    assert.match(ev[0][1].message, /exited/)
    assert.equal(s._isBusy, false, 'busy cleared after client exit mid-turn')
    assert.equal(s._processReady, false, 'session marked not-ready')
    cleanup()
  })

  it('an error notification during a turn fails the turn', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onNotification({ method: 'error', params: { message: 'boom' } })
    assert.equal(ev[0][0], 'error')
    assert.equal(s._isBusy, false, 'busy cleared on error')
    cleanup()
  })

  it('an intentional interrupt that then fails reports stopped (not error)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error', 'stopped'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s.markIntentionalStop()
    s._failTurn('interrupted')
    assert.deepEqual(ev.map(([e]) => e), ['stopped'], 'intentional stop surfaces as stopped')
    cleanup()
  })

  it('orphan tool_start is swept with a synthetic tool_result at turn end', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    // a tool starts but never completes before the turn ends
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'orphan', command: 'sleep 999', cwd: '/tmp' } } })
    s._onNotification({ method: 'turn/completed', params: { turn: {} } })
    assert.ok(ev.some(([, p]) => p.toolUseId === 'orphan'), 'orphan tool_start got a synthetic tool_result')
    cleanup()
  })
})

describe('CodexAppServerSession — approval surfacing (#6605 Phase 2)', () => {
  const tick = () => new Promise((r) => setImmediate(r))
  function mkApprovalSession(mode = 'approve') {
    const { s, cleanup } = mkSession()
    const responded = []
    s._processReady = true
    s.permissionMode = mode
    s._turnAbort = new AbortController()
    s._client = {
      respond: (id, r) => responded.push([id, r]),
      respondError: (id, code, message) => responded.push([id, { error: { code, message } }]),
    }
    return { s, cleanup, responded }
  }

  it('capabilities advertise permissions + inProcessPermissions + permissionModeSwitch', () => {
    const c = CodexAppServerSession.capabilities
    assert.equal(c.permissions, true)
    assert.equal(c.inProcessPermissions, true)
    assert.equal(c.permissionModeSwitch, true)
  })

  it('exposes the in-process permission responders', () => {
    const { s, cleanup } = mkSession()
    assert.equal(typeof s.respondToPermission, 'function')
    assert.equal(typeof s.respondToQuestion, 'function')
    cleanup()
  })

  it('approvalPolicy: auto → never, every other mode → on-request', () => {
    const { s, cleanup } = mkSession()
    s.permissionMode = 'auto'; assert.equal(s._approvalPolicy(), 'never')
    s.permissionMode = 'approve'; assert.equal(s._approvalPolicy(), 'on-request')
    s.permissionMode = 'acceptEdits'; assert.equal(s._approvalPolicy(), 'on-request')
    cleanup()
  })

  it('commandExecution approval → permission_request; allow → {decision:accept}', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 5, method: 'item/commandExecution/requestApproval', params: { command: 'rm x', cwd: '/tmp', reason: 'Delete x?' } })
    assert.equal(reqs.length, 1, 'emitted a permission_request')
    assert.equal(reqs[0][1].tool, 'shell')
    s.respondToPermission(reqs[0][1].requestId, 'allow')
    await tick()
    assert.deepEqual(responded, [[5, { decision: 'accept' }]])
    cleanup()
  })

  it('commandExecution deny → {decision:decline}', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 6, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /', reason: 'nope' } })
    s.respondToPermission(reqs[0][1].requestId, 'deny')
    await tick()
    assert.deepEqual(responded, [[6, { decision: 'decline' }]])
    cleanup()
  })

  it('commandExecution allowAlways → {decision:acceptForSession}', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'ls', reason: 'list' } })
    s.respondToPermission(reqs[0][1].requestId, 'allowAlways')
    await tick()
    assert.deepEqual(responded, [[7, { decision: 'acceptForSession' }]])
    cleanup()
  })

  it('fileChange approval uses ReviewDecision (allow→approved, deny→denied, session→approved_for_session)', async () => {
    for (const [decision, expected] of [['allow', 'approved'], ['deny', 'denied'], ['allowAlways', 'approved_for_session']]) {
      const { s, cleanup, responded } = mkApprovalSession()
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 9, method: 'item/fileChange/requestApproval', params: { grantRoot: '/repo', reason: 'edit files' } })
      assert.equal(reqs[0][1].tool, 'apply_patch')
      s.respondToPermission(reqs[0][1].requestId, decision)
      await tick()
      assert.deepEqual(responded, [[9, { decision: expected }]], `fileChange ${decision} → ${expected}`)
      cleanup()
    }
  })

  it('auto mode auto-allows without emitting a prompt (accept)', async () => {
    const { s, cleanup, responded } = mkApprovalSession('auto')
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 10, method: 'item/commandExecution/requestApproval', params: { command: 'echo hi' } })
    await tick()
    assert.equal(reqs.length, 0, 'auto mode does not prompt')
    assert.deepEqual(responded, [[10, { decision: 'accept' }]])
    cleanup()
  })

  it('permissions-escalation request is safe-denied (grant nothing, no scope) without a prompt', () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 11, method: 'item/permissions/requestApproval', params: { scope: 'disk-full-access' } })
    assert.equal(reqs.length, 0, 'escalation is not surfaced as a normal prompt in Phase 2')
    // grant nothing: empty permissions, scope OMITTED (an explicit 'none' is an
    // invalid PermissionGrantScope enum value and would wedge the turn — #6612).
    assert.deepEqual(responded, [[11, { permissions: {} }]])
    cleanup()
  })

  it('interrupt() aborts a pending approval → Stop unblocks the turn (decline)', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    capture(s, ['permission_request'])
    s._onServerRequest({ id: 20, method: 'item/commandExecution/requestApproval', params: { command: 'x' } })
    await s.interrupt()
    await tick()
    assert.deepEqual(responded, [[20, { decision: 'decline' }]], 'Stop declined the pending approval')
    cleanup()
  })

  it('switching to auto drains a pending approval (autoAllowPending → accept)', async () => {
    const { s, cleanup, responded } = mkApprovalSession('approve')
    capture(s, ['permission_request'])
    s._onServerRequest({ id: 21, method: 'item/commandExecution/requestApproval', params: { command: 'x' } })
    s.setPermissionMode('auto') // panic button — must drain the pending prompt
    await tick()
    assert.deepEqual(responded, [[21, { decision: 'accept' }]], 'auto drained the pending prompt as accept')
    cleanup()
  })

  it('destroy() clears a pending approval without hanging (no leak)', async () => {
    const { s, cleanup } = mkApprovalSession()
    capture(s, ['permission_request'])
    s._onServerRequest({ id: 14, method: 'item/commandExecution/requestApproval', params: { command: 'x' } })
    assert.equal(s._permissions._pendingPermissions.size, 1, 'one pending approval before destroy')
    await s.destroy()
    assert.equal(s._permissions._pendingPermissions.size, 0, 'destroy cleared the pending approval (no hang/leak)')
    cleanup()
  })

  it('an unsupported serverRequest is declined with a JSON-RPC error', () => {
    const { s, cleanup, responded } = mkApprovalSession()
    s._onServerRequest({ id: 12, method: 'some/futureRequest', params: {} })
    assert.equal(responded[0][0], 12)
    assert.ok(responded[0][1].error, 'answered with an error')
    cleanup()
  })

  it('an aborted turn scope resolves a pending approval as deny (decline)', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 13, method: 'item/commandExecution/requestApproval', params: { command: 'sleep 999' } })
    assert.equal(reqs.length, 1)
    s._endTurnAbort() // interrupt()/turn-end aborts the scope
    await tick()
    assert.deepEqual(responded, [[13, { decision: 'decline' }]], 'abort → decline')
    cleanup()
  })
})
