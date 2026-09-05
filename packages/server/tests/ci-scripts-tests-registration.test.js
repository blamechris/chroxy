import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane, code, stepRun } from './helpers/workflow-reader.js'

/**
 * #7504 — a test suite that runs in no workflow, and a green CI, are the same
 * observable outcome.
 *
 * `scripts/__tests__/merge-updater-feeds.test.sh` was executable, passing, and
 * referenced by ZERO workflow steps for its whole life. Its subject is
 * release-critical: release.yml folds the per-platform Tauri updater feeds into
 * the one latest.json the auto-updater serves. Nothing would have gone red.
 *
 * The cause is structural, not a one-off oversight: `scripts-tests` names each
 * suite in its own hand-written step, which is a hardcoded list beside a
 * growing directory — the first cause in docs/false-safety-guards.md. Fixing
 * only the orphan leaves the next one exactly as invisible, so this guard
 * quantifies over the FILESYSTEM.
 *
 * Registration is checked across ALL workflows, not just ci.yml's
 * `scripts-tests` job: a suite legitimately wired into release.yml or a nightly
 * is registered, and demanding one particular job would be a guard that fails
 * on correct configurations.
 *
 * WHAT #7637 FIXED — every item below was found by review, and every one failed
 * in the direction that lets a real orphan through
 * ----------------------------------------------------------------------------
 * 1. IT READ THE WHOLE STEP, NOT THE COMMAND. The rule matched
 *    `code(step).join('\n')` — every line of the step block bar whole-line
 *    comments — so a step whose `run:` no longer invoked the suite still
 *    counted it as wired if the name survived anywhere else in the block.
 *    Reproduced against the real tree, both green with the release-critical
 *    suite running in no step:
 *
 *      - name: Run scripts/__tests__/merge-updater-feeds.test.sh tests
 *        run: true
 *
 *      - name: Run merge-updater-feeds.mjs tests
 *        run: true  # was bash scripts/__tests__/merge-updater-feeds.test.sh
 *
 *    The second is the realistic regression, and `code()` cannot catch it: it
 *    drops whole-line comments, and that is a TRAILING one. The rule's own
 *    comment said it matched "STEP BODIES with comments stripped ... a guard
 *    that reads prose as configuration is satisfiable by prose", while being
 *    satisfiable by prose — a comment describing a stronger check than the code
 *    performs, which is the #7290/#7291 shape, produced in a guard written for
 *    that catalogue.
 *
 *    The fix uses `stepRun()`, the reader's accessor for the shell script YAML
 *    actually hands the runner. It did NOT exist when this guard was written:
 *    the guard landed 2026-08-30 in #7540 against a reader that had only
 *    `code()`, and `stepRun()` arrived 2026-09-04 in #7633 for a different
 *    guard. So this is not "the right accessor was there and went unused" — it
 *    is a capability that appeared five days later and that nothing went back
 *    to apply. Worth stating precisely, because the two have different
 *    remedies: the first is a review miss, the second is that adding a sharper
 *    tool to a shared module leaves every existing consumer on the blunt one.
 *
 * 1b. AND IT READ THE STEP AS PROSE ONE LAYER DOWN. `stepRun()` hands back a
 *    BLOCK scalar verbatim, because a `#` inside one is a shell comment that
 *    belongs to the script. So commenting the invocation out —
 *
 *      run: |
 *        # bash scripts/__tests__/merge-updater-feeds.test.sh
 *        echo "temporarily skipped"
 *
 *    still read as wired, which is the same regression in the other YAML
 *    spelling, and the entire first mutation suite missed it because every case
 *    in it mutated a plain scalar. Comments are stripped in `invokes()` now,
 *    which is the only place that can: two spellings of identical config must
 *    not disagree.
 *
 * 1c. AND "AN INTERPRETER BEFORE THE NAME" MEANT "ANYWHERE EARLIER ON THE
 *    LINE". `chmod +x ./x.test.sh`, `cp ./x.test.sh /tmp/` and `node --version
 *    && echo "see x.test.sh"` each read as an invocation while running nothing.
 *    The match is anchored to a shell command position now — the #7290/#7291
 *    shape again, three times in one function, which is a fair measure of how
 *    hard the safe direction is to hold onto.
 *
 * 2. IT LOOKED IN ONE DIRECTORY. The subject was `readdir` over
 *    `scripts/__tests__/`, so `packages/desktop/scripts/verify-entitlements.
 *    test.sh` — wired only by name, outside that directory — was exactly as
 *    exposed as merge-updater-feeds had been, and a suite added under
 *    `packages/server/scripts/__tests__/` would have been too.
 *
 * WHAT IS A SUBJECT, AND WHY THE BOUNDARY IS WHERE IT IS
 * ------------------------------------------------------
 * A suite belongs here when NO test-runner glob discovers it, so a name in CI
 * config is the only thing that can invoke it. Measured, per extension:
 *
 *   *.test.sh — repo-wide. No runner in this repo looks for shell files;
 *     vitest, `node --test` and jest all discover JavaScript. A shell suite is
 *     invoked by name or by nothing.
 *
 *   *.test.mjs — repo-wide, minus the trees in GLOB_COVERED. Six of this
 *     repo's eight packages CANNOT discover a `.mjs`: server and claude-hooks
 *     pin `./tests/**\/*.test.js`, protocol pins `tests/*.test.js`, dashboard's
 *     vitest include is `src/**\/*.test.{ts,tsx}`, app runs jest whose default
 *     testMatch is `[jt]s?(x)` (which excludes `mjs`), and desktop has no
 *     `test` script at all. Excluding `packages/**` wholesale — on the strength
 *     of ONE measurement, store-core's — would leave a hole with a template
 *     already sitting in the tree next to nine server lint scripts.
 *
 *   *.test.{js,cjs} under ANY `scripts/__tests__/` — no package runner's glob
 *     reaches such a directory (they are pinned to `./tests/**`, `tests/*`,
 *     `src/**`, or jest's defaults), and the root package.json has no `test`
 *     script at all. It is NOT swept repo-wide: `.test.js` is the extension
 *     five of the eight package runners ARE pinned to, so a repo-wide sweep
 *     would be almost entirely exemptions. That boundary has a cost worth
 *     naming — a `*.test.js` outside both a runner's glob and a
 *     `scripts/__tests__/` is a subject this does not look at.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 * -------------------------------------
 * That the step will RUN. A `run:` inside a job gated by `if:`, reachable only
 * on a tag or a schedule, or marked `continue-on-error`, reads as wired here.
 * Whether an `if:` can ever be true is undecidable in general, and the question
 * #7504 asked is whether anything at all invokes the file.
 *
 * That an invocation spelled without the filename is seen. `for f in
 * scripts/__tests__/*.test.sh; do bash "$f"; done` names no suite, so every
 * suite it runs would be reported orphaned. That is a false POSITIVE — loud,
 * and fixable by whoever writes the loop. Under-inclusive is the direction that
 * waves a real orphan through, which is the failure this file exists to
 * prevent, so every judgement call here is made toward crying wolf.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ROOT_SUITE_DIR = 'scripts/__tests__/'
const TESTS_DIR = new URL('../../../scripts/__tests__/', import.meta.url)

/**
 * Loose floors, not counts. Today 16 files match the shapes below and 15 are
 * subjects, one being exempted by GLOB_COVERED. They catch an enumeration that
 * has stopped working, not the tree's size — a number tracking today's count
 * would be the first cause in docs/false-safety-guards.md again.
 */
const MIN_TRACKED_FILES = 500
const MIN_SUITES = 10

/**
 * Trees whose `*.test.mjs` a test runner really does discover by glob, each
 * with the measurement that establishes it.
 *
 * A roster beside a growing set is the first cause in the catalogue, so this
 * one is asserted EQUAL to reality on every run: the tree must be the package
 * root the measurement is about, `test` must still be that package's exact
 * `test` script, and the tree must still hold at least one file the exemption
 * is doing work for. Drift in any of the three is the thing it reports, rather
 * than something it hides. The guard still enumerates the filesystem and
 * consults no list of SUITES.
 *
 * The tree-is-the-package check is not decoration: without it, widening `tree`
 * to `packages/` left all 21 tests green while exempting every
 * `packages/**\/*.test.mjs` — the blanket exclusion this guard's own header
 * argues is a hole, reachable as a one-word edit. It was a surviving mutant,
 * which is the definition of a missing assertion.
 *
 * The eighth package, design-tokens, runs a bare `node --test` and so DOES glob
 * `*.test.mjs`. It has none today, and an entry covering nothing is a roster
 * line no evidence can contradict — so it gets none, and the check below is
 * what would demand one if a file ever appeared there.
 */
const GLOB_COVERED = [
  {
    tree: 'packages/store-core/',
    pkg: 'packages/store-core/package.json',
    test: 'vitest run',
    covers: /\.test\.(mjs|cjs|js)$/,
    why:
      "vitest's defaultInclude is `**/*.{test,spec}.?(c|m)[jt]s?(x)`, which matches .mjs and is " +
      'not confined to src/; packages/store-core/vitest.config.ts sets only timeouts and workers ' +
      'and says so. Measured: `npx vitest list --filesOnly` in packages/store-core lists ' +
      'scripts/__tests__/export-targets.test.mjs.',
  },
]

/**
 * The files that LOOK like a suite of the kinds this guard covers, before any
 * exemption. Kept separate from `isSubject` because the basename-collision
 * check has to quantify over this wider set: an exempted file still sits in the
 * tree with a basename, and a run line naming it would vouch for a subject that
 * shares it.
 *
 * `*.test.{js,cjs}` is matched under any `scripts/__tests__/` rather than only
 * the root one. No package runner's glob reaches a `scripts/__tests__/` — they
 * are pinned to `./tests/**`, `tests/*`, `src/**` or jest's defaults — so such
 * a file is invoked by name or by nothing wherever it lives. It is NOT swept
 * repo-wide: `.test.js` is the extension five of the eight package runners are
 * pinned to, so a repo-wide sweep would be almost entirely exemptions.
 */
const isSuiteShaped = p =>
  /\.test\.(sh|mjs)$/.test(p) || (/(^|\/)scripts\/__tests__\//.test(p) && /\.test\.(js|cjs)$/.test(p))

/**
 * Is this repo-relative path a suite that only a name in CI config can invoke?
 *
 * An exemption applies only to the extensions its runner actually globs. vitest
 * discovers JavaScript; it would not find a `*.test.sh` under store-core, so
 * exempting the whole tree by path would open a hole in the one class that has
 * no glob coverage anywhere.
 */
const isSubject = p =>
  isSuiteShaped(p) && !GLOB_COVERED.some(e => p.startsWith(e.tree) && e.covers.test(p))

/**
 * Every tracked file, via `git ls-files -z`.
 *
 * NUL-separated so a filename containing a newline cannot forge an entry and
 * `core.quotePath` cannot mangle a non-ASCII name out of matching. No PATHSPEC:
 * a pathspec is a small language rather than a path, and `GIT_LITERAL_PATHSPECS`
 * in the environment would turn `*.test.sh` into a literal name matching
 * nothing — a silently SHRUNK subject set, which is the direction that reports
 * green over suites it never looked at. The filtering happens in JavaScript
 * where no environment variable can reinterpret it.
 */
function trackedFiles() {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.ok(!r.error, `could not run git in ${REPO_ROOT}: ${r.error?.message}`)
  assert.equal(
    r.status,
    0,
    `\`git ls-files\` failed in ${REPO_ROOT}: ${(r.stderr?.toString('utf8') || '').trim()}`
  )
  const files = r.stdout.toString('utf8').split('\0').filter(s => s !== '')
  assert.ok(
    files.length >= MIN_TRACKED_FILES,
    `\`git ls-files\` returned only ${files.length} tracked files (expected >=${MIN_TRACKED_FILES}) — ` +
      'the enumeration is broken, not the tree. "Found nothing to check" must not read as "nothing wrong".'
  )
  return files
}

/** The last path segment. `git ls-files` emits `/` separators on every platform. */
const basenameOf = p => p.slice(p.lastIndexOf('/') + 1)

/** Escape a literal for embedding in a RegExp. */
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Every place `text` names this file as a whole path segment.
 *
 * A plain `includes()` is over-inclusive about WIRED, which is under-inclusive
 * about ORPHAN — the dangerous direction. `bash foo.test.sh.bak` and `bash
 * xfoo.test.sh` both contain `foo.test.sh` as a substring and invoke a
 * different file. The left boundary admits `/` (a path prefix is exactly how
 * the name is normally spelled) but not a filename character; the right
 * boundary admits neither, so an extended name cannot vouch for the suite.
 *
 * EVERY occurrence, not the first: `echo "replacing x.test.sh" && bash
 * x.test.sh` names it twice, and stopping at the first would read the mention
 * and miss the invocation. That direction is only a false positive, but it is
 * free to get right.
 */
function namePositions(text, name) {
  const re = new RegExp(`(?<![A-Za-z0-9_.\\-])${esc(name)}(?![A-Za-z0-9_.\\-])`, 'g')
  return [...text.matchAll(re)].map(m => m.index)
}

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'npx', 'npm'])

/** Shell command separators: everything after the last one begins a new command. */
const SEPARATORS = /[;&|(`{]/g

/**
 * Is the name at `at` in a COMMAND position on this line — i.e. does the text
 * immediately before it invoke it?
 *
 * The prefix is cut back to the last shell separator, quotes are dropped, and
 * what remains must be one of:
 *
 *   `./`                     — `./x.test.sh`
 *   <interpreter> [flags] [path-prefix]
 *                            — `bash x.test.sh`, `node --test scripts/__tests__/x`,
 *                              `bash ./x.test.sh`, `out=$(bash x.test.sh)`
 *
 * The first version of this asked only whether an interpreter appeared ANYWHERE
 * earlier on the line, and whether `./` appeared anywhere earlier. Both were the
 * #7290/#7291 shape — a comment ("before the name") describing a stronger check
 * than the code performed — and both were live false negatives, verified:
 * `chmod +x ./x.test.sh`, `cp ./x.test.sh /tmp/` and `node --version && echo
 * "see x.test.sh"` each read as an invocation while running nothing. Anchoring
 * to the command position is what makes the claim and the code agree.
 *
 * A bare `x.test.sh` at a command position is NOT accepted, though a shell
 * would run it: nothing in this repo spells an invocation that way, and a
 * heredoc body line naming a suite would otherwise read as running it. That
 * costs a false positive on a shape nobody writes, which is the safe direction.
 */
function isCommandPosition(line, at) {
  const before = line.slice(0, at)
  SEPARATORS.lastIndex = 0
  let cut = 0
  for (const m of before.matchAll(SEPARATORS)) cut = m.index + 1
  const seg = before.slice(cut).replace(/["']/g, '').trim()
  if (seg === './') return true
  const words = seg.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  // `words[0]` rather than `words.some(...)`: the interpreter must be the
  // command WORD. The two are provably equivalent given the tail check below —
  // an interpreter is neither a flag nor a path prefix, so it cannot appear
  // after position 0 and still pass — and a differential search over 168,420
  // token sequences found no input distinguishing them. Recorded because that
  // makes swapping them a genuinely INERT mutant rather than a missing
  // assertion, and the next person to mutate this deserves to know which.
  if (!INTERPRETERS.has(words[0])) return false
  // After the interpreter: flags, plus optionally a trailing path prefix — the
  // directory part of the argument when the match was on the basename.
  return words.slice(1).every((w, i, rest) => w.startsWith('-') || (i === rest.length - 1 && w.endsWith('/')))
}

/**
 * A run body's lines with shell comments removed.
 *
 * `stepRun()` strips a trailing comment from a PLAIN scalar, because that is
 * what YAML does. It deliberately does NOT strip one inside a BLOCK scalar —
 * a `#` there is a shell comment and belongs to the script it hands back. So
 * the single most idiomatic way to disable a CI command,
 *
 *     run: |
 *       # bash scripts/__tests__/x.test.sh
 *       echo "temporarily skipped"
 *
 * read as WIRED until this existed: the same "delete the `run:`, keep the
 * comment" regression this whole guard is about, one YAML spelling over, and
 * missed by the entire mutation suite because every case in it mutated a plain
 * scalar. Two spellings of identical config must not disagree.
 *
 * A `#` inside quotes truncates the line here where a shell would not. That
 * shortens what is searched, so its only effect is to report a wired suite as
 * an orphan — loud, and the safe direction.
 */
const uncommented = runBody =>
  runBody.split('\n').map(line => line.replace(/(^|\s)#.*$/, ''))

/**
 * Does any line of this `run:` body actually INVOKE the named file, as opposed
 * to merely mentioning it?
 *
 * `stepRun()` already keeps a step's `name:`, `if:` and `with:` out of reach.
 * This closes the rest: a comment inside a block scalar, and a mention inside a
 * live command.
 *
 * Requiring a real command position costs nothing today — all 15 wired suites
 * are invoked as `bash <path>` or `node <path>`, measured, one line each. A
 * future shape without one (`npm run x`, a variable holding the path, `for f in
 * ...; do bash "$f"; done`) is reported as an orphan: a false POSITIVE, loud,
 * and fixable by whoever writes it. Under-inclusive is the direction that waves
 * a real orphan through.
 */
function invokes(runBody, name) {
  return uncommented(runBody).some(line =>
    namePositions(line, name).some(at => isCommandPosition(line, at))
  )
}

/** Is the name present at all — invoked or merely mentioned? Diagnostics only. */
const mentions = (runBody, name) => namePositions(runBody, name).length > 0

/**
 * Paths that share a basename, as `a vs b`.
 *
 * Matching admits the basename alone because an invocation under
 * `working-directory:` spells neither the full path nor the bare name: ci.yml
 * runs `bash scripts/verify-entitlements.test.sh` from packages/desktop. That
 * is only as strong as path matching while basenames are unique, so a collision
 * has to fail the build rather than let one suite's step vouch for another.
 */
function basenameCollisions(paths) {
  const seen = new Map()
  const collisions = []
  for (const p of paths) {
    const b = basenameOf(p)
    if (seen.has(b)) collisions.push(`${seen.get(b)} vs ${p}`)
    else seen.set(b, p)
  }
  return collisions
}

/**
 * Every shell command any workflow step actually runs.
 *
 * `stepRun()` reproduces YAML's reading of `run:` — block scalars taken
 * literally, plain scalars truncated at a ` #` comment, quoted scalars ended at
 * their closing quote. That last two are what make this immune to defect 1
 * above: a name in a step's `name:`, `if:`, `with:` or trailing comment is not
 * part of the command, so it cannot vouch for a suite nothing runs.
 */
const runBodies = workflows =>
  workflows.flatMap(w => w.jobs.flatMap(j => j.steps.map(stepRun))).filter(t => t != null)

/**
 * The whole rule, as ONE function, so the mutation cases at the bottom exercise
 * the code that ships rather than a transcription of it. A red proof that runs
 * a second copy of the detector proves the copy goes red.
 */
function orphansIn(suites, workflows) {
  const runs = runBodies(workflows)
  return suites.filter(p => !runs.some(t => invokes(t, p) || invokes(t, basenameOf(p))))
}

/**
 * The orphans, each annotated with whether its name appears in a run body at
 * all. "Named but never invoked" and "named nowhere" are different mistakes —
 * the first is usually an `echo` or a half-finished edit, the second a deleted
 * step — and the reader should not have to guess which.
 */
function describeOrphans(suites, workflows) {
  const runs = runBodies(workflows)
  return orphansIn(suites, workflows).map(p => {
    const mentioned = runs.some(t => mentions(t, p) || mentions(t, basenameOf(p)))
    return `${p} (${mentioned ? 'named in a run: body but never invoked' : 'named by no workflow step'})`
  })
}

describe('every test suite CI can only invoke BY NAME is invoked by a workflow step (#7504, #7637)', () => {
  let suites
  let workflows
  let runs

  before(async () => {
    suites = trackedFiles().filter(isSubject).sort()
    workflows = await readWorkflows()
    runs = runBodies(workflows)
  })

  // ---- positive controls ----
  // Every rule below quantifies over sets these readers produce. An empty
  // inventory, or a workflow reader that has stopped parsing these files, makes
  // every rule pass over nothing and report a clean green — the
  // "cannot check treated as nothing to check" cause in
  // docs/false-safety-guards.md.
  it('finds the suite inventory and the workflows', () => {
    assert.ok(
      suites.length >= MIN_SUITES,
      `expected >=${MIN_SUITES} suites, found ${suites.length} — the inventory is broken`
    )
    assertReaderSane(workflows)
  })

  it('finds run bodies to search — an empty set would wire nothing and pass everything', () => {
    assert.ok(runs.length >= 50, `expected >=50 \`run:\` bodies across all workflows, found ${runs.length}`)
  })

  it('the git enumeration and the directory agree about scripts/__tests__/', async () => {
    // A second, independent source for the one directory whose contents are
    // known. `git ls-files` going stale or returning a subset is otherwise
    // indistinguishable from a tree with fewer suites in it. Only this
    // direction is asserted: readdir also sees UNTRACKED files, and a scratch
    // file on a developer's machine must not fail the build.
    const onDisk = new Set((await readdir(TESTS_DIR)).map(String))
    const missing = suites
      .filter(p => p.startsWith(ROOT_SUITE_DIR) && !p.slice(ROOT_SUITE_DIR.length).includes('/'))
      .filter(p => !onDisk.has(basenameOf(p)))
    assert.deepEqual(missing, [], 'git lists suites that are not on disk — the enumeration is stale')
  })

  it('suite basenames are unique, so a basename match cannot vouch for the wrong file', () => {
    // Matching admits the basename alone because an invocation under
    // `working-directory:` spells neither the full path nor the bare name:
    // ci.yml runs `bash scripts/verify-entitlements.test.sh` from
    // packages/desktop. A collision would let one suite's step wire the other,
    // which is the under-inclusive direction.
    //
    // Quantified over every suite-SHAPED file, not just the subjects: a file
    // excluded by GLOB_COVERED still sits in the tree with a basename, and a
    // run line naming IT would vouch for a subject that shares it. Narrowing
    // this argument back to `suites` is a real weakening that today's tree
    // CANNOT falsify — no subject shares a basename with an exempt file — so it
    // is a surviving mutant by construction, and the synthetic case below is
    // what pins the logic instead. Said plainly rather than left for the next
    // person to discover.
    const collisions = basenameCollisions(trackedFiles().filter(isSuiteShaped))
    assert.deepEqual(collisions, [], 'two suite files share a basename — rename one')
  })

  it('basenameCollisions REPORTS a collision — the check above is not vacuous', () => {
    // The real tree has none, so the case above passes identically against a
    // function that returns [] unconditionally. This is the control.
    assert.deepEqual(
      basenameCollisions(['a/x.test.sh', 'b/y.test.sh', 'c/x.test.sh']),
      ['a/x.test.sh vs c/x.test.sh']
    )
  })

  it('every suite is invoked by at least one workflow step', () => {
    const orphans = describeOrphans(suites, workflows)
    assert.deepEqual(
      orphans,
      [],
      'test suites that no workflow step runs — a suite that never runs and a passing suite are ' +
        `the same observable outcome (#7504): ${orphans.join('; ')}`
    )
  })

  it('pins merge-updater-feeds.test.sh by name — the suite that was orphaned', () => {
    assert.ok(
      suites.includes('scripts/__tests__/merge-updater-feeds.test.sh'),
      'merge-updater-feeds.test.sh must still exist; it covers the release updater-feed merge'
    )
  })

  it('pins verify-entitlements.test.sh — a suite OUTSIDE scripts/__tests__, wired only by name', () => {
    // The subject-widening in #7637 exists for this file. If it stops being
    // enumerated, the widening has silently reverted to the one-directory scan
    // and this suite is unguarded again.
    assert.ok(
      suites.includes('packages/desktop/scripts/verify-entitlements.test.sh'),
      `the repo-wide *.test.sh sweep stopped reaching packages/desktop/. Enumerated: ${suites.join(', ')}`
    )
  })
})

describe('the GLOB_COVERED exemptions are still true (#7637)', () => {
  // An exemption is a claim about someone else's configuration. Left
  // unchecked it is the first cause in docs/false-safety-guards.md wearing a
  // rationale: the runner changes, the glob stops reaching the tree, and the
  // suites inside it are subjects that nothing enumerates.
  for (const entry of GLOB_COVERED) {
    it(`${entry.tree} is the root of the package whose runner vouches for it`, () => {
      // Without this, widening `tree` to `packages/` keeps both checks below
      // green (pkg still points at store-core, and packages/ still contains its
      // .test.mjs) while exempting every packages/**/*.test.mjs — the blanket
      // exclusion this guard's header argues is a hole. A surviving mutant.
      assert.equal(
        entry.pkg,
        `${entry.tree}package.json`,
        'the exemption tree must be the package root the measurement is about — a wider tree ' +
          'exempts files no runner in that package ever globs'
      )
    })

    it(`${entry.tree}'s exemption does not reach *.test.sh`, () => {
      // No runner in this repo globs shell, so no exemption may ever cover it.
      // Without this, widening `covers` to /./ exempts a hypothetical
      // *.test.sh under the tree from the one class that has no glob coverage
      // anywhere — inert on today's files, and a hole the moment one appears.
      assert.ok(
        !entry.covers.test('packages/x/scripts/__tests__/a.test.sh'),
        `${entry.tree}'s \`covers\` matches a shell suite. ${entry.why} is a claim about a ` +
          'JavaScript runner; nothing in this repo discovers *.test.sh by glob.'
      )
    })

    it(`${entry.tree} still runs \`${entry.test}\``, async () => {
      const pkg = JSON.parse(await readFile(new URL(`../../../${entry.pkg}`, import.meta.url), 'utf8'))
      assert.equal(
        pkg.scripts?.test,
        entry.test,
        `${entry.pkg}'s test script changed. This exemption rests on: ${entry.why}\n` +
          'Re-measure whether the new runner still discovers *.test.mjs in that tree, and update ' +
          'or delete the entry — do not adjust the string to match.'
      )
    })

    it(`${entry.tree} still holds a *.test.mjs the exemption is doing work for`, () => {
      const covered = trackedFiles().filter(
        p => p.startsWith(entry.tree) && isSuiteShaped(p) && entry.covers.test(p)
      )
      assert.ok(
        covered.length > 0,
        `no *.test.mjs under ${entry.tree}, so this exemption excludes nothing and is unfalsifiable. ` +
          'Delete it — a roster line no evidence can contradict is how a roster rots.'
      )
    })
  }
})

describe('Scripts Tests parse-checks every tracked shell script (#7504)', () => {
  let step

  before(async () => {
    const ci = workflowsByName(await readWorkflows(), 'ci.yml')
    const job = ci.jobs.find(j => j.id === 'scripts-tests')
    assert.ok(job, "ci.yml should have a 'scripts-tests' job")
    // Anchored to the RUN BODY, for the same reason the registration rule above
    // is: `code()` keeps a step's `name:` and every trailing comment, so a
    // narrowed pathspec plus a comment quoting the old one would read clean.
    const matches = job.steps.filter(s => (stepRun(s) ?? '').includes('bash -n'))
    assert.equal(
      matches.length,
      1,
      `expected exactly one 'bash -n' step in scripts-tests, found ${matches.length}`
    )
    step = uncommented(stepRun(matches[0])).join('\n')
  })

  it('enumerates the whole tracked set, not a typed subdirectory glob', () => {
    // The pathspec is the property. Narrowing it to `scripts/*.sh` re-creates
    // the exact hole this closes — packages/server/scripts/,
    // packages/desktop/scripts/ and packages/app/.maestro/scripts/ all drop
    // out, and the step stays green while parsing 13 of 30 files.
    assert.ok(
      /git ls-files -z '\*\.sh'/.test(step),
      "the parse-check step must enumerate `git ls-files -z '*.sh'` — a narrower pathspec silently " +
        'skips whole script directories, and a list typed into CI config is reachable by no lint or test (#7270)'
    )
  })

  it('fails CLOSED when the enumeration comes back short', () => {
    // "Found nothing to check" must not read as "nothing wrong" — the second
    // cause in docs/false-safety-guards.md, and the one a `for f in glob` loop
    // gets wrong for free (an unmatched glob iterates zero times, exit 0).
    assert.ok(/-lt 20/.test(step), 'the parse-check step must assert a floor on the file count')
    assert.ok(/exit 2/.test(step), 'a broken enumeration must exit 2 — a distinct, loud outcome from 0')
  })
})

/**
 * THE RED PROOF.
 *
 * Everything above asserts that the real tree is clean, and a rule that
 * accepted everything would assert exactly the same thing just as green. #7273
 * is the inverse in this catalogue — a check so broken it satisfied its own
 * negative tests — and #7504's own guard passed continuously while being
 * satisfiable by a step that ran nothing. So each mutation below breaks the
 * wiring in one specific way and demands the SAME detector name the SAME suite.
 *
 * Every mutation asserts that it LANDED before it is trusted: a `replace()`
 * whose pattern has drifted returns the input unchanged and the case then
 * passes for the wrong reason, which is the shape it is here to catch.
 */
describe('the registration rule goes RED — one mutation at a time (#7637)', () => {
  const dirs = []
  const REAL = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))
  const SUITE = 'scripts/__tests__/merge-updater-feeds.test.sh'
  const DESKTOP = 'packages/desktop/scripts/verify-entitlements.test.sh'
  const RUN_LINE = '        run: bash scripts/__tests__/merge-updater-feeds.test.sh'
  const NAME_LINE = '      - name: Run merge-updater-feeds.mjs tests'

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  /**
   * A copy of the real workflows with each `[find, replace]` applied to ci.yml.
   *
   * Pairs rather than one transform, and each asserted SEPARATELY: a chained
   * `.replace().replace()` whose first pattern has drifted still changes the
   * text, so a single before/after check passes while the case silently
   * degrades into a weaker one.
   *
   * The landing check is collapsed to a boolean before asserting. Comparing two
   * ~86 KB strings with `assert.notEqual` puts BOTH in the AssertionError as
   * `actual` and `expected` — ~200 KB of TAP per call — which is the payload
   * that wedged this runner in #7340.
   */
  async function mutated(pairs) {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-wired-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const ci = join(dir, 'ci.yml')
    let text = readFileSync(ci, 'utf8')
    for (const [find, replace] of pairs) {
      const occurrences = text.split(find).length - 1
      assert.ok(
        occurrences === 1,
        `the mutation did not land: ci.yml contains ${occurrences} occurrences of ` +
          `${JSON.stringify(find.slice(0, 90))}, expected exactly 1 — it has drifted from what ` +
          'this case edits, and the case would otherwise pass for the wrong reason'
      )
      text = text.replace(find, replace)
    }
    writeFileSync(ci, text)
    return readWorkflows(pathToFileURL(`${dir}/`))
  }

  const SUITES = [SUITE, DESKTOP]

  it('CONTROL: an unmutated copy has no orphans, so the rule is not deny-everything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-wired-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    assert.deepEqual(orphansIn(SUITES, await readWorkflows(pathToFileURL(`${dir}/`))), [])
  })

  it('a suite no workflow has ever heard of is reported, against the UNMUTATED tree', async () => {
    // The control above proves the rule accepts the real wiring; this proves it
    // still rejects something, without any mutation in play. Together they rule
    // out both a rule that accepts everything and one that denies everything —
    // #7273's negative tests all passed against a check that denied everything.
    const wf = await readWorkflows(pathToFileURL(REAL))
    const ghost = 'scripts/__tests__/no-workflow-has-ever-named-this.test.sh'
    assert.deepEqual(orphansIn([...SUITES, ghost], wf), [ghost])
  })

  it('the `run:` deleted outright', async () => {
    const wf = await mutated([[`${RUN_LINE}\n`, '']])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('the `run:` replaced, the name surviving in the step NAME (the shipped fail-open)', async () => {
    // This exact shape was GREEN under the previous rule, which matched every
    // line of the step block. The step runs nothing.
    //
    // TWO independent mechanisms now reject it — `stepRun()` never yields the
    // `name:` line, and `invokes()` finds no interpreter before the name in
    // `- name: Run <path> tests`. Mutating EITHER alone leaves this case green;
    // only the combined mutant turns it red (verified). It is kept as the
    // redundancy check it is rather than credited to `stepRun()` alone, which
    // would be a comment claiming more than any single line performs — the
    // #7290/#7291 shape. The two mechanisms are pinned separately below: the
    // trailing-comment case is red without `stepRun()`, and the mention and
    // `refresh` cases are red without `invokes()`.
    const wf = await mutated([
      [NAME_LINE, `      - name: Run ${SUITE} tests`],
      [RUN_LINE, '        run: true'],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('the `run:` replaced, the name surviving in a TRAILING comment (the shipped fail-open)', async () => {
    // The realistic regression, and the one `code()` cannot catch: it drops
    // whole-line comments, and this is a trailing one on a live `run:`.
    const wf = await mutated([[RUN_LINE, `        run: true  # was bash ${SUITE}`]])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('the `run:` MENTIONING the suite without invoking it', async () => {
    // The last hole inside the command itself. `stepRun()` keeps a step's
    // `name:` and trailing comments out; this is a real run body that names the
    // suite and runs nothing.
    const wf = await mutated([[RUN_LINE, `        run: echo "::error::${SUITE} was removed"`]])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
    // Collapsed to a boolean before asserting: a failing `assert.match` carries
    // the WHOLE subject as `actual`, which has wedged this runner before (#7340).
    const why = describeOrphans(SUITES, wf).join('')
    assert.ok(/named in a run: body but never invoked/.test(why), why)
  })

  it('the invocation COMMENTED OUT inside a `run: |` block scalar', async () => {
    // The realistic regression in the other YAML spelling, and the one the whole
    // mutation suite missed until review: `stepRun()` must hand back a block
    // scalar verbatim (a `#` there is a SHELL comment), so nothing but
    // `invokes()` can strip it. Every other case here mutates a plain scalar,
    // so without this one that branch of `stepRun()` is never exercised.
    const wf = await mutated([
      [RUN_LINE, `        run: |\n          # bash ${SUITE}\n          echo "temporarily skipped"`],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('a real invocation SURVIVING beside a commented-out one in the same block', async () => {
    // The control for the case above. Stripping comments must not strip the
    // command: a rule that dropped the whole body would report every suite
    // orphaned and its negative tests would pass for the wrong reason (#7273).
    const wf = await mutated([
      [RUN_LINE, `        run: |\n          # bash ${SUITE} --old\n          bash ${SUITE}`],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [])
  })

  it('the file being CHMODded rather than run — `./` anywhere earlier is not an invocation', async () => {
    // `before.includes('./')` accepted any relative path earlier on the line, so
    // `chmod +x ./<suite>` and `cp ./<suite> /tmp/` both read as invocations
    // while running nothing. Anchoring to the command position is what makes
    // the header's claim ("before the name") and the code agree.
    const wf = await mutated([[RUN_LINE, `        run: chmod +x ./${SUITE}`]])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('an interpreter earlier in the line, the suite only MENTIONED after it', async () => {
    // INVOKER_RE used to be tested against the whole prefix, so any `node` or
    // `bash` earlier on the line vouched for a mention later on it.
    const wf = await mutated([
      [RUN_LINE, `        run: node --version && echo "see ${SUITE}"`],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('a real `./` invocation still counts — the anchoring is not deny-everything', async () => {
    const wf = await mutated([[RUN_LINE, `        run: ./${SUITE}`]])
    assert.deepEqual(orphansIn(SUITES, wf), [])
  })

  it('`bash ./<path>` and a quoted argument still count', async () => {
    const wf = await mutated([[RUN_LINE, `        run: bash "./${SUITE}"`]])
    assert.deepEqual(orphansIn(SUITES, wf), [])
  })

  it('a mention and a real invocation on the SAME line — every occurrence is examined', async () => {
    // `namePositions` returns every match, not the first. Stopping at the first
    // would read the mention and miss the invocation two words later, reporting
    // a wired suite as an orphan. Only a false positive, but free to get right.
    const wf = await mutated([
      [RUN_LINE, `        run: echo "running ${SUITE}" && bash ${SUITE}`],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [])
  })

  it('a commented-out invocation whose comment contains a shell separator', async () => {
    // The `;` resets the command-position scan, so without comment stripping the
    // text after it reads as a fresh command. This is what makes `uncommented()`
    // load-bearing rather than redundant with the command-position anchoring —
    // every other commented shape is caught twice.
    const wf = await mutated([
      [RUN_LINE, `        run: |\n          # disabled; bash ${SUITE}\n          echo skipped`],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('an interpreter NAMED but not first in the command — `echo bash <suite>`', async () => {
    // The interpreter must be the command WORD, not merely present among the
    // words. Accepting any position makes `echo bash x.test.sh` — printing a
    // command rather than running it — read as an invocation.
    const wf = await mutated([[RUN_LINE, `        run: echo bash ${SUITE}`]])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('a MENTION whose prefix contains `sh` only inside another word', async () => {
    // Pins the token boundaries on INVOKER_RE itself. `refresh` contains `sh`,
    // `bash` contains `sh`, `.bashrc` contains `bash`; an unbounded alternation
    // reads any of them as an invocation and the mention counts as wiring.
    // Without this case that weakening is a SURVIVING mutant — measured.
    const wf = await mutated([[RUN_LINE, `        run: echo "refresh ${SUITE}"`]])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('the `run:` naming a LONGER filename that merely contains the suite name', async () => {
    // `bash x.test.sh.bak` invokes a different file. A substring match would
    // call the suite wired — over-inclusive about WIRED is under-inclusive
    // about ORPHAN, the direction that waves a real orphan through.
    const wf = await mutated([[RUN_LINE, `${RUN_LINE}.bak`]])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('the `run:` naming a file whose name merely ENDS with the suite name', async () => {
    const wf = await mutated([
      [RUN_LINE, '        run: bash scripts/__tests__/x-merge-updater-feeds.test.sh'],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [SUITE])
  })

  it('a suite OUTSIDE scripts/__tests__ loses its step — the widening is load-bearing', async () => {
    // Invoked as `bash scripts/verify-entitlements.test.sh` under
    // `working-directory: packages/desktop`, so this also pins that the rule
    // matches a basename and not only a repo-relative path.
    const wf = await mutated([
      ['        run: bash scripts/verify-entitlements.test.sh\n', '        run: true\n'],
    ])
    assert.deepEqual(orphansIn(SUITES, wf), [DESKTOP])
  })
})

/** ci.yml, or a named assertion failure rather than an undefined deref. */
function workflowsByName(workflows, name) {
  const found = workflows.find(w => w.name === name)
  assert.ok(found, `expected ${name} among the scanned workflows`)
  return found
}
