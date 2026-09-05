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
 *      to the quoted string "false", in a `env:` mapping at COLUMN 0 — the
 *      workflow level, not a job's and not a step's?
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
 * real `npm config get` on the real CI node. It does NOT check job-level or
 * step-level env (deliberately: those do not cover jobs added later, so
 * accepting them would accept the shape this lint rejects). It does NOT look
 * at composite actions or reusable workflows — this repo calls none.
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
// after whitespace or a shell operator that can begin one. The trailing
// boundary is a lookahead rather than `(?:\s|$)` so `out=$(npm ci)` — the `)`
// closes the substitution, no space in sight — is still a site; the alternation
// is longest-first, so `npm install` matches `install` and not the bare `i`.
const INSTALL_RE = /(?:^|[\s;&|(])npm\s+(?:ci|install|i)(?![\w-])/

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
 * The block ends at the first line that is non-blank and starts at column 0 —
 * a comment at column 0 included, since a `#` there is not part of the mapping
 * and a block that resumed after it would be indistinguishable to a reader.
 */
export const workflowEnv = (text) => {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^env:\s*(#.*)?$/.test(l))
  if (start === -1) return null
  const env = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/\s+#.*$/, '')
  }
  return env
}

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
  let installSites = 0

  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8')
    const sites = findInstallSites(text)
    if (sites.length === 0) continue
    installSites += sites.length

    const env = workflowEnv(text)
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
  }

  if (installSites < MIN_INSTALL_SITES) {
    throw new CannotCheckError(
      `found only ${installSites} npm install site(s) across ${names.length} workflow(s) ` +
      `(expected >=${MIN_INSTALL_SITES}) — the site detector is broken, not the tree`,
    )
  }

  return { workflows: names.length, installSites, violations }
}

export const runCli = (argv = process.argv.slice(2)) => {
  const dirFlag = argv.indexOf('--dir')
  const dir = dirFlag === -1 ? join('.github', 'workflows') : argv[dirFlag + 1]
  if (dirFlag !== -1 && !dir) {
    console.error('::error::[workflow-npm-env] --dir requires a path')
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
