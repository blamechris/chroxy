import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// #8018 — browse_files / list_directory outer catches. A code with no mapping
// (EIO here) is unreachable with real files on a healthy disk, so the readdir
// failure is injected. Needs --experimental-test-module-mocks (the CI command).

const HAVE_MOCKS = typeof mock.module === 'function'

describe('browser outer catches report no absolute path for an unmapped fs failure (#8018)', { skip: !HAVE_MOCKS && 'needs --experimental-test-module-mocks' }, () => {
  let tmp
  let sent
  let ops
  const ws = {}

  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fileops-8018i-')))
    mkdirSync(join(tmp, 'sub'))
    sent = []
    const realFsp = await import('node:fs/promises')
    const mockFsp = {
      ...realFsp,
      readdir: async (p, ...rest) => {
        if (String(p).endsWith('sub')) {
          throw Object.assign(new Error(`EIO: i/o error, scandir '${p}'`), { code: 'EIO' })
        }
        return realFsp.readdir(p, ...rest)
      },
    }
    mock.module('fs/promises', { defaultExport: mockFsp, namedExports: mockFsp })
    const realOs = await import('node:os')
    const mockOs = { ...realOs, homedir: () => tmp }
    mock.module('os', { defaultExport: mockOs, namedExports: mockOs })
    const { createFileOps } = await import(`../src/ws-file-ops/index.js?cacheBust=8018-${Date.now()}-${Math.random()}`)
    ops = createFileOps((_, msg) => sent.push(msg), tmp)
  })

  afterEach(() => {
    mock.reset()
    rmSync(tmp, { recursive: true, force: true })
  })

  function assertSafe(text) {
    assert.equal(text, 'Operation failed')
    assert.ok(!text.includes(tmp), 'leaks the temp root')
  }

  it('browse_files', async () => {
    await ops.browseFiles(ws, 'sub', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_listing')
    assertSafe(sent[0].error)
  })

  it('list_directory', async () => {
    await ops.listDirectory(ws, join(tmp, 'sub'))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'directory_listing')
    assertSafe(sent[0].error)
  })
})
