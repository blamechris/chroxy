import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * #8866 — `writeFileRestricted` does NOT throw when only the post-rename
 * directory fsync fails; it returns `{ durabilityUnconfirmed }`. The state
 * writer must keep that verdict, because the archive restore drops its other
 * copy on the strength of a durable write.
 */
let verdict = null
const calls = []
const real = await import('../src/platform.js')
mock.module('../src/platform.js', {
  namedExports: {
    ...real,
    writeFileRestricted: (path, data, opts) => {
      calls.push(opts)
      return { durabilityUnconfirmed: verdict }
    },
  },
})
const { SessionStatePersistence } = await import('../src/session-state-persistence.js')

describe('SessionStatePersistence durability verdict (#8866)', () => {
  let dir
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; calls.length = 0; verdict = null })
  const make = () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-persist-dur-'))
    return new SessionStatePersistence({ stateFilePath: join(dir, 'state.json') })
  }

  it('passes durable through and exposes an unconfirmed directory fsync', () => {
    const p = make()
    verdict = 'EIO: directory fsync failed'
    p.serializeState({ version: 1, sessions: [] }, { durable: true })
    assert.equal(calls[0].durable, true)
    assert.equal(p.lastDurabilityUnconfirmed, 'EIO: directory fsync failed')
  })

  it('a later confirmed write clears the verdict, and a non-durable write makes no claim', () => {
    const p = make()
    verdict = 'EIO'
    p.serializeState({ version: 1, sessions: [] }, { durable: true })
    verdict = null
    p.serializeState({ version: 1, sessions: [] }, { durable: true })
    assert.equal(p.lastDurabilityUnconfirmed, null)
    p.serializeState({ version: 1, sessions: [] })
    assert.equal(calls[2].durable, false)
  })
})
