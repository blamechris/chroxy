import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { runAgainstFifoWithReader } from './helpers/fifo-with-reader.js'

// #7957 — write_file's EEXIST retry opens the target a second time. That open
// must refuse a non-regular target on its handle exactly like the first one.
// The race is forced with a module mock: the first openNoFollow call reports
// EEXIST, the second is the real function against a FIFO with a reader.
describe('write_file EEXIST retry open (#7957)', () => {
  const skip = process.platform === 'win32'
    ? 'no mkfifo on win32'
    : (typeof mock.module !== 'function' ? 'requires --experimental-test-module-mocks' : false)

  it('refuses a FIFO with a reader attached on the retry open and writes nothing', { skip }, async () => {
    const real = await import('../src/ws-file-ops/open-nofollow.js?real=7957')
    let calls = 0
    const openNoFollow = (...args) => {
      calls += 1
      if (calls === 1) return Promise.reject(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }))
      return real.openNoFollow(...args)
    }
    mock.module('../src/ws-file-ops/open-nofollow.js', { namedExports: { ...real, openNoFollow } })
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-write-eexist-'))
    const fifo = join(dir, 'evil.fifo')
    execFileSync('mkfifo', [fifo])
    try {
      const { createReaderOps } = await import(`../src/ws-file-ops/reader.js?cacheBust=7957-${Date.now()}`)
      const out = []
      const cache = new Map()
      const ops = createReaderOps(
        (_ws, msg) => out.push(msg),
        (cwd) => resolveSessionCwd(cwd, cache, 60_000),
        (abs, cwd) => validatePathWithinCwd(abs, cwd, cache, 60_000)
      )
      const piped = await runAgainstFifoWithReader(fifo, () => ops.writeFile({}, 'evil.fifo', 'secret-payload', dir))
      assert.equal(calls, 2, 'the retry open must have been reached')
      assert.equal(piped, '', 'nothing may be written into the pipe')
      assert.equal(out.length, 1)
      assert.equal(out[0].error, 'Not a regular file')
    } finally {
      mock.reset()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
