import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { configuredCwdWarning, validateCwdAllowed } from '../src/handler-utils.js'
import { isPathWithin } from '../src/utils/path-containment.js'
import { OUTSIDE_HOME_DIR } from './helpers/outside-home.js'

/**
 * #8303 — Browse (`list_directory`) honours the allowlist session creation
 * honours: `workspaceRoots` when configured (which may sit outside $HOME), the
 * same credential-directory deny-list, and a startup warning when the configured
 * default cwd fails the same check.
 *
 * The outside-$HOME fixtures use os.tmpdir(), which is INSIDE the profile on
 * Windows; there the positive "root outside home" cases skip (the same cases run
 * on POSIX) rather than pass trivially.
 */
const TMP_IS_OUTSIDE_HOME = !isPathWithin(realpathSync(tmpdir()), realpathSync(homedir()))
const SKIP_TMP_INSIDE_HOME = TMP_IS_OUTSIDE_HOME ? false : 'os.tmpdir() is inside $HOME on this platform'

function listWith(config, requestedPath) {
  const sent = []
  const ops = createBrowserOps(
    (_ws, msg) => sent.push(msg),
    (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
    (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
    { getConfig: () => config },
  )
  return ops.listDirectory(null, requestedPath).then(() => {
    assert.equal(sent.length, 1, 'exactly one directory_listing reply')
    return sent[0]
  })
}

describe('Browse honours workspaceRoots (#8303)', () => {
  let root

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-test-8303-')))
    mkdirSync(join(root, 'proj-a', 'nested'), { recursive: true })
    mkdirSync(join(root, 'proj-b'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('without workspaceRoots a directory outside $HOME is refused (unchanged)', { skip: SKIP_TMP_INSIDE_HOME }, async () => {
    const reply = await listWith({}, root)
    assert.match(reply.error, /^Access denied: directory listing is restricted to the home directory$/)
    assert.deepEqual(reply.entries, [])
  })

  it('with workspaceRoots, Browse lists the root and its subdirectories', { skip: SKIP_TMP_INSIDE_HOME }, async () => {
    const config = { workspaceRoots: [root] }
    const top = await listWith(config, root)
    assert.equal(top.error, null)
    assert.deepEqual(top.entries.map(e => e.name), ['proj-a', 'proj-b'])
    const nested = await listWith(config, join(root, 'proj-a'))
    assert.equal(nested.error, null)
    assert.deepEqual(nested.entries.map(e => e.name), ['nested'])
  })

  it('a root the allowlist accepts is also a directory Create accepts (the two rules agree)', { skip: SKIP_TMP_INSIDE_HOME }, async () => {
    const config = { workspaceRoots: [root] }
    assert.equal(validateCwdAllowed(join(root, 'proj-a'), config), null)
    assert.equal((await listWith(config, join(root, 'proj-a'))).error, null)
  })

  it('a directory outside every root and outside $HOME is still refused, naming the roots', async () => {
    const reply = await listWith({ workspaceRoots: [root] }, OUTSIDE_HOME_DIR)
    assert.match(reply.error, /^Access denied: .*workspace roots/)
    assert.deepEqual(reply.entries, [])
  })

  it('a stale workspace root cannot match and does not break home browsing', async () => {
    const reply = await listWith({ workspaceRoots: [join(root, 'no-such-root')] }, homedir())
    assert.equal(reply.error, null)
    const outside = await listWith({ workspaceRoots: [join(root, 'no-such-root')] }, OUTSIDE_HOME_DIR)
    assert.match(outside.error, /^Access denied/)
  })

  it('the default cwd under a root is browsable, and one outside every root is not', { skip: SKIP_TMP_INSIDE_HOME }, async () => {
    const config = { workspaceRoots: [root], cwd: join(root, 'proj-b') }
    assert.equal(validateCwdAllowed(config.cwd, config), null)
    assert.equal((await listWith(config, config.cwd)).error, null)
    const stray = { workspaceRoots: [root], cwd: OUTSIDE_HOME_DIR }
    assert.notEqual(validateCwdAllowed(stray.cwd, stray), null)
    assert.match((await listWith(stray, stray.cwd)).error, /^Access denied/)
  })
})

describe('Browse applies the credential-directory deny-list (#8303)', () => {
  let home

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(homedir(), '.chroxy-test-8303-')))
    mkdirSync(join(home, '.ssh', 'keys'), { recursive: true })
    mkdirSync(join(home, 'projects'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // `homeOverride` points the DENY-LIST at the throwaway home; Browse's own $HOME
  // boundary is the real home, which contains the throwaway directory.
  const config = () => ({ homeOverride: home })

  it('refuses a credential directory and its children', async () => {
    for (const target of [join(home, '.ssh'), join(home, '.ssh', 'keys')]) {
      const reply = await listWith(config(), target)
      assert.match(reply.error, /^Access denied: credential and configuration directories/, target)
      assert.deepEqual(reply.entries, [])
    }
  })

  it('is case-insensitive about the credential directory name', async () => {
    const reply = await listWith(config(), join(home, '.SSH'))
    assert.match(reply.error, /^Access denied: credential and configuration directories/)
  })

  it('still lists an ordinary directory under the same home (control: the deny-list is not deny-everything)', async () => {
    const reply = await listWith(config(), join(home, 'projects'))
    assert.equal(reply.error, null)
  })
})

// A config dir spelled with different case than on disk only differs on a
// case-insensitive filesystem; elsewhere the variant simply does not exist.
function caseVariantResolves(p) {
  try { statSync(join(dirname(p), basename(p).toUpperCase())); return true } catch { return false }
}

describe('Browse refuses the daemon state root through a mis-cased CHROXY_CONFIG_DIR (#8303)', () => {
  let state
  let savedConfigDir

  beforeEach(() => {
    state = realpathSync(mkdtempSync(join(homedir(), '.chroxy-test-8303-state-')))
    mkdirSync(join(state, 'sessions'))
    savedConfigDir = process.env.CHROXY_CONFIG_DIR
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedConfigDir
    rmSync(state, { recursive: true, force: true })
  })

  it('refuses the state root and its children whatever the spelling of CHROXY_CONFIG_DIR', { skip: !caseVariantResolves(homedir()) && 'filesystem is case-sensitive' }, async () => {
    process.env.CHROXY_CONFIG_DIR = join(dirname(state), basename(state).toUpperCase())
    for (const target of [state, join(state, 'sessions')]) {
      const reply = await listWith({}, target)
      assert.match(reply.error, /^Access denied: credential and configuration directories/, target)
    }
  })

  it('refuses the state root spelled exactly as on disk (control: the plain case)', async () => {
    process.env.CHROXY_CONFIG_DIR = state
    const reply = await listWith({}, join(state, 'sessions'))
    assert.match(reply.error, /^Access denied: credential and configuration directories/)
  })
})

describe('configuredCwdWarning (#8303)', () => {
  it('is null with no configured cwd', () => {
    assert.equal(configuredCwdWarning({}), null)
    assert.equal(configuredCwdWarning(null), null)
  })

  it('is null for a configured cwd that passes the session-cwd check', () => {
    assert.equal(configuredCwdWarning({ cwd: homedir() }), null)
  })

  it('names the directory and the reason when the configured cwd fails the check', () => {
    const warning = configuredCwdWarning({ cwd: join(homedir(), 'chroxy-no-such-dir-8303') })
    assert.ok(warning && warning.includes('chroxy-no-such-dir-8303'), 'names the directory')
    assert.ok(warning.includes('does not exist'), 'carries the validateCwdAllowed reason')
    assert.ok(/blank cwd/.test(warning) && /Browse/.test(warning))
  })

  it('warns for a configured cwd outside every workspace root', () => {
    const warning = configuredCwdWarning({ cwd: OUTSIDE_HOME_DIR, workspaceRoots: [homedir()] })
    assert.ok(warning && warning.includes('workspace root'))
  })
})
