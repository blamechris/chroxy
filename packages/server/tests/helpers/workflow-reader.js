/**
 * A small indentation-aware reader for `.github/workflows/*.yml`, shared by the
 * CI guards in `packages/server/tests/ci-*.test.js`, plus `ci-workflow-reader`
 * (this module's own tests). The consumers are deliberately NOT listed here: a
 * roster in a comment beside a growing set is the first cause in
 * docs/false-safety-guards.md, and this one was already three names short of
 * the truth when #7661 came to add a fourth. `grep -l workflow-reader` answers
 * it correctly and always.
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
  const jobsAt = lines.findIndex(l => l === 'jobs:')
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
  const stepsAt = bodyLines.findIndex(l => /^\s*steps:\s*$/.test(l))
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
  if (/^[|>][-+]?\d*\s*(?:#.*)?$/.test(value)) return 'block'
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
  const stepsAt = jobBody.findIndex(l => /^\s*steps:\s*$/.test(l))
  const lines = code(jobBody.slice(0, stepsAt === -1 ? jobBody.length : stepsAt))

  // Anchored to `defaults:` → `run:` → `shell:`, not "any shell: before steps:".
  // The unanchored version read a `strategy.matrix.shell` axis, or an
  // `env.shell`, as the job's effective shell. That is the dangerous direction:
  // the run-block guard only feeds bash/sh shells to `bash -n`, so one false
  // "powershell" here silently drops every real bash block in that job out of
  // the check — "a guard wired to only some of its callers", and the mirror
  // image of the bug it was written for.
  const defaultsAt = lines.findIndex(l => /^\s*defaults:\s*$/.test(l))
  if (defaultsAt === -1) return undefined
  const defaultsIndent = /^(\s*)/.exec(lines[defaultsAt])[1].length

  let runIndent = null
  for (let i = defaultsAt + 1; i < lines.length; i++) {
    const indent = /^(\s*)/.exec(lines[i])[1].length
    if (indent <= defaultsIndent) break
    if (runIndent === null) {
      if (/^\s*run:\s*$/.test(lines[i])) runIndent = indent
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

    const block = /^([|>])([-+]?\d*)$/.exec(head)
    if (block) {
      const body = []
      for (let j = i + 1; j < stepLines.length; j++) {
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
      const dedented = body.map(l => l.slice(dedent))
      return block[1] === '>' ? fold(dedented) : dedented.join('\n')
    }

    if (head.startsWith("'") || head.startsWith('"')) {
      const q = head[0]
      const close = head.indexOf(q, 1)
      return close === -1 ? head.slice(1) : head.slice(1, close)
    }

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
 */
export const stripShellComment = line => {
  const m = /(^|\s)#/.exec(maskQuotedData(line))
  return m === null ? line : line.slice(0, m.index)
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
 * One pass, two answers, so the mask and the precondition cannot disagree about
 * what a quote is.
 *
 * A stack rather than a flag: `"$(echo 'x')"` nests double → substitution →
 * single, and each level has to return to the right one. A backtick both opens
 * and closes, so it is popped when it is already the innermost context.
 */
function scanQuoting(line) {
  const out = [...line]
  const stack = ['code']
  for (let i = 0; i < line.length; i++) {
    const ctx = stack[stack.length - 1]
    const c = line[i]

    if (ctx === 'single') {
      out[i] = ' '
      if (c === "'") stack.pop()
      continue
    }

    if (ctx === 'double') {
      if (c === '\\') {
        out[i] = ' '
        if (i + 1 < line.length) out[i + 1] = ' '
        i++
        continue
      }
      if (c === '"') {
        out[i] = ' '
        stack.pop()
        continue
      }
      // Command substitution inside double quotes is CODE. Left visible.
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
      continue
    }

    // `code`, `subst` and `backtick` are all contexts whose text is shell code.
    if (c === '\\') {
      i++
      continue
    }
    if (c === "'") {
      out[i] = ' '
      stack.push('single')
      continue
    }
    if (c === '"') {
      out[i] = ' '
      stack.push('double')
      continue
    }
    if (c === '$' && line[i + 1] === '(') {
      stack.push('subst')
      i++
      continue
    }
    if (c === '`') {
      if (ctx === 'backtick') stack.pop()
      else stack.push('backtick')
      continue
    }
    if (c === ')' && ctx === 'subst') stack.pop()
  }
  // A QUOTE left open is what invalidates the per-line model. A command
  // substitution left open does not: its continuation lines really are shell
  // code, which is how this reads them, and three lines in this repo's
  // workflows spell exactly that (`version=$(printf … \`).
  return { masked: out.join(''), openQuote: stack.includes('single') || stack.includes('double') }
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
  SEPARATORS.lastIndex = 0
  let cut = 0
  for (const m of before.matchAll(SEPARATORS)) cut = m.index + 1
  return before.slice(cut)
}

/**
 * The words after `from` that belong to the same command, up to the next
 * separator.
 *
 * Read off the MASKED line, so a quoted argument comes back as nothing rather
 * than as text that might contain a separator. A caller that cannot read the
 * argument it needs must fail in ITS safe direction; this returns what is
 * legible and does not guess.
 */
function argWords(masked, from) {
  let after = masked.slice(from)
  SEPARATORS.lastIndex = 0
  const cut = [...after.matchAll(SEPARATORS)].map(m => m.index)[0]
  if (cut !== undefined) after = after.slice(0, cut)
  return after.trim().split(/\s+/).filter(Boolean)
}

/**
 * Every place `name` appears in a `run:` body, classified — see the section
 * header for the three buckets and why the third one exists.
 *
 * `args` is populated for an `invocation` only; it is the words that follow the
 * command word up to the next separator, which is what lets a caller ask about
 * a SUBCOMMAND (`npm ci` resolves the dependency tree, `npm run build` does
 * not) without a second parser.
 *
 * The passes run in the same order as `invokes()`, and for the same reason
 * recorded there: blanking heredoc bodies BEFORE stripping comments, so the
 * stripper cannot manufacture a terminator the shell never sees.
 *
 * @param {string} runBody A step's `run:` script, as `stepRun()` returns it.
 * @param {string} name The command word to look for.
 * @returns {Array<{kind: 'invocation'|'quoted'|'unclassified', line: string, args: string[]}>}
 */
export function commandUses(runBody, name) {
  const uses = []
  for (const line of withoutHeredocBodies(runBody.split('\n')).map(stripShellComment)) {
    const masked = maskQuotedData(line)
    for (const at of namePositions(line, name)) {
      if (masked.slice(at, at + name.length) !== name) {
        uses.push({ kind: 'quoted', line, args: [] })
      } else if (segmentBefore(masked, at).trim() !== '') {
        uses.push({ kind: 'unclassified', line, args: [] })
      } else {
        uses.push({ kind: 'invocation', line, args: argWords(masked, at + name.length) })
      }
    }
  }
  return uses
}
