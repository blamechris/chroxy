/**
 * Tests for scripts/lint-acp-imports.mjs (#7318 review).
 *
 * The lint bans two literal substrings, matched on comment-stripped source,
 * across every git-known file under a scan root: `@zed-industries/agent-`
 * `client-protocol` (the stale predecessor package) and `@agentclientprotocol`
 * `/sdk/experimental` (any draft/experimental ACP entry point). This file
 * exists to prove the four defects found in the original inline version are
 * actually fixed here — not just that a clean tree passes, which a vacuous
 * lint would also do.
 *
 * Strategy: run the lint as a child process against a temp fixture tree (via
 * the `--scan-root` override), asserting exit code + offender output —
 * mirrors tests/lint-ws-index-mutations.test.js.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-acp-imports.mjs')

// This file is allowed to spell both needles as one contiguous literal — it
// IS the fixture data the lint's own TEST_EXEMPTIONS list carves out (see
// lint-acp-imports.mjs's docblock). Splitting these would make the fixtures
// stop looking like the real offending imports they stand in for.
const ZED_IMPORT_SRC = `
import { Client } from '@zed-industries/agent-client-protocol'
export const client = new Client()
`

const EXPERIMENTAL_IMPORT_SRC = `
import { agent } from '@agentclientprotocol/sdk/experimental/node'
export { agent }
`

const CLEAN_SRC = `
import { agent, client } from '@agentclientprotocol/sdk'
export function run() {
  return agent && client
}
`

// The exact false positive #7318's review found: a comment explaining why
// the stale predecessor is NOT used. Must pass -- this is prose, not an
// import, and prose is exactly what a real #7306 change will write here.
const COMMENT_ONLY_SRC = `
// We deliberately do NOT use @zed-industries/agent-client-protocol.
// See @agentclientprotocol/sdk instead.
export function run() {
  return true
}
`

// A trailing inline // comment mentioning the experimental subpath -- must
// also pass, same reasoning as the block comment above.
const INLINE_COMMENT_SRC = `
export function note() {
  doThing() // do not import @agentclientprotocol/sdk/experimental/node here
  return true
}
`

// A guarded exemption -- the marker on the line above suppresses the offense.
const IGNORED_SRC = `
export function legacyShim() {
  // lint-ignore-acp-import: transitional import kept for a migration test only.
  return require('@zed-industries/agent-client-protocol')
}
`

// A .cjs file -- the original inline scan's /\.(m?js|jsx)$/ regex missed this
// extension entirely (#7318 review, defect 2).
const CJS_OFFENDER_SRC = `
module.exports = require('@zed-industries/agent-client-protocol')
`

// node_modules must be skipped, same as every sibling lint's walker.
const NODE_MODULE_SRC = `module.exports = require('@zed-industries/agent-client-protocol')\n`

function setupFixtureTree(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-lint-acp-'))
  for (const [name, src] of Object.entries(files)) {
    const filePath = join(dir, name)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, src, 'utf8')
  }
  return dir
}

function runLint(scanRoot, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [LINT_SCRIPT, '--scan-root', scanRoot, ...extraArgs],
    { encoding: 'utf8' },
  )
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

describe('lint-acp-imports', () => {
  const cleanups = []
  after(() => {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  test('passes on a clean tree', () => {
    const dir = setupFixtureTree({ 'index.mjs': CLEAN_SRC, 'lib/util.mjs': CLEAN_SRC })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(dir)
    assert.equal(code, 0, `lint should pass on a clean tree\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('fails on the stale @zed-industries predecessor', () => {
    const dir = setupFixtureTree({ 'src/client.mjs': ZED_IMPORT_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 1, 'a zed-industries import must fail')
    assert.match(stderr, /client\.mjs:2.*zed-industries-predecessor/, 'error should name the offending file:line and kind')
  })

  test('fails on an experimental/* ACP entry point', () => {
    const dir = setupFixtureTree({ 'src/agent.mjs': EXPERIMENTAL_IMPORT_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 1, 'an experimental/* import must fail')
    assert.match(stderr, /agent\.mjs:2.*experimental-entry-point/, 'error should name the offending file:line and kind')
  })

  test('fails on an offender OUTSIDE src/ -- sidecar/, hooks/, and scripts/-shaped paths', () => {
    // The defect this regression-tests: the original inline scan only ever
    // walked packages/server/src, so the same offender in a shipped
    // (sidecar/, hooks/) or tooling (scripts/) directory passed silently.
    const dir = setupFixtureTree({
      'sidecar/agent.mjs': ZED_IMPORT_SRC,
      'hooks/emit.mjs': ZED_IMPORT_SRC,
      'scripts/evil.mjs': ZED_IMPORT_SRC,
    })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 1, 'offenders outside src/ must still fail')
    assert.match(stderr, /sidecar\/agent\.mjs:2/, 'sidecar/ offender must be reported')
    assert.match(stderr, /hooks\/emit\.mjs:2/, 'hooks/ offender must be reported')
    assert.match(stderr, /scripts\/evil\.mjs:2/, 'scripts/ offender must be reported')
  })

  test('fails on an offender in a .cjs file', () => {
    // The original /\.(m?js|jsx)$/ extension regex silently skipped .cjs.
    const dir = setupFixtureTree({ 'src/legacy.cjs': CJS_OFFENDER_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 1, 'a .cjs offender must fail')
    assert.match(stderr, /legacy\.cjs:2/, 'error should name the .cjs file:line')
  })

  test('does NOT flag a comment explaining why the predecessor is avoided', () => {
    // The proven false positive: this is exactly the kind of comment #7306
    // will write. Must stay green.
    const dir = setupFixtureTree({ 'src/notes.mjs': COMMENT_ONLY_SRC })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(dir)
    assert.equal(code, 0, `a comment-only mention must not fail\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('does NOT flag a mention inside a trailing inline // comment', () => {
    const dir = setupFixtureTree({ 'src/notes2.mjs': INLINE_COMMENT_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 0, `an inline-comment mention must not fail\nstderr:\n${stderr}`)
  })

  test('respects the lint-ignore comment on a guarded site', () => {
    const dir = setupFixtureTree({ 'src/shim.mjs': IGNORED_SRC })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(dir)
    assert.equal(code, 0, `lint-ignore comment should suppress the offense\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('skips node_modules', () => {
    // A real, offending file lives INSIDE node_modules/ alongside a clean file
    // outside it. If the walker did not skip node_modules, the offense inside
    // it would be reported and this fails; if it collapsed to zero files, the
    // min-files floor above would catch that separately. This isolates the
    // one behavior under test: node_modules/ content is invisible either way.
    const dir = setupFixtureTree({
      'node_modules/dep/index.js': NODE_MODULE_SRC,
      'src/clean.mjs': CLEAN_SRC,
    })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(dir)
    assert.equal(code, 0, `node_modules must not be walked\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('exits 2 when the walk collapses to zero files', () => {
    const dir = setupFixtureTree({ 'README.md': '# not a scanned extension\n' })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 2, 'an empty walk must exit 2, not report a clean tree')
    assert.match(stderr, /walked 0 files/)
  })

  test('exits 2 when --min-files is not met', () => {
    const dir = setupFixtureTree({ 'src/only-one.mjs': CLEAN_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir, ['--min-files', '5'])
    assert.equal(code, 2, 'a walk below the floor must exit 2')
    assert.match(stderr, /walked only 1 file/)
  })

  test('--dry-run reports offenders but exits 0', () => {
    const dir = setupFixtureTree({ 'src/bad.mjs': ZED_IMPORT_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir, ['--dry-run'])
    assert.equal(code, 0, '--dry-run should not fail the exit code')
    assert.match(stderr, /bad\.mjs:2/, '--dry-run should still print offenders')
  })

  test('reports BOTH offenders when a file has one of each kind', () => {
    const dir = setupFixtureTree({
      'src/both.mjs': ZED_IMPORT_SRC + EXPERIMENTAL_IMPORT_SRC,
    })
    cleanups.push(dir)
    const { code, stderr } = runLint(dir)
    assert.equal(code, 1)
    assert.match(stderr, /zed-industries-predecessor/)
    assert.match(stderr, /experimental-entry-point/)
  })
})
