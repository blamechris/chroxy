/**
 * A small indentation-aware reader for `.github/workflows/*.yml`, shared by the
 * CI guards in `packages/server/tests/ci-*.test.js` — today `ci-cache-key`
 * (#7386), `ci-npm-cache-routing` (#7383) and `ci-workflow-reader` (this
 * module's own tests).
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
 * The shared positive control every consumer must run BEFORE its rules.
 *
 * Thresholds are LOOSE on purpose. Their job is to catch a reader that has
 * stopped understanding these files (which yields zero), not to pin today's job
 * count — sitting them on exact numbers would turn "a job was merged away" into
 * a failure that blames the reader for someone else's refactor.
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
  const end = stepsAt === -1 ? jobBody.length : stepsAt
  for (const line of code(jobBody.slice(0, end))) {
    const m = /^\s*shell:\s*(.*)$/.exec(line)
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

    if (/^[|>][-+]?\d*$/.test(head)) {
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
      return body.map(l => l.slice(dedent)).join('\n')
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
