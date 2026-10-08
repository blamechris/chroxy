#!/usr/bin/env node
/**
 * harness-case-floor.test.mjs — every hand-rolled test harness in this repo
 * must go RED when its cases stop executing (#7653).
 *
 * THE DEFECT. A harness that counts its own cases and exits on `fail > 0`
 * reports success when NO case ran at all: "all cases passed" and "no case
 * executed" are the same observable outcome — the second recurring cause in
 * docs/false-safety-guards.md. Measured before this landed: eleven of the
 * repo's sixteen hand-rolled harnesses printed their normal summary with every
 * counter at zero and exited 0. One of them, merge-updater-feeds.test.sh,
 * guards the release updater-feed merge that #7504 was filed about, so a
 * silently-empty run there restores exactly the blind spot #7504 closed.
 *
 * WHY THIS FILE EXISTS AND NOT JUST THE ELEVEN FLOORS. Adding a floor and
 * proving it fires are two different pieces of work, and only removing the
 * floor tells them apart. The floors are five lines each in sixteen files; a
 * seventeenth harness would arrive with none, and nothing would notice. So the
 * roster is ENUMERATED from git rather than typed here, and each harness is
 * proven BEHAVIOURALLY — its counters are neutered in a copy and the copy must
 * go red. Nothing here matches a harness's source text against an expected
 * spelling: a guard that reads prose as configuration is satisfiable by prose
 * (#7290/#7291), and the two floor idioms already in the tree (an EQUAL
 * `EXPECTED_CASES` for harnesses that enumerate their cases literally, a
 * lower-bound `MIN_CASES` for those whose case count is derived from the tree)
 * would have needed a roster of accepted spellings. Behaviour needs none: both
 * idioms go red when the count reaches zero, which is the property under test.
 *
 * THE NEUTER. One regex per language, applied by this file — NOT a pattern each
 * harness declares about itself. A self-declared pattern is an expectation
 * derived from its own subject (#7424), and it is worse than that here: a
 * harness could declare `^EXPECTED_CASES=` and satisfy every assertion below
 * while every case still ran. This file chooses the pattern, and the harnesses
 * must be neuterable by it — a harness that is not goes red rather than being
 * exempted.
 *
 * WHY "REPORTED ZERO", NOT "REPORTED FEWER". A regex that matches only SOME of
 * a harness's increments still drives the count below its floor, so the floor
 * still fires and a "fewer than expected" assertion would pass while the neuter
 * silently rotted. Requiring exactly zero is what makes a stale regex loud:
 * measured, the first version of the shell pattern was line-anchored and missed
 * every increment written inside a one-line function body — docker-entrypoint
 * reported all 5 cases and parse-check-shell 11 of 25, both of which this
 * assertion caught and a "fewer" assertion would not have.
 *
 * ONE HARNESS OF THIS CLASS IS OUT OF THIS ROSTER, and it is FLOORED ANYWAY
 * (#7657, closed). packages/server/tests/smoke-test.mjs counts its own cases and
 * ci.yml invokes it directly, but it is neither named `*.test.mjs` nor
 * shebanged, and it needs Playwright and a live server — which this job
 * deliberately has neither of, so a neutered copy run HERE would die for a
 * reason unrelated to its floor, the very failure the "exactly one floor line"
 * assertion below rejects.
 *
 * What resolved that is EXTRACTING THE VERDICT rather than relaxing the roster:
 * the floor lives in `packages/server/tests/helpers/harness-floor.mjs`, a pure
 * function with no browser, no server and no filesystem, and its red proof is
 * `packages/server/tests/smoke-test-floor.test.js` — which runs in the ordinary
 * server suite, on every platform, rather than only inside the job it guards.
 * That file also pins the WIRING, because four cases exercising the pure
 * function would all stay green against a harness that imported it and then
 * exited on `failed > 0` regardless.
 *
 * ITS BLIND SPOT, STATED. A case that stops executing but is still COUNTED — a

 * case converted into a reported skip — satisfies every floor here.
 * lint-no-raw-color-literals.test.sh is the live instance: break its locale
 * probe and its three collation cases become three skips, the sum still reaches
 * 8, and this guard is green. That is a positive control on the probe, a
 * different guard, and it is filed rather than implied.
 *
 * Run from anywhere:  node scripts/__tests__/harness-case-floor.test.mjs
 * Exit status: 0 if all cases pass, 1 otherwise.
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The marker that keeps this file out of its OWN behavioural pass, and — the
 * reason it is a marker and not a filename — out of any COPY of itself. A
 * neutered copy of this guard re-enumerates and re-neuters the whole roster; if
 * the exclusion were by name the copy would not recognise itself, would neuter
 * the original, and the recursion would not terminate. Content travels with the
 * copy; a name does not.
 *
 * The literal must appear in this file for the exclusion to find it, which is
 * why it is written out rather than assembled from pieces: the first version
 * concatenated two halves to keep the token out of the prose above, and then
 * matched nothing at all.
 */
const SELF_MARKER = 'HARNESS_FLOOR_META_GUARD'

/**
 * A floor on the ENUMERATION, not a count of today's harnesses.
 *
 * `git ls-files '<glob>'` prints nothing and exits 0 under an inherited
 * GIT_NOGLOB_PATHSPECS or GIT_LITERAL_PATHSPECS, and NARROWS to the subtree
 * when run from a subdirectory — measured in this repo, the pathspec vars
 * return 0 rows and `scripts/__tests__` returns 16 against 18 from the root.
 * Zero rows would satisfy every per-harness assertion below vacuously,

 * which is #7503's shape (a filter whose terms match nothing, and a gate
 * satisfied by the empty result) reproduced inside the guard written for that
 * catalogue. The cwd and the environment are pinned below; this is the backstop
 * for whatever pins are missed.
 *
 * Deliberately loose — the roster is seventeen today (sixteen proven harnesses
 * plus this file). A number tracking the live count would be a hardcoded list
 * beside a growing set, the first cause in the catalogue.
 *
 * It is the SECOND line of defence, not the first: a floor with headroom cannot
 * notice one harness leaving the roster, which is why EXCLUDED_HARNESSES below
 * is asserted equal. This catches an enumeration that has collapsed; that
 * catches one that has merely leaked.
 */
const MIN_HARNESSES = 12


/** One case per harness, plus the fixed cases below. */
const FIXED_CASES = 17

/**
 * WHAT COUNTS AS A SUBJECT, and why it is the shebang.
 *
 * A tracked `*.test.sh` / `*.test.mjs` is in the roster when its first line
 * declares an interpreter — and the interpreter that runs it is READ FROM that
 * line, not inferred from the extension. That is the difference between a
 * marker this guard matches and a declaration it obeys: a file saying
 * `#!/usr/bin/env bash` is asserting that it is executed directly, which is
 * exactly the class that owns its own exit status and can therefore report
 * success over zero cases.
 *
 * The boundary is not cosmetic. `packages/store-core/scripts/__tests__/
 * export-targets.test.mjs` is a vitest suite: it declares no interpreter, is
 * found by a runner's glob, and crashes under bare `node`. Its zero-test
 * behaviour is #7447's class — a RUNNER exiting 0 on an empty discovery — which
 * scripts/lib/assert-test-count.mjs guards, one layer up from here. Folding it
 * in would have meant a roster of exceptions; reading the shebang means the
 * distinction derives itself. It was found by this guard on its first run,
 * against a roster the author had scoped by hand and got wrong.
 *
 * BOTH SPELLINGS OF A SHEBANG, and the exclusions are ASSERTED rather than
 * printed. The first version of this rule accepted only `#!/usr/bin/env bash`,
 * which is a comment describing a general boundary in front of a code path that
 * hardcoded two strings — the #7290/#7291 shape, in the guard written for this
 * catalogue. `#!/bin/bash` is an ordinary form and five tracked scripts here
 * already use it. Measured on the narrow version: rewriting two harnesses'
 * shebangs to `#!/bin/bash` dropped them from the roster and the guard printed
 * `20 passed, 0 failed`, rc=0 — including merge-updater-feeds.test.sh, the one
 * this file's own header names. Nothing caught it, because the summary floor's
 * `expected` is derived from `subjects.length`, so it SELF-ADJUSTED from 22 to
 * 20: a coverage check whose expectation comes from its own subject, which is
 * `#7424` and is named in this repo's own list of recurring causes.
 *
 * Widening the regex closes today's instance. What closes the CLASS is
 * EXCLUDED_HARNESSES below: the roster's complement is asserted equal to a
 * written list, so a file leaving the roster for any reason — a new shebang
 * spelling, a rename, a glob that stops matching — has to be justified in a
 * diff. An exclusion set is the one place a hardcoded list is the correct
 * shape: the danger with a list beside a growing set is that it fails to grow,
 * and here failing to grow is exactly what must go red.
 */
const SHEBANG = /^#!(?:\/usr\/bin\/env[ \t]+|\/(?:usr\/)?bin\/)(bash|node)[ \t]*$/

/**
 * Tracked `*.test.sh` / `*.test.mjs` that are deliberately NOT proven here,
 * each with the reason. Asserted EQUAL to what the enumeration actually skips.
 *
 * `export-targets.test.mjs` is a vitest suite: it declares no interpreter, is
 * found by a runner's glob, and crashes under bare `node`. Its zero-test
 * behaviour is #7447's class — a RUNNER exiting 0 on an empty discovery — which
 * scripts/lib/assert-test-count.mjs guards, one layer up from here.
 */
const EXCLUDED_HARNESSES = [
  // Uses node:test, not hand-rolled verdict counters. Dashboard Smoke checks
  // its TAP summary with assert-test-count.mjs (minimum 15 browser cases).
  'packages/dashboard/scripts/tool-layout.test.mjs',
  // node:test as well (#7324): ci.yml's desktop-tests job runs it by name and
  // checks its TAP summary with assert-test-count.mjs (minimum 19 cases).
  'packages/desktop/scripts/__tests__/derive-server-lockfile.test.mjs',
  // node:test too (#7986): the same desktop-tests job runs it by name and
  // checks its TAP summary with assert-test-count.mjs (exact floor: 36 cases,
  // the real non-root suite count — #7986 review N7).
  'packages/desktop/scripts/__tests__/find-macho.test.mjs',
  'packages/store-core/scripts/__tests__/export-targets.test.mjs',
]


/**
 * Shell counters. NOT line-anchored: `pass() { PASS=$((PASS + 1)); echo ...; }`
 * puts the increment mid-line, and an anchored version of this pattern left
 * docker-entrypoint.test.sh reporting all five of its cases.
 */

const SHELL_INCREMENT = /(?:PASS|FAIL|SKIP)=\$\(\((?:PASS|FAIL|SKIP) \+ [0-9]+\)\)/g

/**
 * JS counters. Longest alternatives first, so `passed++` is not matched as
 * `pass` followed by an unmatchable `ed++`. `failures.push(...)` is not matched:
 * the name must be followed by `++` or `+=`.
 */
const JS_INCREMENT = /(?:passed|failed|skipped|pass|fail)[ \t]*(?:\+\+|\+=[ \t]*\d+)/g

/** The one line every floor in the repo prints, in either idiom. */
const FLOOR_LINE = /^HARNESS BROKEN: ran (\d+) cases?, expected (?:at least )?(\d+)/gm

/** Floor constants, whose declarations the neuter must leave untouched. */
const FLOOR_CONSTANT = /^.*\b(?:EXPECTED_CASES|MIN_CASES)\s*=.*$/gm

/**
 * A GIT_* variable inherited from the caller redirects or narrows every
 * `git ls-files` below, and a missing GIT_INDEX_FILE reads as an EMPTY index at
 * exit 0 — "found nothing" wearing "nothing wrong". The same scrubbed
 * environment is handed to the harness copies, because it is the environment CI
 * gives them.
 */
const CLEAN_ENV = { ...process.env }
for (const k of [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS', 'CDPATH',
]) delete CLEAN_ENV[k]

/**
 * Probe copies are removed in a `finally`, which covers a normal exit and a
 * throw but NOT a signal — and a job killed at its timeout is a signal. GitHub
 * Actions sends SIGTERM before SIGKILL, so the handlers below are what turn
 * "cancelled" into "cancelled and cleaned up"; against SIGKILL nothing can, and
 * the copies are untracked and name-shaped so that they cannot enter the roster
 * even if they survive.
 */
const liveProbes = new Set()
const sweepProbes = () => { for (const p of liveProbes) rmSync(p, { force: true }) }
process.on('exit', sweepProbes)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { sweepProbes(); process.exit(1) })
}

let pass = 0
let fail = 0
const failures = []

const test = async (name, fn) => {
  try {
    await fn()
    pass++
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/**
 * Per-harness wall-clock budget (#8498).
 *
 * This was 60s, and 60s is what killed the guard. check-dist-drift.test.sh
 * runs about 54s ALONE on a quiet 16-core laptop (builds and git operations,
 * mostly waiting on process spawns), and this file runs CONCURRENCY harnesses
 * at once, so on a loaded runner it crossed 60s routinely. Measured: four
 * copies of this guard run side by side on one machine failed on that harness,
 * all four, at its H7/H8 mutant cases, and the CI step for the same guard took
 * a flat 60.0s on a PASSING main run — it was riding the limit.
 *
 * The kill was also INVISIBLE. execFile reports a timeout kill as
 * `err.code === null`, which `?? 1` turned into exit 1, and the assertion
 * below then said "died for some other reason". So the failure read as a
 * harness that crashed, at a different case every time, when it was a harness
 * that was cut off. The outcome now carries `timedOut` and `signal`, and
 * assertGoesRed says which one it was.
 *
 * 120s is not "long enough that it never happens": it is the budget that fits
 * the job. The Scripts Tests job has timeout-minutes: 5 (300s) and this step
 * starts 106-130s into it (measured on CI), so a genuinely wedged harness is
 * reported here, as a named timeout, at 130 + 120 + 2 (SIGKILL delay) + 5
 * (report grace) = 257s at the latest — before GitHub cancels the job and
 * renders it as a failure with no diagnostic. 150s was the first value and it
 * put that figure at ~284s of 300s, with the arithmetic in this comment wrong
 * (2m07s + 150s is 4m37s, not the 4m17s it said). The relationship is now
 * ASSERTED against ci.yml by a case below rather than described, so a slower
 * setup or a raised budget cannot silently cross it. 120s is 2.2x the 54s
 * worst case measured alone and still clear of the 74s measured under 4-way
 * load.
 */
const HARNESS_TIMEOUT_MS = 120_000
/** Delay between SIGTERM and SIGKILL to the harness's process group. */
const KILL_DELAY_MS = 2_000
/** After a timeout, how long to wait for the pipes to close before reporting anyway. */
const REPORT_GRACE_MS = 5_000
/** Where in the job's 300s this step starts, worst case measured on CI (106-130s). */
const STEP_START_WORST_MS = 130_000

/**
 * Run a child to completion or to its timeout and report HOW it ended.
 *
 * The child leads its own process group and the whole group is killed on
 * timeout. execFile's own `timeout` kills only the direct child: a harness is a
 * bash script whose builds and `sleep`s are grandchildren that keep the stdout
 * pipe open, so the callback waits for them and the "timeout" does not end the
 * run. SIGKILL after SIGTERM because a harness with a `trap ... TERM` (several
 * of them are about signals) can ignore the first.
 */
const run = (cmd, args, cwd, timeoutMs = HARNESS_TIMEOUT_MS) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(cmd, args, { cwd, env: CLEAN_ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let timedOut = false
  let spawnFailed = false
  let finished = false
  const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { /* already gone */ } }
  const finish = (code, signal, extra = '') => {
    if (finished) return
    finished = true
    clearTimeout(term)
    // Let go of the pipes. A straggler that left the group (setsid) still holds
    // the other end, and an open read end keeps THIS process alive for as long
    // as the straggler lives — measured, a report at 6s and an exit at 25s.
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
    const pipesReleased = !child.stdout || (child.stdout.destroyed && child.stderr.destroyed)
    // `code` is null when a signal ended the child. Keep it null rather than
    // coercing it to 1: a signal and an exit are different facts.
    resolve({ code, signal, timedOut, spawnFailed, pipesReleased, budgetMs: timeoutMs, ms: Date.now() - started, out: out + extra })
  }
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const term = setTimeout(() => {
    timedOut = true
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), KILL_DELAY_MS).unref()
    // A grandchild that left the group (a harness that tests setsid, as
    // run-with-timeout.test.sh does) can hold the pipes open, so 'close' never
    // fires. Measured: a 20s budget on that harness ended at 56s. Report the
    // timeout on time rather than whenever the stragglers let go.
    setTimeout(() => finish(null, 'SIGTERM'), REPORT_GRACE_MS).unref()
  }, timeoutMs)
  child.on('error', (err) => { spawnFailed = true; finish(1, null, `spawn failed: ${err.message}`) })
  child.on('close', (code, signal) => {
    killGroup('SIGKILL') // anything the harness left behind
    finish(code, signal)
  })
})

/**
 * Neuter one harness's counters in a sibling copy, run it, and report what
 * happened. The copy is a SIBLING because every harness resolves the repo root
 * from its own location (`dirname "$0"/../..`, `import.meta.url`): a copy under
 * /tmp resolves to the wrong root, and the harness then dies for a reason that
 * has nothing to do with its floor — a green guard proving nothing.
 *
 * The copy's name cannot match the `*.test.sh` / `*.test.mjs` globs the roster
 * is enumerated with, and it is untracked besides, so it can never enter the
 * roster. It is removed in a `finally`, so a run killed at the job's timeout
 * still leaves nothing behind.
 */
const neuterAndRun = async ({ path: relPath, interpreter }) => {
  const abs = join(REPO_ROOT, relPath)
  const isShell = interpreter === 'bash'
  const src = readFileSync(abs, 'utf8')
  let substitutions = 0
  const neutered = src.replace(isShell ? SHELL_INCREMENT : JS_INCREMENT, () => {
    substitutions++
    return isShell ? ':' : 'void 0'
  })
  const copy = abs.replace(/\.test\.(sh|mjs)$/, `.floor-probe.${process.pid}.$1`)
  liveProbes.add(copy)
  try {
    writeFileSync(copy, neutered)
    // The interpreter the FILE declared, not one derived from its extension.
    const outcome = await run(isShell ? 'bash' : process.execPath, [copy], dirname(abs))
    return { substitutions, ...outcome, neutered, src }
  } finally {
    rmSync(copy, { force: true })
    liveProbes.delete(copy)
  }

}

/**
 * The assertions, factored out so the positive control below drives them
 * through the same code the real harnesses do. A control that exercises a
 * different path is not a control.
 */
const assertGoesRed = ({ substitutions, code, signal, timedOut, spawnFailed, budgetMs, ms, out, neutered, src }, label) => {
  assert(substitutions > 0,
    `${label}: the neuter matched no counter increment — it cannot have stopped anything from counting. ` +
    'Either this harness counts its cases in a spelling the pattern does not know, or the pattern has rotted.')
  assert(JSON.stringify(src.match(FLOOR_CONSTANT)) === JSON.stringify(neutered.match(FLOOR_CONSTANT)),
    `${label}: the neuter altered a floor constant. It must silence the COUNTERS; a "proof" that ` +
    'lowers the expected number instead would pass while every case still ran.')
  assert(code !== 0, `${label}: exited 0 with its counters silenced — no floor fired`)
  const tail = out.trim().split('\n').slice(-3).join(' / ')
  // The two ways a harness can be stopped from OUTSIDE are named before the
  // floor line is looked for, because neither says anything about the floor: a
  // run that was cut off never got the chance to print it (#8498). Reporting
  // that as "exited without a floor line" sent the investigation to a harness
  // that had not misbehaved.
  assert(!spawnFailed,
    `${label}: FAILED TO SPAWN — the harness never started, so nothing about its floor was measured. ` +
    `Output tail: ${tail}`)
  assert(!timedOut,
    `${label}: KILLED BY TIMEOUT after ${Math.round(ms / 1000)}s (signal ${signal ?? 'none'}), before it reached its ` +
    `floor — this is the harness being slow or wedged, not its floor failing to fire. Budget is ` +
    `${Math.round(budgetMs / 1000)}s per harness. Output tail: ${tail}`)
  assert(signal === null || signal === undefined,
    `${label}: KILLED BY SIGNAL ${signal} after ${Math.round(ms / 1000)}s without a timeout — something outside ` +
    `this guard stopped the harness (OOM killer, a cancelled job, a stray kill). Output tail: ${tail}`)
  const hits = [...out.matchAll(FLOOR_LINE)]
  assert(hits.length === 1,
    `${label}: expected exactly one floor line, saw ${hits.length}. The harness EXITED on its own with code ` +
    `${code} after ${Math.round(ms / 1000)}s, not killed by a timeout or a signal, and never printed its floor. ` +
    `Output tail: ${tail}`)
  assert(hits[0][1] === '0',
    `${label}: floor fired but the harness still counted ${hits[0][1]} cases — the neuter reached only ` +
    'some of its increments, so this proves nothing about the rest.')
  assert(Number(hits[0][2]) > 0, `${label}: floor expects ${hits[0][2]} cases, which no run can fall below`)
}

// ---------------------------------------------------------------------------
// Case 1-2: the roster. Enumerated from git, from the repo root, with the
// pathspec environment scrubbed — and floored, because every one of those pins
// fails to zero rows at exit 0 rather than to an error.
// ---------------------------------------------------------------------------

let roster = []
let selfMatches = []

await test('the harness roster enumerates from git and clears its floor', () => {
  const raw = execFileSync('git', ['ls-files', '-z', '*.test.sh', '*.test.mjs'],
    { cwd: REPO_ROOT, env: CLEAN_ENV, encoding: 'utf8' })
  const tracked = raw.split('\0').filter(Boolean)
  const skipped = []
  for (const path of tracked) {
    const first = readFileSync(join(REPO_ROOT, path), 'utf8').split('\n', 1)[0]
    const m = SHEBANG.exec(first)
    if (m) roster.push({ path, interpreter: m[1] })
    else skipped.push(path)
  }
  // ASSERTED, not printed. Printing a dropped harness and carrying on is how
  // the narrow version of SHEBANG lost merge-updater-feeds.test.sh in silence.
  assert(JSON.stringify(skipped) === JSON.stringify(EXCLUDED_HARNESSES),
    `the set of tracked test files this guard does NOT prove has changed.\n  skipped:  ${JSON.stringify(skipped)}\n  ` +
    `expected: ${JSON.stringify(EXCLUDED_HARNESSES)}\nA file leaving the roster is the failure this assertion exists ` +
    'for: the summary floor below derives its expectation from the roster, so a silent drop lowers the bar it is ' +
    'measured against. Add it to EXCLUDED_HARNESSES with a reason, or give it a shebang.')
  assert(roster.length >= MIN_HARNESSES,
    `enumerated only ${roster.length} harnesses, expected at least ${MIN_HARNESSES} — the enumeration is ` +
    'broken, not the tree. Zero rows at exit 0 is what a narrowed pathspec looks like.')
})


await test('exactly one file is excluded from the behavioural pass, and it is this one', () => {
  selfMatches = roster.filter((h) => readFileSync(join(REPO_ROOT, h.path), 'utf8').includes(SELF_MARKER))
    .map((h) => h.path)
  assert(selfMatches.length === 1,
    `${selfMatches.length} files carry the self-exclusion marker (${selfMatches.join(', ') || 'none'}); ` +
    'exactly one — this guard — may. More than one means a harness has opted itself out of being proven.')
  assert(selfMatches[0].endsWith('harness-case-floor.test.mjs'),
    `the excluded file is ${selfMatches[0]}, not this guard`)
})

// FATAL, not a recorded failure. If this guard cannot recognise itself it
// becomes a subject of its own behavioural pass: it neuters a copy of itself,
// the copy re-enumerates and neuters the tracked original, and so on without
// bound. Measured — a mutation that made the marker a computed value (so the
// literal no longer appeared in the file) ran until it was killed and left 48
// probe copies behind, because a SIGKILLed process runs no `finally`. A false
// precondition must stop the run, not merely be noted while the body proceeds.
if (selfMatches.length !== 1) {
  // A distinct prefix on purpose. The unified "HARNESS BROKEN: ran N cases,
  // expected M" line is machine-read, and emitting it here would mean emitting
  // numbers that say nothing is wrong while claiming something is.
  process.stdout.write('\nHARNESS REFUSED: self-identification failed — refusing to run the behavioural ' +
    'pass, which would recurse into this file.\n')

  process.exit(1)
}

// ---------------------------------------------------------------------------
// Case 3-5: the guard's own red proof. Two synthetic harnesses, identical
// except that one carries a floor, are driven through assertGoesRed — the same
// function the real roster uses. Without the unfloored one, every assertion
// below could be satisfied by a checker that says "red" unconditionally, and
// this file would be the thing it is written to prevent.
// ---------------------------------------------------------------------------

const CONTROL_DIR = mkdtempSync(join(tmpdir(), 'harness-floor-control-'))

/**
 * Three synthetic harnesses, identical but for their floor:
 *
 *   'floored'   — prints the floor line and exits 1. Must be detected.
 *   'unfloored' — no floor at all. Must NOT be detected.
 *   'toothless' — prints the floor line and exits 0 anyway. Must NOT be
 *                 detected either, and it is the one that earns
 *                 `assertGoesRed`'s exit-code assertion its place: with that
 *                 assertion deleted, 'unfloored' still fails (it prints no
 *                 floor line at all) and the whole guard stayed green.
 *                 Measured — a surviving mutant, which is a missing assertion.
 *                 It is also the live shape from #7646, where `rc=1` demoted
 *                 to a `::warning` turned a real sweep into a no-op that
 *                 reported success.
 */
/**
 * The synthetic controls. Each is a three-case harness identical but for how it
 * reports a breach, and EVERY ONE is driven through `assertGoesRed` — the same
 * function the real roster uses. A control that exercises a different path is
 * not a control.
 *
 * There is one control per assertion in `assertGoesRed`, and that is the point:
 * with only "floored" and "unfloored", FIVE of the six assertions could be
 * deleted outright with this file still green, because an unfloored harness is
 * rejected by the very first thing that looks at its output. Each mode below
 * exists to be the ONLY reason its assertion fires.
 *
 *   floored       prints the line, exits 1              -> accepted
 *   unfloored     no floor at all                       -> rejected: no floor line
 *   toothless     prints the line, exits 0 anyway       -> rejected: exit code
 *                 (#7646's "demoted to a warning")
 *   undercount    floor fires but reports a NONZERO ran -> rejected: ran must be 0,
 *                 (the partial-neuter shape)               not merely "fewer"
 *   doubled       prints the floor line twice           -> rejected: exactly one line
 *   zerofloor     expects 0 cases, a bar nothing can    -> rejected: expected > 0
 *                 fall below
 *   unmatched     counts with `((PASS++))`, a spelling  -> rejected: exit code
 *                 the neuter does not know                 (its floor never fires)
 *   faker         same unknown spelling, but PRINTS a   -> rejected: the neuter
 *                 perfect floor line and exits 1            matched nothing
 *                 whatever happens
 *
 * `faker` is the one that makes `substitutions > 0` load-bearing, and it was
 * added because without it that assertion could be deleted with this file still
 * green: `unmatched` is caught by the exit code instead, since a harness whose
 * counters the neuter never touched simply passes and exits 0. `faker` is a
 * harness that emits exactly what a working floor emits while the neuter did
 * nothing at all — the only thing that can tell the difference is whether the
 * neuter actually changed anything.

 *   movable       hides an increment inside its own     -> rejected: the neuter
 *                 EXPECTED_CASES line                      altered a floor constant
 *   wedged        never returns (sleeps), so the        -> rejected, and the message
 *                 control's 3s timeout ends it             must say KILLED BY TIMEOUT
 *   signalled     kills itself with SIGKILL             -> rejected: KILLED BY SIGNAL
 *   crashes       exits 3 before its floor              -> rejected: EXITED on its own
 *   straggler     wedges AND leaves a setsid grandchild -> rejected: KILLED BY TIMEOUT,
 *                 holding the pipes open                   reported inside budget + grace
 *
 * The last four are #8498: a run that was cut off used to be reported as
 * "died for some other reason", which sent the investigation to a harness that
 * had done nothing wrong. They assert the MESSAGE (`mentions`), because each is
 * rejected anyway by "no floor line" and the verdict alone cannot tell them
 * apart from the old wording.
 */
const CONTROL_MODES = {
  floored: { verdict: 'accept' },
  unfloored: { verdict: 'reject', because: 'no floor line' },
  toothless: { verdict: 'reject', because: 'exit code' },
  undercount: { verdict: 'reject', because: 'ran is not zero' },
  doubled: { verdict: 'reject', because: 'more than one floor line' },
  zerofloor: { verdict: 'reject', because: 'expected is zero' },
  unmatched: { verdict: 'reject', because: 'its floor never fires' },
  faker: { verdict: 'reject', because: 'the neuter matched nothing' },

  movable: { verdict: 'reject', because: 'the neuter altered a floor constant' },

  // #8498. These two prove the failure MESSAGE, not just the verdict: both are
  // rejected anyway by "no floor line", so without `mentions` a regression to
  // the old wording ("died for some other reason") would leave them green.
  signalled: { verdict: 'reject', because: 'killed by a signal', mentions: 'KILLED BY SIGNAL' },
  crashes: { verdict: 'reject', because: 'exited on its own, no floor', mentions: 'EXITED on its own with code 3' },

  // `bounded` pins HOW the timeout was carried out, which the verdict cannot:
  //   group    the report arrives promptly (the group kill ended the child, so
  //            'close' fired) and the harness's own grandchild is gone. A
  //            `child.kill()` that reaches only bash leaves `sleep 600` running
  //            and holding the pipe, so the report waits for the fallback.
  //   grace    a grandchild that LEFT the group holds the pipes; the report must
  //            still arrive after REPORT_GRACE_MS and not before the pipes close.
  wedged: { verdict: 'reject', because: 'killed by timeout', mentions: 'KILLED BY TIMEOUT', bounded: 'group' },
  straggler: { verdict: 'reject', because: 'killed by timeout, pipes held', mentions: 'KILLED BY TIMEOUT', bounded: 'grace' },
}

const floorLine = (ran, expected) =>
  `echo "HARNESS BROKEN: ran ${ran} cases, expected ${expected} — a case stopped executing"`

const controlHarness = (mode, pidfile) => {
  // `((PASS++))` is deliberately outside SHELL_INCREMENT's grammar.
  const inc = (mode === 'unmatched' || mode === 'faker')
    ? 'check() { if [ "$2" = "$3" ]; then ((PASS++)); else ((FAIL++)); fi; }'
    : 'check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi; }'

  // Dies before the floor, three different ways. `wedged` never returns (the
  // control's own timeout is what ends it), `signalled` kills itself with a
  // signal no timeout sent, `crashes` exits non-zero on its own.
  const preamble = {
    // The pid goes to a file so the test can prove the grandchild is gone.
    wedged: `sleep 600 & echo $! > "${pidfile}"; wait`,
    // setsid() via perl (not every setsid binary exists on macOS). Its stdout
    // and stderr are the harness's, so it holds the pipes open after the kill.
    straggler: `perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "600"' & echo $! > "${pidfile}"; sleep 600`,
    signalled: 'kill -KILL $$',
    crashes: 'exit 3',
  }[mode] ?? ':'
  const decl = mode === 'movable'
    ? 'EXPECTED_CASES=3 # a stray PASS=$((PASS + 1)) in the declaration line itself'
    : 'EXPECTED_CASES=3'
  let body
  if (mode === 'unfloored') {
    body = '# no floor at all'
  } else if (mode === 'faker') {
    // Emits exactly what a correctly-neutered, correctly-floored harness emits,
    // while its counters were never touched. Only "did the neuter change
    // anything" separates this from the real thing.
    body = `${floorLine('0', '3')}\nexit 1`
  } else {

    const ran = mode === 'undercount' ? '2' : '$((PASS + FAIL))'
    const exp = mode === 'zerofloor' ? '0' : '$EXPECTED_CASES'
    const line = floorLine(ran, exp)
    const emit = mode === 'doubled' ? `${line}\n  ${line}` : line
    body = `if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ] || [ ${mode === 'undercount' ? 1 : 0} -eq 1 ]; then
  ${emit}
  ${mode === 'toothless' ? ': # prints, but does not exit' : 'exit 1'}
fi`
  }
  return `#!/usr/bin/env bash
set -uo pipefail
${decl}
PASS=0
FAIL=0
${inc}
${preamble}
check "a" 1 1
check "b" 1 1
check "c" 1 1
echo "ran $((PASS + FAIL))"
${body}
exit 0
`
}

/** Budget for the controls that are meant to time out; ample for bash to start. */
const CONTROL_TIMEOUT_MS = 3_000

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const readPid = (file) => { try { return Number(readFileSync(file, 'utf8').trim()) || null } catch { return null } }

const runControl = async (mode) => {
  const p = join(CONTROL_DIR, `control-${mode}.sh`)
  const pidfile = join(CONTROL_DIR, `${mode}.pid`)
  writeFileSync(p, controlHarness(mode, pidfile))
  const src = readFileSync(p, 'utf8')
  let substitutions = 0
  const neutered = src.replace(SHELL_INCREMENT, () => { substitutions++; return ':' })
  const np = `${p}.neutered`
  writeFileSync(np, neutered)
  // A wedged control must not wait out the real budget: 3s is ample for bash to
  // start and print nothing, and it is the timeout path that is under test.
  const timeoutMs = (mode === 'wedged' || mode === 'straggler') ? CONTROL_TIMEOUT_MS : HARNESS_TIMEOUT_MS
  // A run() that never reports (a fallback delay mutated to hours) would hang
  // this guard instead of failing it — catalogue entry 17's shape — so the
  // wait itself has a deadline.
  // The deadline is a literal on purpose: built from KILL_DELAY_MS and
  // REPORT_GRACE_MS it would stretch with them, and a mutant that inflates the
  // grace would then wait out its own inflated deadline.
  const deadlineMs = timeoutMs + 20_000
  let deadline
  const outcome = await Promise.race([
    run('bash', [np], CONTROL_DIR, timeoutMs),
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(
        `run() did not report within ${deadlineMs / 1000}s of a ${timeoutMs / 1000}s budget — ` +
        'its timeout path is not bounded')), deadlineMs)
      deadline.unref()
    }),
  ]).finally(() => clearTimeout(deadline))
  return { substitutions, ...outcome, neutered, src, pidfile }
}

/**
 * Returns the assertion message `assertGoesRed` threw, or null if it accepted.
 * A bare `catch {}` would count a CRASH as a correct rejection — the negative
 * controls would then pass while proving nothing, which is the failure they
 * exist to prevent. A non-assertion error is re-thrown.
 */
const rejectionOf = (result, label) => {
  try { assertGoesRed(result, label) } catch (err) {
    if (!(err instanceof Error) || err instanceof TypeError || err instanceof ReferenceError) throw err
    return err.message
  }
  return null
}

for (const [mode, spec] of Object.entries(CONTROL_MODES)) {
  await test(`CONTROL: a synthetic "${mode}" harness is ${spec.verdict}ed${spec.because ? ` (${spec.because})` : ''}`, async () => {
    try {
      const r = await runControl(mode)
      assert(r.neutered !== r.src || mode === 'unmatched' || mode === 'faker',

        `the neuter was a no-op on the ${mode} control — it is not a control`)
      const why = rejectionOf(r, `synthetic-${mode}`)
      if (spec.verdict === 'accept') {
        assert(why === null, `assertGoesRed rejected the well-formed control: ${why}`)
      } else {
        assert(why !== null,
          `assertGoesRed ACCEPTED the "${mode}" control, which it must reject on ${spec.because}. ` +
          'Without this the corresponding assertion can be deleted with the whole guard still green.')
        assert(!spec.mentions || why.includes(spec.mentions),
          `the "${mode}" control was rejected, but not for the stated reason: expected the message to say ` +
          `"${spec.mentions}", got: ${why}`)
      }
      if (spec.bounded === 'group') {
        assert(r.ms < r.budgetMs + 4_500,
          `the timeout path took ${r.ms}ms against a ${r.budgetMs}ms budget: with the group killed the report is ` +
          'immediate, so this is the fallback delay firing — the kill did not end the process tree.')
        const pid = readPid(r.pidfile)
        assert(pid, 'the wedged harness never recorded its grandchild pid, so "it is gone" proves nothing')
        for (let i = 0; i < 20 && pidAlive(pid); i++) await new Promise((res) => setTimeout(res, 100))
        assert(!pidAlive(pid),
          `the wedged harness's grandchild (pid ${pid}) is still running: the timeout killed the shell and ` +
          'left its children, which is what a plain child.kill() does.')
      }
      if (spec.bounded === 'grace') {
        assert(r.ms >= r.budgetMs + REPORT_GRACE_MS - 200 && r.ms < r.budgetMs + REPORT_GRACE_MS + 1_500,
          `reported after ${r.ms}ms against a ${r.budgetMs}ms budget + ${REPORT_GRACE_MS}ms grace — the ` +
          'straggler holds the pipes, so only the grace timer can end the wait, and it must do so on time.')
        // Not observable from the outside: this file ends in process.exit(), so a
        // straggler holding an open pipe cannot keep THIS process alive. It matters
        // to anything that reuses run() without that, and costs one property read.
        assert(r.pipesReleased,
          'the straggler still holds the harness pipes after the report: an open read end keeps a node ' +
          'process alive for as long as the straggler lives (measured: report at 6s, exit at 25s).')
      }
    } finally {
      // Whatever happened above, no sleeping grandchild outlives this case. It
      // runs AFTER the "grandchild is gone" assertion, which is why it is here.
      const pid = readPid(join(CONTROL_DIR, `${mode}.pid`))
      if (pid && pidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  })
}

await test('a harness that cannot be spawned is reported as FAILED TO SPAWN, not as an exit', async () => {
  const r = await run(join(CONTROL_DIR, 'no-such-interpreter'), [], CONTROL_DIR)
  const why = rejectionOf({ substitutions: 1, ...r, neutered: '', src: '' }, 'unspawnable')
  assert(why !== null && why.includes('FAILED TO SPAWN'),
    `expected a rejection saying FAILED TO SPAWN, got: ${why}`)
})

await test('the worst-case timeout path fits inside the Scripts Tests job timeout in ci.yml', () => {
  const yml = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
  const at = yml.search(/^ {4}name: Scripts Tests[ \t]*$/m)
  assert(at >= 0, 'cannot find the "Scripts Tests" job in ci.yml — this check would otherwise pass over nothing')
  const rest = yml.slice(at)
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:[ \t]*$/m)
  const block = next > 0 ? rest.slice(0, next) : rest
  assert(block.includes('harness-case-floor.test.mjs'),
    'the Scripts Tests job block does not run this guard, so its timeout-minutes is not the one bounding it')
  const m = /^ {4}timeout-minutes:[ \t]*(\d+)[ \t]*$/m.exec(block)
  assert(m, 'the Scripts Tests job declares no timeout-minutes this guard can read')
  const jobMs = Number(m[1]) * 60_000
  const worst = STEP_START_WORST_MS + HARNESS_TIMEOUT_MS + KILL_DELAY_MS + REPORT_GRACE_MS
  assert(worst < jobMs,
    `a wedged harness would be reported at ${worst / 1000}s (step start ${STEP_START_WORST_MS / 1000}s + budget ` +
    `${HARNESS_TIMEOUT_MS / 1000}s + kill ${KILL_DELAY_MS / 1000}s + grace ${REPORT_GRACE_MS / 1000}s), not before ` +
    `the job's ${jobMs / 1000}s timeout cancels it with no diagnostic. Lower the budget or raise timeout-minutes.`)
})

rmSync(CONTROL_DIR, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// One case per harness. Run with bounded concurrency: serially this is the sum
// of every harness's runtime (bump-version.test.sh alone is ~20s), which is
// real wall clock on a job with a five-minute cap.
// ---------------------------------------------------------------------------

const subjects = roster.filter((h) => !selfMatches.includes(h.path))
const CONCURRENCY = 4
const queue = [...subjects]
let slowest = null
const worker = async () => {
  for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
    const result = await neuterAndRun(h)
    if (!slowest || result.ms > slowest.ms) slowest = { path: h.path, ms: result.ms }
    await test(`${h.path} goes red when its cases stop counting`, () => assertGoesRed(result, h.path))
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// --- summary ---------------------------------------------------------------
const ran = pass + fail
const expected = FIXED_CASES + subjects.length
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
// Printed so the margin is visible in every run's log, not only when it is gone:
// a harness creeping toward the budget shows up here, releases before it flakes.
if (slowest) {
  process.stdout.write(`slowest harness: ${slowest.path} ${Math.round(slowest.ms / 1000)}s ` +
    `of a ${HARNESS_TIMEOUT_MS / 1000}s budget\n`)
}
let broken = false
if (fail > 0) {
  for (const f of failures) process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  broken = true
}
if (ran !== expected) {
  process.stdout.write(
    `HARNESS BROKEN: ran ${ran} cases, expected ${expected} — a case stopped executing\n`,
  )
  broken = true
}
process.exit(broken ? 1 : 0)
