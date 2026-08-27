// no-test-force-exit.mjs — the ONE refusal both test harnesses install.
//
// #7400: `--test-force-exit` makes the Node test runner report FEWER TESTS
// THAN IT RAN, non-deterministically, while exiting 0 with `# fail 0`. It is
// the false-safety shape `docs/false-safety-guards.md` catalogues: "ran and
// passed" and "never reported" are the same observable outcome, so every green
// run is worth less than it looks.
//
// ── Measured on this repo, 2026-08-27, node v22.22.3 ────────────────────────
//
// `node --import ./tests/_setup.mjs --experimental-test-module-mocks --test
// tests/base-session.test.js`, a file with 192 tests:
//
//   WITH --test-force-exit:   192 / 165 / 173 / 162 / 154   (all `# fail 0`, exit 0)
//   WITHOUT:                  192 / 192 / 192               (exit 0)
//
// The tests are not skipped — their RESULTS are lost. A root `beforeEach`
// appending one line per test to a side file recorded all 192 on a run whose
// summary said 168.
//
// The mechanism is the process boundary, not the reporter: with
// `--experimental-test-isolation=none` (or running the file in-process, no
// `--test`) the flag reported 192 three times out of three. Under the default
// process isolation the child INHERITS the flag — `process.execArgv` in a child
// reads `["--test-force-exit","--test-force-exit"]` — so the child
// `process.exit()`s as soon as its own root test settles, and whatever it had
// queued for the parent goes with it.
//
// What survives: a real failure. A deliberately failing test placed mid-file
// and at the tail exited 1 on 14 of 14 runs, truncated or not, because the
// child's non-zero exit code reaches the parent regardless. So RED stays
// trustworthy; it is the COUNT, and therefore every GREEN, that does not.
//
// ── Why refusing costs nothing ──────────────────────────────────────────────
//
// The flag existed to paper over leaked handles that kept the runner alive
// (#5480 lore). Those leaks were fixed — #6027 / #6042 / #6100 — and the repo
// has passed the flag nowhere since. Re-measured 2026-08-27, every one of the
// eight files on the #6027 leak map exits on its own without it, and the flag
// buys no wall clock: byok-session 66.5s -> 63.9s, byok-mcp-client 74.9s ->
// 74.9s, tunnel/cloudflare 27.3s -> 27.3s. A file that hangs today is a leak to
// fix, not a flag to add — and CI runs without the flag, so force-exiting
// locally hides exactly the leak CI will hit.
//
// ── Spellings this has to catch ─────────────────────────────────────────────
//
// Node normalises `_` to `-` in option names, so `--test_force_exit` is the
// same flag and lands in `execArgv` spelled with underscores. And node does NOT
// read the value of this boolean: `--test-force-exit=false` still truncates
// (measured 164 / 155 / 159 of 192), so any `=value` form is a hit.
//
// NODE_OPTIONS is scanned too. Node currently rejects the flag there outright
// ("--test-force-exit is not allowed in NODE_OPTIONS"), which means the scan is
// expected to find nothing — but "it cannot happen" silently treated as
// "nothing to check" is its own entry in the catalogue, and an allowlist can
// change under us in a Node upgrade.

// ── Where this is installed ─────────────────────────────────────────────────
//
// Every package whose tests run on `node --test`:
//
//   packages/server        tests/_setup.mjs        (already --import'd)
//   packages/claude-hooks  tests/_setup.mjs        (already --import'd)
//   packages/protocol      --import ./no-test-force-exit-hook.mjs
//   packages/design-tokens --import ./no-test-force-exit-hook.mjs
//
// The first two have a setup module and call `assertNoTestForceExit()` from it;
// the other two have none, so they import the side-effecting hook next door.
// `packages/dashboard` and `packages/store-core` run vitest and `packages/app`
// runs jest — none of them accepts this flag, so there is nothing to refuse.
//
// The limit, stated rather than left to be discovered: a run that skips
// `--import` altogether (`node --test tests/foo.test.js`, no setup module) is
// not reachable from here. Such a run also has no fs write sandbox, which is
// the larger reason not to do it — see `tests/_setup.mjs` and #4633.

export const FORCE_EXIT_OPTION = '--test-force-exit'
export const FORCE_EXIT_ERROR_CODE = 'CHROXY_TEST_FORCE_EXIT'
export const FORCE_EXIT_ALLOW_ENV = 'CHROXY_ALLOW_TEST_FORCE_EXIT'

// The escape hatch takes an explicit AFFIRMATIVE value, not any truthy string.
// `CHROXY_ALLOW_TEST_FORCE_EXIT=0` and `=false` read, to anyone who exported
// them, as "guard on" — and under plain truthiness they turn it off, silently,
// which is the failure this whole module is about.
const ALLOW_VALUES = new Set(['1', 'true', 'yes', 'on'])

/** Is this env value an explicit "yes, waive the refusal"? */
export function isAllowValue (raw) {
  return ALLOW_VALUES.has(String(raw ?? '').trim().toLowerCase())
}

/**
 * Reduce one node CLI argument to its canonical option name: drop any `=value`
 * and fold `_` to `-`, the two transformations node itself applies. Returns the
 * argument unchanged if it is not an option.
 */
export function normalizeNodeOptionName (arg) {
  if (typeof arg !== 'string' || !arg.startsWith('-')) return arg
  const eq = arg.indexOf('=')
  const name = eq === -1 ? arg : arg.slice(0, eq)
  return name.replaceAll('_', '-')
}

/**
 * Find `--test-force-exit` in this process's node options.
 *
 * @returns {{ source: 'execArgv' | 'NODE_OPTIONS', arg: string } | null}
 */
export function findTestForceExit ({ execArgv = process.execArgv, env = process.env } = {}) {
  for (const arg of execArgv ?? []) {
    if (normalizeNodeOptionName(arg) === FORCE_EXIT_OPTION) return { source: 'execArgv', arg }
  }
  // NODE_OPTIONS is whitespace-separated; the flag itself contains no spaces,
  // so a plain split is enough to spot it.
  for (const arg of String(env?.NODE_OPTIONS ?? '').split(/\s+/)) {
    if (arg && normalizeNodeOptionName(arg) === FORCE_EXIT_OPTION) return { source: 'NODE_OPTIONS', arg }
  }
  return null
}

export function forceExitRefusalMessage ({ source, arg }) {
  return (
    `${FORCE_EXIT_ERROR_CODE}: refusing to run the test suite with \`${arg}\` (via ${source}).\n` +
    '\n' +
    '  It does not skip tests — it drops their RESULTS. Measured on\n' +
    '  base-session.test.js (192 tests): 154-192 reported across five runs, every\n' +
    '  one of them `# fail 0`, exit 0. A green run therefore proves nothing about\n' +
    '  which tests ran, which is fatal for mutation testing (#7400).\n' +
    '\n' +
    '  Drop the flag. The leaked handles it worked around were fixed in #6027 /\n' +
    '  #6042, CI has never passed it, and it saves no wall clock. If a file hangs\n' +
    '  after its summary, that is a leaked handle to tear down in the test — the\n' +
    '  same leak CI will hit, which this flag would hide.\n' +
    '\n' +
    `  Deliberately debugging the flag itself? Set ${FORCE_EXIT_ALLOW_ENV}=1 and the\n` +
    '  run proceeds with a warning instead. Only 1/true/yes/on waive it — anything\n' +
    '  else, including 0 and false, still refuses.'
  )
}

/**
 * Throw unless this process was started without `--test-force-exit`.
 *
 * Installed from each package's `tests/_setup.mjs`, which `--import` puts ahead
 * of the test graph — so the refusal lands before a single test in that file
 * runs.
 *
 * WHICH process, precisely, because it is not the obvious one: under the
 * default process isolation `--import` runs in the per-file CHILDREN only. The
 * runner parent never loads it (measured: two children logged the hook, the
 * parent did not), so the parent keeps its own `--test-force-exit` and still
 * force-exits while it aggregates. That is fine — every file fails, the run is
 * red, and the refusals are small enough to survive the parent's exit — but the
 * authoritative signal is the non-zero exit, not the message. With
 * `--experimental-test-isolation=none` it is the other way round: one process,
 * which does load the hook, and where the flag was harmless anyway.
 *
 * @returns {{ allowed: true, found: object } | null} `null` when clean; the
 *   found flag when the escape hatch waived it (a warning is printed).
 */
export function assertNoTestForceExit ({
  execArgv = process.execArgv,
  env = process.env,
  warn = (msg) => process.stderr.write(msg + '\n'),
} = {}) {
  const found = findTestForceExit({ execArgv, env })
  if (!found) return null

  if (isAllowValue(env?.[FORCE_EXIT_ALLOW_ENV])) {
    warn(
      `WARNING: running with \`${found.arg}\` because ${FORCE_EXIT_ALLOW_ENV} is set.\n` +
      '  Test COUNTS from this run are not trustworthy — up to 20% of results are\n' +
      '  dropped silently while the run still exits 0 (#7400).',
    )
    return { allowed: true, found }
  }

  const err = new Error(forceExitRefusalMessage(found))
  err.code = FORCE_EXIT_ERROR_CODE
  throw err
}
