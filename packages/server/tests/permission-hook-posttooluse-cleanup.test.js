import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, spawnSync } from 'child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { writeHookSettings } from '../src/claude-tui-session.js'

/**
 * #4671 (follow-up to #4669): integration test for the PostToolUse
 * sibling-lock cleanup pipeline.
 *
 * The companion file `permission-hook-sibling-deny.test.js` proves the
 * PreToolUse deny path, but it *simulates* the PostToolUse cleanup with
 * a direct `rmSync` (see the inline comment on its
 * "allows the next AskUserQuestion after the lock is removed" test). The
 * actual cleanup runs as a shell pipeline registered in `writeHookSettings()`
 * (claude-tui-session.js) and looks like:
 *
 *   tee <sink>/post-<uuid>.json | grep -q '"tool_name":"AskUserQuestion"' \
 *     && rm -rf <sink>/askuserquestion-active || true
 *
 * Three properties of this pipeline are load-bearing for the #4668 fix:
 *
 *   1. `tee` (not `cat`) — `cat > file` would consume stdin entirely and
 *      leave the cleanup grep with an empty payload, silently re-wedging
 *      the session forever. This was the pre-#4669 shape and the exact
 *      regression a future "cleanup" refactor would re-introduce if not
 *      pinned by a test.
 *   2. The grep targets AskUserQuestion — only that tool's PostToolUse may
 *      drop the lock. A wholesale `rm -rf` on every PostToolUse would let
 *      a Bash PostToolUse clear a still-pending AskUserQuestion lock, also
 *      re-wedging.
 *   3. The forensic file (`post-<uuid>.json`) must always be written even
 *      when grep matches nothing — the per-turn poller in claude-tui-session
 *      reads those files to drive tool_result emission.
 *
 * This file pins all three by:
 *   - calling the production `writeHookSettings()` to produce the same
 *     settings.json the running daemon would,
 *   - extracting the PostToolUse command verbatim,
 *   - piping real payloads through it via `spawn('/bin/bash', ['-c', cmd])`,
 *   - then driving a full Q1-PostToolUse-Q2 round trip through the real
 *     `permission-hook.sh` to prove the cleanup actually unblocks the next
 *     PreToolUse (no lock leakage between turns).
 *
 * Conflict note (#4670): this file is its own test, separate from the
 * sibling-deny / concurrent-burst files, so per-test-file edits don't
 * collide with the in-flight concurrent-burst PR. All tests share the
 * single permission-hook.sh script.
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

// Read the PostToolUse command verbatim out of the settings.json the
// production session writer would produce. Reaching through settings.json
// (instead of asserting on the raw string in claude-tui-session.js) means
// this file is also a regression test for the shape of writeHookSettings()
// itself — a refactor that, say, moved the cleanup to a separate hook entry
// would surface here as "command not found" or "wrong command extracted".
function extractPostToolUseCleanup(sinkDir) {
  const settingsPath = writeHookSettings(sinkDir, { permissionsEnabled: true })
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const postHooks = settings.hooks.PostToolUse[0].hooks
  // Pin the registered-hook count: a future refactor that adds a second
  // PostToolUse hook (e.g. a metrics emitter) must also re-think the
  // cleanup ordering — fail loudly here so the new contributor sees it.
  assert.equal(postHooks.length, 1,
    'PostToolUse currently has exactly one hook (forensic sink + cleanup combined via tee). If you added a second hook, decide whether the cleanup still belongs on the first one.')
  const command = postHooks[0].command
  // Sanity-check the load-bearing tokens before returning — a missing
  // `tee` is the exact regression #4669 was originally fixing.
  assert.match(command, /\btee\b/, 'PostToolUse must use `tee` to preserve stdin for the cleanup grep — `cat > file` would consume stdin and silently re-wedge the session')
  assert.match(command, /'"tool_name":"AskUserQuestion"'/, 'cleanup grep must target AskUserQuestion specifically — a wholesale rm on every PostToolUse would let a Bash PostToolUse clear a still-pending AskUserQuestion lock')
  assert.match(command, /rm -rf .*askuserquestion-active/, 'cleanup must `rm -rf` the askuserquestion-active lock dir — that is what releases the sibling deny')
  return command
}

function runCleanupPipeline(command, payload) {
  return spawnSync('/bin/bash', ['-c', command], {
    input: payload,
    encoding: 'utf8',
  })
}

describe('permission-hook PostToolUse cleanup pipeline (#4671)', () => {
  let sinkDir

  beforeEach(() => {
    sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-hook-post-cleanup-'))
  })

  afterEach(() => {
    rmSync(sinkDir, { recursive: true, force: true })
  })

  describe('isolated pipeline behaviour', () => {
    it('removes the askuserquestion-active lock when the PostToolUse payload is AskUserQuestion', () => {
      const command = extractPostToolUseCleanup(sinkDir)
      // Simulate the PreToolUse claim — the real claim is performed by
      // the permission-hook.sh `mkdir` race-winner branch; here we just
      // place the lock directly so this test focuses exclusively on the
      // PostToolUse pipeline behaviour.
      mkdirSync(join(sinkDir, 'askuserquestion-active'))
      assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
        'precondition: lock dir exists before PostToolUse fires')

      const result = runCleanupPipeline(command, JSON.stringify({
        tool_name: 'AskUserQuestion',
        tool_response: { questions: [{ question: 'one?' }] },
      }))

      assert.equal(result.status, 0, 'pipeline must exit 0 (the `|| true` ensures the chain never fails the PostToolUse)')
      assert.equal(existsSync(join(sinkDir, 'askuserquestion-active')), false,
        'AskUserQuestion PostToolUse must release the sibling lock so the next Q can claim it')
    })

    it('preserves the lock when the PostToolUse payload is NOT AskUserQuestion (e.g. Bash)', () => {
      const command = extractPostToolUseCleanup(sinkDir)
      mkdirSync(join(sinkDir, 'askuserquestion-active'))

      const result = runCleanupPipeline(command, JSON.stringify({
        tool_name: 'Bash',
        tool_response: { stdout: 'ok', stderr: '', exit_code: 0 },
      }))

      // The pipeline still exits 0 because `|| true` clamps grep's exit-1
      // (no match) into a success — claude must never see PostToolUse hook
      // failures, otherwise it would interpret the tool call as having
      // failed.
      assert.equal(result.status, 0,
        'pipeline must succeed even when grep finds no AskUserQuestion match — `|| true` guarantees PostToolUse never fails')
      assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
        'a Bash PostToolUse must NOT clear an AskUserQuestion lock — otherwise an in-flight question would be wrongly released and a second Q could slip past the deny')
    })

    it('always writes the forensic post-<uuid>.json file regardless of grep match', () => {
      const command = extractPostToolUseCleanup(sinkDir)

      // First payload: AskUserQuestion (grep matches).
      const askPayload = JSON.stringify({ tool_name: 'AskUserQuestion', tool_response: {} })
      mkdirSync(join(sinkDir, 'askuserquestion-active'))
      runCleanupPipeline(command, askPayload)

      // Second payload: Bash (grep misses).
      const bashPayload = JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: 'x' } })
      runCleanupPipeline(command, bashPayload)

      const postFiles = readdirSync(sinkDir).filter((n) => n.startsWith('post-') && n.endsWith('.json'))
      // Forensic files are critical: the per-turn poller in claude-tui-session
      // (around line 1028, `_emitToolHookEvent('PostToolUse', ...)`) walks the
      // sink dir and emits tool_result events based on these files. A
      // cleanup pipeline that swallowed stdin would leave EMPTY forensic
      // files; one that elided the tee entirely would leave NO files and
      // tool_result would never emit.
      assert.equal(postFiles.length, 2,
        'tee must write one forensic file per PostToolUse invocation regardless of whether grep matched — the per-turn poller depends on these files for tool_result emission')

      for (const name of postFiles) {
        const content = readFileSync(join(sinkDir, name), 'utf8')
        assert.ok(content.length > 0,
          `${name}: tee must write the full stdin payload — an empty forensic file means tee was misconfigured (e.g. swapped for cat > file as in the pre-#4669 shape) and would silently break tool_result emission`)
        // Parsable as JSON: the poller does JSON.parse on this content.
        assert.doesNotThrow(() => JSON.parse(content),
          `${name}: forensic file must be valid JSON — the per-turn poller parses it directly`)
      }
    })

    it('writes a UNIQUE forensic filename per invocation (no overwrites across PostToolUses)', () => {
      // uuidgen is the cross-platform unique-name source. If a future
      // refactor switched to mktemp `foo-XXXXXX.json` (the macOS BSD-mktemp
      // suffix-handling bug noted in claude-tui-session.js:150), every
      // PostToolUse would clobber the same file and the poller would see
      // only the last one. This catches that regression.
      const command = extractPostToolUseCleanup(sinkDir)

      for (let i = 0; i < 5; i++) {
        runCleanupPipeline(command, JSON.stringify({ tool_name: 'Bash', tool_response: { i } }))
      }

      const postFiles = readdirSync(sinkDir).filter((n) => n.startsWith('post-') && n.endsWith('.json'))
      assert.equal(postFiles.length, 5,
        'each PostToolUse must produce a unique filename — overwrites would silently drop tool_result events')
      assert.equal(new Set(postFiles).size, 5, 'all forensic filenames must be distinct')
    })
  })

  describe('end-to-end Q1 → PostToolUse → Q2 round trip via the real permission-hook.sh', () => {
    it('Q1 PreToolUse claims the lock; PostToolUse cleanup releases it; Q2 PreToolUse re-claims cleanly', async () => {
      // This is the integration the issue calls out: the production
      // PreToolUse/PostToolUse chain working together through the same
      // sink dir, with no manual fix-up between turns. Proves the lock
      // doesn't leak across PostToolUse and that the cleanup actually
      // unblocks the next PreToolUse — which is the property #4668
      // requires for sequential AskUserQuestion to work.
      const cleanupCommand = extractPostToolUseCleanup(sinkDir)

      // --- Q1 PreToolUse: must allow (no sibling) and claim the lock.
      const q1 = await runHook(JSON.stringify(singleQuestion('Vite')), { CHROXY_SINK_DIR: sinkDir })
      const q1Decision = JSON.parse(q1.stdout.trim())
      assert.equal(q1Decision.hookSpecificOutput.permissionDecision, 'allow',
        'Q1 (first AskUserQuestion) must allow — no sibling pending')
      assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
        'Q1 PreToolUse must claim the sibling lock')

      // Sanity: at this point a Q2 PreToolUse WITHOUT cleanup would deny.
      // (Already covered by sibling-deny.test.js — but asserting here too
      // makes the test's positive control explicit: the lock IS doing its
      // job and the cleanup is what flips Q2 to allow.)
      const q2EarlyAttempt = await runHook(JSON.stringify(singleQuestion('Webpack')), { CHROXY_SINK_DIR: sinkDir })
      assert.equal(JSON.parse(q2EarlyAttempt.stdout.trim()).hookSpecificOutput.permissionDecision, 'deny',
        'precondition: without PostToolUse cleanup, Q2 must deny — confirms the lock is the only thing the cleanup needs to release')

      // --- Q1 PostToolUse: run the production cleanup pipeline against
      // an AskUserQuestion payload. This is the path the test exists to pin.
      const postResult = runCleanupPipeline(cleanupCommand, JSON.stringify({
        tool_name: 'AskUserQuestion',
        tool_response: { selected: { Vite: { label: 'Vite', value: 'vite' } } },
      }))
      assert.equal(postResult.status, 0, 'PostToolUse cleanup must exit 0')
      assert.equal(existsSync(join(sinkDir, 'askuserquestion-active')), false,
        'PostToolUse for AskUserQuestion MUST remove the sibling lock — this is the load-bearing cleanup #4668 depends on')

      // --- Q2 PreToolUse: must now allow cleanly (no lock leakage).
      const q2 = await runHook(JSON.stringify(singleQuestion('Webpack')), { CHROXY_SINK_DIR: sinkDir })
      const q2Decision = JSON.parse(q2.stdout.trim())
      assert.equal(q2Decision.hookSpecificOutput.permissionDecision, 'allow',
        'Q2 (sequential AskUserQuestion after PostToolUse cleanup) must allow — this is the sequential-happy-path #4668 restores')
      assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
        'Q2 PreToolUse must re-claim the lock for its own turn')

      // --- Q1 + Q2 forensic files both written.
      const postFiles = readdirSync(sinkDir).filter((n) => n.startsWith('post-') && n.endsWith('.json'))
      assert.equal(postFiles.length, 1,
        'exactly one PostToolUse forensic file — only Q1 fired PostToolUse in this test (Q2 is still pending)')
    })

    it('non-AskUserQuestion PostToolUse during a pending Q does NOT release the lock', async () => {
      // Realistic scenario: Q1 is pending (user hasn't answered) and the
      // model fires a Bash tool_use in parallel (which is allowed —
      // sibling-deny only targets AskUserQuestion). Bash's PostToolUse
      // must not collaterally clear Q1's lock; otherwise a stray Bash
      // could re-open the parallel-AskUserQuestion wedge the fix exists
      // to prevent.
      const cleanupCommand = extractPostToolUseCleanup(sinkDir)

      // Q1 claims the lock.
      await runHook(JSON.stringify(singleQuestion('Vite')), { CHROXY_SINK_DIR: sinkDir })
      assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')))

      // A Bash PostToolUse fires (e.g. a parallel non-AskUserQuestion tool
      // wrapped up while Q1 is still pending the user's answer).
      runCleanupPipeline(cleanupCommand, JSON.stringify({
        tool_name: 'Bash',
        tool_response: { stdout: 'whatever', exit_code: 0 },
      }))

      // Lock still in place — Bash's PostToolUse must not touch it.
      assert.ok(existsSync(join(sinkDir, 'askuserquestion-active')),
        'Bash PostToolUse must NOT clear the askuserquestion-active lock — it is owned by Q1 which has not yet completed')

      // A second AskUserQuestion attempt still denies (lock is intact).
      const q2 = await runHook(JSON.stringify(singleQuestion('Webpack')), { CHROXY_SINK_DIR: sinkDir })
      assert.equal(JSON.parse(q2.stdout.trim()).hookSpecificOutput.permissionDecision, 'deny',
        'Q2 must still deny — Q1 is still pending because no AskUserQuestion PostToolUse has fired')
    })
  })
})
