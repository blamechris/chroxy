import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession } from '../src/sdk-session.js'
import { SessionStatePersistence } from '../src/session-state-persistence.js'
import { resetModels } from '../src/models.js'

/**
 * Tests for SdkSession — permission handling, question handling,
 * agent tracking, model/permission mode changes, and cleanup.
 *
 * These tests instantiate SdkSession without calling start() or
 * sendMessage() and exercise internal methods directly.
 *
 * #4700: every test routes through a per-test temp `stateFilePath` so a
 * future regression that gives SdkSession a persistence path can never
 * contaminate `~/.chroxy/session-state.json`. SdkSession does not
 * currently accept `stateFilePath` directly (the persistence layer lives
 * on SessionManager / SessionStatePersistence), so the value is stashed
 * on the instance as `_testStateFilePath` and ignored by the constructor
 * — purely a belt-and-braces guard so the moment someone wires a write
 * path on the session this hook already exists. Mirrors the temp-state
 * discipline pinned in session-manager.test.js (#429, #2314).
 */

// Module-level temp dir for tests that don't manage their own. Each call
// returns a unique file path so concurrent describe blocks don't share
// state. The `after` hook below tears the whole dir down.
let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'sdk-session-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

function createSession(opts = {}) {
  const stateFilePath = opts.stateFilePath || tmpStateFile()
  // SdkSession ignores unknown keys via destructuring today, so passing
  // `stateFilePath` is a harmless no-op now AND auto-protects the suite
  // the moment someone wires a persistence path on the session class —
  // the destructured value will point at the per-test temp file instead
  // of `~/.chroxy/session-state.json`. The path is also stashed on the
  // instance so individual tests can assert on it.
  const session = new SdkSession({ cwd: '/tmp', stateFilePath, ...opts })
  session._testStateFilePath = stateFilePath
  return session
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

    // #3749 / #3884: result-timeout window is configurable per server.
    // Default is the BaseSession constant (30 min as of #3884); explicit
    // values flow from SessionManager → providerOpts.resultTimeoutMs →
    // BaseSession.
    it('defaults _resultTimeoutMs to 30 minutes (#3749 / #3884)', () => {
      assert.equal(session._resultTimeoutMs, 30 * 60 * 1000,
        'fresh sessions must adopt the BaseSession default so legitimate slow tools do not time out at 5 min')
    })

    it('honours an explicit resultTimeoutMs option (#3749)', () => {
      const s = createSession({ resultTimeoutMs: 600_000 })
      assert.equal(s._resultTimeoutMs, 600_000,
        'operators must be able to extend / shorten the inactivity safety net via config')
      s.destroy()
    })

    it('falls back to the default when resultTimeoutMs is non-positive (#3749)', () => {
      const s1 = createSession({ resultTimeoutMs: 0 })
      const s2 = createSession({ resultTimeoutMs: -1 })
      const s3 = createSession({ resultTimeoutMs: 'oops' })
      assert.equal(s1._resultTimeoutMs, 30 * 60 * 1000)
      assert.equal(s2._resultTimeoutMs, 30 * 60 * 1000)
      assert.equal(s3._resultTimeoutMs, 30 * 60 * 1000)
      s1.destroy()
      s2.destroy()
      s3.destroy()
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
      const fastSession = createSession()
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

    it('re-emits AskUserQuestion permission_resolved WITH toolUseId so questionSessionMap can prune via the unified pipeline (#3048, #3975, #3988)', async () => {
      const upstream = []
      session.on('permission_resolved', (data) => upstream.push(data))

      // AskUserQuestion routes through _handlePermission but resolves via
      // the question path. PermissionManager emits permission_resolved
      // with { toolUseId, reason: 'answered' } (#3988 — symmetric with the
      // aborted/timeout/cleared question-variant emits added in #3975).
      // SdkSession's gate at line ~281 allows toolUseId-only payloads
      // through so EventNormalizer + ws-forwarding can prune
      // questionSessionMap on the unified pipeline. The ws-server
      // permission-audit listener still ignores question variants by
      // gating on data.requestId.
      const promise = session._handlePermission('AskUserQuestion', { questions: [{ question: 'ok?' }] }, null)
      session.respondToQuestion('yes')
      await promise

      assert.equal(upstream.length, 1,
        'question variant emits permission_resolved with toolUseId for unified-pipeline cleanup')
      assert.equal(upstream[0].requestId, undefined,
        'question variant carries no requestId — distinct wire from permission requests')
      assert.equal(typeof upstream[0].toolUseId, 'string',
        'toolUseId is propagated so EventNormalizer can prune questionSessionMap')
      assert.equal(upstream[0].reason, 'answered')
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

    it('aligns toolUseId with synthesized fallback when block.id is missing (#4778)', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      // Mirrors the defensive fallback path of buildToolStartData when
      // upstream stream_event omits content_block.id. agent_spawned +
      // _activeAgents must key off the synthesized `${messageId}-tool`
      // id, not `undefined`, so they match the wire-emitted tool_start.
      session._handleToolUseBlock('msg-99', {
        name: 'Task',
        input: { description: 'fallback path' },
      })

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'msg-99-tool')
      assert.ok(session._activeAgents.has('msg-99-tool'))
      assert.ok(!session._activeAgents.has(undefined))
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

    // #4307: background-shell tracking wired through SdkSession's
    // tool_use → tool_result loop. Asserts: command stashing at
    // tool_use time, BashOutput-triggered clearing, ignoring non-Bash
    // run_in_background:false calls.
    describe('#4307 — background-shell tracking', () => {
      it('stashes the command on a run_in_background Bash tool_use', () => {
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-1',
          input: { command: 'sleep 600', run_in_background: true },
        })
        assert.equal(session._pendingBackgroundCommands.get('tu-bg-1'), 'sleep 600')
        // No shell registered yet — that happens on the matching tool_result.
        assert.equal(session._pendingBackgroundShells.size, 0)
      })

      it('does not stash on a regular Bash call (no run_in_background flag)', () => {
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-2',
          input: { command: 'ls' },
        })
        assert.equal(session._pendingBackgroundCommands.size, 0)
      })

      it('does not stash on a non-Bash tool with run_in_background:true (defensive)', () => {
        // The flag is Bash-specific in Claude's tool surface — a non-Bash
        // call with the field is a malformed payload; reject without
        // poisoning the pending-commands map.
        session._handleToolUseBlock('msg-1', {
          name: 'Edit',
          id: 'tu-bg-3',
          input: { file_path: '/foo', run_in_background: true },
        })
        assert.equal(session._pendingBackgroundCommands.size, 0)
      })

      it('records a pending shell when the matching tool_result carries the canonical id', () => {
        const events = []
        session.on('background_work_changed', (e) => events.push(e))
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-4',
          input: { command: 'sleep 600', run_in_background: true },
        })
        session._recordBackgroundShellsFromToolResults([
          {
            type: 'tool_result',
            tool_use_id: 'tu-bg-4',
            content: 'Command running in background with ID: brk57kt6pm. Output…',
          },
        ])
        assert.equal(session._pendingBackgroundShells.size, 1)
        const entry = session._pendingBackgroundShells.get('brk57kt6pm')
        assert.equal(entry.command, 'sleep 600')
        assert.equal(entry.shellId, 'brk57kt6pm')
        assert.ok(entry.startedAt > 0)
        // The ephemeral command stash drops once promoted to a pending shell.
        assert.equal(session._pendingBackgroundCommands.has('tu-bg-4'), false)
        // background_work_changed fired with the new snapshot.
        assert.equal(events.length, 1)
        assert.equal(events[0].pending[0].shellId, 'brk57kt6pm')
      })

      it('extracts the id from an array-form content block (text-only blocks)', () => {
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-5',
          input: { command: 'long-running', run_in_background: true },
        })
        session._recordBackgroundShellsFromToolResults([
          {
            type: 'tool_result',
            tool_use_id: 'tu-bg-5',
            content: [
              { type: 'text', text: 'Command running in background with ID: bg-abc-1.' },
            ],
          },
        ])
        assert.equal(session._pendingBackgroundShells.size, 1)
        assert.ok(session._pendingBackgroundShells.has('bg-abc-1'))
      })

      it('isRunning reports waiting (true) once _isBusy clears but the shell is pending', () => {
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-6',
          input: { command: 'sleep 600', run_in_background: true },
        })
        session._recordBackgroundShellsFromToolResults([
          {
            type: 'tool_result',
            tool_use_id: 'tu-bg-6',
            content: 'Command running in background with ID: bg-6-id. Output…',
          },
        ])
        // Simulate turn-end: _clearMessageState happens after `result`.
        session._isBusy = true
        session._clearMessageState()
        assert.equal(session._isBusy, false)
        // The waiting-on-background-work signal: isRunning stays true.
        assert.equal(session.isRunning, true)
        assert.equal(session._pendingBackgroundShells.size, 1)
      })

      it('clears the pending entry when the agent calls BashOutput with the matching bash_id', () => {
        const events = []
        // Set up a pending shell.
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-7',
          input: { command: 'sleep 600', run_in_background: true },
        })
        session._recordBackgroundShellsFromToolResults([
          {
            type: 'tool_result',
            tool_use_id: 'tu-bg-7',
            content: 'Command running in background with ID: shell-77. Output…',
          },
        ])
        session.on('background_work_changed', (e) => events.push(e))
        // Now the agent calls BashOutput on shell-77.
        session._handleToolUseBlock('msg-2', {
          name: 'BashOutput',
          id: 'tu-bo-1',
          input: { bash_id: 'shell-77' },
        })
        assert.equal(session._pendingBackgroundShells.size, 0)
        assert.equal(session.isRunning, false)
        assert.equal(events.length, 1)
        assert.equal(events[0].pending.length, 0)
      })

      it('destroy() clears the pending map (no leak)', () => {
        session._handleToolUseBlock('msg-1', {
          name: 'Bash',
          id: 'tu-bg-8',
          input: { command: 'sleep 600', run_in_background: true },
        })
        session._recordBackgroundShellsFromToolResults([
          {
            type: 'tool_result',
            tool_use_id: 'tu-bg-8',
            content: 'Command running in background with ID: shell-88. Output…',
          },
        ])
        assert.equal(session._pendingBackgroundShells.size, 1)
        session.destroy()
        assert.equal(session._pendingBackgroundShells.size, 0)
        // Re-create one for the afterEach destroy to not double-destroy.
        session = createSession()
      })
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

    it('ignores non-auto change when busy', () => {
      session._isBusy = true
      session.setPermissionMode('plan')
      assert.equal(session.permissionMode, 'approve')
    })

    it('applies auto mode change even when busy (panic button, #3729)', () => {
      // Pre-fix bug: setPermissionMode('auto') was silently rejected when
      // _isBusy=true, but settings-handlers.js still broadcast
      // permission_mode_changed, leaving the dashboard in an "auto" state
      // while the server kept emitting prompts under the old mode. Auto
      // is now the one mode that overrides the busy guard.
      session._isBusy = true
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'auto')
    })

    it('rejects invalid modes', () => {
      session.setPermissionMode('invalid')
      assert.equal(session.permissionMode, 'approve')
    })

    it('accepts acceptEdits mode', () => {
      session.setPermissionMode('acceptEdits')
      assert.equal(session.permissionMode, 'acceptEdits')
    })

    it('switching to auto auto-resolves pending permissions (#3729)', async () => {
      // Reproduce the user's "I flipped to auto and the prompt stayed
      // there" report: a prompt is pending under the previous mode, the
      // user flips to auto, the prompt should resolve as 'allow' instead
      // of sitting until the 5-min timeout.
      const pmgr = session._permissions
      const promise = pmgr.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      assert.equal(pmgr._pendingPermissions.size, 1)

      session.setPermissionMode('auto')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.equal(pmgr._pendingPermissions.size, 0)
    })

    it('switching to auto while busy drains pending prompts (#3729)', async () => {
      // The end-to-end scenario: SDK turn in progress (_isBusy=true), a
      // permission prompt is on screen, user clicks "Auto bypass". Both
      // the busy guard AND the pending-drain need to fire.
      const pmgr = session._permissions
      session._isBusy = true
      const promise = pmgr.handlePermission('Bash', { command: 'rm' }, null, 'approve')

      session.setPermissionMode('auto')

      assert.equal(session.permissionMode, 'auto')
      const result = await promise
      assert.equal(result.behavior, 'allow')
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
      assert.equal(session._outgoingQueue.length, 1)
      assert.equal(session._outgoingQueue[0].prompt, 'follow-up message')
    })

    it('clears pending queue on destroy', () => {
      session._isBusy = true
      session.sendMessage('queued')
      assert.equal(session._outgoingQueue.length, 1)
      session.destroy()
      assert.equal(session._outgoingQueue.length, 0)
    })

    // #5936: the SDK's old mid-turn cap of 3 (#5711) became the shared
    // OUTGOING_QUEUE_MAX (10) on BaseSession; overflow still surfaces a visible
    // `error` rather than a silent drop.
    it('caps the mid-turn queue at OUTGOING_QUEUE_MAX and discards overflow with an error (#5936)', () => {
      session._isBusy = true
      const errors = []
      session.on('error', (data) => errors.push(data))

      // Fill the queue to the cap (10).
      for (let i = 0; i < 10; i++) session.sendMessage(`q${i}`)
      assert.equal(session._outgoingQueue.length, 10)
      assert.equal(errors.length, 0)

      // The 11th overflows: discarded with a visible error, queue stays at 10.
      session.sendMessage('q-overflow')
      assert.equal(session._outgoingQueue.length, 10)
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /queue full \(max 10\)/)
      assert.equal(errors[0].code, 'queue_full')
      // The discarded message is NOT in the queue.
      assert.ok(!session._outgoingQueue.some((m) => m.prompt === 'q-overflow'))
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
      assert.equal(s._outgoingQueue.length, 3, 'precondition: three messages queued')

      // Flag flips mid-turn (e.g. SidecarProcess loses stdin while query is
      // still streaming). Now any new sendMessage must reject AND drain the
      // queue so the post-finally process.nextTick dequeue does not call
      // sendMessage three more times.
      s._stdinForwardingDisabled = true
      s._isBusy = false  // turn finished, would normally trigger dequeue

      await s.sendMessage('arriving while disabled')

      assert.equal(captured.length, 0, '_callQuery must not be invoked')
      assert.equal(s._outgoingQueue.length, 0, 'queued follow-ups must be drained')
      assert.equal(errors.length, 1, 'a single error event covers the drained batch + new call')
      assert.equal(errors[0].code, 'stdin_disabled')

      s.destroy()
    })

    // #3562: short-circuit dequeue in finally when stdin forwarding is disabled.
    //
    // PR #3560 (closes #3539) drains _outgoingQueue at the *entry* of sendMessage
    // when the flag is set. This handles the case "next caller hits the gate".
    // But the post-turn dequeue path in sendMessage's finally block still has
    // its own "shift + process.nextTick(sendMessage)" branch. If a turn is
    // mid-flight when the SidecarProcess emits stdin_disabled, the entry-gate
    // has already been passed, so the finally path will still schedule a
    // recursive sendMessage for the queued follow-up — wasting an event-loop
    // hop and a redundant function call before the entry gate finally rejects
    // it.
    //
    // The fix: short-circuit at the dequeue site too. If the flag flips
    // mid-turn, drain the queue, log a single warn, and skip the recursion.
    it('short-circuits dequeue in finally when flag flips mid-turn (#3562)', async () => {
      const s = createSession()
      s._processReady = true

      let callCount = 0
      s._callQuery = (_args) => {
        callCount++
        return (async function* () {
          // Simulate the SidecarProcess latching stdin_disabled mid-turn —
          // the flag flips while _callQuery is still streaming, before the
          // result event finishes the turn. The finally block runs after
          // this generator returns and must observe the flipped flag.
          s._stdinForwardingDisabled = true
          yield { type: 'result', session_id: 'mid-turn-flip', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }

      // Pre-queue a follow-up so the dequeue site has work to do.
      s._outgoingQueue = [{ prompt: 'queued-follow-up', attachments: undefined, sendOptions: {} }]

      const errors = []
      s.on('error', (e) => errors.push(e))

      await s.sendMessage('initial turn')

      // Wait one process.nextTick and one event-loop turn (setImmediate
      // schedules into the check phase) so the dequeue path has had the
      // opportunity to recurse, if it were going to.
      await new Promise((resolve) => process.nextTick(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      assert.equal(callCount, 1, '_callQuery must only be invoked for the original turn — no recursive dequeue')
      assert.equal(s._outgoingQueue.length, 0, 'queued follow-ups must be drained at the dequeue site')
      assert.equal(errors.length, 0, 'dequeue-site short-circuit must not emit a per-message error (the warn is enough)')

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
        s._outgoingQueue = [{ prompt: 'q1' }, { prompt: 'q2' }]
        await s.sendMessage('attempt 1')
        // Second refused call inside the window — re-queue and verify the
        // drain warn is suppressed alongside the refusal warn.
        s._outgoingQueue = [{ prompt: 'q3' }]
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
      assert.equal(s._outgoingQueue.length, 0,
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

  // -- thinking keyword escalation (#4306) --

  describe('thinking keyword escalation (#4306)', () => {
    // The native CLI's REPL scans user prompts for magic thinking keywords
    // ("think", "think hard", "think harder", "megathink", "ultrathink") and
    // escalates maxThinkingTokens for that turn. SdkSession's query() path
    // does NOT do this — the scanner lives in the REPL, not the SDK. These
    // tests assert that Chroxy detects the keyword server-side and bumps
    // maxThinkingTokens on the per-turn options object before the query
    // generator is invoked.
    function setupCapturingSession(opts = {}) {
      const s = createSession(opts)
      s._processReady = true
      const captured = []
      s._callQuery = (args) => {
        captured.push(args)
        return (async function* () {
          yield { type: 'result', session_id: 'test', total_cost_usd: 0, duration_ms: 0, usage: {} }
        })()
      }
      return { s, captured }
    }

    it('does NOT set maxThinkingTokens when no keyword present', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('please refactor this function')
      s.destroy()
      assert.equal(captured.length, 1)
      assert.equal(captured[0].options.maxThinkingTokens, undefined,
        'plain prompts must not bump the SDK thinking budget')
    })

    it('escalates to 4_000 for bare "think"', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('please think about this')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, 4_000)
    })

    it('escalates to 10_000 for "think hard"', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('think hard about edge cases')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, 10_000)
    })

    it('escalates to 32_000 for "think harder" (prefers over "think hard")', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('think harder please')
      s.destroy()
      // Without longest-match-first, this would fall through to `think hard`
      // (which is also a substring) and shortchange the user's intent.
      assert.equal(captured[0].options.maxThinkingTokens, 32_000)
    })

    it('escalates to 128_000 for "ultrathink"', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('ultrathink the architecture trade-offs')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, 128_000)
    })

    it('case-insensitive: ULTRATHINK still escalates', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('ULTRATHINK now')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, 128_000)
    })

    it('does NOT match `think` inside `unthinkingly` (word boundary)', async () => {
      const { s, captured } = setupCapturingSession()
      await s.sendMessage('I unthinkingly committed this')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, undefined,
        'substring matches must not trigger escalation — the user did not type a keyword')
    })

    // The dropdown-driven thinking level (#2263) and the per-turn keyword
    // escalation are layered: the keyword must never DOWNgrade an explicit
    // max-level session. Mirrors the native CLI's "more thinking, never less"
    // semantic — typing `think` on a session you already cranked to `max`
    // should leave it at max for that turn, not drop it to 4_000.
    it('keyword does NOT lower an already-elevated dropdown level', async () => {
      const { s, captured } = setupCapturingSession()
      s._thinkingLevel = 'max' // dropdown set to 128_000
      await s.sendMessage('please think about this')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, 128_000,
        'dropdown-level budget must win when it is higher than the keyword budget')
    })

    it('keyword DOES raise above the dropdown level when bigger', async () => {
      const { s, captured } = setupCapturingSession()
      s._thinkingLevel = 'high' // dropdown set to 32_000
      await s.sendMessage('ultrathink this one')
      s.destroy()
      assert.equal(captured[0].options.maxThinkingTokens, 128_000,
        'a stronger keyword must override a weaker dropdown level for the turn')
    })

    it('keyword escalation is per-turn and does NOT mutate the session-wide level', async () => {
      const { s, captured } = setupCapturingSession()
      // First turn: keyword present.
      await s.sendMessage('ultrathink this design')
      assert.equal(captured[0].options.maxThinkingTokens, 128_000)
      assert.equal(s._thinkingLevel, null, 'session-wide level must remain unchanged')

      // Second turn: no keyword — must drop back to no escalation.
      await s.sendMessage('now write the code')
      s.destroy()
      assert.equal(captured[1].options.maxThinkingTokens, undefined,
        'per-turn escalation must NOT bleed into subsequent turns without the keyword')
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
      const restored = createSession({ stdinForwardingDisabled: true })
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
      // but it exercises the public contract (early-return guard).
      await session.interrupt()

      assert.equal(session._stdinDroppedBytesTotal, bytesBefore,
        '_stdinDroppedBytesTotal must survive interrupt()')
      assert.equal(session._stdinDroppedCount, countBefore,
        '_stdinDroppedCount must survive interrupt()')
      assert.equal(session._stdinDroppedThresholdLogged, thresholdLoggedBefore,
        '_stdinDroppedThresholdLogged must survive interrupt()')
    })

    // The early-return test above only exercises `if (!this._query) return`.
    // This sibling test stubs an active query so we cover the more meaningful
    // active-query branch — counters must survive interrupt() even when it
    // actually tears the query down (#3565).
    it('preserves stdin_dropped counters across interrupt() with active query (#3565)', async () => {
      const { EventEmitter } = await import('events')
      const proc = new EventEmitter()
      session._attachSidecarProcessListeners(proc)

      proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })
      proc.emit('stdin_dropped', { bytes: 60, reason: 'pre-dial-cap' })

      const bytesBefore = session._stdinDroppedBytesTotal
      const countBefore = session._stdinDroppedCount
      const thresholdLoggedBefore = session._stdinDroppedThresholdLogged

      // Stub `_callQuery` to return a long-running async iterable so the
      // active-query branch of interrupt() is exercised. The iterable hangs
      // on next() until `interrupt()` is called, which resolves a pending
      // gate so the iterator can return cleanly.
      //
      // Async gate (#3596): the stubbed interrupt() yields past a
      // setImmediate boundary BEFORE flipping `interruptCalled`. If
      // SdkSession.interrupt() ever drops the `await` on _query.interrupt(),
      // control returns from `await session.interrupt()` before the gate
      // resolves and the assertion below fails — locking down the await
      // contract regression-style.
      let interruptCalled = false
      let resolveGate
      const gate = new Promise((resolve) => { resolveGate = resolve })
      const longRunningQuery = {
        [Symbol.asyncIterator]() { return this },
        async next() {
          await gate
          return { value: undefined, done: true }
        },
        async interrupt() {
          // Defer flag set past a macrotask boundary (setImmediate) so a
          // missing `await` in SdkSession.interrupt() leaves
          // `interruptCalled` false at the assertion site. A bare
          // `await Promise.resolve()` is not strict enough — both async
          // function returns and the awaited query promise drain
          // microtasks in FIFO order, so a single microtask gate would
          // still resolve before the outer await of session.interrupt()
          // returns control. setImmediate forces a full event-loop turn,
          // which only happens if SdkSession.interrupt() actually awaits
          // the returned promise.
          await new Promise((resolve) => setImmediate(resolve))
          interruptCalled = true
          resolveGate()
        },
      }
      session._query = longRunningQuery

      // Kick off iteration so the query is "mid-stream" when interrupt fires.
      const iterationPromise = (async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of session._query) { /* drain */ }
      })()

      await session.interrupt()

      // Snapshot the flag immediately after the await resolves — this is
      // the strict assertion that proves SdkSession.interrupt() awaited the
      // query interrupt promise (the microtask gate above must have run).
      const interruptCalledAfterAwait = interruptCalled

      await iterationPromise

      assert.equal(interruptCalledAfterAwait, true,
        'SdkSession.interrupt() must await query.interrupt() (microtask gate, active-query branch)')
      assert.equal(interruptCalled, true,
        'active query interrupt() must be awaited (active-query branch)')
      assert.equal(session._stdinDroppedBytesTotal, bytesBefore,
        '_stdinDroppedBytesTotal must survive active-query interrupt()')
      assert.equal(session._stdinDroppedCount, countBefore,
        '_stdinDroppedCount must survive active-query interrupt()')
      assert.equal(session._stdinDroppedThresholdLogged, thresholdLoggedBefore,
        '_stdinDroppedThresholdLogged must survive active-query interrupt()')
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

  // #4467: stream-stall recovery — SDK sibling of the CLI watchdog
  // (already shipped in cli-session.js via #4475). The SDK path was
  // missing the third timer, so a half-open HTTPS connection to the
  // Anthropic API would leave the session at "Thinking…" until the user
  // clicked Stop. These tests pin the unit behaviour of the handler
  // itself; the arm/reset/pause integration tests live in
  // sdk-session-timeout-pause.test.js alongside the soft+hard suite.
  describe('SdkSession._handleStreamStall (#4467: stream-stall recovery)', () => {
    it('emits stream_end + error{code:stream_stall} so dashboard can offer retry', () => {
      const s = createSession({ streamStallTimeoutMs: 60_000 })
      s._isBusy = true
      s._currentMessageId = 'msg_ss'
      s._sessionId = 'sess_ss'

      const events = []
      s.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
      s.on('error', (p) => events.push({ name: 'error', payload: p }))

      s._handleStreamStall('msg_ss', true)

      assert.deepEqual(events.map((e) => e.name), ['stream_end', 'error'])
      assert.equal(events[0].payload.messageId, 'msg_ss')
      assert.equal(events[1].payload.code, 'stream_stall',
        'error MUST carry code:stream_stall so dashboard can distinguish from generic errors')
      assert.match(events[1].payload.message, /stalled/i)
      assert.equal(s._isBusy, false,
        'busy state must clear so the user can retry from the same session')
      s.destroy()
    })

    it('does NOT emit stream_end when the stream had not yet started', () => {
      const s = createSession({ streamStallTimeoutMs: 60_000 })
      s._isBusy = true
      s._currentMessageId = 'msg_ss'

      const events = []
      s.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
      s.on('error', (p) => events.push({ name: 'error', payload: p }))

      s._handleStreamStall('msg_ss', false)

      assert.deepEqual(events.map((e) => e.name), ['error'])
      assert.equal(events[0].payload.code, 'stream_stall')
      s.destroy()
    })

    it('no-ops when not busy (timer fired against an idle session)', () => {
      const s = createSession()
      s._isBusy = false

      const events = []
      s.on('stream_end', () => events.push('stream_end'))
      s.on('error', () => events.push('error'))

      s._handleStreamStall('msg_x', true)
      assert.deepEqual(events, [])
      s.destroy()
    })

    it('emits synthetic `result` so event-normalizer fans to agent_idle → activeTools clear (#4616)', () => {
      // #4616 — without the synthetic `result` event, the dashboard's
      // activeTools entries linger after a stream stall: the event-
      // normalizer only synthesizes `agent_idle` from `result` (see
      // event-normalizer.js:253), and store-core handleAgentIdle clears
      // `activeTools: []` as the #4308 safety net. CLI does the same via
      // _emitInterruptedTurnResult (stream_end + result). Pre-#4616 the
      // SDK was missing the `result` half of the pair, so its footer
      // pill never cleared after a stall.
      const s = createSession({ streamStallTimeoutMs: 60_000 })
      s._isBusy = true
      s._currentMessageId = 'msg_ss'
      s._sessionId = 'sess_ss'
      s._sdkSessionId = 'sess_ss'

      const events = []
      s.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
      s.on('result', (p) => events.push({ name: 'result', payload: p }))
      s.on('error', (p) => events.push({ name: 'error', payload: p }))

      s._handleStreamStall('msg_ss', true)

      assert.deepEqual(events.map((e) => e.name), ['stream_end', 'result', 'error'],
        'order is stream_end → result → error so agent_idle lands before the toast')

      const resultEvent = events[1].payload
      assert.equal(resultEvent.cost, null,
        'cost MUST be null so session-manager skips billing accumulation on a stalled turn')
      assert.equal(resultEvent.usage, null,
        'usage MUST be null on a stalled turn — no real assistant response was produced')
      assert.equal(resultEvent.sessionId, 'sess_ss',
        'sessionId snapshotted before _clearMessageState so the synthetic result is correctly identified')
      assert.equal(typeof resultEvent.duration, 'number',
        'duration carries the stall timeout so the dashboard can render an approximate turn time')

      assert.equal(events[2].payload.code, 'stream_stall',
        'error still carries the structured code for the dashboard stall chip')
      s.destroy()
    })
  })
})

// ---------------------------------------------------------------------------
// #4700 — Session-state persistence roundtrip.
//
// SdkSession does not own a `saveSessionState()` / `restoreSessionState()`
// pair directly — the persistence layer lives on `SessionManager` /
// `SessionStatePersistence`, which serializes session metadata (model,
// permissionMode, sdkSessionId, stdinForwardingDisabled, …) to JSON. The
// roundtrip tested here is the JSON shape contract on each side of that
// boundary:
//
//   1. Snapshot the session metadata SessionManager would persist.
//   2. JSON-stringify it to a temp `stateFilePath` (atomic write contract).
//   3. Parse it back.
//   4. Reconstruct a fresh SdkSession with the restored opts.
//   5. Assert every persisted field round-tripped exactly.
//
// The audit (#4700) flagged this as the missing layer: SessionManager-level
// restore tests already cover the persistence path end-to-end (see
// session-manager.test.js), but a regression on the SDK side — a field
// that survives restore in shape but no longer hydrates into the
// constructor — would only show up in integration tests, not at the
// unit layer.
//
// The corrupt-file + mismatched-id branches mirror the same patterns
// covered in session-manager.test.js for symmetry. The Map-serialization
// branch pins the JSON gotcha that #4687 surfaced for the analogous
// claude-tui-session `_pendingUserAnswers` field: a naive
// `JSON.stringify(new Map(…))` silently emits `{}` and loses every
// entry — the canonical workaround is `[...map.entries()]`. The test
// fails on any future SDK code that tries to persist a Map field
// directly.
// ---------------------------------------------------------------------------

describe('SdkSession state-persistence roundtrip (#4700)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sdk-roundtrip-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Snapshot the fields SessionManager.serializeState() would write for an
  // SdkSession entry. Mirrors the shape pinned in session-manager.test.js
  // (`stdinForwardingDisabled`, `sdkSessionId`, `model`, `permissionMode`,
  // `name`, `cwd`) — keep these two in sync.
  function snapshotForPersistence(session, { name, cwd }) {
    return {
      name,
      cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      sdkSessionId: session.resumeSessionId,
      stdinForwardingDisabled: !!session._stdinForwardingDisabled,
    }
  }

  it('happy path: create → snapshot → write → read → restore → asserts metadata equality', () => {
    // Step 1: build a session with non-default metadata so the restore
    // side has to actually hydrate every field. `_sdkSessionId` is the
    // SDK resume key — restored sessions feed it back into `resume`.
    const original = createSession({
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      stdinForwardingDisabled: true,
    })
    original._sdkSessionId = 'sdk-resume-abc-123'

    // Step 2: snapshot + write atomically (mirrors SessionStatePersistence
    // tmp + rename, simplified to a single write since the test owns the
    // file lifecycle).
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [snapshotForPersistence(original, { name: 'Restored', cwd: '/tmp' })],
    }
    writeFileSync(stateFile, JSON.stringify(state))
    assert.ok(existsSync(stateFile), 'state file must exist after write')

    // Step 3: destroy the original — restoration is the only path that
    // recovers the metadata from disk.
    original.destroy()

    // Step 4: read back and reconstruct.
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.sessions.length, 1)
    const persisted = parsed.sessions[0]

    const restored = createSession({
      model: persisted.model,
      permissionMode: persisted.permissionMode,
      resumeSessionId: persisted.sdkSessionId,
      stdinForwardingDisabled: persisted.stdinForwardingDisabled,
    })

    // Step 5: every field that mattered to the user is back.
    assert.equal(restored.model, 'claude-sonnet-4-6',
      'model must round-trip — dashboard renders this on the session header')
    assert.equal(restored.permissionMode, 'auto',
      'permissionMode must round-trip — controls every canUseTool prompt')
    assert.equal(restored.resumeSessionId, 'sdk-resume-abc-123',
      'SDK resume key must round-trip — without it the restored session starts a new conversation')
    assert.equal(restored._stdinForwardingDisabled, true,
      'stdin_disabled latch must round-trip — restored sessions surface the disabled state immediately (#3540)')

    restored.destroy()
  })

  it('corrupt state file: production restoreState must return null silently, not throw', () => {
    // A truncated / hand-edited / partial-write state file must not take
    // the server down. Pin the PRODUCTION contract: drive the real
    // `SessionStatePersistence.restoreState()` (the entry point
    // `SessionManager.restoreState()` calls — see session-manager.js:1266)
    // and assert it returns `null` without throwing. The internal
    // try/catch in session-state-persistence.js:148-170 swallows the
    // SyntaxError, attempts .bak recovery, and falls back to null when
    // no backup exists — supervisor / dashboard depend on that silent
    // behaviour so a corrupt state file cannot block server boot.
    writeFileSync(stateFile, '{ this is not valid json')

    const persistence = new SessionStatePersistence({ stateFilePath: stateFile })
    let restored
    let threw = null
    try {
      restored = persistence.restoreState()
    } catch (err) {
      threw = err
    }

    assert.equal(threw, null,
      'restoreState() MUST NOT throw on corrupt JSON — supervisor depends on the silent-null contract; ' +
      'a throw here would crash the server on every restart after a partial write')
    assert.equal(restored, null,
      'restoreState() must return null on corrupt JSON so SessionManager treats it as "no prior state" and starts fresh')

    // Secondary assertion documenting the underlying mechanism: the raw
    // JSON.parse used inside restoreState() does throw a SyntaxError —
    // that's why restoreState() wraps it in try/catch. The corrupt file
    // was unlinked by restoreState's recovery path, so we re-write it
    // here to pin the raw behaviour.
    writeFileSync(stateFile, '{ this is not valid json')
    let rawThrew = null
    try { JSON.parse(readFileSync(stateFile, 'utf-8')) } catch (err) { rawThrew = err }
    assert.ok(rawThrew instanceof SyntaxError,
      'raw JSON.parse throws SyntaxError — restoreState() exists specifically to swallow this')

    // The fallback path: instantiate a fresh SdkSession with no restored
    // opts. Must succeed — a corrupt state file cannot block new session
    // creation.
    const fresh = createSession()
    assert.equal(fresh._sdkSessionId, null,
      'fresh session after corrupt-file restore must have no SDK resume id')
    assert.equal(fresh._stdinForwardingDisabled, false,
      'fresh session must start with stdin latch off — no carryover from corrupt state')
    fresh.destroy()
  })

  it('mismatched session id: persisted resumeSessionId is silently ignored when the restoring caller does not forward it', () => {
    // Operator hand-edits the state file (or schema drift, or a partial
    // write that produced a half-valid entry): the file contains a
    // resumeSessionId but the caller chooses not to plumb it through
    // (e.g. because the SDK key no longer maps to a live conversation).
    // The constructor must accept the choice without throwing or
    // silently re-instating the stale id.
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [{
        name: 'Stale',
        cwd: '/tmp',
        model: null,
        permissionMode: 'approve',
        sdkSessionId: 'sdk-resume-stale-9999',
        stdinForwardingDisabled: false,
      }],
    }
    writeFileSync(stateFile, JSON.stringify(state))

    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const persisted = parsed.sessions[0]
    assert.equal(persisted.sdkSessionId, 'sdk-resume-stale-9999',
      'precondition: state file carries the stale id')

    // Caller decides NOT to forward the resumeSessionId (mismatch — the
    // id no longer corresponds to a valid SDK conversation on the
    // upstream). The fresh session must start clean.
    const fresh = createSession({
      model: persisted.model,
      permissionMode: persisted.permissionMode,
      // resumeSessionId intentionally omitted
    })

    assert.equal(fresh._sdkSessionId, null,
      'session must not silently adopt a stale persisted SDK resume id — caller controls forwarding')
    assert.equal(fresh.resumeSessionId, null,
      'public accessor must also report null when no resume id was forwarded')

    fresh.destroy()
  })

  // #4700 — Map-serialization contract. PR #4687 changed
  // `_pendingUserAnswers` on claude-tui-session.js from a single field to
  // a Map keyed by toolUseId. This test pins the canonical JSON
  // workaround for ANY Map field that a future SdkSession (or any
  // BaseSession descendant) might want to persist. The naive write
  // (`JSON.stringify(new Map(…))`) silently emits `{}` and loses every
  // entry — a regression that would not be caught by any existing
  // serialize/restore test because the Map's *type* is lost before the
  // disk hop, so the restored "Map" is an empty `{}` and round-trip
  // assertions pass on shape but fail in semantics.
  it('Map field serialization roundtrip: pins the entries-array contract (#4687 surface)', () => {
    // Build a Map with the same shape as `_pendingUserAnswers`: keyed by
    // tool_use_id, values are per-turn pending entries.
    const pending = new Map()
    pending.set('toolu_first', { questions: [{ question: 'Q1?' }], options: ['A', 'B'] })
    pending.set('toolu_second', { questions: [{ question: 'Q2?' }], options: ['Y', 'N'] })

    // The trap: naive Map serialization loses every entry. This
    // assertion documents the gotcha so a future contributor who writes
    // `JSON.stringify(session._someMap)` sees this test and remembers
    // to convert to an array first.
    assert.equal(JSON.stringify(pending), '{}',
      'NAIVE Map.toJSON is {} — every entry is silently lost. ' +
      'Any persistence of a Map field MUST use [...map.entries()] (see workaround below)')

    // The canonical workaround: serialize as an array of entries so the
    // restore side can feed `new Map(parsed)` and recover every key.
    const serialized = JSON.stringify([...pending.entries()])
    writeFileSync(stateFile, serialized)

    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const restored = new Map(parsed)

    assert.equal(restored.size, 2,
      'entries-array roundtrip must preserve every key')
    assert.ok(restored.has('toolu_first'),
      'first toolUseId key must survive — sibling pending answers from parallel AskUserQuestion blocks (#4668) depend on this')
    assert.ok(restored.has('toolu_second'),
      'second toolUseId key must survive — the bug #4687 fixed was the single-field overwrite')
    assert.deepEqual(restored.get('toolu_first').questions, [{ question: 'Q1?' }])
    assert.deepEqual(restored.get('toolu_second').options, ['Y', 'N'])

    // Symmetry assertion: the restored Map iterates in the same order
    // as the original. JSON arrays preserve insertion order, so this
    // pins the contract that "most-recent" fallback semantics (see
    // claude-tui-session.js `_lastPendingAnswerToolUseId`) survive a
    // restart.
    assert.deepEqual([...restored.keys()], ['toolu_first', 'toolu_second'],
      'Map insertion order must round-trip so "most-recent" semantics survive a restart')
  })
})

// #6692 — per-model usage forwarding: the result payload must surface the
// SDK's modelUsage split (normalized to snake_case) plus num_turns /
// duration_api_ms instead of discarding them.
describe('per-model usage forwarding (#6692)', () => {
  it('forwards normalized modelUsage + numTurns + apiDurationMs on result', async () => {
    const s = createSession()
    s._processReady = true
    const results = []
    s.on('result', (r) => results.push(r))
    s._callQuery = () => {
      return (async function* () {
        yield {
          type: 'result',
          session_id: 'usage-test',
          total_cost_usd: 0.05,
          duration_ms: 1234,
          duration_api_ms: 987,
          num_turns: 3,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: {
            'claude-opus-4-8': {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadInputTokens: 25,
              cacheCreationInputTokens: 5,
              webSearchRequests: 0,
              costUSD: 0.05,
              contextWindow: 200000,
            },
          },
        }
      })()
    }
    await s.sendMessage('hello')
    assert.equal(results.length, 1)
    const r = results[0]
    assert.equal(r.numTurns, 3)
    assert.equal(r.apiDurationMs, 987)
    assert.deepEqual(r.modelUsage, {
      'claude-opus-4-8': {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 5,
        web_search_requests: 0,
        cost_usd: 0.05,
      },
    })
    s.destroy()
  })

  it('degrades numTurns/apiDurationMs/modelUsage to null when the result omits them', async () => {
    const s = createSession()
    s._processReady = true
    const results = []
    s.on('result', (r) => results.push(r))
    s._callQuery = () => {
      return (async function* () {
        yield {
          type: 'result',
          session_id: 'usage-test-2',
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        }
      })()
    }
    await s.sendMessage('hello')
    assert.equal(results.length, 1)
    assert.equal(results[0].numTurns, null)
    assert.equal(results[0].apiDurationMs, null)
    assert.equal(results[0].modelUsage, null)
    s.destroy()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// #6766 — conversation fork boundary + fork wrapper. These make checkpoint
// "Rewind" actually branch the conversation truncated to the checkpoint (for the
// SDK provider) rather than resuming the full latest transcript.
// ──────────────────────────────────────────────────────────────────────────────

describe('SdkSession conversation fork (#6766)', () => {
  it('captures the latest assistant transcript uuid as the fork boundary during a turn', async () => {
    const s = createSession()
    s._processReady = true
    assert.equal(s.lastMessageUuid, null, 'null before any turn')
    s._callQuery = () => (async function* () {
      yield { type: 'assistant', uuid: 'asst-1', message: { content: [{ type: 'text', text: 'hi' }] } }
      yield { type: 'assistant', uuid: 'asst-2', message: { content: [{ type: 'text', text: 'more' }] } }
      yield { type: 'result', session_id: 'conv-x', total_cost_usd: 0, duration_ms: 1, usage: {} }
    })()
    await s.sendMessage('hello')
    assert.equal(s.lastMessageUuid, 'asst-2', 'boundary tracks the latest assistant message of the turn')
    s.destroy()
  })

  it('_captureBoundaryMessage ignores messages without a string uuid', () => {
    const s = createSession()
    s._captureBoundaryMessage({ uuid: 'm-1' })
    assert.equal(s.lastMessageUuid, 'm-1')
    s._captureBoundaryMessage({}) // no uuid — keep previous
    assert.equal(s.lastMessageUuid, 'm-1')
    s._captureBoundaryMessage({ uuid: 42 }) // non-string — keep previous
    assert.equal(s.lastMessageUuid, 'm-1')
    s._captureBoundaryMessage({ uuid: 'm-2' })
    assert.equal(s.lastMessageUuid, 'm-2')
    s.destroy()
  })

  it('supportsConversationFork is true for the SDK provider', () => {
    const s = createSession()
    assert.equal(s.supportsConversationFork, true)
    s.destroy()
  })

  it('forkConversation wraps the SDK forkSession with the boundary + project dir', async () => {
    const s = createSession({ cwd: '/repo' })
    const calls = []
    s._forkSessionImpl = async (id, opts) => { calls.push([id, opts]); return { sessionId: 'forked-xyz' } }
    const forked = await s.forkConversation({ sessionId: 'conv-1', upToMessageId: 'm-2' })
    assert.equal(forked, 'forked-xyz')
    assert.deepEqual(calls, [['conv-1', { upToMessageId: 'm-2', dir: '/repo' }]])
    s.destroy()
  })

  it('forkConversation defaults the source to the live session and returns null when the SDK gives no id', async () => {
    const s = createSession({ cwd: '/repo' })
    s._sdkSessionId = 'live-conv'
    let seen = null
    s._forkSessionImpl = async (id) => { seen = id; return {} } // no sessionId
    const forked = await s.forkConversation({ upToMessageId: 'm-9' })
    assert.equal(seen, 'live-conv', 'defaults to the live SDK session id')
    assert.equal(forked, null)
    s.destroy()
  })

  it('forkConversation throws when there is no source conversation', async () => {
    const s = createSession()
    s._sdkSessionId = null
    await assert.rejects(() => s.forkConversation({}), /no source session id/)
    s.destroy()
  })
})
