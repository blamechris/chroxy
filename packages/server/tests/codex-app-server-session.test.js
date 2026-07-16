import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'fs'
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

  it('acceptEdits auto-approves a codex file edit (fileChange) without a prompt', async () => {
    const { s, cleanup, responded } = mkApprovalSession('acceptEdits')
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 30, method: 'item/fileChange/requestApproval', params: { grantRoot: '/repo', reason: 'edit' } })
    await tick()
    assert.equal(reqs.length, 0, 'acceptEdits does not prompt for a codex edit')
    assert.deepEqual(responded, [[30, { decision: 'approved' }]])
    cleanup()
  })

  it('acceptEdits still PROMPTS for a codex shell command (not an edit)', async () => {
    const { s, cleanup, responded } = mkApprovalSession('acceptEdits')
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 31, method: 'item/commandExecution/requestApproval', params: { command: 'rm x' } })
    assert.equal(reqs.length, 1, 'acceptEdits prompts for a shell command')
    assert.equal(responded.length, 0, 'no decision until the user answers')
    s.respondToPermission(reqs[0][1].requestId, 'deny')
    await tick()
    assert.deepEqual(responded, [[31, { decision: 'decline' }]])
    cleanup()
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

  describe('permissions-escalation surfacing (#6610)', () => {
    // A real PermissionsRequestApprovalParams (codex asks to broaden its sandbox).
    const escalationParams = {
      cwd: '/repo', itemId: 'i1', threadId: 't1', turnId: 'turn1', startedAtMs: 0,
      reason: 'install deps',
      permissions: {
        fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/repo/node_modules' } }] },
        network: { enabled: true },
      },
    }

    it('surfaces the escalation as a distinctly-worded prompt describing the requested scope', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 11, method: 'item/permissions/requestApproval', params: escalationParams })
      assert.equal(reqs.length, 1, 'escalation is surfaced (no longer safe-denied silently)')
      const req = reqs[0][1]
      assert.match(req.description, /broaden its sandbox permissions/)
      assert.match(req.description, /install deps/)
      assert.match(req.description, /filesystem write/)
      assert.match(req.description, /network access/)
      // structured detail passed through for any client that wants to render it
      assert.deepEqual(req.input.requestedPermissions, escalationParams.permissions)
      s.respondToPermission(req.requestId, 'deny') // resolve so no pending timeout timer leaks past cleanup
      cleanup()
    })

    it('approve → grants EXACTLY the requested permissions for this turn', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 12, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[12, { permissions: escalationParams.permissions, scope: 'turn' }]])
      cleanup()
    })

    it('approve-always → grants the requested permissions for the SESSION', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 13, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'allowAlways')
      await tick()
      assert.deepEqual(responded, [[13, { permissions: escalationParams.permissions, scope: 'session' }]])
      cleanup()
    })

    it('deny → grants NOTHING (empty permissions, scope omitted per #6612)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 14, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      await tick()
      assert.deepEqual(responded, [[14, { permissions: {} }]])
      cleanup()
    })

    it('the grant response conforms to PermissionsRequestApprovalResponse (schema shape)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 15, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      const resp = responded[0][1]
      assert.equal(typeof resp.permissions, 'object', 'permissions is the required GrantedPermissionProfile object')
      assert.ok(['turn', 'session'].includes(resp.scope), 'scope is a valid PermissionGrantScope enum')
      assert.deepEqual(
        Object.keys(resp).filter((k) => !['permissions', 'scope', 'strictAutoReview'].includes(k)),
        [],
        'no fields outside the schema',
      )
      cleanup()
    })

    it('abort mid-escalation → responds { permissions: {} } (answers codex, no turn wedge #6612)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 16, method: 'item/permissions/requestApproval', params: escalationParams })
      assert.equal(reqs.length, 1, 'escalation prompted')
      s._endTurnAbort() // Stop / turn-end aborts the pending escalation
      await tick()
      assert.deepEqual(responded, [[16, { permissions: {} }]], 'abort grants nothing but still answers codex')
      cleanup()
    })

    it('malformed permissions (an array) is coerced to an empty grant, never echoed (no wedge)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      // typeof [] === 'object': a naive echo would put an array on the wire where codex
      // expects a {fileSystem?, network?} object → deserialize failure → wedged turn (#6612).
      s._onServerRequest({ id: 17, method: 'item/permissions/requestApproval', params: { ...escalationParams, permissions: [] } })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[17, { permissions: {}, scope: 'turn' }]], 'array dropped, grants an empty (valid) profile')
      cleanup()
    })

    it('grants ONLY fileSystem/network — an unexpected requested field never reaches the wire', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      const params = { ...escalationParams, permissions: { ...escalationParams.permissions, bogus: 'x' } }
      s._onServerRequest({ id: 18, method: 'item/permissions/requestApproval', params })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(
        responded[0][1],
        { permissions: { fileSystem: escalationParams.permissions.fileSystem, network: escalationParams.permissions.network }, scope: 'turn' },
        'only the two GrantedPermissionProfile fields are granted; a request-only key is dropped',
      )
      cleanup()
    })

    it('describes the legacy read/write filesystem shape (not just entries)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      const params = { ...escalationParams, reason: null, permissions: { fileSystem: { read: ['/etc/hosts'], write: ['/var/log'] } } }
      s._onServerRequest({ id: 19, method: 'item/permissions/requestApproval', params })
      assert.match(reqs[0][1].description, /filesystem read: \/etc\/hosts/)
      assert.match(reqs[0][1].description, /filesystem write: \/var\/log/)
      s.respondToPermission(reqs[0][1].requestId, 'deny') // resolve so no pending timeout timer leaks past cleanup
      cleanup()
    })

    it('caps a huge filesystem scope with a "+N more" tail so the prompt stays bounded and keeps network access', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      const entries = Array.from({ length: 10 }, (_, i) => ({ access: 'write', path: { type: 'path', path: `/p/${i}` } }))
      const params = { ...escalationParams, reason: null, permissions: { fileSystem: { entries }, network: { enabled: true } } }
      s._onServerRequest({ id: 22, method: 'item/permissions/requestApproval', params })
      const desc = reqs[0][1].description
      assert.match(desc, /\+7 more/, 'summarizes the tail instead of listing all 10 entries')
      assert.match(desc, /network access/, 'the trailing network scope survives the cap')
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })
  })

  describe('MCP connector elicitation surfacing (#6635)', () => {
    const elicitParams = { serverName: 'github', threadId: 't1', mode: 'form', message: 'Allow writing a comment to issue #42?', requestedSchema: {} }

    it('surfaces the elicitation as a prompt naming the connector + message (was -32601 declined)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 30, method: 'mcpServer/elicitation/request', params: elicitParams })
      assert.equal(reqs.length, 1, 'connector elicitation is surfaced, not silently declined')
      assert.equal(reqs[0][1].tool, 'mcp_elicitation')
      assert.match(reqs[0][1].description, /github/)
      assert.match(reqs[0][1].description, /issue #42/)
      s.respondToPermission(reqs[0][1].requestId, 'deny')
    })

    it('accept → { action: accept }', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 31, method: 'mcpServer/elicitation/request', params: elicitParams })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[31, { action: 'accept' }]])
      cleanup()
    })

    it('deny → { action: decline } (a missed connector approval is now an explicit decline)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 32, method: 'mcpServer/elicitation/request', params: elicitParams })
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      await tick()
      assert.deepEqual(responded, [[32, { action: 'decline' }]])
      cleanup()
    })

    it('abort mid-elicitation → { action: decline } (answers codex, no wedge)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 33, method: 'mcpServer/elicitation/request', params: elicitParams })
      assert.equal(reqs.length, 1)
      s._endTurnAbort()
      await tick()
      assert.deepEqual(responded, [[33, { action: 'decline' }]])
      cleanup()
    })

    it('url-mode surfaces the link in the prompt', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 34, method: 'mcpServer/elicitation/request', params: { serverName: 'github', threadId: 't1', mode: 'url', elicitationId: 'e1', message: 'Authorize access', url: 'https://example.com/oauth' } })
      assert.match(reqs[0][1].description, /https:\/\/example\.com\/oauth/)
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })

    it('a REQUIRED-field form is declined even on allow (no incomplete accept until #6684)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      // form-mode with a required property → we can't collect content yet, so an
      // action-only accept could write empty/default params → decline instead.
      s._onServerRequest({ id: 35, method: 'mcpServer/elicitation/request', params: { serverName: 'github', threadId: 't1', mode: 'form', message: 'Fill the release notes', requestedSchema: { required: ['notes'] } } })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[35, { action: 'decline' }]], 'required-field form → decline even on allow')
      cleanup()
    })

    it('openai/form is declined even on allow (freeform content not yet collectable)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 36, method: 'mcpServer/elicitation/request', params: { serverName: 'x', threadId: 't1', mode: 'openai/form', message: 'give feedback', requestedSchema: true } })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[36, { action: 'decline' }]])
      cleanup()
    })

    it('auto mode auto-accepts a connector elicitation (bypass) without prompting', async () => {
      const { s, cleanup, responded } = mkApprovalSession('auto')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 37, method: 'mcpServer/elicitation/request', params: elicitParams })
      await tick()
      assert.equal(reqs.length, 0, 'auto mode does not prompt')
      assert.deepEqual(responded, [[37, { action: 'accept' }]])
      cleanup()
    })

    it('a missing serverName falls back to a generic connector label', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 38, method: 'mcpServer/elicitation/request', params: { threadId: 't1', mode: 'form', message: 'proceed?', requestedSchema: {} } })
      assert.match(reqs[0][1].description, /an MCP connector/)
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })
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

describe('CodexAppServerSession — attachments (#6609)', () => {
  const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')

  it('text-only input when there are no attachments', () => {
    const { s, cleanup } = mkSession()
    assert.deepEqual(s._buildTurnInput('hi', undefined, 'm1'), [{ type: 'text', text: 'hi' }])
    cleanup()
  })

  it('a binary image becomes a localImage item (codex vision), prompt text unchanged', async () => {
    const { s, cleanup } = mkSession()
    const input = s._buildTurnInput('look at this', [{ type: 'image', mediaType: 'image/png', data: PNG_B64, name: 'shot.png' }], 'm2')
    assert.equal(input[0].type, 'text')
    assert.equal(input[0].text, 'look at this', 'prompt text is not suffixed for an image')
    const img = input.find((i) => i.type === 'localImage')
    assert.ok(img && img.path.endsWith('.png'), 'a localImage item points at the materialized file')
    assert.ok(existsSync(img.path), 'the image bytes were written to disk')
    await s.destroy()
    cleanup()
  })

  it('a document is named in a text suffix, not a localImage', async () => {
    const { s, cleanup } = mkSession()
    const input = s._buildTurnInput('read this', [{ type: 'document', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64'), name: 'notes.txt' }], 'm3')
    assert.equal(input.filter((i) => i.type === 'localImage').length, 0, 'documents are not localImage items')
    assert.match(input[0].text, /notes\.txt|att-1/, 'document referenced in the text suffix')
    await s.destroy()
    cleanup()
  })

  it('a relative file_ref image path is used directly (no copy) as a localImage', () => {
    const { s, cleanup } = mkSession()
    const input = s._buildTurnInput('see', [{ type: 'file_ref', path: 'pics/shot.jpg', name: 'shot.jpg' }], 'm4')
    const img = input.find((i) => i.type === 'localImage')
    assert.equal(img?.path, 'pics/shot.jpg', 'relative file_ref path passed straight through, no temp copy')
    assert.equal(s._attachDir, null, 'no temp dir created when there are no binary attachments')
    cleanup()
  })

  it('destroy() removes the materialized-attachment temp dir', async () => {
    const { s, cleanup } = mkSession()
    s._buildTurnInput('x', [{ type: 'image', mediaType: 'image/png', data: PNG_B64, name: 'a.png' }], 'm5')
    const dir = s._attachDir
    assert.ok(dir && existsSync(dir), 'temp dir created for a binary attachment')
    await s.destroy()
    assert.ok(!existsSync(dir), 'temp dir removed on destroy')
    cleanup()
  })

  it('skips an absolute / parent-traversing file_ref path (defence-in-depth, #6614)', () => {
    const { s, cleanup } = mkSession()
    for (const bad of ['/etc/passwd.jpg', '../secrets/key.png']) {
      const input = s._buildTurnInput('see', [{ type: 'file_ref', path: bad, name: 'x.png' }], 'm6')
      assert.equal(input.filter((i) => i.type === 'localImage').length, 0, `unconfined file_ref not turned into a localImage: ${bad}`)
      assert.deepEqual(input, [{ type: 'text', text: 'see' }])
    }
    cleanup()
  })

  it('does not silently drop an unattachable attachment (no data, not a file_ref)', () => {
    const { s, cleanup } = mkSession()
    // No throw, prompt still sent; the malformed entry is omitted (and warn-logged).
    const input = s._buildTurnInput('hi', [{ type: 'image', mediaType: 'image/png', name: 'nodata.png' }], 'm7')
    assert.deepEqual(input, [{ type: 'text', text: 'hi' }], 'malformed attachment omitted, prompt preserved')
    cleanup()
  })
})
