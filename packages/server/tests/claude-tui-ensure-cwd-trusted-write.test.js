/**
 * #7046 — write fidelity of `ensureCwdTrusted`, the DEFAULT provider's
 * `~/.claude.json` writer.
 *
 * `claude-tui` is DEFAULT_PROVIDER, and `ClaudeTuiSession.start()` calls
 * `ensureCwdTrusted(cwd)` on every start where the cwd is not already
 * trusted+onboarded — so this path rewrites `~/.claude.json` far more often than
 * the BYOK `add_mcp_server` path #7002 hardened. It had the SAME two defects, one
 * of them worse:
 *
 *  1. SYMLINK DESTRUCTION. `writeFileSync(tmp)` → `renameSync(tmp, claudeConfig)`
 *     replaces the final path component, so a dotfiles-repo
 *     `~/.claude.json -> ~/dotfiles/claude.json` was converted into a regular
 *     file: the user's link vanished and their real config stopped receiving
 *     updates.
 *  2. PERMISSION WIDENING. The sidecar was written with NO `mode` and never
 *     chmod'd, so the rename left `0666 & ~umask` — dropping a 0600 config
 *     holding OAuth material to 0644. (The MCP writer at least PRESERVED the
 *     mode; this one actively loosened it.)
 *
 * Every test points HOME at a mkdtemp dir — the real `~/.claude.json` is a
 * PROTECTED_FILE in `_setup.mjs`, so a regression that escaped the temp home
 * would trip the sandbox guard rather than touch the developer's config.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// `claude-tui-session.js` and `claude-tui/pty-driver.js` are a deliberate import
// CYCLE (the session imports `PtyDriverMixin`; the driver imports the class for
// its static tuning getters), and the mixin is applied at
// claude-tui-session.js's top level. Entering the cycle at the DRIVER therefore
// hits `applyMixin(ClaudeTuiSession, PtyDriverMixin)` while `PtyDriverMixin` is
// still in TDZ → `ReferenceError: Cannot access 'PtyDriverMixin' before
// initialization`. Pre-existing, and unrelated to what this file tests: importing
// the session module first fixes the evaluation order, which is also the order
// production uses (nothing imports the driver as an entry point).
import '../src/claude-tui-session.js'
import { ensureCwdTrusted } from '../src/claude-tui/pty-driver.js'

let dir
let fakeHome
let dotfilesDir
let projectDir
let realProjectDir
let linkPath
let targetPath
let origHome

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-tui-trust-'))
  fakeHome = join(dir, 'home')
  dotfilesDir = join(dir, 'dotfiles')
  projectDir = join(dir, 'project')
  mkdirSync(fakeHome)
  mkdirSync(dotfilesDir)
  mkdirSync(projectDir)
  // ensureCwdTrusted keys the projects map by realpathSync(cwd), and on macOS a
  // mkdtemp path resolves through /private — key the assertions the same way.
  realProjectDir = realpathSync(projectDir)
  linkPath = join(fakeHome, '.claude.json')
  targetPath = join(dotfilesDir, 'claude.json')
  origHome = process.env.HOME
  process.env.HOME = fakeHome
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const sidecars = (d) => readdirSync(d).filter((f) => f.includes('.chroxy.') && f.endsWith('.tmp'))

// An UNTRUSTED cwd — ensureCwdTrusted early-returns without writing when the
// project is already `hasTrustDialogAccepted && hasCompletedProjectOnboarding`,
// so every fixture below must leave the write to happen.
const UNTRUSTED = { numStartups: 7, projects: {} }

const writeConfig = (path, obj, mode) => {
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode })
  chmodSync(path, mode)
}

describe('#7046 ensureCwdTrusted: a symlinked ~/.claude.json is written THROUGH', () => {
  it('leaves the dotfiles link in place and lands the trust flags in the TARGET', () => {
    writeConfig(targetPath, UNTRUSTED, 0o600)
    symlinkSync(targetPath, linkPath)

    ensureCwdTrusted(projectDir)

    assert.equal(lstatSync(linkPath).isSymbolicLink(), true,
      'the user’s dotfiles symlink must survive the trust pre-write')
    assert.equal(readlinkSync(linkPath), targetPath, 'the link still points at the same target')

    const persisted = JSON.parse(readFileSync(targetPath, 'utf8'))
    const entry = persisted.projects?.[realProjectDir]
    assert.ok(entry,
      `the trust entry landed in the link TARGET (projects: ${Object.keys(persisted.projects || {}).join(', ')})`)
    assert.equal(entry.hasTrustDialogAccepted, true)
    assert.equal(entry.hasCompletedProjectOnboarding, true)
    assert.equal(persisted.numStartups, 7, 'unrelated keys in the real config survive')

    assert.deepEqual(sidecars(fakeHome), [], 'no sidecar left beside the link')
    assert.deepEqual(sidecars(dotfilesDir), [], 'no sidecar left beside the target')
  })

  it('refuses a DANGLING link instead of materializing a regular file over it', () => {
    const missing = join(dotfilesDir, 'missing.json')
    symlinkSync(missing, linkPath)

    // Best-effort by contract: the trust pre-write is skipped with a warning
    // rather than throwing, so session start still proceeds (claude may render
    // its trust dialog). What must NOT happen is the link being replaced.
    ensureCwdTrusted(projectDir)

    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the dangling link is left exactly as found')
    assert.equal(existsSync(missing), false, 'we never invent a file at the link’s chosen target')
    assert.deepEqual(sidecars(fakeHome), [])
    assert.deepEqual(sidecars(dotfilesDir), [])
  })

  // NOTE deliberately no "link to a directory / to another uid's file" case here.
  // Those refusals belong to `resolveClaudeConfigWritePath` and are pinned where
  // it lives (`byok-mcp-config-symlink-write.test.js`). Through THIS entry point a
  // directory link never reaches the writer at all — `readFileSync` fails with
  // EISDIR first and the function returns on its unreadable-config branch — so a
  // test here would pass identically with and without the fix, i.e. verify
  // nothing. The dangling case above is the one that genuinely reached the write.
})

describe('#7046 ensureCwdTrusted: the config’s mode is PRESERVED, never widened', () => {
  // Asserted over TWO distinct modes deliberately. The pre-fix write produced
  // `0666 & ~umask` — a single value on any given host — so a one-mode assertion
  // could pass by coincidence under some umask. No umask maps to both 0600 and
  // 0640, so this pair fails pre-fix on every host.
  for (const mode of [0o600, 0o640]) {
    it(`a 0${mode.toString(8)} config is still 0${mode.toString(8)} after the trust pre-write`, () => {
      writeConfig(linkPath, UNTRUSTED, mode)

      ensureCwdTrusted(projectDir)

      assert.equal(statSync(linkPath).mode & 0o777, mode,
        'the trust pre-write must not re-permission a file that holds OAuth material')
      const persisted = JSON.parse(readFileSync(linkPath, 'utf8'))
      assert.ok(persisted.projects?.[realProjectDir]?.hasTrustDialogAccepted, 'the write actually happened')
      assert.equal(persisted.numStartups, 7, 'the existing config was preserved, not clobbered')
    })
  }

  it('a 0600 symlink TARGET keeps 0600 (the mode is read through the link)', () => {
    writeConfig(targetPath, UNTRUSTED, 0o600)
    symlinkSync(targetPath, linkPath)

    ensureCwdTrusted(projectDir)

    assert.equal(statSync(targetPath).mode & 0o777, 0o600)
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true)
  })

  it('a config we CREATE is 0600, not umask-derived', () => {
    assert.equal(existsSync(linkPath), false)
    ensureCwdTrusted(projectDir)
    assert.equal(existsSync(linkPath), true, 'the first-write case still creates the file')
    assert.equal(statSync(linkPath).mode & 0o777, 0o600)
    assert.deepEqual(sidecars(fakeHome), [])
  })

  it('is still idempotent — an already trusted+onboarded cwd is not rewritten', () => {
    writeConfig(linkPath, {
      projects: { [realProjectDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }, 0o640)

    ensureCwdTrusted(projectDir)

    // A rewrite would normalize the entry (adding projectOnboardingSeenCount);
    // an untouched file still has exactly the two keys it started with.
    const persisted = JSON.parse(readFileSync(linkPath, 'utf8'))
    assert.deepEqual(Object.keys(persisted.projects[realProjectDir]).sort(),
      ['hasCompletedProjectOnboarding', 'hasTrustDialogAccepted'],
      'no write when the cwd is already trusted+onboarded')
  })
})
