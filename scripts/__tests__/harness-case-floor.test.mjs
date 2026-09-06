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
 * ONE HARNESS OF THIS CLASS IS OUT OF SCOPE, and it is named rather than left
 * to be rediscovered: packages/server/tests/smoke-test.mjs counts its own cases
 * and exits on `failed > 0`, and ci.yml invokes it directly — but it is neither
 * named `*.test.mjs` nor shebanged, and it needs Playwright and a live server,
 * which this job deliberately has neither of. Filed as #7657.
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

import { execFile } from 'node:child_process'
import { execFileSync } from 'node:child_process'
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
const FIXED_CASES = 11

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

const run = (cmd, args, cwd) => new Promise((done) => {
  // 60s, not the job's own 5 minutes. A per-child timeout equal to the job
  // budget can never fire: GitHub cancels the job first, and on this repo's
  // self-hosted runners a cancellation renders as a failure with no diagnostic.
  // The slowest harness measured 13s on the runner, so this is 4x margin and
  // still leaves a wedged harness to be reported by the guard's own
  // "expected exactly one floor line, saw 0" message.
  execFile(cmd, args, { cwd, env: CLEAN_ENV, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },

    (err, stdout, stderr) => done({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }))
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
    const { code, out } = await run(isShell ? 'bash' : process.execPath, [copy], dirname(abs))
    return { substitutions, code, out, neutered, src }
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
const assertGoesRed = ({ substitutions, code, out, neutered, src }, label) => {
  assert(substitutions > 0,
    `${label}: the neuter matched no counter increment — it cannot have stopped anything from counting. ` +
    'Either this harness counts its cases in a spelling the pattern does not know, or the pattern has rotted.')
  assert(JSON.stringify(src.match(FLOOR_CONSTANT)) === JSON.stringify(neutered.match(FLOOR_CONSTANT)),
    `${label}: the neuter altered a floor constant. It must silence the COUNTERS; a "proof" that ` +
    'lowers the expected number instead would pass while every case still ran.')
  assert(code !== 0, `${label}: exited 0 with its counters silenced — no floor fired`)
  const hits = [...out.matchAll(FLOOR_LINE)]
  assert(hits.length === 1,
    `${label}: expected exactly one floor line, saw ${hits.length}. Exit ${code} without one means the ` +
    `harness died for some other reason and its floor was never reached. Output tail: ${out.trim().split('\n').slice(-3).join(' / ')}`)
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
}

const floorLine = (ran, expected) =>
  `echo "HARNESS BROKEN: ran ${ran} cases, expected ${expected} — a case stopped executing"`

const controlHarness = (mode) => {
  // `((PASS++))` is deliberately outside SHELL_INCREMENT's grammar.
  const inc = (mode === 'unmatched' || mode === 'faker')
    ? 'check() { if [ "$2" = "$3" ]; then ((PASS++)); else ((FAIL++)); fi; }'
    : 'check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi; }'

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
check "a" 1 1
check "b" 1 1
check "c" 1 1
echo "ran $((PASS + FAIL))"
${body}
exit 0
`
}

const runControl = async (mode) => {
  const p = join(CONTROL_DIR, `control-${mode}.sh`)
  writeFileSync(p, controlHarness(mode))
  const src = readFileSync(p, 'utf8')
  let substitutions = 0
  const neutered = src.replace(SHELL_INCREMENT, () => { substitutions++; return ':' })
  const np = `${p}.neutered`
  writeFileSync(np, neutered)
  const { code, out } = await run('bash', [np], CONTROL_DIR)
  return { substitutions, code, out, neutered, src }
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
    }
  })
}

rmSync(CONTROL_DIR, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// One case per harness. Run with bounded concurrency: serially this is the sum
// of every harness's runtime (bump-version.test.sh alone is ~20s), which is
// real wall clock on a job with a five-minute cap.
// ---------------------------------------------------------------------------

const subjects = roster.filter((h) => !selfMatches.includes(h.path))
const CONCURRENCY = 4
const queue = [...subjects]
const worker = async () => {
  for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
    const result = await neuterAndRun(h)
    await test(`${h.path} goes red when its cases stop counting`, () => assertGoesRed(result, h.path))
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// --- summary ---------------------------------------------------------------
const ran = pass + fail
const expected = FIXED_CASES + subjects.length
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
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
