/**
 * Codex spawn-and-assert integration test (#3873).
 *
 * Catches argv-rejection bugs where chroxy passes flags Codex doesn't accept
 * in a given subcommand scope. The motivating example (#3867 review): chroxy
 * passed `--sandbox workspace-write` to `codex exec resume`, but `--sandbox` is
 * only declared on the parent `exec` command, so codex-cli 0.128.0 rejected the
 * argv with `error: unexpected argument '--sandbox' found` (clap exit code 2).
 *
 * Unit-only tests against `buildCodexArgs` cannot catch this — they inspect the
 * argv array but never spawn the binary. This file spawns the real codex CLI
 * with each argv form chroxy produces and asserts the clap parser accepts it.
 *
 * Gating
 * ------
 * Runs when:
 *   - `RUN_CODEX_INTEGRATION=1`, OR
 *   - `codex` is resolvable via CodexSession.binaryCandidates (covers a local
 *     dev box where the binary is already installed).
 * Skips silently otherwise so it is safe to leave in the default test glob and
 * in CI environments where codex is not installed.
 *
 * Why this works without a valid OPENAI_API_KEY
 * ---------------------------------------------
 * clap parses argv before any auth/network code runs. An argv parse failure
 * exits 2 immediately with the diagnostic on stderr. Past that point the test
 * does not care whether the subsequent network turn succeeds — it kills the
 * child after a short grace window. The argv-contract assertion is therefore
 * deterministic regardless of credentials.
 *
 * When `OPENAI_API_KEY` is set OR codex has stored ChatGPT credentials, the
 * test ALSO asserts the issue's stronger contract — stdout begins with
 * `{"type":"thread.started"` — by reading the first JSONL line before killing
 * the process. That branch is skipped silently when no auth is configured.
 *
 * Run locally:
 *   RUN_CODEX_INTEGRATION=1 node --test \
 *     packages/server/tests/integration/codex-spawn-argv.integration.test.js
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { CodexSession, buildCodexArgs } from '../../src/codex-session.js'

// ─── gating ───────────────────────────────────────────────────────────────

const FORCE = process.env.RUN_CODEX_INTEGRATION === '1'

/**
 * Probe for a usable codex binary at test time.
 *
 * `CodexSession.resolvedBinary` is evaluated at module-load via
 * `resolveBinary('codex', BINARY_CANDIDATES)`, which always returns a string
 * (never `null`):
 *   1. The absolute path printed by `which codex` (when codex is on PATH).
 *   2. The first existing candidate from `BINARY_CANDIDATES`.
 *   3. The bare name `'codex'` as a last-resort fallback, so callers get a
 *      descriptive ENOENT instead of a silent failure.
 *
 * Case 3 is what this helper has to defend against — `existsSync('codex')` is
 * false even when the binary is invocable via a PATH lookup at test time.
 * We re-probe candidates first (cheap, deterministic), then fall through to
 * `which` so a PATH-only install is still recognised.
 *
 * Returns the resolved binary spec (absolute path) or `null` when no
 * candidate exists and codex is not on PATH.
 */
function resolveCodexBinary() {
  // Case 1/2: resolvedBinary is an absolute path that exists on disk.
  if (existsSync(CodexSession.resolvedBinary)) {
    return CodexSession.resolvedBinary
  }
  // Re-scan candidates in case the module-load PATH was minimal.
  for (const candidate of CodexSession.binaryCandidates) {
    if (existsSync(candidate)) return candidate
  }
  // Case 3: resolvedBinary may be the bare name 'codex'. Verify it is
  // genuinely invocable via the current PATH before claiming a hit, so we
  // don't spawn a missing binary and report a confusing test failure.
  try {
    const whichPath = execFileSync('which', ['codex'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return whichPath || null
  } catch {
    return null
  }
}

const CODEX_BIN = resolveCodexBinary()
const SHOULD_RUN = FORCE || CODEX_BIN !== null

if (!SHOULD_RUN) {
  console.log(
    '[codex-spawn-integration] Skipped — install codex CLI or set ' +
    'RUN_CODEX_INTEGRATION=1 to run.',
  )
  // No tests registered → file passes vacuously.
} else if (!CODEX_BIN) {
  console.log(
    '[codex-spawn-integration] Skipped — RUN_CODEX_INTEGRATION=1 but codex ' +
    'binary not found in BINARY_CANDIDATES.',
  )
} else {

  // ─── constants ──────────────────────────────────────────────────────────

  // Clap exits 2 on argv parse failure; this is the load-bearing assertion.
  const CLAP_PARSE_ERROR_EXIT = 2

  // Stderr fragments that indicate codex rejected our argv at parse time.
  // Matching either is a hard failure — this is exactly the bug class #3873
  // was filed to catch.
  const PARSE_ERROR_FRAGMENTS = [
    'unexpected argument',
    'error: invalid value',
    'error: the argument',
    'error: a value is required',
  ]

  // How long we let codex run before killing it. Long enough for clap to parse
  // and for the first JSONL line (`thread.started`) to flush when auth is
  // present; short enough to keep the test snappy in CI.
  const SPAWN_GRACE_MS = 6_000

  // A trivial prompt — small enough that even if the network round-trip
  // does start, we are not racking up tokens.
  const TRIVIAL_PROMPT = 'reply with the single word OK and nothing else'

  // A syntactically valid UUID for the `resume` form. Codex silently falls
  // back to a fresh thread when the id is unknown (documented in
  // codex-session.js), so this still exercises the resume-form argv parse.
  const DUMMY_THREAD_ID = '00000000-0000-4000-8000-000000000000'

  // ─── helpers ────────────────────────────────────────────────────────────

  /**
   * Spawn codex with the given argv, collect stdout/stderr, and either:
   *  - resolve early on the first stdout line (so we can assert thread.started
   *    without paying the full turn duration), then kill the child, OR
   *  - kill the child after SPAWN_GRACE_MS if no output arrives.
   *
   * Returns `{ exitCode, signal, firstStdoutLine, stderr, spawnError }`.
   *
   * `spawnError` is non-null when the OS rejected the spawn outright (ENOENT,
   * EACCES, chdir failure). assertArgvAccepted() promotes any non-null
   * `spawnError` to a hard failure so spawn-level breakage is never masked
   * as "argv accepted".
   */
  function spawnCodexAndWait(argv, { graceMs = SPAWN_GRACE_MS } = {}) {
    return new Promise((resolve) => {
      const child = spawn(CODEX_BIN, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Run in a tmp cwd so we don't accidentally touch the test repo.
        // `--skip-git-repo-check` is always in argv so cwd choice doesn't gate
        // execution, but keeping it neutral avoids any per-cwd config lookup.
        cwd: '/tmp',
      })

      let firstStdoutLine = null
      let stderr = ''
      let killTimer = null
      let earlyKill = false
      let spawnError = null
      let settled = false

      const settle = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        try { rl.close() } catch { /* already closed */ }
        resolve(payload)
      }

      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        if (firstStdoutLine === null) {
          firstStdoutLine = line
          // Got what we needed — terminate the child. We don't need to wait
          // for the full network turn to validate argv parsing.
          earlyKill = true
          try { child.kill('SIGTERM') } catch { /* already gone */ }
        }
      })
      // Drain — without a listener, large stderr could backpressure & block.
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf-8')
      })

      killTimer = setTimeout(() => {
        earlyKill = true
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }, graceMs)

      child.on('close', (code, signal) => {
        settle({
          exitCode: code,
          signal,
          firstStdoutLine,
          stderr,
          earlyKill,
          spawnError,
        })
      })

      child.on('error', (err) => {
        // Capture so assertArgvAccepted() can promote this to a hard failure
        // instead of silently treating `exitCode === null` as "argv accepted".
        spawnError = err
        settle({
          exitCode: null,
          signal: null,
          firstStdoutLine: null,
          stderr: `spawn error: ${err.message}`,
          earlyKill: false,
          spawnError: err,
        })
      })
    })
  }

  /**
   * Fail with a descriptive message if codex's stderr contains a clap
   * argv-rejection fragment. This is the core regression assertion: PR #3867's
   * misordered `--sandbox` flag on the resume subcommand surfaced as
   * `error: unexpected argument '--sandbox' found` on stderr.
   *
   * Also promotes OS-level spawn failures (ENOENT, EACCES, chdir) to hard
   * failures — without this, `child.on('error')` resolves with
   * `exitCode === null` and the `exitCode !== 2` check would silently treat a
   * never-started process as "argv accepted".
   */
  function assertArgvAccepted(result, argv, formLabel) {
    const trimmedStderr = result.stderr.trim()

    // Spawn-level failure (the OS rejected `spawn()` outright). This is NOT
    // an argv-acceptance signal — fail loudly so a broken codex install or a
    // bad CWD doesn't masquerade as a passing test.
    if (result.spawnError) {
      assert.fail(
        `[${formLabel}] codex failed to spawn (OS-level error, not an argv decision).\n` +
        `  argv: ${JSON.stringify(argv)}\n` +
        `  error: ${result.spawnError.message}\n` +
        `  stderr:\n${trimmedStderr}`,
      )
    }

    // No exit code AND no signal — the child neither exited nor was killed.
    // Should be unreachable given the SPAWN_GRACE_MS timer, but defend
    // against a future regression where the timer is removed.
    if (result.exitCode === null && result.signal === null) {
      assert.fail(
        `[${formLabel}] codex child resolved without an exit code or signal — ` +
        `assertion cannot determine whether argv was accepted.\n` +
        `  argv: ${JSON.stringify(argv)}\n` +
        `  stderr:\n${trimmedStderr}`,
      )
    }

    for (const fragment of PARSE_ERROR_FRAGMENTS) {
      if (trimmedStderr.includes(fragment)) {
        assert.fail(
          `[${formLabel}] codex argv parser rejected our argv.\n` +
          `  argv: ${JSON.stringify(argv)}\n` +
          `  fragment matched: "${fragment}"\n` +
          `  full stderr:\n${trimmedStderr}\n\n` +
          `This is the #3873 bug class — chroxy is passing a flag in the wrong ` +
          `subcommand scope. Check buildCodexArgs() in codex-session.js.`,
        )
      }
    }

    // Clap exits 2 specifically for argv parse errors. Any other exit code
    // (including 0, 1, 130 from SIGTERM, etc.) means we got past argv parsing,
    // which is all this contract test cares about.
    assert.notEqual(
      result.exitCode,
      CLAP_PARSE_ERROR_EXIT,
      `[${formLabel}] codex exited with clap parse-error code ${CLAP_PARSE_ERROR_EXIT}.\n` +
      `  argv: ${JSON.stringify(argv)}\n` +
      `  stderr:\n${trimmedStderr}`,
    )
  }

  // ─── tests ──────────────────────────────────────────────────────────────

  describe('Codex spawn-and-assert integration (#3873)', () => {
    before(() => {
      console.log(`[codex-spawn-integration] Using binary: ${CODEX_BIN}`)
    })

    // Pin the negative case: if a future refactor flips --sandbox onto the
    // resume subcommand again, this test reproduces the #3867 bug. We pre-
    // build the broken argv by hand (NOT via buildCodexArgs) and assert that
    // the parser rejects it — proving the spawn-based assertion above would
    // actually catch the regression.
    it('sanity check: a deliberately-broken argv IS rejected by clap (proves the harness)', async () => {
      const brokenArgv = [
        'exec', 'resume', DUMMY_THREAD_ID, TRIVIAL_PROMPT,
        '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      ]
      const result = await spawnCodexAndWait(brokenArgv)
      assert.ok(
        result.stderr.includes('unexpected argument'),
        `expected clap to reject --sandbox on resume subcommand, got:\n${result.stderr}`,
      )
      assert.equal(
        result.exitCode, CLAP_PARSE_ERROR_EXIT,
        `expected exit ${CLAP_PARSE_ERROR_EXIT} from clap parse error, got ${result.exitCode}`,
      )
    })

    it('first-turn argv (no model, no thread) is accepted by clap', async () => {
      const argv = buildCodexArgs(TRIVIAL_PROMPT, null)
      const result = await spawnCodexAndWait(argv)
      assertArgvAccepted(result, argv, 'first-turn / no-model')
    })

    it('first-turn argv with model override is accepted by clap', async () => {
      const argv = buildCodexArgs(TRIVIAL_PROMPT, 'gpt-5-codex')
      const result = await spawnCodexAndWait(argv)
      assertArgvAccepted(result, argv, 'first-turn / with-model')
    })

    it('resume argv (no model) is accepted by clap', async () => {
      const argv = buildCodexArgs(TRIVIAL_PROMPT, null, DUMMY_THREAD_ID)
      const result = await spawnCodexAndWait(argv)
      assertArgvAccepted(result, argv, 'resume / no-model')
    })

    it('resume argv with model override is accepted by clap', async () => {
      const argv = buildCodexArgs(TRIVIAL_PROMPT, 'gpt-5-codex', DUMMY_THREAD_ID)
      const result = await spawnCodexAndWait(argv)
      assertArgvAccepted(result, argv, 'resume / with-model')
    })

    // Strong-form assertion from the issue ACs: stdout begins with
    // `{"type":"thread.started"`. This requires working auth (either
    // OPENAI_API_KEY or a stored ChatGPT login). When neither is present
    // the first stdout line never arrives within SPAWN_GRACE_MS — that is
    // not a regression in chroxy's argv contract, so we skip rather than fail.
    it('first-turn stdout begins with thread.started JSONL (when auth is configured)', async (t) => {
      const argv = buildCodexArgs(TRIVIAL_PROMPT, null)
      const result = await spawnCodexAndWait(argv)
      assertArgvAccepted(result, argv, 'first-turn / no-model (strong)')

      if (result.firstStdoutLine === null) {
        t.skip(
          'No stdout produced within grace window — Codex auth likely not ' +
          'configured in this environment. argv parse contract still verified ' +
          'by earlier assertions.',
        )
        return
      }

      assert.ok(
        result.firstStdoutLine.startsWith('{"type":"thread.started"'),
        `expected first stdout line to start with thread.started JSONL, got:\n` +
        `  ${result.firstStdoutLine}`,
      )
    })
  })
}
