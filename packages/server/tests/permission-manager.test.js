import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager, ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../src/permission-manager.js'

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
      const expected = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']
      for (const tool of expected) {
        assert.ok(ELIGIBLE_TOOLS.has(tool), `Expected ELIGIBLE_TOOLS to contain ${tool}`)
      }
      assert.equal(ELIGIBLE_TOOLS.size, expected.length)
    })

    it('NEVER_AUTO_ALLOW contains the expected dangerous tools', () => {
      const expected = ['Bash', 'Task', 'WebFetch', 'WebSearch']
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
})
