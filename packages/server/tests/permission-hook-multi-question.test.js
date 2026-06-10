import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

/**
 * #4648 (v0.9.24): permission-hook.sh refuses multi-question AskUserQuestion
 * forms with a structured `deny + permissionDecisionReason` so the model
 * re-issues the call as N sequential single-question forms (the empirically-
 * validated happy path that has worked since v0.9.4).
 *
 * Why this is its own test file: the existing permission-hook-sanitization
 * tests focus on PORT/PERM_MODE input validation; the sidecar-integration
 * tests cover mid-session permission-mode flips. The multi-question deny is
 * a third orthogonal axis (payload-shape inspection) and gets its own file
 * so a future refactor of either of the other two areas doesn't grow them
 * by reading-stdin scaffolding.
 *
 * See docs/audit-results/tui-form-delivery-rethink/ for the full audit that
 * established this approach (6 agents, unanimous).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

function runHook(input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [hookPath], {
      env: { CHROXY_PORT: '12345', CHROXY_PERMISSION_MODE: 'approve', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    if (input != null) child.stdin.write(input)
    child.stdin.end()
  })
}

describe('permission-hook.sh — multi-question AskUserQuestion deny (#4648)', () => {
  it('denies a multi-question AskUserQuestion with the canonical reason text', async () => {
    const payload = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Which provider?', header: 'Provider', options: [{ label: 'A', value: 'a' }] },
          { question: 'Which transport?', header: 'Transport', options: [{ label: 'B', value: 'b' }] },
        ],
      },
    }
    const { stdout, status } = await runHook(JSON.stringify(payload))
    assert.equal(status, 0, 'exits cleanly')
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
    // The reason text steers the model toward the right retry behavior.
    // Don't pin the exact string (a future copy edit shouldn't break tests)
    // but DO pin the load-bearing semantics: must say "one question at a
    // time" or equivalent so the model knows how to recover, and must
    // mention "separate AskUserQuestion" so the model knows it can retry.
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /one question at a time/i)
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /separate AskUserQuestion/i)
  })

  it('denies a multi-question form REGARDLESS of permission mode (auto must still deny)', async () => {
    // Auto mode normally short-circuits to "allow" without reading the
    // payload. The deny check must run BEFORE the mode dispatch so a user
    // in auto mode (the most common dogfood mode per [[feedback_app_means_desktop]])
    // still gets the deny — otherwise auto-mode users would hit the wedge
    // every time the model emits a multi-q form.
    const payload = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ q: 1 }, { q: 2 }] },
    }
    for (const mode of ['auto', 'approve', 'acceptEdits', 'plan']) {
      const { stdout } = await runHook(JSON.stringify(payload), { CHROXY_PERMISSION_MODE: mode })
      const decision = JSON.parse(stdout.trim())
      assert.equal(
        decision.hookSpecificOutput.permissionDecision,
        'deny',
        `mode=${mode} must deny multi-q form regardless`,
      )
    }
  })

  it('allows a single-question AskUserQuestion in auto mode (only multi-q is denied)', async () => {
    const payload = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'one?', header: 'One', options: [{ label: 'A', value: 'a' }] }] },
    }
    const { stdout } = await runHook(JSON.stringify(payload), { CHROXY_PERMISSION_MODE: 'auto' })
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'single-q AskUserQuestion in auto mode still allows (no regression of v0.9.4 happy path)')
  })

  it('lets non-AskUserQuestion tools pass through (Bash in auto mode allows as before)', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      { CHROXY_PERMISSION_MODE: 'auto' },
    )
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'Bash in auto mode still allows — multi-q check is AskUserQuestion-only')
  })

  // These three assert the #4648 multi-question GUARD does not fire on
  // odd-shaped payloads. They route to phone afterward; on the unreachable test
  // port that now fails CLOSED with a #5330 transport deny (was "ask"), so we
  // assert specifically that the guard's deny (reason "one question at a time")
  // did NOT fire — not merely that the decision isn't "deny".
  const firedMultiQuestionGuard = (decision) => {
    const d = decision.hookSpecificOutput
    return d.permissionDecision === 'deny' && /one question at a time/i.test(d.permissionDecisionReason || '')
  }

  it('does NOT trip the multi-question guard on malformed payload (no tool_input)', async () => {
    // python3 parse failure → empty QUESTION_COUNT → guard doesn't fire →
    // normal handling resumes. A broken hook payload must NOT cause the
    // multi-question guard to deny every tool call across the board.
    const { stdout } = await runHook(JSON.stringify({ tool_name: 'AskUserQuestion' }))
    const decision = JSON.parse(stdout.trim())
    assert.equal(firedMultiQuestionGuard(decision), false,
      'malformed payload must not trip the multi-question guard')
  })

  it('does NOT trip the multi-question guard on empty questions array', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }),
    )
    const decision = JSON.parse(stdout.trim())
    assert.equal(firedMultiQuestionGuard(decision), false,
      'empty questions array must not trip the guard — > 1 is the gate, not >= 1')
  })

  it('does NOT trip the multi-question guard on non-array questions value (shape drift)', async () => {
    // If Anthropic ever ships a payload where `questions` is an object map or
    // a string, the python3 check returns 0 (not isinstance(list)), so the
    // guard doesn't fire. Better to attempt the wedge (v0.9.23 watchdog
    // catches it) than to deny something that wasn't actually multi-question.
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: 'not-a-list' } }),
    )
    const decision = JSON.parse(stdout.trim())
    assert.equal(firedMultiQuestionGuard(decision), false,
      'non-array questions value must not trip the guard — defensive against shape drift')
  })
})
