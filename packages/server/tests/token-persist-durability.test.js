import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistTokenToConfigFile } from '../src/server-cli.js'

/**
 * #7067 — the primary-token persist must keep #6965's operator-visible surface.
 *
 * #7067 changed `writeFileRestricted` so a POST-rename directory-fsync failure
 * REPORTS (`durabilityUnconfirmed`) instead of throwing: the rename already
 * published the file, so telling most callers "the write failed" is a lie.
 *
 * This caller is the deliberate exception. The revoke ack is gated on this
 * callback, and #6965 built a `REVOKE_NOT_DURABLE` frame for exactly this
 * outcome. If the caveat were swallowed here, the panic-button revoke would
 * report a CLEAN durable success while the new token's directory entry might not
 * survive a power loss — trading the old false-FAILURE for a false SUCCESS on the
 * single most consequential control in the daemon.
 */
describe('persistTokenToConfigFile durability (#7067)', () => {
  let dir, configFile
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-token-persist-'))
    configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ apiToken: 'old', port: 8765 }, null, 2))
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })

  it('a REVOKE whose write landed but is durability-unconfirmed RE-RAISES (so REVOKE_NOT_DURABLE fires)', () => {
    const write = (file, body) => {
      writeFileSync(file, body) // the write really lands — that is the whole point
      return { durabilityUnconfirmed: 'simulated dir fsync EIO' }
    }
    assert.throws(
      () => persistTokenToConfigFile(configFile, 'new-token', { durable: true, _write: write }),
      /could not be fsynced|simulated dir fsync/,
      'the caveat must reach #6965s rethrow, not die in a log line',
    )
    assert.equal(
      JSON.parse(readFileSync(configFile, 'utf-8')).apiToken, 'new-token',
      'and the token IS on disk — the throw is a durability caveat, not a failed write',
    )
  })

  it('a clean REVOKE persist does not throw', () => {
    const write = (file, body) => { writeFileSync(file, body); return { durabilityUnconfirmed: null } }
    assert.doesNotThrow(() => persistTokenToConfigFile(configFile, 'new-token', { durable: true, _write: write }))
    assert.equal(JSON.parse(readFileSync(configFile, 'utf-8')).apiToken, 'new-token')
  })

  it('a NON-durable (scheduled) rotation ignores the caveat — only the revoke opts in', () => {
    const write = (file, body) => {
      writeFileSync(file, body)
      return { durabilityUnconfirmed: 'should be ignored on the fail-safe path' }
    }
    assert.doesNotThrow(
      () => persistTokenToConfigFile(configFile, 'rotated', { durable: false, _write: write }),
      'a scheduled rotation is fail-safe: the old token works through its grace window',
    )
    assert.equal(JSON.parse(readFileSync(configFile, 'utf-8')).apiToken, 'rotated')
  })

  it('preserves the rest of config.json', () => {
    const write = (file, body) => { writeFileSync(file, body); return { durabilityUnconfirmed: null } }
    persistTokenToConfigFile(configFile, 'tok', { durable: true, _write: write })
    assert.equal(JSON.parse(readFileSync(configFile, 'utf-8')).port, 8765)
  })
})
