import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { mkdirSync, rmSync, mkdtempSync, existsSync, statSync, utimesSync } from 'fs'
import { tmpdir } from 'os'

/**
 * #4668 (short-term): permission-hook.sh refuses an AskUserQuestion when a
 * sibling AskUserQuestion is already pending in the session sink directory.
 *
 * Why this is its own test file: parallel-tool-use is an orthogonal axis from
 * the multi-question payload-shape check (`permission-hook-multi-question.test.js`)
 * — same hook script, different lifetime semantics (filesystem state vs.
 * stdin payload). Splitting keeps each file focused on one invariant.
 *
 * Wedge that motivated this fix (chroxy.log 2026-05-31, v0.9.26 session
 * 9ea82aed): #4648's deny pushed claude TUI to re-emit as N "separate"
 * AskUserQuestion calls, but the model interpreted "separate" as parallel
 * within the same turn. Chroxy's `_pendingUserAnswer` is a single field that
 * gets overwritten by each new tool_use → all 4 user answers routed to the
 * wrong question, 5-minute stall watchdog fires. Forcing true serialization
 * at the hook layer restores the single-pending invariant that the existing
 * keystroke driver was built around — until the long-term Map-keyed refactor
 * lands.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

function runHook(input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [hookPath], {
      env: { CHROXY_PORT: '12345', CHROXY_PERMISSION_MODE: 'auto', ...env },
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

const singleQuestion = (label = 'A') => ({
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{ question: 'one?', header: 'One', options: [{ label, value: label.toLowerCase() }] }],
  },
})

describe('permission-hook.sh — sibling AskUserQuestion deny (#4668)', () => {
  let sinkDir

  beforeEach(() => {
    sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-hook-sibling-'))
  })

  afterEach(() => {
    rmSync(sinkDir, { recursive: true, force: true })
  })

  it('allows the first AskUserQuestion and claims the sibling lock', async () => {
    const { stdout, status } = await runHook(JSON.stringify(singleQuestion('Vite')), { CHROXY_SINK_DIR: sinkDir })
    assert.equal(status, 0)
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'first AskUserQuestion must allow — no sibling pending yet')
    assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
      'first call must claim the lock so subsequent siblings can see it')
  })

  it('denies a second AskUserQuestion while the sibling lock is fresh', async () => {
    // First call claims the lock.
    await runHook(JSON.stringify(singleQuestion('Vite')), { CHROXY_SINK_DIR: sinkDir })
    // Second call (no PostToolUse cleanup in between — simulates the parallel-burst case).
    const { stdout } = await runHook(JSON.stringify(singleQuestion('Webpack')), { CHROXY_SINK_DIR: sinkDir })
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny',
      'second sibling must deny while the first is pending')
    // The reason text must steer the model toward true serialization — pin
    // the load-bearing phrases without locking the exact copy.
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /pending/i)
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /parallel/i)
  })

  it('allows the next AskUserQuestion after the lock is removed (PostToolUse cleanup path)', async () => {
    // First call claims the lock.
    await runHook(JSON.stringify(singleQuestion('Vite')), { CHROXY_SINK_DIR: sinkDir })
    // Simulate the PostToolUse cleanup hook removing the lock when the user
    // answered the first question and the TUI emitted PostToolUse. The
    // production cleanup runs via the `tee | grep | rm -rf` chain wired in
    // claude-tui-session.js writeHookSettings(); here we just remove it
    // directly so this test doesn't depend on that wiring.
    rmSync(join(sinkDir, 'askuserquestion-active'), { recursive: true, force: true })
    // Second call should now allow — the sequential happy path.
    const { stdout } = await runHook(JSON.stringify(singleQuestion('Webpack')), { CHROXY_SINK_DIR: sinkDir })
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'sequential AskUserQuestion after cleanup must allow')
  })

  it('reclaims a stale lock older than 60s (crash recovery)', async () => {
    // Manually create a stale lock with mtime 5 minutes ago — simulates a
    // wedged session that died without cleaning up. The hook must reclaim
    // the lock rather than wedge the next session permanently.
    const lockPath = join(sinkDir, 'askuserquestion-active')
    mkdirSync(lockPath)
    const fiveMinAgo = (Date.now() - 5 * 60 * 1000) / 1000
    utimesSync(lockPath, fiveMinAgo, fiveMinAgo)
    // Sanity check the mtime was applied.
    assert.ok((Date.now() / 1000) - statSync(lockPath).mtimeMs / 1000 > 60,
      'precondition: lock is older than 60s')

    const { stdout } = await runHook(JSON.stringify(singleQuestion('React')), { CHROXY_SINK_DIR: sinkDir })
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'stale lock (>60s) must be reclaimed — otherwise a dead session permanently wedges its successors')
  })

  it('no-ops the sibling check when CHROXY_SINK_DIR is unset (backward compat)', async () => {
    // Without the env var, the hook can't manage the lock — it must skip
    // the sibling check entirely and behave like pre-#4668. Otherwise
    // upgrading the script without upgrading claude-tui-session.js (e.g.,
    // partial deploy) would block every AskUserQuestion.
    const { stdout } = await runHook(JSON.stringify(singleQuestion('Vite')))
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'no sink dir → no sibling check → allow (pre-#4668 behavior preserved)')
  })

  it('no-ops the sibling check when CHROXY_SINK_DIR points to a non-existent dir', async () => {
    // Defensive: an operator-set sink dir that no longer exists shouldn't
    // crash or accidentally deny. The hook's `[ -d "$CHROXY_SINK_DIR" ]`
    // guard handles this; verifies the guard works.
    const { stdout } = await runHook(JSON.stringify(singleQuestion('Vite')), { CHROXY_SINK_DIR: '/nonexistent/path/xyz123' })
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'missing sink dir → no sibling check → allow')
  })

  it('does not affect non-AskUserQuestion tools (Bash unblocked even with stale lock)', async () => {
    // A pending AskUserQuestion lock must not block other tools — only
    // a sibling AskUserQuestion. Otherwise a stale lock could globally
    // block Bash / Read / etc, which is much worse than the wedge it's
    // trying to fix.
    mkdirSync(join(sinkDir, 'askuserquestion-active'))
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      { CHROXY_SINK_DIR: sinkDir, CHROXY_PERMISSION_MODE: 'auto' },
    )
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow',
      'Bash must not be blocked by a pending AskUserQuestion lock')
  })

  it('the multi-question deny still runs BEFORE the sibling check (deny-first ordering)', async () => {
    // If both conditions fire on the same call (multi-question payload AND
    // a sibling lock exists), the multi-question deny should win — its
    // reason text is more actionable for the model. Verify by setting up
    // both conditions and asserting the multi-q phrasing surfaces.
    mkdirSync(join(sinkDir, 'askuserquestion-active'))
    const payload = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ q: 1 }, { q: 2 }] },
    }
    const { stdout } = await runHook(JSON.stringify(payload), { CHROXY_SINK_DIR: sinkDir })
    const decision = JSON.parse(stdout.trim())
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /one question at a time/i,
      'multi-question deny text should win over the sibling-pending text')
  })
})
