import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { validateCwdAllowed, validateResolvedCwdAllowed } from '../src/handler-utils.js'
import { isPathWithin } from '../src/utils/path-containment.js'

// Windows TEMP can contain 8.3 names. Promise realpath and realpathSync.native
// expand them, while legacy realpathSync preserves ordinary short components.
// Model that spelling difference on every host, exercising the actual policy
// with real disposable directories and the native path returned by Browse.
describe('cwd policy uses the same native canonical paths as Browse', () => {
  const originalRealpathSync = fs.realpathSync
  let base, home, root, state, previousConfigDir
  beforeEach(() => {
    base = originalRealpathSync.native(fs.mkdtempSync(join(tmpdir(), 'cwd-native-')))
    home = join(base, 'home')
    root = join(base, 'workspace')
    state = join(root, 'daemon-state')
    for (const directory of [home, root, state, join(home, '.ssh'), join(home, 'project'), join(root, 'child')]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    previousConfigDir = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = state
    const legacy = mock.method(fs, 'realpathSync', (path, options) => {
      const canonical = originalRealpathSync.native(path, options)
      return isPathWithin(canonical, base)
        ? join(base, 'legacy-alias', relative(base, canonical))
        : canonical
    })
    legacy.native = originalRealpathSync.native
    syncBuiltinESMExports()
  })
  afterEach(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
    if (previousConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = previousConfigDir
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('matches native Browse targets against configured workspace roots', async () => {
    const config = { workspaceRoots: [root], homeOverride: home }
    for (const path of [root, join(root, 'child')]) {
      assert.equal(validateResolvedCwdAllowed(await realpath(path), config), null)
    }
    assert.notEqual(validateResolvedCwdAllowed(await realpath(home), config), null)
  })

  it('matches native Browse targets against the home fallback and credential boundary', async () => {
    const config = { homeOverride: home }
    assert.equal(validateResolvedCwdAllowed(await realpath(join(home, 'project')), config), null)
    assert.notEqual(validateResolvedCwdAllowed(await realpath(join(home, '.ssh')), config), null)
    assert.notEqual(validateResolvedCwdAllowed(await realpath(root), config), null)
  })

  it('canonicalizes explicit Create targets with the same native resolver', () => {
    assert.equal(validateCwdAllowed(root, { workspaceRoots: [root], homeOverride: home }), null)
  })

  it('retains the relocated daemon state boundary for native Browse targets', async () => {
    const config = { workspaceRoots: [root], homeOverride: home }
    assert.equal(validateResolvedCwdAllowed(await realpath(join(root, 'child')), config), null)
    assert.notEqual(validateResolvedCwdAllowed(await realpath(state), config), null)
  })
})
