import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { resolveDefaultCwd } from '../src/server-cli.js'
import { validateCwdAllowed } from '../src/handler-utils.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { POSIX_PERM_SKIP } from './test-helpers.js'

describe('directory listings use the session workspace policy', () => {
  let base, home, workspace, outside, config, ops, sent, savedEnv
  beforeEach(() => {
    // Retain the JS realpath spelling: Windows CI supplies an 8.3 temp path,
    // so these fixtures exercise a different spelling from native realpath.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'browse-policy-')))
    home = join(base, 'home')
    workspace = join(base, 'workspace')
    outside = join(base, 'outside')
    for (const path of [home, workspace, outside]) mkdirSync(path)
    mkdirSync(join(workspace, 'project'))
    mkdirSync(join(home, 'project'))
    savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CHROXY_CONFIG_DIR'].map(key => [key, process.env[key]]))
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.CHROXY_CONFIG_DIR = join(base, 'state')
    mkdirSync(process.env.CHROXY_CONFIG_DIR)
    config = { homeOverride: home, workspaceRoots: [workspace], cwd: workspace }
    sent = []
    ops = createFileOps((_ws, message) => sent.push(message))
  })
  afterEach(() => {
    try { chmodSync(join(workspace, 'unreadable'), 0o700) } catch {}
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(base, { recursive: true, force: true })
  })
  async function list(path, policy = config) {
    sent.length = 0
    await ops.listDirectory(null, path, policy)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'directory_listing')
    return sent[0]
  }

  it('warns about a rejected configured default without changing blank-create compatibility', () => {
    const warnings = []
    const cwd = resolveDefaultCwd({ ...config, cwd: outside }, { warn: message => warnings.push(message) })
    assert.equal(cwd, outside)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('cannot be browsed or used explicitly'))
    assert.ok(warnings[0].includes('workspaceRoots'))
    warnings.length = 0
    assert.equal(resolveDefaultCwd(config, { warn: message => warnings.push(message) }), workspace)
    assert.deepEqual(warnings, [])
  })
  it('warns when the computed default is outside the configured roots', (t) => {
    // Make this branch deterministic even when cwd and HOME are on different
    // Windows drives; that unrelated default-selection behavior is not this test.
    t.mock.method(process, 'cwd', () => home)
    const warnings = []
    assert.equal(resolveDefaultCwd({ homeOverride: home, workspaceRoots: [workspace] }, { warn: message => warnings.push(message) }), home)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('cannot be browsed or used explicitly'))
  })
  it('echoes the request id for success and error listings after path normalization', async () => {
    for (const path of [workspace + '//project/..', join(outside, 'missing')]) {
      sent.length = 0
      await ops.listDirectory(null, path, config, 'directory-1')
      assert.equal(sent[0].requestId, 'directory-1')
    }
  })
  it('lists a configured workspace and default cwd outside home, matching explicit create validation', async () => {
    assert.equal(validateCwdAllowed(workspace, config), null)
    const reply = await list(config.cwd)
    assert.equal(reply.error, null)
    assert.deepEqual(reply.entries.map(entry => entry.name), ['project'])
  })
  it('applies the same policy to native paths and equivalent alias spellings', async (t) => {
    const alias = join(base, 'alias')
    // Junctions need no symlink privilege on Windows; on POSIX this is a normal
    // directory symlink. Both spellings must physically name the same target.
    symlinkSync(base, alias, 'junction')
    assert.equal(await realpath(alias), await realpath(base))
    const aliasHome = join(alias, 'home')
    const aliasWorkspace = join(alias, 'workspace')
    const aliasOutside = join(alias, 'outside')
    const aliasPolicy = { ...config, homeOverride: aliasHome, workspaceRoots: [aliasWorkspace] }
    process.env.CHROXY_CONFIG_DIR = join(alias, 'state')

    // Emulate Windows JS realpath retaining an alias, while native/async
    // realpath expands it. This reproduces that difference on POSIX too.
    const original = fs.realpathSync
    const mocked = t.mock.method(fs, 'realpathSync', (path, ...args) => {
      const resolved = original(path, ...args)
      return resolved === base || resolved.startsWith(base + sep)
        ? alias + resolved.slice(base.length)
        : resolved
    })
    mocked.native = original.native
    syncBuiltinESMExports()
    try {
      assert.equal(validateCwdAllowed(aliasWorkspace, aliasPolicy), null)
      assert.equal((await list(aliasWorkspace, aliasPolicy)).error, null)
      assert.ok(validateCwdAllowed(aliasOutside, aliasPolicy))
      assert.ok((await list(aliasOutside, aliasPolicy)).error?.startsWith('Access denied'))
      assert.equal((await list(aliasHome, { ...aliasPolicy, workspaceRoots: [] })).error, null)
      mkdirSync(join(home, '.ssh'))
      assert.ok((await list(join(aliasHome, '.ssh'), { ...aliasPolicy, workspaceRoots: [aliasHome] })).error?.startsWith('Access denied'))
      assert.ok((await list(process.env.CHROXY_CONFIG_DIR, { ...aliasPolicy, workspaceRoots: [alias] })).error?.startsWith('Access denied'))
    } finally {
      mocked.mock.restore()
      syncBuiltinESMExports()
    }
  })
  it('forwards the current runtime config on every request', async () => {
    let pending
    const ctx = { services: { fileOps: { listDirectory: (...args) => { pending = ops.listDirectory(...args) } }, config } }
    fileHandlers.list_directory(null, {}, { path: workspace }, ctx)
    await pending
    assert.equal(sent.at(-1).error, null)
    ctx.services.config = { ...config, workspaceRoots: [outside] }
    fileHandlers.list_directory(null, {}, { path: workspace }, ctx)
    await pending
    assert.ok(sent.at(-1).error?.startsWith('Access denied'))
  })
  it('rejects an in-home path outside explicit roots, even when it is the configured default', async () => {
    config.cwd = home
    assert.ok(validateCwdAllowed(home, config))
    assert.ok((await list(home)).error?.startsWith('Access denied'))
  })
  it('retains home fallback when no roots are configured, without adding an outside default to the allowlist', async () => {
    config.workspaceRoots = []
    assert.equal((await list(home)).error, null)
    assert.ok((await list(config.cwd)).error?.startsWith('Access denied'))
  })
  it('rejects credential directories even under an explicit workspace root', async () => {
    config.workspaceRoots = [home]
    const credentialDir = join(home, '.ssh')
    mkdirSync(credentialDir)
    assert.ok((await list(credentialDir)).error?.startsWith('Access denied'))
  })
  it('rejects the relocated config root even when its parent is allowlisted', async () => {
    config.workspaceRoots = [base]
    assert.ok((await list(process.env.CHROXY_CONFIG_DIR)).error?.startsWith('Access denied'))
  })
  it('uses canonical targets for symlinks and retains the same policy for missing targets', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(workspace, join(home, 'allowed-link'), 'dir')
    symlinkSync(outside, join(workspace, 'outside-link'), 'dir')
    assert.equal((await list(join(home, 'allowed-link'))).error, null)
    assert.equal((await list(join(home, 'allowed-link', 'missing'))).error, 'Directory not found')
    const existing = await list(join(workspace, 'outside-link'))
    const missing = await list(join(workspace, 'outside-link', 'missing'))
    assert.ok(existing.error?.startsWith('Access denied'))
    assert.equal(missing.error, existing.error)
  })
  it('reports in-policy missing targets and non-directory paths without granting a listing', async () => {
    assert.equal((await list(join(workspace, 'missing'))).error, 'Directory not found')
    writeFileSync(join(workspace, 'file'), 'fixture')
    const reply = await list(join(workspace, 'file', 'child'))
    // Windows native realpath reports ENOENT through a file; POSIX reports ENOTDIR.
    assert.equal(reply.error, process.platform === 'win32' ? 'Directory not found' : 'Not a directory')
    assert.deepEqual(reply.entries, [])
  })
  it('reports in-policy unreadable targets without exposing outside path state', { skip: POSIX_PERM_SKIP }, async () => {
    mkdirSync(join(workspace, 'unreadable'))
    chmodSync(join(workspace, 'unreadable'), 0o000)
    assert.equal((await list(join(workspace, 'unreadable', 'child'))).error, 'Permission denied')
    assert.ok((await list(join(outside, 'missing'))).error?.startsWith('Access denied'))
  })
})
