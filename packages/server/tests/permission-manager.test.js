import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PermissionManager, wirePermissionManager, ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../src/permission-manager.js'

/**
 * Tests for PermissionManager — permission request lifecycle,
 * question handling, timeouts, abort signals, and cleanup.
 */

const silentLog = { info() {}, warn() {} }

function createManager(opts = {}) {
  return new PermissionManager({ log: silentLog, ...opts })
}

describe('PermissionManager', () => {
  let pm

  beforeEach(() => {
    pm = createManager()
  })

  afterEach(() => {
    pm.destroy()
  })

  // -- Permission requests --

  // #5121: requestIds must be globally unique across sessions so the
  // parent-level subagent routing table (byok-session.js) can never alias
  // a parent's own pending requestId against a child's. Each manager mints
  // a per-instance nonce; the id is opaque to all consumers.
  describe('requestId global uniqueness (#5121)', () => {
    it('two managers do not mint the same requestId even with identical counters', () => {
      const a = createManager()
      const b = createManager()
      try {
        const aEvents = []
        const bEvents = []
        a.on('permission_request', (d) => aEvents.push(d))
        b.on('permission_request', (d) => bEvents.push(d))

        // Same tool/input/counter position in each manager — only the
        // per-instance nonce keeps the ids apart.
        a.handlePermission('Bash', { command: 'ls' }, null, 'approve')
        b.handlePermission('Bash', { command: 'ls' }, null, 'approve')

        assert.ok(aEvents[0].requestId)
        assert.ok(bEvents[0].requestId)
        assert.notEqual(aEvents[0].requestId, bEvents[0].requestId)
        assert.match(aEvents[0].requestId, /^perm-/)
        assert.match(bEvents[0].requestId, /^perm-/)
      } finally {
        a.destroy()
        b.destroy()
      }
    })

    it('a single manager mints distinct requestIds with a stable nonce', () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.handlePermission('Bash', { command: 'pwd' }, null, 'approve')

      assert.notEqual(events[0].requestId, events[1].requestId)
      // Both ids share this manager's nonce, proving the nonce is
      // per-instance, not per-request. Extract it by stripping the `perm-`
      // prefix and the trailing `-<counter>-<ms>` rather than indexing a
      // fixed segment, so the assertion stays valid if the nonce format
      // changes (it remains opaque to consumers either way).
      const nonceOf = (id) => id.replace(/^perm-/, '').replace(/-\d+-\d+$/, '')
      assert.equal(nonceOf(events[0].requestId), nonceOf(events[1].requestId))
    })
  })

  describe('handlePermission', () => {
    it('emits permission_request and creates entry in pending map', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      assert.ok(events[0].requestId)
      assert.equal(events[0].description, 'ls')
      assert.ok(pm._pendingPermissions.has(events[0].requestId))
      assert.ok(pm._lastPermissionData.has(events[0].requestId))
    })

    it('resolves with allow on respondToPermission', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.respondToPermission(events[0].requestId, 'allow')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { command: 'ls' })
    })

    it('resolves with deny on respondToPermission', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Write', { file_path: '/x' }, null, 'approve')
      pm.respondToPermission(events[0].requestId, 'deny')

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(result.message, 'User denied')
    })

    it('resolves allowAlways as SDK-compliant behavior:allow (no suggestions — 2026-04-11 audit Skeptic finding)', async () => {
      // Pre-audit bug: respondToPermission('allowAlways') resolved with
      // { behavior: 'allowAlways' }, which is NOT a valid SDK
      // PermissionResult.behavior — the Agent SDK type only accepts
      // 'allow'|'deny'. The SDK silently coerced or dropped it, and the
      // user-facing 'Allow Always' button effectively did nothing more
      // than a plain 'Allow'.
      //
      // Post-fix: the result shape must be { behavior: 'allow',
      // updatedInput, updatedPermissions?: [suggestions from canUseTool] }.
      // When no suggestions were provided by the SDK callback, the
      // result has no updatedPermissions field.
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      // No suggestions provided — `handlePermission` called WITHOUT the
      // optional `suggestions` argument, simulating an older SDK release
      // or a tool that doesn't produce allow-always suggestions.
      const promise = pm.handlePermission('Bash', { command: 'npm test' }, null, 'approve')
      const requestId = events[0].requestId
      assert.ok(pm._permissionTimers.has(requestId))

      pm.respondToPermission(requestId, 'allowAlways')

      const result = await promise
      assert.equal(result.behavior, 'allow', "behavior must be the SDK-valid 'allow', not 'allowAlways'")
      assert.deepEqual(result.updatedInput, { command: 'npm test' })
      assert.equal(result.updatedPermissions, undefined,
        'no updatedPermissions when the SDK did not provide suggestions')
      assert.ok(!pm._pendingPermissions.has(requestId))
      assert.ok(!pm._permissionTimers.has(requestId))
    })

    it('resolves allowAlways with updatedPermissions when suggestions are available', async () => {
      // When the SDK canUseTool callback provides suggestions (e.g. the
      // pre-built rule to persist 'always allow Read on /project'),
      // respondToPermission('allowAlways') must echo them back via
      // updatedPermissions so the rule becomes a session-wide permission.
      // This is the 'Always allow' flow the SDK type actually supports.
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const suggestions = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Read', ruleContent: '/project/**' }],
          behavior: 'allow',
          destination: 'session',
        },
      ]
      const promise = pm.handlePermission('Read', { path: '/project/file.txt' }, null, 'approve', suggestions)
      const requestId = events[0].requestId

      pm.respondToPermission(requestId, 'allowAlways')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { path: '/project/file.txt' })
      assert.deepEqual(result.updatedPermissions, suggestions,
        "allowAlways must echo the SDK's suggestions via updatedPermissions")
    })

    it('cleans up pending map and timer on response', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Read', {}, null, 'approve')
      const requestId = events[0].requestId
      assert.ok(pm._pendingPermissions.has(requestId))
      assert.ok(pm._permissionTimers.has(requestId))
      assert.ok(pm._lastPermissionData.has(requestId))

      pm.respondToPermission(requestId, 'allow')
      assert.ok(!pm._pendingPermissions.has(requestId))
      assert.ok(!pm._permissionTimers.has(requestId))
      assert.ok(!pm._lastPermissionData.has(requestId))
    })

    // #3048: every resolution path must emit a uniform { requestId, decision, reason }
    // payload so the unified broadcast pipeline (PermissionManager → SdkSession
    // → ws-forwarding) can fan out without path-specific branches.
    it('emits unified permission_resolved payload from respondToPermission (#3048)', async () => {
      const events = []
      pm.on('permission_resolved', (data) => events.push(data))

      const promise = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      const requestId = Array.from(pm._pendingPermissions.keys())[0]
      pm.respondToPermission(requestId, 'allow')
      await promise

      assert.equal(events.length, 1)
      assert.deepStrictEqual(events[0], { requestId, decision: 'allow', reason: 'user' })
    })

    it('emits unified permission_resolved payload on timeout (#3048)', async () => {
      const fastPm = createManager({ timeoutMs: 5 })
      const events = []
      fastPm.on('permission_resolved', (data) => events.push(data))

      const promise = fastPm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      const requestId = Array.from(fastPm._pendingPermissions.keys())[0]
      const result = await promise

      assert.equal(result.behavior, 'deny')
      assert.equal(events.length, 1)
      assert.deepStrictEqual(events[0], { requestId, decision: 'deny', reason: 'timeout' })
      fastPm.destroy()
    })

    it('emits unified permission_resolved payload on abort (#3048)', async () => {
      const events = []
      pm.on('permission_resolved', (data) => events.push(data))

      const controller = new AbortController()
      const promise = pm.handlePermission('Bash', { command: 'ls' }, controller.signal, 'approve')
      const requestId = Array.from(pm._pendingPermissions.keys())[0]
      controller.abort()
      const result = await promise

      assert.equal(result.behavior, 'deny')
      assert.equal(events.length, 1)
      assert.deepStrictEqual(events[0], { requestId, decision: 'deny', reason: 'aborted' })
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = pm.handlePermission('Bash', {}, controller.signal, 'approve')
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.ok(result.message.includes('cancelled') || result.message.includes('Cancelled'))
    })

    it('warns on unknown requestId', () => {
      // Should not throw
      pm.respondToPermission('nonexistent', 'allow')
    })

    it('uses tool name as description when input is empty', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Bash', {}, null, 'approve')
      assert.equal(events[0].description, 'Bash')
    })

    it('uses file_path as description', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Read', { file_path: '/tmp/foo.txt' }, null, 'approve')
      assert.equal(events[0].description, '/tmp/foo.txt')
    })

    it('generates unique request IDs', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Bash', {}, null, 'approve')
      pm.handlePermission('Read', {}, null, 'approve')

      assert.notEqual(events[0].requestId, events[1].requestId)
    })
  })

  // -- acceptEdits mode --

  describe('acceptEdits permission mode', () => {
    it('auto-approves file operation tools', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const result = await pm.handlePermission('Read', { file_path: '/tmp/x' }, null, 'acceptEdits')
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 0, 'Should NOT emit permission_request for file ops')
    })

    it('auto-approves all ACCEPT_EDITS_TOOLS', async () => {
      const tools = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']

      for (const tool of tools) {
        const result = await pm.handlePermission(tool, {}, null, 'acceptEdits')
        assert.equal(result.behavior, 'allow', `${tool} should be auto-approved`)
      }
    })

    it('still prompts for Bash tool', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Bash', { command: 'rm -rf /' }, null, 'acceptEdits')
      assert.equal(events.length, 1, 'Should emit permission_request for Bash')
      assert.equal(events[0].tool, 'Bash')

      pm.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })

    it('still prompts for WebFetch tool', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('WebFetch', { url: 'https://example.com' }, null, 'acceptEdits')
      assert.equal(events.length, 1, 'Should emit permission_request for WebFetch')

      pm.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    })
  })

  // -- auto (bypass) mode --

  describe('auto permission mode (#3729)', () => {
    it('auto-allows tools that would otherwise prompt', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const result = await pm.handlePermission('Bash', { command: 'rm -rf /tmp/x' }, null, 'auto')
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { command: 'rm -rf /tmp/x' })
      assert.equal(events.length, 0, 'auto mode must not emit permission_request')
    })

    it('auto mode bypasses session deny rules (panic-button overrides everything)', async () => {
      // Pre-fix: rule lookup ran BEFORE any auto-mode check, so a deny
      // rule would still block tools after the user flipped to bypass.
      // The fix puts the auto-mode short-circuit first.
      pm.setRules([{ tool: 'Read', decision: 'deny' }])
      const result = await pm.handlePermission('Read', { file_path: '/x' }, null, 'auto')
      assert.equal(result.behavior, 'allow')
    })

    it('AskUserQuestion still routes to user_question even in auto mode', async () => {
      // AskUserQuestion is solicited user input, not a permission gate —
      // auto mode must NOT auto-answer it. Otherwise the model gets a
      // bogus 'allow' instead of the user's actual answer.
      const events = []
      pm.on('user_question', (data) => events.push(data))

      const promise = pm.handlePermission('AskUserQuestion', { questions: [{ question: 'pick one' }] }, null, 'auto')
      assert.equal(events.length, 1, 'should still emit user_question in auto mode')

      pm.respondToQuestion('blue')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })

    it('autoAllowPending() resolves all pending prompts as allow', async () => {
      // Simulates the panic-button: prompts emitted under the previous
      // mode are sitting open when the user flips to auto. They should
      // resolve immediately rather than time out at 5min.
      const promiseA = pm.handlePermission('Bash', { command: 'a' }, null, 'approve')
      const promiseB = pm.handlePermission('Bash', { command: 'b' }, null, 'approve')
      assert.equal(pm._pendingPermissions.size, 2)

      const resolvedEvents = []
      pm.on('permission_resolved', (e) => resolvedEvents.push(e))

      pm.autoAllowPending()

      const [resA, resB] = await Promise.all([promiseA, promiseB])
      assert.equal(resA.behavior, 'allow')
      assert.equal(resB.behavior, 'allow')
      assert.equal(pm._pendingPermissions.size, 0, 'pending map drained')
      assert.equal(resolvedEvents.length, 2)
      assert.ok(resolvedEvents.every(e => e.reason === 'auto_mode'))
    })

    it('autoAllowPending() is a safe no-op when nothing is pending', () => {
      // Defensive — switching to auto with an idle session must not throw.
      assert.doesNotThrow(() => pm.autoAllowPending())
    })

    it('autoAllowPending() denies pending MCP trust prompts to avoid silent persist (#4462)', async () => {
      // A pending requestMcpTrust prompt persists trust forever on
      // allow via byok-mcp-fleet's recordTrust path. Auto-mode bypass
      // is "approve everything for THIS turn" semantics — granting
      // forever-trust via a panic-button click changes the security
      // contract. autoAllowPending must resolve mcp_spawn entries as
      // deny so the trust store stays untouched.
      const trustPromise = pm.requestMcpTrust({
        name: 'evilmcp',
        command: '/usr/bin/curl',
        args: ['http://evil.example.com'],
        envKeys: [],
      })
      assert.equal(pm._pendingPermissions.size, 1)

      const resolvedEvents = []
      pm.on('permission_resolved', (e) => resolvedEvents.push(e))

      pm.autoAllowPending()

      const allowed = await trustPromise
      assert.equal(allowed, false, 'auto-mode bypass must NOT grant MCP trust')
      assert.equal(pm._pendingPermissions.size, 0)
      assert.equal(resolvedEvents.length, 1)
      assert.equal(resolvedEvents[0].decision, 'deny')
      assert.match(resolvedEvents[0].reason, /mcp_trust/)
    })

    it('autoAllowPending() handles mixed pending: allows tool prompts, denies MCP trust (#4462)', async () => {
      // Mixed-pending scenario: a Bash prompt and an MCP trust prompt
      // are both open when auto fires. Bash gets the allow (panic-button
      // semantics), MCP trust gets the deny (no forever-trust via bypass).
      const bashPromise = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      const trustPromise = pm.requestMcpTrust({
        name: 'mcp1',
        command: 'node',
        args: ['mcp.js'],
        envKeys: [],
      })
      assert.equal(pm._pendingPermissions.size, 2)

      pm.autoAllowPending()

      const [bashRes, trusted] = await Promise.all([bashPromise, trustPromise])
      assert.equal(bashRes.behavior, 'allow', 'tool prompt must auto-allow')
      assert.equal(trusted, false, 'MCP trust prompt must auto-deny')
      assert.equal(pm._pendingPermissions.size, 0)
    })
  })

  // -- AskUserQuestion handling --

  describe('AskUserQuestion handling', () => {
    it('routes AskUserQuestion through handlePermission', async () => {
      const events = []
      pm.on('user_question', (data) => events.push(data))

      const promise = pm.handlePermission('AskUserQuestion', { questions: [] }, null, 'approve')
      pm.respondToQuestion('ok')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 1)
    })

    it('emits user_question and resolves on respondToQuestion', async () => {
      const events = []
      pm.on('user_question', (data) => events.push(data))

      const questions = [{ question: 'Pick one?', options: [{ label: 'A' }] }]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      assert.equal(events.length, 1)
      assert.deepEqual(events[0].questions, questions)
      assert.equal(pm._waitingForAnswer, true)

      pm.respondToQuestion('A')
      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput.answers, { 'Pick one?': 'A' })
      assert.equal(pm._waitingForAnswer, false)
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = pm._handleAskUserQuestion({ questions: [] }, controller.signal)
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(pm._waitingForAnswer, false)
    })

    it('clears question timer on respondToQuestion', async () => {
      pm._handleAskUserQuestion({ questions: [] }, null)
      assert.ok(pm._questionTimer !== null)

      pm.respondToQuestion('answer')
      assert.equal(pm._questionTimer, null)
    })

    it('no-ops respondToQuestion when no pending answer', () => {
      // Should not throw
      pm.respondToQuestion('stale answer')
    })

    // #3988: symmetry follow-up to #3975. The user-response handler at
    // handlers/input-handlers.js:451 already deletes from questionSessionMap before
    // calling respondToQuestion, so the unified-pipeline cleanup is
    // redundant on this path — but every other question-variant emit
    // (aborted/timeout/cleared) carries toolUseId, and future internal
    // paths shouldn't have to remember "every emit needs toolUseId
    // EXCEPT this one." Defensive consistency.
    it('emits permission_resolved with toolUseId + reason:answered on respondToQuestion (#3988)', async () => {
      const events = []
      pm.on('permission_resolved', (data) => events.push(data))

      const userQuestionEvents = []
      pm.on('user_question', (data) => userQuestionEvents.push(data))
      const promise = pm._handleAskUserQuestion({ questions: [{ question: 'go?' }] }, null)
      assert.equal(userQuestionEvents.length, 1)
      const toolUseId = userQuestionEvents[0].toolUseId
      assert.ok(toolUseId, 'precondition: user_question must carry toolUseId')

      pm.respondToQuestion('yes')
      await promise

      const questionEmits = events.filter(e => !e.requestId)
      assert.equal(questionEmits.length, 1,
        'respondToQuestion must emit exactly one question-variant permission_resolved')
      assert.equal(questionEmits[0].toolUseId, toolUseId,
        'toolUseId must be propagated for symmetry with the other question-variant emits')
      assert.equal(questionEmits[0].reason, 'answered')
    })

    it('supports per-question answersMap', async () => {
      const questions = [
        { question: 'Color?', options: [{ label: 'Red' }] },
        { question: 'Size?', options: [{ label: 'Large' }] },
      ]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      pm.respondToQuestion('Red', { 'Color?': 'Red', 'Size?': 'Large' })
      const result = await promise
      assert.deepEqual(result.updatedInput.answers, { 'Color?': 'Red', 'Size?': 'Large' })
    })

    it('filters unknown question keys from answersMap', async () => {
      const questions = [{ question: 'Color?' }]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      pm.respondToQuestion('Red', { 'Color?': 'Red', 'Unknown?': 'x' })
      const result = await promise
      assert.deepEqual(result.updatedInput.answers, { 'Color?': 'Red' })
      assert.ok(!('Unknown?' in result.updatedInput.answers))
    })

    // #4621 wire shape + #4731 SDK normalization. answersMap values may
    // arrive as string[] (native multi-select from updated dashboards).
    // PermissionManager normalizes arrays to the SDK's canonical
    // comma-separated string shape (see normalizeAnswerValue and
    // sdk-multi-question-shapes.test.js for the full coverage) because
    // the SDK's `AskUserQuestionOutput.answers` is typed
    // `{ [questionText]: string }`. Single-select strings pass through.
    it('normalizes string[] answersMap values to comma-separated strings for the SDK (#4621 + #4731)', async () => {
      const questions = [
        { question: 'Areas?', multiSelect: true, options: [{ label: 'App' }, { label: 'Tests' }] },
        { question: 'Strategy?', options: [{ label: 'Patch' }, { label: 'Minor' }] },
      ]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      pm.respondToQuestion('summary', {
        'Areas?': ['App', 'Tests'],
        'Strategy?': 'Minor',
      })
      const result = await promise
      assert.deepEqual(result.updatedInput.answers, {
        'Areas?': 'App, Tests',
        'Strategy?': 'Minor',
      })
      assert.equal(typeof result.updatedInput.answers['Areas?'], 'string',
        'multi-select array must be coerced to comma-separated string per SDK contract')
    })

    // #4621 / #4735 / #4731 — mixed single-select + multi-select shape.
    // Single-select strings pass through unchanged; multi-select arrays
    // are normalized to comma-separated strings per the SDK contract
    // (see normalizeAnswerValue + the test above). #4735 added the
    // mixed-shape coverage; #4731 corrected the assertion to match the
    // SDK's `{ [questionText]: string }` output type.
    it('normalizes mixed string + string[] answers per the SDK contract (#4621 / #4731 / #4735)', async () => {
      const questions = [
        { question: 'Strategy?', options: [{ label: 'Patch' }, { label: 'Minor' }] },
        { question: 'Targets?', multiSelect: true, options: [
          { label: 'App' }, { label: 'Docs' },
        ] },
        { question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }] },
      ]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      pm.respondToQuestion('summary', {
        'Strategy?': 'Patch',
        'Targets?': ['App', 'Docs'],
        'Confirm?': 'Yes',
      })
      const result = await promise
      assert.deepEqual(result.updatedInput.answers, {
        'Strategy?': 'Patch',
        'Targets?': 'App, Docs',
        'Confirm?': 'Yes',
      })
      assert.equal(typeof result.updatedInput.answers['Targets?'], 'string',
        'multi-select array must be coerced to comma-separated string per SDK contract')
    })
  })

  // -- clearAll --

  describe('clearAll', () => {
    it('auto-denies all pending permissions', async () => {
      const promise1 = pm.handlePermission('Bash', {}, null, 'approve')
      const promise2 = pm.handlePermission('Read', {}, null, 'approve')

      pm.clearAll()

      const result1 = await promise1
      const result2 = await promise2
      assert.equal(result1.behavior, 'deny')
      assert.equal(result2.behavior, 'deny')
      assert.equal(pm._pendingPermissions.size, 0)
      assert.equal(pm._lastPermissionData.size, 0)
    })

    // #3048: every resolution path must emit a uniform { requestId, decision, reason }
    // payload so the unified broadcast pipeline can fan out to every connected client.
    it('emits permission_resolved with decision:deny + reason:cleared per pending request (#3048)', async () => {
      const events = []
      pm.on('permission_resolved', (data) => events.push(data))

      const p1 = pm.handlePermission('Bash', {}, null, 'approve')
      const p2 = pm.handlePermission('Read', {}, null, 'approve')
      const reqIds = Array.from(pm._pendingPermissions.keys())
      assert.equal(reqIds.length, 2)

      pm.clearAll()
      await Promise.all([p1, p2])

      // One emit per pending request — each carries decision + reason
      const requestEmits = events.filter(e => e.requestId)
      assert.equal(requestEmits.length, 2)
      for (const emit of requestEmits) {
        assert.equal(emit.decision, 'deny')
        assert.equal(emit.reason, 'cleared')
        assert.ok(reqIds.includes(emit.requestId))
      }
    })

    it('auto-denies pending user answer', async () => {
      const promise = pm._handleAskUserQuestion({ questions: [] }, null)
      pm.clearAll()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(pm._pendingUserAnswer, null)
      assert.equal(pm._waitingForAnswer, false)
    })

    it('clears question timer', () => {
      pm._questionTimer = setTimeout(() => {}, 999999)
      pm.clearAll()
      assert.equal(pm._questionTimer, null)
    })

    // #3975: clearAll must include `toolUseId` on the question-variant
    // permission_resolved emit so the unified pipeline (EventNormalizer)
    // can prune the questionSessionMap entry. Pre-fix the emit was
    // `{ reason: 'cleared' }` with no `toolUseId`, the sdk-session re-emit
    // gate dropped it, and the routing map leaked one entry per
    // message-completion-while-question-pending event.
    it('emits permission_resolved with toolUseId + reason:cleared for the pending question (#3975)', async () => {
      const events = []
      pm.on('permission_resolved', (data) => events.push(data))

      // Spin up an AskUserQuestion so PermissionManager captures a toolUseId.
      const userQuestionEvents = []
      pm.on('user_question', (data) => userQuestionEvents.push(data))
      const promise = pm._handleAskUserQuestion({ questions: [{ question: 'go?' }] }, null)
      assert.equal(userQuestionEvents.length, 1)
      const toolUseId = userQuestionEvents[0].toolUseId
      assert.ok(toolUseId, 'precondition: user_question must carry toolUseId')

      pm.clearAll()
      await promise

      const questionEmits = events.filter(e => !e.requestId)
      assert.equal(questionEmits.length, 1,
        'clearAll must emit exactly one question-variant permission_resolved')
      assert.equal(questionEmits[0].toolUseId, toolUseId,
        'toolUseId must be propagated so questionSessionMap can be pruned')
      assert.equal(questionEmits[0].reason, 'cleared')
    })
  })

  // -- destroy --

  describe('destroy', () => {
    it('cleans up pending permissions', async () => {
      const promise = pm.handlePermission('Bash', {}, null, 'approve')
      pm.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('cleans up pending user answer', async () => {
      const promise = pm._handleAskUserQuestion({ questions: [] }, null)
      pm.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('removes all listeners', () => {
      pm.on('permission_request', () => {})
      pm.on('user_question', () => {})
      pm.destroy()
      assert.equal(pm.listenerCount('permission_request'), 0)
      assert.equal(pm.listenerCount('user_question'), 0)
    })
  })

  // -- Rule engine constants --

  describe('ELIGIBLE_TOOLS and NEVER_AUTO_ALLOW constants', () => {
    it('ELIGIBLE_TOOLS contains the expected file operation tools', () => {
      // apply_patch = codex's file-edit tool (#6605), eligible like Write/Edit.
      const expected = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'apply_patch']
      for (const tool of expected) {
        assert.ok(ELIGIBLE_TOOLS.has(tool), `Expected ELIGIBLE_TOOLS to contain ${tool}`)
      }
      assert.equal(ELIGIBLE_TOOLS.size, expected.length)
    })

    it('NEVER_AUTO_ALLOW contains the expected dangerous tools', () => {
      // shell = codex's command-execution tool (#6605), never-whitelistable like Bash.
      // request_permissions = codex's sandbox-escalation tool (#6610) — broadening
      // filesystem/network scope must always prompt, never be rule-whitelisted.
      // mcp_elicitation = a codex MCP connector eliciting the user (#6635) — a
      // connector action (e.g. a GitHub write approval) must always prompt too.
      const expected = ['Bash', 'Task', 'WebFetch', 'WebSearch', 'shell', 'request_permissions', 'mcp_elicitation']
      for (const tool of expected) {
        assert.ok(NEVER_AUTO_ALLOW.has(tool), `Expected NEVER_AUTO_ALLOW to contain ${tool}`)
      }
      assert.equal(NEVER_AUTO_ALLOW.size, expected.length)
    })

    it('ELIGIBLE_TOOLS and NEVER_AUTO_ALLOW are disjoint', () => {
      for (const tool of ELIGIBLE_TOOLS) {
        assert.ok(!NEVER_AUTO_ALLOW.has(tool), `${tool} must not be in both sets`)
      }
    })
  })

  // -- setRules / getRules / clearRules --

  describe('setRules / getRules / clearRules', () => {
    it('sets and retrieves rules', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      const rules = pm.getRules()
      assert.equal(rules.length, 1)
      assert.equal(rules[0].tool, 'Read')
      assert.equal(rules[0].decision, 'allow')
    })

    it('getRules returns a copy (mutations do not affect internal state)', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      const rules = pm.getRules()
      rules.push({ tool: 'Write', decision: 'deny' })
      assert.equal(pm.getRules().length, 1)
    })

    it('setRules replaces existing rules', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      pm.setRules([{ tool: 'Write', decision: 'deny' }, { tool: 'Glob', decision: 'allow' }])
      const rules = pm.getRules()
      assert.equal(rules.length, 2)
      assert.equal(rules[0].tool, 'Write')
    })

    it('clearRules empties the rule list', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      pm.clearRules()
      assert.equal(pm.getRules().length, 0)
    })

    it('starts with no rules', () => {
      assert.equal(pm.getRules().length, 0)
    })

    it('accepts multiple rules for different tools', () => {
      const rules = [
        { tool: 'Read', decision: 'allow' },
        { tool: 'Write', decision: 'deny' },
        { tool: 'Edit', decision: 'allow' },
      ]
      pm.setRules(rules)
      assert.equal(pm.getRules().length, 3)
    })
  })

  // -- setRules validation --

  describe('setRules validation', () => {
    it('throws if rules is not an array', () => {
      assert.throws(() => pm.setRules(null), /rules must be an array/)
      assert.throws(() => pm.setRules('allow'), /rules must be an array/)
      assert.throws(() => pm.setRules({}), /rules must be an array/)
    })

    it('throws if a rule has no tool', () => {
      assert.throws(() => pm.setRules([{ decision: 'allow' }]), /tool/)
    })

    it('throws if tool is not a string', () => {
      assert.throws(() => pm.setRules([{ tool: 42, decision: 'allow' }]), /tool/)
    })

    it('throws if decision is not allow or deny', () => {
      assert.throws(
        () => pm.setRules([{ tool: 'Read', decision: 'allowAlways' }]),
        /decision must be 'allow' or 'deny'/
      )
      assert.throws(
        () => pm.setRules([{ tool: 'Read', decision: '' }]),
        /decision must be 'allow' or 'deny'/
      )
    })

    it('throws for NEVER_AUTO_ALLOW tools', () => {
      for (const tool of ['Bash', 'Task', 'WebFetch', 'WebSearch']) {
        assert.throws(
          () => pm.setRules([{ tool, decision: 'allow' }]),
          /NEVER_AUTO_ALLOW/,
          `Expected error for ${tool}`
        )
      }
    })

    it('throws for tools not in ELIGIBLE_TOOLS', () => {
      assert.throws(
        () => pm.setRules([{ tool: 'UnknownTool', decision: 'allow' }]),
        /ELIGIBLE_TOOLS/
      )
    })

    it('accepts deny decision for all ELIGIBLE_TOOLS', () => {
      for (const tool of ELIGIBLE_TOOLS) {
        assert.doesNotThrow(() => pm.setRules([{ tool, decision: 'deny' }]))
      }
    })

    it('accepts allow decision for all ELIGIBLE_TOOLS', () => {
      for (const tool of ELIGIBLE_TOOLS) {
        assert.doesNotThrow(() => pm.setRules([{ tool, decision: 'allow' }]))
      }
    })

    it('does not change rules on invalid input', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      assert.throws(() => pm.setRules([{ tool: 'Bash', decision: 'allow' }]))
      assert.equal(pm.getRules().length, 1, 'rules should be unchanged after failed setRules')
    })
  })

  // -- _matchesRule --

  describe('_matchesRule', () => {
    it('returns null when no rules set', () => {
      assert.equal(pm._matchesRule('Read'), null)
    })

    it('returns the rule decision for a matching tool', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      assert.equal(pm._matchesRule('Read'), 'allow')
    })

    it('returns deny for a deny rule', () => {
      pm.setRules([{ tool: 'Write', decision: 'deny' }])
      assert.equal(pm._matchesRule('Write'), 'deny')
    })

    it('returns null for a tool not in rules', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      assert.equal(pm._matchesRule('Write'), null)
    })

    it('uses first matching rule (FIFO)', () => {
      pm._sessionRules = [
        { tool: 'Read', decision: 'allow' },
        { tool: 'Read', decision: 'deny' },
      ]
      assert.equal(pm._matchesRule('Read'), 'allow')
    })
  })

  // -- handlePermission with rules --

  describe('handlePermission with session rules', () => {
    it('auto-allows a tool matching an allow rule without emitting permission_request', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))
      pm.setRules([{ tool: 'Read', decision: 'allow' }])

      const result = await pm.handlePermission('Read', { file_path: '/tmp/x' }, null, 'approve')
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { file_path: '/tmp/x' })
      assert.equal(events.length, 0)
    })

    it('auto-denies a tool matching a deny rule without emitting permission_request', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))
      pm.setRules([{ tool: 'Write', decision: 'deny' }])

      const result = await pm.handlePermission('Write', { file_path: '/tmp/y' }, null, 'approve')
      assert.equal(result.behavior, 'deny')
      assert.equal(result.message, 'Denied by session rule')
      assert.equal(events.length, 0)
    })

    it('rules take priority over acceptEdits mode', async () => {
      // With no rules, acceptEdits auto-allows Read
      const resultNoRule = await pm.handlePermission('Read', {}, null, 'acceptEdits')
      assert.equal(resultNoRule.behavior, 'allow')

      // With a deny rule, the rule wins even in acceptEdits mode
      pm.setRules([{ tool: 'Read', decision: 'deny' }])
      const resultWithRule = await pm.handlePermission('Read', {}, null, 'acceptEdits')
      assert.equal(resultWithRule.behavior, 'deny')
    })

    it('falls through to prompt when no rule matches', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))
      pm.setRules([{ tool: 'Read', decision: 'allow' }])

      // Write is not in our rules so it should prompt
      const promise = pm.handlePermission('Write', { file_path: '/tmp/z' }, null, 'approve')
      assert.equal(events.length, 1, 'Should emit permission_request for unmatched tool')
      pm.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })

    it('passes updatedInput with empty object when input is null', async () => {
      pm.setRules([{ tool: 'Glob', decision: 'allow' }])
      const result = await pm.handlePermission('Glob', null, null, 'approve')
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, {})
    })

    it('clears rules does not affect in-flight prompt requests', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Write', { file_path: '/x' }, null, 'approve')
      assert.equal(events.length, 1)

      pm.clearRules() // clear while prompt is pending

      pm.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })
  })

  // #6830 — a persisted (project-scoped) rule auto-approving a tool call had
  // ZERO audit trail: handlePermission short-circuits before a requestId is
  // ever minted or a permission_request emitted, so the audit log had no way
  // to answer "why did tool X auto-approve after a restart?" These pin the
  // gap-fill signal and its precedence rules.
  //
  // PR #6842 review — the signal is a DIRECT audit sink callback, NOT a
  // permission_resolved emission: permission_resolved rides ws-forwarding →
  // broadcastToSession, so emitting it here would spam every client with a
  // wire message per rule-matched tool call. The zero-emission contract is
  // pinned below via a wirePermissionManager forwarding spy.
  describe('handlePermission with persistent (project) rules — #6830 audit gap', () => {
    it('auto-allowing via a PERSISTENT rule calls the audit sink with tool + projectKey and emits NOTHING', async () => {
      const sinkCalls = []
      const events = []
      const cwdPm = createManager({ cwd: '/proj/a' })
      try {
        cwdPm.setAuditSink((info) => sinkCalls.push(info))
        cwdPm.on('permission_resolved', (data) => events.push(['permission_resolved', data]))
        cwdPm.on('permission_request', (data) => events.push(['permission_request', data]))
        cwdPm._persistentRules = [{ tool: 'Write', decision: 'allow' }]

        const result = await cwdPm.handlePermission('Write', { file_path: '/tmp/x' }, null, 'approve')
        assert.equal(result.behavior, 'allow')
        assert.equal(events.length, 0, 'no prompt AND no wire-lane event — audit sink only')
        assert.deepEqual(sinkCalls, [{ tool: 'Write', projectKey: '/proj/a' }])
      } finally {
        cwdPm.destroy()
      }
    })

    it('N=50 persisted-rule approvals forward ZERO permission_resolved through wirePermissionManager (the wire lane)', async () => {
      const cwdPm = createManager({ cwd: '/proj/a' })
      const session = new EventEmitter()
      const forwarded = []
      try {
        // The exact wiring every provider (sdk/byok/codex) uses — anything the
        // session re-emits here is what SessionManager → ws-forwarding →
        // broadcastToSession would put on the wire.
        wirePermissionManager(session, cwdPm)
        session.on('permission_resolved', (d) => forwarded.push(d))
        session.on('permission_request', (d) => forwarded.push(d))

        const sinkCalls = []
        cwdPm.setAuditSink((info) => sinkCalls.push(info))
        cwdPm._persistentRules = [{ tool: 'Read', decision: 'allow' }]

        for (let i = 0; i < 50; i++) {
          const result = await cwdPm.handlePermission('Read', { file_path: `/tmp/f${i}` }, null, 'approve')
          assert.equal(result.behavior, 'allow')
        }
        assert.equal(forwarded.length, 0, 'zero wire emissions across 50 silent auto-approves')
        assert.equal(sinkCalls.length, 50, 'every approve still reaches the audit sink (coalescing is ring-side)')
      } finally {
        cwdPm.destroy()
      }
    })

    it('a missing sink is a safe no-op, and a throwing sink never breaks tool approval', async () => {
      pm._persistentRules = [{ tool: 'Write', decision: 'allow' }]
      // No sink wired at all.
      const r1 = await pm.handlePermission('Write', { file_path: '/tmp/x' }, null, 'approve')
      assert.equal(r1.behavior, 'allow')
      // A sink that throws.
      pm.setAuditSink(() => { throw new Error('sink boom') })
      const r2 = await pm.handlePermission('Write', { file_path: '/tmp/y' }, null, 'approve')
      assert.equal(r2.behavior, 'allow', 'sink failure must not affect the approval')
    })

    it('wirePermissionManager installs the setPermissionAuditSink delegate on the session', () => {
      const session = new EventEmitter()
      wirePermissionManager(session, pm)
      assert.equal(typeof session.setPermissionAuditSink, 'function')
      const sinkCalls = []
      session.setPermissionAuditSink((info) => sinkCalls.push(info))
      pm._auditSink({ tool: 'Read', projectKey: null })
      assert.equal(sinkCalls.length, 1, 'delegate routes to the manager sink slot')
    })

    it('a SESSION rule match does NOT call the persisted-rule audit sink (session rules shadow persistent rules)', async () => {
      const sinkCalls = []
      pm.setAuditSink((info) => sinkCalls.push(info))
      pm.setRules([{ tool: 'Write', decision: 'allow' }])
      pm._persistentRules = [{ tool: 'Write', decision: 'allow' }] // same tool, both sets

      const result = await pm.handlePermission('Write', { file_path: '/tmp/x' }, null, 'approve')
      assert.equal(result.behavior, 'allow')
      assert.equal(sinkCalls.length, 0, 'session rule wins precedence — no persisted-rule audit needed')
    })

    it('a persistent DENY rule match does not call the (allow-only) audit sink', async () => {
      const sinkCalls = []
      pm.setAuditSink((info) => sinkCalls.push(info))
      pm._persistentRules = [{ tool: 'Write', decision: 'deny' }]

      const result = await pm.handlePermission('Write', { file_path: '/tmp/x' }, null, 'approve')
      assert.equal(result.behavior, 'deny')
      assert.equal(sinkCalls.length, 0)
    })

    it('_persistentRuleSourced reflects session-rule shadowing directly', () => {
      pm._persistentRules = [{ tool: 'Read', decision: 'allow' }]
      assert.equal(pm._persistentRuleSourced('Read'), true)
      pm._sessionRules = [{ tool: 'Read', decision: 'deny' }]
      assert.equal(pm._persistentRuleSourced('Read'), false, 'a session rule for the same tool shadows the persistent rule')
    })
  })

  // -- clearRules on mode change --

  describe('clearRules on mode change', () => {
    it('clearRules is idempotent when called multiple times', () => {
      pm.clearRules()
      pm.clearRules()
      assert.equal(pm.getRules().length, 0)
    })

    it('rules are independent across multiple setRules calls', () => {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      pm.clearRules()
      pm.setRules([{ tool: 'Write', decision: 'deny' }])
      assert.equal(pm.getRules().length, 1)
      assert.equal(pm.getRules()[0].tool, 'Write')
    })
  })

  // -- Timeout configuration --

  describe('timeout configuration', () => {
    it('uses custom timeout', () => {
      const custom = createManager({ timeoutMs: 60_000 })
      assert.equal(custom._timeoutMs, 60_000)
      custom.destroy()
    })

    it('defaults to 300_000ms', () => {
      assert.equal(pm._timeoutMs, 300_000)
    })

    it('includes remainingMs in permission_request payload', () => {
      const custom = createManager({ timeoutMs: 60_000 })
      const events = []
      custom.on('permission_request', (data) => events.push(data))

      custom.handlePermission('Bash', {}, null, 'approve')
      assert.equal(events[0].remainingMs, 60_000)
      custom.destroy()
    })
  })

  describe('requestMcpTrust (#4457)', () => {
    it('emits permission_request with tool=mcp_spawn and server detail', () => {
      const events = []
      pm.on('permission_request', (e) => events.push(e))
      pm.requestMcpTrust({ name: 'github', command: 'node', args: ['gh.js'], envKeys: ['GITHUB_TOKEN'] })
      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'mcp_spawn')
      assert.equal(events[0].input.mcpServer.name, 'github')
      assert.equal(events[0].input.mcpServer.command, 'node')
      assert.deepEqual(events[0].input.mcpServer.args, ['gh.js'])
      assert.deepEqual(events[0].input.mcpServer.envKeys, ['GITHUB_TOKEN'])
      assert.match(events[0].description, /Spawn MCP server "github"/)
    })

    it('resolves to true when respondToPermission says allow', async () => {
      const events = []
      pm.on('permission_request', (e) => events.push(e))
      const promise = pm.requestMcpTrust({ name: 'x', command: 'true' })
      pm.respondToPermission(events[0].requestId, 'allow')
      assert.equal(await promise, true)
    })

    it('resolves to false on deny', async () => {
      const events = []
      pm.on('permission_request', (e) => events.push(e))
      const promise = pm.requestMcpTrust({ name: 'x', command: 'true' })
      pm.respondToPermission(events[0].requestId, 'deny')
      assert.equal(await promise, false)
    })

    it('auto-denies on timeout (fail-closed)', async () => {
      const custom = createManager({ timeoutMs: 80 })
      const events = []
      custom.on('permission_request', (e) => events.push(e))
      const promise = custom.requestMcpTrust({ name: 'x', command: 'true' })
      assert.equal(await promise, false)
      custom.destroy()
    })
  })
})
