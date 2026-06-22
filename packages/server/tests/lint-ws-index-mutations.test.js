/**
 * Tests for scripts/lint-ws-index-mutations.mjs (#5579).
 *
 * The lint guards the sessionId→clients reverse index (#5575): every change to
 * a client's active session or subscription Set must route through the
 * index-maintaining mutators on ws-client-manager.js, or the index drifts. A
 * bare `client.activeSessionId = x` / `client.subscribedSessionIds.add(...)`
 * outside that file is an offense.
 *
 * Strategy: run the lint as a child process against a temp fixture `src/` tree
 * (via the `--src-dir` override) and assert exit code + offender output.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-ws-index-mutations.mjs')

// The owner file — exempt wholesale, because its mutators ARE the sanctioned
// write path. A bare mutation here must pass.
const OWNER_SRC = `
export class WsClientManager {
  setActiveSession(client, sid) {
    client.activeSessionId = sid
  }
  subscribe(client, sid) {
    client.subscribedSessionIds.add(sid)
  }
  unsubscribe(client, sid) {
    client.subscribedSessionIds.delete(sid)
  }
  reset(client) {
    client.subscribedSessionIds.clear()
  }
}
`

// A clean handler — only reads and comparisons, no bare mutation.
const CLEAN_SRC = `
export function pick(client, sessionId) {
  if (client.activeSessionId === sessionId) return true
  if (client.activeSessionId !== sessionId) return false
  return client.subscribedSessionIds.has(sessionId)
}
`

// A bare active-session write outside the owner — must FAIL.
const BARE_ACTIVE_WRITE_SRC = `
export function badAssign(client, sid) {
  client.activeSessionId = sid
}
`

// A bare subscribe outside the owner — must FAIL.
const BARE_SUBSCRIBE_SRC = `
export function badSubscribe(client, sid) {
  client.subscribedSessionIds.add(sid)
}
`

// A whole-Set reassignment outside the owner — must FAIL; a comparison and an
// arrow after `=` must NOT (regression for the assignment-vs-comparison split).
const SET_REASSIGN_SRC = `
export function badReplace(client) {
  client.subscribedSessionIds = new Set()
}
export function fineCompare(client, other) {
  return client.subscribedSessionIds === other.subscribedSessionIds
}
`

// A bare delete + clear outside the owner — must FAIL (two offenses).
const BARE_DELETE_CLEAR_SRC = `
export function badRemove(client, sid) {
  client.subscribedSessionIds.delete(sid)
  client.subscribedSessionIds.clear()
}
`

// A guarded fixture fallback carrying the opt-out comment above the bare write
// (with a multi-line justification between marker and the line) — must PASS.
const IGNORED_FALLBACK_SRC = `
export function restore(client, ctx, activeId) {
  if (typeof ctx.setActiveSession === 'function') {
    ctx.setActiveSession(client, activeId)
  } else {
    // lint-ignore-ws-index-mutation: guarded fixture fallback. This else-branch
    // only runs for legacy fixtures whose ctx predates the helper; production
    // always takes the helper path above.
    client.activeSessionId = activeId
  }
}
`

// A bare write that sits inside a comment — must NOT be flagged.
const COMMENT_ONLY_SRC = `
export function note() {
  // Handlers MUST route through ctx.setActiveSession, NOT bare
  // \`client.activeSessionId = x\` or \`client.subscribedSessionIds.add(...)\`.
  return true
}
`

// A mutation pattern that appears only in a TRAILING inline \`//\` comment —
// must NOT be flagged (regression for the inline-comment false positive).
const INLINE_COMMENT_SRC = `
export function note(client, s) {
  doThing() // client.activeSessionId = s — the wrong way; use ctx.setActiveSession
  more() // client.subscribedSessionIds.add(s) is also forbidden
  return true
}
`

// A minified production bundle of the kind Vite emits into \`src/dashboard-next/\`
// — gitignored build output, not hand-written source. It packs several forbidden
// patterns onto one dense line, so if the walker descends into that directory it
// trips ACTIVE_WRITE_RE and SET_MUTATE_RE and fails the lint with false positives
// (#6255). The walker must skip the whole \`dashboard-next/\` directory.
const MINIFIED_BUNDLE_SRC = `function r(e,t){e.activeSessionId=t;e.subscribedSessionIds.add(t);return e.subscribedSessionIds}\n`

// A vendored third-party dependency under \`node_modules/\` — also full of bare
// mutations the walker has no business linting. Same directory-skip requirement.
const NODE_MODULE_SRC = `module.exports = function (c, s) { c.activeSessionId = s }\n`

// `name` may contain a `/`-separated subpath (e.g. `dashboard-next/dist/x.js`);
// the parent dirs are created so fixtures can exercise the walker's recursion
// and directory-skip behavior, not just a flat tree.
function setupFixtureTree(extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-lint-ws-idx-'))
  const srcDir = join(dir, 'src')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(extraFiles)) {
    const filePath = join(srcDir, name)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, src, 'utf8')
  }
  return { dir, srcDir }
}

function runLint(srcDir) {
  const result = spawnSync(
    process.execPath,
    [LINT_SCRIPT, '--src-dir', srcDir],
    { encoding: 'utf8' },
  )
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

describe('lint-ws-index-mutations', () => {
  const cleanups = []
  after(() => {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  test('passes on a clean tree (owner + read-only handler)', () => {
    const { dir, srcDir } = setupFixtureTree({
      'ws-client-manager.js': OWNER_SRC,
      'ws-broadcaster.js': CLEAN_SRC,
    })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(srcDir)
    assert.equal(code, 0, `lint should pass on clean tree\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('allows bare mutations inside the owner file', () => {
    const { dir, srcDir } = setupFixtureTree({ 'ws-client-manager.js': OWNER_SRC })
    cleanups.push(dir)
    const { code } = runLint(srcDir)
    assert.equal(code, 0, 'bare mutations in ws-client-manager.js must be exempt')
  })

  test('fails on a bare activeSessionId write outside the owner', () => {
    const { dir, srcDir } = setupFixtureTree({ 'ws-history.js': BARE_ACTIVE_WRITE_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'bare activeSessionId write must fail')
    assert.match(stderr, /ws-history\.js:3/, 'error should name the offending file:line')
  })

  test('fails on a bare subscribedSessionIds.add outside the owner', () => {
    const { dir, srcDir } = setupFixtureTree({ 'handler-utils.js': BARE_SUBSCRIBE_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'bare subscribe must fail')
    assert.match(stderr, /handler-utils\.js:3/, 'error should name the offending file:line')
  })

  test('fails on whole-Set reassignment but not comparison', () => {
    const { dir, srcDir } = setupFixtureTree({ 'bad-replace.js': SET_REASSIGN_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'whole-Set reassignment must fail')
    assert.match(stderr, /bad-replace\.js:3/, 'should flag the reassignment line')
    assert.doesNotMatch(stderr, /bad-replace\.js:6/, 'comparison must not be flagged')
  })

  test('fails on bare delete and clear (two offenses)', () => {
    const { dir, srcDir } = setupFixtureTree({ 'bad.js': BARE_DELETE_CLEAR_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'bare delete/clear must fail')
    assert.match(stderr, /bad\.js:3/, 'should flag the delete line')
    assert.match(stderr, /bad\.js:4/, 'should flag the clear line')
  })

  test('respects the lint-ignore comment on a guarded fallback', () => {
    const { dir, srcDir } = setupFixtureTree({ 'ws-history.js': IGNORED_FALLBACK_SRC })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(srcDir)
    assert.equal(code, 0, `lint-ignore comment should suppress the offense\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('does not flag mutation patterns that appear only inside comments', () => {
    const { dir, srcDir } = setupFixtureTree({ 'doc.js': COMMENT_ONLY_SRC })
    cleanups.push(dir)
    const { code } = runLint(srcDir)
    assert.equal(code, 0, 'comment-only references must not be flagged')
  })

  test('does not flag mutation patterns inside a trailing inline // comment', () => {
    const { dir, srcDir } = setupFixtureTree({ 'doc.js': INLINE_COMMENT_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 0, `inline-comment references must not be flagged\nstderr:\n${stderr}`)
  })

  test('skips gitignored dashboard-next build artifacts', () => {
    const { dir, srcDir } = setupFixtureTree({ 'dashboard-next/dist/bundle.js': MINIFIED_BUNDLE_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 0, `gitignored dashboard-next/ must not be walked\nstderr:\n${stderr}`)
  })

  test('skips node_modules', () => {
    const { dir, srcDir } = setupFixtureTree({ 'node_modules/dep/index.js': NODE_MODULE_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 0, `node_modules must not be walked\nstderr:\n${stderr}`)
  })

  test('still recurses into ordinary subdirectories', () => {
    const { dir, srcDir } = setupFixtureTree({ 'handlers/bad.js': BARE_ACTIVE_WRITE_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'a real offender in a normal subdir must still fail')
    assert.match(stderr, /handlers[/\\]bad\.js:3/, 'should flag the nested offender with its path')
  })

  test('skips skip-dirs nested below the src root', () => {
    // The skip matches the directory's basename at every recursion level, not
    // just a child of src/. A transitive `node_modules/` under a normal source
    // dir must be skipped too — this pins the "skip at any depth" contract that a
    // root-only skip would silently break (the offender sits two levels down).
    const { dir, srcDir } = setupFixtureTree({ 'handlers/node_modules/dep/index.js': NODE_MODULE_SRC })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 0, `a skip-dir nested below src/ must still be skipped\nstderr:\n${stderr}`)
  })

  test('--dry-run reports offenders but exits 0', () => {
    const { dir, srcDir } = setupFixtureTree({ 'bad.js': BARE_ACTIVE_WRITE_SRC })
    cleanups.push(dir)
    const result = spawnSync(
      process.execPath,
      [LINT_SCRIPT, '--src-dir', srcDir, '--dry-run'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, '--dry-run should not fail the exit code')
    assert.match(result.stderr || '', /bad\.js:3/, '--dry-run should still print offenders')
  })
})
