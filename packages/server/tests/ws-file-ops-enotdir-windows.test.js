import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import * as realFsPromises from 'node:fs/promises'
import { join, sep, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * #7284 (second half) — a path THROUGH a regular file (`afile.txt/subdir`).
 *
 * POSIX answers ENOTDIR from `realpath` and `readdir`. Windows answers ENOENT
 * from both, so the handlers' ENOTDIR branch was never taken and the user read
 * "Directory not found" for a path whose parent exists and is a file. The
 * handlers now ask which of the two it really is when a listing fails ENOENT
 * (win32 only; POSIX already says ENOTDIR and the helper is a no-op there).
 *
 * Windows is simulated here, on every platform, by wrapping `fs/promises` so
 * that `realpath` / `readdir` / `lstat` / `stat` of any path through the
 * fixture file fail ENOENT exactly as the Windows runner measured. The module
 * mock is installed before the code under test is imported. A missing
 * `mock.module` fails this file LOUDLY: a skip would be a green that proves
 * nothing.
 */
assert.equal(typeof mock.module, 'function',
  'mock.module is unavailable: run with --experimental-test-module-mocks (the package test script passes it)')

const FILE_NAME = 'afile.txt'
const throughFile = (p) => typeof p === 'string' && p.includes(`${FILE_NAME}${sep}`)
const enoent = (p, syscall) => Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: 'ENOENT', syscall, path: p })

const windowsLike = {
  ...realFsPromises,
  realpath: (p, ...rest) => (throughFile(p) ? Promise.reject(enoent(p, 'realpath')) : realFsPromises.realpath(p, ...rest)),
  readdir: (p, ...rest) => (throughFile(p) ? Promise.reject(enoent(p, 'scandir')) : realFsPromises.readdir(p, ...rest)),
  lstat: (p, ...rest) => (throughFile(p) ? Promise.reject(enoent(p, 'lstat')) : realFsPromises.lstat(p, ...rest)),
  stat: (p, ...rest) => (throughFile(p) ? Promise.reject(enoent(p, 'stat')) : realFsPromises.stat(p, ...rest)),
}

/**
 * The handlers read the live platform, so the integration cases run as win32
 * for the duration of one call. On a real Windows runner this is a no-op.
 */
async function asWin32(fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...saved, value: 'win32' })
  try { return await fn() } finally { Object.defineProperty(process, 'platform', saved) }
}

let createFileOps
let notADirectoryError

before(async () => {
  mock.module('fs/promises', { namedExports: windowsLike })
  ;({ createFileOps } = await import('../src/ws-file-ops/index.js'))
  ;({ notADirectoryError } = await import('../src/ws-file-ops/common.js'))
})
after(() => mock.reset())


describe('#7284 ENOTDIR on a Windows-style ENOENT', () => {
  let tmp
  let sent
  let ops
  const ws = {}

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fileops-enotdir-')))
    writeFileSync(join(tmp, FILE_NAME), 'hello')
    mkdirSync(join(tmp, 'adir'))
    sent = []
    ops = createFileOps((_, msg) => sent.push(msg))
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('the simulated Windows really does answer ENOENT for a path through a file (control)', async () => {
    await assert.rejects(() => windowsLike.realpath(join(tmp, FILE_NAME, 'subdir')), (e) => e.code === 'ENOENT')
    await assert.rejects(() => windowsLike.readdir(join(tmp, FILE_NAME, 'subdir')), (e) => e.code === 'ENOENT')
  })

  it('browseFiles through a file says "Not a directory"', async () => {
    await asWin32(() => ops.browseFiles(ws, `${FILE_NAME}/subdir`, tmp))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].error, 'Not a directory')
  })

  it('browseFiles of a genuinely missing directory still says "Directory not found"', async () => {
    await asWin32(() => ops.browseFiles(ws, 'adir/missing', tmp))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].error, 'Directory not found')
  })

  it('browseFiles of a missing directory under a missing one still says "Directory not found"', async () => {
    await asWin32(() => ops.browseFiles(ws, 'nope/deeper', tmp))
    assert.equal(sent[0].error, 'Directory not found')
  })

  it('listDirectory through a file says "Not a directory" (home is the boundary)', async () => {
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    process.env.HOME = tmp
    process.env.USERPROFILE = tmp
    try {
      await asWin32(() => ops.listDirectory(ws, join(tmp, FILE_NAME, 'subdir')))
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile
    }
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'directory_listing')
    assert.equal(sent[0].error, 'Not a directory')
  })

  it('on a non-win32 platform the original ENOENT stands (the helper is a no-op)', async () => {
    // The simulated Windows ENOENT, but a POSIX platform: nothing may be probed
    // or reclassified, so the answer is main's, byte for byte.
    await ops.browseFiles(ws, `${FILE_NAME}/subdir`, tmp)
    assert.equal(sent[0].error, 'Directory not found')
  })
})

/** An in-memory filesystem that records every probe, for the helper's own contract. */
function memFs(entries) {
  const probes = []
  const get = (p) => entries[p]
  const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code, path: p })
  return {
    probes,
    lstat: async (p) => {
      probes.push(`lstat ${p}`)
      const e = get(p)
      if (!e) throw err('ENOENT', p)
      if (e.deny) throw err('EACCES', p)
      return { isSymbolicLink: () => e.type === 'link', isDirectory: () => e.type === 'dir' }
    },
    realpath: async (p) => {
      probes.push(`realpath ${p}`)
      const e = get(p)
      if (!e) throw err('ENOENT', p)
      return e.real ?? p
    },
  }
}

describe('#7284 notADirectoryError — contract, against an in-memory filesystem', () => {
  const ROOT = resolve(sep, 'ws')
  const OUTSIDE = resolve(sep, 'outside')
  const win32 = (fs) => ({ platform: 'win32', lstat: fs.lstat, realpath: fs.realpath })
  const outsideProbes = (fs) => fs.probes.filter((x) => !x.split(' ')[1].startsWith(ROOT))

  it('is true for a missing path whose deepest existing ancestor is a regular file', async () => {
    const fs = memFs({ [ROOT]: { type: 'dir' }, [join(ROOT, 'afile.txt')]: { type: 'file' } })
    assert.equal(await notADirectoryError(join(ROOT, 'afile.txt', 'a', 'b'), ROOT, win32(fs)), true)
    assert.deepEqual(outsideProbes(fs), [])
  })

  it('is false when the deepest existing ancestor is a directory', async () => {
    const fs = memFs({ [ROOT]: { type: 'dir' }, [join(ROOT, 'adir')]: { type: 'dir' } })
    assert.equal(await notADirectoryError(join(ROOT, 'adir', 'x', 'y'), ROOT, win32(fs)), false)
  })

  it('a path outside the boundary is declined WITHOUT a single probe', async () => {
    const fs = memFs({ [join(OUTSIDE, 'afile.txt')]: { type: 'file' } })
    assert.equal(await notADirectoryError(join(OUTSIDE, 'afile.txt', 'x'), ROOT, win32(fs)), false)
    assert.deepEqual(fs.probes, [], 'the walk probed a path outside the boundary and discarded the answer')
  })

  it('an unknown root declines without a probe', async () => {
    const fs = memFs({ [join(ROOT, 'afile.txt')]: { type: 'file' } })
    assert.equal(await notADirectoryError(join(ROOT, 'afile.txt', 'x'), null, win32(fs)), false)
    assert.deepEqual(fs.probes, [])
  })

  it('a parent swapped for a symlink after containment is declined, and its target is never probed', async () => {
    // /ws/probe was a plain missing directory when the caller contained
    // /ws/probe/missing; by walk time it is a link to /outside/x, a regular
    // file. Following it would answer "Not a directory" only if x exists.
    const fs = memFs({
      [ROOT]: { type: 'dir' },
      [join(ROOT, 'probe')]: { type: 'link', real: join(OUTSIDE, 'x') },
      [join(OUTSIDE, 'x')]: { type: 'file' },
    })
    assert.equal(await notADirectoryError(join(ROOT, 'probe', 'missing'), ROOT, win32(fs)), false)
    assert.deepEqual(fs.probes, [`lstat ${join(ROOT, 'probe')}`],
      'the walk went past the symlink or followed it')
  })

  it('a regular file reached through a symlinked ancestor above it is declined (realpath leaves the boundary)', async () => {
    const fs = memFs({
      [ROOT]: { type: 'dir' },
      [join(ROOT, 'lnk', 'afile.txt')]: { type: 'file', real: join(OUTSIDE, 'afile.txt') },
    })
    assert.equal(await notADirectoryError(join(ROOT, 'lnk', 'afile.txt', 'x'), ROOT, win32(fs)), false)
    assert.deepEqual(outsideProbes(fs), [])
  })

  it('a probe that fails for any other reason declines', async () => {
    const fs = memFs({ [join(ROOT, 'afile.txt')]: { type: 'file', deny: true } })
    assert.equal(await notADirectoryError(join(ROOT, 'afile.txt', 'x'), ROOT, win32(fs)), false)
  })

  for (const platform of ['darwin', 'linux', 'freebsd']) {
    it(`on ${platform} it answers false having made ZERO probes`, async () => {
      const fs = memFs({ [join(ROOT, 'afile.txt')]: { type: 'file' } })
      assert.equal(await notADirectoryError(join(ROOT, 'afile.txt', 'x'), ROOT,
        { platform, lstat: fs.lstat, realpath: fs.realpath }), false)
      assert.deepEqual(fs.probes, [])
    })
  }
})
