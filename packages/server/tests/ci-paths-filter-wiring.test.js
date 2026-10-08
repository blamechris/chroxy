import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import {
  assertReaderSane,
  heredocDelimiter,
  jobShell,
  maskQuotedData,
  parseJobs,
  parseSteps,
  readWorkflows,
  stepInput,
  stepRun,
  stripShellComment,
  workflowTriggers,
} from './helpers/workflow-reader.js'
import {
  jobContinueOnErrorIssue,
  jobIf,
  jobNeeds,
  stepShellIssue,
  stripYamlComments,
} from './helpers/release-publish.js'

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
 * every `ci-*` / `release-*` / `contributing-*` guard that existed then: M18
 * (typo in a consumer's `if:`), M19 (an output mapping deleted), M25 (the
 * mapping reading a misspelled step output — actionlint misses this one too),
 * M20 (`|| true` on the run step) and M21 (`continue-on-error`).
 *
 * THE INVARIANTS, every set DERIVED from ci.yml and none transcribed here (a
 * hand-written list beside a set that grows is the first cause in the
 * catalogue):
 *
 *   mapping    each `changes` output reads `steps.<id>.outputs.<key>` where
 *              `<id>` is a real step of that job and — for a paths-filter step —
 *              `<key>` is a filter that step declares (or one of its own
 *              built-ins), under the SAME name as the output (so two valid names
 *              cannot be crossed); and every declared filter is mapped by some
 *              output.
 *   reference  EVERY job's `needs.<id>` read names a job in that job's OWN
 *              `needs:` — not just reads of `changes`, because a typo'd
 *              `needs.chnages` is a read of a context that does not exist, which
 *              is empty, and the job is skipped; and every job reading
 *              `needs.changes.outputs.<name>` names an output that exists and
 *              compares it to `'true'` (the only value paths-filter emits for a
 *              hit).
 *   roster     every output is read by some job or is on
 *              UNCONSUMED_OUTPUT_EXEMPTIONS with a reason, and every exemption
 *              still matches something — checked in BOTH directions, because a
 *              roster checked one way is a catalogued class (#7639).
 *   loud       neither a consumer NOR the `changes` job itself may swallow its
 *              own failure: no `continue-on-error` (job or step), no run line
 *              that ends a command in a zero-exit spelling, and no shell
 *              without `-e`. The producer is in scope because a failed filter
 *              leaves every output empty and skips every consumer — the issue's
 *              own failure mode, one hop upstream. Its job-level `if:` must be
 *              satisfiable: every `github.event_name == '<event>'` it names is an
 *              event the workflow triggers on, and it lets `pull_request`
 *              through when the workflow has that trigger.
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
 * WHAT IS NOT CHECKED, stated so the next reader does not assume it is — and in
 * which direction each gap fails, because the first version of this comment
 * called them "loud false positives" and they are the opposite. A swallow
 * spelling this file does not enumerate PASSES: that is a silent false negative,
 * the dangerous direction.
 *
 *   Detected: `|| true`, `|| :`, `|| exit 0`, `|| /bin/true`, `|| { true; }`,
 *   `|| (true)`, `|| echo ...` / `|| printf ...` (unless the same line then
 *   exits non-zero, fails or returns), `; true`, `set +e`, those same spellings
 *   inside a `bash -c '...'` / `sh -c "..."` payload, `continue-on-error` at job
 *   or step level, and a `shell:` other than the default or exactly `bash`
 *   (a `bash {0}` template drops `-e`). Quoted text, shell comments and
 *   TERMINATED heredoc bodies are data; an unterminated or over-matched heredoc
 *   start (`echo "x<<EOF"`, `$((1<<4))`) is NOT treated as one, because blanking
 *   the rest of the step would hide a later swallow.
 *
 *   NOT detected (each fails silently): `cmd && true`, `if cmd; then :; fi` and
 *   other conditional wrappers, `trap ... ERR`/`EXIT` handlers that reset the
 *   status, `exit 0` on its own line, a shell function or alias that swallows,
 *   `cmd &` without a `wait`, `timeout`/`xargs`-style wrappers that change the
 *   status, a swallow reached through a variable or `eval`, and a `-c` payload
 *   that is not a literal. A reference in a form the reader cannot resolve to an
 *   output name (`needs.changes.outputs['x']`, a computed property) IS reported
 *   rather than skipped, and so is a producer `if:` it cannot read.
 *
 * actionlint would catch M18 and M19 but is not run in CI, and nothing but this
 * catches M25; running it is a separate piece of work.
 */

const WORKFLOW = 'ci.yml'
const PRODUCER_JOB = 'changes'
const PATHS_FILTER_ACTION = 'dorny/paths-filter@'

/**
 * FLOORS: an emptied parse yields zero, and every rule below passes over an
 * empty set. Calibrated 2026-10-01 against 4 outputs (one of them exempt,
 * since removed, #7642) and 3 consuming jobs; 3 outputs today, all consumed.
 * MIN_OUTPUTS sits at today's count.
 * MIN_CONSUMERS EQUALS it — #8193's acceptance asked for "at least as many as
 * there are consumer jobs today" — so retiring a consumer on purpose trips the
 * floor, and the remedy then is to lower MIN_CONSUMERS in that same change, not
 * to doubt the reader.
 */
const MIN_OUTPUTS = 3
const MIN_CONSUMERS = 3

/**
 * Outputs that legitimately have NO consuming job, each with the reason. An
 * output is a promise that something reads it, so an unread one is either dead
 * or a consumer that lost its wiring — the exemption is how a person says which.
 *
 * EMPTY: the one entry it ever held, `platform` (written for the Windows job,
 * #5002, then orphaned when that job lost its `if:`), was removed with the
 * output itself (#7642). The table stays so the next legitimate case is a
 * reasoned, self-checking entry rather than a loosened rule.
 *
 * Every entry is itself checked: it must name a declared output that is still
 * unconsumed, so deleting the output or wiring a consumer to it fails this
 * test until the entry goes too.
 */
export const UNCONSUMED_OUTPUT_EXEMPTIONS = new Map()

/**
 * `<job id>/<step label>` -> reason, for a step that legitimately swallows a
 * failure (or sets a shell without `-e`) and so must be allowed to. EMPTY: no
 * path-filtered job or producer step has one today, and the table exists so the
 * next legitimate case is a reasoned, self-checking entry (a stale one fails)
 * rather than a loosened rule.
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

/**
 * A job's DIRECT dependencies, as GitHub sees them. `jobNeeds` does not strip a
 * trailing `# comment` (`needs: [a, changes]  # why` reads as `changes] # why`)
 * or unquote an entry (`needs: ['a', "changes"]`), and both are valid, common
 * spellings — so comments are stripped first and entries unquoted after.
 */
export const directNeeds = (job) => jobNeeds(stripYamlComments(job.body)).map((n) => unquote(n.trim()))

const NEEDS_READ = /\bneeds\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*(['"])([A-Za-z_][\w-]*)\2\s*\])/g

/**
 * Every job id a job reads through the `needs` context, anywhere in its
 * comment-stripped body (`if:` at job or step level, `env:`, `with:`,
 * `runs-on:`, ...).
 *
 * @param {{body: string[]}} job
 * @returns {string[]}
 */
export function needsReads(job) {
  const text = stripYamlComments(job.body).join('\n')
  return [...new Set([...text.matchAll(NEEDS_READ)].map((m) => m[1] ?? m[3]))]
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

// ---- swallowed failures ----------------------------------------------------

const squash = (s) => s.replace(/\s+/g, ' ').trim()

/**
 * What may follow `||` and still leave the command's failure swallowed: a
 * zero-exit word (`true`, `:`, `exit 0`, `/bin/true`, quoted or not), a brace
 * group or subshell that does nothing else, each ended by end-of-line or a
 * separator so `|| trueish` and `|| exit 1` are not read as swallows.
 */
const ZERO_EXIT_AFTER_OR = new RegExp(
  String.raw`^\s*(?:(["']?)(?:true|:|exit\s+0|\/(?:usr\/)?bin\/true)\1|\{\s*(?:true|:|exit\s+0)\s*;?\s*\}|\(\s*(?:true|:|exit\s+0)\s*\))(?=$|[\s;&|)}])`
)
const FAILS_AFTERWARDS = /\bexit\s+(?!0\b)\S|\bfalse\b|\breturn\b/
const SEMI_TRUE = /(?<!;);\s*true\s*(?=$|[;&|)}])/
const SET_PLUS_E = /(?:^\s*|[;&|({]\s*)set\s+(?:-\S+\s+)*\+[A-Za-z]*e[A-Za-z]*(?=\s|$|;)/
const SHELL_C = /(?:^|[\s;&|(])(?:ba|da|z|k)?sh\s+(?:-[A-Za-z-]+\s+)*-[A-Za-z]*c\s+(?=['"])/g

/**
 * Heredoc bodies blanked — but only for heredocs that really TERMINATE, and only
 * for a `<<` the shell reads as code. The reader's own `withoutHeredocBodies`
 * blanks to the end of the script on an unterminated start, which is the safe
 * direction for `invokes()` (it can only report a wired suite as an orphan) and
 * the unsafe one here: `echo "x<<EOF" >> $GITHUB_OUTPUT` or `$((1<<4))` would
 * hide every later line, and a real `|| true` after it would read clean.
 */
function withoutTerminatedHeredocs(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const code = stripShellComment(lines[i])
    const m = /(?<!<)<<(-?)\s*/.exec(maskQuotedData(code))
    if (!m) continue
    const word = /^([^\s;&|<>()`]+)/.exec(code.slice(m.index + m[0].length))
    if (!word) continue
    const terminator = heredocDelimiter(word[1])
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if ((m[1] === '-' ? lines[j].replace(/^\t+/, '') : lines[j]) === terminator) {
        end = j
        break
      }
    }
    if (end === -1) continue // not a heredoc: keep reading what follows as code
    for (let j = i + 1; j <= end; j++) out.push('')
    i = end
  }
  return out
}

/**
 * Lines the shell reads as ONE command: a trailing backslash, `||`, `&&` or `|`
 * continues onto the next line.
 */
function logicalLines(lines) {
  const out = []
  let acc = ''
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.endsWith('\\')) {
      acc += `${line.slice(0, -1)} `
      continue
    }
    acc += line
    if (/(?:\|\||&&|\|)$/.test(line)) {
      acc += ' '
      continue
    }
    out.push(acc)
    acc = ''
  }
  if (acc !== '') out.push(acc)
  return out
}

/** The literal payloads of `bash -c '...'` / `sh -ec "..."` on a line whose `sh` word is code. */
function shellCPayloads(original, masked) {
  const payloads = []
  for (const m of original.matchAll(SHELL_C)) {
    const lead = /^[\s;&|(]/.test(m[0]) ? 1 : 0
    if (masked[m.index + lead] === ' ') continue // inside quoted data
    const start = m.index + m[0].length
    const q = original[start]
    let end = start + 1
    while (end < original.length && original[end] !== q) end += q === '"' && original[end] === '\\' ? 2 : 1
    if (end >= original.length) continue // unterminated
    payloads.push(original.slice(start + 1, end).replace(/\\(["\\$`])/g, '$1'))
  }
  return payloads
}

function swallowInLine(original) {
  const masked = maskQuotedData(original)
  for (const m of masked.matchAll(/\|\|/g)) {
    const zero = ZERO_EXIT_AFTER_OR.exec(original.slice(m.index + 2))
    if (zero) return squash(original.slice(m.index, m.index + 2 + zero[0].length))
    const afterMasked = masked.slice(m.index + 2)
    if (/^\s*(?:echo|printf)\b/.test(afterMasked) && !FAILS_AFTERWARDS.test(afterMasked)) {
      return squash(`|| ${original.slice(m.index + 2).trim().slice(0, 24)}`)
    }
  }
  const semi = SEMI_TRUE.exec(masked)
  if (semi) return squash(original.slice(semi.index, semi.index + semi[0].length))
  const setE = SET_PLUS_E.exec(masked)
  if (setE) return squash(original.slice(setE.index, setE.index + setE[0].length)).replace(/^[;&|({]\s*/, '')
  for (const payload of shellCPayloads(original, masked)) {
    const inner = swallowedFailure(payload)
    if (inner) return `-c '…${inner}'`
  }
  return null
}

/**
 * The first place a `run:` body swallows a failure — see the header for the
 * spellings, and for the ones this does NOT see — or null. Quoted text, shell
 * comments and terminated heredoc bodies are data, not commands; line
 * continuations are joined so `cmd ||` over `true` on the next line is read as
 * one command; and the word after `||` is read from the ORIGINAL text with only
 * the `||` located in the masked one, so `cmd || "true"` is still a swallow.
 *
 * @param {string} runBody
 * @returns {string|null}
 */
export function swallowedFailure(runBody) {
  for (const line of logicalLines(withoutTerminatedHeredocs(runBody.split('\n')).map(stripShellComment))) {
    const hit = swallowInLine(line)
    if (hit) return hit
  }
  return null
}

/**
 * What is wrong with the `changes` job's own job-level `if:` — or `[]`. The `if:`
 * is the one place a typo skips the producer, and with it every consumer, on
 * every run, so it is read for the only thing it can be checked against without
 * a transcribed value: the workflow's own triggers. Every
 * `github.event_name == '<event>'` it names must be an event the workflow
 * triggers on, and when the workflow triggers on `pull_request` it must let one
 * through (path filters mean nothing off a PR). An `if:` naming no such
 * comparison is reported as unreadable; no `if:` at all is fine.
 *
 * @param {{body: string[]}} producer
 * @param {string} workflowText
 * @returns {string[]}
 */
export function producerIfIssues(producer, workflowText) {
  const expr = jobIf(stripYamlComments(producer.body))
  if (expr === null) return []
  const triggers = workflowTriggers(workflowText)
  const named = [...expr.matchAll(/github\.event_name\s*==\s*'([^']*)'/g)].map((m) => m[1])
  if (named.length === 0) {
    return [`its if: (${expr}) names no github.event_name == '<event>' comparison, so this guard cannot tell which events it lets through — extend producerIfIssues`]
  }
  const issues = []
  for (const e of named) {
    if (!triggers.includes(e)) {
      issues.push(`its if: compares github.event_name to '${e}', which this workflow never triggers on (on: ${triggers.join(', ') || 'unreadable'}) — the job is skipped on every event, and so is every consumer`)
    }
  }
  if (triggers.includes('pull_request') && !named.includes('pull_request')) {
    issues.push(`its if: never lets a pull_request through (it names: ${named.join(', ')}), though path filters only mean anything on a PR — every consumer is skipped on every PR`)
  }
  return issues
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

/**
 * paths-filter's own outputs, beyond the one-per-filter booleans: `changes` (the
 * JSON list of matching filters) always, and `<filter>_files` when the step sets
 * `list-files`. They are the action's, not declared in `filters:`, so they are
 * not reported as "declares no filter" — but they are not filters either, so
 * they never count as mapping one.
 */
function isPathsFilterBuiltin(key, names, step) {
  if (key === 'changes') return true
  const files = /^(.+)_files$/.exec(key)
  const listFiles = stepInput(step, 'list-files')
  return files !== null && names.includes(files[1]) && listFiles !== undefined && listFiles !== 'none'
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
    issues.push(issue('mapping', `${workflow.name} has no '${PRODUCER_JOB}' job — if it was renamed, update PRODUCER_JOB in this file; if it was removed, so were its consumers' gate`))
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
    const builtin = isPathsFilterBuiltin(key, names, stepById.get(id))
    if (!names.includes(key) && !builtin) {
      issues.push(
        issue('mapping', `output '${name}' reads steps.${id}.outputs.${key}, but that paths-filter step declares no filter '${key}' (declared: ${names.join(', ')}; the action's own 'changes' and, with list-files, '<filter>_files' are also accepted) — the output is always empty`)
      )
      continue
    }
    if (!builtin) mapped.add(`${id}.${key}`)
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

  // -- loud: no job on the path may swallow its own failure -------------------
  const swallowUsed = new Set()
  const checkLoud = (job, why) => {
    const jobCoe = jobContinueOnErrorIssue(job.body)
    if (jobCoe) issues.push(issue('loud', `job '${job.id}': ${jobCoe} — ${why}`))
    const defaultShell = jobShell(job.body)
    if (defaultShell !== undefined && defaultShell !== 'bash') {
      issues.push(issue('loud', `job '${job.id}': defaults.run.shell: ${defaultShell} — only the default shell or exactly bash keeps -e; a custom template drops it`))
    }
    job.steps.forEach((step, idx) => {
      const label = stepLabel(step, idx)
      const coe = stepInput(step, 'continue-on-error')
      if (coe !== undefined && coe !== 'false') {
        issues.push(issue('loud', `job '${job.id}', step '${label}': continue-on-error: ${coe} — ${why}`))
      }
      const run = stepRun(step)
      if (run === undefined) return
      const findings = []
      const hit = swallowedFailure(run)
      if (hit) findings.push(`\`${hit}\` swallows the command's failure, so the job reads green over a broken check`)
      const shell = stepShellIssue(step)
      if (shell) findings.push(`${shell} — a shell template without -e lets a failing command pass`)
      if (findings.length === 0) return
      const key = `${job.id}/${label}`
      if (swallowExemptions.has(key)) swallowUsed.add(key)
      else for (const f of findings) issues.push(issue('loud', `job '${job.id}', step '${label}': ${f}`))
    })
  }
  checkLoud(producer, 'a failed filter would leave every output empty and skip every consumer')
  for (const text of producerIfIssues(producer, workflow.text)) issues.push(issue('loud', `job '${PRODUCER_JOB}': ${text}`))

  // -- reference: every job's needs reads, and every job that reads `changes` --
  const consumers = []
  for (const job of workflow.jobs) {
    const direct = directNeeds(job)
    for (const dep of needsReads(job)) {
      if (!direct.includes(dep)) {
        issues.push(
          issue('reference', `job '${job.id}' reads needs.${dep}, but '${dep}' is not in its own needs: (${direct.join(', ') || 'none'}) — a context that does not exist reads as empty, so the job is silently skipped`)
        )
      }
    }
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
    if (!direct.includes(PRODUCER_JOB)) {
      issues.push(
        issue('reference', `job '${job.id}' reads needs.${PRODUCER_JOB}.outputs but does not list '${PRODUCER_JOB}' in its own needs: (${direct.join(', ') || 'none'}) — the needs context holds DIRECT dependencies only, so every reference is empty and the job never runs`)
      )
    }
    checkLoud(job, 'a real failure would not fail the job')
  }
  for (const key of swallowExemptions.keys()) {
    if (!swallowUsed.has(key)) {
      issues.push(issue('loud', `stale SWALLOW_EXEMPTIONS entry '${key}': no step of a consumer or of '${PRODUCER_JOB}' has that key and swallows a failure any more — delete it`))
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
      `expected >= ${MIN_OUTPUTS} '${PRODUCER_JOB}' outputs, derived ${report.outputs.length} — the reader has probably stopped understanding the file (or '${PRODUCER_JOB}' was renamed: update PRODUCER_JOB)`
    )
    assert.ok(
      report.filters.length >= MIN_OUTPUTS,
      `expected >= ${MIN_OUTPUTS} paths-filter filter names, derived ${report.filters.length} — if the action was replaced or forked, update PATHS_FILTER_ACTION ('${PATHS_FILTER_ACTION}'); if '${PRODUCER_JOB}' was renamed, update PRODUCER_JOB`
    )
    assert.ok(
      report.consumers.length >= MIN_CONSUMERS,
      `expected >= ${MIN_CONSUMERS} jobs reading needs.${PRODUCER_JOB}.outputs, derived ${report.consumers.length}: ${report.consumers.map((c) => c.id).join(', ')} — if a consumer was retired on purpose, lower MIN_CONSUMERS in the same change; otherwise the reader has stopped understanding the file`
    )
  })

  it('CONTROL: the line readers agree with js-yaml over the real file (the oracle for a hand-rolled walk)', () => {
    const doc = yaml.load(ci.text)
    assert.ok(doc.jobs?.[PRODUCER_JOB], `js-yaml finds no '${PRODUCER_JOB}' job in ${WORKFLOW} — if it was renamed, update PRODUCER_JOB`)
    const oracleOutputs = Object.entries(doc.jobs[PRODUCER_JOB].outputs ?? {})
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
        JSON.stringify(directNeeds(job)) === JSON.stringify(oracleNeeds),
        `directNeeds disagrees with js-yaml for '${c.id}': ${JSON.stringify(directNeeds(job))} vs ${JSON.stringify(oracleNeeds)}`
      )
    }
  })

  it('every output mapping reads a step output that exists, under its own name, and every filter is mapped', () => {
    assertNone(report, 'mapping')
  })

  it("every job's needs.<id> read names a job in its own needs:, and every reader of needs.changes.outputs names an output that exists and compares it to 'true'", () => {
    assertNone(report, 'reference')
  })

  it('every output is read by some job or is exempt with a reason, and every exemption still matches', () => {
    assertNone(report, 'roster')
  })

  it("neither a consuming job nor the changes job swallows its own failure (continue-on-error, a zero-exit || spelling, set +e, a shell without -e), and the producer's if: is satisfiable", () => {
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
      users.length === 0
        ? `no job uses ${PATHS_FILTER_ACTION}: if the action was replaced or forked, update PATHS_FILTER_ACTION in this file — until then the guard reads nothing`
        : `paths-filter is used by ${JSON.stringify(users)}; this guard covers only ${WORKFLOW}#${PRODUCER_JOB} — extend it (PRODUCER_JOB) to the new job rather than leave its consumers unguarded`
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
    // #8210 review S4 — spellings that used to pass silently.
    "bash -c 'npm run build || true'",
    'sh -c "npm run build || true"',
    "bash -ec 'npm run build || true'",
    "env CI=1 bash -lc 'npm run build ||true'",
    'npm run build; true',
    'npm run build ; true\nnext',
    'npm run build || { true; }',
    'npm run build || { :; }',
    'npm run build || (true)',
    'npm run build || echo ignored',
    'npm run build || printf "%s" x',
    'npm run build ||\n  echo ignored',
    'set +e\nnpm run build',
    'set -e; set +e',
    'set +eu\nnpm run build',
    'a && set +e',
    // an unterminated or over-matched heredoc start must not hide a later swallow
    'echo "x<<EOF" >> "$GITHUB_OUTPUT"\nnpm run build || true',
    'x=$((1<<4))\nnpm run build || true',
    'cat <<EOF\nnever terminated\nnpm run build || true',
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
    "bash -c 'npm run build'",
    "bash -c 'npm run build || exit 1'",
    'echo "bash -c \'x || true\'"',
    'npm run build || echo failed >&2 && exit 1',
    'npm run build || echo "failed" && false',
    'npm run build || { echo failed; exit 1; }',
    'echo "x; true"',
    'for f in a b; do echo $f; done',
    'set -e',
    'set -euo pipefail',
    'cat <<EOF\nset +e\nEOF\nnpm run build',
    'echo "set +e"',
    'while true; do break; done',
    'case $x in a) y;; true) z;; esac',
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

  it('needsReads reads dot and bracketed job ids anywhere in the body, ignoring comments, and dedupes', () => {
    const job = {
      body: [
        '  j:',
        '    runs-on: ${{ fromJSON(needs.runner-target.outputs.runner) }}  # needs.commented.outputs.x',
        "    if: needs.changes.outputs.a == 'true' && needs['other'].result == 'success'",
        '    steps:',
        "      - if: needs.changes.outputs.b == 'true'",
        '        run: echo needs:',
      ],
    }
    assert.deepEqual(needsReads(job), ['runner-target', 'changes', 'other'])
  })

  it('directNeeds reads scalar, flow and block spellings, strips a trailing comment and unquotes', () => {
    const body = (...needs) => ({ body: ['  j:', ...needs, '    runs-on: x'] })
    assert.deepEqual(directNeeds(body('    needs: changes')), ['changes'])
    assert.deepEqual(directNeeds(body('    needs: [runner-target, changes]  # why')), ['runner-target', 'changes'])
    assert.deepEqual(directNeeds(body("    needs: ['runner-target', \"changes\"]")), ['runner-target', 'changes'])
    assert.deepEqual(directNeeds(body('    needs: "changes"')), ['changes'])
    assert.deepEqual(directNeeds(body('    needs:', '      - runner-target', '      - changes')), ['runner-target', 'changes'])
    assert.deepEqual(directNeeds(body()), [])
  })

  const producer = (ifLine) => ({ body: ['  changes:', ...(ifLine === null ? [] : [ifLine]), '    runs-on: x'] })
  const ON = 'on:\n  push:\n  pull_request:\n'
  it('producerIfIssues accepts no if:, and an if: naming events the workflow triggers on and lets a PR through', () => {
    assert.deepEqual(producerIfIssues(producer(null), ON), [])
    assert.deepEqual(producerIfIssues(producer("    if: github.event_name == 'pull_request'"), ON), [])
    assert.deepEqual(producerIfIssues(producer("    if: github.event_name == 'pull_request' || github.event_name == 'push'  # both"), ON), [])
    assert.deepEqual(producerIfIssues(producer("    if: ${{ github.event_name == 'pull_request' }}"), ON), [])
  })

  it('producerIfIssues reports a typo\'d event, a PR that cannot get through, and an if: it cannot read', () => {
    const typo = producerIfIssues(producer("    if: github.event_name == 'pull_requests'"), ON)
    assert.ok(typo.some((t) => /compares github\.event_name to 'pull_requests', which this workflow never triggers on/.test(t)), JSON.stringify(typo))
    assert.ok(typo.some((t) => /never lets a pull_request through/.test(t)), JSON.stringify(typo))
    const pushOnly = producerIfIssues(producer("    if: github.event_name == 'push'"), ON)
    assert.ok(pushOnly.length === 1 && /never lets a pull_request through/.test(pushOnly[0]), JSON.stringify(pushOnly))
    const unreadable = producerIfIssues(producer("    if: github.ref == 'refs/heads/main'"), ON)
    assert.ok(unreadable.length === 1 && /names no github\.event_name/.test(unreadable[0]), JSON.stringify(unreadable))
    // a workflow with no pull_request trigger is not required to let one through
    assert.deepEqual(producerIfIssues(producer("    if: github.event_name == 'push'"), 'on:\n  push:\n'), [])
  })
})

const FIXTURE = [
  'name: fixture',
  'on:',
  '  push:',
  '  pull_request:',
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


  // -- #8210 review: S1 (needs membership), S2 (the producer), S4 (more spellings)
  const JOB_C = [
    '  job-c:',
    '    needs: changes',
    "    if: needs.changes.outputs.alpha == 'true'",
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: node check-c.mjs',
  ].join('\n')
  const withJobC = (t) => `${t}\n${JOB_C}`

  it('S1: a clean SECOND consumer of an output already read by another job reports nothing', () => {
    assert.deepEqual(run(withJobC(FIXTURE)).issues, [])
  })

  it('S1: a needs.<typo> on one of two consumers of the same output is still reported (the roster rule cannot see it)', () => {
    const text = swap(
      withJobC(FIXTURE),
      "    if: needs.changes.outputs.alpha == 'true'\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@abc",
      "    if: needs.chnages.outputs.alpha == 'true'\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@abc"
    )
    const r = run(text)
    assertReports(r, 'reference', /job 'job-a' reads needs\.chnages, but 'chnages' is not in its own needs: \(changes\)/, 'shared-output typo')
    assert.deepEqual(textsOf(r, 'roster'), [], 'the roster rule is blind here — only the needs-membership rule can catch it')
  })

  it('S1: any job reading needs.<id> outside its own needs: is reported, consumer or not, dot or bracket form', () => {
    const dot = run(swap(FIXTURE, '  other:\n    runs-on: ubuntu-24.04\n', '  other:\n    runs-on: ${{ needs.zz.outputs.x }}\n'))
    assertReports(dot, 'reference', /job 'other' reads needs\.zz, but 'zz' is not in its own needs: \(none\)/, 'dot')
    const bracket = run(swap(FIXTURE, '  other:\n    runs-on: ubuntu-24.04\n', "  other:\n    runs-on: ${{ needs['zz'].outputs.x }}\n"))
    assertReports(bracket, 'reference', /job 'other' reads needs\.zz/, 'bracket')
  })

  it('S1: a trailing comment, quoted entries, or a block list on needs: are the same dependency and report nothing', () => {
    assert.deepEqual(run(swap(FIXTURE, 'needs: [other, changes]', 'needs: [other, changes]  # why')).issues, [])
    assert.deepEqual(run(swap(FIXTURE, 'needs: [other, changes]', "needs: ['other', \"changes\"]")).issues, [])
    assert.deepEqual(run(swap(FIXTURE, 'needs: [other, changes]', 'needs:\n      - other\n      - changes')).issues, [])
    assert.deepEqual(run(swap(FIXTURE, '  job-a:\n    needs: changes\n', "  job-a:\n    needs: 'changes'  # direct\n")).issues, [])
  })

  it('S2: continue-on-error on the changes job, or on its paths-filter step, is reported', () => {
    assertReports(
      run(swap(FIXTURE, '  changes:\n    needs: other\n', '  changes:\n    needs: other\n    continue-on-error: true\n')),
      'loud', /job 'changes': continue-on-error: true at job level — a failed filter would leave every output empty/, 'producer job'
    )
    assertReports(
      run(swap(FIXTURE, '      - id: filter\n        uses: dorny/paths-filter@abc\n', '      - id: filter\n        continue-on-error: true\n        uses: dorny/paths-filter@abc\n')),
      'loud', /job 'changes', step 'dorny\/paths-filter@abc': continue-on-error: true — a failed filter/, 'producer step'
    )
    assert.deepEqual(textsOf(run(swap(FIXTURE, '      - id: filter\n', '      - id: filter\n        continue-on-error: false\n')), 'loud'), [])
  })

  it('S2: a run step of the changes job is held to the same swallow rule as a consumer', () => {
    assertReports(
      run(swap(FIXTURE, '      - uses: actions/checkout@abc\n      - id: filter', '      - uses: actions/checkout@abc\n      - name: Warm\n        run: npm ci || true\n      - id: filter')),
      'loud', /job 'changes', step 'Warm': `\|\| true` swallows/, 'producer run step'
    )
  })

  it("S2: the changes job's own if: — typo'd event, push-only, unreadable, and the real one", () => {
    const withIf = (expr) => swap(FIXTURE, '  changes:\n    needs: other\n', `  changes:\n    needs: other\n    if: ${expr}\n`)
    assert.deepEqual(textsOf(run(withIf("github.event_name == 'pull_request'")), 'loud'), [])
    assertReports(run(withIf("github.event_name == 'pull_requests'")), 'loud', /job 'changes': its if: compares github\.event_name to 'pull_requests', which this workflow never triggers on/, 'typo')
    assertReports(run(withIf("github.event_name == 'push'")), 'loud', /job 'changes': its if: never lets a pull_request through/, 'push only')
    assertReports(run(withIf("github.ref == 'refs/heads/main'")), 'loud', /job 'changes': its if: .* names no github\.event_name/, 'unreadable')
  })

  it('S4: a custom shell template (no -e) on a step, or sh as the job default, is reported; bash is not', () => {
    const step = (shell) => swap(FIXTURE, '      - name: Check a\n        run: node check-a.mjs', `      - name: Check a\n        shell: ${shell}\n        run: node check-a.mjs`)
    assertReports(run(step('bash {0}')), 'loud', /job 'job-a', step 'Check a': shell: bash \{0\}/, 'bash {0}')
    assert.deepEqual(textsOf(run(step('bash')), 'loud'), [])
    assertReports(
      run(swap(FIXTURE, "    if: needs.changes.outputs.alpha == 'true'\n", "    if: needs.changes.outputs.alpha == 'true'\n    defaults:\n      run:\n        shell: sh\n")),
      'loud', /job 'job-a': defaults\.run\.shell: sh/, 'defaults'
    )
    const exempt = { unconsumedExemptions: new Map(), swallowExemptions: new Map([['job-a/Check a', 'why']]) }
    assert.deepEqual(textsOf(run(step('bash {0}'), exempt), 'loud'), [])
  })

  it("S4: the cheap swallow spellings, on a consumer's own step", () => {
    const spellings = [
      ["bash -c 'node check-a.mjs || true'", /-c '…\|\| true'/],
      ['sh -c "node check-a.mjs || true"', /-c '…\|\| true'/],
      ['node check-a.mjs; true', /`; true` swallows/],
      ['node check-a.mjs || { true; }', /`\|\| \{ true; \}` swallows/],
      ['node check-a.mjs || echo ignored', /`\|\| echo ignored` swallows/],
      ['set +e; node check-a.mjs', /`set \+e` swallows/],
    ]
    for (const [cmd, re] of spellings) {
      assertReports(run(swap(FIXTURE, 'run: node check-a.mjs', `run: ${cmd}`)), 'loud', re, cmd)
    }
  })

  it("paths-filter's own outputs are not 'declares no filter': changes always, <filter>_files only with list-files", () => {
    const withOut = (extra) => swap(FIXTURE, '      beta: ${{', '      ' + extra + '\n      beta: ${{')
    const withList = (t) => swap(t, '        uses: dorny/paths-filter@abc\n', '        uses: dorny/paths-filter@abc\n        list-files: json\n')
    assert.deepEqual(textsOf(run(withOut('changes: ${{ steps.filter.outputs.changes }}')), 'mapping'), [])
    assert.deepEqual(textsOf(run(withList(withOut('alpha_files: ${{ steps.filter.outputs.alpha_files }}'))), 'mapping'), [])
    // without list-files the action emits no such output, so it is still a typo
    assertReports(run(withOut('alpha_files: ${{ steps.filter.outputs.alpha_files }}')), 'mapping', /declares no filter 'alpha_files'/, 'no list-files')
    // and a built-in never counts as mapping a filter, nor escapes the roster rule
    assertReports(run(withList(withOut('alpha_files: ${{ steps.filter.outputs.alpha_files }}'))), 'roster', /output 'alpha_files' is declared and no job reads it/, 'unread built-in')
    // a built-in of a filter that is not declared is still a typo
    assertReports(run(withList(withOut('zz_files: ${{ steps.filter.outputs.zz_files }}'))), 'mapping', /declares no filter 'zz_files'/, 'built-in of nothing')
  })

  it('a missing producer names the constant to edit', () => {
    assertReports(run(swap(FIXTURE, '  changes:\n', '  changez:\n')), 'mapping', /has no 'changes' job — if it was renamed, update PRODUCER_JOB/, 'message')
  })

  it('mapping: a workflow that is not valid YAML is reported as such, and the line-level rules still run', () => {
    // `|| :` closing a PLAIN scalar is a real way to break the document: the
    // trailing colon reads as a mapping key. GitHub would reject the file.
    const r = run(swap(FIXTURE, 'run: node check-a.mjs', 'run: node check-a.mjs || :'))
    assertReports(r, 'mapping', /is not valid YAML \(js-yaml:/, 'invalid yaml')
    assertReports(r, 'loud', /job 'job-a', step 'Check a': `\|\| :` swallows/, 'line rules still run')
    assert.ok(!textsOf(r, 'mapping').some((t) => /not an inline mapping/.test(t)), 'the unreadable-filters noise must not repeat the YAML finding')
  })

})

// ---- the same defects, injected into the REAL ci.yml, on every consumer -----

/**
 * The mutants from #8191's review (and #8210's), applied to in-memory COPIES of
 * the real ci.yml and aimed at every job and output the rule DISCOVERED — not at
 * three names written here — so a consumer added tomorrow is mutation-proven the
 * day it lands. The file on disk is never touched.
 *
 * Every edit asserts it changed something, and every suite starts from a CONTROL
 * that the unmutated copy is clean, so a mutant that lands nowhere cannot read as
 * a pass. The suite runs once per LAYOUT: the same file rewritten in a spelling
 * GitHub treats identically (a `working-directory:` after the `run:`, quoted
 * mappings, no spaces around `==`, a comment, quotes or a block list on
 * `needs:`, a second reader of an output). The rule must stay quiet on each
 * layout and every mutant must still land and go red on it — which is what keeps
 * a mutant's ANCHOR from being the thing that fails (#8210 review S3: an anchor
 * that assumed one layout turned valid edits red with a message that blamed the
 * rule).
 */

const ANCHOR = 'mutation anchor assumption (not a guard defect)'
const indentOf = (l) => /^( *)/.exec(l)[1].length
const red = (mutant, kind, re, what) => assertReports(pathsFilterWiring(asWorkflow(mutant)), kind, re, what)

/** Edit one job's block of `text` in place on its lines; asserts the edit changed something. */
function editJob(text, id, fn) {
  const lines = text.split('\n')
  const job = parseJobs(text, WORKFLOW).find((j) => j.id === id)
  assert.ok(job, `${ANCHOR}: no job '${id}' in ${WORKFLOW}`)
  const start = job.line - 1
  const end = start + job.body.length
  const find = (pred, what) => {
    const i = lines.findIndex((l, n) => n >= start && n < end && !/^\s*#/.test(l) && pred(l))
    assert.ok(i !== -1, `${ANCHOR}: not found in '${id}': ${what}`)
    return i
  }
  fn({ lines, start, end, job, find })
  const out = lines.join('\n')
  assert.ok(out !== text, `${ANCHOR}: the edit on '${id}' changed nothing`)
  return out
}

/** The absolute [from, to) line span of each step of a job. */
function stepSpans(job, start) {
  const steps = parseSteps(job.body)
  assert.ok(steps.length > 0, `${ANCHOR}: job '${job.id}' has no steps`)
  const stepsAt = job.body.findIndex((l) => /^\s*steps:/.test(l))
  let at = job.body.indexOf(steps[0][0], stepsAt + 1)
  return steps.map((s) => {
    const span = { from: start + at, to: start + at + s.length, step: s }
    at += s.length
    return span
  })
}

/**
 * Where a step's `run:` scalar lives: its key line, its last line (the key line
 * for a single-line scalar, the last non-blank, non-comment line deeper than the
 * key for a block scalar), and its first body line. NOT the last line of the
 * step span, which is wherever the NEXT key happens to be (#8210 review S3).
 */
function runScalar(lines, span) {
  const keyIndent = indentOf(lines[span.from]) + 2
  let key = -1
  for (let i = span.from; i < span.to; i++) {
    const l = i === span.from ? lines[i].replace(/^(\s*)-\s/, (_, sp) => `${sp}  `) : lines[i]
    if (new RegExp(`^ {${keyIndent}}run:`).test(l)) {
      key = i
      break
    }
  }
  assert.ok(key !== -1, `${ANCHOR}: no run: key in the step at line ${span.from + 1}`)
  const head = lines[key].replace(/^\s*(?:-\s+)?run:\s*/, '').replace(/\s+#.*$/, '').trim()
  const block = head === '' || /^[|>][-+0-9]*$/.test(head)
  let first = -1
  let last = key
  if (block) {
    for (let i = key + 1; i < span.to; i++) {
      if (lines[i].trim() === '') continue
      if (indentOf(lines[i]) <= keyIndent) break
      if (first === -1) first = i
      if (!/^\s*#/.test(lines[i])) last = i
    }
  }
  return { key, last, first, block, keyIndent }
}

const insertAfterRun = (lines, span, text) => {
  const { last, keyIndent } = runScalar(lines, span)
  lines.splice(last + 1, 0, `${' '.repeat(keyIndent)}${text}`)
}

function appendToRun(lines, span, suffix) {
  const { last, block } = runScalar(lines, span)
  const quoted = !block && /^(\s*(?:-\s+)?run:\s*)(['"])(.*)\2\s*$/.exec(lines[last])
  if (quoted) lines[last] = `${quoted[1]}${quoted[2]}${quoted[3]}${suffix}${quoted[2]}`
  else lines[last] = lines[last].replace(/(\s+#.*)?$/, (_, comment) => suffix + (comment ?? ''))
}

function wrapRunInShellC(lines, span) {
  const { key, last, block } = runScalar(lines, span)
  if (!block) {
    const m = /^(\s*(?:-\s+)?run:\s*)(.*?)\s*$/.exec(lines[key])
    assert.ok(!m[2].includes("'"), `${ANCHOR}: the run value contains a single quote`)
    lines[key] = `${m[1]}bash -c '${m[2]} || true'`
  } else {
    const trimmed = lines[last].trim()
    assert.ok(!trimmed.includes("'"), `${ANCHOR}: the run line contains a single quote`)
    lines[last] = `${' '.repeat(indentOf(lines[last]))}bash -c '${trimmed} || true'`
  }
}

function prependSetPlusE(lines, span) {
  const { key, first, block } = runScalar(lines, span)
  if (!block) {
    const m = /^(\s*(?:-\s+)?run:\s*)(.*)$/.exec(lines[key])
    lines[key] = `${m[1]}set +e; ${m[2]}`
  } else {
    lines.splice(first, 0, `${' '.repeat(indentOf(lines[first]))}set +e`)
  }
}

/** Every spelling the swallow rule claims to see, as a mutation of a step's run scalar. */
const RUN_SPELLINGS = [
  ['|| true', /`\|\| true` swallows/, (lines, span) => appendToRun(lines, span, ' || true')],
  ['|| :', /`\|\| :` swallows/, (lines, span) => appendToRun(lines, span, ' || :')],
  ['; true', /`; true` swallows/, (lines, span) => appendToRun(lines, span, ' ; true')],
  ['|| { true; }', /`\|\| \{ true; \}` swallows/, (lines, span) => appendToRun(lines, span, ' || { true; }')],
  ['|| echo ignored', /`\|\| echo ignored` swallows/, (lines, span) => appendToRun(lines, span, ' || echo ignored')],
  ["bash -c '… || true'", /-c '…\|\| true'/, wrapRunInShellC],
  ['set +e', /`set \+e` swallows/, prependSetPlusE],
  ['shell: bash {0}', /shell: bash \{0\}/, (lines, span) => insertAfterRun(lines, span, 'shell: bash {0}')],
]

/** A job's `needs:` as {i, len, items}: scalar, flow list or block list, comment stripped, unquoted. */
function readNeeds(lines, start, end) {
  const i = lines.findIndex((l, n) => n >= start && n < end && /^ {4}needs:/.test(l))
  assert.ok(i !== -1, `${ANCHOR}: no needs: line`)
  const raw = lines[i].replace(/^ {4}needs:\s*/, '').replace(/\s+#.*$/, '').trim()
  if (raw !== '') {
    return { i, len: 1, items: raw.replace(/^\[|\]$/g, '').split(',').map((x) => unquote(x.trim())).filter(Boolean) }
  }
  const items = []
  let j = i + 1
  for (; j < end; j++) {
    const m = /^ {6,}-\s*(\S+)/.exec(lines[j])
    if (!m) break
    items.push(unquote(m[1]))
  }
  return { i, len: j - i, items }
}

const mappingLine = (out) => new RegExp(`^ {6}${out}:\\s*['"]?\\$\\{\\{`)

/** Apply `fn(lines, span)` to every run step of every consumer `base` discovered. */
function onEveryConsumerRunStep(text, base, fn) {
  let out = text
  for (const c of base.consumers) {
    out = editJob(out, c.id, ({ lines, start, job }) => {
      for (const span of stepSpans(job, start).reverse()) if (stepRun(span.step) !== undefined) fn(lines, span)
    })
  }
  return out
}

const onEveryConsumer = (text, base, fn) =>
  base.consumers.reduce((out, c) => editJob(out, c.id, (ctx) => fn(ctx, c)), text)

/** Valid rewrites of the real file: the rule must stay quiet on each, and every mutant must still land. */
const LAYOUTS = [
  { name: 'as committed', xf: (t) => t },
  {
    name: 'run: followed by working-directory:',
    xf: (t, base) => onEveryConsumerRunStep(t, base, (lines, span) => insertAfterRun(lines, span, 'working-directory: .')),
  },
  {
    name: 'quoted output mappings',
    xf: (t, base) =>
      editJob(t, PRODUCER_JOB, ({ lines, find }) => {
        for (const o of base.outputs) {
          const i = find((l) => mappingLine(o.name).test(l), `the ${o.name} mapping`)
          lines[i] = lines[i].replace(/^(\s*[\w-]+:\s*)(\S.*?)\s*$/, (_, a, b) => `${a}'${b}'`)
        }
      }),
  },
  {
    name: "no spaces around == 'true'",
    xf: (t, base) =>
      onEveryConsumer(t, base, ({ lines, start, end }) => {
        for (let i = start; i < end; i++) {
          if (!/^\s*#/.test(lines[i]) && /needs\.changes\.outputs\.[\w-]+\s*==\s*'true'/.test(lines[i])) {
            lines[i] = lines[i].replace(/\s*==\s*'true'/, "=='true'")
          }
        }
      }),
  },
  {
    name: 'needs: with a trailing comment',
    xf: (t, base) => onEveryConsumer(t, base, ({ lines, start, end }) => {
      const n = readNeeds(lines, start, end)
      lines[n.i] += '  # why'
    }),
  },
  {
    name: 'needs: entries quoted',
    xf: (t, base) => onEveryConsumer(t, base, ({ lines, start, end }) => {
      const n = readNeeds(lines, start, end)
      lines.splice(n.i, n.len, n.items.length === 1 ? `    needs: '${n.items[0]}'` : `    needs: [${n.items.map((x) => `'${x}'`).join(', ')}]`)
    }),
  },
  {
    name: 'needs: as a block list',
    xf: (t, base) => onEveryConsumer(t, base, ({ lines, start, end }) => {
      const n = readNeeds(lines, start, end)
      lines.splice(n.i, n.len, '    needs:', ...n.items.map((x) => `      - ${x}`))
    }),
  },
  {
    name: 'a second reader of every consumed output',
    xf: (t, base) => onEveryConsumer(t, base, ({ lines, start, end }, c) => {
      const clone = lines.slice(start, end)
      clone[0] = clone[0].replace(`  ${c.id}:`, `  zz-second-${c.id}:`)
      assert.ok(clone[0] !== lines[start], `${ANCHOR}: could not rename the cloned job header`)
      lines.splice(end, 0, ...clone)
    }),
  },
]

for (const layout of LAYOUTS) {
  describe(`the rule turns RED on each wiring mutant, for every job and output ci.yml has (#8193) [${layout.name}]`, () => {
    let text
    let report

    before(async () => {
      const ci = (await readWorkflows()).find((w) => w.name === WORKFLOW)
      assert.ok(ci, `expected ${WORKFLOW} among the scanned workflows`)
      const base = pathsFilterWiring(ci)
      text = layout.xf(ci.text, base)
      assert.ok(layout.name === 'as committed' || text !== ci.text, `${ANCHOR}: layout '${layout.name}' changed nothing`)
      report = pathsFilterWiring(asWorkflow(text))
    })

    const consumedOutputs = () => [...new Set(report.consumers.flatMap((c) => c.outputs))]

    it('CONTROL: this layout is a valid edit — it reports nothing, so every RED below is the mutant', () => {
      assert.ok(report.issues.length === 0, `a valid layout false-alarms:\n  ${report.issues.map((i) => i.text).join('\n  ')}`)
      assert.ok(report.consumers.length >= MIN_CONSUMERS, `derived ${report.consumers.length} consumers on this layout`)
    })

    it("M18: a typo in each consumer's if:", () => {
      for (const c of report.consumers) {
        const out = c.outputs[0]
        const mutant = editJob(text, c.id, ({ lines, find }) => {
          const i = find((l) => l.includes(`needs.changes.outputs.${out}`), 'the if: reading the output')
          lines[i] = lines[i].replace(`needs.changes.outputs.${out}`, `needs.changes.outputs.${out}-zz-mutant`)
        })
        red(mutant, 'reference', new RegExp(`job '${c.id}' reads needs\\.changes\\.outputs\\.${out}-zz-mutant, but 'changes' declares no such output`), `M18 on ${c.id}`)
      }
    })

    it("M18 (literal): a typo in the 'true' each consumer compares against", () => {
      for (const c of report.consumers) {
        const mutant = editJob(text, c.id, ({ lines, find }) => {
          const i = find((l) => /needs\.changes\.outputs\.[\w-]+\s*==\s*'true'/.test(l), "the == 'true' comparison")
          lines[i] = lines[i].replace(/==(\s*)'true'/, "==$1'ture'")
        })
        red(mutant, 'reference', new RegExp(`job '${c.id}'.*without comparing it to 'true'`), `literal on ${c.id}`)
      }
    })

    it('M18 (job id): a typo in needs.changes is reported by the needs-membership rule, with or without another reader of the output', () => {
      for (const c of report.consumers) {
        const out = c.outputs[0]
        const mutant = editJob(text, c.id, ({ lines, find }) => {
          const i = find((l) => l.includes(`needs.changes.outputs.${out}`), 'the if: reading the output')
          lines[i] = lines[i].replace('needs.changes.outputs', 'needs.chnages.outputs')
        })
        red(mutant, 'reference', new RegExp(`job '${c.id}' reads needs\\.chnages, but 'chnages' is not in its own needs`), `needs.chnages on ${c.id}`)
        if (report.consumers.some((o) => o.id !== c.id && o.outputs.includes(out))) {
          // Another job still reads this output, so the roster rule is blind to the typo:
          // the needs-membership rule is the only thing that can have caught it.
          assert.deepEqual(textsOf(pathsFilterWiring(asWorkflow(mutant)), 'roster'), [], `roster should be blind on ${c.id}`)
        }
      }
    })

    it("M19: each consumed output's mapping deleted", () => {
      for (const out of consumedOutputs()) {
        const mutant = editJob(text, PRODUCER_JOB, ({ lines, find }) => {
          lines.splice(find((l) => mappingLine(out).test(l), `the ${out} mapping`), 1)
        })
        const consumer = report.consumers.find((c) => c.outputs.includes(out))
        red(mutant, 'reference', new RegExp(`job '${consumer.id}' reads needs\\.changes\\.outputs\\.${out}, but 'changes' declares no such output`), `M19 on ${out}`)
      }
    })

    it("M25: each consumed output's mapping reading a misspelled step output", () => {
      for (const out of consumedOutputs()) {
        const mutant = editJob(text, PRODUCER_JOB, ({ lines, find }) => {
          const i = find((l) => mappingLine(out).test(l), `the ${out} mapping`)
          lines[i] = lines[i].replace(/(outputs\.[\w-]+)(\s*\}\})/, '$1-zz-mutant$2')
        })
        red(mutant, 'mapping', new RegExp(`output '${out}' reads steps\\.[\\w-]+\\.outputs\\.${out}-zz-mutant, but that paths-filter step declares no filter`), `M25 on ${out}`)
      }
    })

    it('M25 (crossed): each consumed output reading ANOTHER real filter', () => {
      const names = report.outputs.map((o) => o.name)
      for (const out of consumedOutputs()) {
        const other = names.find((n) => n !== out)
        const mutant = editJob(text, PRODUCER_JOB, ({ lines, find }) => {
          const i = find((l) => mappingLine(out).test(l), `the ${out} mapping`)
          lines[i] = lines[i].replace(/outputs\.[\w-]+/, `outputs.${other}`)
        })
        red(mutant, 'mapping', new RegExp(`output '${out}' is mapped from filter '${other}'`), `crossed ${out}->${other}`)
      }
    })

    it('a filter deleted from the paths-filter filters: block, for each consumed output', () => {
      for (const out of consumedOutputs()) {
        const mutant = editJob(text, PRODUCER_JOB, ({ lines, find }) => {
          const at = find((l) => /^\s*filters:\s*\|/.test(l), 'the filters: block scalar')
          const indent = indentOf(lines.slice(at + 1).find((l) => l.trim() !== ''))
          const i = lines.findIndex((l, n) => n > at && new RegExp(`^ {${indent}}${out}:\\s*$`).test(l))
          assert.ok(i !== -1, `${ANCHOR}: no '${out}:' filter key at indent ${indent}`)
          // Delete the whole entry (key + its list items and comments), not just
          // the key line: a bare key delete only parses when ANOTHER filter
          // precedes it to absorb the orphaned items, which stopped being true
          // for the first filter once `platform` was removed (#7642).
          let end = i + 1
          while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > indent)) end++
          lines.splice(i, end - i)
        })
        red(mutant, 'mapping', new RegExp(`output '${out}' reads steps\\.[\\w-]+\\.outputs\\.${out}, but that paths-filter step declares no filter '${out}'`), `filter ${out} deleted`)
      }
    })

    it('a new output nothing consumes', () => {
      const mutant = editJob(text, PRODUCER_JOB, ({ lines, find }) => {
        const stepId = MAPPING.exec(report.outputs[0].value)[1]
        lines.splice(find((l) => /^ {4}outputs:\s*$/.test(l), 'outputs:') + 1, 0, `      zz-mutant: \${{ steps.${stepId}.outputs.zz-mutant }}`)
        const at = find((l) => /^\s*filters:\s*\|/.test(l), 'the filters: block scalar')
        const indent = ' '.repeat(indentOf(lines[at + 1]))
        lines.splice(at + 1, 0, `${indent}zz-mutant:`, `${indent}  - 'zz-mutant-not-a-path'`)
      })
      red(mutant, 'roster', /'changes' output 'zz-mutant' is declared and no job reads it/, 'unconsumed output')
    })

    it("a consumer that loses 'changes' from its own needs", () => {
      for (const c of report.consumers) {
        const mutant = editJob(text, c.id, ({ lines, start, end }) => {
          const n = readNeeds(lines, start, end)
          assert.ok(n.items.includes('changes'), `${ANCHOR}: needs ${JSON.stringify(n.items)} lacks changes`)
          const rest = n.items.filter((x) => x !== 'changes')
          lines.splice(n.i, n.len, rest.length > 0 ? `    needs: [${rest.join(', ')}]` : '    needs: runner-target')
        })
        red(mutant, 'reference', new RegExp(`job '${c.id}'.*does not list 'changes' in its own needs`), `needs on ${c.id}`)
      }
    })

    it('M20 and its spellings: every way the rule claims to see a swallow, on every run step of each consumer', () => {
      let proved = 0
      for (const c of report.consumers) {
        const job = parseJobs(text, WORKFLOW).find((j) => j.id === c.id)
        stepSpans(job, job.line - 1).forEach((span, idx) => {
          if (stepRun(span.step) === undefined) return
          for (const [spelling, re, mutate] of RUN_SPELLINGS) {
            const mutant = editJob(text, c.id, ({ lines }) => mutate(lines, span))
            red(mutant, 'loud', re, `${spelling} on ${c.id} step ${idx + 1}`)
            proved++
          }
        })
      }
      assert.ok(proved >= MIN_CONSUMERS * RUN_SPELLINGS.length, `proved ${proved} swallow placements, expected at least ${MIN_CONSUMERS * RUN_SPELLINGS.length}`)
    })

    it('M21: continue-on-error added to every step, and to the job itself, of each consumer', () => {
      let proved = 0
      for (const c of report.consumers) {
        const job = parseJobs(text, WORKFLOW).find((j) => j.id === c.id)
        stepSpans(job, job.line - 1).forEach((span, idx) => {
          const mutant = editJob(text, c.id, ({ lines }) => {
            lines.splice(span.from + 1, 0, `${' '.repeat(indentOf(lines[span.from]) + 2)}continue-on-error: true`)
          })
          red(mutant, 'loud', new RegExp(`job '${c.id}', step '.*': continue-on-error: true`), `M21 on ${c.id} step ${idx + 1}`)
          proved++
        })
        const jobMutant = editJob(text, c.id, ({ lines, start }) => {
          lines.splice(start + 1, 0, '    continue-on-error: true')
        })
        red(jobMutant, 'loud', new RegExp(`job '${c.id}': continue-on-error: true at job level`), `M21 job-level on ${c.id}`)
        proved++
      }
      assert.ok(proved >= MIN_CONSUMERS, `proved M21 on ${proved} placements, expected at least ${MIN_CONSUMERS}`)
    })

    it("S2: continue-on-error on every step of the changes job, and on the job itself — a failed filter skips every consumer", () => {
      const producer = parseJobs(text, WORKFLOW).find((j) => j.id === PRODUCER_JOB)
      const spans = stepSpans(producer, producer.line - 1)
      assert.ok(spans.some((s) => (stepInput(s.step, 'uses') ?? '').startsWith(PATHS_FILTER_ACTION)), `${ANCHOR}: no paths-filter step in the producer`)
      spans.forEach((span, idx) => {
        const mutant = editJob(text, PRODUCER_JOB, ({ lines }) => {
          lines.splice(span.from + 1, 0, `${' '.repeat(indentOf(lines[span.from]) + 2)}continue-on-error: true`)
        })
        red(mutant, 'loud', new RegExp(`job '${PRODUCER_JOB}', step '.*': continue-on-error: true — a failed filter would leave every output empty`), `producer step ${idx + 1}`)
      })
      const jobMutant = editJob(text, PRODUCER_JOB, ({ lines, start }) => {
        lines.splice(start + 1, 0, '    continue-on-error: true')
      })
      red(jobMutant, 'loud', new RegExp(`job '${PRODUCER_JOB}': continue-on-error: true at job level — a failed filter`), 'producer job')
    })

    it("S2: the changes job's own if: typo'd, or narrowed to an event that is not a pull_request", () => {
      const swapEvent = (to) =>
        editJob(text, PRODUCER_JOB, ({ lines, find }) => {
          const i = find((l) => /^ {4}if:/.test(l) && l.includes("'pull_request'"), "the producer's if: naming pull_request")
          lines[i] = lines[i].replace("'pull_request'", `'${to}'`)
        })
      red(swapEvent('pull_requests'), 'loud', /job 'changes': its if: compares github\.event_name to 'pull_requests', which this workflow never triggers on/, "typo'd event")
      red(swapEvent('push'), 'loud', /job 'changes': its if: never lets a pull_request through/, 'push only')
    })
  })
}
