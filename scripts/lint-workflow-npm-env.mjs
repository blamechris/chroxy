#!/usr/bin/env node
/**
 * lint-workflow-npm-env.mjs — every workflow that installs npm dependencies
 * must disable npm's implicit audit + funding calls at the WORKFLOW `env:`
 * level (#7616).
 *
 * THE CLASS
 * ---------
 * Every `npm ci` and `npm install` makes an unrequested call to
 * registry.npmjs.org's bulk-advisory endpoint
 * (`/-/npm/v1/security/advisories/bulk`) and a second one for funding metadata.
 * On 2026-09-03/04 the advisory endpoint stalled 17-48s per call — measured
 * from the Mac host and from inside a runner container — and a cold `npm ci`
 * went from 27s to 2m15s. `Server Lint` and `Design Tokens Tests`, both on
 * `timeout-minutes: 5`, failed four consecutive times on #7608. No job in this
 * repo runs `npm audit` on purpose, so a registry-side slowdown of a call
 * nobody asked for was able to fail a lint job for free.
 *
 * WHY A LINT AND NOT 22 FLAGS
 * ---------------------------
 * The ask on #7616 offered two shapes: `--no-audit --no-fund` on each of the
 * 22 executable install sites, or the two environment variables once per
 * workflow. The flags cover exactly the sites that exist when they are typed;
 * the 23rd site, added six months later by someone who has never read #7616,
 * is uncovered and nothing says so. That is the FIRST cause in
 * docs/false-safety-guards.md — a hardcoded roster beside a set that grows —
 * and this repo has walked past a roster line eight times (see the
 * adjacent-field wire-cap pattern). The `env:` block covers a whole file
 * including everything added to it later, and this lint covers the file that
 * gets added later.
 *
 * WHAT THE CODE ACTUALLY CHECKS — no more than this
 * -------------------------------------------------
 * For every file in .github/workflows/:
 *
 *   1. Does it contain an executable npm INSTALL invocation? Lines whose first
 *      non-space character is `#` are dropped first: such a line is a comment
 *      in BOTH grammars in play here (a YAML comment outside a block scalar, a
 *      shell comment inside one), so dropping it is correct either way and
 *      needs no YAML parsing to decide which it is.
 *   2. If so, does the file set BOTH `NPM_CONFIG_AUDIT` and `NPM_CONFIG_FUND`
 *      to the quoted string "false", in an `env:` mapping at COLUMN 0 — the
 *      workflow level, not a job's and not a step's?
 *   3. And is either key set to anything OTHER than "false" further down the
 *      file? GitHub resolves step env over job env over workflow env, so the
 *      block in (2) is a DEFAULT, not a guarantee: one job re-declaring
 *      `NPM_CONFIG_AUDIT: "true"` audits anyway while (2) still reads clean.
 *      A job- or step-level block is therefore never ACCEPTED in place of the
 *      workflow-level one — it does not cover jobs added later — but it is
 *      rejected when it CONTRADICTS it.
 *
 * The detector is deliberately OVER-inclusive, and that direction is the safe
 * one. `echo "::error::... npm ci cannot run ..."` is not an install, but it
 * makes its workflow look like one; the only consequence is that the file is
 * required to carry two environment variables that cost it nothing. A detector
 * that were under-inclusive would let a real install site through silently,
 * which is the failure this file exists to prevent.
 *
 * It does NOT verify that npm honours the variables — that is a property of
 * npm, not of this repo, and it is pinned by a live positive-and-negative
 * control in scripts/__tests__/lint-workflow-npm-env.test.mjs, which runs the
 * real `npm config get` on the real CI node. It does NOT read the workflows a
 * COMPOSITE ACTION or a reusable workflow brings with it; it does not have to
 * for the composite case, because workflow-level env is exported into the job's
 * process environment and a composite action's `run` steps inherit it —
 * measured on this repo's own `Repo Relay` job, where the action's internal
 * `npm ci --omit=dev` went from `added 66 packages, and audited 67 packages in
 * 4s` (run 33951308582) to `added 66 packages in 1s` (run 33952673042) with no
 * change inside the action. A reusable workflow would NOT inherit it, and this
 * repo calls none — `grep -rn 'uses: \./' .github/workflows/` is empty.
 *
 * WHY QUOTED "false" AND NOT BARE `false`
 * ---------------------------------------
 * An environment variable is always a string. `NPM_CONFIG_AUDIT=false npm
 * config get audit` printing `false` against a `true` baseline is the exact
 * behaviour that was measured, and `"false"` is the value that measurement
 * used. Bare `false` is a YAML boolean that GitHub converts on its way to the
 * process environment; that conversion very probably yields the same string,
 * but "very probably" is not what a guard should rest on and nothing here has
 * measured it. Requiring the form that was proven keeps the code's claim and
 * the comment's claim identical.
 *
 * FAILING CLOSED
 * --------------
 * "Cannot check" must never be reported as "nothing to check" — the second
 * cause in docs/false-safety-guards.md. A missing workflow directory, an
 * enumeration that returns implausibly few workflows, and a site detector that
 * finds implausibly few installs across the whole tree each exit 2, which is a
 * distinct and loud outcome from both 0 and 1. The two floors are LOOSE on
 * purpose: they catch an enumeration that has stopped working, not today's
 * file count. A number that tracked today's count would be the first cause
 * again, one directory over.
 *
 * Exit codes:  0 clean · 1 a workflow installs without the env block · 2 cannot check
 *
 * Run from the repo root:
 *   node scripts/lint-workflow-npm-env.mjs
 *   node scripts/lint-workflow-npm-env.mjs --dir <path>   # used by the tests
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isEntryPoint } from './lib/is-entry-point.mjs'

export const REQUIRED_ENV = Object.freeze({
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_FUND: 'false',
})

// Loose floors, not counts. Today: 7 workflow files, 22 install sites. These
// exist so a broken enumeration goes RED rather than green-and-empty; they are
// not a record of the tree's size and must not be maintained as one.
export const MIN_WORKFLOWS = 5
export const MIN_INSTALL_SITES = 15

const WORKFLOW_EXT = /\.ya?ml$/

// `npm ci`, `npm install`, `npm i` at a command position: start of line, or
// after whitespace or a shell character that can begin one. The trailing
// boundary is a lookahead rather than `(?:\s|$)` so `out=$(npm ci)` — the `)`
// closes the substitution, no space in sight — is still a site; the alternation
// is longest-first, so `npm install` matches `install` and not the bare `i`.
//
// The backtick is in the leading class for the same reason as `(`: it is the
// legacy command substitution, and `OUT=`npm ci`` has no whitespace before
// `npm` either. Missing it was a real hole — under-inclusive is the direction
// that lets a genuine install site through clean, which is the failure this
// whole file exists to prevent.
const INSTALL_RE = /(?:^|[\s;&|(`])npm\s+(?:ci|install|i)(?![\w-])/

export class CannotCheckError extends Error {}

/** Drop lines that are comments in both YAML and shell — see the header. */
const stripCommentLines = (text) =>
  text.split('\n').map((line, i) => ({ line, no: i + 1 })).filter(({ line }) => !/^\s*#/.test(line))

/** Executable npm install sites in one workflow, as {no, line}. */
export const findInstallSites = (text) =>
  stripCommentLines(text).filter(({ line }) => INSTALL_RE.test(line))

/**
 * The `env:` mapping at column 0, as a plain object of raw (unstripped) values.
 * Returns null when the file has no workflow-level `env:` at all.
 *
 * The block ends at the first line that is non-blank, not a comment, and starts
 * at column 0. A COMMENT NEVER ENDS IT, at any indentation: a `#` line is not
 * part of the mapping and YAML resumes the mapping after it, so
 *
 *     env:
 *       NPM_CONFIG_AUDIT: "false"
 *     # why funding is off too
 *       NPM_CONFIG_FUND: "false"
 *
 * is one two-key mapping to GitHub's parser. This used to break at the
 * unindented comment and report `NPM_CONFIG_FUND` missing on a file that is
 * correct — a false POSITIVE, so it could never wave a bad workflow through,
 * but it was justified in this header by a claim about YAML that was simply
 * untrue. Cross-checked against a real YAML parser rather than reasoned about.
 *
 * A quoted key (`"NPM_CONFIG_AUDIT": "false"`) is valid YAML and is read.
 *
 * A FLOW mapping (`env: { A: "1" }`) is not parsed at all — it raises a
 * cannot-check naming the file rather than being silently read as "no env
 * block", which is what it used to do. Nothing in this repo writes one, and a
 * loud "rewrite it in block style" beats a confident wrong answer.
 */
export const workflowEnv = (text) => {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^env:/.test(l))
  if (start === -1) return null
  const inline = /^env:\s*(\S.*?)\s*$/.exec(lines[start])
  if (inline && !inline[1].startsWith('#')) {
    throw new CannotCheckError(
      `\`env:\` on line ${start + 1} carries an inline value (\`${inline[1]}\`). This lint reads ` +
      'block mappings only — rewrite it as an indented block so the guarded keys are visible.',
    )
  }
  const env = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\s*#/.test(line)) continue
    if (!/^\s/.test(line)) break
    const m = /^\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*(.*?)\s*$/.exec(line)
    if (m) env[m[1] ?? m[2] ?? m[3]] = m[4].replace(/\s+#.*$/, '')
  }
  return env
}

/**
 * Every setting of a guarded key ANYWHERE in the file that is not the quoted
 * string "false", reported as {no, key, raw}.
 *
 * The workflow-level block is a DEFAULT: GitHub resolves step env over job env
 * over workflow env, so `NPM_CONFIG_AUDIT: "true"` on one job silently undoes
 * it for that job while the workflow-level check above still reads clean. The
 * lint said OK on exactly that shape until this was added.
 *
 * It matches by key at any indentation rather than by resolving YAML nesting:
 * the value must be "false" wherever it is set, so no nesting analysis is
 * needed to decide. Over-inclusive in the safe direction, like the install
 * detector — an `echo "NPM_CONFIG_AUDIT: true"` inside a `run:` block would be
 * flagged, and the remedy is to not write that line.
 */
export const overridesOf = (text) =>
  stripCommentLines(text)
    .map(({ line, no }) => {
      const m = /^\s+(NPM_CONFIG_AUDIT|NPM_CONFIG_FUND)\s*:\s*(.*?)\s*$/.exec(line)
      return m ? { no, key: m[1], raw: m[2].replace(/\s+#.*$/, '') } : null
    })
    .filter((hit) => hit !== null && !isQuotedFalse(hit.raw))

/** Does `raw` express the quoted string "false"? */
const isQuotedFalse = (raw) => raw === '"false"' || raw === "'false'"

/**
 * @returns {{workflows: number, installSites: number, violations: string[]}}
 * @throws {CannotCheckError}
 */
export const analyze = (dir) => {
  let names
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory')
    names = readdirSync(dir).filter((n) => WORKFLOW_EXT.test(n)).sort()
  } catch (err) {
    throw new CannotCheckError(`cannot read ${dir}: ${err.message}`)
  }
  if (names.length < MIN_WORKFLOWS) {
    throw new CannotCheckError(
      `enumerated only ${names.length} workflow file(s) in ${dir} (expected >=${MIN_WORKFLOWS}) — ` +
      'the enumeration is broken, not the tree',
    )
  }

  const violations = []
  const installing = []
  let installSites = 0

  for (const name of names) {
    // A file that cannot be READ is a cannot-check, not a violation. Unwrapped
    // this throws out of runCli and node exits 1 — the code that means "a
    // workflow is missing the env block", sending the reader to look for a
    // missing block instead of at the unreadable file. It failed closed either
    // way; it failed closed with the wrong diagnosis.
    let text
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch (err) {
      throw new CannotCheckError(`cannot read ${join(dir, name)}: ${err.message}`)
    }
    const sites = findInstallSites(text)
    if (sites.length === 0) continue
    installing.push(name)
    installSites += sites.length

    let env
    try {
      env = workflowEnv(text)
    } catch (err) {
      if (err instanceof CannotCheckError) throw new CannotCheckError(`${name}: ${err.message}`)
      throw err
    }
    const where = `${sites.length} npm install site(s), first at line ${sites[0].no}`
    if (env === null) {
      violations.push(
        `${name}: ${where}, but no workflow-level \`env:\` block. Add one at column 0:\n` +
        '    env:\n      NPM_CONFIG_AUDIT: "false"\n      NPM_CONFIG_FUND: "false"',
      )
      continue
    }
    for (const [key, want] of Object.entries(REQUIRED_ENV)) {
      const raw = env[key]
      if (raw === undefined) {
        violations.push(`${name}: ${where}, but workflow-level \`env:\` does not set ${key}.`)
      } else if (!isQuotedFalse(raw)) {
        violations.push(
          `${name}: workflow-level ${key} is \`${raw}\`, not the quoted string "${want}". ` +
          'See the header of scripts/lint-workflow-npm-env.mjs for why the quotes are required.',
        )
      }
    }
    for (const { no, key, raw } of overridesOf(text)) {
      violations.push(
        `${name}:${no}: ${key} is set to \`${raw}\` somewhere below the workflow level. ` +
        'GitHub resolves step env over job env over workflow env, so this NEUTRALISES the ' +
        'workflow-level block for that job or step and the install audits anyway.',
      )
    }
  }

  if (installSites < MIN_INSTALL_SITES) {
    throw new CannotCheckError(
      `found only ${installSites} npm install site(s) across ${names.length} workflow(s) ` +
      `(expected >=${MIN_INSTALL_SITES}). Either the site detector has stopped matching, or the ` +
      'installs moved somewhere it does not look — a composite action or a reusable workflow, ' +
      'which this lint deliberately does not follow. Both are real; it cannot tell which, so it ' +
      'refuses rather than reporting a tree it did not actually check.',
    )
  }

  return { workflows: names.length, installSites, installing, violations }
}

/**
 * `--dir <path>` and `--dir=<path>`, and NOTHING else.
 *
 * The equals form used to fall through `argv.indexOf('--dir')` unrecognised and
 * take the default — so `--dir=/some/fixture` silently analysed the real
 * .github/workflows and reported on a tree the caller never asked about. An
 * unknown argument is a refusal for the same reason: a flag that is read as
 * "no flag" is how a run reports confidently on the wrong subject.
 */
export const parseArgs = (argv) => {
  let dir = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') {
      dir = argv[i + 1]
      i++
      if (dir === undefined) return { error: '--dir requires a path' }
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length)
    } else {
      return { error: `unknown argument \`${arg}\` — this lint takes --dir <path> and nothing else` }
    }
    if (dir === '') return { error: '--dir requires a non-empty path' }
  }
  return { dir: dir ?? join('.github', 'workflows') }
}

export const runCli = (argv = process.argv.slice(2)) => {
  const { dir, error } = parseArgs(argv)
  if (error) {
    console.error(`::error::[workflow-npm-env] ${error}`)
    return 2
  }

  let result
  try {
    result = analyze(dir)
  } catch (err) {
    if (err instanceof CannotCheckError) {
      console.error(`::error::[workflow-npm-env] CANNOT CHECK — ${err.message}`)
      return 2
    }
    throw err
  }

  const { workflows, installSites, violations } = result
  console.log(
    `[workflow-npm-env] ${workflows} workflow(s), ${installSites} npm install site(s) checked.`,
  )
  if (violations.length === 0) {
    console.log('[workflow-npm-env] OK — every workflow that installs disables npm audit + fund.')
    return 0
  }
  for (const v of violations) console.error(`::error::[workflow-npm-env] ${v}`)
  console.error(
    `\n[workflow-npm-env] FAIL — ${violations.length} problem(s). A workflow that runs ` +
    '`npm ci` must set NPM_CONFIG_AUDIT and NPM_CONFIG_FUND to "false" at the workflow ' +
    '`env:` level, so every install site in it — including ones added later — is covered (#7616).',
  )
  return 1
}

if (isEntryPoint(import.meta.url)) {
  process.exit(runCli())
}
