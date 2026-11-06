// Pins for how the installer writes settings.json:
//
//   - the temp file is created with the target mode, so it is never wider than
//     the target between the write and the rename
//   - Windows (simulated through the platform + exec seams): the owner-only ACL
//     is stamped on the EMPTY temp before any bytes land, and a failed stamp
//     writes nothing, renames nothing and leaves no temp behind
//   - a symlinked settings.json is written through only when its target is an
//     owned regular file
//   - a concurrent change between the read and the rename is merged, not lost
//
// Every test injects a temp `settingsPath` — never the real ~/.claude.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, openSync, rmSync, unlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installHooks, uninstallHooks } from '../src/installer.js'

const BIN = '/opt/somewhere/chroxy/packages/claude-hooks/bin/chroxy-hooks.js'
const NODE = '/usr/local/bin/node'

function tempDir(prefix = 'hooks-write-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function settingsAt(initial, mode) {
  const path = join(tempDir(), 'settings.json')
  if (initial !== undefined) {
    writeFileSync(path, initial)
    if (mode !== undefined) chmodSync(path, mode)
  }
  return path
}

function tmpFiles(path) {
  return readdirSync(dirname(path)).filter((n) => n.endsWith('.tmp'))
}

function withUmask(mask, fn) {
  const prev = process.umask(mask)
  try { return fn() } finally { process.umask(prev) }
}

const install = (settingsPath, _seams) => installHooks({ settingsPath, nodePath: NODE, binPath: BIN, _seams })

describe('settings temp file mode', () => {
  for (const [label, initial, mode, expected] of [
    ['a new file', undefined, undefined, 0o600],
    ['an existing 0600 file', JSON.stringify({ model: 'opus' }), 0o600, 0o600],
  ]) {
    it(`is never wider than the target for ${label}`, () => {
      withUmask(0o022, () => {
        const path = settingsAt(initial, mode)
        const seen = []
        const record = (stage) => ({ tmpPath }) => seen.push([stage, statSync(tmpPath).mode & 0o777])
        install(path, { hooks: { afterWrite: record('afterWrite'), beforeRename: record('beforeRename') } })
        assert.equal(seen.length, 2, 'both seams must fire')
        for (const [stage, m] of seen) {
          assert.equal(m & ~expected & 0o777, 0, `${stage}: temp mode ${m.toString(8)} is wider than ${expected.toString(8)}`)
        }
        assert.equal(statSync(path).mode & 0o777, expected)
      })
    })
  }

  it('restates the exact preserved mode when the umask would have stripped bits', () => {
    withUmask(0o077, () => {
      const path = settingsAt(JSON.stringify({ model: 'opus' }), 0o644)
      install(path)
      assert.equal(statSync(path).mode & 0o777, 0o644)
    })
  })

  for (const [label, initial, mode, expected] of [
    ['a new file', undefined, undefined, 0o600],
    ['an existing 0640 file', JSON.stringify({}), 0o640, 0o640],
    ['an existing read-only 0444 file', JSON.stringify({}), 0o444, 0o444],
  ]) {
    it(`creates the temp with exactly the target mode (${label})`, () => {
      const path = settingsAt(initial, mode)
      const created = []
      const open = (p, flags, m) => {
        if (String(p).endsWith('.tmp')) created.push([flags, m])
        return openSync(p, flags, m)
      }
      install(path, { open })
      assert.deepEqual(created, [['wx', expected]])
    })
  }

  it('applies a read-only preserved mode after the write', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }), 0o444)
    install(path)
    assert.equal(statSync(path).mode & 0o777, 0o444)
    assert.ok(JSON.parse(readFileSync(path, 'utf-8')).hooks.SessionStart)
  })

  it('leaves no temp file behind after a successful write', () => {
    const path = settingsAt(JSON.stringify({}))
    install(path)
    assert.deepEqual(tmpFiles(path), [])
  })
})

describe('Windows owner-only stamp (simulated)', () => {
  function fakeExec({ failWhoami = false, failIcacls = false, path } = {}) {
    const calls = []
    const exec = (file, args) => {
      const tool = /whoami/i.test(file) ? 'whoami' : 'icacls'
      const tmp = tmpFiles(path)
      calls.push({ tool, args, tmpSizes: tmp.map((n) => statSync(join(dirname(path), n)).size) })
      if (tool === 'whoami') {
        if (failWhoami) throw new Error('whoami boom')
        return '"HOST\\user","S-1-5-21-1-2-3-1001"\n'
      }
      if (failIcacls) throw new Error('icacls boom')
      return ''
    }
    return { exec, calls }
  }

  it('stamps the owner-only ACL on the empty temp before any bytes are written', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }))
    const { exec, calls } = fakeExec({ path })
    const sizesAtRename = []
    install(path, {
      platform: 'win32',
      exec,
      hooks: { beforeRename: ({ tmpPath }) => sizesAtRename.push(statSync(tmpPath).size) },
    })
    const icacls = calls.find((c) => c.tool === 'icacls')
    assert.ok(icacls, 'icacls was not invoked')
    assert.deepEqual(icacls.tmpSizes, [0], 'temp must exist and be empty when the ACL is stamped')
    assert.ok(icacls.args[0].endsWith('.tmp'), 'icacls targets the temp file')
    assert.deepEqual(icacls.args.slice(1), [
      '/inheritance:r',
      '/grant:r', '*S-1-5-21-1-2-3-1001:F',
      '/grant:r', '*S-1-5-18:F',
    ])
    assert.ok(sizesAtRename[0] > 0, 'bytes were written after the stamp')
    assert.ok(JSON.parse(readFileSync(path, 'utf-8')).hooks.SessionStart)
  })

  for (const [label, opts, message] of [
    ['whoami fails', { failWhoami: true }, /current-user SID/],
    ['icacls fails', { failIcacls: true }, /icacls could not restrict/],
  ]) {
    it(`fails closed when ${label}: nothing written, nothing renamed, no temp left`, () => {
      const original = JSON.stringify({ model: 'opus' })
      const path = settingsAt(original)
      const { exec, calls } = fakeExec({ path, ...opts })
      assert.throws(() => install(path, { platform: 'win32', exec }), message)
      assert.ok(calls.every((c) => c.tmpSizes.every((s) => s === 0)), 'bytes were written before the stamp')
      assert.equal(readFileSync(path, 'utf-8'), original, 'destination was replaced')
      assert.deepEqual(tmpFiles(path), [])
    })

    it(`fails closed for a new file when ${label}`, () => {
      const path = settingsAt(undefined)
      const { exec } = fakeExec({ path, ...opts })
      assert.throws(() => install(path, { platform: 'win32', exec }), message)
      assert.equal(existsSync(path), false)
      assert.deepEqual(tmpFiles(path), [])
    })
  }
})

describe('symlinked settings.json', () => {
  function link(targetSetup) {
    const store = tempDir('hooks-store-')
    const target = join(store, 'real-settings.json')
    targetSetup(target)
    const linkPath = join(tempDir('hooks-link-'), 'settings.json')
    try { symlinkSync(target, linkPath) } catch { return null }
    return { target, linkPath }
  }

  it('refuses a link whose target is owned by another uid', (t) => {
    const l = link((p) => writeFileSync(p, JSON.stringify({ model: 'opus' })))
    if (!l) return t.skip('symlinks unavailable')
    const before = readFileSync(l.target, 'utf-8')
    const uid = process.getuid()
    assert.throws(() => install(l.linkPath, { getuid: () => uid + 1 }), /owned by uid/)
    assert.equal(readFileSync(l.target, 'utf-8'), before)
    assert.equal(lstatSync(l.linkPath).isSymbolicLink(), true)
    assert.deepEqual(tmpFiles(l.target), [])
  })

  it('refuses a link whose target is not a regular file', (t) => {
    const l = link((p) => mkdirSync(p))
    if (!l) return t.skip('symlinks unavailable')
    assert.throws(() => install(l.linkPath), /not a regular file/)
    assert.equal(lstatSync(l.linkPath).isSymbolicLink(), true)
    assert.equal(statSync(l.target).isDirectory(), true)
  })

  it('refuses a dangling link instead of creating its target', (t) => {
    const l = link(() => {})
    if (!l) return t.skip('symlinks unavailable')
    assert.throws(() => install(l.linkPath), /cannot be resolved/)
    assert.equal(existsSync(l.target), false)
  })

  it('still writes through a link to a target the user owns', (t) => {
    const l = link((p) => { writeFileSync(p, JSON.stringify({ model: 'opus' })); chmodSync(p, 0o600) })
    if (!l) return t.skip('symlinks unavailable')
    install(l.linkPath)
    assert.equal(lstatSync(l.linkPath).isSymbolicLink(), true)
    const written = JSON.parse(readFileSync(l.target, 'utf-8'))
    assert.equal(written.model, 'opus')
    assert.ok(written.hooks.SessionStart)
    assert.equal(statSync(l.target).mode & 0o777, 0o600)
  })

  it('refuses a foreign-uid target on uninstall too', (t) => {
    const l = link((p) => writeFileSync(p, JSON.stringify({ model: 'opus' })))
    if (!l) return t.skip('symlinks unavailable')
    assert.throws(() => uninstallHooks({ settingsPath: l.linkPath, _seams: { getuid: () => process.getuid() + 1 } }), /owned by uid/)
  })
})

describe('concurrent change to settings.json', () => {
  it('re-merges from the fresh file instead of losing the other writer\'s update', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }))
    let fired = 0
    install(path, {
      hooks: {
        beforeRename: () => {
          if (fired++ === 0) writeFileSync(path, JSON.stringify({ model: 'opus', theme: 'dark' }))
        },
      },
    })
    const result = JSON.parse(readFileSync(path, 'utf-8'))
    assert.equal(result.theme, 'dark', 'the concurrent update was lost')
    assert.ok(result.hooks.SessionStart)
    assert.equal(fired, 2)
    assert.deepEqual(tmpFiles(path), [])
  })

  it('gives up after exactly 5 attempts and leaves the destination and directory clean', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }))
    let n = 0
    assert.throws(() => install(path, {
      hooks: { beforeRename: () => writeFileSync(path, JSON.stringify({ model: 'opus', n: n++ })) },
    }), /kept changing/)
    assert.equal(n, 5)
    assert.equal(JSON.parse(readFileSync(path, 'utf-8')).hooks, undefined)
    assert.deepEqual(tmpFiles(path), [])
  })

  it('treats a mode-only change as a conflict and re-merges with the fresh mode', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }), 0o644)
    let fired = 0
    install(path, {
      hooks: { beforeRename: () => { if (fired++ === 0) chmodSync(path, 0o600) } },
    })
    assert.equal(fired, 2, 'the mode change must force a second attempt')
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the concurrent tightening was undone')
    assert.ok(JSON.parse(readFileSync(path, 'utf-8')).hooks.SessionStart)
    assert.deepEqual(tmpFiles(path), [])
  })

  it('follows a parent directory link retargeted before the rename, leaving no orphan temp', (t) => {
    const root = tempDir('hooks-parent-')
    const a = join(root, 'A')
    const b = join(root, 'B')
    mkdirSync(a)
    mkdirSync(b)
    const same = JSON.stringify({ model: 'opus' })
    writeFileSync(join(a, 'settings.json'), same)
    writeFileSync(join(b, 'settings.json'), same)
    const config = join(root, 'config')
    try { symlinkSync(a, config) } catch { return t.skip('symlinks unavailable') }
    let fired = 0
    install(join(config, 'settings.json'), {
      hooks: {
        beforeRename: () => {
          if (fired++ === 0) { unlinkSync(config); symlinkSync(b, config) }
        },
      },
    })
    assert.deepEqual(tmpFiles(join(a, 'settings.json')), [], 'temp orphaned in the old directory')
    assert.deepEqual(tmpFiles(join(b, 'settings.json')), [])
    assert.equal(readFileSync(join(a, 'settings.json'), 'utf-8'), same, 'old directory was written')
    assert.ok(JSON.parse(readFileSync(join(b, 'settings.json'), 'utf-8')).hooks.SessionStart)
  })
})

describe('temp file cleanup', () => {
  it('surfaces a failed unlink (not ENOENT) with the temp path and stops retrying', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }))
    let renames = 0
    let n = 0
    const unlink = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) }
    assert.throws(() => install(path, {
      unlink,
      hooks: { beforeRename: () => { renames++; writeFileSync(path, JSON.stringify({ n: n++ })) } },
    }), (err) => /could not remove temp file .*\.tmp: EPERM/.test(err.message))
    assert.equal(renames, 1, 'retried after a cleanup failure')
    rmSync(dirname(path), { recursive: true, force: true })
  })

  it('ignores an unlink that finds the temp already gone', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }))
    let fired = 0
    const unlink = (p) => { unlinkSync(p); throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
    install(path, {
      unlink,
      hooks: { beforeRename: () => { if (fired++ === 0) writeFileSync(path, JSON.stringify({ x: 1 })) } },
    })
    assert.equal(JSON.parse(readFileSync(path, 'utf-8')).x, 1)
  })

  it('reports a temp that cannot be removed after a Windows stamp failure', () => {
    const path = settingsAt(JSON.stringify({ model: 'opus' }))
    const exec = () => { throw new Error('whoami boom') }
    const unlink = () => { throw Object.assign(new Error('nope'), { code: 'EBUSY' }) }
    assert.throws(() => install(path, { platform: 'win32', exec, unlink }), /could not remove temp file .*EBUSY/)
  })
})

describe('uninstall with no settings file', () => {
  it('touches nothing: no parent directories are created', () => {
    const root = tempDir('hooks-missing-')
    const path = join(root, 'deep', 'er', 'settings.json')
    uninstallHooks({ settingsPath: path })
    assert.equal(existsSync(join(root, 'deep')), false)
  })

  it('creates no file in an existing directory', () => {
    const path = join(tempDir('hooks-missing-'), 'settings.json')
    uninstallHooks({ settingsPath: path })
    assert.deepEqual(readdirSync(dirname(path)), [])
  })

  it('install still creates missing parent directories', () => {
    const path = join(tempDir('hooks-missing-'), 'deep', 'settings.json')
    install(path)
    assert.ok(JSON.parse(readFileSync(path, 'utf-8')).hooks.SessionStart)
  })
})
