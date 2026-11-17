// node-test-roster.mjs — the ONE derivation of "which packages run `node --test`"
// and "which other files run `node:test` directly" (#8056).
//
// Two package walks need this roster: `no-test-force-exit.test.mjs` (#7400) and
// `assert-match-payload-guard-wiring.test.mjs` (#7413). They each carried a line-for-line
// copy of the derivation; two copies of one derivation drift, so both import this.
//
// The roster is checked in BOTH directions, against an explicit list:
//   - derived but not expected: a new `node --test` package (needs the guards, and an
//     entry in EXPECTED_NODE_TEST_PACKAGES so this is a conscious decision);
//   - expected but not derived: a package whose script stopped matching (e.g. `tsx --test`),
//     which would otherwise drop out of the walk and take its guards with it, silently.
// A numeric floor cannot see the second one once a fifth package lands (#7199/#7216/#7544).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Hardcoded on purpose: the point is that the derived set is asserted EQUAL to it, so
// neither can change without the other. Add a package here in the same PR that adds it.
export const EXPECTED_NODE_TEST_PACKAGES = ['claude-hooks', 'design-tokens', 'protocol', 'server']

// `node ... --test` — vitest ("vitest run") and jest ("jest --coverage") never match, and
// `--test-force-exit` does not match `--test` because of the trailing boundary.
export const isNodeTestScript = (script) => /\bnode\b/.test(script) && /--test(\s|$)/.test(script)

// Any `--test` token at all (a mixed script such as `tsx --test && node --test` still matches
// isNodeTestScript, so its package stays in the roster; this only widens the net).
// Any `--test` token at all, whichever runner precedes it (`tsx --test`, `bun --test`).
// A script like that is NOT in the roster, so a hook it used to carry is gone with it.
export const mentionsTestFlag = (script) => /(^|\s)--test(\s|$)/.test(script)

// Only `scripts.test` is walked. `test:*` variants (server's integration and k8s scripts) are
// outside the roster by design: they are not what `npm test` / the CI test job runs.
function packageManifests(repoRoot) {
  const packagesDir = resolve(repoRoot, 'packages')
  const out = []
  for (const name of readdirSync(packagesDir).sort()) {
    const manifest = join(packagesDir, name, 'package.json')
    if (!existsSync(manifest)) continue
    out.push({ name, script: JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test ?? '' })
  }
  return out
}

/** @returns {{name: string, script: string}[]} packages whose test script runs `node --test`. */
export function nodeTestPackages(repoRoot) {
  return packageManifests(repoRoot).filter((p) => isNodeTestScript(p.script))
}

/** Packages with a `--test` token that the roster regex does NOT accept. */
export function suspectTestFlagPackages(repoRoot) {
  return packageManifests(repoRoot).filter((p) => mentionsTestFlag(p.script) && !isNodeTestScript(p.script))
}

// ── Does the package's test command actually INSTALL each guard? ────────────
//
// Behavioural, not textual (#8056 review S1). A text or line match credits a call inside a
// block comment or template string, or a dead `if (false)` call. So this SPAWNS node with
// exactly the package's relative `--import`s and observes the guard doing its job:
//   - the refusal: a `--test --test-force-exit` run must die with FORCE_EXIT_ERROR_CODE;
//   - the payload guard: `assert.match` must be the guarded function.
// Importing the LIBRARY instead of the hook installs nothing on import, so it fails both
// observations with no special-casing. (A parser such as acorn is the other option; the
// `Scripts Tests` CI job installs no npm dependencies, so none is resolvable there.)

const FORCE_EXIT_CODE = 'CHROXY_TEST_FORCE_EXIT'
const GUARDED_ASSERT_NAME = 'chroxyGuardedAssert'

function relativeImportArgs(repoRoot, pkg) {
  const packageDir = resolve(repoRoot, 'packages', pkg.name)
  const args = []
  for (const m of pkg.script.matchAll(/--import\s+(\S+)/g)) {
    const spec = m[1].replace(/^['"]|['"]$/g, '')
    if (!spec.startsWith('.')) continue // bare specifier (tsx/esm) — not ours
    const file = resolve(packageDir, spec)
    if (!existsSync(file)) continue
    args.push('--import', pathToFileURL(file).href)
  }
  return { packageDir, args }
}

function withProbeDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-roster-probe-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Does this package's `--import`s make a `--test-force-exit` run refuse? */
export function packageRefusesForceExit({ repoRoot, pkg }) {
  const { packageDir, args } = relativeImportArgs(repoRoot, pkg)
  if (args.length === 0) return false
  return withProbeDir((dir) => {
    const probe = join(dir, 'probe.test.js')
    writeFileSync(probe, "import { test } from 'node:test'\ntest('probe', () => {})\n")
    const r = spawnSync(process.execPath, [...args, '--test', '--test-force-exit', probe], {
      encoding: 'utf8', cwd: packageDir, timeout: 60_000,
    })
    return r.status !== 0 && (r.stdout + r.stderr).includes(FORCE_EXIT_CODE)
  })
}

/** Does this package's `--import`s leave `assert.match` as the payload-guarded function? */
export function packagePatchesAssertMatch({ repoRoot, pkg }) {
  const { packageDir, args } = relativeImportArgs(repoRoot, pkg)
  if (args.length === 0) return false
  return withProbeDir((dir) => {
    const probe = join(dir, 'probe.mjs')
    writeFileSync(probe, "import assert from 'node:assert/strict'\nconsole.log(assert.match.name)\n")
    const r = spawnSync(process.execPath, [...args, probe], { encoding: 'utf8', cwd: packageDir, timeout: 60_000 })
    return r.status === 0 && r.stdout.includes(GUARDED_ASSERT_NAME)
  })
}

// ── node:test suites that run OUTSIDE the roster packages ────────────────────

// Source forms the scanners understand. Any other tracked file under packages/ that QUOTES
// 'node:test' is reported (see `unclassifiedNodeTestMentions`), never skipped.
const SCANNED_EXTENSIONS = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/
const NON_CODE_EXTENSIONS = /\.(?:md|json|ya?ml|lock|txt|png|jpg|jpeg|gif|svg|ico|icns|woff2?|ttf|rs|toml|sh|html|css|map|snap)$/

// Any quoted 'node:test' specifier: static `from`, `require()`, dynamic `import()`, bare
// `import 'node:test'`. Deliberately broad — a mention in a string or comment OVER-reports,
// which surfaces as "unlisted" and is cheap to resolve; the reverse silently skips a suite.
export const importsNodeTest = (text) => /['"`]node:test['"`]/.test(text)

// Match-family call sites, counted so an exemption is judged on a number:
//   - calls: `assert.match(`, `t.assert.doesNotMatch(`, `strict.match(`, any `.match(`
//     (over-counts String.prototype.match — the safe direction);
//   - destructuring / import bindings: `const { match } = assert`, `import { match as m }`;
//   - aliasing without a call: `const m = assert.match`.
const MATCH_CALL = /\.(?:match|doesNotMatch)\(/g
const MATCH_BINDING = /(?:\bconst|\blet|\bvar|\bimport)\s*\{[^}]*\b(?:match|doesNotMatch)\b[^}]*\}/g
const MATCH_ALIAS = /=\s*[\w$.]+\.(?:match|doesNotMatch)\b(?!\s*\()/g
export function countMatchSites(text) {
  return [MATCH_CALL, MATCH_BINDING, MATCH_ALIAS].reduce((n, re) => n + (text.match(re) ?? []).length, 0)
}

/**
 * Tracked files under packages/ that import `node:test`, excluding the roster packages
 * (which are guarded through their `test` script). Throws if git yields nothing — "could not
 * list" must not read as "nothing to check".
 */
export function directRunNodeTestFiles(repoRoot, rosterNames) {
  const roster = new Set(rosterNames)
  const found = []
  for (const rel of trackedPackageFiles(repoRoot)) {
    if (roster.has(rel.split('/')[1]) || !SCANNED_EXTENSIONS.test(rel)) continue
    const text = readFileSync(resolve(repoRoot, rel), 'utf8')
    if (importsNodeTest(text)) found.push({ file: rel, matchSites: countMatchSites(text) })
  }
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

function trackedPackageFiles(repoRoot) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  if (listed.length === 0) throw new Error('git ls-files listed no files under packages/')
  return listed
}

/**
 * Tracked files outside the roster that quote 'node:test' but have an extension the scanner
 * does not understand (and is not a known non-code type). Reported, never skipped.
 */
export function unclassifiedNodeTestMentions(repoRoot, rosterNames) {
  const roster = new Set(rosterNames)
  return trackedPackageFiles(repoRoot).filter((rel) => {
    if (roster.has(rel.split('/')[1]) || SCANNED_EXTENSIONS.test(rel) || NON_CODE_EXTENSIONS.test(rel)) return false
    return importsNodeTest(readFileSync(resolve(repoRoot, rel), 'utf8'))
  })
}

// ── Is each exempt file really run as `node <file>` by ci.yml? ───────────────

/**
 * Commands a workflow runs, with the working directories each step could run them in.
 * A line reader, not a YAML parser (none is installable in the Scripts Tests job): it reads
 * `run:` values (inline or block scalar), the step's `working-directory:`, and any
 * `defaults.run.working-directory`. Comments are dropped; commands are split on `|`, `&&`,
 * `;` and `||`, with `\` continuations joined.
 * @returns {{cwds: string[], argv: string[]}[]}
 */
export function workflowCommands(workflowText) {
  const lines = workflowText.split('\n')
  const indentOf = (l) => l.length - l.trimStart().length
  const defaults = []
  const steps = [] // {wd: string[], runs: string[]}
  let cur = null
  let curIndent = -1
  let prev = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const prevLine = prev
    prev = trimmed
    const dashed = /^(\s*)- /.exec(line)
    if (dashed && (cur === null || dashed[1].length <= curIndent)) {
      cur = { wd: [], runs: [] }
      steps.push(cur)
      curIndent = dashed[1].length
    }
    const body = trimmed.replace(/^- /, '')
    const wd = /^working-directory:\s*(\S+)\s*$/.exec(body)
    if (wd) {
      const v = wd[1].replace(/^['"]|['"]$/g, '')
      // `defaults:\n  run:\n    working-directory:` — the parent key is a bare `run:`.
      if (prevLine === 'run:') defaults.push(v)
      else if (cur) cur.wd.push(v)
      continue
    }
    const run = /^run:\s*(.*)$/.exec(body)
    if (run && cur) {
      const v = run[1]
      if (/^[|>][+-]?\d*\s*$/.test(v)) {
        const base = indentOf(line)
        const block = []
        while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > base)) block.push(lines[++i])
        cur.runs.push(block.join('\n'))
      } else {
        cur.runs.push(v)
      }
    }
  }
  const out = []
  for (const step of steps) {
    const cwds = ['', ...step.wd, ...defaults]
    for (const run of step.runs) {
      const joined = run.replace(/\\\n/g, ' ')
      for (const raw of joined.split(/\n|\|\||&&|;|\|/)) {
        const cmd = raw.trim()
        if (cmd === '' || cmd.startsWith('#')) continue
        out.push({ cwds, argv: cmd.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, '')) })
      }
    }
  }
  return out
}

/** Is `relFile` invoked as `node [flags] <file>` (no `--test` runner flag) by some command? */
export function workflowRunsFileDirectly(repoRoot, workflowText, relFile) {
  const target = resolve(repoRoot, relFile)
  for (const { cwds, argv } of workflowCommands(workflowText)) {
    const at = argv.indexOf('node')
    if (at === -1) continue
    const rest = argv.slice(at + 1)
    let script = null
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]
      if (t === '--test' || t.startsWith('--test=')) { script = null; break }
      if (t === '--import' || t === '-r' || t === '--require') { i++; continue }
      if (t.startsWith('-')) continue
      script = t
      break
    }
    if (script === null || isAbsolute(script)) continue
    if (cwds.some((cwd) => resolve(repoRoot, cwd, script) === target)) return true
  }
  return false
}

const CI_DIRECT = 'CI runs it as `node <file>` (not through a package `test` script with --import hooks)'

// Every direct-run suite is EXEMPT, not guarded, and the reason is falsifiable: `matchSites`
// is the exact number of assert.match/doesNotMatch calls, asserted equal, so the first new
// site over a possibly-large subject turns this red instead of riding the exemption.
export const DIRECT_RUN_EXEMPTIONS = {
  'packages/desktop/scripts/__tests__/find-macho.test.mjs': {
    matchSites: 5,
    reason: `${CI_DIRECT}; --test-force-exit only exists on the node --test runner it never uses; its assert.match sites all check a small child \`stderr\` line (bounded payload)`,
  },
  'packages/desktop/scripts/__tests__/derive-server-lockfile.test.mjs': {
    matchSites: 0,
    reason: `${CI_DIRECT}; no assert.match/doesNotMatch, so the payload guard has nothing to bound`,
  },
  'packages/dashboard/scripts/tool-layout.test.mjs': {
    matchSites: 0,
    reason: `${CI_DIRECT}; no assert.match/doesNotMatch, so the payload guard has nothing to bound`,
  },
  'packages/dashboard/scripts/header-layout.test.mjs': {
    matchSites: 0,
    reason: `${CI_DIRECT}; no assert.match/doesNotMatch, so the payload guard has nothing to bound`,
  },
  'packages/dashboard/scripts/panel-header-layout.test.mjs': {
    matchSites: 0,
    reason: `${CI_DIRECT}; no assert.match/doesNotMatch, so the payload guard has nothing to bound`,
  },
  'packages/dashboard/scripts/sidebar-layout.test.mjs': {
    matchSites: 0,
    reason: `${CI_DIRECT}; no assert.match/doesNotMatch, so the payload guard has nothing to bound`,
  },
}
