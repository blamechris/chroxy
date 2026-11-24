/**
 * #8151 round-2 review (Critical 1) — exercises the PRODUCTION
 * `ptyMod = await import('node-pty')` branch of `_spawnPty` (claude-tui) and
 * `start()` (user-shell), not just the `_ptyModOverride` test seam.
 *
 * The round-2 review found that claude-tui-session.test.js's and
 * user-shell-session.test.js's "start() rejects with the actionable
 * node-pty-unavailable message" tests only ever set `_ptyModOverride` to a
 * throwing function — they never made the REAL dynamic import fail. The
 * reviewer proved this by reverting ONLY the production catch block in each
 * file (restoring the pre-#8151 bare rethrow) and running the full suite:
 * 51 files / 2229 tests stayed green, because nothing exercised that branch.
 *
 * Fixed here by running the real `start()` in a CHILD PROCESS with a
 * `node:module` `registerHooks` resolve hook that makes `import('node-pty')`
 * reject — see `fixtures/reject-node-pty-import.mjs` — loaded via `--import`
 * ahead of `fixtures/production-pty-import-child.mjs`, which constructs the
 * real session class (no override) and calls its real `start()`.
 *
 * The child process ALSO loads `tests/_setup.mjs` first (same sandboxed
 * test runner as every other server test — fs write sandbox +
 * CHROXY_CONFIG_DIR redirect) so this exercise never touches real user
 * state, per the review's explicit requirement.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import {
  snapshotClaudeJsonSiblings,
  assertNoNewClaudeJsonSiblings,
} from './helpers/claude-json-siblings-guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// #8151 round-2 review (Windows fallout, caught by CI after the review
// itself) — `--import` goes through Node's ESM loader, which REJECTS a
// bare Windows absolute path ("A:\foo\bar.mjs") with
// ERR_UNSUPPORTED_ESM_URL_SCHEME: "On Windows, absolute paths must be
// valid file:// URLs." `join(__dirname, ...)` produces exactly that bare
// form on Windows. `pathToFileURL(...).href` is the portable fix for
// `--import` specifically — a no-op on POSIX, a `file:///A:/...` URL on
// Windows.
//
// The MAIN SCRIPT argument (CHILD, below) must stay a PLAIN path, not a
// file:// URL: Node resolves the main-module argument through a different,
// older path-based mechanism than `--import`'s ESM loader, and handing it
// a `file://` URL made it try to resolve that URL STRING as a path
// relative to cwd (confirmed: it failed on macOS too, with "Cannot find
// module '<cwd>/file:/private/tmp/.../production-pty-import-child.mjs'").
const SETUP = pathToFileURL(join(__dirname, '_setup.mjs')).href
const HOOK = pathToFileURL(join(__dirname, 'fixtures', 'reject-node-pty-import.mjs')).href
const CHILD = join(__dirname, 'fixtures', 'production-pty-import-child.mjs')

// #8151 round-2 review (S-a) — `ClaudeTuiSession.start()`'s real code path
// calls `ensureCwdTrusted`, which reads/writes `homedir()/.claude.json`
// (claude-tui/pty-driver.js) — a plain `writeFileSync`/rename pair the
// in-process fs sandbox (tests/_setup.mjs) DOES catch when it runs in
// THIS process, but this harness deliberately runs it in a CHILD process,
// which inherits the real `HOME` (and so the real `homedir()`) unless told
// otherwise. The sandbox's rename-target check blocked the final
// `rename(tmp, ~/.claude.json)` (confirmed via its own logged WARN), but
// the INTERMEDIATE `~/.claude.json.chroxy.<uuid>.tmp` write that precedes
// the rename is a plain `writeFileSync` to a SIBLING path the sandbox's
// `protectedFiles` list (which names `~/.claude.json` exactly) does not
// cover — landing a stray file in the developer's real home directory.
// Fixed by giving the child its OWN fake `HOME` (so `homedir()` — and
// therefore `ensureCwdTrusted`'s every read/write — resolves entirely
// inside a disposable tmp dir), never the real one.
let fakeHome
// The guard helper takes the directory as a parameter, so the decoy tests
// below aim the very same assertion at a throwaway directory (#8945) instead
// of ever writing into the developer's real home.
const realHome = homedir()
let siblingsBefore

before(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-pty-prod-import-home-'))
  siblingsBefore = snapshotClaudeJsonSiblings(realHome)
})

after(() => {
  // The assertion that actually PROVES this harness left the developer's real
  // home alone — not merely that it intended to. #8945: this used to compare
  // the real ~/.claude.json mtime, which every concurrently running Claude
  // Code process (including the one driving this test) rewrites, so it went
  // red on clean changes. What the child could actually do wrong is drop a
  // `.claude.json.chroxy.<uuid>.tmp` sibling, so assert exactly that: no
  // `.claude.json.chroxy.*` name that was absent before the run exists after it.
  try {
    assertNoNewClaudeJsonSiblings(siblingsBefore, realHome)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

function runChild(target) {
  const stdout = execFileSync(
    process.execPath,
    ['--import', SETUP, '--import', HOOK, CHILD, target],
    { encoding: 'utf8', env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } },
  )
  // The child may log a WARN line (e.g. the sandboxed ensureCwdTrusted
  // best-effort write) ahead of its one JSON result line — take the LAST
  // non-blank line, not the whole stdout blob.
  const lines = stdout.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

describe("production import('node-pty') failure — real child process, no _ptyModOverride (#8151 round-2 Critical 1)", () => {
  it('ClaudeTuiSession.start() rejects with the actionable message when the REAL import(\'node-pty\') rejects', () => {
    const result = runChild('claude-tui')
    assert.equal(result.unexpectedSuccess, undefined, 'the real import must actually fail under the resolve hook')
    assert.equal(result.home, fakeHome, 'the child must resolve homedir() to the fake HOME, never the real one')
    assert.equal(result.code, 'PTY_UNAVAILABLE')
    assert.match(result.message, /^node-pty is unavailable/)
    assert.match(result.message, /claude-sdk/)
    assert.match(result.message, /simulated by reject-node-pty-import\.mjs/)
  })

  it('UserShellSession.start() rejects with the actionable message when the REAL import(\'node-pty\') rejects', () => {
    const result = runChild('user-shell')
    assert.equal(result.unexpectedSuccess, undefined, 'the real import must actually fail under the resolve hook')
    assert.equal(result.home, fakeHome, 'the child must resolve homedir() to the fake HOME, never the real one')
    assert.equal(result.code, 'PTY_UNAVAILABLE')
    assert.match(result.message, /^node-pty is unavailable/)
    assert.match(result.message, /claude-sdk/)
    assert.match(result.message, /simulated by reject-node-pty-import\.mjs/)
  })
})

// #8945 — prove the guard itself, against a DECOY "real home" (a mkdtemp dir).
// Nothing here may touch the developer's actual home directory.
describe('stray .claude.json sibling guard (#8945)', () => {
  let decoy
  before(() => { decoy = mkdtempSync(join(tmpdir(), 'chroxy-decoy-real-home-')) })
  after(() => { rmSync(decoy, { recursive: true, force: true }) })

  it('stays green when a concurrent process rewrites ~/.claude.json during the run', () => {
    const file = join(decoy, '.claude.json')
    writeFileSync(file, '{}')
    const snap = snapshotClaudeJsonSiblings(decoy)
    const t = new Date(Date.now() + 60_000)
    utimesSync(file, t, t) // another Claude Code process touched it
    writeFileSync(file, '{"touched":true}')
    assertNoNewClaudeJsonSiblings(snap, decoy)
  })

  it('stays green when Claude Code itself creates .claude.json.backup / .tmp.123 siblings during the run', () => {
    const snap = snapshotClaudeJsonSiblings(decoy)
    writeFileSync(join(decoy, '.claude.json.backup'), '{}')
    writeFileSync(join(decoy, '.claude.json.tmp.123'), '{}')
    assertNoNewClaudeJsonSiblings(snap, decoy)
  })

  it('goes red when a .claude.json.chroxy.<uuid>.tmp sibling appears during the run', () => {
    const snap = snapshotClaudeJsonSiblings(decoy)
    writeFileSync(join(decoy, '.claude.json.chroxy.0000-test.tmp'), '{}')
    assert.throws(
      () => assertNoNewClaudeJsonSiblings(snap, decoy),
      /\.claude\.json\.chroxy\.0000-test\.tmp/,
    )
  })

  it('does not blame this run for a stray sibling that already existed', () => {
    writeFileSync(join(decoy, '.claude.json.chroxy.preexisting.tmp'), '{}')
    const snap = snapshotClaudeJsonSiblings(decoy)
    assert.ok(snap.has('.claude.json.chroxy.preexisting.tmp'))
    assertNoNewClaudeJsonSiblings(snap, decoy)
  })

  it('refuses (does not pass vacuously) when the directory cannot be read', () => {
    assert.throws(() => snapshotClaudeJsonSiblings(join(decoy, 'does-not-exist')), /cannot snapshot/)
  })
})
