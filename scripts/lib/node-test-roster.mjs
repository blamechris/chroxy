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

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Hardcoded on purpose: the point is that the derived set is asserted EQUAL to it, so
// neither can change without the other. Add a package here in the same PR that adds it.
export const EXPECTED_NODE_TEST_PACKAGES = ['claude-hooks', 'design-tokens', 'protocol', 'server']

// `node ... --test` — vitest ("vitest run") and jest ("jest --coverage") never match, and
// `--test-force-exit` does not match `--test` because of the trailing boundary.
export const isNodeTestScript = (script) => /\bnode\b/.test(script) && /--test(\s|$)/.test(script)

// Any `--test` token at all, whichever runner precedes it (`tsx --test`, `bun --test`).
// A script like that is NOT in the roster, so a hook it used to carry is gone with it.
export const mentionsTestFlag = (script) => /(^|\s)--test(\s|$)/.test(script)

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

/**
 * Does `name`'s test script `--import` a relative file that CALLS the guard installer at the
 * start of a line? A plain substring check also matches the library's own
 * `export function <name>(` definition, which installs nothing on import, so a one-token slip
 * (dropping `-hook`) would read as wired (#8056 finding 1). The anchored call matches a hook
 * or a setup module and excludes the library definition and any descriptive comment.
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {{name: string, script: string}} o.pkg
 * @param {RegExp} o.installCall  e.g. /^assertNoTestForceExit\(/m
 * @param {string[]} o.libraryFiles repo-relative library paths that must never count
 */
export function packageInstalls({ repoRoot, pkg, installCall, libraryFiles }) {
  const packageDir = resolve(repoRoot, 'packages', pkg.name)
  const libraries = new Set(libraryFiles.map((f) => resolve(repoRoot, f)))
  const imports = [...pkg.script.matchAll(/--import\s+(\S+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  return imports.some((spec) => {
    if (!spec.startsWith('.')) return false // bare specifier (tsx/esm) — not ours
    const file = resolve(packageDir, spec)
    if (libraries.has(file) || !existsSync(file)) return false
    return installCall.test(readFileSync(file, 'utf8'))
  })
}

// ── node:test suites that run OUTSIDE the roster packages ────────────────────

const IMPORTS_NODE_TEST = /(?:from\s+|require\()\s*['"]node:test['"]/
const MATCH_SITE = /\bassert\.(?:match|doesNotMatch)\(/g

/**
 * Tracked files under packages/ that import `node:test`, excluding the roster packages
 * (which are guarded through their `test` script). Throws if git yields nothing — "could not
 * list" must not read as "nothing to check".
 */
export function directRunNodeTestFiles(repoRoot, rosterNames) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  if (listed.length === 0) throw new Error('git ls-files listed no files under packages/')
  const roster = new Set(rosterNames)
  const found = []
  for (const rel of listed) {
    if (!/\.(?:mjs|cjs|js|ts)$/.test(rel)) continue
    if (roster.has(rel.split('/')[1])) continue
    const text = readFileSync(resolve(repoRoot, rel), 'utf8')
    if (!IMPORTS_NODE_TEST.test(text)) continue
    found.push({ file: rel, matchSites: (text.match(MATCH_SITE) ?? []).length })
  }
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

const CI_DIRECT = 'CI runs it as `node <file>` (not through a package `test` script with --import hooks)'

// Every direct-run suite is EXEMPT, not guarded, and the reason is falsifiable: `matchSites`
// is the exact number of assert.match/doesNotMatch calls, asserted equal, so the first new
// site over a possibly-large subject turns this red instead of riding the exemption.
export const DIRECT_RUN_EXEMPTIONS = {
  'packages/desktop/scripts/__tests__/find-macho.test.mjs': {
    matchSites: 5,
    reason: `${CI_DIRECT}; --test-force-exit only exists on the node --test runner it never uses; its 5 assert.match sites all check a small child \`stderr\` line (bounded payload)`,
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
