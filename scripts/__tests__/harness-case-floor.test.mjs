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
 * `git ls-files '<glob>'` prints nothing and exits 0 from a subdirectory, and
 * again under an inherited GIT_NOGLOB_PATHSPECS or GIT_LITERAL_PATHSPECS —
 * measured in this repo, all three return 0 rows where the repo root returns
 * seven. Zero rows would satisfy every per-harness assertion below vacuously,
 * which is #7503's shape (a filter whose terms match nothing, and a gate
 * satisfied by the empty result) reproduced inside the guard written for that
 * catalogue. The cwd and the environment are pinned below; this is the backstop
 * for whatever pins are missed.
 *
 * Deliberately loose — sixteen harnesses exist today. A number tracking the
 * live count would be a hardcoded list beside a growing set, the first cause in
 * the catalogue.
 */
const MIN_HARNESSES = 12

/** One case per harness, plus the fixed cases below. */
const FIXED_CASES = 6

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
 * The limit, stated: a standalone harness written WITHOUT a shebang is not seen
 * here. It is not invisible to the repo — ci-scripts-tests-registration.test.js
 * independently requires every tracked test file to be invoked by a workflow
 * step or to be discovered by a package runner — but it would carry no proof
 * that its floor fires. Every one of the sixteen has one today.
 */
const SHEBANG = /^#!\/usr\/bin\/env[ \t]+(bash|node)[ \t]*$/

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
  execFile(cmd, args, { cwd, env: CLEAN_ENV, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
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
  // Named, not silently dropped: a harness that loses its shebang leaves the
  // roster, and the only thing that would say so is this line.
  if (skipped.length) process.stdout.write(`       (not standalone, no shebang: ${skipped.join(', ')})\n`)
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
  process.stdout.write('\nHARNESS BROKEN: ran 1 cases, expected 1 — self-identification failed; refusing to ' +
    'run the behavioural pass, which would recurse into this file.\n')
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
const FLOOR_BODY = `if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  echo "HARNESS BROKEN: ran $((PASS + FAIL)) cases, expected $EXPECTED_CASES — a case stopped executing"
  MODE_EXIT
fi`

const controlHarness = (mode) => `#!/usr/bin/env bash
set -uo pipefail
EXPECTED_CASES=3
PASS=0
FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi; }
check "a" 1 1
check "b" 1 1
check "c" 1 1
echo "ran $((PASS + FAIL))"
${mode === 'unfloored'
    ? '# no floor at all — the negative control'
    : FLOOR_BODY.replace('MODE_EXIT', mode === 'toothless' ? ': # prints, but does not exit' : 'exit 1')}
exit 0
`

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

const rejects = (result, label) => {
  try { assertGoesRed(result, label) } catch { return true }
  return false
}

await test('POSITIVE CONTROL: a synthetic floored harness is detected as red', async () => {
  assertGoesRed(await runControl('floored'), 'synthetic-floored')
})

await test('NEGATIVE CONTROL: a synthetic UNFLOORED harness is NOT detected (the check discriminates)', async () => {
  const r = await runControl('unfloored')
  assert(r.substitutions > 0, 'the control neuter matched nothing — the control is not a control')
  assert(r.code === 0, 'an unfloored harness exited nonzero — it is not the control it claims to be')
  assert(rejects(r, 'synthetic-unfloored'), 'assertGoesRed passed a harness with no floor at all')
})

await test('NEGATIVE CONTROL: a floor that PRINTS but does not exit is NOT detected', async () => {
  const r = await runControl('toothless')
  assert(r.code === 0, 'the toothless control exited nonzero — it is not toothless')
  assert([...r.out.matchAll(FLOOR_LINE)].length === 1,
    'the toothless control printed no floor line — it would be rejected for the wrong reason')
  assert(rejects(r, 'synthetic-toothless'),
    'assertGoesRed accepted a floor that reports a breach and then exits 0 anyway — the #7646 shape, and ' +
    'the exit-code assertion is inert without this control')
})

await test('the neuter regexes are not vacuous against the control', async () => {
  const r = await runControl('floored')
  assert(r.substitutions === 2, `expected 2 substitutions in the control, saw ${r.substitutions}`)
  assert(r.neutered !== r.src, 'the neuter was a no-op on the control')
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
