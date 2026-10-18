import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { realpath, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { validateCwdAllowed } from '../src/handler-utils.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

// Every directory, including the fake credential directory, is disposable.
describe('Browse shares the Create cwd policy', () => {
  let base, home, root, outside, config
  beforeEach(() => {
    // Keep the runner's spelling, including Windows TEMP's 8.3 components.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'browse-roots-')))
    home = join(base, 'home')
    root = join(base, 'workspace')
    outside = join(base, 'outside')
    for (const dir of [home, root, outside, join(root, 'child'), join(home, '.ssh'), join(home, 'project')]) mkdirSync(dir, { recursive: true })
    config = { workspaceRoots: [root], homeOverride: home, cwd: root }
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  async function list(path, cfg = config) {
    const sent = []
    await createFileOps((_, msg) => sent.push(msg)).listDirectory(null, path, cfg)
    assert.equal(sent.length, 1)
    return sent[0]
  }
  it('echoes optional request nonces for allowed, denied, missing and normalized paths', async () => {
    for (const path of [root, root + '//child', outside, join(root, 'missing')]) {
      const sent = []
      await createFileOps((_, msg) => sent.push(msg)).listDirectory(null, path, config, 'check-current')
      assert.equal(sent[0].requestId, 'check-current')
    }
    assert.equal(Object.hasOwn(await list(root), 'requestId'), false)
  })
  it('lists an allowed root and child outside home, matching explicit Create', async () => {
    for (const path of [root, join(root, 'child'), await realpath(root)]) {
      assert.equal(validateCwdAllowed(path, config), null)
      assert.equal((await list(path)).error, null)
    }
    assert.deepEqual((await list(root)).entries.map(e => e.name), ['child'])
  })
  it('lists an allowed symlink target', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(join(root, 'child'), join(root, 'child-link'))
    assert.equal((await list(join(root, 'child-link'))).error, null)
  })
  it('starts blank Browse at the configured default cwd only when it is allowed', async () => {
    assert.equal((await list(undefined)).path, root)
    assert.equal((await list(undefined)).error, null)
    const denied = { ...config, cwd: outside }
    assert.notEqual(validateCwdAllowed(outside, denied), null)
    assert.match((await list(outside, denied)).error, /^Access denied/)
  })
  it('refuses outside roots, including existing and missing targets', async () => {
    for (const path of [outside, join(outside, 'missing'), join(home, 'project')]) {
      assert.notEqual(validateCwdAllowed(path, config), null)
      assert.match((await list(path)).error, /^Access denied/)
    }
  })
  it('refuses symlinks outside roots, including missing descendants', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(outside, join(root, 'escape'))
    for (const path of [join(root, 'escape'), join(root, 'escape', 'missing')]) {
      assert.notEqual(validateCwdAllowed(path, config), null)
      assert.match((await list(path)).error, /^Access denied/)
    }
  })
  it('keeps the credential deny-list even when home is an allowed workspace root', async () => {
    const cfg = { ...config, workspaceRoots: [home], cwd: join(home, '.ssh') }
    assert.equal((await list(join(home, 'project'), cfg)).error, null)
    for (const path of [join(home, '.ssh'), join(home, '.ssh', 'missing')]) {
      assert.notEqual(validateCwdAllowed(path, cfg), null)
      assert.match((await list(path, cfg)).error, /^Access denied/)
    }
  })
  it('refuses a symlink to a credential directory', { skip: SKIP_NO_SYMLINK }, async () => {
    const cfg = { ...config, workspaceRoots: [home] }
    symlinkSync(join(home, '.ssh'), join(home, 'credential-link'))
    assert.match((await list(join(home, 'credential-link'), cfg)).error, /^Access denied/)
  })
  it('keeps error classification within the same policy for non-directory targets', async (t) => {
    writeFileSync(join(root, 'file'), '')
    writeFileSync(join(outside, 'file'), '')
    const target = join(root, 'file', 'child')
    // Windows reports a missing path below a file; POSIX reports ENOTDIR.
    // Prove the actual filesystem result before expecting its Browse message.
    const expectedCode = process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR'
    let listingCode
    for (const [name, operation] of [['realpath', realpath], ['readdir', readdir]]) {
      await assert.rejects(operation(target), (err) => {
        assert.equal(err.code, expectedCode, `${name} file-child errno`)
        t.diagnostic(`${name} file-child errno: ${err.code}`)
        if (name === 'readdir') listingCode = err.code
        return true
      })
    }
    const expectedMessage = { ENOENT: 'Directory not found', ENOTDIR: 'Not a directory' }[listingCode]
    assert.equal((await list(target)).error, expectedMessage)
    assert.match((await list(join(outside, 'file', 'child'))).error, /^Access denied/)
  })
  it('refuses a symlink cycle', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync(join(root, 'loop'), join(root, 'loop'))
    assert.match((await list(join(root, 'loop'))).error, /^Access denied/)
  })
  it('refuses the relocated daemon config root even inside an allowed workspace', async () => {
    const state = join(root, 'daemon-state')
    mkdirSync(state)
    const previous = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = state
    try {
      assert.equal((await list(join(root, 'child'))).error, null)
      assert.match((await list(state)).error, /^Access denied/)
    } finally {
      if (previous === undefined) delete process.env.CHROXY_CONFIG_DIR
      else process.env.CHROXY_CONFIG_DIR = previous
    }
  })
  it('keeps home fallback without configured roots and rejects its outside sibling', async () => {
    const cfg = { homeOverride: home, cwd: join(home, 'project') }
    assert.equal((await list(undefined, cfg)).path, cfg.cwd)
    assert.equal((await list(cfg.cwd, cfg)).error, null)
    assert.match((await list(outside, cfg)).error, /^Access denied/)
    assert.equal((await list(join(home, 'missing'), cfg)).error, 'Directory not found')
  })
})
