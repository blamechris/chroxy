import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import * as realFsPromises from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * #7284 (second half) — a path THROUGH a regular file (`afile.txt/subdir`).
 *
 * POSIX answers ENOTDIR from `realpath` and `readdir`. Windows answers ENOENT
 * from both, so the handlers' ENOTDIR branch was never taken and the user read
 * "Directory not found" for a path whose parent exists and is a file. The
 * handlers now ask which of the two it really is when a listing fails ENOENT.
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

let createFileOps
let notADirectoryError

describe('#7284 ENOTDIR on a Windows-style ENOENT', () => {
  let tmp
  let sent
  let ops
  const ws = {}

  before(async () => {
    mock.module('fs/promises', { namedExports: windowsLike })
    ;({ createFileOps } = await import('../src/ws-file-ops/index.js'))
    ;({ notADirectoryError } = await import('../src/ws-file-ops/common.js'))
  })
  after(() => mock.reset())

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
    await ops.browseFiles(ws, `${FILE_NAME}/subdir`, tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].error, 'Not a directory')
  })

  it('browseFiles of a genuinely missing directory still says "Directory not found"', async () => {
    await ops.browseFiles(ws, 'adir/missing', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].error, 'Directory not found')
  })

  it('browseFiles of a missing directory under a missing one still says "Directory not found"', async () => {
    await ops.browseFiles(ws, 'nope/deeper', tmp)
    assert.equal(sent[0].error, 'Directory not found')
  })

  it('listDirectory through a file says "Not a directory" (home is the boundary)', async () => {
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    process.env.HOME = tmp
    process.env.USERPROFILE = tmp
    try {
      await ops.listDirectory(ws, join(tmp, FILE_NAME, 'subdir'))
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile
    }
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'directory_listing')
    assert.equal(sent[0].error, 'Not a directory')
  })

  describe('notADirectoryError', () => {
    it('is true for a missing path whose deepest existing ancestor is a file', async () => {
      assert.equal(await notADirectoryError(join(tmp, FILE_NAME, 'a', 'b'), tmp), true)
    })

    it('is false when the deepest existing ancestor is a directory', async () => {
      assert.equal(await notADirectoryError(join(tmp, 'adir', 'x', 'y'), tmp), false)
    })

    it('never probes above the boundary it was given', async () => {
      // The file sits OUTSIDE the root: whether an ancestor out there is a file
      // is not the caller's to learn.
      const inner = join(tmp, 'adir')
      assert.equal(await notADirectoryError(join(tmp, FILE_NAME, 'x'), inner), false)
    })

    it('is false, never a throw, when the root is unknown', async () => {
      assert.equal(await notADirectoryError(join(tmp, FILE_NAME, 'x'), null), false)
    })
  })
})
