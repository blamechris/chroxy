import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SdkSession } from '../src/sdk-session.js'
import { resetModels } from '../src/models.js'

/**
 * Tests for SdkSession — permission handling, question handling,
 * agent tracking, model/permission mode changes, and cleanup.
 *
 * These tests instantiate SdkSession without calling start() or
 * sendMessage() and exercise internal methods directly.
 */

function createSession(opts = {}) {
  return new SdkSession({ cwd: '/tmp', ...opts })
}

describe('SdkSession', () => {
  let session

  beforeEach(() => {
    session = createSession()
  })

  afterEach(() => {
    session.destroy()
  })

  // -- Constructor --

  describe('constructor', () => {
    it('sets default values', () => {
      assert.equal(session.cwd, '/tmp')
      assert.equal(session.model, null)
      assert.equal(session.permissionMode, 'approve')
      assert.equal(session._isBusy, false)
      assert.equal(session._processReady, false)
    })

    it('accepts model and permissionMode options', () => {
      const s = createSession({ model: 'opus', permissionMode: 'auto' })
      assert.equal(s.model, 'opus')
      assert.equal(s.permissionMode, 'auto')
      s.destroy()
    })

    it('does not accept allowedTools', () => {
      assert.equal(session.allowedTools, undefined)
    })

    it('stores sandbox option when provided', () => {
      const sandbox = {
        network: { allowedDomains: ['example.com'] },
        filesystem: { allowedPaths: ['/tmp'] },
      }
      const s = createSession({ sandbox })
      assert.deepEqual(s._sandbox, sandbox)
      s.destroy()
    })

    it('defaults sandbox to null when not provided', () => {
      assert.equal(session._sandbox, null)
    })

    // #3540: the SidecarProcess `stdin_disabled` latch is persisted to
    // session metadata so a server restart preserves the disabled
    // state. Restored sessions are constructed with the persisted value
    // forwarded as the `stdinForwardingDisabled` opt; the constructor
    // initialises `_stdinForwardingDisabled` from it so listSessions
    // and the existing _attachSidecarProcessListeners short-circuit
    // both observe the latched flag immediately.
    it('defaults _stdinForwardingDisabled to false when not provided (#3540)', () => {
      assert.equal(session._stdinForwardingDisabled, false,
        'fresh sessions must start with the latch off so the warn/error fires on the first SidecarProcess signal')
    })

    it('hydrates _stdinForwardingDisabled from the constructor opt (#3540)', () => {
      const s = createSession({ stdinForwardingDisabled: true })
      assert.equal(s._stdinForwardingDisabled, true,
        'restored sessions must start with the latch on so reconnecting clients see the disabled state in listSessions')
      s.destroy()
    })

    it('coerces non-boolean stdinForwardingDisabled values to a strict boolean (#3540)', () => {
      // Defensive coerce: a stray `null` / numeric / undefined from a
      // mangled state file must not produce `_stdinForwardingDisabled`
      // values that fail strict-equality checks downstream (the
      // `if (this._stdinForwardingDisabled) return` short-circuit in
      // _attachSidecarProcessListeners depends on truthy semantics, but
      // listSessions / serializeState round-trip through `!!`).
      const sNull = createSession({ stdinForwardingDisabled: null })
      assert.equal(sNull._stdinForwardingDisabled, false)
      sNull.destroy()
      const sUndef = createSession({ stdinForwardingDisabled: undefined })
      assert.equal(sUndef._stdinForwardingDisabled, false)
      sUndef.destroy()
    })

    // #3209/#3246: SDK is the only provider that rebuilds the system
    // prompt each turn (see _callQuery), so manual-skill toggles
    // propagate to the wire. Subprocess providers inherit
    // BaseSession's `false` default.
    it('supportsRuntimeSkillToggle returns true (override of BaseSession default)', () => {
      assert.equal(session.supportsRuntimeSkillToggle(), true)
    })

    it('exposes skillToggle: true via static capabilities', () => {
      assert.equal(SdkSession.capabilities.skillToggle, true)
    })
  })

  // -- start() --

  describe('start', () => {
    it('emits ready and sets processReady', () => {
      const events = []
      session.on('ready', (data) => events.push(data))
      session.start()
      assert.equal(session._processReady, true)
      assert.equal(events.length, 1)
      assert.equal(events[0].model, null)
    })
  })

  // -- Permission handling --

  describe('_handlePermission', () => {
    it('emits permission_request and resolves on respondToPermission (allow)', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Bash', { command: 'ls' }, null)

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      assert.ok(events[0].requestId)

      session.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { command: 'ls' })
    })

    it('resolves with deny on respondToPermission (deny)', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Write', { file_path: '/x' }, null)
      session.respondToPermission(events[0].requestId, 'deny')

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('resolves allowAlways as SDK-compliant behavior:allow (2026-04-11 audit Skeptic finding)', async () => {
      // Pre-audit bug: respondToPermission('allowAlways') resolved with
      // { behavior: 'allowAlways' }, which is NOT a valid SDK
      // PermissionResult.behavior — the Agent SDK only accepts
      // 'allow'|'deny'. Post-fix: behavior must be 'allow' and any
      // suggestions provided by canUseTool get echoed via updatedPermissions.
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Bash', { command: 'npm test' }, null)
      const requestId = events[0].requestId
      assert.ok(session._permissions._permissionTimers.has(requestId))

      session.respondToPermission(requestId, 'allowAlways')

      const result = await promise
      assert.equal(result.behavior, 'allow',
        "behavior must be the SDK-valid 'allow', not 'allowAlways'")
      assert.deepEqual(result.updatedInput, { command: 'npm test' })
      assert.ok(!session._pendingPermissions.has(requestId))
      assert.ok(!session._permissions._permissionTimers.has(requestId))
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = session._handlePermission('Bash', {}, controller.signal)
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.ok(result.message.includes('cancelled') || result.message.includes('Cancelled'))
    })

    it('clears permission timer on response', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      session._handlePermission('Read', {}, null)
      const requestId = events[0].requestId
      assert.ok(session._permissions._permissionTimers.has(requestId))

      session.respondToPermission(requestId, 'allow')
      assert.ok(!session._permissions._permissionTimers.has(requestId))
    })

    it('warns on unknown requestId', () => {
      // Should not throw
      session.respondToPermission('nonexistent', 'allow')
    })

    // #3048: SdkSession re-emits permission_resolved upward so SessionManager
    // can fan it out via the unified broadcast pipeline. Only requestId-bearing
    // emits are forwarded — AskUserQuestion paths use toolUseId and a separate
    // wire contract (user_question / user_question_response).
    it('re-emits permission_resolved upward when payload carries a requestId (#3048)', async () => {
      const upstream = []
      session.on('permission_resolved', (data) => upstream.push(data))

      const promise = session._handlePermission('Bash', { command: 'ls' }, null)
      const requestId = Array.from(session._pendingPermissions.keys())[0]
      session.respondToPermission(requestId, 'allow')
      await promise

      assert.equal(upstream.length, 1)
      assert.deepStrictEqual(upstream[0], { requestId, decision: 'allow', reason: 'user' })
    })

    it('re-emits permission_resolved on timeout (#3048)', async () => {
      const fastSession = new SdkSession({ cwd: '/tmp' })
      // Override the manager with a fast timeout so the test runs quickly
      fastSession._permissions._timeoutMs = 5
      const upstream = []
      fastSession.on('permission_resolved', (data) => upstream.push(data))

      const promise = fastSession._handlePermission('Bash', { command: 'ls' }, null)
      const requestId = Array.from(fastSession._pendingPermissions.keys())[0]
      const result = await promise

      assert.equal(result.behavior, 'deny')
      assert.equal(upstream.length, 1)
      assert.deepStrictEqual(upstream[0], { requestId, decision: 'deny', reason: 'timeout' })
      fastSession.destroy()
    })

    it('re-emits permission_resolved on abort (#3048)', async () => {
      const upstream = []
      session.on('permission_resolved', (data) => upstream.push(data))

      const controller = new AbortController()
      const promise = session._handlePermission('Bash', { command: 'ls' }, controller.signal)
      const requestId = Array.from(session._pendingPermissions.keys())[0]
      controller.abort()
      const result = await promise

      assert.equal(result.behavior, 'deny')
      assert.equal(upstream.length, 1)
      assert.deepStrictEqual(upstream[0], { requestId, decision: 'deny', reason: 'aborted' })
    })

    it('does NOT re-emit AskUserQuestion permission_resolved (no requestId — separate wire contract, #3048)', async () => {
      const upstream = []
      session.on('permission_resolved', (data) => upstream.push(data))

      // AskUserQuestion routes through _handlePermission but resolves via
      // the question path (toolUseId, no requestId). The PermissionManager
      // emits { reason: 'answered' } with no requestId — SdkSession must
      // NOT re-emit it onto the unified pipeline.
      const promise = session._handlePermission('AskUserQuestion', { questions: [{ question: 'ok?' }] }, null)
      session.respondToQuestion('yes')
      await promise

      assert.equal(upstream.length, 0,
        'question paths use toolUseId and route via user_question, not permission_resolved')
    })
  })

  // -- acceptEdits permission mode --

  describe('acceptEdits permission mode', () => {
    it('auto-approves file operation tools', async () => {
      session.permissionMode = 'acceptEdits'
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const result = await session._handlePermission('Read', { file_path: '/tmp/x' }, null)
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 0, 'Should NOT emit permission_request for file ops')
    })

    it('auto-approves all ACCEPT_EDITS_TOOLS', async () => {
      session.permissionMode = 'acceptEdits'
      const tools = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']

      for (const tool of tools) {
        const result = await session._handlePermission(tool, {}, null)
        assert.equal(result.behavior, 'allow', `${tool} should be auto-approved`)
      }
    })

    it('still prompts for Bash tool', async () => {
      session.permissionMode = 'acceptEdits'
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Bash', { command: 'rm -rf /' }, null)

      assert.equal(events.length, 1, 'Should emit permission_request for Bash')
      assert.equal(events[0].tool, 'Bash')

      session.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })

    it('still prompts for WebFetch tool', async () => {
      session.permissionMode = 'acceptEdits'
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('WebFetch', { url: 'https://example.com' }, null)
      assert.equal(events.length, 1, 'Should emit permission_request for WebFetch')

      session.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    })
  })

  // -- AskUserQuestion handling --

  describe('_handleAskUserQuestion', () => {
    it('emits user_question and resolves on respondToQuestion', async () => {
      const events = []
      session.on('user_question', (data) => events.push(data))

      const questions = [{ question: 'Pick one?', options: [{ label: 'A' }] }]
      const promise = session._permissions._handleAskUserQuestion({ questions }, null)

      assert.equal(events.length, 1)
      assert.deepEqual(events[0].questions, questions)
      assert.equal(session._permissions._waitingForAnswer, true)

      session.respondToQuestion('A')
      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput.answers, { 'Pick one?': 'A' })
      assert.equal(session._permissions._waitingForAnswer, false)
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = session._permissions._handleAskUserQuestion({ questions: [] }, controller.signal)
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(session._permissions._waitingForAnswer, false)
    })

    it('clears question timer on respondToQuestion', async () => {
      session._permissions._handleAskUserQuestion({ questions: [] }, null)
      assert.ok(session._permissions._questionTimer !== null)

      session.respondToQuestion('answer')
      assert.equal(session._permissions._questionTimer, null)
    })

    it('no-ops respondToQuestion when no pending answer', () => {
      // Should not throw
      session.respondToQuestion('stale answer')
    })
  })

  // -- _handlePermission routing --

  describe('_handlePermission routing', () => {
    it('routes AskUserQuestion to _handleAskUserQuestion', async () => {
      const events = []
      session.on('user_question', (data) => events.push(data))

      const promise = session._handlePermission('AskUserQuestion', { questions: [] }, null)
      session.respondToQuestion('ok')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 1)
    })
  })

  // -- Agent tracking --

  describe('_handleToolUseBlock', () => {
    it('tracks Task tool as agent', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      session._handleToolUseBlock('msg-1', {
        name: 'Task',
        id: 'tool-1',
        input: { description: 'Explore codebase' },
      })

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'tool-1')
      assert.equal(events[0].description, 'Explore codebase')
      assert.ok(session._activeAgents.has('tool-1'))
    })

    it('truncates long descriptions to 200 chars', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      session._handleToolUseBlock('msg-1', {
        name: 'Task',
        id: 'tool-2',
        input: { description: 'x'.repeat(300) },
      })

      assert.equal(events[0].description.length, 200)
    })

    it('ignores non-Task tools', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      session._handleToolUseBlock('msg-1', { name: 'Bash', id: 'tool-3', input: {} })
      assert.equal(events.length, 0)
      assert.equal(session._activeAgents.size, 0)
    })

    it('emits error for oversized tool input', () => {
      const errors = []
      session.on('error', (data) => errors.push(data))

      const bigInput = { data: 'x'.repeat(session._maxToolInput) }
      session._handleToolUseBlock('msg-1', { name: 'Write', id: 'tool-big', input: bigInput })

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.includes('Tool input too large'))
      assert.ok(errors[0].message.includes('Write'))
    })

    it('skips agent tracking when input exceeds cap', () => {
      const spawned = []
      const errors = []
      session.on('agent_spawned', (data) => spawned.push(data))
      session.on('error', (data) => errors.push(data))

      const bigInput = { description: 'x'.repeat(session._maxToolInput) }
      session._handleToolUseBlock('msg-1', { name: 'Task', id: 'tool-task', input: bigInput })

      assert.equal(spawned.length, 0)
      assert.equal(errors.length, 1)
    })

    it('accepts maxToolInput constructor option', () => {
      const s = createSession({ maxToolInput: 1024 })
      assert.equal(s._maxToolInput, 1024)

      const errors = []
      s.on('error', (data) => errors.push(data))
      s._handleToolUseBlock('msg-1', { name: 'Bash', id: 'tool-4', input: { cmd: 'x'.repeat(2000) } })
      assert.equal(errors.length, 1)
      s.destroy()
    })
  })

  // -- _clearMessageState --

  describe('_clearMessageState', () => {
    it('emits agent_completed for all active agents', () => {
      const events = []
      session.on('agent_completed', (data) => events.push(data))

      session._activeAgents.set('a1', { toolUseId: 'a1', description: 'test', startedAt: 1 })
      session._activeAgents.set('a2', { toolUseId: 'a2', description: 'test', startedAt: 2 })
      session._isBusy = true

      session._clearMessageState()

      assert.equal(events.length, 2)
      assert.equal(session._activeAgents.size, 0)
      assert.equal(session._isBusy, false)
    })

    it('auto-denies pending permissions', async () => {
      const promise = session._handlePermission('Bash', {}, null)
      session._clearMessageState()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(session._pendingPermissions.size, 0)
    })

    it('auto-denies pending user answer', async () => {
      const promise = session._permissions._handleAskUserQuestion({ questions: [] }, null)
      session._clearMessageState()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(session._permissions._pendingUserAnswer, null)
    })

    it('clears result timeout', () => {
      session._resultTimeout = setTimeout(() => {}, 999999)
      session._clearMessageState()
      assert.equal(session._resultTimeout, null)
    })

    it('clears question timer', () => {
      session._permissions._questionTimer = setTimeout(() => {}, 999999)
      session._clearMessageState()
      assert.equal(session._permissions._questionTimer, null)
    })
  })

  // -- Model / Permission Mode --

  describe('setModel', () => {
    it('changes model when not busy', () => {
      session.setModel('sonnet')
      assert.ok(session.model) // resolveModelId may transform the name
    })

    it('ignores model change when busy', () => {
      session._isBusy = true
      const original = session.model
      session.setModel('opus')
      assert.equal(session.model, original)
    })
  })

  describe('setPermissionMode', () => {
    it('changes permission mode when not busy', () => {
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'auto')
    })

    it('ignores change when busy', () => {
      session._isBusy = true
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'approve')
    })

    it('rejects invalid modes', () => {
      session.setPermissionMode('invalid')
      assert.equal(session.permissionMode, 'approve')
    })

    it('accepts acceptEdits mode', () => {
      session.setPermissionMode('acceptEdits')
      assert.equal(session.permissionMode, 'acceptEdits')
    })
  })

  // -- _sdkPermissionMode --

  describe('_sdkPermissionMode', () => {
    it('maps approve to default', () => {
      session.permissionMode = 'approve'
      assert.equal(session._sdkPermissionMode(), 'default')
    })

    it('maps auto to bypassPermissions', () => {
      session.permissionMode = 'auto'
      assert.equal(session._sdkPermissionMode(), 'bypassPermissions')
    })

    it('maps plan to plan', () => {
      session.permissionMode = 'plan'
      assert.equal(session._sdkPermissionMode(), 'plan')
    })

    it('maps acceptEdits to default (uses canUseTool callback)', () => {
      session.permissionMode = 'acceptEdits'
      assert.equal(session._sdkPermissionMode(), 'default')
    })
  })

  // -- sendMessage while busy --

  describe('sendMessage while busy', () => {
    it('queues message when already processing', () => {
      session._isBusy = true
      const errors = []
      session.on('error', (data) => errors.push(data))

      session.sendMessage('follow-up message')
      assert.equal(errors.length, 0)
      assert.equal(session._pendingInput.length, 1)
      assert.equal(session._pendingInput[0].prompt, 'follow-up message')
    })

    it('clears pending queue on destroy', () => {
      session._isBusy = true
      session.sendMessage('queued')
      assert.equal(session._pendingInput.length, 1)
      session.destroy()
      assert.equal(session._pendingInput.length, 0)
    })
  })

  // -- sendMessage when stdin forwarding is disabled (#3539) --
  //
  // PR #3536 (closes #3502) latches `_stdinForwardingDisabled` and surfaces it
  // to clients via a session-level `error` event. The flag is now visible, but
  // until #3539 sendMessage still accepted further writes that disappeared
  // into the SidecarProcess PassThrough. These tests cover the contract: send
  // before the flag flips succeeds; send after the flag flips is refused with
  // the same machine-readable `code: 'stdin_disabled'` and never reaches the
  // underlying SDK query.
  describe('sendMessage when stdin forwarding is disabled (#3539)', () => {
    it('accepts sendMessage before the flag flips (regression guard)', async () => {
      const s = createSession()
      s._processReady = true

      const captured = []
      s._callQuery = (args) => {
        captured.push(args)
        return (async function* () {
          yield { type: 'result', session_id: 'test-pre', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }

      await s.sendMessage('before disable')
      s.destroy()

      assert.equal(captured.length, 1, 'pre-disable sendMessage should reach the SDK')
      // #3540 wired a constructor initializer `this._stdinForwardingDisabled = false`,
      // so the pre-flip value is now `false` rather than `undefined`. The contract
      // here is "flag has not flipped" — match against the falsy initial state.
      assert.equal(s._stdinForwardingDisabled, false, 'flag must remain unset on a healthy turn')
    })

    it('refuses sendMessage after the flag is set and never invokes _callQuery', async () => {
      const s = createSession()
      s._processReady = true

      const captured = []
      s._callQuery = (args) => {
        captured.push(args)
        return (async function* () {
          yield { type: 'result', session_id: 'should-not-run', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }

      const errors = []
      s.on('error', (e) => errors.push(e))

      // Simulate the SidecarProcess having latched the flag (e.g. via
      // #3502's stdin_disabled signal handler) before this sendMessage call.
      s._stdinForwardingDisabled = true

      await s.sendMessage('after disable')

      assert.equal(captured.length, 0, '_callQuery must NOT be invoked when stdin forwarding is disabled')
      assert.equal(errors.length, 1, 'exactly one error event should fire on refused sendMessage')
      assert.equal(errors[0].code, 'stdin_disabled', 'error must carry the same machine-readable code as #3502')
      assert.equal(errors[0].recoverable, false, 'stdin_disabled is unrecoverable until session restart')
      assert.match(errors[0].message, /stdin/i, 'error message should mention stdin')
      assert.equal(s._isBusy, false, 'refused sendMessage must not flip _isBusy')

      s.destroy()
    })

    it('drains queued follow-ups when the flag flips so the dequeue path does not re-trigger writes', async () => {
      const s = createSession()
      s._processReady = true

      const captured = []
      s._callQuery = (args) => {
        captured.push(args)
        return (async function* () {
          yield { type: 'result', session_id: 'drain', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }

      const errors = []
      s.on('error', (e) => errors.push(e))

      // Queue up a few follow-ups while the session is busy (mirrors a real
      // turn that has the dequeue-on-finish path active).
      s._isBusy = true
      s.sendMessage('q1')
      s.sendMessage('q2')
      s.sendMessage('q3')
      assert.equal(s._pendingInput.length, 3, 'precondition: three messages queued')

      // Flag flips mid-turn (e.g. SidecarProcess loses stdin while query is
      // still streaming). Now any new sendMessage must reject AND drain the
      // queue so the post-finally process.nextTick dequeue does not call
      // sendMessage three more times.
      s._stdinForwardingDisabled = true
      s._isBusy = false  // turn finished, would normally trigger dequeue

      await s.sendMessage('arriving while disabled')

      assert.equal(captured.length, 0, '_callQuery must not be invoked')
      assert.equal(s._pendingInput.length, 0, 'queued follow-ups must be drained')
      assert.equal(errors.length, 1, 'a single error event covers the drained batch + new call')
      assert.equal(errors[0].code, 'stdin_disabled')

      s.destroy()
    })

    it('emits an error every time a fresh sendMessage is refused (no one-shot mute)', async () => {
      // The #3502 emit on the stdin_disabled signal is gated by the flag
      // itself (one warn / one error per session). The #3539 refusal at the
      // sendMessage entry point is per-call: every refused write deserves a
      // signal so callers can render "send failed" feedback per attempt.
      const s = createSession()
      s._processReady = true
      s._stdinForwardingDisabled = true

      const errors = []
      s.on('error', (e) => errors.push(e))

      await s.sendMessage('attempt 1')
      await s.sendMessage('attempt 2')
      await s.sendMessage('attempt 3')

      assert.equal(errors.length, 3, 'each refused sendMessage call should emit its own error')
      for (const err of errors) {
        assert.equal(err.code, 'stdin_disabled')
        assert.equal(err.recoverable, false)
      }

      s.destroy()
    })
  })

  // -- refused-sendMessage warn log rate-limit (#3575) --
  //
  // PR #3560 (#3539) logs a warn on every refused sendMessage when
  // `_stdinForwardingDisabled` is latched. A stuck client that retries on
  // every error event would otherwise flood operator logs. #3575 gates the
  // warn behind a `_lastRefusedWarnTs` + Date.now() window
  // (REFUSED_SENDMESSAGE_WARN_INTERVAL_MS, default 30s). The per-call
  // `error` event continues to fire on every refused attempt so client UI
  // feedback is unchanged — only the log line is rate-limited.
  describe('refused-sendMessage warn log rate-limit (#3575)', () => {
    it('logs the refusal warn on the first refused attempt', async () => {
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const s = createSession()
      s._processReady = true
      s._stdinForwardingDisabled = true
      s.on('error', () => {})  // swallow expected error event

      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await s.sendMessage('first refused')
      } finally {
        removeLogListener(listener)
      }

      const warns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Refusing sendMessage'),
      )
      assert.equal(warns.length, 1, 'first refused sendMessage must log the warn')
      assert.ok(s._lastRefusedWarnTs > 0,
        '_lastRefusedWarnTs must be stamped after the warn fires so the next call can be gated')

      s.destroy()
    })

    it('suppresses the refusal warn on a second refused attempt within the window', async () => {
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const { REFUSED_SENDMESSAGE_WARN_INTERVAL_MS } = await import('../src/sdk-session.js')

      const s = createSession()
      s._processReady = true
      s._stdinForwardingDisabled = true
      s.on('error', () => {})

      const errors = []
      s.on('error', (e) => errors.push(e))

      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await s.sendMessage('attempt 1')
        // Force the second call to land inside the rate-limit window by
        // stamping the timestamp to "just now". Avoids relying on real-time
        // ordering between two awaits.
        s._lastRefusedWarnTs = Date.now()
        await s.sendMessage('attempt 2')
        await s.sendMessage('attempt 3')
      } finally {
        removeLogListener(listener)
      }

      const warns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Refusing sendMessage'),
      )
      assert.equal(warns.length, 1,
        'subsequent refused sendMessage attempts within the window must be suppressed')
      assert.equal(errors.length, 3,
        'every refused sendMessage still emits an error event regardless of warn rate-limit')
      assert.ok(REFUSED_SENDMESSAGE_WARN_INTERVAL_MS > 0,
        'rate-limit interval constant must be a positive number of ms')

      s.destroy()
    })

    it('logs the refusal warn again after the rate-limit window elapses', async () => {
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const { REFUSED_SENDMESSAGE_WARN_INTERVAL_MS } = await import('../src/sdk-session.js')

      const s = createSession()
      s._processReady = true
      s._stdinForwardingDisabled = true
      s.on('error', () => {})

      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await s.sendMessage('attempt 1')
        // Simulate the window elapsing by backdating the timestamp far
        // enough that `now - _lastRefusedWarnTs >= INTERVAL_MS`. Direct
        // field manipulation avoids real-clock waits in the test.
        s._lastRefusedWarnTs = Date.now() - REFUSED_SENDMESSAGE_WARN_INTERVAL_MS - 1
        await s.sendMessage('attempt 2 — after window')
      } finally {
        removeLogListener(listener)
      }

      const warns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Refusing sendMessage'),
      )
      assert.equal(warns.length, 2,
        'a refused sendMessage after the rate-limit window must log a fresh warn')

      s.destroy()
    })

    it('also rate-limits the "Discarding queued follow-ups" warn so it does not bypass the gate', async () => {
      // The drain warn fires alongside the refusal warn whenever queued
      // follow-ups are present. It must share the same gate so a hot-loop
      // retry (which can pile up + drain queues each turn) does not flood
      // logs through the second warn channel.
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const s = createSession()
      s._processReady = true
      s._stdinForwardingDisabled = true
      s.on('error', () => {})

      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        // First refused call — both warns fire (refusal + drain of 0
        // queued follow-ups won't fire; pre-load the queue to force the
        // drain warn to be eligible).
        s._pendingInput = [{ prompt: 'q1' }, { prompt: 'q2' }]
        await s.sendMessage('attempt 1')
        // Second refused call inside the window — re-queue and verify the
        // drain warn is suppressed alongside the refusal warn.
        s._pendingInput = [{ prompt: 'q3' }]
        s._lastRefusedWarnTs = Date.now()
        await s.sendMessage('attempt 2')
      } finally {
        removeLogListener(listener)
      }

      const drainWarns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Discarding'),
      )
      assert.equal(drainWarns.length, 1,
        'drain warn must share the rate-limit gate with the refusal warn')
      assert.equal(s._pendingInput.length, 0,
        'queue must still be drained even when the warn is suppressed')

      s.destroy()
    })
  })

  // -- sandbox option in query --

  describe('sandbox option', () => {
    it('includes sandbox in query options when configured', async () => {
      const sandbox = {
        network: { allowedDomains: ['example.com'] },
        filesystem: { allowedPaths: ['/tmp'], deniedPaths: ['/etc'] },
        bash: { allowedCommands: ['ls', 'cat'] },
        autoAllowBashIfSandboxed: true,
      }
      const s = createSession({ sandbox })
      s._processReady = true

      // Capture the args passed to query() by patching _callQuery
      const captured = []
      s._callQuery = (args) => {
        captured.push(args)
        // Return an async iterable that yields a result immediately
        return (async function* () {
          yield { type: 'result', session_id: 'test-123', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }

      await s.sendMessage('hello')
      s.destroy()

      assert.equal(captured.length, 1)
      assert.deepEqual(captured[0].options.sandbox, sandbox)
    })

    it('omits sandbox from query options when not configured', async () => {
      const s = createSession()
      s._processReady = true

      const captured = []
      s._callQuery = (args) => {
        captured.push(args)
        return (async function* () {
          yield { type: 'result', session_id: 'test-456', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }

      await s.sendMessage('hello')
      s.destroy()

      assert.equal(captured.length, 1)
      assert.equal(captured[0].options.sandbox, undefined)
    })
  })

  // -- destroy --

  describe('destroy', () => {
    it('cleans up pending permissions', async () => {
      const promise = session._handlePermission('Bash', {}, null)
      session.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('cleans up pending user answer', async () => {
      const promise = session._permissions._handleAskUserQuestion({ questions: [] }, null)
      session.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('sets destroying flag and clears processReady', () => {
      session.start()
      session.destroy()
      assert.equal(session._destroying, true)
      assert.equal(session._processReady, false)
    })

    it('removes all listeners', () => {
      session.on('ready', () => {})
      session.on('error', () => {})
      session.destroy()
      assert.equal(session.listenerCount('ready'), 0)
      assert.equal(session.listenerCount('error'), 0)
    })
  })

  // -- Dynamic model list --

  describe('_fetchSupportedModels', () => {
    afterEach(() => {
      resetModels()
    })

    function mockQuery(overrides = {}) {
      return { interrupt: async () => {}, ...overrides }
    }

    it('emits models_updated with converted SDK models', async () => {
      const events = []
      session.on('models_updated', (data) => events.push(data))

      session._query = mockQuery({
        supportedModels: async () => [
          { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
          { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Capable' },
        ],
      })

      await session._fetchSupportedModels()

      assert.equal(events.length, 1)
      // Lookup by fullId — the registry merges fallback entries the SDK
      // omitted (#3075) and synthesizes [1m] variants for >=1M models, so
      // the emitted list is a superset of the two SDK entries above. We
      // assert that the SDK-supplied entries were converted correctly,
      // not the total length (which is registry-driven).
      const byFullId = new Map(events[0].models.map(m => [m.fullId, m]))
      const sonnet = byFullId.get('claude-sonnet-4-6')
      const opus = byFullId.get('claude-opus-4-6')
      assert.ok(sonnet, 'expected sonnet entry from SDK input')
      assert.equal(sonnet.id, 'sonnet-4-6')
      assert.equal(sonnet.label, 'Sonnet 4.6')
      assert.ok(opus, 'expected opus entry from SDK input')
      assert.equal(opus.id, 'opus-4-6')
      assert.equal(opus.label, 'Opus 4.6')
    })

    it('does not emit when query has no supportedModels method', async () => {
      const events = []
      session.on('models_updated', (data) => events.push(data))

      session._query = mockQuery()
      await session._fetchSupportedModels()

      assert.equal(events.length, 0)
    })

    it('does not emit when supportedModels throws', async () => {
      const events = []
      session.on('models_updated', (data) => events.push(data))

      session._query = mockQuery({
        supportedModels: async () => { throw new Error('SDK error') },
      })

      await session._fetchSupportedModels()

      assert.equal(events.length, 0)
    })

    it('does not emit when no query is active', async () => {
      const events = []
      session.on('models_updated', (data) => events.push(data))

      session._query = null
      await session._fetchSupportedModels()

      assert.equal(events.length, 0)
    })
  })

  // -- Getters --

  // -- Transform integration --

  describe('sendMessage applies transforms', () => {
    it('applies voiceCleanup when configured and isVoice is true', async () => {
      const s = createSession({ transforms: ['voiceCleanup'] })
      s._processReady = true

      // Spy on the pipeline's apply method
      const applyCalls = []
      const originalApply = s._transformPipeline.apply.bind(s._transformPipeline)
      s._transformPipeline.apply = (msg, ctx) => {
        applyCalls.push({ msg, ctx })
        return originalApply(msg, ctx)
      }

      // sendMessage will fail at the SDK query (no real client), but the
      // transform runs synchronously before the async part
      s.on('error', () => {}) // absorb the SDK error
      s.sendMessage('um fix the bug', [], { isVoice: true })

      // Give the async sendMessage a tick to start, then destroy to prevent hang
      await new Promise(r => setTimeout(r, 50))
      s.destroy()

      assert.equal(applyCalls.length, 1)
      assert.equal(applyCalls[0].msg, 'um fix the bug')
      assert.equal(applyCalls[0].ctx.isVoiceInput, true)
      assert.equal(applyCalls[0].ctx.cwd, '/tmp')
    })

    it('does not transform when no transforms configured', async () => {
      const s = createSession() // no transforms
      s._processReady = true

      const applyCalls = []
      const originalApply = s._transformPipeline.apply.bind(s._transformPipeline)
      s._transformPipeline.apply = (msg, ctx) => {
        applyCalls.push({ msg, ctx })
        return originalApply(msg, ctx)
      }

      s.on('error', () => {})
      s.sendMessage('hello world', [])

      await new Promise(r => setTimeout(r, 50))
      s.destroy()

      // Pipeline has no transforms, so apply is skipped (hasTransforms check)
      assert.equal(applyCalls.length, 0)
    })
  })

  // -- Query error enrichment --

  describe('query error enrichment', () => {
    async function queryWithError(s, errorMessage) {
      s._processReady = true
      const errors = []
      s.on('error', (data) => errors.push(data))

      s._callQuery = () => {
        return (async function* () {
          throw new Error(errorMessage)
        })()
      }

      await s.sendMessage('hello')
      return errors
    }

    it('enriches SIGABRT error with helpful context', async () => {
      const s = createSession()
      const errors = await queryWithError(s, 'Claude Code process terminated by signal SIGABRT')
      s.destroy()

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.includes('crashed'))
      assert.ok(errors[0].message.includes('API'))
      assert.ok(!errors[0].message.includes('SIGABRT'))
    })

    it('enriches rate limit errors', async () => {
      const s = createSession()
      const errors = await queryWithError(s, 'rate_limit_error: too many requests')
      s.destroy()

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.toLowerCase().includes('rate limit'))
    })

    it('enriches authentication errors', async () => {
      const s = createSession()
      const errors = await queryWithError(s, 'authentication_error: invalid api key')
      s.destroy()

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.toLowerCase().includes('api key'))
    })

    it('enriches billing/credit errors', async () => {
      const s = createSession()
      const errors = await queryWithError(s, 'Your account has insufficient credits')
      s.destroy()

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.toLowerCase().includes('credit'))
    })

    it('enriches overloaded errors', async () => {
      const s = createSession()
      const errors = await queryWithError(s, 'overloaded_error: the API is temporarily overloaded')
      s.destroy()

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.toLowerCase().includes('overloaded'))
    })

    it('passes through unknown errors unchanged', async () => {
      const s = createSession()
      const errors = await queryWithError(s, 'Something completely unknown went wrong')
      s.destroy()

      assert.equal(errors.length, 1)
      assert.equal(errors[0].message, 'Something completely unknown went wrong')
    })

    it('emits stream_end when error occurs after streaming started', async () => {
      const s = createSession()
      s._processReady = true
      const streamEnds = []
      const errors = []
      s.on('stream_end', (data) => streamEnds.push(data))
      s.on('error', (data) => errors.push(data))

      s._callQuery = () => {
        return (async function* () {
          yield { type: 'assistant', message: { id: 'msg-1', content: [], model: 'test', role: 'assistant' } }
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }
          throw new Error('process terminated by signal SIGABRT')
        })()
      }

      await s.sendMessage('hello')
      s.destroy()

      assert.equal(streamEnds.length, 1)
      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.includes('crashed'))
    })
  })

  describe('result timeout resets on activity', () => {
    it('resets timeout on each SDK event (no false timeout during active work)', async () => {
      const s = createSession()
      s._processReady = true
      const errors = []
      s.on('error', (data) => errors.push(data))

      // Simulate a long-running query with many tool events
      s._callQuery = () => {
        return (async function* () {
          // Yield events spread over time — each should reset the timeout
          yield { type: 'assistant', message: { id: 'msg-1', content: [], model: 'test', role: 'assistant' } }
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read' } } }
          yield { type: 'result', session_id: 'test-123', total_cost_usd: 0, duration_ms: 100, usage: {} }
        })()
      }

      await s.sendMessage('hello')

      // Should complete without timeout error
      assert.equal(errors.length, 0)
      assert.equal(s._resultTimeout, null) // cleared in finally
      s.destroy()
    })
  })

  // -- modelUsage contract drift --

  describe('modelUsage contract drift', () => {
    afterEach(() => {
      resetModels()
    })

    async function runWithModelUsage(modelUsage) {
      const s = createSession()
      s._processReady = true
      s._callQuery = () => {
        return (async function* () {
          yield {
            type: 'result',
            session_id: 'drift-test',
            total_cost_usd: 0,
            duration_ms: 0,
            usage: {},
            modelUsage,
          }
        })()
      }
      await s.sendMessage('hello')
      s.destroy()
    }

    it('logs debug message when modelUsage entries lack contextWindow', async () => {
      const { addLogListener, removeLogListener, setLogLevel } = await import(
        '../src/logger.js'
      )
      setLogLevel('debug')
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await runWithModelUsage({
          'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50 },
        })
      } finally {
        removeLogListener(listener)
        setLogLevel('info')
      }

      const drift = entries.find(
        (e) => e.component === 'sdk' && e.message.startsWith('modelUsage partial drift')
      )
      assert.ok(drift, 'expected a drift debug log')
      assert.equal(drift.level, 'debug')
      assert.ok(drift.message.includes('claude-sonnet-4-6'))
      assert.ok(drift.message.includes('inputTokens'))
    })

    it('logs partial drift when some entries carry contextWindow and others do not', async () => {
      const { addLogListener, removeLogListener, setLogLevel } = await import(
        '../src/logger.js'
      )
      setLogLevel('debug')
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await runWithModelUsage({
          'claude-sonnet-4-6': { contextWindow: 200000 },
          'claude-haiku-4-6': { inputTokens: 42, outputTokens: 17 },
        })
      } finally {
        removeLogListener(listener)
        setLogLevel('info')
      }

      const drift = entries.find(
        (e) => e.component === 'sdk' && e.message.startsWith('modelUsage partial drift')
      )
      assert.ok(drift, 'expected a partial drift debug log')
      assert.equal(drift.level, 'debug')
      // Only the entry missing contextWindow should be reported
      assert.ok(
        drift.message.includes('claude-haiku-4-6'),
        'expected missing model id in log'
      )
      assert.ok(
        !drift.message.includes('claude-sonnet-4-6'),
        'entries that satisfied the contract should not appear in missingIds'
      )
      // Sample keys from the skipped entry should be present for diagnostics
      assert.ok(drift.message.includes('inputTokens'))
    })

    it('does not log drift when contextWindow is present', async () => {
      const { addLogListener, removeLogListener, setLogLevel } = await import(
        '../src/logger.js'
      )
      setLogLevel('debug')
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await runWithModelUsage({
          'claude-sonnet-4-6': { contextWindow: 200000 },
        })
      } finally {
        removeLogListener(listener)
        setLogLevel('info')
      }

      const drift = entries.find(
        (e) => e.component === 'sdk' && e.message.startsWith('modelUsage partial drift')
      )
      assert.equal(drift, undefined)
    })

    it('does not log drift when modelUsage is empty', async () => {
      const { addLogListener, removeLogListener, setLogLevel } = await import(
        '../src/logger.js'
      )
      setLogLevel('debug')
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        await runWithModelUsage({})
      } finally {
        removeLogListener(listener)
        setLogLevel('info')
      }

      const drift = entries.find(
        (e) => e.component === 'sdk' && e.message.startsWith('modelUsage partial drift')
      )
      assert.equal(drift, undefined)
    })
  })

  describe('getters', () => {
    it('isRunning reflects _isBusy', () => {
      assert.equal(session.isRunning, false)
      session._isBusy = true
      assert.equal(session.isRunning, true)
    })

    it('isReady requires processReady and not busy', () => {
      assert.equal(session.isReady, false)
      session._processReady = true
      assert.equal(session.isReady, true)
      session._isBusy = true
      assert.equal(session.isReady, false)
    })
  })

  // -- _attachSidecarProcessListeners (#3402, #3474) --
  //
  // SidecarProcess emits stdin_dropped (#3474) and stdin_disabled (#3402)
  // when stdin forwarding fails or over-cap chunks are dropped.  Without a
  // consumer the SDK's PassThrough silently swallows the data and the user
  // sees a hung turn.  SdkSession provides a default warn-log listener so
  // the failure surfaces in operator logs at minimum.
  describe('_attachSidecarProcessListeners', () => {
    it('logs an error on the first stdin_dropped (#3506)', async () => {
      // The first drop in a session is escalated to error level so the
      // signal stands out in operator logs — subsequent drops fall back
      // to warn unless a cumulative threshold is crossed.
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })
      } finally {
        removeLogListener(listener)
      }

      const errorEntry = entries.find(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.ok(errorEntry, 'expected an error-level log on first stdin_dropped')
      assert.ok(errorEntry.message.includes('60 bytes'),
        'log must include the dropped byte count')
      assert.ok(errorEntry.message.includes('pre-dial-cap'),
        'log must include the drop reason tag')
      assert.ok(errorEntry.message.includes('cumulative='),
        'log must include the cumulative running total')
    })

    it('accumulates dropped bytes across events (#3506)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 100, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', { bytes: 250, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', { bytes: 50, reason: 'pre-dial-cap' })

      assert.equal(session._stdinDroppedBytesTotal, 400,
        'cumulative bytes must equal the sum of every drop')
      assert.equal(session._stdinDroppedCount, 3,
        'drop count must equal the number of stdin_dropped events')
    })

    it('treats unknown/missing byte counts as zero in the running total (#3506)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 100, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped')                 // no payload
      proc.emit('stdin_dropped', { reason: 'x' }) // no bytes field

      assert.equal(session._stdinDroppedBytesTotal, 100,
        'unknown byte counts must not poison the running total')
      assert.equal(session._stdinDroppedCount, 3,
        'every event still bumps the drop count')
    })

    it('logs subsequent drops at warn level (#3506)', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })  // first → error
        proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })  // second → warn
        proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })  // third → warn
      } finally {
        removeLogListener(listener)
      }

      const errs = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      const warns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.equal(errs.length, 1, 'only the first drop escalates to error')
      assert.equal(warns.length, 2, 'subsequent drops log at warn level')
    })

    it('escalates to error every N drops (#3506)', async () => {
      // Operators triaging "why did my prompt vanish?" need a recurring
      // loud signal even on a flood of small drops.  Every Nth drop is
      // re-escalated to error.
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const { STDIN_DROPPED_ESCALATION_EVERY_N } = await import('../src/sdk-session.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        for (let i = 0; i < STDIN_DROPPED_ESCALATION_EVERY_N; i++) {
          proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' })
        }
      } finally {
        removeLogListener(listener)
      }

      const errs = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      // First drop is always error; the Nth drop is re-escalated.
      assert.equal(errs.length, 2,
        'expected error on first drop and on the Nth drop')
    })

    it('escalates to error when cumulative bytes cross the threshold (#3506)', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const { STDIN_DROPPED_BYTES_ERROR_THRESHOLD } = await import('../src/sdk-session.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        // First drop — always error, so emit a tiny one then push a chunk
        // that crosses the cumulative threshold and produces a second error.
        proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' })
        proc.emit('stdin_dropped', {
          bytes: STDIN_DROPPED_BYTES_ERROR_THRESHOLD,
          reason: 'pre-dial-cap',
        })
      } finally {
        removeLogListener(listener)
      }

      const errs = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.equal(errs.length, 2,
        'expected error on first drop and again when cumulative >= threshold')
      assert.ok(errs[1].message.includes('cumulative='),
        'threshold-cross error must include the cumulative byte total')
    })

    it('does not re-escalate after the byte threshold once crossed (#3506)', async () => {
      // After the cumulative byte threshold is crossed, subsequent drops
      // still log (at warn) but should not spam additional error lines —
      // the escalation is one-shot per crossing.
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const { STDIN_DROPPED_BYTES_ERROR_THRESHOLD } = await import('../src/sdk-session.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' })  // first → error
        proc.emit('stdin_dropped', {
          bytes: STDIN_DROPPED_BYTES_ERROR_THRESHOLD,
          reason: 'pre-dial-cap',
        })  // crosses threshold → error
        proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' })  // → warn, no re-escalation
        proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' })  // → warn
      } finally {
        removeLogListener(listener)
      }

      const errs = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.equal(errs.length, 2,
        'threshold-crossing escalation must be one-shot')
    })

    // #3543 — the cumulative byte total is hard to scan as raw bytes once a
    // session crosses MiB scale.  The log line keeps the raw count for
    // scriptable consumers and appends a humanised KiB/MiB/GiB suffix so
    // operators can triage at a glance.
    it('formats the cumulative byte total as a humanised KiB/MiB suffix (#3543)', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      // Drive the cumulative total through three magnitudes (B → KiB → MiB)
      // in a single attach, asserting the suffix on each emit so we lock the
      // log-line shape for every range we care about.
      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        // First emit: 500 B total — bytes range.
        proc.emit('stdin_dropped', { bytes: 500, reason: 'pre-dial-cap' })
        // Second emit: +2000 B → 2500 B total — KiB range (2.4 KiB).
        proc.emit('stdin_dropped', { bytes: 2000, reason: 'pre-dial-cap' })
        // Third emit: bump to MiB scale — 2500 + 1 MiB = 1051076 → "1.0 MiB".
        proc.emit('stdin_dropped', { bytes: 1024 * 1024, reason: 'pre-dial-cap' })
      } finally {
        removeLogListener(listener)
      }

      const drops = entries.filter(
        (e) => e.component === 'sdk' &&
          (e.level === 'error' || e.level === 'warn') &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.equal(drops.length, 3, 'expected one log per stdin_dropped emit')

      // Raw byte count is preserved on every line — scriptable consumers
      // (regex log scrapers, dashboards) keep working unchanged.
      for (const entry of drops) {
        assert.ok(/cumulative=\d+ bytes /.test(entry.message),
          `line must keep the raw "cumulative=N bytes" prefix, got: ${entry.message}`)
      }

      // Humanised suffix per magnitude.
      assert.ok(drops[0].message.includes('cumulative=500 bytes (500 B)'),
        `bytes-range line must show "500 B", got: ${drops[0].message}`)
      assert.ok(drops[1].message.includes('cumulative=2500 bytes (2.4 KiB)'),
        `KiB-range line must show "2.4 KiB", got: ${drops[1].message}`)
      // 2500 + 1048576 = 1051076 bytes → 1.0 MiB once formatted.
      assert.ok(/cumulative=1051076 bytes \(1\.0 MiB\)/.test(drops[2].message),
        `MiB-range line must show "1.0 MiB", got: ${drops[2].message}`)
    })

    // #3543 — the load-bearing case: at the 10 MiB error-escalation
    // threshold the line must read "10.0 MiB" so triage operators can spot
    // the threshold crossing without doing arithmetic in their head.
    it('renders the 10 MiB error-escalation threshold as "10.0 MiB" (#3543)', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const { STDIN_DROPPED_BYTES_ERROR_THRESHOLD } = await import('../src/sdk-session.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        // Single drop big enough to cross the threshold immediately so the
        // first-drop error log is also the threshold-cross log.
        proc.emit('stdin_dropped', {
          bytes: STDIN_DROPPED_BYTES_ERROR_THRESHOLD,
          reason: 'pre-dial-cap',
        })
      } finally {
        removeLogListener(listener)
      }

      const errorEntry = entries.find(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.ok(errorEntry, 'expected error log on threshold-cross drop')
      assert.ok(errorEntry.message.includes(`cumulative=${STDIN_DROPPED_BYTES_ERROR_THRESHOLD} bytes (10.0 MiB)`),
        `threshold line must show "10.0 MiB" alongside raw byte count, got: ${errorEntry.message}`)
    })

    it('logs a warning when stdin_disabled fires on the proc', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)
      // #3502: stdin_disabled now also emits a session-level `error` event;
      // attach a no-op listener so EventEmitter doesn't crash on emit.
      session.on('error', () => {})

      try {
        session._attachSidecarProcessListeners(proc)
        proc.emit('stdin_disabled')
      } finally {
        removeLogListener(listener)
      }

      const warn = entries.find(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Sidecar stdin forwarding is disabled'),
      )
      assert.ok(warn, 'expected a warn-level log on stdin_disabled')
    })

    it('handles a missing proc safely', () => {
      // ChildProcess paths or test stubs may pass null/undefined — must
      // not throw because the helper runs unconditionally.
      assert.doesNotThrow(() => session._attachSidecarProcessListeners(null))
      assert.doesNotThrow(() => session._attachSidecarProcessListeners(undefined))
      assert.doesNotThrow(() => session._attachSidecarProcessListeners({}))
    })

    it('logs unknown payload values when info is missing', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        session._attachSidecarProcessListeners(proc)
        proc.emit('stdin_dropped')  // no payload
      } finally {
        removeLogListener(listener)
      }

      // First drop always escalates to error (#3506); accept either level.
      const entry = entries.find(
        (e) => e.component === 'sdk' &&
          (e.level === 'warn' || e.level === 'error') &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.ok(entry, 'must still log when payload is missing')
      assert.ok(entry.message.includes('unknown bytes'),
        'must report unknown bytes when payload omits the count')
    })

    // #3502 — surface the _stdinForwardingDisabled flag to clients via a
    // session-level `error` event so dashboards / mobile apps can render a
    // banner ("stdin forwarding lost — restart this session") instead of
    // staring at a hung turn.  The session-manager already proxies the
    // `error` event into the unified `session_event` envelope, so a single
    // emit on first signal is enough.
    it('emits an error event with code=stdin_disabled the first time the signal fires (#3502)', async () => {
      const { EventEmitter } = await import('events')

      const proc = new EventEmitter()
      const errorEvents = []
      session.on('error', (e) => errorEvents.push(e))

      session._attachSidecarProcessListeners(proc)
      proc.emit('stdin_disabled')

      assert.equal(errorEvents.length, 1, 'exactly one error event should fire on first stdin_disabled signal')
      assert.equal(errorEvents[0].code, 'stdin_disabled', 'error payload should carry the machine-readable code')
      assert.equal(errorEvents[0].recoverable, false, 'stdin disabled is unrecoverable until session restart')
      assert.match(errorEvents[0].message, /stdin/i, 'error message should mention stdin')

      // Idempotent — second emission must NOT re-fire the error event.
      proc.emit('stdin_disabled')
      assert.equal(errorEvents.length, 1, 'error event must fire exactly once per session')
    })

    // #3540: when a session is restored from disk with the latch already
    // set (the prior process recorded `stdin_disabled` and persisted it),
    // a fresh SidecarProcess `stdin_disabled` signal MUST stay silenced —
    // no warn, no error event, no double-banner on the dashboard.  The
    // existing `if (this._stdinForwardingDisabled) return` short-circuit
    // already handles this; the test pins the contract so a future
    // refactor cannot regress.
    it('does not warn or emit error when the latch was hydrated at construct time (#3540)', async () => {
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      // Construct with the persisted latch already set.
      const restored = new SdkSession({ cwd: '/tmp', stdinForwardingDisabled: true })
      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)
      const errorEvents = []
      restored.on('error', (e) => errorEvents.push(e))

      try {
        restored._attachSidecarProcessListeners(proc)
        proc.emit('stdin_disabled')
      } finally {
        removeLogListener(listener)
      }

      const disabledWarns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Sidecar stdin forwarding is disabled'),
      )
      assert.equal(disabledWarns.length, 0,
        'restored sessions must not re-warn — the user already saw this banner before the restart')
      assert.equal(errorEvents.length, 0,
        'restored sessions must not re-emit the error event — metadata field is the canonical signal for cold restart')
      assert.equal(restored._stdinForwardingDisabled, true,
        'latch stays on across the (suppressed) signal')

      restored.destroy()
    })

    it('is idempotent — repeated calls do not stack listeners', async () => {
      // Without the guard, calling _attachSidecarProcessListeners twice on
      // the same proc would attach two warn-log handlers and emit two log
      // lines per event.  Verify the Symbol-marker guard short-circuits
      // the second call (#3504 review).
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const proc = new EventEmitter()
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)
      // #3502: stdin_disabled now also emits a session-level `error` event;
      // attach a no-op listener so EventEmitter doesn't crash on emit.
      session.on('error', () => {})

      try {
        session._attachSidecarProcessListeners(proc)
        session._attachSidecarProcessListeners(proc)  // second call — must no-op
        session._attachSidecarProcessListeners(proc)  // third call — must no-op
        proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })
        proc.emit('stdin_disabled')
      } finally {
        removeLogListener(listener)
      }

      // The first drop now escalates to error (#3506); accept either level.
      const droppedLogs = entries.filter(
        (e) => e.component === 'sdk' &&
          (e.level === 'warn' || e.level === 'error') &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      const disabledWarns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Sidecar stdin forwarding is disabled'),
      )
      assert.equal(droppedLogs.length, 1,
        'stdin_dropped log must fire exactly once even after triple-attach')
      assert.equal(disabledWarns.length, 1,
        'stdin_disabled warn must fire exactly once even after triple-attach')
      // Listener counts on the proc itself should also reflect single-wire.
      assert.equal(proc.listenerCount('stdin_dropped'), 1,
        'only one stdin_dropped listener should be attached')
      assert.equal(proc.listenerCount('stdin_disabled'), 1,
        'only one stdin_disabled listener should be attached')
    })

    // -- #3542 — session-lifetime counter contract --
    //
    // The cumulative `_stdinDroppedBytesTotal`, `_stdinDroppedCount`, and
    // `_stdinDroppedThresholdLogged` flags are session-lifetime by design
    // (see #3506).  They MUST survive a `_clearMessageState()` / mid-session
    // interrupt — otherwise the loud-signal escalation would re-fire on
    // every turn (each turn would treat its first drop as "first drop ever")
    // and the threshold-cross one-shot would silently regress.  These tests
    // pin the contract so a future refactor of `_clearMessageState()` can't
    // accidentally reset the counters.
    it('preserves stdin_dropped counters across _clearMessageState() (#3542)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 100, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', { bytes: 250, reason: 'pre-dial-cap' })

      const bytesBefore = session._stdinDroppedBytesTotal
      const countBefore = session._stdinDroppedCount
      assert.equal(bytesBefore, 350)
      assert.equal(countBefore, 2)

      session._clearMessageState()

      assert.equal(session._stdinDroppedBytesTotal, bytesBefore,
        '_stdinDroppedBytesTotal must survive _clearMessageState()')
      assert.equal(session._stdinDroppedCount, countBefore,
        '_stdinDroppedCount must survive _clearMessageState()')
    })

    it('preserves _stdinDroppedThresholdLogged across _clearMessageState() (#3542)', async () => {
      const { EventEmitter } = await import('events')
      const { STDIN_DROPPED_BYTES_ERROR_THRESHOLD } = await import('../src/sdk-session.js')

      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', {
        bytes: STDIN_DROPPED_BYTES_ERROR_THRESHOLD,
        reason: 'pre-dial-cap',
      })
      assert.equal(session._stdinDroppedThresholdLogged, true,
        'precondition: threshold-crossed flag must be set after the big drop')

      session._clearMessageState()

      assert.equal(session._stdinDroppedThresholdLogged, true,
        '_stdinDroppedThresholdLogged must survive _clearMessageState()')
    })

    it('preserves stdin_dropped counters across interrupt() (#3542)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })

      const bytesBefore = session._stdinDroppedBytesTotal
      const countBefore = session._stdinDroppedCount
      const thresholdLoggedBefore = session._stdinDroppedThresholdLogged

      // Mid-session interrupt — no active query so this is a no-op,
      // but it exercises the public contract.
      await session.interrupt()

      assert.equal(session._stdinDroppedBytesTotal, bytesBefore,
        '_stdinDroppedBytesTotal must survive interrupt()')
      assert.equal(session._stdinDroppedCount, countBefore,
        '_stdinDroppedCount must survive interrupt()')
      assert.equal(session._stdinDroppedThresholdLogged, thresholdLoggedBefore,
        '_stdinDroppedThresholdLogged must survive interrupt()')
    })

    it('does not re-escalate a fresh drop after _clearMessageState() to error (#3542)', async () => {
      // The "first drop" error is one-shot per session.  After a turn ends
      // and `_clearMessageState()` runs, the next turn's first drop must
      // log at warn — otherwise operators would see a fresh "first drop"
      // error every turn and the loud-signal contract would regress.
      const { EventEmitter } = await import('events')
      const { addLogListener, removeLogListener } = await import('../src/logger.js')

      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      // Turn 1 — first drop fires the one-shot error.
      proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })

      // End of turn 1.
      session._clearMessageState()

      // Turn 2 — capture only the logs that happen AFTER the clear so we
      // can assert the post-clear drop does NOT escalate.
      const entries = []
      const listener = (entry) => entries.push(entry)
      addLogListener(listener)

      try {
        proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })
      } finally {
        removeLogListener(listener)
      }

      const errs = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'error' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      const warns = entries.filter(
        (e) => e.component === 'sdk' &&
          e.level === 'warn' &&
          e.message.includes('Sidecar stdin chunk dropped'),
      )
      assert.equal(errs.length, 0,
        'post-clear drop must not re-escalate to error — first-drop is one-shot per session')
      assert.equal(warns.length, 1,
        'post-clear drop must still log at warn level')
    })

    // -- #3544 — surface stdin_dropped totals over the WS protocol --
    //
    // Operators not tailing the server log (mobile users, dashboard-only
    // operators) have no visibility into how much input has been lost.
    // Each escalation point (first drop, every Nth drop, byte threshold
    // cross) must also emit a session-level `stdin_dropped_totals` event
    // carrying the running cumulative counters so SessionManager can
    // proxy it onto the unified `session_event` envelope.
    it('exposes stdinDroppedTotals via a public getter (#3544)', () => {
      assert.deepEqual(session.stdinDroppedTotals, { bytes: 0, count: 0 },
        'getter returns zeroed totals before any drops')
    })

    it('reflects accumulated drops in the public getter (#3544)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 100, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', { bytes: 250, reason: 'pre-dial-cap' })

      assert.deepEqual(session.stdinDroppedTotals, { bytes: 350, count: 2 },
        'getter must mirror the cumulative counters')
    })

    it('emits stdin_dropped_totals on the first drop with cumulative counters (#3544)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      const totalsEvents = []
      session.on('stdin_dropped_totals', (data) => totalsEvents.push(data))

      session._attachSidecarProcessListeners(proc)
      proc.emit('stdin_dropped', { bytes: 75, reason: 'pre-dial-cap' })

      assert.equal(totalsEvents.length, 1,
        'first drop must emit exactly one stdin_dropped_totals event')
      assert.equal(totalsEvents[0].bytes, 75,
        'event must carry the cumulative byte total')
      assert.equal(totalsEvents[0].count, 1,
        'event must carry the cumulative drop count')
      assert.equal(totalsEvents[0].reason, 'pre-dial-cap',
        'event must echo the drop reason')
      assert.equal(totalsEvents[0].escalated, true,
        'first drop is escalated — flag must be true')
    })

    it('emits stdin_dropped_totals on every drop, not just escalations (#3544)', async () => {
      // The dashboard needs to render a live "X bytes lost" counter, so
      // even non-escalated warn-level drops must surface a totals event.
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      const totalsEvents = []
      session.on('stdin_dropped_totals', (data) => totalsEvents.push(data))

      session._attachSidecarProcessListeners(proc)
      proc.emit('stdin_dropped', { bytes: 50, reason: 'pre-dial-cap' })   // first → escalated
      proc.emit('stdin_dropped', { bytes: 50, reason: 'pre-dial-cap' })   // warn → not escalated
      proc.emit('stdin_dropped', { bytes: 50, reason: 'pre-dial-cap' })   // warn → not escalated

      assert.equal(totalsEvents.length, 3,
        'every drop must emit a stdin_dropped_totals event')
      assert.deepEqual(
        totalsEvents.map((e) => ({ bytes: e.bytes, count: e.count, escalated: e.escalated })),
        [
          { bytes: 50, count: 1, escalated: true },
          { bytes: 100, count: 2, escalated: false },
          { bytes: 150, count: 3, escalated: false },
        ],
        'cumulative counters and escalation flag must reflect each drop',
      )
    })

    it('marks escalated=true when the cumulative byte threshold is crossed (#3544)', async () => {
      const { EventEmitter } = await import('events')
      const { STDIN_DROPPED_BYTES_ERROR_THRESHOLD } = await import('../src/sdk-session.js')
      const proc = new EventEmitter()
      const totalsEvents = []
      session.on('stdin_dropped_totals', (data) => totalsEvents.push(data))

      session._attachSidecarProcessListeners(proc)
      proc.emit('stdin_dropped', { bytes: 1, reason: 'pre-dial-cap' }) // first → escalated
      proc.emit('stdin_dropped', {
        bytes: STDIN_DROPPED_BYTES_ERROR_THRESHOLD,
        reason: 'pre-dial-cap',
      }) // crosses threshold → escalated

      assert.equal(totalsEvents.length, 2)
      assert.equal(totalsEvents[0].escalated, true,
        'first drop is always escalated')
      assert.equal(totalsEvents[1].escalated, true,
        'threshold-cross drop must also be marked escalated')
    })

    it('treats unknown bytes as zero in the emitted totals (#3544)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      const totalsEvents = []
      session.on('stdin_dropped_totals', (data) => totalsEvents.push(data))

      session._attachSidecarProcessListeners(proc)
      proc.emit('stdin_dropped', { bytes: 100, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped')                  // unknown bytes
      proc.emit('stdin_dropped', { reason: 'x' }) // unknown bytes

      assert.equal(totalsEvents.length, 3,
        'every drop emits a totals event regardless of payload completeness')
      assert.equal(totalsEvents[0].bytes, 100)
      assert.equal(totalsEvents[1].bytes, 100, 'unknown bytes must not mutate the running total')
      assert.equal(totalsEvents[2].bytes, 100)
      assert.equal(totalsEvents[2].count, 3, 'count still increments on unknown payloads')
    })
  })
})
