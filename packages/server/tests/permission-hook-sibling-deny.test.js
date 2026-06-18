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
    // the load-bearing phrases without locking the exact copy. tool_result
    // is the explicit signal the model has been observed responding to;
    // pre-#4668 "answer each in turn" was the ambiguous phrasing the model
    // mis-read as "parallel within one turn".
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /pending/i)
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /parallel/i)
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /tool_result/i)
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

  /**
   * #4670: concurrent-burst proof of sibling-lock atomicity.
   *
   * The pre-existing tests in this file invoke runHook serially — they prove
   * the deny *logic* fires once a lock exists, but never exercise the race
   * the hook is designed to mitigate. The production wedge (chroxy.log
   * forensic on session 9ea82aed, 2026-05-31) was N parallel hook processes
   * spawned within milliseconds of each other when claude TUI emitted N
   * AskUserQuestion tool_use blocks in one assistant turn.
   *
   * The hook now uses `mkdir` AS the atomic check-and-claim (POSIX guarantees
   * at most one mkdir per parent directory wins; the rest see EEXIST). These
   * tests prove that guarantee survives the actual race: spawning N hooks in
   * parallel against the same CHROXY_SINK_DIR must produce exactly one allow
   * and N-1 denies. Any future regression to a check-then-claim split (e.g.,
   * `if [ -d "$LOCK" ]; then deny; else mkdir; fi`) would show up here as
   * the allow count drifting above 1.
   */
  describe('concurrent-burst sibling-lock atomicity (#4670)', () => {
    const burstSizes = [4, 20]

    for (const n of burstSizes) {
      it(`exactly 1 of ${n} parallel hooks acquires the lock; the rest deny`, async () => {
        // Spawn N hook processes in parallel against the same sink dir.
        // Promise.all + spawn (rather than awaiting each) is the closest
        // node-test approximation of "4 hooks firing within milliseconds"
        // that the production forensic captured. The kernel scheduler
        // interleaves mkdir calls across the N child processes.
        const labels = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26)) + i)
        const results = await Promise.all(
          labels.map((label) => runHook(JSON.stringify(singleQuestion(label)), { CHROXY_SINK_DIR: sinkDir })),
        )

        // Every hook must exit 0 — a non-zero exit means the script crashed
        // (e.g. arithmetic error from a botched stat fallback), which would
        // leave the caller in an undefined permission state. Pin this even
        // though it's implied by the JSON parse below, because a crashing
        // hook is a worse outcome than a wrong decision.
        for (const r of results) {
          assert.equal(r.status, 0, `hook exited non-zero: stderr=${r.stderr}`)
        }

        const decisions = results.map((r) => {
          try {
            return JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision
          } catch (err) {
            assert.fail(`hook stdout did not parse as JSON: ${r.stdout} (stderr=${r.stderr})`)
          }
        })

        const allows = decisions.filter((d) => d === 'allow').length
        const denies = decisions.filter((d) => d === 'deny').length

        // The load-bearing invariant: at most one allow no matter how many
        // hooks race. mkdir's POSIX atomicity is what makes this true; if a
        // future refactor splits check-and-claim, this assertion catches it.
        assert.equal(allows, 1,
          `expected exactly 1 allow in a burst of ${n}, got ${allows} (decisions: ${decisions.join(',')})`)
        assert.equal(denies, n - 1,
          `expected ${n - 1} denies in a burst of ${n}, got ${denies} (decisions: ${decisions.join(',')})`)

        // The lock dir must exist after the burst — the winner claimed it
        // and no loser should have removed it on the way out (only the
        // stale-recovery branch removes the lock, and a fresh-claim race
        // shouldn't hit that branch since the winner's mtime is <60s).
        assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
          'winner\'s lock must survive the burst — losers must not rm the active lock')

        // Every denier must surface the sibling-pending phrasing rather than
        // the multi-question phrasing — the test payload is single-question.
        // Pinning the phrase guards against the deny text accidentally
        // diverging between the EEXIST branch and the post-recovery branch
        // in the hook (both should produce the same reason).
        const denyReasons = results
          .filter((_, i) => decisions[i] === 'deny')
          .map((r) => JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecisionReason)
        for (const reason of denyReasons) {
          assert.match(reason, /pending/i,
            'sibling deny must mention the pending sibling (not the multi-question phrasing)')
          assert.match(reason, /parallel/i)
        }
      })
    }

    it('no losers corrupt sink state — only the lock dir is created', async () => {
      // Defense-in-depth: a buggy loser branch might create stray files
      // (e.g., a half-written lock contents file) in the sink dir. Verify
      // that after a parallel burst, the sink contains *only* the single
      // lock directory we expect. Catches regressions where someone adds
      // a "second attempt" or "telemetry write" to the loser path that
      // leaves debris behind.
      const n = 8
      await Promise.all(
        Array.from({ length: n }, (_, i) =>
          runHook(JSON.stringify(singleQuestion(`Q${i}`)), { CHROXY_SINK_DIR: sinkDir })),
      )

      const { readdirSync } = await import('fs')
      const entries = readdirSync(sinkDir)
      assert.deepEqual(entries, ['askuserquestion-active'],
        `sink dir should contain only the lock after a burst, got: ${entries.join(',')}`)
    })
  })
})
