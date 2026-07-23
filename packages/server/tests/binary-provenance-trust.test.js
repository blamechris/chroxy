import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  BinaryProvenanceLedger,
  DEFAULT_BINARY_TRUST_FILE,
  binaryTrustFileExists,
} from '../src/binary-provenance-trust.js'

/**
 * Unit tests for the provider-binary provenance pin ledger (#6858) — a thin
 * subclass of the well-tested PathHashTrustLedger. Exercises the wiring
 * (wrapper key, approval field, best-effort flush) and the pin lifecycle over a
 * temp file so the real ~/.chroxy/binary-trust.json is never touched.
 */

const sha = (s) => createHash('sha256').update(s).digest('hex')
const HASH_A = sha('binary-a')
const HASH_B = sha('binary-b')

describe('BinaryProvenanceLedger (#6858)', () => {
  let dir
  let ledgerPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-binary-trust-'))
    ledgerPath = join(dir, 'binary-trust.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults its file to ~/.chroxy/binary-trust.json', () => {
    assert.match(DEFAULT_BINARY_TRUST_FILE, /\.chroxy[/\\]binary-trust\.json$/)
  })

  it('pins on approve and reports the record as trusted', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    assert.equal(led.getRecord('/opt/homebrew/bin/codex'), null)
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_A), false)

    assert.equal(led.approve('/opt/homebrew/bin/codex', HASH_A), true)
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_A), true)
    const rec = led.getRecord('/opt/homebrew/bin/codex')
    assert.equal(rec.sha256, HASH_A)
    assert.ok(rec.firstSeen)
    assert.ok(rec.approvedAt)
  })

  it('a changed hash is no longer trusted until re-approved (re-gate)', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve('/opt/homebrew/bin/codex', HASH_A)
    // Binary swapped: the new hash does not match the pinned one.
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_B), false)
    // Operator re-approves the new hash.
    led.approve('/opt/homebrew/bin/codex', HASH_B)
    assert.equal(led.isTrusted('/opt/homebrew/bin/codex', HASH_B), true)
  })

  it('persists to disk under the "binaries" wrapper key at mode 0600', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve('/opt/homebrew/bin/codex', HASH_A)
    assert.ok(binaryTrustFileExists(ledgerPath))
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    assert.ok(parsed.binaries, 'on-disk shape wraps records under "binaries"')
    assert.equal(parsed.binaries['/opt/homebrew/bin/codex'].sha256, HASH_A)
    // POSIX: owner-only permissions on the sidecar.
    if (process.platform !== 'win32') {
      const mode = statSync(ledgerPath).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })

  it('reloads a persisted ledger from disk', () => {
    const first = new BinaryProvenanceLedger({ filePath: ledgerPath })
    first.approve('/opt/homebrew/bin/codex', HASH_A)
    const second = new BinaryProvenanceLedger({ filePath: ledgerPath })
    assert.equal(second.isTrusted('/opt/homebrew/bin/codex', HASH_A), true)
  })

  it('fails open to an empty ledger on a corrupt file', () => {
    writeFileSync(ledgerPath, '{ this is not valid json', 'utf8')
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    // A corrupt ledger must not lock every binary out — it loads empty.
    assert.equal(led.getRecord('/opt/homebrew/bin/codex'), null)
  })

  it('revoke drops the record so the binary re-gates', () => {
    const led = new BinaryProvenanceLedger({ filePath: ledgerPath })
    led.approve('/opt/homebrew/bin/codex', HASH_A)
    assert.equal(led.revoke('/opt/homebrew/bin/codex'), true)
    assert.equal(led.getRecord('/opt/homebrew/bin/codex'), null)
  })
})
