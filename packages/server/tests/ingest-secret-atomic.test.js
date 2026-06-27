import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadOrCreateIngestSecret } from '../src/event-ingest.js'

/**
 * Swarm-audit hardening: loadOrCreateIngestSecret used a non-atomic
 * existsSync+write check-then-act, so two concurrent first-starts could each
 * generate a DIFFERENT secret (the last writer won, silently invalidating the
 * first). The fix uses an atomic exclusive-create ('ax') so the first writer
 * wins and losers re-read it, while still recovering an empty/corrupt file.
 */
describe('loadOrCreateIngestSecret — atomic create (swarm-audit race fix)', () => {
  let dir
  let secretPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-ingest-'))
    secretPath = join(dir, 'ingest-secret')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates + persists a secret when missing, owner-only (0600)', () => {
    const s = loadOrCreateIngestSecret(secretPath)
    assert.equal(typeof s, 'string')
    assert.ok(s.length > 0)
    assert.equal(readFileSync(secretPath, 'utf-8').trim(), s)
    if (process.platform !== 'win32') {
      // no group/other access
      assert.equal(statSync(secretPath).mode & 0o077, 0)
    }
  })

  it('is idempotent — a second call returns the same persisted secret', () => {
    const a = loadOrCreateIngestSecret(secretPath)
    const b = loadOrCreateIngestSecret(secretPath)
    assert.equal(a, b)
  })

  it('returns a pre-existing secret verbatim (the loser re-read path)', () => {
    writeFileSync(secretPath, 'preexisting-secret\n', { mode: 0o600 })
    assert.equal(loadOrCreateIngestSecret(secretPath), 'preexisting-secret')
  })

  it('regenerates over an empty/corrupt file (recovery, not the concurrent race)', () => {
    writeFileSync(secretPath, '', { mode: 0o600 })
    const s = loadOrCreateIngestSecret(secretPath)
    assert.ok(s.length > 0)
    assert.equal(readFileSync(secretPath, 'utf-8').trim(), s)
  })
})
