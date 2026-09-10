/**
 * A small indentation-aware reader for `.github/workflows/*.yml`, shared by the
 * CI guards in `packages/server/tests/ci-*.test.js`, plus `ci-workflow-reader`
 * (this module's own tests). The consumers are deliberately NOT listed here: a
 * roster in a comment beside a growing set is the first cause in
 * docs/false-safety-guards.md, and this one demonstrated it — written accurate
 * at three names, it still said three when there were nine, and #7661 arrived
 * to add the tenth. (The first correction to this sentence said "three short,
 * adding a fourth", which was the same mistake one layer up — #7662 review.)
 * `grep -rl "helpers/workflow-reader" packages/server/tests --include='*.test.js'`
 * answers it, and the IMPORT PATH is the part that matters: a bare
 * `grep -l workflow-reader` also matches `batch-merge-check-gate.test.js`,
 * which mentions this module in a comment and imports nothing from it. That
 * over-count reached #7658's PR body (corrected there) and then #7666's, which
 * said "eleven importers" for ten. The sentence this replaces claimed the bare
 * grep "answers it correctly and always" — a comment describing a stronger
 * check than the command performs, in the file that catalogues that cause.
 *
 * WHY THIS IS A MODULE AND NOT A COPY IN EACH TEST
 * ------------------------------------------------
 * It began as a private reader inside `ci-npm-cache-routing.test.js` (#7383).
 * #7386 needed the same reader in `ci-cache-key.test.js`, and transcribing it
 * would have produced a second implementation of the one thing both guards
 * depend on being right — the defect class the root CLAUDE.md names outright:
 * "the copy is always the convenient thing to write and always the thing that
 * drifts". Both guards now fail together, or neither does.
 *
 * WHY IT IS NOT A YAML PARSER
 * ---------------------------
 * The guards must anchor every assertion to a STEP BODY, because ci.yml's own
 * comments quote the exact strings they match on — `cache: npm` appears
 * verbatim in the rationale for having removed it, and `npm ci` twice in
 * `server-tests-windows`'s explanation of its timeout budget. A guard that
 * reads prose as configuration is satisfiable by prose. A real parser would
 * also work, but the structural facts these guards need (which job, which step,
 * which `with:` input) are exactly what this reader exposes, with the comment
 * handling made explicit rather than incidental.
 *
 * EVERY CONSUMER MUST CARRY A POSITIVE CONTROL. Assertions here quantify over
 * what the reader found; if the reader breaks it finds nothing and every rule
 * passes over an empty set, reporting a clean green. That is the
 * "cannot check this treated as nothing to check" failure in
 * docs/false-safety-guards.md. `assertReaderSane` below is the shared floor.
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

/** The pinned setup-node action, matched by prefix so the SHA can move. */
export const SETUP_NODE = 'actions/setup-node@'

/** The cache value every runner-target-routed job must use (#7383). */
export const ROUTED_CACHE = '${{ needs.runner-target.outputs.npmcache }}'

/** The only correct `cache-dependency-path` in a repo with three lockfiles. */
export const LOCKFILE_GLOB = '**/package-lock.json'

/** Runner-target outputs that mean "this job's runner depends on the trust predicate". */
export const ROUTED_RUNNER_OUTPUTS = [
  'needs.runner-target.outputs.runner',
  // #7471 long-job pin: the three long Linux jobs route through `longrunner`.
  // Omitting it here would silently drop them out of every guard that
  // quantifies over "routed" jobs (the npm-cache rules chief among them) —
  // the guard-wired-to-some-of-its-callers class.
  'needs.runner-target.outputs.longrunner',
  'needs.runner-target.outputs.winrunner',
]

/**
 * A `key:` line carrying NO value — the head of a block mapping or sequence —
 * with YAML's optional trailing comment.
 *
 * ONE implementation, because there were four and every one of them was wrong
 * the same way (#7673). Each ended at a bare `$`, so `steps: # the pipeline`
 * and `defaults: # pwsh everywhere` — legal YAML, and this repo comments keys
 * throughout ci.yml — matched nothing. Measured, before the fix:
 *
 *   parseJobs   `jobs: # …`     -> THROWS; the whole FILE yields nothing
 *   parseSteps  `steps: # …`    -> 0 steps, the whole job's steps vanish
 *   jobShell    `defaults: # …` -> undefined, a powershell job reads as unset
 *   jobShell    `run: # …`      -> undefined, the same
 *   jobShell    `steps: # …`    -> "pwsh" FOR A BASH JOB
 *
 * WHICH OF THOSE REACHES A CONSUMER is not what the first version of this
 * comment claimed, and the correction is recorded rather than the sentence
 * quietly rewritten, because the wrong version is the intuitive one.
 *
 * The `defaults:` and `run:` rows are the ones that independently change a
 * CLASSIFICATION. `ci-workflow-run-blocks-parse` resolves a block's shell as
 * `stepInput(step, 'shell') ?? jobShell(job.body) ?? 'bash'`, and both of this
 * repo's PowerShell jobs declare their shell in `defaults:` with nothing on a
 * step — so `undefined` feeds every one of their blocks to `bash -n` as bash.
 * That file carries a control for exactly this (`blocks.some(b =>
 * /powershell|pwsh/.test(b.shell))`), so it fails LOUD, under the misleading
 * diagnosis "jobShell has stopped reading job-level defaults".
 *
 * The two `steps:` rows share a TRIGGER — the same regex on the same line — so
 * the bogus "pwsh" is computed and never consumed: the block loop iterates
 * `job.steps`, which `parseSteps` has already emptied. The job's run blocks get
 * no `bash -n` coverage at all, which is the OUTCOME the earlier wording
 * claimed but not its mechanism. Since #7671 the per-file step row catches that
 * too, so it is loud rather than silent. Measured in review of #7674.
 *
 * `parseJobs`'s row is the SIXTH site and was not a regex at all — a
 * `l === 'jobs:'` string equality, which no source grep for a regex shape could
 * have found. It surfaced only once the guard started asking BEHAVIOURALLY.
 *
 * `parseJobs` has carried the `(?:#.*)?$` allowance on a job-id line since
 * #7499. That fix was applied to the site that had the bug and the module was
 * never swept for siblings — the adjacent-field pattern. The sweep for this fix
 * found SIX instances here plus two more in a sibling FILE
 * (`ci-npm-cache-routing.test.js`), which is the same pattern one level up.
 *
 * TWO GUARDS, AND THE WEAKER ONE IS HONEST ABOUT BEING WEAK. A source rule in
 * `ci-workflow-reader.test.js` refuses a bare `key:\s*$` anchor in this file.
 * It is cheap, and it is a SPELLING check: review of #7674 evaded it twice, with
 * `[:]` and with a split `new RegExp("…" + "…")`, and it could never have seen
 * `parseJobs`'s string equality. The rule that does the real work is
 * BEHAVIOURAL — comment every valueless key in the live corpus, and the reader
 * must report exactly what it reported before. That one is spelling-blind by
 * construction, and it is what found the sixth site.
 *
 * VALUELESS IS THE LOAD-BEARING HALF, and it is asserted directly rather than
 * inferred from the four call sites. A mutation sweep made this `${key}:.*$`
 * — an allowance that accepts a key WITH a value — and every one of those
 * sites stayed green, because in real YAML these three keys are never written
 * with one. A comment claiming the call sites pin it would be describing a
 * stronger check than they perform, so `valuelessKey` is exported and its
 * contract is pinned by its own case.
 *
 * The `\\s+` before `#` is deliberate and stricter than `parseJobs`'s
 * job-id pattern: YAML needs whitespace before a `#` for it to open a comment,
 * so `steps:#x` is a plain scalar, not a key at all, and must not match. It is
 * ALSO stricter than the `defaults:` matcher #7671 added, which accepted
 * `defaults:#x` — the one accept->reject flip this consolidation makes. It is a
 * correctness gain and no file in the corpus relies on the old form.
 *
 * `[^\\n]` rather than `.` in the comment branch, because `.` excludes `\\r`:
 * with `.` the pattern matched `steps: \\r` and REJECTED `steps: # c\\r`,
 * reproducing this very bug class gated on line ending instead of on a comment.
 * `.gitattributes` pins the repo to LF so nothing live hit it, but this is an
 * exported helper now and a future caller carries no such promise.
 */
export const valuelessKey = (key, { topLevel = false } = {}) => {
  // `key` is interpolated into a RegExp. Anything but a plain YAML identifier
  // would change what the pattern MATCHES rather than failing loudly — one `.`
  // or `(` from a future caller silently widens every anchor built from it.
  // REFUSED rather than escaped: every key this module anchors on is a plain
  // identifier, and a refusal needs no escape table to be correct.
  assert.ok(
    /^[A-Za-z0-9_-]+$/.test(key),
    `valuelessKey expects a plain YAML key, got ${JSON.stringify(key)}`
  )
  return new RegExp(`^${topLevel ? '' : '\\s*'}${key}:(?:\\s+#[^\\n]*|\\s*)$`)
}
const JOBS_KEY = valuelessKey('jobs', { topLevel: true })
const STEPS_KEY = valuelessKey('steps')
const DEFAULTS_KEY = valuelessKey('defaults')
const RUN_MAPPING_KEY = valuelessKey('run')

/**
 * Split a workflow's `jobs:` mapping into per-job blocks.
 *
 * Job ids are the only keys at exactly two-space indent, and these workflows
 * each have a single top-level `jobs:` key, so this needs no general YAML
 * support — but it must not silently return nothing, which is what each
 * consumer's positive control checks.
 *
 * @param {string} yml Raw workflow text.
 * @param {string} [name] File name, used only in the assertion message.
 */
export function parseJobs(yml, name = 'workflow') {
  const lines = yml.split('\n')
  const jobsAt = lines.findIndex(l => JOBS_KEY.test(l))
  assert.notEqual(jobsAt, -1, `${name} should have a top-level 'jobs:' key`)

  const starts = []
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(lines[i])
    if (m) starts.push({ id: m[1], line: i })
  }

  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length
    const body = lines.slice(s.line, end)
    return { id: s.id, line: s.line + 1, body, runsOn: runsOnOf(body), steps: parseSteps(body) }
  })
}

/**
 * A job's whole `runs-on:` value as one string — the key line PLUS its block
 * body when the labels are written as a YAML block sequence.
 *
 * This used to be `body.find(l => /^\s*runs-on:/.test(l))`, a single line, and
 * that is a false-safety guard of the kind this repo catalogues. GitHub accepts
 * two spellings of the same label set:
 *
 *     runs-on: [self-hosted, macOS, ARM64]        # flow — the whole value is on the line
 *     runs-on:                                    # block — the line holds NOTHING
 *       - self-hosted
 *       - macOS
 *
 * Under the old reader the block form yielded the literal string `"runs-on:"`,
 * so `/self-hosted/.test(job.runsOn)` was false and every self-hosted rule
 * `continue`d past the job. Reproduced before this fix: a workflow pinned to
 * `[self-hosted, macOS, ARM64]` in block form while hardcoding `cache: npm` —
 * precisely the #7383 defect — passed all 14 tests green. Two spellings of
 * identical config must not disagree, least of all in a module whose stated job
 * is covering files that do not exist yet.
 *
 * Blank and comment lines are skipped rather than treated as the end of the
 * block, so a commented label list does not truncate the value early.
 */
function runsOnOf(bodyLines) {
  const at = bodyLines.findIndex(l => /^\s*runs-on:/.test(l))
  if (at === -1) return ''
  const keyIndent = /^(\s*)/.exec(bodyLines[at])[1].length
  const parts = [bodyLines[at]]
  for (let i = at + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    if (/^(\s*)/.exec(line)[1].length <= keyIndent) break
    parts.push(line)
  }
  return parts.join(' ')
}

/**
 * Split a job body into step blocks.
 *
 * A step begins at a `- ` list item under `steps:`; the block runs until the
 * next list item at the same indent or the end of the job. Only step bodies are
 * ever asserted on, which is what keeps a workflow's explanatory comments out
 * of a guard's reach.
 */
export function parseSteps(bodyLines) {
  const stepsAt = bodyLines.findIndex(l => STEPS_KEY.test(l))
  if (stepsAt === -1) return []

  const starts = []
  let indent = null
  for (let i = stepsAt + 1; i < bodyLines.length; i++) {
    const m = /^(\s*)- /.exec(bodyLines[i])
    if (!m) continue
    if (indent === null) indent = m[1].length
    if (m[1].length === indent) starts.push(i)
  }

  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : bodyLines.length
    return bodyLines.slice(start, end)
  })
}

/**
 * Drop comment lines.
 *
 * ci.yml is heavily commented and several of those comments quote the very
 * strings the guards match on. A guard that reads prose as configuration is
 * satisfiable by prose.
 */
export function code(lines) {
  return lines.filter(l => !/^\s*#/.test(l))
}

/**
 * The value of a `with:` input inside a single step block, or undefined.
 *
 * Must strip a TRAILING comment, not just a whole-line one. `cache: npm # hosted-only`
 * parses as `npm` in YAML, and a naive read of the rest of the line sees
 * `npm # hosted-only` — which matches no rule and so slips past every assertion.
 * Verified during #7383: adding exactly that line to a job left the suite 9/9
 * green while the workflow really did hardcode the cache.
 */
export function stepInput(stepLines, key) {
  // A step's FIRST line carries the `- ` list marker, so a key written there —
  // `- continue-on-error: true`, `- if: ...`, `- id: ...` — is not preceded by
  // whitespace alone and was invisible here until #7632, where a guard asserting
  // "the action step must NOT be continue-on-error" stayed green against a step
  // that was. Both spellings are the same config to GitHub; two spellings of
  // identical config must not disagree. Normalising the marker to two spaces
  // puts such a key at the same indent as every other one.
  const normalised = stepLines.map((l, i) =>
    i === 0 ? l.replace(/^(\s*)-\s/, (_, sp) => `${sp}  `) : l
  )
  for (const line of code(normalised)) {
    const m = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(line)
    if (!m) continue
    const raw = m[1].trim()

    // A quoted scalar ends at its closing quote; anything after it is a comment.
    if (raw.startsWith("'") || raw.startsWith('"')) {
      const q = raw[0]
      const close = raw.indexOf(q, 1)
      return close === -1 ? raw.slice(1) : raw.slice(1, close)
    }
    // Otherwise a ` #` (whitespace-preceded, per YAML) starts a comment. `${{ }}`
    // expressions contain no `#`, so this cannot truncate a routed value.
    return raw.replace(/\s+#.*$/, '').trim()
  }
  return undefined
}

/**
 * Every workflow file, parsed. Discovered by `readdir` rather than from a list
 * held in a test — a hardcoded roster beside a growing set is the first cause
 * in docs/false-safety-guards.md, and it is how the `maestro-nightly.yml`
 * instance of #7383 stayed invisible through the fix for #7383.
 *
 * @param {URL} [dir] Override for the workflows directory (tests only).
 * @returns {Promise<Array<{name: string, text: string, jobs: object[]}>>}
 */
export async function readWorkflows(dir = new URL('../../../../.github/workflows/', import.meta.url)) {
  const names = (await readdir(dir)).filter(n => n.endsWith('.yml') || n.endsWith('.yaml'))
  return Promise.all(
    names.map(async name => {
      const text = await readFile(new URL(name, dir), 'utf8')
      return { name, text, jobs: parseJobs(text, name) }
    })
  )
}

/**
 * A step's `run:` key line, or undefined — the FIRST line of the step shaped
 * like the key, which is the same line `stepRun()` acts on.
 *
 * Deliberately a loose line-shape match rather than a second copy of
 * `stepRun()`'s indent arithmetic. It exists to CLASSIFY a step's YAML spelling
 * for the floors below, and a classifier that reproduced `stepRun()`'s internals
 * would degrade in step with it — the drift this module exists to prevent.
 *
 * Taking the FIRST match is what keeps a `run:`-shaped line INSIDE a block
 * scalar's body from being read as the key: the real key precedes its own body.
 *
 * It is NOT indent-anchored the way `stepRun`'s key search is, so a contrived
 * step — a `run:`-shaped line inside an earlier `env:` block scalar, say — can
 * hand back the wrong line. Measured across all 137 live run steps: zero
 * disagreements with the line `stepRun` anchors on. And the failure direction is
 * one-way: `stepRun` computes the body from its OWN exact-indent anchor
 * regardless of what this picked, so a mis-picked head can only drop a step out
 * of a bucket, never move one in. Deflation makes a floor HARDER to clear, which
 * is the safe direction for a positive control (#7658 review).
 */
const runKeyLine = stepLines => stepLines.find(l => /^\s*(?:-\s+)?run:/.test(l))

/**
 * Which of `stepRun()`'s three branches this `run:` key line selects: a BLOCK
 * scalar header (`|`, `>`, and the chomping and indent-indicator forms), a
 * QUOTED flow scalar, or a plain one.
 *
 * Three outcomes rather than "block or not", because the floors below must
 * count each of `stepRun`'s branches SEPARATELY. An earlier version asked only
 * `!isBlockRunHead`, which swept quoted heads into the plain bucket and made
 * the plain floor satisfiable by a branch it does not measure: with the plain
 * branch deleted, a synthetic corpus of 45 quoted heads and 25 block ones kept
 * `assertReaderSane` GREEN. That is this module's own defect class — a floor
 * whose stated subject is one branch, cleared by another — and it also
 * contradicted the comment beside it, which claimed quoted heads were not
 * floored at all. Caught in review of #7658; the test named for it below is
 * that counterexample, kept.
 *
 * The block grammar deliberately MIRRORS `stepRun`'s own (`/^([|>])([-+]?\d*)$/`)
 * rather than improving on it: both accept `|-2` and both reject the equally
 * legal `|2-`. Agreeing with `stepRun` is the property that matters here, since
 * a classifier that recognised a spelling `stepRun` does not would count a step
 * whose body is the garbage string `'|2-'`. If `stepRun`'s regex is ever
 * widened, widen this one in the same change.
 */
function runHeadSpelling(line) {
  const m = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line)
  const value = m ? m[1].trim() : ''
  if (BLOCK_HEAD.test(value)) return 'block'
  if (value.startsWith("'") || value.startsWith('"')) return 'quoted'
  return 'plain'
}

/**
 * Floors for the two `run:` spellings, calibrated 2026-09-09 against the live
 * corpus: 137 run steps across 7 workflows — **42 block-spelled** (41 of which
 * yield a multi-line body) and **95 plain-spelled**. Loose, like the floors
 * above, for the same reason: ~50% headroom catches a branch that has collapsed
 * without blaming the reader for someone else's refactor.
 *
 * The 42 is cross-checked by an unrelated method: #7647 reached the same number
 * from the other direction, deleting `stepRun()`'s block branch and watching the
 * body count fall. Its figures were 135 run bodies, 93 plain, 42 block; the
 * corpus has since gained two plain scalars and no block ones, which is why the
 * plain number moved and the block number did not.
 *
 * All 42 block heads are `|` today — the corpus contains ZERO `>` folded
 * blocks. So the `>` half of `isBlockRunHead` is carried for correctness, not
 * exercised by this floor; `ci-workflow-reader.test.js` covers folding on
 * synthetic input, which is where a shape the real directory lacks belongs.
 */
export const MIN_BLOCK_RUN_STEPS = 20
export const MIN_PLAIN_RUN_STEPS = 40

/**
 * The shared positive control every consumer must run BEFORE its rules.
 *
 * Thresholds are LOOSE on purpose. Their job is to catch a reader that has
 * stopped understanding these files (which yields zero), not to pin today's job
 * count — sitting them on exact numbers would turn "a job was merged away" into
 * a failure that blames the reader for someone else's refactor.
 *
 * WHY IT ALSO EXERCISES `stepRun` (#7647)
 * ---------------------------------------
 * The floors above read RAW STEP LINES and never called `stepRun()` — the
 * accessor four of the eight `ci-*.test.js` consumers now anchor every RUN-BODY
 * assertion to. Measured: deleting `stepRun()`'s block-scalar branch drops 42
 * of 135 run bodies, and this function — the one whose whole job is to say "the
 * reader is still working" — reported the reader healthy, with every core test
 * of `ci-scripts-tests-registration.test.js` staying green. A third of the
 * reader's output could vanish behind a clean bill of health.
 *
 * Each spelling is floored SEPARATELY, and each step is classified by its raw
 * YAML head rather than by the shape of what `stepRun` returned. Classifying by
 * the output would be circular — it would ask the mutated function to report
 * its own mutation — and it is also wrong on this corpus: one of the 42
 * block-spelled steps yields a single-line body, so "multi-line means block"
 * both undercounts and, run backwards, lets a surviving block branch stand in
 * for a dead plain one.
 *
 * The discriminators are sound in the direction that matters. ONLY the block
 * branch can emit a newline, so "N block-spelled steps yielded a multi-line
 * body" cannot be satisfied by a plain scalar; and the plain floor counts only
 * steps whose head is not a block head, so a live block branch cannot vouch for
 * a dead plain one.
 *
 * The QUOTED branch (`run: "echo hi"`) is EXCLUDED from both floors rather than
 * given a third. This corpus contains zero quoted run heads, so a floor over
 * them would be a gate satisfied by zero rows — #7503, the "filter whose terms
 * match nothing" cause in docs/false-safety-guards.md. Excluding is not the same
 * as ignoring: a quoted head counted as plain would let a live quoted branch
 * clear the floor that measures the plain one, which is how the first version of
 * this code failed. `ci-workflow-reader.test.js` covers the quoted branch with
 * synthetic input, the right home for a shape the real directory lacks.
 *
 * WHAT THESE FLOORS STILL CANNOT SEE, stated so no caller reads them as more
 * than they are. They count bodies of the right SHAPE; they do not inspect
 * content. So a block branch that still returns multi-line text while CORRUPTING
 * it passes: swapping `Math.min` for `Math.max` in the dedent arithmetic
 * over-slices every line (`echo` becomes `ho`), and both floors stay green
 * (#7658 review). So does a `>` folded wrongly. Those belong to `fold()`'s and
 * `stepRun()`'s own unit tests in `ci-workflow-reader.test.js`, and to the
 * `bash -n` pass in `ci-workflow-run-blocks-parse.test.js`, which is what
 * actually catches the dedent case today. A positive control answers "is the
 * reader still producing output of each kind"; it cannot answer "is the output
 * right".
 */
/**
 * Every workflow file yields the jobs it declares, and every job yields steps.
 *
 * THE FLOORS BELOW ARE GLOBAL TOTALS, AND THAT IS A BLIND SPOT (#7659). `ci.yml`
 * carries 22 of this repo's 34 jobs and clears every one of them on its own, so
 * a file that silently stops parsing contributes nothing and the reader still
 * reports healthy. Measured while reviewing #7662: misindenting ONE job id in
 * `nightly-k8s-integration.yml` by a single space drops that file to zero jobs,
 * leaves `assertReaderSane` green, and hides a genuine two-resolve-in-five-
 * minutes violation from the guard written to catch exactly that.
 *
 * A global floor structurally cannot see this, so this check is PER FILE and
 * derives its expectation from a DIFFERENT signal than `parseJobs` uses.
 * `parseJobs` anchors on the job-id key at two spaces; this counts the job-level
 * key every job must have — `runs-on:` for a normal job, `uses:` for a
 * reusable-workflow call, both at exactly four spaces, and the schema allows
 * exactly one of them per job. Deriving the expectation from the same regex the
 * subject uses would be the "expectation computed from its own subject" failure
 * in docs/false-safety-guards.md; two independent readings of the same file have
 * to agree, and when they do not, one of them is wrong.
 *
 * Equality, not a floor: parsed > declared means a job with neither key, which
 * GitHub rejects, and parsed < declared is the collapse above.
 *
 * The step check is the same argument one level down — a file whose jobs parse
 * but whose STEPS do not contributes no run bodies, and every rule that
 * quantifies over run bodies then passes over an empty set for that file. All
 * 34 jobs in this repo have steps.
 *
 * WHAT IT STILL CANNOT SEE, stated so no caller reads it as more: a job
 * re-indented WHOLESALE moves its `runs-on:` too, so both readings fall
 * together and agree. That YAML is invalid — a sibling key cannot sit at a
 * shallower indent than the mapping it follows — and `actionlint` runs in CI,
 * which is what catches it. This closes the case where the two readings can
 * DISAGREE, which is the one a guard can decide by itself.
 *
 * That hole is now smaller than this paragraph implies, and the correction is
 * recorded rather than the paragraph rewritten, because the limitation is
 * still real for one file. `assertEveryFileContributes` below reads the raw
 * text with NO indent anchoring at all, so a wholesale re-indent leaves its
 * declared count untouched while every body vanishes: measured in review of
 * #7666, re-indenting the whole `jobs:` block of nightly-k8s-integration.yml,
 * repo-relay.yml or maestro-nightly.yml keeps THIS check green and turns that
 * one RED. It stays true only for a file carrying no run bodies — stale.yml.
 *
 * THE STEP COUNT IS THE THIRD ROW, AND `steps.length === 0` WAS THE WEAK
 * VERSION OF IT (#7668)
 * ----------------------------------------------------------------------
 * A step whose keys sit on the line AFTER the dash is legal Actions YAML:
 *
 *     steps:
 *       -
 *         name: thing
 *         uses: actions/setup-node@abc
 *       - run: echo hi
 *
 * `parseSteps` starts a step at `/^(\s*)- /`, which needs the space on the
 * SAME line, so it does not start one here and those lines are absorbed into
 * the PREVIOUS step. Nothing above could see that. The stepless check below
 * only rejects ZERO, and the job still has steps. Neither of
 * `assertEveryFileContributes`'s rows can reach it BY CONSTRUCTION: the run
 * half counts one body per step, so absorbing a non-run step changes nothing,
 * and the setup half counts LINES, which a merge never changes. Measured on a
 * synthetic file: js-yaml 4 steps, `parseSteps` 3, both rows green.
 *
 * It is not only a count. The absorbed `with:` block lands in the wrong step,
 * so `stepInput()` on the merged block can hand back a NEIGHBOUR'S value — the
 * #7383 failure (a guard reading the wrong step's config) one layer down.
 *
 * The different signal is the one this function already uses one level up: the
 * schema gives every step exactly one of `run:` or `uses:`, the way it gives
 * every job exactly one of `runs-on:` or `uses:`. So the declared side counts
 * that required KEY in the raw text, at any indent, with no notion of a job or
 * a step — nothing of `parseSteps`'s list-marker arithmetic — and the parsed
 * side is `j.steps.length`. Equality, not a floor, and the reason is NOT the
 * one the jobs row gives. That row says parsed > declared means an invented
 * job; here that direction is mostly the declared side failing to recognise a
 * legal key spelling — measured, on real `parseJobs` output: `- "run": echo hi`
 * (quoted key) gives 2/0, `- run : echo hi` (space before the colon) 1/0, and
 * `- { run: echo hi }` (a flow-mapping step, #7669) 1/0. Every one of those is
 * a real step this row cannot see the declaration of. A floor in either
 * direction would pass over all of them; equality refuses the corpus and names
 * the file, which is the fail-closed behaviour this module wants. The
 * INVENTED-step reading is still true, but only for a SYNTHETIC caller that
 * builds `jobs` and `text` separately — the same qualification
 * `assertEveryFileContributes` makes about its own `>` direction.
 *
 * VALUE-AGNOSTIC ON PURPOSE, unlike `assertEveryFileContributes`'s `RUN_KEY`.
 * A `run:` whose value sits on the next line is still a step, and requiring a
 * value here would turn this row RED on the exact spelling that function pins
 * as a known false GREEN (#7670) — red for the WRONG reason, since the step
 * count really is 1 and only the BODY is lost. A guard that is wrong about its
 * own quantity for a legal spelling is worse than one that is silent.
 *
 * TWO EXCLUSIONS, BOTH LOAD-BEARING, both pinned by their own case — and they
 * are the two the LIVE CORPUS needs, not an exhaustive list of the places a
 * mapping key can be spelled `run` or `uses`. See the false reds below:
 *   - A job's own `uses:` — the reusable-workflow call — sits at the job-key
 *     indent with no list marker. It is counted as a JOB above; counting it
 *     here would declare a step for a job that has none.
 *   - `defaults:` -> `run:` is a MAPPING HEAD, not a step key. ci.yml has 15,
 *     so without this the live corpus reads 15 steps over. Identified by its
 *     PARENT — the previous non-blank, non-comment line is a `defaults:` key —
 *     rather than by an indent number, so it survives a file that nests
 *     differently.
 *
 * NO `code()` CALL, deliberately. The anchor forces the first non-space
 * character to be `-`, `r` or `u`, and a comment's is `#`, so a comment filter
 * here could not change a count — which is exactly the INERT call review of
 * #7666 found and deleted on the run side, the "comment describes a stronger
 * check than the code performs" cause in docs/false-safety-guards.md.
 *
 * THE LEGITIMATE ZERO, and it is weaker evidence than the run row's. A file
 * with no jobs declares zero steps and yields zero, so it needs no roster —
 * the same structural argument. But EVERY workflow here that has a job has
 * steps, so unlike `stale.yml` for run bodies, no live file exercises the zero.
 * Said rather than implied, because an untested branch described as handled is
 * how this module's other floors got their corrections.
 *
 * IT AND THE STEPLESS CHECK ARE NOT REDUNDANT. This row is per FILE and catches
 * a step LOST while its required key is still in the text. The stepless check
 * is per JOB and catches a job that yields nothing at all — which this row
 * cannot see when the text declares no steps for it either, the reusable-
 * workflow spelling being exactly that case.
 *
 * IT DETECTS, IT DOES NOT HANDLE (the open question in #7668, decided here).
 * Teaching `parseSteps` the spelling means teaching `stepRun` and `stepInput`
 * it too — both anchor on the dash line — across ten importing suites, for a
 * shape the corpus has zero instances of. Detection fails CLOSED on the day
 * someone writes one, and points at the file. Handling it can be done later
 * against a red build; the reverse is not true.
 *
 * WHAT IT CANNOT SEE. It is a per-FILE total, so one job losing a step while a
 * sibling gains one agrees — the same limitation both rows below carry.
 * FALSE REDS, disclosed rather than guarded for the same reason as theirs: a
 * `run:`- or `uses:`-shaped line inside a block scalar's BODY, ANY mapping key
 * literally named `run` or `uses` outside a step — a `with:` input, an `env:`
 * variable (measured: a job-level `env:` -> `run:` gives declared 2 against
 * parsed 1) — and a step carrying both keys or neither. The last is invalid to
 * GitHub; none exists in the corpus; all fail CLOSED.
 *
 * ONE COUPLING TO THE JOBS ROW, undocumented until review of this change and
 * worth stating because nothing in either row's comment implied it. The `<= 4`
 * above is the step row's only indent literal, and it is safe ONLY because
 * `declaredJobs` requires `runs-on:`/`uses:` at EXACTLY four spaces: a job body
 * shallow enough for a bare-dash step's continuation line to land at <= 4 has
 * already failed the jobs row, and a job body that clears the jobs row cannot
 * put one there (measured: dash at 4, continuation at 5, declared 2 / parsed 1,
 * RED). Loosen `^ {4}` in `declaredJobs` without revisiting this and the
 * absorbed-step case this row exists for becomes silently GREEN again.
 */
export function assertEveryFileParsed(workflows) {
  const declaredJobs = text =>
    code(text.split('\n')).filter(l => /^ {4}(?:runs-on|uses):/.test(l)).length

  const disagreements = workflows
    .map(w => ({ file: w.name, parsed: w.jobs.length, declared: declaredJobs(w.text) }))
    .filter(f => f.parsed !== f.declared)
  assert.deepEqual(
    disagreements,
    [],
    'a workflow file yields a different number of jobs than it declares — the reader has stopped ' +
      'understanding that file, and every rule below it passes over an empty set for it'
  )

  // The step row runs AFTER the jobs row and BEFORE the stepless one, and the
  // order is load-bearing in both directions. A file whose jobs collapse also
  // loses every step, so the jobs row has to speak first or the failure blames
  // the wrong quantity. And a file whose text declares steps while the parse
  // yields none must report the disagreement rather than the emptier
  // `steps.length === 0`, which says nothing about what was lost.
  const stepDisagreements = workflows
    .map(w => ({
      file: w.name,
      parsed: w.jobs.reduce((n, j) => n + j.steps.length, 0),
      declared: declaredSteps(w.text),
    }))
    .filter(f => f.parsed !== f.declared)
  assert.deepEqual(
    stepDisagreements,
    [],
    'a workflow file yields a different number of steps than its text declares — one of the two ' +
      'readings has stopped recognising a step, so a rule anchored to a step body reads a ' +
      'neighbour\'s step, none, or one the text does not contain'
  )

  const stepless = workflows.flatMap(w =>
    w.jobs.filter(j => j.steps.length === 0).map(j => `${w.name}:${j.id}`)
  )
  assert.deepEqual(
    stepless,
    [],
    'a job parsed with no steps at all — it contributes no run bodies, so every run-body rule ' +
      'passes over nothing for it'
  )
}

/**
 * How many steps a workflow's TEXT declares, counted by the key the schema
 * requires every step to carry exactly one of. See `assertEveryFileParsed`'s
 * comment for why this key, why it is value-agnostic, and why the two
 * exclusions below are each load-bearing.
 *
 * @param {string} text Raw workflow text.
 */
function declaredSteps(text) {
  const lines = text.split('\n')
  return lines.filter((_, i) => isStepKeyLine(lines, i, STEP_REQUIRED_KEY)).length
}

/** Either of the two keys the schema requires a step to carry exactly one of. */
const STEP_REQUIRED_KEY = /^(\s*)(-\s+)?(?:run|uses):/
/** Just `run:` — the same question, for the run-body row. */
const STEP_RUN_KEY = /^(\s*)(-\s+)?run:/

/**
 * Is `lines[i]` a STEP-level key line matching `re`?
 *
 * ONE predicate for both rows, because the hard part is shared and was already
 * transcribed once: a job's own `uses:` (no list marker, at the job-key indent —
 * `declaredJobs` counts it, with the same `^ {4}` this negates) and the
 * `defaults:` -> `run:` mapping head are the two things a step key is NOT, and
 * getting either wrong moves a count on the live corpus.
 *
 * `re` must capture the indent as group 1 and the optional list marker as
 * group 2; it is passed precompiled rather than interpolated, so no caller can
 * widen it with a metacharacter (the hazard `valuelessKey` refuses outright).
 */
const isStepKeyLine = (lines, i, re) => {
  const m = re.exec(lines[i])
  if (!m) return false
  if (m[2] === undefined && m[1].length <= 4) return false
  return !isDefaultsRunHead(lines, i)
}

/**
 * Whether the `run:` key on `lines[at]` is the head of a `defaults:` mapping
 * rather than a step's key — true when the previous non-blank, non-comment line
 * is a `defaults:` key.
 *
 * Blank and comment lines are skipped for the same reason `runsOnOf` skips
 * them: a comment between the two keys must not hide the relationship.
 *
 * The `(?:#.*)?$` is the trailing-comment allowance `parseJobs` already uses on
 * a job-id line (#7499), and it is not decoration: `defaults: # bash everywhere`
 * is legal YAML that this repo's style writes freely, and a bare `$` anchor
 * misses it, so the `run:` beneath counts as a step and the file goes RED at
 * declared+1. Measured before the fix: declared 2, parsed 1. Found by review of
 * this change, not by writing it.
 *
 * FOUR SIBLING ANCHORS IN THIS MODULE STILL LACK IT — `parseSteps`'s and
 * `jobShell`'s `steps:`, and `jobShell`'s `defaults:` and `run:`. Named here
 * rather than fixed here: each has its own blast radius (`jobShell` returning
 * undefined decides whether a run block is fed to `bash -n`), and fixing three
 * of four while walking past the fourth is this repo's adjacent-field pattern.
 * Tracked separately.
 *
 * Read by PARENT, and by nothing else. This carried an indent comparison as
 * well — the parent had to be SHALLOWER — until a mutation sweep proved it
 * inert: no legal spelling can falsify it, because `defaults:` is valid only at
 * workflow and job level, and a step's own `run:` always has `steps:` and a
 * dash line between it and any `defaults:`. A filter that cannot alter an
 * outcome is not a weak guard, it is a comment that reads like one — the same
 * finding that deleted the `code()` call in `assertEveryFileContributes`
 * (#7666 review), and the same cause in docs/false-safety-guards.md.
 */
function isDefaultsRunHead(lines, at) {
  for (let i = at - 1; i >= 0; i--) {
    if (/^\s*(?:#|$)/.test(lines[i])) continue
    return DEFAULTS_KEY.test(lines[i])
  }
  return false
}

/**
 * Per-file agreement for the two quantities the GLOBAL floors below count:
 * `run:` bodies, and `actions/setup-node@` steps.
 *
 * WHY THIS EXISTS AT ALL (#7659)
 * ------------------------------
 * `assertEveryFileParsed` closed the STRUCTURE half — a file must yield the
 * jobs it declares, and every job must yield steps. This closes the CONTENT
 * half, which that check structurally cannot reach: a file whose jobs are
 * present, whose steps are present, and whose parsed `run:` content is simply
 * gone. Every remaining floor in `assertReaderSane` is a total across the whole
 * set, and `ci.yml` alone clears all of them — it carries 91 of the 137 run
 * bodies, 17 of the 24 setup-node steps and 22 of the 34 jobs. So a file that
 * stops yielding run bodies contributes nothing to any of them and the shared
 * positive control still reports the reader healthy.
 *
 * WHAT MAKES IT A CONTROL AND NOT A RESTATEMENT
 * --------------------------------------------
 * Both quantities are compared against a reading of the file's RAW TEXT that
 * shares none of the reader's structure. The parsed side walks
 * `parseJobs` -> `parseSteps` -> `stepRun`, where `stepRun` anchors the key at
 * exactly the step's dash indent plus two and then branches on the head's
 * shape. The declared side matches a step-level `run:` key anywhere in the
 * file, at any indent, with no notion of a job or a step. A collapse along that
 * chain — a job lost, a step lost, the key not found at the anchored indent, a
 * branch that stops returning a body — makes the two disagree. Deriving the
 * expectation from the same traversal the subject uses would be the
 * "expectation computed from its own subject" cause in
 * docs/false-safety-guards.md, which is the trap #7662 avoided the same way one
 * level up.
 *
 * THE INDEPENDENCE USED TO BE QUALIFIED, AND IS NOT ANY MORE (#7670). The
 * declared side required a NON-EMPTY value after the colon, and `stepRun`
 * returned '' for a plain scalar continued on the next line — so for that one
 * spelling both sides encoded the same rule, agreed at zero by construction
 * rather than by evidence, and a file written entirely that way collected the
 * free pass stale.yml gets. The shared rule was removed from BOTH sides at
 * once, which is the only fix for that shape: `stepRun` folds the continuation
 * and the declared side counts a bare `run:` key, with the `defaults:` mapping
 * head excluded by its PARENT instead of by the absence of a value.
 *
 * THE LEGITIMATE ZERO IS STRUCTURAL, NOT AN EXEMPTION
 * ---------------------------------------------------
 * `stale.yml` has no run steps and no setup-node step today. It needs no entry
 * on any list: it declares zero, so zero is what it is required to yield, and
 * a file that later grows its first run step starts being held to it on the
 * same commit. A hardcoded roster beside a growing set is the first cause in
 * docs/false-safety-guards.md, and this module has already been bitten by one
 * (the consumer list at the top of this file).
 *
 * EQUALITY, NOT A FLOOR, for the same reason `assertEveryFileParsed` uses one:
 * yielded > declared means the reader has INVENTED a body — a `run:`-shaped
 * line the file's text does not contain at all — which is as much a defect as
 * losing one, and a floor cannot see it. Said precisely, because the sentence
 * reads as though it protects the live corpus and it does not: for a caller
 * whose `jobs` came from `parseJobs(w.text)` every step is a slice of that
 * same text, so yielded <= declared always holds and the `>` direction is
 * unreachable. What it guards is the SYNTHETIC callers — the fixtures in
 * `ci-scripts-tests-registration.test.js` build `jobs` and `text` separately —
 * and any future reader that stops deriving one from the other.
 *
 * PROSE MUST NOT COUNT AS A DECLARATION, and the two halves need DIFFERENT
 * defences for it — a fact established by mutating them, not by reasoning
 * about them. The setup-node side matches a SUBSTRING, so a comment that
 * quotes the action is indistinguishable from a step that uses it, and both
 * of its readings run through `code()`. The run side does not need one: a
 * comment line's first non-space character is `#`, and `RUN_KEY` requires
 * that character to be `-` or `r`, so the two filters are mutually exclusive
 * by construction. `code()` was written on that side first and a mutation
 * sweep found it INERT — removing it changed no count and killed no test.
 * A filter that cannot alter an outcome is not a weak guard, it is a comment
 * that reads like one, which is the "guard whose comment describes a stronger
 * check than its code performs" cause in docs/false-safety-guards.md. So it
 * is gone, and the anchor that does the work is pinned by its own case.
 *
 * WHAT IT CANNOT SEE, stated so no caller reads it as more than it is. Most of
 * this list came out of review rather than out of writing the function, which
 * is the usual ratio and the reason the list is here at all.
 *
 * It counts bodies; it does not INSPECT them, so a branch that still returns
 * multi-line text while CORRUPTING it agrees with the declared count and
 * passes. `fold()`'s and `stepRun()`'s unit tests and the `bash -n` pass in
 * `ci-workflow-run-blocks-parse.test.js` are what catch that.
 *
 * FALSE REDS — legal spellings that fire on a healthy reader. Disclosed rather
 * than guarded: each fails CLOSED, none exists in the corpus today, and
 * excluding them would mean growing a second block-scalar parser on the
 * declared side, which is the drift this module exists to prevent.
 *   - A `run:`-shaped line inside a block scalar's BODY — a heredoc writing a
 *     YAML file, say. The declared side has no notion of "inside a block
 *     scalar", so it counts a line the parsed side correctly reads as data.
 *   - A `run: |` with an empty block body, or `run: ''` — a declared key
 *     against a yielded `''`.
 *   - A setup-node reference outside any step.
 *
 * THE ONE FALSE GREEN IS FIXED, and the paragraph is corrected rather than
 * deleted, because the SHAPE is the thing worth remembering. A plain scalar
 * whose value sits on the NEXT line is a real run step to YAML:
 *
 *     - name: thing
 *       run:
 *         echo hi
 *
 * `stepRun` used to return `''` and the declared side used to skip the key,
 * because BOTH encoded the same rule — nothing after the colon means nothing.
 * Agreement is not evidence where the two sides share a rule, and no amount of
 * testing either side alone could have found it. #7670 removed that rule from
 * both at once; the case that pinned the behaviour is now INVERTED and asserts
 * that both sides see the step.
 *
 * And a step written as a bare `- ` with its keys on the following line is
 * absorbed into the previous step by `parseSteps`, which neither row here can
 * see: the run half counts one body per step and the setup half counts lines,
 * so a merge changes neither total. CLOSED IN #7668, one level up rather than
 * here — `assertEveryFileParsed`'s step-count row uses the same
 * different-signal method against the required `run:`/`uses:` step key. The
 * limitation is still true OF THESE TWO ROWS, which is why it is corrected in
 * place rather than deleted: they remain blind to it, and something else now
 * is not.
 */
export function assertEveryFileContributes(workflows) {
  // A step's `run:` key, WITH OR WITHOUT a value on the key line (#7670).
  //
  // This required a non-empty value until `stepRun` learned to read a plain
  // scalar continued on the next line. That requirement was doing two jobs at
  // once: excluding the 15 `defaults:` -> `run:` -> `shell:` mapping heads in
  // ci.yml, and — accidentally — excluding a real run step whose value sits
  // below the key. The two are now separated: `isStepKeyLine` excludes the
  // mapping head BY ITS PARENT, and a bare `run:` key counts as the step it is.
  // Leaving `\S` in place would have put the declared side one BEHIND the
  // yielded side for that spelling, which is measured in a case below.
  //
  // The leading `^` is what keeps PROSE out: it forces the first non-space
  // character to be `-` or `r`, which a comment line never is. Drop it and
  // repo-relay.yml's prose starts counting: line 210 quotes a `run:` key
  // inside a comment. Named exactly, because the first version of this line
  // blamed ci.yml, which has no such line at all — the hazard is real and
  // lives one file over.
  const runRows = workflows.map(w => ({
    file: w.name,
    declared: (l => l.filter((_, i) => isStepKeyLine(l, i, STEP_RUN_KEY)).length)(w.text.split('\n')),
    yielded: w.jobs
      .flatMap(j => j.steps)
      .filter(s => {
        const body = stepRun(s)
        return typeof body === 'string' && body.length > 0
      }).length,
  }))
  assert.deepEqual(
    runRows.filter(r => r.declared !== r.yielded),
    [],
    'a workflow file yields a different number of `run:` bodies than its text declares — that ' +
      'file now contributes nothing to the run-step floors below, and ci.yml clears those on ' +
      'its own, so no total can see it'
  )

  // Both sides count LINES containing the action, not steps — a step carrying
  // two would count twice on both. The quantity is stable because it is the
  // same on each side; the WORD "steps" in the message below is the loose
  // reading, and #7667 is where the counting rule itself gets decided.
  const setupRows = workflows.map(w => ({
    file: w.name,
    declared: code(w.text.split('\n')).filter(l => l.includes(SETUP_NODE)).length,
    yielded: w.jobs.flatMap(j =>
      j.steps.flatMap(s => code(s).filter(l => l.includes(SETUP_NODE)))
    ).length,
  }))
  assert.deepEqual(
    setupRows.filter(r => r.declared !== r.yielded),
    [],
    'a workflow file declares setup-node LINES the reader does not reach through its jobs and ' +
      'steps — the global setup-node floor below cannot see this, ci.yml clears it alone'
  )
}

export function assertReaderSane(workflows) {
  assert.ok(workflows.length >= 5, `expected >=5 workflow files, found ${workflows.length}`)
  assert.ok(
    workflows.some(w => w.name === 'ci.yml'),
    'expected ci.yml among the scanned workflows'
  )
  assert.ok(
    workflows.some(w => w.name === 'release.yml'),
    'expected release.yml among the scanned workflows'
  )
  const totalJobs = workflows.reduce((n, w) => n + w.jobs.length, 0)
  assert.ok(totalJobs >= 20, `expected >=20 jobs across all workflows, found ${totalJobs}`)

  // ORDER IS LOAD-BEARING, and the two kinds of check above and below are not
  // redundant with each other (#7659).
  //
  // The four assertions ABOVE are SET-LEVEL, and they are the only thing between
  // a per-file check and an empty set: every per-file check is a quantifier over
  // `workflows`, and a quantifier over an EMPTY set is satisfied by zero rows —
  // the #7503 cause in docs/false-safety-guards.md. A `readWorkflows` returning
  // `[]` would clear every per-file agreement below in perfect silence.
  //
  // HOW MUCH they prove, measured rather than assumed: `>=5` tolerates TWO of
  // the seven files going MISSING — dropping repo-relay.yml AND
  // nightly-k8s-integration.yml leaves this whole function green at 32 jobs and
  // 130 run bodies; three dropped is the first red. That is #7659 in its ABSENT
  // mode, which no per-file check can reach by construction — they quantify
  // over the files that are PRESENT. Left loose on purpose, for the reason
  // stated above: pinning the exact count turns "a workflow was deleted" into a
  // failure that blames the reader for someone else's change.
  //
  // The two PER-FILE checks that follow are what the set-level floors cannot
  // do: with ci.yml carrying 22 of 34 jobs, 91 of 137 run bodies and 17 of 24
  // setup-node steps, it clears every total on its own, so a total says
  // nothing about the other six files. Structure first, then content.
  assertEveryFileParsed(workflows)
  assertEveryFileContributes(workflows)
  const setupNodeSteps = workflows.flatMap(w =>
    w.jobs.flatMap(j => j.steps.filter(s => s.some(l => l.includes(SETUP_NODE))))
  )
  assert.ok(
    setupNodeSteps.length >= 15,
    `expected >=15 setup-node steps across all workflows, found ${setupNodeSteps.length} — ` +
      'the reader is probably broken'
  )

  const runSteps = workflows.flatMap(w =>
    w.jobs.flatMap(j =>
      j.steps
        .map(s => ({ head: runKeyLine(s), body: stepRun(s) }))
        .filter(s => s.head !== undefined)
    )
  )
  const blockBodies = runSteps.filter(
    s =>
      runHeadSpelling(s.head) === 'block' &&
      typeof s.body === 'string' &&
      s.body.includes('\n') &&
      // Non-blank, so a branch degraded to emitting only newlines does not
      // clear a floor that means "still producing block bodies" (#7658 review).
      s.body.trim().length > 0
  )
  assert.ok(
    blockBodies.length >= MIN_BLOCK_RUN_STEPS,
    `expected >=${MIN_BLOCK_RUN_STEPS} block-scalar \`run:\` steps to yield a multi-line body, found ` +
      `${blockBodies.length} — stepRun()'s BLOCK-scalar branch has stopped producing anything. ` +
      'The floors above cannot see this: they read raw step lines and never call stepRun().'
  )
  const plainBodies = runSteps.filter(
    s =>
      runHeadSpelling(s.head) === 'plain' &&
      typeof s.body === 'string' &&
      s.body.length > 0 &&
      !s.body.includes('\n')
  )
  assert.ok(
    plainBodies.length >= MIN_PLAIN_RUN_STEPS,
    `expected >=${MIN_PLAIN_RUN_STEPS} plain-scalar \`run:\` steps to yield a body, found ` +
      `${plainBodies.length} — stepRun()'s PLAIN-scalar branch has stopped producing anything. ` +
      'Neither a live block branch nor a live quoted one can stand in for it: these are counted ' +
      'by their raw YAML head.'
  )
}

/**
 * A job's `defaults.run.shell`, or undefined.
 *
 * Read from the job's keys BEFORE `steps:`, which is what makes it a job
 * default rather than one step's.
 *
 * A `shell:` named only in a comment must not be read as configuration —
 * ci.yml's `server-tests-windows` explains its choice in prose containing the
 * literal string "shell: bash". TWO things independently prevent that: the
 * pattern anchors `shell:` to the start of the line after indent, and `code()`
 * drops comment lines first. They are redundant, and deliberately kept so:
 * mutating either ALONE leaves the property intact, and it takes removing both
 * to turn the guard red (verified). The comment says this rather than crediting
 * `code()` alone, which would be a rationale describing a stronger check than
 * any single line performs.
 *
 * This is not a nicety: BOTH of this repo's PowerShell jobs
 * (`server-tests-windows`, `desktop-tests-windows`) declare their shell here
 * and NEITHER declares it on a step. A consumer that looked only at step-level
 * `shell:` would classify all six of their run blocks as bash — the
 * "guard wired to only some of its callers" cause in docs/false-safety-guards.md.
 */
export function jobShell(jobBody) {
  const stepsAt = jobBody.findIndex(l => STEPS_KEY.test(l))
  const lines = code(jobBody.slice(0, stepsAt === -1 ? jobBody.length : stepsAt))

  // Anchored to `defaults:` → `run:` → `shell:`, not "any shell: before steps:".
  // The unanchored version read a `strategy.matrix.shell` axis, or an
  // `env.shell`, as the job's effective shell. That is the dangerous direction:
  // the run-block guard only feeds bash/sh shells to `bash -n`, so one false
  // "powershell" here silently drops every real bash block in that job out of
  // the check — "a guard wired to only some of its callers", and the mirror
  // image of the bug it was written for.
  const defaultsAt = lines.findIndex(l => DEFAULTS_KEY.test(l))
  if (defaultsAt === -1) return undefined
  const defaultsIndent = /^(\s*)/.exec(lines[defaultsAt])[1].length

  let runIndent = null
  for (let i = defaultsAt + 1; i < lines.length; i++) {
    const indent = /^(\s*)/.exec(lines[i])[1].length
    if (indent <= defaultsIndent) break
    if (runIndent === null) {
      if (RUN_MAPPING_KEY.test(lines[i])) runIndent = indent
      continue
    }
    if (indent <= runIndent) break
    const m = /^\s*shell:\s*(.*)$/.exec(lines[i])
    if (m) return m[1].replace(/\s+#.*$/, '').trim()
  }
  return undefined
}

/**
 * The shell script a step runs, as YAML would hand it to the runner — or
 * undefined for a step with no `run:`.
 *
 * It must reproduce YAML's reading, not a friendlier one, because the whole
 * point is to catch a `run:` whose YAML value is not what its author sees. The
 * plain-scalar branch is where that bites: a whitespace-preceded `#` opens a
 * comment, so
 *
 *     run: echo "... see #7632."
 *
 * has the YAML value `echo "... see` — an unterminated quote, and a step that
 * fails at parse time on the runner. That exact line shipped into
 * repo-relay.yml during #7632 and was caught by `bash -n`, not by review.
 *
 * Block scalars (`|`, `|-`, `>`, and the indent-indicator forms) are the common
 * case and are taken literally: a `#` inside one is a SHELL comment and must
 * survive, so `code()` is deliberately not applied to the body.
 */
export function stepRun(stepLines) {
  if (!stepLines.length) return undefined
  const dash = /^(\s*)-\s/.exec(stepLines[0])
  if (!dash) return undefined
  const keyIndent = dash[1].length + 2
  const runKey = new RegExp(`^ {${keyIndent}}run:\\s*(.*)$`)

  for (let i = 0; i < stepLines.length; i++) {
    // The first line carries `- ` where later lines carry two spaces; normalise
    // it so a `- run: ...` step is found at the same indent as any other key.
    const line = i === 0 ? stepLines[i].replace(/^(\s*)-\s/, (_, sp) => `${sp}  `) : stepLines[i]
    const m = runKey.exec(line)
    if (!m) continue
    const head = m[1].trim()

    const block = BLOCK_HEAD.exec(head)
    if (block) {
      const dedented = keyBody(stepLines, i, keyIndent)
      return block[1] === '>' ? fold(dedented) : dedented.join('\n')
    }

    if (head.startsWith("'") || head.startsWith('"')) {
      const q = head[0]
      const close = head.indexOf(q, 1)
      return close === -1 ? head.slice(1) : head.slice(1, close)
    }

    // A PLAIN scalar whose value sits on the FOLLOWING lines (#7670). Nothing
    // after the colon does not mean nothing:
    //
    //     - name: thing
    //       run:
    //         echo hi
    //
    // is a real run step whose value is `echo hi`. This branch used to return
    // the empty string for it, so every guard anchored to `stepRun` — the
    // `bash -n` pass, the npm-resolve budget rule, the cache rules — passed
    // over an empty body and a step spelled this way was UNGUARDED.
    //
    // Folded, not joined with newlines, because that is what YAML does to a
    // multi-line plain scalar. NOT the same folding as `>` — see `foldPlain`,
    // which exists because sharing `fold()` here was wrong and measurably so.
    // A step whose key really carries nothing still yields '' — `keyBody`
    // returns no lines and `foldPlain([])` is ''.
    if (head === '') return foldPlain(keyBody(stepLines, i, keyIndent))

    return head.replace(/\s+#.*$/, '').trim()
  }
  return undefined
}

/**
 * Fold a `>` block scalar the way YAML does, so a consumer sees the ONE line
 * the runner will see rather than the several the author wrote.
 *
 * Treating `>` like `|` is not a cosmetic difference — it inverts this
 * module's whole purpose. `> / if true; then / echo hi / fi` reads as three
 * statements unfolded and parses clean, while GitHub hands bash the folded
 * `if true; then echo hi fi`, which dies with "unexpected end of file". The
 * guard would report green on a step that cannot run.
 *
 * The rules applied: a break between two non-empty lines at the base indent
 * becomes a SPACE; n blank lines become n newlines; a MORE-indented line is
 * literal and keeps the breaks around it.
 */
/**
 * A `run:` value that is a BLOCK-scalar header — `|`, `>`, their chomping and
 * indent-indicator forms, and YAML's optional trailing comment.
 *
 * ONE grammar, shared by `stepRun`'s branch selection and `runHeadSpelling`'s
 * classification. It was two, and `runHeadSpelling`'s comment claimed they
 * MIRRORED each other while its own pattern carried `\s*(?:#.*)?` that
 * `stepRun`'s did not — a comment describing a different check than the code
 * performs, in a module that catalogues that cause.
 *
 * The divergence was not cosmetic. `run: | # c` is legal YAML whose value is
 * `echo hi`; `stepRun` fell through to the plain catch-all and returned the
 * literal string `"|"`, while `runHeadSpelling` called the same step a block.
 * Measured against js-yaml in review of #7675: `| # c` -> `"|"`, `|- # c` ->
 * `"|-"`, `>+ # c` -> `">+"`. The last is the dangerous one: `>+` is a VALID
 * bash line (a redirect to a file named `+`), so `bash -n` passes it and a
 * content-inspecting guard sees `">+"` instead of the script it meant to read.
 * The same bare-`$` anchor #7673 swept out of every KEY position, surviving on
 * the VALUE side.
 */
const BLOCK_HEAD = /^([|>])([-+]?\d*)\s*(?:#.*)?$/

/**
 * Fold a PLAIN scalar's continuation lines, which is NOT what `fold()` does.
 *
 * The two look like the same operation and are not, and sharing them was this
 * change's own first mistake. A folded BLOCK scalar (`>`) keeps a
 * more-indented line literal — that is what lets a `>` block hold an indented
 * `if`/`fi` body. A PLAIN scalar has no such rule: every line break folds to a
 * space regardless of indent. Measured against js-yaml:
 *
 *     run:
 *       if true; then
 *         echo hi
 *       fi
 *
 * is the single line `if true; then echo hi fi`, not three lines. `fold()`
 * returned the three-line form, so `bash -n` would have validated a script the
 * runner never receives — a false green in the exact scenario `stepRun`'s
 * block-scalar comment names as the reason folding matters at all.
 *
 * Blank lines still collapse the same way in both: n line breaks become n-1
 * newlines, which is why a blank line survives as a `\n` here.
 *
 * `keyBody()` remains shared, because COLLECTING the lines really is the same
 * operation in both styles. Only the fold differs.
 */
function foldPlain(lines) {
  let out = ''
  let blanks = 0
  for (const line of lines) {
    const text = line.trim()
    if (text === '') {
      blanks++
      continue
    }
    if (out === '') out = text
    else out += blanks > 0 ? '\n'.repeat(blanks) + text : ` ${text}`
    blanks = 0
  }
  return out
}

/**
 * The lines belonging to the key at `stepLines[at]` — strictly more indented
 * than `keyIndent` — with the block's common indent removed and trailing blanks
 * dropped.
 *
 * ONE implementation, shared by `stepRun`'s block-scalar branch and its
 * continued-plain-scalar branch (#7670). The two differ only in what they do
 * with the result — a block literal joins, a folded or plain scalar folds — and
 * transcribing the collection twice is the drift this module exists to prevent.
 */
function keyBody(stepLines, at, keyIndent) {
  const body = []
  for (let j = at + 1; j < stepLines.length; j++) {
    const l = stepLines[j]
    if (/^\s*$/.test(l)) {
      body.push('')
      continue
    }
    if (/^(\s*)/.exec(l)[1].length <= keyIndent) break
    body.push(l)
  }
  while (body.length && body[body.length - 1] === '') body.pop()
  const widths = body.filter(l => l !== '').map(l => /^(\s*)/.exec(l)[1].length)
  const dedent = widths.length ? Math.min(...widths) : 0
  return body.map(l => l.slice(dedent))
}

function fold(lines) {
  const out = []
  let buf = null
  let blanks = 0
  const flush = () => {
    if (buf !== null) out.push(buf)
    buf = null
  }
  for (const line of lines) {
    if (line === '') {
      blanks++
      continue
    }
    if (/^\s/.test(line)) {
      flush()
      out.push('\n'.repeat(Math.max(blanks, 0)) + line)
      blanks = 0
      continue
    }
    if (buf === null) buf = line
    else if (blanks > 0) buf += '\n'.repeat(blanks) + line
    else buf += ' ' + line
    blanks = 0
  }
  flush()
  return out.join('\n')
}

/**
 * A job's CHECK CONTEXT name — its `name:` when present, else its job id.
 *
 * This is the string branch protection matches on, so it is the unit every
 * roster guard quantifies over. It lived as a hand-rolled four-line snippet
 * inside `contributing-required-checks.test.js` until #7639 needed the same
 * derivation for a second guard; transcribing it would have produced the
 * second implementation this module exists to prevent. That is not a
 * hypothetical drift risk here — `stepRun()` landed five days AFTER the guard
 * that needed it and left that guard on the blunt `code().join('\n')` for its
 * whole life (#7637). Adding a sharper tool to a shared module does not migrate
 * its existing consumers; this one is migrated in the same change.
 *
 * Anchored to a key at EXACTLY four spaces, which is the job-key column. That
 * is what excludes a step's own `name:` — steps sit at six spaces or deeper —
 * and it does so wherever the key appears in the job. An earlier version also
 * sliced the body at `steps:` for belt and braces, and that turned out to be a
 * regression rather than redundancy: YAML does not order mapping keys, so
 * `steps:` before `name:` is valid and GitHub still uses the name. The slice
 * silently returned the job id for such a job (#7643 review).
 *
 * YAML quoting is cosmetic — `name: "X"` and `name: X` are the same context —
 * so a single layer of matching quotes is stripped. An unquoted value ends at a
 * whitespace-preceded `#`, per YAML, so `name: Deploy # temporary` is the
 * context `Deploy`; reading the comment as part of the name would put a string
 * in the roster that branch protection can never match. `stepInput()` already
 * does this for step inputs and the two must not disagree.
 *
 * LIMITATION, stated because a caller cannot infer it: a matrix job's `name:`
 * is a TEMPLATE (`Deploy (${{ matrix.os }})`), and GitHub posts one context per
 * expansion, none of them equal to the template. This returns the template
 * verbatim. No job in this repo uses `strategy.matrix` today; if one is added,
 * its real contexts must be written out by hand, and
 * contributing-required-checks.test.js already fails a roster entry containing
 * `${{` for exactly that reason.
 */
export function jobName(job) {
  const m = code(job.body)
    .map(l => /^ {4}name:\s*(.+?)\s*$/.exec(l))
    .find(Boolean)
  if (!m) return job.id
  const raw = m[1]
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const q = raw[0]
    const close = raw.indexOf(q, 1)
    return close === -1 ? raw.slice(1) : raw.slice(1, close)
  }
  return raw.replace(/\s+#.*$/, '').trim()
}

/**
 * GitHub's own default when a job declares no `timeout-minutes` (six hours).
 *
 * Named rather than inlined because a consumer that treats "absent" as "no
 * budget rule applies" and one that treats it as this number reach the same
 * verdict for every rule that is a FLOOR, and different verdicts for anything
 * else. Saying which one is meant is cheaper than re-deriving it per caller.
 */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 360

/**
 * A job's declared `timeout-minutes` as a number, `undefined` when it declares
 * none, or `NaN` when it declares something that is not a number.
 *
 * Anchored at EXACTLY four spaces, the job-key column, which is what excludes a
 * STEP's own `timeout-minutes` — steps sit at six spaces or deeper, and a step
 * timeout is a different budget with a different meaning. `jobName` is anchored
 * the same way for the same reason; the two must not disagree about where a job
 * key lives.
 *
 * NaN rather than a throw for an unparseable value, and it is deliberate: every
 * consumer of this compares it against a required minimum, and NaN fails every
 * `>=` comparison there is. A timeout nobody can read therefore goes RED at the
 * consumer instead of quietly satisfying a floor — which is the whole
 * "cannot check this treated as nothing to check" failure in
 * docs/false-safety-guards.md, closed by arithmetic rather than by remembering.
 *
 * `undefined` is the case that CANNOT be made fail-closed here, because absent
 * really is legal and really does mean six hours. A consumer must therefore
 * carry a positive control proving this function still finds the timeouts that
 * are declared: if it silently stopped matching, every job would read as
 * absent, and a floor over `DEFAULT_JOB_TIMEOUT_MINUTES` passes for anything.
 */
export function jobTimeout(job) {
  const m = code(job.body)
    .map(l => /^ {4}timeout-minutes:\s*(.+?)\s*$/.exec(l))
    .find(Boolean)
  if (!m) return undefined
  return Number(m[1].replace(/\s+#.*$/, '').trim())
}

/**
 * The event names in a workflow's top-level `on:` mapping.
 *
 * Every spelling GitHub accepts, because an unrecognised one returns NOTHING and
 * silently drops the whole file out of any guard that quantifies over PR-visible
 * jobs — the cannot-check-treated-as-nothing-to-check failure in
 * docs/false-safety-guards.md, and the exact class
 * ci-required-check-partition.test.js exists to close. Reported by two
 * independent reviewers of #7643 against the first version of this function,
 * which matched only a bare unquoted `on:` in block or list form.
 *
 * The spellings, and why each is real rather than hypothetical:
 *
 *   on:                    block mapping — what all seven workflows use today
 *   on: [push, pull_request]   flow sequence
 *   on: push               single scalar
 *   "on":                   YAML 1.1 parses bare `on` as a BOOLEAN, so linters
 *   'on':                   and hand-written workflows routinely quote the key.
 *                          GitHub treats it identically; this reader must too.
 *   on: {pull_request: null}   flow mapping
 *   on: &anchor            an anchor on the key line, with the events below it
 *
 * `code()` is applied first: repo-relay.yml's `on:` block carries a long comment
 * that names `pull_request_review` while explaining why that trigger was
 * REMOVED. A guard reading prose as configuration is satisfiable by prose.
 */
export function workflowTriggers(yml) {
  const lines = code(yml.split('\n'))
  // The key may be quoted; YAML 1.1's bare `on` is a boolean, so `"on":` is a
  // normal thing to find in a real workflow.
  const at = lines.findIndex(l => /^(["']?)on\1\s*:/.test(l))
  if (at === -1) return []

  let head = /^(?:["']?)on(?:["']?)\s*:\s*(.*)$/.exec(lines[at])[1].replace(/\s+#.*$/, '').trim()
  // An anchor or alias sits between the key and its value; strip it so the
  // value (or the block below) is what gets read.
  head = head.replace(/^[&*][A-Za-z0-9_-]+\s*/, '').trim()

  // Flow sequence: [push, pull_request]
  if (head.startsWith('[')) {
    return head.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  // Flow mapping: {push: null, pull_request: {types: [opened]}} — the event is
  // the key before the first colon of each top-level entry.
  if (head.startsWith('{')) {
    const inner = head.replace(/^\{|\}$/g, '')
    const out = []
    let depth = 0
    let buf = ''
    for (const ch of inner) {
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') depth--
      if (ch === ',' && depth === 0) {
        out.push(buf)
        buf = ''
        continue
      }
      buf += ch
    }
    out.push(buf)
    return out
      .map(e => e.split(':')[0].trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  if (head) return [head.replace(/^["']|["']$/g, '')]

  const events = []
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) continue
    if (/^\S/.test(line)) break
    const m = /^ {2}["']?([A-Za-z_]+)["']?\s*:/.exec(line)
    if (m) events.push(m[1])
  }
  return events
}

/* ───────────────────────────────────────────────────────────────────────────
 * DOES A `run:` BODY REALLY INVOKE THIS?
 *
 * Everything below answers one question in two shapes:
 *
 *   invokes(body, 'scripts/__tests__/x.test.sh')   is this FILE executed?
 *   commandUses(body, 'npm')                       is this COMMAND run?
 *
 * It began as a private predicate inside `ci-scripts-tests-registration.test.js`
 * (#7637, #7645), which is the right place for one implementation with one
 * consumer. #7660 established a second rule that needs the same "invokes, as
 * opposed to mentions" judgement — an `npm ci` in a five-minute job — and this
 * module's precedent is to hoist when the second consumer arrives (`jobName`,
 * #7639). Transcribing instead would produce the second implementation the
 * header of this file exists to prevent, and this predicate in particular has
 * had SIX fail-opens found in it by measurement; a copy would inherit whichever
 * of them was current on the day it was made.
 *
 * THE TWO SHAPES DIFFER IN ONE THING, AND IT IS NOT A DETAIL. Both run the same
 * passes to decide what text is even a command — heredoc bodies blanked, shell
 * comments stripped, the line cut back to the last separator before the name.
 * They differ in what they then require of the words that remain:
 *
 *   FILE     the name is an OPERAND, so something must be running it. The
 *            segment must be `./`, or an interpreter optionally followed by the
 *            directory part of the path: `bash x.test.sh`, `./x.test.sh`,
 *            `out=$(bash x.test.sh)`.
 *   COMMAND  the name IS the command word, so nothing may precede it. The
 *            segment must be EMPTY: `npm ci`, `a && npm ci`, `out=$(npm ci)`.
 *
 * WHY ONLY THE COMMAND SHAPE MASKS QUOTED TEXT. The file shape reads through
 * quotes and must: `bash "x.test.sh"` really does run the file, and quoting an
 * operand changes nothing. It can afford to, because its accepting condition is
 * a segment HEADED BY AN INTERPRETER, and no amount of quoted prose produces
 * one — `echo "... && bash x.test.sh"` cuts at the quoted `&&` to an EMPTY
 * segment, which that shape rejects.
 *
 * The command shape accepts exactly that empty segment, so the same quoted
 * separator hands it a false invocation. It is not hypothetical: ci.yml's
 * `server-lint` job carries
 *
 *     echo "::error::… Run 'cd packages/server && npm install --package-lock-only' …"
 *
 * and a first pass at the #7660 measurement counted that line as a third npm
 * resolve. A guard that reads prose as configuration is satisfiable by prose —
 * this file's oldest rule, and the way to hold it here is to mask what the
 * shell would treat as DATA before looking for a command at all.
 *
 * THE THIRD BUCKET IS THE POINT. `commandUses` classifies every occurrence as
 * an `invocation`, `quoted` data, or `unclassified` — a name that survives
 * masking but has something in front of it (`sudo npm ci`, `then npm ci`,
 * `xargs npm ci`). Nothing here tries to decide whether such a prefix runs its
 * operand, because that is predicting a shell (#7341), and guessing WRONG in
 * the lenient direction is undercounting: the failure the budget rule exists to
 * catch, arriving silently. A caller asserts the bucket is EMPTY over its
 * corpus instead, so a spelling nobody anticipated goes red and gets classified
 * by a person. Measured across all seven workflow files: 57 invocations, 6
 * quoted mentions, 0 unclassified.
 *
 * READING THE ARGUMENTS NEEDS A THIRD ANSWER, AND THE MASK CANNOT GIVE IT.
 * Deciding whether npm is a COMMAND needs to know which text is code; deciding
 * what SUBCOMMAND it runs needs to know what the quoted text says. The mask
 * answers the first and destroys the second — a quoted span comes back as
 * spaces, so `npm 'run' build` read as `['build']` and a script run counted as
 * a registry resolve (#7663). Reading the raw line instead only trades the
 * error for the opposite one: a quoted `&&` truncates the argument list.
 *
 * So `scanQuoting` reports a per-character ROLE — code, literal data, quoting
 * punctuation the shell removes, or the close of a substitution — and
 * `commandWords` splits on that, which is what the shell itself does. Quotes
 * stop breaking words (`'a'b` is `ab`), separators inside them stop ending
 * commands, and a quoted subcommand is read rather than inferred from whatever
 * survived masking. Both readings were half-right; the roles are the whole
 * question, and one scan answers it so no two consumers can disagree.
 *
 * WHAT ONE LINE CANNOT CONTAIN IS REPORTED, NOT GUESSED. A `\` continuation, an
 * unclosed quote, or an argument a substitution produces at run time all leave
 * the list a PREFIX of the real one, and `argsComplete` says so. A word the
 * shell has not closed is dropped rather than reported short, because a prefix
 * offered as a word is the same defect one layer down: `npm 'ru` answering `ru`
 * would be classified against a list of real subcommands.
 * ─────────────────────────────────────────────────────────────────────────── */

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
export function namePositions(text, name) {
  const re = new RegExp(`(?<![A-Za-z0-9_.\\-])${esc(name)}(?![A-Za-z0-9_.\\-])`, 'g')
  return [...text.matchAll(re)].map(m => m.index)
}

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'npx', 'npm'])

/**
 * The `$'…'` escapes that stand for THEMSELVES, and so can be read literally.
 *
 * Every other ANSI-C escape denotes a character this reader does not decode —
 * see the `opaque` role. These three are the ones the workflows actually spell.
 */
const ANSI_LITERAL_ESCAPES = `\\'"`

/**
 * The stand-in for a character whose value this reader cannot determine.
 *
 * It is deliberately not a word character: a subcommand carrying it can never
 * equal a real npm subcommand, so a word this reader could not fully read is
 * always UNRECOGNISED and always classified in whichever direction its caller
 * treats as loud. That is the property to preserve if this is ever changed —
 * substituting a plausible letter instead would let `$'ru\n'` read as `run`.
 */
const OPAQUE_CHAR = '\uFFFD'

/** Shell command separators: everything after the last one begins a new command. */
const SEPARATOR_CHARS = ';&|(`{'

/**
 * Every index in `text` holding an UNESCAPED separator.
 *
 * The escape awareness is #7662's fix for a fail-open that shipped in the
 * original: this was a `/[;&|(`{]/g` regex, and a BACKSLASH-ESCAPED separator
 * is literal text the shell passes to the command in front of it, not a new
 * command. So `echo \`bash x.test.sh\`` — where bash prints the words and runs
 * nothing, verified with `bash -x` — cut at the escaped backtick, left `bash `
 * as the segment, and `invokes()` reported the suite WIRED. Every separator
 * has this spelling — `\;`, `\|`, `\&`, `\(`, `\{`, `` \` `` — and that is the
 * registration guard's dangerous direction: an orphaned suite reading as wired. None of them is in
 * the workflows today, so this was latent rather than an active miss.
 *
 * ONE implementation, scanned rather than matched, because the two callers want
 * opposite ends of the same list — the LAST separator before a position, and
 * the FIRST after one — and a regex plus a hand-rolled scan would be the second
 * copy this module exists to prevent.
 */
function separatorIndexes(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (SEPARATOR_CHARS.includes(text[i])) out.push(i)
  }
  return out
}

/**
 * Is the name at `at` in a COMMAND position on this line — i.e. does the text
 * immediately before it invoke it?
 *
 * The prefix is cut back to the last shell separator, quotes are dropped, and
 * what remains must be one of:
 *
 *   `./`                     — `./x.test.sh`
 *   <interpreter> [path-prefix]
 *                            — `bash x.test.sh`, `bash scripts/__tests__/x.test.sh`,
 *                              `bash ./x.test.sh`, `out=$(bash x.test.sh)`
 *
 * NO FLAGS, and that is the #7645 fix rather than an omission. The previous
 * rule accepted ANY `-`-prefixed word unconditionally, so a flag that stops the
 * interpreter executing the file still read as an invocation. Measured against
 * the shipped predicate:
 *
 *   WIRED  | bash -n <suite>            | parse-only, runs NOTHING
 *   WIRED  | sh -n <suite>              | parse-only
 *   WIRED  | bash --norc -n <suite>     | parse-only, behind a harmless flag
 *   WIRED  | node --check <suite>       | compiles, runs NOTHING
 *   WIRED  | node --help <suite>        | argument ignored entirely
 *
 * `bash -n` is not hypothetical: it is this repo's own parse-check idiom,
 * run over every tracked shell script by `scripts/parse-check-shell.sh` —
 * invoked from the step IMMEDIATELY ABOVE these suite invocations in the same
 * `scripts-tests` job. (It sat inline in that step until #7646 moved it into a
 * script a test could run; the distance changed, the adjacency did not.)
 * Downgrading a flaky suite to "just syntax-check it for now" is a copy of the
 * idiom one step up, and the release-critical updater-feed suite would then run
 * in no step with this guard reporting it wired — #7504 exactly, through the
 * guard written to prevent it.
 *
 * #7637 fixed three fail-opens in this function and every one was about the
 * COMMAND WORD (`chmod +x ./x`, `cp ./x /tmp/`, `node --version && echo`). The
 * flag axis was never considered. It is the #7281 shape as well: `bash <path>`
 * is validated as a shell command word and `-n` is re-parsed by bash under a
 * different grammar, as "do not execute".
 *
 * An ALLOWLIST rather than a denylist of no-exec flags, and an empty one:
 * predicting a shell is unwinnable (#7341, entry 15 in the catalogue — six
 * bypasses in two rounds), and `-n`, `--check`, `-e`, `-p`, `-c` and `--help`
 * are only the ones anyone thought of. All 15 wired invocations in this repo
 * spell zero flags — measured, `bash <path>` or `node <path>`, one line each —
 * so an allowlist costs nothing today and a future `node --test <path>` is
 * reported as an ORPHAN: a false positive, loud, and fixed by adding the flag
 * here with the reason it preserves execution. Under-inclusive about WIRED is
 * the direction this whole file is built toward.
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
 * would run it: nothing in this repo spells an invocation that way. That costs
 * a false positive on a shape nobody writes, which is the safe direction.
 *
 * This paragraph used to credit the bare-name rejection with covering heredoc
 * bodies too. It never did — it covers the BARE-NAME spelling, and a body line
 * spelled `bash <suite>` read as an invocation (measured, #7645). Heredoc
 * bodies are blanked by `withoutHeredocBodies` now, and this sentence claims
 * only what this rule performs. The #7290/#7291 shape, found in the same
 * function that had it three times before.
 */
export function isCommandPosition(line, at) {
  // `segmentBefore` is shared with `commandUses`; see its own note on why the
  // cut is not written twice.
  const seg = segmentBefore(line, at).replace(/["']/g, '').trim()
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
  // After the interpreter: NOTHING, or a single trailing path prefix — the
  // directory part of the argument when the match was on the basename. No
  // flags; see the header for why the allowlist is empty rather than a
  // denylist of the no-exec ones.
  const rest = words.slice(1)
  return rest.length === 0 || (rest.length === 1 && rest[0].endsWith('/'))
}

/**
 * Shell here-document starts. The captured word is the raw delimiter.
 *
 * THE DELIMITER IS A SHELL WORD, not an identifier. The first version of this
 * matched `'...'`, `"..."` or `[A-Za-z_][A-Za-z0-9_]*` — and the shell accepts
 * far more, so two ordinary spellings opened a heredoc that this did not see:
 *
 *   cat <<\EOF     the standard backslash-quoted literal heredoc, exactly
 *                  equivalent to <<'EOF'
 *   cat <<1EOF     a digit-leading delimiter
 *
 * Measured against the shipped predicate, and against real bash: both bodies
 * were handed back as LIVE COMMANDS, so `bash <suite>` inside one read as an
 * invocation while the shell ran nothing. A total fail-open of the protection
 * this function exists to provide.
 *
 * The polarity is the thing to hold on to, because it INVERTS between the two
 * ends of a heredoc. At the TERMINATOR, matching too eagerly ends the body
 * early and hands data lines back as commands — dangerous — so that match is
 * strict. At the START, matching too NARROWLY fails to open the body at all,
 * which is the same danger by the opposite route. Strictness is not a direction;
 * it is a direction *per end*, and the first version of this applied the
 * terminator's argument to the start.
 *
 * So the delimiter is now "everything up to whitespace or a shell
 * metacharacter", normalised by `heredocDelimiter` below. That over-matches:
 * `$(( 1 << 2 ))` opens a body terminated by `2`, which never arrives, so the
 * rest of the block is blanked. Over-blanking reports a wired suite as an
 * ORPHAN — loud, and the safe direction.
 *
 * `<<<` is a here-STRING and takes no body. It is excluded TWICE over, and only
 * once deliberately: the `(?<!<)` lookbehind stops the engine retrying one
 * character along and reading the trailing `<` as a `<<` start, and `<` is also
 * in the delimiter's excluded set. A `(?!<)` lookahead stood here too, with a
 * comment calling both "load-bearing". It was INERT — a differential search over
 * 204,204 strings found zero inputs where dropping it changed the result, and
 * six where dropping the lookbehind did. It is removed rather than kept with a
 * note, because the excluded set makes it redundant a second time; the proof is
 * recorded here so the next person does not add it back.
 */
const HEREDOC_START = /(?<!<)<<-?\s*([^\s;&|<>()`]+)/

/**
 * The terminator a heredoc delimiter denotes: quoting removed, since quoting
 * only tells the shell whether to expand the BODY.
 */
export const heredocDelimiter = word => word.replace(/['"\\]/g, '')

/**
 * The lines of a run body with here-document BODIES blanked out (#7645).
 *
 * A heredoc body is DATA the shell hands to a command, not commands the shell
 * runs, so
 *
 *     cat <<EOF
 *     bash scripts/__tests__/merge-updater-feeds.test.sh
 *     EOF
 *
 * documents an invocation without performing one — and read as WIRED until
 * this existed. The file's own header claimed the bare-name rejection covered
 * heredocs; it covers only the bare-name spelling, and `bash <suite>` inside a
 * body was an invocation. Measured before the fix.
 *
 * A body that is WRITTEN TO A FILE and later executed really does run the
 * suite, so blanking it can report a wired suite as an orphan. That is the
 * declared safe direction, and no workflow does it today.
 *
 * The terminator must appear ALONE on its line — leading tabs allowed only for
 * `<<-`, which is what the shell strips. Deliberately strict: a lenient match
 * ends the body EARLY and hands the remaining data lines back as commands,
 * which is the dangerous direction. An unterminated heredoc therefore blanks
 * the rest of the body, which is loud and safe. That also covers the shape this
 * repo really has — `echo "body<<EOF" >> $GITHUB_OUTPUT`, a GitHub Actions
 * multiline-output delimiter rather than a shell heredoc, whose terminator line
 * is `echo "EOF" >> $GITHUB_OUTPUT` and never matches. Blanking from there on
 * costs nothing measurable: no suite is invoked after one.
 */
export function withoutHeredocBodies(lines) {
  const out = []
  let terminator = null
  let stripTabs = false
  for (const line of lines) {
    if (terminator !== null) {
      const candidate = stripTabs ? line.replace(/^\t+/, '') : line
      if (candidate === terminator) terminator = null
      out.push('')
      continue
    }
    out.push(line)
    const m = HEREDOC_START.exec(line)
    if (m) {
      terminator = heredocDelimiter(m[1])
      stripTabs = /<<-/.test(line)
    }
  }
  return out
}

/**
 * One line of a run body with its shell comment removed.
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
 * A `#` INSIDE QUOTES is not a comment, and this used to truncate there anyway
 * (#7661). That was defensible while the only consumer was the registration
 * guard — discarding text can only report a wired suite as an ORPHAN, which is
 * loud — but it is not defensible for a consumer that COUNTS: repo-relay.yml
 * carries
 *
 *     echo "::warning::… does not fail the job — see #7632."
 *
 * and the old stripper cut that line at ` #7632`, leaving an unterminated quote
 * and silently dropping whatever followed. For a rule that counts npm resolves
 * per job, dropping text is UNDERCOUNTING — the exact failure the rule exists
 * to catch, arriving quietly.
 *
 * So the `#` must be at a position the shell would read as code, which is
 * `maskQuotedData`'s answer and not a second opinion about what a quote is.
 * The change only ever KEEPS text that was discarded before, and keeping text
 * cannot manufacture an invocation on its own: both shapes above still have to
 * clear the command-position anchoring, and quoted prose does not.
 *
 * TWO LINES ARE READ HERE, AND WHICH ONE ANSWERS WHICH QUESTION IS THE WHOLE
 * CARE. The MASKED line says whether the `#` is code or data. The ORIGINAL line
 * says whether it begins a word, which is what makes it a comment: bash starts
 * one at a `#` that follows unquoted WHITESPACE or the start of the line, and
 * `a#b` is a single word in which the `#` is literal.
 *
 * Asking the masked line both questions is wrong, and the first version of this
 * did (#7662 review, found by Copilot). Masking replaces a quoted span with
 * SPACES, so it manufactures whitespace where the original had none: in
 * `echo "x"#y && npm ci` the `#` follows a `"`, bash runs `echo x#y` and then
 * runs the `npm ci` — verified — while the masked line shows a space before the
 * `#` and the whole tail was cut. Dropping text is the UNDERCOUNT direction for
 * anything that counts invocations, and it is silent.
 */
export const stripShellComment = line => {
  const masked = maskQuotedData(line)
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '#') continue
    if (i === 0) return ''
    // The single preceding whitespace character goes with the comment, which is
    // what the `/(^|\s)#.*$/` this replaces did.
    if (/\s/.test(line[i - 1])) return line.slice(0, i - 1)
  }
  return line
}

/**
 * Does any line of this `run:` body actually INVOKE the named file, as opposed
 * to merely mentioning it?
 *
 * `stepRun()` already keeps a step's `name:`, `if:` and `with:` out of reach.
 * This closes the rest: a comment inside a block scalar, and a mention inside a
 * live command.
 *
 * Requiring a real command position costs nothing today — every wired suite is
 * invoked as `bash <path>` or `node <path>`, measured, one line each. No count
 * is written here: a number beside a growing set is the first cause in
 * docs/false-safety-guards.md, and this line carried a stale 15 through the PR
 * that made it 16. A
 * future shape without one (`npm run x`, a variable holding the path, `for f in
 * ...; do bash "$f"; done`) is reported as an orphan: a false POSITIVE, loud,
 * and fixable by whoever writes it. Under-inclusive is the direction that waves
 * a real orphan through.
 */
export function invokes(runBody, name) {
  // ORDER MATTERS, and the first version had it backwards. Heredoc tracking is
  // stateful and line-ordered; comment stripping rewrites lines. Running the
  // stripper FIRST let it manufacture a terminator the shell never sees:
  //
  //     cat <<EOF
  //     EOF # not really the terminator
  //     bash <suite>
  //     EOF
  //
  // The shell terminates only on a line that is exactly `EOF`, so the whole
  // thing is data and nothing runs. Stripping first turns line 2 into `EOF`,
  // closes the body there, and hands `bash <suite>` back as a live command —
  // measured WIRED. Blanking the bodies first means the stripper only ever sees
  // lines the shell would have executed.
  //
  // The reverse order costs nothing: a heredoc START hidden inside a comment
  // (`echo x  # cat <<EOF`) now opens a body that never terminates and blanks
  // the rest, which is over-blanking — loud, and the safe direction.
  return withoutHeredocBodies(runBody.split('\n'))
    .map(stripShellComment)
    .some(line => namePositions(line, name).some(at => isCommandPosition(line, at)))
}

/** Is the name present at all — invoked or merely mentioned? Diagnostics only. */
export const mentions = (runBody, name) => namePositions(runBody, name).length > 0

/**
 * A shell line with everything the shell would treat as QUOTED DATA replaced by
 * spaces, one space per character, so positions in the result still line up
 * with positions in the input.
 *
 * Only `commandUses` reads this; the header above says why the file shape must
 * not. What it models, and nothing more:
 *
 *   '…'        literal: masked whole, quotes included, no escapes inside
 *   "…"        masked, EXCEPT `$(…)` and `` `…` `` inside it, which are code
 *              the shell runs and are left visible — `out="$(npm ci)"` is a
 *              real invocation, and masking it would UNDERCOUNT, the one
 *              direction a budget rule must not fail in
 *   \x         outside quotes, a literal character; skipped, not masked
 *
 * The `$(` and `` ` `` themselves stay visible, which matters: `(` and `` ` ``
 * are separators, and they are what cuts `out="$(npm ci)"` back to an empty
 * segment.
 *
 * IT IS PER LINE, and a quote that opens on one line and closes on another is
 * not modelled — the second line would read as code. `hasUnclosedQuoting`
 * exists so a caller can assert its corpus contains no such line rather than
 * assume it; every unbalanced-quote line in this repo's workflows today is a
 * COMMENT, and comments are stripped before this runs.
 */
export function maskQuotedData(line) {
  return scanQuoting(line).masked
}

/**
 * Does this line end with a QUOTE still open?
 *
 * The precondition of `maskQuotedData`'s per-line model, exposed so a consumer
 * can prove it over its own corpus. "This model does not apply here" and "this
 * line is clean" are otherwise the same observable outcome, which is the
 * failure `docs/false-safety-guards.md` catalogues.
 */
export function hasUnclosedQuoting(line) {
  return scanQuoting(line).openQuote
}

/**
 * One pass, several answers, so no two consumers can disagree about what a
 * quote is.
 *
 * A stack rather than a flag: `"$(echo 'x')"` nests double → substitution →
 * single, and each level has to return to the right one. A backtick both opens
 * and closes, so it is popped when it is already the innermost context.
 *
 * `roles` is the per-character answer to "what is this character FOR", and it
 * is what `commandWords` needs and the mask cannot give it. Masking is lossy on
 * purpose — a quoted span and an absent one are both spaces — so a consumer
 * that has to READ a quoted word has to be told which spaces stood for text:
 *
 *   code    shell code: whitespace separates words, a separator ends the command
 *   data    literal text: part of the current word, and never a separator
 *   syntax  quoting punctuation the shell REMOVES: dropped, but it STARTS a word,
 *           so `''` is an empty argument and `'a'b` is the single word `ab`
 *   opaque  a character whose decoded value this reader does not model — an
 *           ANSI-C escape. It stands for SOMETHING, so the word it sits in keeps
 *           its position, but the value is unknown; see `commandWords`
 *   end     closes a substitution the command sits inside, so the command ends
 *
 * `continued` reports a trailing unescaped backslash, which is the shell's line
 * continuation: the command is not finished on this line, and any consumer
 * reading a single line has an incomplete picture of it.
 */
function scanQuoting(line) {
  // `split('')` and NOT `[...line]`: the spread iterates CODE POINTS, while this
  // loop — and `roles`, and every index a caller carries in from
  // `namePositions` — is in UTF-16 CODE UNITS. One astral character (an emoji)
  // makes `out` one element shorter than `line`, and from that character on the
  // mask is offset by one against the line it is supposed to align with.
  // `echo "🚀" && npm ci` then masked its `&&` and reported the real `npm ci`
  // as QUOTED — a resolve that vanishes, which is the silent direction
  // (Copilot, #7665 review; no workflow spells one today, so it was latent).
  const out = line.split('')
  const roles = new Array(line.length).fill('code')
  const stack = ['code']
  let escaped = -1
  let continued = false
  /** A backslash that acts as an escape: syntax here, literal text next. */
  const escapes = i => {
    roles[i] = 'syntax'
    if (i + 1 < line.length) roles[i + 1] = 'data'
    else continued = true
  }
  for (let i = 0; i < line.length; i++) {
    const ctx = stack[stack.length - 1]
    const c = line[i]

    if (ctx === 'single') {
      out[i] = ' '
      // No escapes inside `'…'`, so a trailing backslash there is literal text
      // and continues nothing — the unclosed quote is what carries to the next
      // line, and `openQuote` already reports that.
      if (c === "'") {
        roles[i] = 'syntax'
        stack.pop()
      } else {
        roles[i] = 'data'
      }
      continue
    }

    // `$'…'` is ANSI-C quoting, and it is the ONE single-quoted form that
    // honours backslash escapes — `$'it\'s'` is one string, where the plain
    // `'it\'s'` is a bash syntax error. Without this the embedded `\'` closed
    // the string, the next `'` opened a new one, and everything after it on the
    // line was masked as data: `echo $'it\'s' && npm ci` reported the `npm ci`
    // as QUOTED. That is the undercount direction — a resolve that vanishes
    // (#7662 review, verified against real bash).
    if (ctx === 'ansi') {
      out[i] = ' '
      if (c === '\\') {
        escapes(i)
        if (i + 1 < line.length) {
          out[i + 1] = ' '
          // `$'…'` DECODES its escapes: `$'\t'` is a tab byte, `$'ru\n'` is `ru`
          // and a newline. This reader does not implement that grammar — doing so
          // means reimplementing octal, hex, `\cX` and `\uXXXX`, which is
          // predicting a shell. So the decoded character is marked OPAQUE
          // instead. Only the three escapes that stand for themselves are read
          // literally; `$'it\'s'` is the shape the workflows actually contain.
          roles[i + 1] = ANSI_LITERAL_ESCAPES.includes(line[i + 1]) ? 'data' : 'opaque'
        }
        i++
        continue
      }
      if (c === "'") {
        roles[i] = 'syntax'
        stack.pop()
      } else {
        roles[i] = 'data'
      }
      continue
    }

    if (ctx === 'double') {
      if (c === '\\') {
        out[i] = ' '
        escapes(i)
        if (i + 1 < line.length) out[i + 1] = ' '
        i++
        continue
      }
      if (c === '"') {
        out[i] = ' '
        roles[i] = 'syntax'
        stack.pop()
        continue
      }
      // Command substitution inside double quotes is CODE. Left visible, and
      // its role stays `code` for the same reason.
      if (c === '$' && line[i + 1] === '(') {
        stack.push('subst')
        i++
        continue
      }
      if (c === '`') {
        stack.push('backtick')
        continue
      }
      out[i] = ' '
      roles[i] = 'data'
      continue
    }

    // `code`, `subst` and `backtick` are all contexts whose text is shell code.
    if (c === '\\') {
      // The escaped character is literal, and remembering WHICH one is what
      // keeps `\$'…'` — a literal dollar followed by an ordinary single-quoted
      // string — from being read as ANSI-C quoting below.
      escaped = i + 1
      escapes(i)
      i++
      continue
    }
    if (c === "'") {
      out[i] = ' '
      roles[i] = 'syntax'
      const ansi = line[i - 1] === '$' && i - 1 !== escaped
      // The `$` of `$'…'` is part of the quoting, not part of the word: the
      // shell hands `$'run'` to the command as `run`. It stays VISIBLE in the
      // mask, where it always was and where nothing reads it as a separator.
      if (ansi) roles[i - 1] = 'syntax'
      stack.push(ansi ? 'ansi' : 'single')
      continue
    }
    if (c === '"') {
      out[i] = ' '
      roles[i] = 'syntax'
      stack.push('double')
      continue
    }
    if (c === '$' && line[i + 1] === '(') {
      stack.push('subst')
      i++
      continue
    }
    if (c === '`') {
      if (ctx === 'backtick') {
        roles[i] = 'end'
        stack.pop()
      } else {
        stack.push('backtick')
      }
      continue
    }
    if (c === ')' && ctx === 'subst') {
      roles[i] = 'end'
      stack.pop()
    }
  }
  // A QUOTE left open is what invalidates the per-line model. A command
  // substitution left open does not: its continuation lines really are shell
  // code, which is how this reads them, and three lines in this repo's
  // workflows spell exactly that (`version=$(printf … \`).
  return {
    masked: out.join(''),
    openQuote: ['single', 'double', 'ansi'].some(q => stack.includes(q)),
    roles,
    continued,
  }
}

/**
 * The line cut back to the last separator before `at` — everything the shell
 * would read as part of the SAME command as the name at that position.
 *
 * Extracted from `isCommandPosition` when `commandUses` needed the same cut.
 * Two copies of it inside one module is the drift this file's header is about,
 * and the cut is exactly where a quoted `&&` does its damage.
 */
function segmentBefore(line, at) {
  const before = line.slice(0, at)
  const seps = separatorIndexes(before)
  return before.slice(seps.length ? seps[seps.length - 1] + 1 : 0)
}

/**
 * The words after `from` that belong to the same command, as the SHELL would
 * split them — quotes honoured and then removed, up to the next separator.
 *
 * THIS USED TO READ THE MASKED LINE, and #7663 is why it no longer does.
 * Masking is lossy by design: a quoted span becomes spaces, so `npm 'run'
 * build` came back as `['build']` and was indistinguishable from `npm build`.
 * The subcommand then read as `build`, and a script run that contacts no
 * registry counted as an npm resolve. Reading the RAW line instead is not the
 * fix either — that is what lets a quoted separator truncate the list, which is
 * the mistake masking was introduced to prevent. Both readings are wrong
 * because each answers only half the question, and `roles` answers all of it:
 * which characters the shell treats as code, which as literal text, and which
 * it removes.
 *
 * Word boundaries come from the code role only, so a quote never breaks a word
 * (`'a'b` is `ab`) and a separator inside one never ends the command
 * (`npm run 'a && b'` is one invocation with two arguments).
 *
 * `complete` is false when the words are a PREFIX of the real argument list
 * rather than all of it — a line continuation, an unclosed quote, or a
 * substitution whose output is the argument. The words themselves are still
 * accurate; what is unknown is whether more follow. A caller that finds what it
 * needs may use it, and one that does not must fail in ITS safe direction —
 * `commandUses` passes the flag straight through rather than deciding here.
 *
 * `scan` lets a caller that has already scanned the line hand the result over
 * rather than paying for a second pass — the same object, so the two readings
 * cannot come from different scans.
 */
function commandWords(line, from, scan = scanQuoting(line)) {
  const { roles, openQuote, continued } = scan
  const words = []
  let word = null
  let complete = !openQuote && !continued
  let ended = false // the shell finished this command ON THIS LINE
  const push = c => {
    word = (word ?? '') + c
  }
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (roles[i] === 'syntax') {
      // Removed by the shell, and it joins the word on either side — but it
      // also STARTS one. `npm '' run` passes npm an empty first argument and
      // `run` as its second; treating `''` as nothing would shift `run` into
      // the subcommand slot and report a script run that the shell never
      // performs. Verified against bash.
      word = word ?? ''
      continue
    }
    if (roles[i] === 'opaque') {
      push(OPAQUE_CHAR) // present, position known, value not modelled
      continue
    }
    if (roles[i] === 'end') {
      ended = true // the substitution this command sits in closed
      break
    }
    if (roles[i] === 'data') {
      push(c)
      continue
    }
    if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
      continue
    }
    if (SEPARATOR_CHARS.includes(c)) {
      // `(` and a backtick in a command's ARGUMENT position open a
      // substitution, so the argument is computed at run time and no static
      // read of it exists. Every other separator genuinely ends the command.
      if (c === '(' || c === '`') complete = false
      ended = true
      break
    }
    push(c)
  }
  // A word still being ACCUMULATED when the line ran out is a fragment, and
  // reporting it would be the #7663 mistake one layer down: `npm 'ru` would
  // answer `ru`, a word the shell never forms, and a caller comparing that
  // against a list of known subcommands would be classifying a prefix. A word
  // is reported only once the shell has closed it — at whitespace, at the
  // separator that ended the command, or at the end of a line that finishes it.
  if (word !== null && (ended || complete)) words.push(word)
  return { words, complete }
}

/**
 * Every place `name` appears in a `run:` body, classified — see the section
 * header for the three buckets and why the third one exists.
 *
 * `args` is populated for an `invocation` only; it is the words that follow the
 * command word up to the next separator, quoted exactly as the shell would hand
 * them over, which is what lets a caller ask about a SUBCOMMAND (`npm ci`
 * resolves the dependency tree, `npm run build` does not) without a second
 * parser.
 *
 * `argsComplete` says whether `args` is the WHOLE argument list. It is false
 * for a line continuation, an unclosed quote, or an argument produced by a
 * substitution — cases where this line does not contain the rest of the
 * command. An empty `args` with `argsComplete: true` is a bare `npm`; an empty
 * one with `argsComplete: false` is `npm \` with the subcommand on the next
 * line, and telling those apart is the whole of #7663. Nothing here guesses
 * what the missing words are; the caller decides which way to fail.
 *
 * The other two buckets report `argsComplete: false` because nothing tried to
 * read their arguments — a mention inside a string and a name behind `sudo` are
 * not commands this function has parsed. `false` is the answer that makes a
 * caller who reads the flag without reading this paragraph fail LOUDLY.
 *
 * The passes run in the same order as `invokes()`, and for the same reason
 * recorded there: blanking heredoc bodies BEFORE stripping comments, so the
 * stripper cannot manufacture a terminator the shell never sees.
 *
 * @param {string} runBody A step's `run:` script, as `stepRun()` returns it.
 * @param {string} name The command word to look for.
 * @returns {Array<{kind: 'invocation'|'quoted'|'unclassified', line: string, args: string[], argsComplete: boolean}>}
 */
export function commandUses(runBody, name) {
  const uses = []
  for (const line of withoutHeredocBodies(runBody.split('\n')).map(stripShellComment)) {
    // One scan per line, shared by both questions: which text is code (the
    // mask) and what the quoted text says (the roles).
    const scan = scanQuoting(line)
    const masked = scan.masked
    for (const at of namePositions(line, name)) {
      if (masked.slice(at, at + name.length) !== name) {
        uses.push({ kind: 'quoted', line, args: [], argsComplete: false })
      } else if (segmentBefore(masked, at).trim() !== '') {
        uses.push({ kind: 'unclassified', line, args: [], argsComplete: false })
      } else {
        const { words, complete } = commandWords(line, at + name.length, scan)
        uses.push({ kind: 'invocation', line, args: words, argsComplete: complete })
      }
    }
  }
  return uses
}
