import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import {
  assertReaderSane,
  maskQuotedData,
  parseJobs,
  parseSteps,
  readWorkflows,
  stepInput,
  stepRun,
  stripShellComment,
  withoutHeredocBodies,
} from './helpers/workflow-reader.js'
import { jobContinueOnErrorIssue, jobNeeds, stripYamlComments } from './helpers/release-publish.js'

/**
 * The WIRING of every path-filtered job in ci.yml (#8193, finding S2 of the
 * #8191 review).
 *
 * THE DEFECT. ci.yml's `changes` job (a `dorny/paths-filter` step) exposes one
 * output per filter, and jobs gate themselves on it —
 * `if: needs.changes.outputs.<name> == 'true'`. Those jobs are deliberately NOT
 * required checks, so when their wiring breaks they do not fail: they are
 * skipped, and a skipped not-required job looks EXACTLY like "nothing relevant
 * changed". That is the #7184 / #7198 shape in docs/false-safety-guards.md —
 * the precondition is false, so the body never runs and the result reads green
 * — and it is why every other guard around these jobs (the filter-vs-input
 * parity tests, the not-required partition) can be green over a job that has
 * not run for a month. Five mutants from the #8191 review stayed green across
 * all 18 `ci-*` / `release-*` / `contributing-*` guards: M18 (typo in a
 * consumer's `if:`), M19 (an output mapping deleted), M25 (the mapping reading
 * a misspelled step output — actionlint misses this one too), M20 (`|| true` on
 * the run step) and M21 (`continue-on-error`).
 *
 * THE INVARIANTS, every set DERIVED from ci.yml and none transcribed here (a
 * hand-written list beside a set that grows is the first cause in the
 * catalogue):
 *
 *   mapping    each `changes` output reads `steps.<id>.outputs.<key>` where
 *              `<id>` is a real step of that job and — for a paths-filter step —
 *              `<key>` is a filter that step declares, under the SAME name as
 *              the output (so two valid names cannot be crossed); and every
 *              declared filter is mapped by some output.
 *   reference  every job that reads `needs.changes.outputs.<name>` names an
 *              output that exists, compares it to `'true'` (the only value
 *              paths-filter emits for a hit), and lists `changes` in its OWN
 *              `needs:`.
 *   roster     every output is read by some job or is on
 *              UNCONSUMED_OUTPUT_EXEMPTIONS with a reason, and every exemption
 *              still matches something — checked in BOTH directions, because a
 *              roster checked one way is a catalogued class (#7639).
 *   loud       a consumer must not swallow its own failure: no
 *              `continue-on-error` (job or step) and no run line that ends the
 *              command in `|| true` / `|| :` / `|| exit 0`.
 *
 * WHY `needs:` MUST BE DIRECT, not merely transitive. The `needs` context holds
 * only a job's DIRECT dependencies. A job that reaches `changes` through
 * another job reads `needs.changes.outputs.x` as the empty string, `== 'true'`
 * is false, and the job is skipped forever — silently. So reaching `changes`
 * transitively is itself the defect, and `transitiveNeeds` is deliberately NOT
 * used.
 *
 * PARSING. The job/step reading is the shared line reader
 * (`helpers/workflow-reader.js`, `helpers/release-publish.js`) so this guard
 * fails and passes with every other CI guard on what a "job" and a "step" are,
 * and the `filters:` block-scalar — a YAML document held as a string — is read
 * with js-yaml exactly as ci-docker-path-filter.test.js and
 * ci-publish-artifacts-path-filter.test.js do. The one reader written here,
 * `jobOutputs`, is a block-mapping walk, and a hand-rolled walk gets an ORACLE:
 * the CONTROL below compares it (and the consumer set, and each consumer's
 * `needs:`) against js-yaml over the real file, so the two cannot disagree
 * silently.
 *
 * WHAT IS NOT CHECKED, stated so the next reader does not assume it is. Other
 * ways to swallow a failure (`set +e`, `|| echo ...`, a `shell:` without `-e`)
 * are not enumerated — the rule names the three spellings #8191's M20 and its
 * zero-exit equivalents use, and the safe direction is a loud false positive
 * that someone then adds a reasoned exemption for. A reference in a form the
 * reader cannot resolve to an output name (`needs['changes']`, a computed
 * property) is reported rather than skipped. actionlint would catch M18 and M19
 * but is not run in CI, and nothing but this catches M25; running it is a
 * separate piece of work.
 */

const WORKFLOW = 'ci.yml'
const PRODUCER_JOB = 'changes'
const PATHS_FILTER_ACTION = 'dorny/paths-filter@'

/**
 * FLOORS, not counts: an emptied parse yields zero, and every rule below
 * passes over an empty set. Calibrated 2026-10-01 against 4 outputs (one of
 * them exempt, below) and 3 consuming jobs; both are loose lower bounds that
 * only a reader that has stopped understanding the file can fall under.
 */
const MIN_OUTPUTS = 3
const MIN_CONSUMERS = 3

/**
 * Outputs that legitimately have NO consuming job, each with the reason. An
 * output is a promise that something reads it, so an unread one is either dead
 * or a consumer that lost its wiring — the exemption is how a person says which.
 *
 * Every entry is itself checked: it must name a declared output that is still
 * unconsumed, so deleting the output or wiring a consumer to it fails this
 * test until the entry goes too.
 */
export const UNCONSUMED_OUTPUT_EXEMPTIONS = new Map([
  [
    'platform',
    "written for the Windows platform-tests job (#5002), which no longer reads it: `server-tests-windows` carries no `if:` and runs on every same-repo event (#7642). ci.yml's `changes` job comment and CONTRIBUTING.md's Detect Changed Paths row both record it as consumer-less.",
  ],
])

/**
 * `<job id>/<step label>` -> reason, for a consumer step that legitimately ends
 * a command in `|| true` and so must be allowed to. EMPTY: no path-filtered job
 * has one today, and the table exists so the next legitimate case is a reasoned,
 * self-checking entry (a stale one fails) rather than a loosened rule.
 */
export const SWALLOW_EXEMPTIONS = new Map()

// ---- readers ---------------------------------------------------------------

const unquote = (v) => {
  const m = /^(['"])(.*)\1$/.exec(v)
  return m ? m[2] : v
}

/**
 * A job's `outputs:` block mapping as `[{name, value}]`, in file order — read
 * from the raw body lines (comments blanked, quote-aware) the way `jobNeeds`
 * reads `needs:`. A flow-style `outputs: {a: x}` is not understood and yields
 * `[]`, which the floor and the js-yaml CONTROL both turn into a failure rather
 * than a pass.
 *
 * @param {string[]} jobBody
 * @returns {{name: string, value: string}[]}
 */
export function jobOutputs(jobBody) {
  const lines = stripYamlComments(jobBody)
  const at = lines.findIndex((l) => /^ {4}outputs:\s*$/.test(l))
  if (at === -1) return []
  const entries = []
  let entryIndent = null
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) continue
    const indent = /^( *)/.exec(line)[1].length
    if (indent <= 4) break
    if (entryIndent === null) entryIndent = indent
    const m = indent === entryIndent ? /^ *([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line) : null
    if (m) entries.push({ name: m[1], value: unquote(m[2]) })
    else if (entries.length > 0) entries[entries.length - 1].value += ` ${line.trim()}`
  }
  return entries
}

const NEEDS_CHANGES = new RegExp(
  String.raw`\bneeds\s*(?:\.\s*${PRODUCER_JOB}|\[\s*(['"])${PRODUCER_JOB}\1\s*\])(?![\w-])`,
  'g'
)

/**
 * Every place a job reads the `changes` job through the `needs` context, from
 * its comment-stripped body — `if:` at job or step level, `env:`, `with:`, any
 * of them. `refs` are the readings of the form `needs.changes.outputs.<name>`;
 * `bad` are readings this reader cannot resolve to an output name, reported so
 * that an unreadable spelling is a failure and never a skipped check.
 * `needs.changes.result` reads no output and is neither.
 *
 * @param {{body: string[]}} job
 * @returns {{refs: {output: string, comparedToTrue: boolean}[], bad: string[]}}
 */
export function changesReferences(job) {
  const text = stripYamlComments(job.body).join('\n')
  const refs = []
  const bad = []
  for (const m of text.matchAll(NEEDS_CHANGES)) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 80)
    const out = /^\.outputs\.([A-Za-z_][\w-]*)(?![\w-])/.exec(tail)
    if (out) {
      refs.push({ output: out[1], comparedToTrue: /^\s*==\s*'true'/.test(tail.slice(out[0].length)) })
    } else if (!/^\.result(?![\w-])/.test(tail)) {
      bad.push(
        `reads needs.${PRODUCER_JOB}${tail.split('\n')[0].slice(0, 30)} — a form this guard cannot resolve to an output name; spell it needs.${PRODUCER_JOB}.outputs.<name>`
      )
    }
  }
  return { refs, bad }
}

/**
 * The first place a `run:` body ends a command in `|| true`, `|| :`,
 * `|| exit 0` or `|| /bin/true`, or null. Quoted text, shell comments and
 * heredoc bodies are data, not commands (the reader's own passes, in the order
 * `invokes()` documents), and line continuations are joined so `cmd ||` over
 * `true` on the next line is read as one command. The word after `||` is read
 * from the ORIGINAL text and only the `||` is located in the masked one, so
 * `cmd || "true"` is still a swallow.
 *
 * @param {string} runBody
 * @returns {string|null}
 */
export function swallowedFailure(runBody) {
  const lines = withoutHeredocBodies(runBody.split('\n')).map(stripShellComment)
  const original = lines.join(' ')
  const masked = lines.map(maskQuotedData).join(' ')
  for (const m of masked.matchAll(/\|\|/g)) {
    const after = /^\s*(["']?)(true|:|exit\s+0|\/(?:usr\/)?bin\/true)\1(?=$|[\s;&|)}])/.exec(original.slice(m.index + 2))
    if (after) return original.slice(m.index, m.index + 2 + after[0].length).replace(/\s+/g, ' ')
  }
  return null
}

const stepLabel = (step, idx) =>
  stepInput(step, 'name') ?? stepInput(step, 'uses') ?? `#${idx + 1}`

// The only mapping shape the rule can verify: `${{ steps.<id>.outputs.<key> }}`.
const MAPPING = /^\$\{\{\s*steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*\}\}$/

function readFilterNames(docStep) {
  const filters = docStep && docStep.with && docStep.with.filters
  if (typeof filters !== 'string') return null
  let parsed
  try {
    parsed = yaml.load(filters)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return Object.keys(parsed)
}

const issue = (kind, text) => ({ kind, text })

// ---- the rule --------------------------------------------------------------

/**
 * Every wiring defect in one workflow's `changes` job and the jobs that read it,
 * plus the sets they were derived from. `issues` is `[{kind, text}]`, kind one
 * of `mapping` | `reference` | `roster` | `loud`; empty means sound.
 *
 * @param {{name: string, text: string, jobs: object[]}} workflow
 * @param {{unconsumedExemptions?: Map<string,string>, swallowExemptions?: Map<string,string>}} [opts]
 */
export function pathsFilterWiring(
  workflow,
  { unconsumedExemptions = UNCONSUMED_OUTPUT_EXEMPTIONS, swallowExemptions = SWALLOW_EXEMPTIONS } = {}
) {
  const issues = []
  const producer = workflow.jobs.find((j) => j.id === PRODUCER_JOB)
  if (!producer) {
    issues.push(issue('mapping', `${workflow.name} has no '${PRODUCER_JOB}' job`))
    return { issues, outputs: [], filters: [], consumers: [] }
  }

  const outputs = jobOutputs(producer.body)
  const outputNames = outputs.map((o) => o.name)

  const stepById = new Map()
  producer.steps.forEach((step) => {
    const id = stepInput(step, 'id')
    if (id) stepById.set(id, step)
  })
  // The `filters:` block-scalar is a YAML document held as a string, so the
  // outer document must parse. When it does not, say so as a finding of its own:
  // an exception here would surface as a cancelled `before` hook and a wall of
  // "did not finish" subtests, which is red but names nothing.
  let docSteps = []
  let yamlError = null
  try {
    docSteps = (yaml.load(workflow.text)?.jobs?.[PRODUCER_JOB]?.steps ?? []).filter(Boolean)
  } catch (e) {
    yamlError = e
    issues.push(
      issue('mapping', `${workflow.name} is not valid YAML (js-yaml: ${String(e.message).split('\n')[0]}) — GitHub rejects such a workflow, so no job in it runs`)
    )
  }

  // paths-filter steps: id -> declared filter names (null = unreadable).
  const filterNamesById = new Map()
  for (const [id, step] of stepById) {
    if ((stepInput(step, 'uses') ?? '').startsWith(PATHS_FILTER_ACTION)) {
      filterNamesById.set(id, readFilterNames(docSteps.find((s) => s.id === id)))
    }
  }

  // -- mapping: output -> step output, and filter -> output ------------------
  const mapped = new Set()
  for (const { name, value } of outputs) {
    const m = MAPPING.exec(value)
    if (!m) {
      issues.push(
        issue('mapping', `output '${name}': ${JSON.stringify(value)} is not a plain steps.<id>.outputs.<key> mapping, so this guard cannot verify it reads anything real`)
      )
      continue
    }
    const [, id, key] = m
    if (!stepById.has(id)) {
      issues.push(
        issue('mapping', `output '${name}' reads steps.${id}.outputs.${key}, but '${PRODUCER_JOB}' has no step with id '${id}' (ids: ${[...stepById.keys()].join(', ') || 'none'}) — the output is always empty`)
      )
      continue
    }
    if (!filterNamesById.has(id)) continue // not a paths-filter step: its keys are not enumerable here
    const names = filterNamesById.get(id)
    if (names === null) {
      if (yamlError) continue // already reported above, once
      issues.push(
        issue('mapping', `output '${name}' reads step '${id}', a paths-filter step whose filters: is not an inline mapping this guard can read — extend the guard rather than skip it`)
      )
      continue
    }
    if (!names.includes(key)) {
      issues.push(
        issue('mapping', `output '${name}' reads steps.${id}.outputs.${key}, but that paths-filter step declares no filter '${key}' (declared: ${names.join(', ')}) — the output is always empty`)
      )
      continue
    }
    mapped.add(`${id}.${key}`)
    if (name !== key) {
      issues.push(
        issue('mapping', `output '${name}' is mapped from filter '${key}' — an output must carry the name of the filter it reads, or a consumer of '${name}' gates on the wrong paths`)
      )
    }
  }
  for (const [id, names] of filterNamesById) {
    for (const f of names ?? []) {
      if (!mapped.has(`${id}.${f}`)) {
        issues.push(issue('mapping', `filter '${f}' of step '${id}' is declared but no '${PRODUCER_JOB}' output maps it, so no job can ever read it`))
      }
    }
  }

  // -- reference + loud: every job that reads `changes` ------------------------
  const consumers = []
  const swallowUsed = new Set()
  for (const job of workflow.jobs) {
    if (job.id === PRODUCER_JOB) continue
    const { refs, bad } = changesReferences(job)
    for (const b of bad) issues.push(issue('reference', `job '${job.id}' ${b}`))
    if (refs.length === 0) continue
    consumers.push({ id: job.id, outputs: [...new Set(refs.map((r) => r.output))] })

    for (const r of refs) {
      if (!outputNames.includes(r.output)) {
        issues.push(
          issue('reference', `job '${job.id}' reads needs.${PRODUCER_JOB}.outputs.${r.output}, but '${PRODUCER_JOB}' declares no such output (declared: ${outputNames.join(', ') || 'none'}) — the job is skipped on every run`)
        )
      }
      if (!r.comparedToTrue) {
        issues.push(
          issue('reference', `job '${job.id}' reads needs.${PRODUCER_JOB}.outputs.${r.output} without comparing it to 'true' — paths-filter emits 'true' for a hit, so any other comparison gates on the wrong value`)
        )
      }
    }
    const direct = jobNeeds(job.body)
    if (!direct.includes(PRODUCER_JOB)) {
      issues.push(
        issue('reference', `job '${job.id}' reads needs.${PRODUCER_JOB}.outputs but does not list '${PRODUCER_JOB}' in its own needs: (${direct.join(', ') || 'none'}) — the needs context holds DIRECT dependencies only, so every reference is empty and the job never runs`)
      )
    }

    const jobCoe = jobContinueOnErrorIssue(job.body)
    if (jobCoe) issues.push(issue('loud', `job '${job.id}': ${jobCoe} — a real failure would not fail the job`))
    job.steps.forEach((step, idx) => {
      const label = stepLabel(step, idx)
      const coe = stepInput(step, 'continue-on-error')
      if (coe !== undefined && coe !== 'false') {
        issues.push(issue('loud', `job '${job.id}', step '${label}': continue-on-error: ${coe} — a real failure would not fail the job`))
      }
      const run = stepRun(step)
      const hit = run === undefined ? null : swallowedFailure(run)
      if (hit) {
        const key = `${job.id}/${label}`
        if (swallowExemptions.has(key)) swallowUsed.add(key)
        else issues.push(issue('loud', `job '${job.id}', step '${label}': \`${hit}\` swallows the command's failure, so the job reads green over a broken check`))
      }
    })
  }
  for (const key of swallowExemptions.keys()) {
    if (!swallowUsed.has(key)) {
      issues.push(issue('loud', `stale SWALLOW_EXEMPTIONS entry '${key}': no consumer step has that key and swallows a failure any more — delete it`))
    }
  }

  // -- roster: output -> consumer, and exemption -> output --------------------
  const consumed = new Set(consumers.flatMap((c) => c.outputs))
  for (const name of outputNames) {
    if (!consumed.has(name) && !unconsumedExemptions.has(name)) {
      issues.push(
        issue('roster', `'${PRODUCER_JOB}' output '${name}' is declared and no job reads it — a consumer that lost its wiring looks exactly like this; wire one, delete the output, or add a reasoned UNCONSUMED_OUTPUT_EXEMPTIONS entry`)
      )
    }
  }
  for (const name of unconsumedExemptions.keys()) {
    if (!outputNames.includes(name)) {
      issues.push(issue('roster', `stale UNCONSUMED_OUTPUT_EXEMPTIONS entry '${name}': '${PRODUCER_JOB}' declares no such output — delete the entry`))
    } else if (consumed.has(name)) {
      issues.push(issue('roster', `stale UNCONSUMED_OUTPUT_EXEMPTIONS entry '${name}': a job reads it now — delete the entry`))
    }
  }

  return { issues, outputs, filters: [...filterNamesById.values()].flatMap((n) => n ?? []), consumers }
}

// ---- helpers for the tests below -------------------------------------------

const textsOf = (report, kind) => report.issues.filter((i) => i.kind === kind).map((i) => i.text)

function assertNone(report, kind) {
  const t = textsOf(report, kind)
  assert.ok(t.length === 0, `${kind} defects in ${WORKFLOW}:\n  ${t.join('\n  ')}`)
}

function assertReports(report, kind, re, what) {
  const t = textsOf(report, kind)
  assert.ok(t.some((x) => re.test(x)), `${what}: expected a '${kind}' issue matching ${re}, got ${JSON.stringify(t)}`)
}

const asWorkflow = (text, name = WORKFLOW) => ({ name, text, jobs: parseJobs(text, name) })

// ---- the rule, on the real tree --------------------------------------------

describe(`${WORKFLOW}: every path-filtered job is wired to a real '${PRODUCER_JOB}' output and fails loudly (#8193)`, () => {
  let workflows
  let ci
  let report

  before(async () => {
    workflows = await readWorkflows()
    // Shared positive control: a reader that has stopped understanding these
    // files finds nothing, and every rule below passes over an empty set.
    assertReaderSane(workflows)
    ci = workflows.find((w) => w.name === WORKFLOW)
    assert.ok(ci, `expected ${WORKFLOW} among the scanned workflows`)
    report = pathsFilterWiring(ci)
  })

  it('FLOOR: outputs, filters and consuming jobs were all derived from the file', () => {
    assert.ok(
      report.outputs.length >= MIN_OUTPUTS,
      `expected >= ${MIN_OUTPUTS} '${PRODUCER_JOB}' outputs, derived ${report.outputs.length} — the reader has probably stopped understanding the file`
    )
    assert.ok(
      report.filters.length >= MIN_OUTPUTS,
      `expected >= ${MIN_OUTPUTS} paths-filter filter names, derived ${report.filters.length}`
    )
    assert.ok(
      report.consumers.length >= MIN_CONSUMERS,
      `expected >= ${MIN_CONSUMERS} jobs reading needs.${PRODUCER_JOB}.outputs, derived ${report.consumers.length}: ${report.consumers.map((c) => c.id).join(', ')}`
    )
  })

  it('CONTROL: the line readers agree with js-yaml over the real file (the oracle for a hand-rolled walk)', () => {
    const doc = yaml.load(ci.text)
    const oracleOutputs = Object.entries(doc.jobs[PRODUCER_JOB].outputs)
    assert.ok(
      JSON.stringify(report.outputs.map((o) => [o.name, o.value])) === JSON.stringify(oracleOutputs),
      `jobOutputs disagrees with js-yaml: ${JSON.stringify(report.outputs.map((o) => o.name))} vs ${JSON.stringify(oracleOutputs.map(([n]) => n))}`
    )

    const oracleConsumers = Object.entries(doc.jobs)
      .filter(([id, job]) => id !== PRODUCER_JOB && /\bneeds\.changes\b/.test(JSON.stringify(job)))
      .map(([id]) => id)
      .sort()
    assert.ok(
      JSON.stringify(report.consumers.map((c) => c.id).sort()) === JSON.stringify(oracleConsumers),
      `the consumer set disagrees with js-yaml: ${report.consumers.map((c) => c.id).join(', ')} vs ${oracleConsumers.join(', ')}`
    )

    for (const c of report.consumers) {
      const job = ci.jobs.find((j) => j.id === c.id)
      const oracleNeeds = [].concat(doc.jobs[c.id].needs ?? [])
      assert.ok(
        JSON.stringify(jobNeeds(job.body)) === JSON.stringify(oracleNeeds),
        `jobNeeds disagrees with js-yaml for '${c.id}': ${JSON.stringify(jobNeeds(job.body))} vs ${JSON.stringify(oracleNeeds)}`
      )
    }
  })

  it('every output mapping reads a step output that exists, under its own name, and every filter is mapped', () => {
    assertNone(report, 'mapping')
  })

  it("every job reading needs.changes.outputs names an output that exists, compares it to 'true', and needs changes directly", () => {
    assertNone(report, 'reference')
  })

  it('every output is read by some job or is exempt with a reason, and every exemption still matches', () => {
    assertNone(report, 'roster')
  })

  it('no consuming job swallows its own failure (continue-on-error, || true, || :, || exit 0)', () => {
    assertNone(report, 'loud')
  })

  it('every dorny/paths-filter step in the repo is the one in ci.yml\'s changes job — none is left unguarded', () => {
    const users = workflows
      .flatMap((w) =>
        w.jobs
          .filter((j) => j.steps.some((s) => (stepInput(s, 'uses') ?? '').startsWith(PATHS_FILTER_ACTION)))
          .map((j) => `${w.name}#${j.id}`)
      )
      .sort()
    assert.ok(
      JSON.stringify(users) === JSON.stringify([`${WORKFLOW}#${PRODUCER_JOB}`]),
      `paths-filter is used by ${JSON.stringify(users)}; this guard covers only ${WORKFLOW}#${PRODUCER_JOB} — extend it to the new job rather than leave its consumers unguarded`
    )
  })
})

// ---- each branch of the readers and the rule proven to REPORT ----------------

describe('jobOutputs / changesReferences / swallowedFailure read the shapes they exist to read (#8193)', () => {
  it('jobOutputs reads a block mapping, ignores comments and blanks, and stops at the next job key', () => {
    const body = [
      '  changes:',
      '    outputs:',
      '      # a comment naming zz: ${{ steps.nope.outputs.zz }}',
      '      alpha: ${{ steps.filter.outputs.alpha }}  # trailing',
      '',
      "      beta: '${{ steps.filter.outputs.beta }}'",
      '    steps:',
      '      - id: not-an-output',
    ]
    assert.deepEqual(jobOutputs(body), [
      { name: 'alpha', value: '${{ steps.filter.outputs.alpha }}' },
      { name: 'beta', value: '${{ steps.filter.outputs.beta }}' },
    ])
  })

  it('jobOutputs yields [] for a job with no outputs: block', () => {
    assert.deepEqual(jobOutputs(['  changes:', '    steps:', '      - run: echo']), [])
  })

  it('changesReferences reads the dot and bracketed-job forms, ignores .result and comments, and reports an unreadable spelling', () => {
    const job = {
      body: [
        '  j:',
        "    if: needs.changes.outputs.alpha == 'true' && needs.changes.result == 'success'",
        '    # needs.changes.outputs.commented == \'true\'',
        '    steps:',
        "      - if: needs['changes'].outputs.beta == 'true'",
        "      - if: needs.changes.outputs['epsilon'] == 'true'",
        "      - if: needs.changes.outputs.gamma != 'true'",
        "      - if: needs.changes.outputs.delta-x == 'true'",
      ],
    }
    const { refs, bad } = changesReferences(job)
    assert.deepEqual(refs, [
      { output: 'alpha', comparedToTrue: true },
      { output: 'beta', comparedToTrue: true },
      { output: 'gamma', comparedToTrue: false },
      { output: 'delta-x', comparedToTrue: true },
    ])
    assert.equal(bad.length, 1, JSON.stringify(bad))
    assert.ok(/cannot resolve to an output name/.test(bad[0]), bad[0])
  })

  it('changesReferences does not read a different job whose id merely starts with changes', () => {
    const { refs, bad } = changesReferences({ body: ['  j:', "    if: needs.changes-other.outputs.x == 'true'"] })
    assert.deepEqual([refs, bad], [[], []])
  })

  const SWALLOWS = [
    'npm run build || true',
    'npm run build||true',
    'npm run build || :',
    'npm run build || exit 0',
    'npm run build || /bin/true',
    'npm run build || "true"',
    'npm run build ||\n  true',
    'npm run build \\\n  || true',
    'x=$(npm run build || true)',
    'echo "$(npm run build || true)"',
    'a\nnpm run build || true\nb',
    'npm run build || true # tolerated',
  ]
  const CLEAN = [
    'npm run build',
    'npm run build || exit 1',
    'npm run build || { echo failed; exit 1; }',
    'npm run build || trueish',
    'true || npm run build',
    'echo "x || true"',
    "echo 'x || true'",
    '# npm run build || true',
    'cat <<EOF\nnpm run build || true\nEOF\nnpm run build',
    'npm run build && echo done',
  ]
  for (const body of SWALLOWS) {
    it(`swallowedFailure reports ${JSON.stringify(body)}`, () => {
      assert.ok(swallowedFailure(body) !== null, `expected a swallow in ${JSON.stringify(body)}`)
    })
  }
  for (const body of CLEAN) {
    it(`swallowedFailure leaves ${JSON.stringify(body)} alone`, () => {
      assert.ok(swallowedFailure(body) === null, `unexpected swallow ${swallowedFailure(body)} in ${JSON.stringify(body)}`)
    })
  }
})

const FIXTURE = [
  'name: fixture',
  'jobs:',
  '  other:',
  '    runs-on: ubuntu-24.04',
  '    steps:',
  '      - run: echo hi',
  '  changes:',
  '    needs: other',
  '    runs-on: ubuntu-24.04',
  '    outputs:',
  '      alpha: ${{ steps.filter.outputs.alpha }}',
  '      beta: ${{ steps.filter.outputs.beta }}',
  '    steps:',
  '      - uses: actions/checkout@abc',
  '      - id: filter',
  '        uses: dorny/paths-filter@abc',
  '        with:',
  '          filters: |',
  '            alpha:',
  "              - 'a/**'",
  '            beta:',
  "              - 'b/**'",
  '  job-a:',
  '    needs: changes',
  "    if: needs.changes.outputs.alpha == 'true'",
  '    runs-on: ubuntu-24.04',
  '    steps:',
  '      - uses: actions/checkout@abc',
  '      - name: Check a',
  '        run: node check-a.mjs',
  '  job-b:',
  '    needs: [other, changes]',
  "    if: needs.changes.outputs.beta == 'true'",
  '    runs-on: ubuntu-24.04',
  '    steps:',
  '      - name: Check b',
  '        run: |',
  '          set -e',
  '          node check-b.mjs',
].join('\n')

const NO_EXEMPTIONS = { unconsumedExemptions: new Map(), swallowExemptions: new Map() }

function swap(text, find, replace) {
  const n = text.split(find).length - 1
  assert.equal(n, 1, `expected exactly 1 occurrence of ${JSON.stringify(find)}, found ${n}`)
  return text.replace(find, replace)
}

describe('pathsFilterWiring reports each defect it exists to find, on a synthetic workflow (#8193)', () => {
  const run = (text, opts = NO_EXEMPTIONS) => pathsFilterWiring(asWorkflow(text), opts)

  it('CONTROL: a sound workflow reports nothing, and the derived sets are what the fixture declares', () => {
    const r = run(FIXTURE)
    assert.deepEqual(r.issues, [])
    assert.deepEqual(r.outputs.map((o) => o.name), ['alpha', 'beta'])
    assert.deepEqual(r.filters, ['alpha', 'beta'])
    assert.deepEqual(r.consumers, [{ id: 'job-a', outputs: ['alpha'] }, { id: 'job-b', outputs: ['beta'] }])
  })

  it('reference: a typo in a consumer if: (M18)', () => {
    const r = run(swap(FIXTURE, 'outputs.alpha ==', 'outputs.alphx =='))
    assertReports(r, 'reference', /job 'job-a' reads needs\.changes\.outputs\.alphx, but 'changes' declares no such output/, 'M18')
  })

  it("reference: a literal other than 'true'", () => {
    const r = run(swap(FIXTURE, "outputs.alpha == 'true'", "outputs.alpha == 'ture'"))
    assertReports(r, 'reference', /job 'job-a'.*without comparing it to 'true'/, "'ture'")
  })

  it('reference: an unreadable spelling is reported, not skipped', () => {
    const r = run(swap(FIXTURE, "needs.changes.outputs.alpha == 'true'", "needs.changes.outputs['alpha'] == 'true'"))
    assertReports(r, 'reference', /job 'job-a' reads needs\.changes\.outputs\['alpha'\].*cannot resolve/, 'bracketed output name')
  })

  it("reference: a consumer that reaches 'changes' only through another job (the needs context is direct-only)", () => {
    const withMid = swap(FIXTURE, '  job-a:\n    needs: changes\n', '  mid:\n    needs: changes\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n  job-a:\n    needs: mid\n')
    assertReports(run(withMid), 'reference', /job 'job-a'.*does not list 'changes' in its own needs: \(mid\)/, 'transitive-only')
  })

  it("reference: a consumer that drops 'changes' from a flow needs list", () => {
    const r = run(swap(FIXTURE, 'needs: [other, changes]', 'needs: [other]'))
    assertReports(r, 'reference', /job 'job-b'.*does not list 'changes'/, 'flow list')
  })

  it('mapping: a deleted output mapping (M19) is reported twice over — by the consumer and by the orphaned filter', () => {
    const r = run(swap(FIXTURE, '      beta: ${{ steps.filter.outputs.beta }}\n', ''))
    assertReports(r, 'reference', /job 'job-b' reads needs\.changes\.outputs\.beta, but 'changes' declares no such output/, 'M19 consumer')
    assertReports(r, 'mapping', /filter 'beta' of step 'filter' is declared but no 'changes' output maps it/, 'M19 filter')
  })

  it('mapping: the mapping reading a misspelled step output (M25)', () => {
    const r = run(swap(FIXTURE, 'beta: ${{ steps.filter.outputs.beta }}', 'beta: ${{ steps.filter.outputs.bet }}'))
    assertReports(r, 'mapping', /output 'beta' reads steps\.filter\.outputs\.bet, but that paths-filter step declares no filter 'bet'/, 'M25')
  })

  it('mapping: two VALID names crossed (the existence checks alone cannot see this)', () => {
    const r = run(swap(FIXTURE, 'beta: ${{ steps.filter.outputs.beta }}', 'beta: ${{ steps.filter.outputs.alpha }}'))
    assertReports(r, 'mapping', /output 'beta' is mapped from filter 'alpha'/, 'crossed')
  })

  it('mapping: a mapping that reads a step id the job does not have', () => {
    const r = run(swap(FIXTURE, 'beta: ${{ steps.filter.outputs.beta }}', 'beta: ${{ steps.filtr.outputs.beta }}'))
    assertReports(r, 'mapping', /output 'beta' reads steps\.filtr\.outputs\.beta, but 'changes' has no step with id 'filtr'/, 'bad id')
  })

  it('mapping: a value that is not a plain step-output mapping is reported, not trusted', () => {
    const r = run(swap(FIXTURE, 'beta: ${{ steps.filter.outputs.beta }}', "beta: ${{ steps.filter.outputs.beta || 'x' }}"))
    assertReports(r, 'mapping', /output 'beta'.*not a plain steps\.<id>\.outputs\.<key> mapping/, 'computed value')
  })

  it('mapping: a filter deleted from the filters: block', () => {
    const r = run(swap(FIXTURE, "            beta:\n              - 'b/**'\n", ''))
    assertReports(r, 'mapping', /output 'beta' reads steps\.filter\.outputs\.beta, but that paths-filter step declares no filter 'beta'/, 'deleted filter')
  })

  it('mapping: a filters: value that is not an inline mapping (a file path) is reported, not skipped', () => {
    const r = run(swap(FIXTURE, '          filters: |\n            alpha:\n              - \'a/**\'\n            beta:\n              - \'b/**\'', '          filters: .github/filters.yml'))
    assertReports(r, 'mapping', /not an inline mapping this guard can read/, 'file filters')
  })

  it('mapping: a producing step that is not paths-filter is held to the step-id check only', () => {
    const r = run(swap(FIXTURE, 'uses: dorny/paths-filter@abc', 'uses: some/other-action@abc'))
    assert.deepEqual(textsOf(r, 'mapping'), [])
  })

  it('roster: an output nothing reads', () => {
    const text = swap(
      swap(FIXTURE, '      beta: ${{', '      zz: ${{ steps.filter.outputs.zz }}\n      beta: ${{'),
      "            beta:\n              - 'b/**'",
      "            beta:\n              - 'b/**'\n            zz:\n              - 'z/**'"
    )
    assertReports(run(text), 'roster', /'changes' output 'zz' is declared and no job reads it/, 'unconsumed')
  })

  it('roster: an exemption silences exactly the output it names, and a stale one is reported', () => {
    const text = swap(
      swap(FIXTURE, '      beta: ${{', '      zz: ${{ steps.filter.outputs.zz }}\n      beta: ${{'),
      "            beta:\n              - 'b/**'",
      "            beta:\n              - 'b/**'\n            zz:\n              - 'z/**'"
    )
    const exempt = (...names) => ({ unconsumedExemptions: new Map(names.map((n) => [n, 'why'])), swallowExemptions: new Map() })
    assert.deepEqual(run(text, exempt('zz')).issues, [])
    assertReports(run(text, exempt('zz', 'gone')), 'roster', /stale UNCONSUMED_OUTPUT_EXEMPTIONS entry 'gone'.*declares no such output/, 'names nothing')
    assertReports(run(text, exempt('zz', 'alpha')), 'roster', /stale UNCONSUMED_OUTPUT_EXEMPTIONS entry 'alpha'.*a job reads it now/, 'now consumed')
  })

  it('loud: continue-on-error on a consumer step, at first-line and key spellings, and at job level (M21)', () => {
    assertReports(
      run(swap(FIXTURE, '      - name: Check a\n', '      - name: Check a\n        continue-on-error: true\n')),
      'loud', /job 'job-a', step 'Check a': continue-on-error: true/, 'step key'
    )
    assertReports(
      run(swap(FIXTURE, '      - name: Check a\n', '      - continue-on-error: true\n        name: Check a\n')),
      'loud', /job 'job-a', step 'Check a': continue-on-error: true/, 'first-line spelling'
    )
    assertReports(
      run(swap(FIXTURE, "    if: needs.changes.outputs.alpha == 'true'\n", "    if: needs.changes.outputs.alpha == 'true'\n    continue-on-error: true\n")),
      'loud', /job 'job-a': continue-on-error: true at job level/, 'job level'
    )
    const falsy = run(swap(FIXTURE, '      - name: Check a\n', '      - name: Check a\n        continue-on-error: false\n'))
    assert.deepEqual(textsOf(falsy, 'loud'), [])
  })

  it('loud: || true / || : appended to a consumer run step, plain and block scalar (M20)', () => {
    assertReports(run(swap(FIXTURE, 'run: node check-a.mjs', 'run: node check-a.mjs || true')), 'loud', /job 'job-a', step 'Check a': `\|\| true` swallows/, 'plain scalar')
    assertReports(run(swap(FIXTURE, 'node check-b.mjs', 'node check-b.mjs || :')), 'loud', /job 'job-b', step 'Check b': `\|\| :` swallows/, 'block scalar')
  })

  it('loud: a swallow exemption silences exactly its job/step, and a stale one is reported', () => {
    const text = swap(FIXTURE, 'run: node check-a.mjs', 'run: node check-a.mjs || true')
    const ex = (...keys) => ({ unconsumedExemptions: new Map(), swallowExemptions: new Map(keys.map((k) => [k, 'why'])) })
    assert.deepEqual(textsOf(run(text, ex('job-a/Check a')), 'loud'), [])
    assertReports(run(text, ex('job-a/Check a', 'job-a/Gone')), 'loud', /stale SWALLOW_EXEMPTIONS entry 'job-a\/Gone'/, 'stale')
    assertReports(run(FIXTURE, ex('job-a/Check a')), 'loud', /stale SWALLOW_EXEMPTIONS entry 'job-a\/Check a'.*swallows a failure any more/, 'swallow removed')
  })

  it('mapping: a workflow that is not valid YAML is reported as such, and the line-level rules still run', () => {
    // `|| :` closing a PLAIN scalar is a real way to break the document: the
    // trailing colon reads as a mapping key. GitHub would reject the file.
    const r = run(swap(FIXTURE, 'run: node check-a.mjs', 'run: node check-a.mjs || :'))
    assertReports(r, 'mapping', /is not valid YAML \(js-yaml:/, 'invalid yaml')
    assertReports(r, 'loud', /job 'job-a', step 'Check a': `\|\| :` swallows/, 'line rules still run')
    assert.ok(!textsOf(r, 'mapping').some((t) => /not an inline mapping/.test(t)), 'the unreadable-filters noise must not repeat the YAML finding')
  })

  it('reports a workflow with no changes job at all', () => {
    const r = run(swap(FIXTURE, '  changes:\n', '  changez:\n'))
    assertReports(r, 'mapping', /has no 'changes' job/, 'missing producer')
  })
})

// ---- the same defects, injected into the REAL ci.yml, on every consumer -----

/**
 * The mutants from #8191's review, applied to in-memory COPIES of the real
 * ci.yml and aimed at every job and output the rule DISCOVERED — not at three
 * names written here — so a consumer added tomorrow is mutation-proven the day
 * it lands. The file on disk is never touched. Every edit asserts it changed
 * something and that the unmutated copy is clean, so a mutant that lands
 * nowhere cannot read as a pass.
 */
describe('the rule turns RED on each wiring mutant, for every job and output ci.yml has (#8193)', () => {
  let text
  let report

  before(async () => {
    const workflows = await readWorkflows()
    const ci = workflows.find((w) => w.name === WORKFLOW)
    assert.ok(ci, `expected ${WORKFLOW} among the scanned workflows`)
    text = ci.text
    report = pathsFilterWiring(ci)
  })

  // -- line-level editing of one job's block ---------------------------------
  function edit(id, fn) {
    const lines = text.split('\n')
    const job = parseJobs(text, WORKFLOW).find((j) => j.id === id)
    assert.ok(job, `no job '${id}' in ${WORKFLOW}`)
    const start = job.line - 1
    const end = start + job.body.length
    const find = (pred, what) => {
      const i = lines.findIndex((l, n) => n >= start && n < end && !/^\s*#/.test(l) && pred(l))
      assert.ok(i !== -1, `mutant anchor not found in '${id}': ${what}`)
      return i
    }
    fn({ lines, start, end, job, find })
    const out = lines.join('\n')
    assert.ok(out !== text, `mutant on '${id}' changed nothing`)
    return out
  }

  // The absolute [from, to) line span of each step of a job.
  function stepSpans(job, start) {
    const steps = parseSteps(job.body)
    const stepsAt = job.body.findIndex((l) => /^\s*steps:/.test(l))
    let at = job.body.indexOf(steps[0][0], stepsAt + 1)
    return steps.map((s) => {
      const span = { from: start + at, to: start + at + s.length, step: s }
      at += s.length
      return span
    })
  }

  const red = (mutant, kind, re, what) => assertReports(pathsFilterWiring(asWorkflow(mutant)), kind, re, what)

  it('CONTROL: the unmutated copy is clean, so every RED below is the mutant', () => {
    assert.deepEqual(report.issues, [])
  })

  it('M18: a typo in each consumer\'s if:', () => {
    for (const c of report.consumers) {
      const out = c.outputs[0]
      const mutant = edit(c.id, ({ lines, find }) => {
        const i = find((l) => l.includes(`needs.changes.outputs.${out}`), 'the if: reading the output')
        lines[i] = lines[i].replace(`needs.changes.outputs.${out}`, `needs.changes.outputs.${out}-zz-mutant`)
      })
      red(mutant, 'reference', new RegExp(`job '${c.id}' reads needs\\.changes\\.outputs\\.${out}-zz-mutant, but 'changes' declares no such output`), `M18 on ${c.id}`)
    }
  })

  it('M18 (literal): a typo in the \'true\' each consumer compares against', () => {
    for (const c of report.consumers) {
      const mutant = edit(c.id, ({ lines, find }) => {
        const i = find((l) => l.includes("== 'true'"), "the == 'true' comparison")
        lines[i] = lines[i].replace("== 'true'", "== 'ture'")
      })
      red(mutant, 'reference', new RegExp(`job '${c.id}'.*without comparing it to 'true'`), `literal on ${c.id}`)
    }
  })

  it('M18 (job id): a typo in needs.changes itself leaves the output with no reader', () => {
    for (const c of report.consumers) {
      const out = c.outputs[0]
      const mutant = edit(c.id, ({ lines, find }) => {
        const i = find((l) => l.includes(`needs.changes.outputs.${out}`), 'the if: reading the output')
        lines[i] = lines[i].replace('needs.changes.outputs', 'needs.chnages.outputs')
      })
      red(mutant, 'roster', new RegExp(`'changes' output '${out}' is declared and no job reads it`), `needs.chnages on ${c.id}`)
    }
  })

  it('M19: each consumed output\'s mapping deleted', () => {
    for (const out of new Set(report.consumers.flatMap((c) => c.outputs))) {
      const mutant = edit(PRODUCER_JOB, ({ lines, find }) => {
        lines.splice(find((l) => new RegExp(`^ {6}${out}:\\s*\\$\\{\\{`).test(l), `the ${out} mapping`), 1)
      })
      const consumer = report.consumers.find((c) => c.outputs.includes(out))
      red(mutant, 'reference', new RegExp(`job '${consumer.id}' reads needs\\.changes\\.outputs\\.${out}, but 'changes' declares no such output`), `M19 on ${out}`)
    }
  })

  it('M25: each consumed output\'s mapping reading a misspelled step output', () => {
    for (const out of new Set(report.consumers.flatMap((c) => c.outputs))) {
      const mutant = edit(PRODUCER_JOB, ({ lines, find }) => {
        const i = find((l) => new RegExp(`^ {6}${out}:\\s*\\$\\{\\{`).test(l), `the ${out} mapping`)
        lines[i] = lines[i].replace(/(outputs\.[\w-]+)(\s*\}\})/, '$1-zz-mutant$2')
      })
      red(mutant, 'mapping', new RegExp(`output '${out}' reads steps\\.[\\w-]+\\.outputs\\.${out}-zz-mutant, but that paths-filter step declares no filter`), `M25 on ${out}`)
    }
  })

  it('M25 (crossed): each consumed output reading ANOTHER real filter', () => {
    const names = report.outputs.map((o) => o.name)
    for (const out of new Set(report.consumers.flatMap((c) => c.outputs))) {
      const other = names.find((n) => n !== out)
      const mutant = edit(PRODUCER_JOB, ({ lines, find }) => {
        const i = find((l) => new RegExp(`^ {6}${out}:\\s*\\$\\{\\{`).test(l), `the ${out} mapping`)
        lines[i] = lines[i].replace(/outputs\.[\w-]+/, `outputs.${other}`)
      })
      red(mutant, 'mapping', new RegExp(`output '${out}' is mapped from filter '${other}'`), `crossed ${out}->${other}`)
    }
  })

  it('a filter deleted from the paths-filter filters: block, for each consumed output', () => {
    for (const out of new Set(report.consumers.flatMap((c) => c.outputs))) {
      const mutant = edit(PRODUCER_JOB, ({ lines, find }) => {
        const at = find((l) => /^\s*filters:\s*\|/.test(l), 'the filters: block scalar')
        const indent = /^( *)/.exec(lines.slice(at + 1).find((l) => l.trim() !== ''))[1].length
        const i = lines.findIndex((l, n) => n > at && new RegExp(`^ {${indent}}${out}:\\s*$`).test(l))
        assert.ok(i !== -1, `no '${out}:' filter key at indent ${indent}`)
        lines.splice(i, 1)
      })
      red(mutant, 'mapping', new RegExp(`output '${out}' reads steps\\.[\\w-]+\\.outputs\\.${out}, but that paths-filter step declares no filter '${out}'`), `filter ${out} deleted`)
    }
  })

  it('a new output nothing consumes', () => {
    const mutant = edit(PRODUCER_JOB, ({ lines, find }) => {
      const first = report.outputs[0].value
      const stepId = MAPPING.exec(first)[1]
      lines.splice(find((l) => /^ {4}outputs:\s*$/.test(l), 'outputs:') + 1, 0, `      zz-mutant: \${{ steps.${stepId}.outputs.zz-mutant }}`)
      const at = find((l) => /^\s*filters:\s*\|/.test(l), 'the filters: block scalar')
      const indent = /^( *)/.exec(lines[at + 1])[1]
      lines.splice(at + 1, 0, `${indent}zz-mutant:`, `${indent}  - 'zz-mutant-not-a-path'`)
    })
    red(mutant, 'roster', /'changes' output 'zz-mutant' is declared and no job reads it/, 'unconsumed output')
  })

  it('a consumer that loses \'changes\' from its own needs', () => {
    for (const c of report.consumers) {
      const mutant = edit(c.id, ({ lines, find }) => {
        const i = find((l) => /^ {4}needs:/.test(l), 'the needs: line')
        const value = lines[i].replace(/^ {4}needs:\s*/, '').trim()
        assert.ok(/^(changes|\[.*\bchanges\b.*\])$/.test(value), `unexpected needs shape ${value}`)
        lines[i] = value === 'changes' ? '    needs: runner-target' : `    needs: ${value.replace(/,\s*changes\b|\bchanges\b,?\s*/, '')}`
      })
      red(mutant, 'reference', new RegExp(`job '${c.id}'.*does not list 'changes' in its own needs`), `needs on ${c.id}`)
    }
  })

  it('M20: || true appended to every run step of each consumer', () => {
    let proved = 0
    for (const c of report.consumers) {
      const job = parseJobs(text, WORKFLOW).find((j) => j.id === c.id)
      stepSpans(job, job.line - 1).forEach((span, idx) => {
        if (stepRun(span.step) === undefined) return
        const mutant = edit(c.id, ({ lines }) => {
          let last = span.to - 1
          while (lines[last].trim() === '' || /^\s*#/.test(lines[last])) last--
          lines[last] += ' || true'
        })
        red(mutant, 'loud', new RegExp(`job '${c.id}', step '.*': \`\\|\\| true\` swallows`), `M20 on ${c.id} step ${idx + 1}`)
        proved++
      })
    }
    assert.ok(proved >= MIN_CONSUMERS, `proved M20 on ${proved} run steps, expected at least ${MIN_CONSUMERS}`)
  })

  it('M21: continue-on-error added to every step, and to the job itself, of each consumer', () => {
    let proved = 0
    for (const c of report.consumers) {
      const job = parseJobs(text, WORKFLOW).find((j) => j.id === c.id)
      stepSpans(job, job.line - 1).forEach((span, idx) => {
        const mutant = edit(c.id, ({ lines }) => {
          const indent = /^( *)/.exec(lines[span.from])[1].length + 2
          lines.splice(span.from + 1, 0, `${' '.repeat(indent)}continue-on-error: true`)
        })
        red(mutant, 'loud', new RegExp(`job '${c.id}', step '.*': continue-on-error: true`), `M21 on ${c.id} step ${idx + 1}`)
        proved++
      })
      const jobMutant = edit(c.id, ({ lines, start }) => {
        lines.splice(start + 1, 0, '    continue-on-error: true')
      })
      red(jobMutant, 'loud', new RegExp(`job '${c.id}': continue-on-error: true at job level`), `M21 job-level on ${c.id}`)
      proved++
    }
    assert.ok(proved >= MIN_CONSUMERS, `proved M21 on ${proved} placements, expected at least ${MIN_CONSUMERS}`)
  })
})
