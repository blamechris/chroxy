import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { homedir } from 'os'

import { resolveRepoSet, DEFAULT_CONTROL_ROOM_ROOT } from '../src/control-room/repo-set.js'

/**
 * Build a fake filesystem seam from a declarative tree description.
 *
 * @param {Object<string, string[]>} dirs - Map of dir path → entry names.
 * @param {Set<string>} gitPaths - Paths that exist as a `.git` entry.
 * @param {Object<string, string>} [realpaths] - Optional path → canonical override.
 * @returns {{ _readdir, _stat, _exists, _realpath }}
 */
function fakeFs(dirs, gitPaths, realpaths = {}) {
  return {
    _readdir: dir => {
      if (!(dir in dirs)) throw new Error(`ENOENT: ${dir}`)
      return dirs[dir]
    },
    _stat: p => {
      // Anything we listed as a directory key is a directory; subdir entries
      // (children listed under a parent) are directories too.
      const isDir = p in dirs || Object.values(dirs).some((entries, i) => {
        const parent = Object.keys(dirs)[i]
        return entries.some(e => join(parent, e) === p)
      })
      return { isDirectory: () => isDir }
    },
    _exists: p => gitPaths.has(p),
    _realpath: p => realpaths[p] || p,
  }
}

describe('resolveRepoSet', () => {
  it('returns config-only repos when discovery root is empty', () => {
    const fs = fakeFs({ '/root': [] }, new Set())
    const result = resolveRepoSet({
      repos: [{ path: '/work/alpha', name: 'alpha' }, { path: '/work/beta' }],
      root: '/root',
      ...fs,
    })
    assert.deepEqual(result, [
      { name: 'alpha', path: '/work/alpha' },
      { name: 'beta', path: '/work/beta' },
    ])
  })

  it('derives name from basename when config entry omits name', () => {
    const fs = fakeFs({ '/root': [] }, new Set())
    const result = resolveRepoSet({ repos: [{ path: '/work/my-repo' }], root: '/root', ...fs })
    assert.deepEqual(result, [{ name: 'my-repo', path: '/work/my-repo' }])
  })

  it('returns scan-only repos that contain a .git entry', () => {
    const dirs = { '/root': ['repo-a', 'repo-b', 'not-a-repo', 'file.txt'] }
    const gitPaths = new Set(['/root/repo-a/.git', '/root/repo-b/.git'])
    const result = resolveRepoSet({ repos: [], root: '/root', ...fakeFs(dirs, gitPaths) })
    assert.deepEqual(result, [
      { name: 'repo-a', path: '/root/repo-a' },
      { name: 'repo-b', path: '/root/repo-b' },
    ])
  })

  it('treats a .git file (worktree/submodule) as a repo', () => {
    const dirs = { '/root': ['wt'] }
    const gitPaths = new Set(['/root/wt/.git']) // _exists returns true regardless of file vs dir
    const result = resolveRepoSet({ repos: [], root: '/root', ...fakeFs(dirs, gitPaths) })
    assert.deepEqual(result, [{ name: 'wt', path: '/root/wt' }])
  })

  it('unions config and discovered repos', () => {
    const dirs = { '/root': ['scanned'] }
    const gitPaths = new Set(['/root/scanned/.git'])
    const result = resolveRepoSet({
      repos: [{ path: '/work/configured', name: 'configured' }],
      root: '/root',
      ...fakeFs(dirs, gitPaths),
    })
    assert.deepEqual(result, [
      { name: 'configured', path: '/work/configured' },
      { name: 'scanned', path: '/root/scanned' },
    ])
  })

  it('de-dupes by realpath, config entry winning over discovered', () => {
    // /root/shared (discovered) and /work/shared (config) realpath to the same
    // canonical path -> only the config entry survives, keeping its name.
    const dirs = { '/root': ['shared'] }
    const gitPaths = new Set(['/root/shared/.git'])
    const realpaths = {
      '/root/shared': '/canonical/shared',
      '/work/shared': '/canonical/shared',
    }
    const result = resolveRepoSet({
      repos: [{ path: '/work/shared', name: 'my-shared' }],
      root: '/root',
      ...fakeFs(dirs, gitPaths, realpaths),
    })
    assert.deepEqual(result, [{ name: 'my-shared', path: '/work/shared' }])
  })

  it('de-dupes duplicate config entries by realpath', () => {
    const realpaths = { '/a/repo': '/canon/repo', '/b/repo': '/canon/repo' }
    const fs = fakeFs({ '/root': [] }, new Set(), realpaths)
    const result = resolveRepoSet({
      repos: [{ path: '/a/repo', name: 'first' }, { path: '/b/repo', name: 'second' }],
      root: '/root',
      ...fs,
    })
    assert.deepEqual(result, [{ name: 'first', path: '/a/repo' }])
  })

  it('skips config entries with missing or invalid path', () => {
    const fs = fakeFs({ '/root': [] }, new Set())
    const result = resolveRepoSet({
      repos: [{ path: '/ok', name: 'ok' }, { name: 'no-path' }, null, { path: '' }],
      root: '/root',
      ...fs,
    })
    assert.deepEqual(result, [{ name: 'ok', path: '/ok' }])
  })

  it('returns empty when root is unreadable and no config repos', () => {
    const fs = fakeFs({}, new Set()) // /root not present -> _readdir throws
    const result = resolveRepoSet({ repos: [], root: '/root', ...fs })
    assert.deepEqual(result, [])
  })

  it('uses the default root (~/Projects) when none provided', () => {
    assert.equal(DEFAULT_CONTROL_ROOM_ROOT, join(homedir(), 'Projects'))

    const calls = []
    const result = resolveRepoSet({
      repos: [],
      _readdir: dir => {
        calls.push(dir)
        return [] // empty default root
      },
      _stat: () => ({ isDirectory: () => true }),
      _exists: () => false,
      _realpath: p => p,
    })
    assert.deepEqual(result, [])
    assert.deepEqual(calls, [DEFAULT_CONTROL_ROOM_ROOT])
  })
})
