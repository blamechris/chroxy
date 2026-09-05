import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane, stepRun } from './helpers/workflow-reader.js'

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
 * THAT COST, MEASURED (#7640). The gap is EMPTY today. All 629 tracked
 * `*.test.js` are reached by exactly one package runner, and every entry was
 * measured rather than read off a glob: server 611 and claude-hooks 5 by
 * expanding `./tests/**\/*.test.js`; protocol 10, all flat under `tests/`; app 2
 * by `jest --listTests` (its effective testMatch lives in the jest-expo preset,
 * not in this repo, so nothing but running it is faithful); design-tokens 1 by a
 * live bare `node --test`. There are ZERO tracked `*.test.cjs` anywhere, so the
 * symmetric `.cjs` hole — jest's default testMatch is `[jt]s?(x)` and every
 * other runner is pinned to `.test.js` or `.test.{ts,tsx}` — is real and also
 * empty.
 *
 * So the DERIVED version — enumerate each package's discovery rule from its own
 * package.json instead of hardcoding GLOB_COVERED — is NOT built, and this is
 * the decision rather than an omission. It would need five different
 * derivations, three of which have no glob string to read at all: `jest
 * --coverage` and `vitest run` carry their patterns in a third-party preset and
 * a TypeScript config, and a bare `node --test` carries Node's own undocumented
 * discovery algorithm. Faithful derivation means SPAWNING each runner from a
 * guard whose whole design is to be a fast read over tracked-file lists and YAML
 * text, and encoding Node's algorithm by hand is the second-copy-of-the-detector
 * anti-pattern this file argues against elsewhere. Against a measured gap of
 * zero, that buys nothing.
 *
 * What would change the answer is a real file appearing in the gap, and the
 * cheap answer then is another GLOB_COVERED-style entry carrying its
 * measurement — not a dynamic parser. Recorded here rather than left open,
 * because a stated gap nobody has measured and a closed one look identical from
 * outside.
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
const MIN_RUN_BODIES = 50

/**
 * The run-body floor above counts BOTH YAML spellings together, and that is not
 * enough on its own. `stepRun()` reads a plain scalar and a block scalar by
 * different branches, and live today the split is 93 plain to 42 block — so
 * losing the BLOCK branch entirely leaves 93, comfortably over 50, while a
 * third of every workflow's shell disappears from the search. Measured: with
 * that branch removed, `orphansIn` still returns [] and every core rule here
 * stays green.
 *
 * So the block spelling gets a floor of its own. A block scalar is the only
 * spelling that can produce a multi-line body, which is what makes this
 * countable without a second copy of `stepRun`'s parser sitting beside it.
 *
 * The plain spelling needs no separate floor: losing THAT branch drops the
 * total to 42, below MIN_RUN_BODIES. The two floors bracket both branches.
 * (#7647 asks the shared reader to carry this for its other seven consumers;
 * this is one file's own copy, not a substitute for that.)
 */
const MIN_BLOCK_RUN_BODIES = 10

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
    // The config the `why` below makes a claim about, and the keys that would
    // falsify it. `vitest run` names the runner; `vitest.config.ts` decides what
    // it discovers, and until #7640 nothing here read it.
    config: 'packages/store-core/vitest.config.ts',
    narrowsDiscovery: /^\s*(include|exclude|dir|root)\s*:/m,
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
 * Git environment variables that redirect or narrow what `git ls-files` sees.
 *
 * The docblock below argued at length that `GIT_LITERAL_PATHSPECS` could
 * silently shrink the subject set, and dropped the PATHSPEC for that reason.
 * The argument is right; the defence was aimed at the one variable that fix had
 * already neutralised. Measured in a worktree of this repo:
 *
 *   git ls-files -z                              -> 2496 files, exit 0
 *   GIT_LITERAL_PATHSPECS=1 git ls-files -z      -> 2496 files, exit 0  (no effect —
 *                                                   there is no pathspec to reinterpret)
 *   GIT_INDEX_FILE=<empty file> git ls-files -z  ->    0 files, EXIT 0
 *   GIT_WORK_TREE=/tmp git ls-files -z           -> 2474 files, exit 0
 *
 * `GIT_INDEX_FILE` is the one that matters: a silently EMPTY enumeration that
 * exits 0 — "found nothing to check" wearing "nothing wrong", the second cause
 * in docs/false-safety-guards.md, reachable from the environment with no edit
 * to this repo at all. MIN_TRACKED_FILES catches it, and a floor as the ONLY
 * defence against a condition the caller can simply arrange is a thin one.
 * `spawnSync` passes the whole inherited environment unless told otherwise, so
 * it is told otherwise.
 *
 * The pathspec family goes too, following #7281's precedent in
 * packages/server/src/ws-file-ops/git.js: they are the user's to set and not
 * ours to assume absent.
 */
const GIT_ENV_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
]

function gitEnv() {
  const env = { ...process.env }
  for (const key of GIT_ENV_OVERRIDES) delete env[key]
  return env
}

/**
 * The fail-closed reading of a `git ls-files -z` result, as a PURE function of
 * the spawn result (#7640).
 *
 * Extracted so each of its refusals can be PROVED to fire, the way
 * `basenameCollisions` was extracted in #7637. Against the real tree git never
 * fails to spawn, never exits non-zero and never returns a short listing, so
 * these three assertions and their absence are the same observable outcome —
 * the shape this whole file is about. They did fire before, but only as a side
 * effect of some OTHER mutation, which shows the FLOOR VALUE is reachable and
 * not that the ASSERTION is present.
 *
 * The cases below pin their MESSAGES, not merely the fact of throwing: a
 * refusal that fires for the wrong reason is how a case silently degrades into
 * a weaker one.
 */
function assertGitRan(r, root, what) {
  assert.ok(!r.error, `could not run \`${what}\` in ${root}: ${r.error?.message}`)
  assert.equal(
    r.status,
    0,
    `\`${what}\` failed in ${root}: ${(r.stderr?.toString('utf8') || '').trim()}`
  )
}

/**
 * The fail-closed reading of a `git ls-files -z` result — see assertGitRan
 * above for the two it shares with the untracked listing, and MIN_TRACKED_FILES
 * for the one it does not.
 */
function parseGitListing(r, root) {
  assertGitRan(r, root, 'git ls-files')
  const files = r.stdout.toString('utf8').split('\0').filter(s => s !== '')
  assert.ok(
    files.length >= MIN_TRACKED_FILES,
    `\`git ls-files\` returned only ${files.length} tracked files (expected >=${MIN_TRACKED_FILES}) — ` +
      'the enumeration is broken, not the tree. "Found nothing to check" must not read as "nothing wrong".'
  )
  return files
}

/**
 * Every tracked file, via `git ls-files -z`.
 *
 * NUL-separated so a filename containing a newline cannot forge an entry and
 * `core.quotePath` cannot mangle a non-ASCII name out of matching. No PATHSPEC:
 * a pathspec is a small language rather than a path, and a pathspec-mode
 * variable in the environment would turn `*.test.sh` into a literal name
 * matching nothing — a silently SHRUNK subject set, which is the direction that
 * reports green over suites it never looked at. The filtering happens in
 * JavaScript where no environment variable can reinterpret it, and the
 * variables that could are dropped from the environment as well.
 */
function trackedFiles() {
  return parseGitListing(
    spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    }),
    REPO_ROOT
  )
}

/** The last path segment. `git ls-files` emits `/` separators on every platform. */
const basenameOf = p => p.slice(p.lastIndexOf('/') + 1)

/**
 * Basenames of the files git can see in `scripts/__tests__/` but does not
 * track — a developer's scratch file, or anything ignored.
 *
 * This is the ALLOWANCE for the disk-side direction of the cross-check, and
 * narrowing it can only make that check STRICTER, never quieter: a missing
 * allowance turns a legitimate scratch file into a loud failure. That asymmetry
 * is why this one may carry a pathspec where `trackedFiles()` deliberately does
 * not — a mangled pathspec fails safe here and fails open there.
 * `--literal-pathspecs` plus the scrubbed environment settles the semantics
 * either way.
 *
 * It shares an index with `trackedFiles()`, so it cannot referee a failure that
 * blinds BOTH — an emptied index reports every file as untracked and this check
 * goes quiet. That case is MIN_TRACKED_FILES' and the environment scrub's, and
 * saying so here is the point: this check earns its keep against a TRUNCATED
 * listing (a maxBuffer overflow, a bad NUL split) and against a JavaScript
 * filter that has stopped matching, not against a git that cannot see the repo.
 */
function untrackedInSuiteDir() {
  const r = spawnSync(
    'git',
    ['-C', REPO_ROOT, '--literal-pathspecs', 'ls-files', '--others', '-z', '--', ROOT_SUITE_DIR],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: gitEnv() }
  )
  assertGitRan(r, REPO_ROOT, 'git ls-files --others')
  return new Set(
    r.stdout
      .toString('utf8')
      .split('\0')
      .filter(s => s !== '')
      .map(basenameOf)
  )
}

/**
 * The fail-closed controls, as CHECKED CONSTRUCTORS (#7640).
 *
 * Each validates and then RETURNS the value, which makes the data flow
 * explicit and keeps `collectSubject` a single expression per control.
 *
 * It does NOT make the call load-bearing, and this docblock claimed it did
 * until the mutation run said otherwise. A control that returns its argument is
 * a no-op to delete: removing `checkedInventory(...)` leaves the same array in
 * the same variable. Measured — all four call-site mutants SURVIVED. The call
 * sites are pinned instead by the source-level guard at the bottom of this
 * file, which claims only what it can: that the call is written.
 *
 * Recorded rather than quietly fixed, because "I threaded the value so the call
 * is covered" is the kind of plausible claim that becomes a comment describing
 * a stronger check than the code performs — the #7290/#7291 shape this file is
 * otherwise about.
 */
function checkedInventory(suites) {
  assert.ok(
    suites.length >= MIN_SUITES,
    `expected >=${MIN_SUITES} suites, found ${suites.length} — the inventory is broken`
  )
  return suites
}

/** The workflow reader's shared floor, threaded (#7640). */
function checkedWorkflows(workflows) {
  assertReaderSane(workflows)
  return workflows
}

/** The run-body floors, both spellings (#7640). */
function checkedRunBodies(runs) {
  assert.ok(
    runs.length >= MIN_RUN_BODIES,
    `expected >=${MIN_RUN_BODIES} \`run:\` bodies across all workflows, found ${runs.length} — ` +
      'an empty set would wire nothing and pass everything'
  )
  const block = runs.filter(t => t.includes('\n')).length
  assert.ok(
    block >= MIN_BLOCK_RUN_BODIES,
    `expected >=${MIN_BLOCK_RUN_BODIES} multi-line \`run:\` bodies, found ${block} — ` +
      "stepRun()'s block-scalar branch has stopped producing anything, and the total floor cannot " +
      'see that: the plain scalars clear it on their own.'
  )
  return runs
}

/**
 * Where the git enumeration and the directory listing disagree about the direct
 * children of `scripts/__tests__/` — in BOTH directions (#7640).
 *
 * The previous check computed only `git \ disk` and its comment said it was
 * there because "`git ls-files` going stale or RETURNING A SUBSET is otherwise
 * indistinguishable from a tree with fewer suites in it". Those are opposite
 * directions. A shrunk enumeration removes the very rows the check would have
 * compared, so the result is [] by construction — the empty set is a subset of
 * everything — and it passed green under every collapse it was measured
 * against, including one that dropped a third of the subjects. Not merely
 * unproven: pointed the wrong way, with a rationale that named the direction it
 * did not assert. The #7290/#7291 shape, in the guard written for that
 * catalogue.
 *
 * Both directions are reported now, and they are different mistakes:
 *   notOnDisk   — git lists a suite the directory does not have (a stale index)
 *   missedByGit — the directory has a suite the enumeration did not return and
 *                 git does not report as untracked (the enumeration lost it)
 *
 * `untracked` is what keeps a developer's scratch file from failing the build,
 * which is the reason the disk-side direction was left out rather than a reason
 * it could not be done.
 */
function enumerationDisagreements({ gitSuites, onDisk, untracked }) {
  const rootSuites = gitSuites.filter(
    p => p.startsWith(ROOT_SUITE_DIR) && !p.slice(ROOT_SUITE_DIR.length).includes('/')
  )
  const gitNames = new Set(rootSuites.map(basenameOf))
  return {
    notOnDisk: rootSuites.filter(p => !onDisk.has(basenameOf(p))),
    missedByGit: [...onDisk].filter(b => !gitNames.has(b) && !untracked.has(b)).sort(),
  }
}

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

/**
 * The subject every rule quantifies over, built ONCE and only through its
 * fail-closed controls (#7640).
 *
 * The controls used to sit BESIDE the rules, as their own `it()`s. That is what
 * #7640 was filed about: each was deletable on its own with the file still
 * green, because a rule that quantifies over an empty set reports a clean pass
 * and nothing obliged a separate assertion to run first. Now every one of them
 * is on the single path that produces the subject: delete a control's body and
 * the synthetic case below goes red (15 mutants, 15 killed); delete its CALL
 * and the source-level guard below goes red.
 *
 * A `before()` failure is reported by `node --test` as `cancelled`, with
 * `# fail 0` in the summary. The exit code is still 1 so CI goes red, but the
 * summary line reads clean and `assert-test-count.mjs` counts a cancelled test
 * as one that ran. That is #7648, filed separately: it is a property of the
 * runner, and it applied equally to the `before()` this replaces.
 */
async function collectSubject() {
  const tracked = trackedFiles()

  // A second, independent source for the one directory whose contents are
  // known. `readdir` is filtered to suite-SHAPED names so the `helpers/`
  // subdirectory and any non-suite file in there are not compared as if they
  // were suites.
  const onDisk = new Set(
    (await readdir(TESTS_DIR)).map(String).filter(n => isSuiteShaped(`${ROOT_SUITE_DIR}${n}`))
  )

  const suites = checkedAgainstDisk(
    checkedInventory(tracked.filter(isSubject).sort()),
    onDisk,
    untrackedInSuiteDir()
  )
  const workflows = checkedWorkflows(await readWorkflows())
  const runs = checkedRunBodies(runBodies(workflows))

  return { tracked, suites, workflows, runs }
}

/** The cross-check, threaded (#7640) — see `enumerationDisagreements`. */
function checkedAgainstDisk(suites, onDisk, untracked) {
  const { notOnDisk, missedByGit } = enumerationDisagreements({ gitSuites: suites, onDisk, untracked })
  assert.deepEqual(notOnDisk, [], 'git lists suites that are not on disk — the enumeration is stale')
  assert.deepEqual(
    missedByGit,
    [],
    'suite files sit in scripts/__tests__/ that the git enumeration did not return and that git ' +
      'does not report as untracked — the enumeration lost them, and a shrunk subject set is the ' +
      'direction that reports green over suites it never looked at'
  )
  return suites
}

describe('every test suite CI can only invoke BY NAME is invoked by a workflow step (#7504, #7637)', () => {
  let tracked
  let suites
  let workflows

  before(async () => {
    // `runs` is deliberately not bound here: every rule below goes through
    // `orphansIn`/`describeOrphans`, which derive it themselves. Binding an
    // unused copy is how a second source of the same set starts.
    ;({ tracked, suites, workflows } = await collectSubject())
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
    const collisions = basenameCollisions(tracked.filter(isSuiteShaped))
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

    it(`${entry.tree}'s runner config still declares no discovery narrowing`, async () => {
      // The exemption's `why` is a claim about DISCOVERY — vitest's
      // defaultInclude reaches .mjs and is not confined to src/, and the config
      // "sets only timeouts and workers and says so". The first half is a
      // property of vitest; the second is a property of a file in this repo,
      // and nothing asserted it. Adding
      //
      //     test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, ... }
      //
      // — a routine "stop vitest wandering outside src" edit — leaves every
      // other check in this block green (the `test` script is unchanged, `pkg`
      // is unchanged, `covers` is unchanged, a covered .mjs is still present)
      // while making the exemption FALSE. And
      // packages/store-core/scripts/__tests__/export-targets.test.mjs is named
      // by NO workflow step (verified), so it would then be discovered by
      // nothing and enumerated by nothing: #7504 reproduced through the very
      // block written to prevent it.
      //
      // A text check, deliberately: evaluating a TypeScript config to ask what
      // it declares needs the config's own toolchain, and the direction this
      // fails in is the safe one — a config that gains a discovery key fails
      // the guard loudly and the answer is to re-measure, not to widen the
      // regex. Collapsed to a boolean before asserting so a failure does not
      // carry the whole file as the error payload (#7340).
      const text = await readFile(new URL(`../../../${entry.config}`, import.meta.url), 'utf8')
      assert.ok(
        !entry.narrowsDiscovery.test(text),
        `${entry.config} now declares a discovery key (include/exclude/dir/root). This exemption ` +
          `rests on: ${entry.why}\nRe-measure which files that runner discovers and update or ` +
          'delete the entry — do not delete this assertion to make it pass.'
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
    // #7290/#7291 shape.
    //
    // The sentence that stood here claimed the two mechanisms were pinned
    // separately, "the trailing-comment case is red without `stepRun()`". That
    // was wrong, and measurement is what showed it (#7640): `uncommented()`
    // inside `invokes()` strips a trailing comment on its own, so that case
    // passes whether or not `stepRun()` strips one. NO case in this block is
    // red on `stepRun()` alone. `stepRun` is covered by
    // ci-workflow-reader.test.js, so this is a false attribution rather than an
    // uncovered accessor — but an attribution nobody measured is the same shape
    // the paragraph above takes credit for having caught three times, which is
    // how easily it recurs. #7649 asks whether a case naming a mechanism should
    // have to prove it.
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


/**
 * THE FAIL-CLOSED CONTROLS GO RED (#7640).
 *
 * The block above proves the RULE is load-bearing. These prove the CONTROLS
 * are — the assertions that stop the rule reporting green over a tree it never
 * examined.
 *
 * They had no proof of their own. Against the real tree git never fails to
 * spawn, never exits non-zero and never returns a short listing; the inventory
 * is never empty and the workflows always parse. So every one of these
 * assertions and its ABSENCE were the same observable outcome — the exact
 * shape docs/false-safety-guards.md is about, sitting inside the guard written
 * for that catalogue. They did fire during #7637's mutation run, but only as a
 * side effect of some other mutation: truncating `git ls-files` trips
 * MIN_TRACKED_FILES, which shows the FLOOR VALUE is reachable, not that the
 * FLOOR IS PRESENT. Those are different claims and only the second is a guard.
 *
 * Each case is a synthetic collapse, because a shape the real tree does not
 * have is exactly the one no tree-reading test can prove is handled — the same
 * argument contributing-roster-parse.test.js (#7643) makes. Each pins the
 * refusal MESSAGE rather than the fact of throwing: a refusal that fires for
 * the wrong reason is how a case silently degrades into a weaker one. And each
 * group opens with a CONTROL, because a control that refuses everything passes
 * its own negative cases for the wrong reason (#7273).
 *
 * What this does NOT claim: that the call site still exists. That is why the
 * controls were folded into `collectSubject()` — there is no route to the
 * subject that skips them — rather than left beside the rules where deleting
 * one is invisible.
 */
describe('the fail-closed controls go RED — one synthetic collapse at a time (#7640)', () => {
  /** A `git ls-files -z` stdout buffer holding exactly `n` paths. */
  const listing = n => Buffer.from(Array.from({ length: n }, (_, i) => `f${i}.txt`).join('\0') + '\0')

  describe('parseGitListing', () => {
    it('CONTROL: a healthy result parses, so the reading is not refuse-everything', () => {
      assert.equal(parseGitListing({ status: 0, stdout: listing(MIN_TRACKED_FILES) }, '/r').length, MIN_TRACKED_FILES)
    })

    it('refuses a spawn that never ran git', () => {
      // spawnSync sets `error` and leaves stdout undefined, so without this the
      // next line reads `.toString()` off undefined: red, but as a TypeError
      // naming nothing. Measured: `git` at a nonexistent path gives
      // status=null, error=ENOENT, stdout=undefined.
      assert.throws(
        () => parseGitListing({ error: new Error('spawn git ENOENT'), status: null, stdout: undefined }, '/r'),
        /could not run `git ls-files` in \/r: spawn git ENOENT/
      )
    })

    it('refuses a non-zero exit, quoting what git said', () => {
      assert.throws(
        () =>
          parseGitListing(
            { status: 128, stdout: Buffer.from(''), stderr: Buffer.from('fatal: not a git repository\n') },
            '/r'
          ),
        /`git ls-files` failed in \/r: fatal: not a git repository/
      )
    })

    it('refuses a listing one file below the floor', () => {
      assert.throws(
        () => parseGitListing({ status: 0, stdout: listing(MIN_TRACKED_FILES - 1) }, '/r'),
        new RegExp(`returned only ${MIN_TRACKED_FILES - 1} tracked files \\(expected >=${MIN_TRACKED_FILES}\\)`)
      )
    })

    it('refuses an EMPTY listing that exited 0 — the shape GIT_INDEX_FILE produces', () => {
      // Measured: `GIT_INDEX_FILE=<empty file> git ls-files -z` returns nothing
      // and exits 0. `gitEnv()` scrubs that variable so it cannot arrive; this
      // floor is what makes the scrub a second strap rather than the only one.
      assert.throws(
        () => parseGitListing({ status: 0, stdout: Buffer.from('') }, '/r'),
        /the enumeration is broken, not the tree/
      )
    })
  })

  describe('gitEnv', () => {
    it('drops every variable that can redirect or narrow what git sees', () => {
      // Without a case here the scrub is a list nothing compares to anything —
      // `gitEnv()` returning `process.env` unchanged is invisible against a
      // developer's environment, which has none of these set. Measured:
      // GIT_INDEX_FILE alone turns 2496 tracked files into 0 at exit 0.
      const before = { ...process.env }
      try {
        for (const key of GIT_ENV_OVERRIDES) process.env[key] = 'x'
        const env = gitEnv()
        assert.deepEqual(GIT_ENV_OVERRIDES.filter(k => k in env), [])
        assert.ok('PATH' in env, 'the rest of the environment must survive — git still needs to be found')
      } finally {
        for (const key of GIT_ENV_OVERRIDES) {
          if (key in before) process.env[key] = before[key]
          else delete process.env[key]
        }
      }
    })

    it('names GIT_INDEX_FILE — the one that empties the listing at exit 0', () => {
      // Pinned by name because the list is otherwise a roster whose members no
      // evidence distinguishes, and this is the member with a measurement
      // behind it.
      assert.ok(GIT_ENV_OVERRIDES.includes('GIT_INDEX_FILE'))
    })

    it('trackedFiles() survives a GIT_INDEX_FILE that would otherwise empty the listing', () => {
      // The end-to-end proof, and the reason it is worth the temp file: every
      // case above tests `gitEnv()` in isolation, so dropping `env: gitEnv()`
      // from the spawn — the CALL rather than the function — would survive them
      // all. Measured without the scrub: `GIT_INDEX_FILE=<empty file>
      // git ls-files -z` returns nothing and exits 0, so this run would come
      // back with an empty subject set and a clean green.
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-gitenv-'))
      const before = process.env.GIT_INDEX_FILE
      try {
        const idx = join(dir, 'empty-index')
        writeFileSync(idx, '')
        process.env.GIT_INDEX_FILE = idx
        assert.ok(trackedFiles().length >= MIN_TRACKED_FILES)
      } finally {
        if (before === undefined) delete process.env.GIT_INDEX_FILE
        else process.env.GIT_INDEX_FILE = before
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('checkedInventory', () => {
    const inventory = n => Array.from({ length: n }, (_, i) => `${ROOT_SUITE_DIR}s${i}.test.sh`)

    it('CONTROL: an inventory at the floor passes', () => {
      assert.equal(checkedInventory(inventory(MIN_SUITES)).length, MIN_SUITES)
    })

    it('refuses an EMPTY inventory — `orphansIn([], workflows)` is [] and every rule passes', () => {
      // Measured against the real workflows: with no subjects the orphan rule
      // returns [] and reports a clean green. This floor is the only thing that
      // distinguishes "nothing to check" from "nothing wrong".
      assert.throws(() => checkedInventory([]), /found 0 — the inventory is broken/)
    })

    it('refuses an inventory one below the floor', () => {
      assert.throws(
        () => checkedInventory(inventory(MIN_SUITES - 1)),
        new RegExp(`expected >=${MIN_SUITES} suites, found ${MIN_SUITES - 1}`)
      )
    })
  })

  describe('checkedRunBodies', () => {
    const plain = n => Array.from({ length: n }, (_, i) => `bash x${i}.sh`)
    const block = n => Array.from({ length: n }, (_, i) => `set -e\nbash y${i}.sh`)

    it('CONTROL: a mix at both floors passes', () => {
      assert.equal(checkedRunBodies([...plain(MIN_RUN_BODIES), ...block(MIN_BLOCK_RUN_BODIES)]).length, MIN_RUN_BODIES + MIN_BLOCK_RUN_BODIES)
    })

    it('refuses an EMPTY set — it would wire nothing and pass everything', () => {
      assert.throws(() => checkedRunBodies([]), /an empty set would wire nothing and pass everything/)
    })

    it('refuses a total below the floor — the shape a lost PLAIN-scalar branch produces', () => {
      // Live: 93 plain, 42 block. Losing the plain branch leaves 42, under 50.
      assert.throws(
        () => checkedRunBodies(block(MIN_RUN_BODIES - 1)),
        new RegExp(`expected >=${MIN_RUN_BODIES} \`run:\` bodies across all workflows`)
      )
    })

    it('refuses a set with no BLOCK scalars, which the total floor alone cannot see', () => {
      // The measured degradation this second floor exists for: `stepRun()`
      // loses its block-scalar branch, 135 run bodies become 93, `orphansIn`
      // still returns [] and every core rule stays green — because 93 clears
      // the total floor on its own. A floor that cannot fail on the realistic
      // failure is a floor in name only.
      assert.throws(
        () => checkedRunBodies(plain(MIN_RUN_BODIES + MIN_BLOCK_RUN_BODIES)),
        /block-scalar branch has stopped producing anything/
      )
    })
  })

  describe('enumerationDisagreements', () => {
    const G = ROOT_SUITE_DIR

    it('CONTROL: agreement in both directions reports nothing', () => {
      assert.deepEqual(
        enumerationDisagreements({
          gitSuites: [`${G}a.test.sh`, `${G}b.test.mjs`],
          onDisk: new Set(['a.test.sh', 'b.test.mjs']),
          untracked: new Set(),
        }),
        { notOnDisk: [], missedByGit: [] }
      )
    })

    it('reports a suite git lists that the directory does NOT have — a stale index', () => {
      assert.deepEqual(
        enumerationDisagreements({
          gitSuites: [`${G}a.test.sh`, `${G}gone.test.sh`],
          onDisk: new Set(['a.test.sh']),
          untracked: new Set(),
        }).notOnDisk,
        [`${G}gone.test.sh`]
      )
    })

    it('reports a suite on disk the enumeration MISSED — the direction the old check could not see', () => {
      // The whole point of #7640's fix here. The previous check computed only
      // `git \ disk`, so a SHRUNK enumeration removed the very rows it would
      // have compared and the result was [] by construction. Measured: dropping
      // 5 of 15 subjects left it, MIN_SUITES and the orphan rule all green.
      assert.deepEqual(
        enumerationDisagreements({
          gitSuites: [`${G}a.test.sh`],
          onDisk: new Set(['a.test.sh', 'b.test.sh']),
          untracked: new Set(),
        }).missedByGit,
        ['b.test.sh']
      )
    })

    it('allows an UNTRACKED file on disk — a scratch file must not fail the build', () => {
      assert.deepEqual(
        enumerationDisagreements({
          gitSuites: [`${G}a.test.sh`],
          onDisk: new Set(['a.test.sh', 'scratch.test.sh']),
          untracked: new Set(['scratch.test.sh']),
        }),
        { notOnDisk: [], missedByGit: [] }
      )
    })

    it('compares only the DIRECT children — `readdir` is one level deep', () => {
      // A nested path would otherwise be reported as missing from a directory
      // listing that was never going to contain it.
      assert.deepEqual(
        enumerationDisagreements({
          gitSuites: [`${G}a.test.sh`, `${G}helpers/n.test.sh`],
          onDisk: new Set(['a.test.sh']),
          untracked: new Set(),
        }),
        { notOnDisk: [], missedByGit: [] }
      )
    })
  })

  describe('the GLOB_COVERED exemption checks are not vacuous', () => {
    // Each check above passes against the real tree, and a check that reported
    // nothing would pass identically. These are the controls.
    for (const entry of GLOB_COVERED) {
      it(`${entry.tree}: narrowsDiscovery REPORTS a config that declares include:`, () => {
        assert.ok(
          entry.narrowsDiscovery.test("export default defineConfig({\n  test: {\n    include: ['src/**/*.test.ts'],\n  },\n})\n"),
          'the discovery-key regex must match a config that narrows discovery, or the check above ' +
            'is satisfied by a pattern matching nothing (#7503: a filter whose terms match nothing ' +
            'is a gate satisfied by zero rows)'
        )
      })

      it(`${entry.tree}: narrowsDiscovery does NOT report the timeouts-only shape`, () => {
        assert.ok(
          !entry.narrowsDiscovery.test("export default defineConfig({\n  test: {\n    testTimeout: 30_000,\n    maxWorkers: '50%',\n  },\n})\n"),
          'the regex must not fire on a config that only bounds the clock — a check that reports ' +
            'everything passes its negative cases for the wrong reason (#7273)'
        )
      })

      it(`${entry.tree}: covers REPORTS the extension it exempts, and refuses shell`, () => {
        assert.ok(entry.covers.test(`${entry.tree}scripts/__tests__/x.test.mjs`))
        assert.ok(!entry.covers.test(`${entry.tree}scripts/__tests__/x.test.sh`))
      })
    }
  })

  describe('isSuiteShaped', () => {
    // Measured: ZERO tracked files match the `scripts/__tests__/` +
    // `.test.{js,cjs}` clause today, so deleting it outright left every test
    // green — a clause no evidence can contradict, which is precisely what
    // GLOB_COVERED's own docblock refuses to allow an exemption to be ("an
    // entry covering nothing is a roster line no evidence can contradict") and
    // what its check D fails an exemption for. The same standard, applied to
    // this file's own subject shapes.
    //
    // The clause stays, because it is a claim about DISCOVERY rather than about
    // today's tree: no package runner's glob reaches a `scripts/__tests__/`, so
    // a `.test.js` there is invoked by name or by nothing. It gets a synthetic
    // case instead of a file.
    it('covers a *.test.js under any scripts/__tests__/, though no such file exists today', () => {
      assert.ok(isSuiteShaped(`${ROOT_SUITE_DIR}x.test.js`))
      assert.ok(isSuiteShaped('packages/server/scripts/__tests__/x.test.cjs'))
    })

    it('does NOT sweep *.test.js repo-wide — five of eight runners are pinned to that extension', () => {
      assert.ok(!isSuiteShaped('packages/server/tests/x.test.js'))
      assert.ok(!isSuiteShaped('packages/app/src/__tests__/x.test.js'))
    })

    it('covers *.test.sh and *.test.mjs repo-wide, and nothing that merely looks like one', () => {
      assert.ok(isSuiteShaped('packages/desktop/scripts/verify-entitlements.test.sh'))
      assert.ok(isSuiteShaped('packages/store-core/scripts/__tests__/export-targets.test.mjs'))
      assert.ok(!isSuiteShaped(`${ROOT_SUITE_DIR}x.js`))
      assert.ok(!isSuiteShaped('scripts/x.test.sh.bak'))
    })
  })
})


/**
 * THE CALL SITES (#7640).
 *
 * Every control above is proved to FIRE by a synthetic case. That is half the
 * question. The other half — is it still CALLED — has no behavioural answer
 * here, and the measurement is what established that rather than an argument:
 * `checkedInventory`, `checkedWorkflows`, `checkedRunBodies` and
 * `checkedAgainstDisk` were each removed from `collectSubject` in turn and all
 * four mutants SURVIVED, because a control that returns the value it validates
 * leaves the same value in the same variable when it goes.
 *
 * So the call site is pinned where it actually lives: in the source text. That
 * is the weaker kind of check — #7374 in the catalogue is two guards pinned at
 * source text rather than behaviour — and it is claimed as no more than it is.
 * It proves the call is WRITTEN. It does not prove it runs, nor that its
 * argument is the subject the rules use. What makes it worth having is that
 * the alternative is nothing, and the deletion it catches — a control dropped
 * during an edit, with every synthetic case still green — is precisely the
 * failure #7640 was filed for.
 *
 * The roster is DERIVED from the source, not typed here: every
 * `function checked*()` in this file must be called by `collectSubject`. A list
 * beside a growing set is the first cause in docs/false-safety-guards.md, and a
 * roster of controls is exactly the kind of set that grows.
 *
 * The body is stripped of line comments first, for the same reason `invokes()`
 * strips them from a `run:` body: every control's name appears in the prose
 * around its call, and a guard that reads prose as configuration is satisfiable
 * by prose.
 */
describe('collectSubject calls every control this file declares (#7640)', () => {
  let body
  let declared

  before(async () => {
    const text = await readFile(new URL(import.meta.url), 'utf8')
    declared = declaredControls(text)
    body = collectSubjectBody(text)
  })

  it('calls every control it declares', () => {
    const uncalled = declared.filter(name => !body.includes(`${name}(`))
    assert.deepEqual(
      uncalled,
      [],
      'controls this file declares but collectSubject does not call. Their synthetic cases still ' +
        'pass: a control nobody calls and one that never fires are the same observable outcome.'
    )
  })

  it('CONTROL: the slice is narrow enough to report a name that is NOT there', () => {
    // Without this, a `body` that accidentally slurped the whole file satisfies
    // the rule above for every possible roster — the deny-nothing shape (#7273).
    assert.ok(!body.includes('thisControlDoesNotExist('))
    assert.ok(
      !body.includes('function checkedInventory('),
      'the slice reaches past collectSubject into the declarations themselves'
    )
    assert.ok(
      !body.includes('describeOrphans('),
      'the slice reaches past collectSubject into the rules'
    )
  })

  it('CONTROL: the comment stripper does not let prose vouch for a call', () => {
    const prose = '  // checkedInventory(suites) used to be called here\n  const x = 1\n'
    const stripped = prose.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    assert.ok(!stripped.includes('checkedInventory('))
  })
})

/**
 * A floor, not a count: a derivation that had stopped matching would otherwise
 * hand the call-site rule an empty roster to quantify over.
 */
const MIN_CONTROLS = 4

/**
 * The controls this file declares, derived from its own source (#7640).
 *
 * Pure, and proved against synthetic documents below, because the real source
 * always has a healthy roster — so the floor's ABSENCE and its SUCCESS are the
 * same observable outcome here, which is the thing #7640 is about. Its own call
 * site is where this recursion stops: nothing pins that `declaredControls` is
 * still called, and saying so is better than a fifth layer that would have the
 * same gap one level further down.
 */
function declaredControls(text) {
  const declared = [...text.matchAll(/^function (checked[A-Za-z0-9]+)\(/gm)].map(m => m[1])
  assert.ok(
    declared.length >= MIN_CONTROLS,
    `found ${declared.length} \`function checked*()\` declarations (expected >=${MIN_CONTROLS}) — ` +
      'the roster derivation is broken, and an empty roster would pass every rule that reads it'
  )
  return declared
}

/**
 * `collectSubject`'s body, sliced out of the source with line comments removed
 * (#7640).
 *
 * The stripping is not decoration: every control's name appears in the prose
 * around its call, so without it a commented-out call vouches for itself —
 * the same regression `invokes()` strips a `run:` body for, one file over.
 *
 * `minLength` is a parameter so the synthetic cases can exercise the slice and
 * the strip separately from the floor; the real call takes the default.
 */
function collectSubjectBody(text, { minLength = 200 } = {}) {
  const start = text.indexOf('\nasync function collectSubject() {')
  assert.ok(start !== -1, 'collectSubject() not found — this guard has drifted from the file it reads')
  const end = text.indexOf('\n}\n', start)
  assert.ok(end > start, 'could not find the end of collectSubject()')
  const body = text
    .slice(start, end)
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.ok(
    body.length >= minLength,
    `the collectSubject() slice reads as ${body.length} chars (expected >=${minLength}) — it is wrong`
  )
  return body
}

describe('the call-site guard\'s own derivations go RED (#7640)', () => {
  const SRC = [
    'function checkedOne(v) {}',
    'function checkedTwo(v) {}',
    'function checkedThree(v) {}',
    'function checkedFour(v) {}',
    '',
    'async function collectSubject() {',
    '  // checkedOne(x) used to be called here',
    '  const a = checkedTwo(1)',
    '  return a',
    '}',
    '',
  ].join('\n')

  it('CONTROL: a healthy synthetic source yields its roster', () => {
    assert.deepEqual(declaredControls(SRC), ['checkedOne', 'checkedTwo', 'checkedThree', 'checkedFour'])
  })

  it('refuses a roster below the floor — an empty one would pass every rule that reads it', () => {
    assert.throws(
      () => declaredControls(SRC.replace('function checkedFour(v) {}\n', '')),
      new RegExp(`found ${MIN_CONTROLS - 1} \`function checked\\*\\(\\)\` declarations`)
    )
  })

  it('refuses a source the derivation matches NOTHING in', () => {
    assert.throws(() => declaredControls('const x = 1\n'), /the roster derivation is broken/)
  })

  it('CONTROL: the body slice returns collectSubject and stops at its closing brace', () => {
    const body = collectSubjectBody(SRC, { minLength: 0 })
    assert.ok(body.includes('checkedTwo('))
    assert.ok(!body.includes('function checkedOne('), 'the slice reached back into the declarations')
  })

  it('strips a COMMENTED-OUT call, so prose cannot vouch for a control', () => {
    // Without the stripper this body contains `checkedOne(` and the call-site
    // rule reads a comment as a call. The real body has no such comment today,
    // so removing the stripper there is invisible — this is what makes it
    // provable at all.
    assert.ok(!collectSubjectBody(SRC, { minLength: 0 }).includes('checkedOne('))
  })

  it('refuses a source with no collectSubject at all', () => {
    assert.throws(() => collectSubjectBody('const x = 1\n', { minLength: 0 }), /collectSubject\(\) not found/)
  })

  it('refuses a slice shorter than the floor', () => {
    assert.throws(() => collectSubjectBody(SRC, { minLength: 10_000 }), /it is wrong/)
  })
})

/** ci.yml, or a named assertion failure rather than an undefined deref. */
function workflowsByName(workflows, name) {
  const found = workflows.find(w => w.name === name)
  assert.ok(found, `expected ${name} among the scanned workflows`)
  return found
}
