import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import {
  PROVENANCE_STATUS,
  sha256File,
  assessMacSignature,
  verifyProvenance,
  MACOS_SPCTL,
} from '../src/utils/verify-provenance.js'

/**
 * Unit tests for opt-in provider-binary provenance verification (#6858).
 *
 * The pin ledger + signature gate are exercised over injected seams (a fake
 * ledger, a fake hash fn, a fake signature assessor), so these run identically
 * on macOS, Linux, and Windows CI with NO real binary, ledger file, or `spctl`.
 */

// A minimal in-memory ledger implementing exactly the surface verifyProvenance
// consults: getRecord() + approve(). Records the same shape PathHashTrustLedger
// returns so a swap for the real ledger changes nothing here.
function makeLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  const approvals = []
  return {
    getRecord(path) {
      const rec = records.get(path)
      return rec ? { ...rec } : null
    },
    approve(path, hash) {
      approvals.push({ path, hash })
      records.set(path, { sha256: hash, firstSeen: 'x', approvedAt: 'x' })
      return true
    },
    _approvals: approvals,
    _records: records,
  }
}

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('verifyProvenance — flag off (default, behaviour unchanged)', () => {
  it('SKIPS entirely when mode is off and the signature gate is off', () => {
    const ledger = makeLedger()
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'off',
      signatureGate: false,
      ledger,
      sha256File: () => { throw new Error('must not hash when off') },
      assessSignature: () => { throw new Error('must not assess when off') },
    })
    assert.equal(v.status, PROVENANCE_STATUS.SKIPPED)
    assert.equal(v.ok, true)
    assert.equal(v.blocked, false)
    assert.equal(ledger._approvals.length, 0)
  })

  it('SKIPS when resolvedPath is empty even with a mode set', () => {
    const v = verifyProvenance({ resolvedPath: '', mode: 'block', signatureGate: true, ledger: makeLedger() })
    assert.equal(v.status, PROVENANCE_STATUS.SKIPPED)
    assert.equal(v.blocked, false)
  })
})

describe('verifyProvenance — SHA-256 pin ledger (cross-platform)', () => {
  it('first sight PINS the hash and allows (trust on first use)', () => {
    const ledger = makeLedger()
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      ledger,
      sha256File: () => HASH_A,
    })
    assert.equal(v.status, PROVENANCE_STATUS.PINNED)
    assert.equal(v.ok, true)
    assert.equal(v.blocked, false)
    assert.equal(v.hash, HASH_A)
    assert.deepEqual(ledger._approvals, [{ path: '/opt/homebrew/bin/codex', hash: HASH_A }])
  })

  it('a matching pinned hash passes without re-pinning', () => {
    const ledger = makeLedger({ '/opt/homebrew/bin/codex': { sha256: HASH_A, firstSeen: 'x', approvedAt: 'x' } })
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'block',
      ledger,
      sha256File: () => HASH_A,
    })
    assert.equal(v.status, PROVENANCE_STATUS.OK)
    assert.equal(v.ok, true)
    assert.equal(v.blocked, false)
    assert.equal(ledger._approvals.length, 0, 'must not re-approve a matching binary')
  })

  it('warn mode: a changed hash surfaces a mismatch but ALLOWS the spawn', () => {
    const ledger = makeLedger({ '/opt/homebrew/bin/codex': { sha256: HASH_A, firstSeen: 'x', approvedAt: 'x' } })
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      ledger,
      sha256File: () => HASH_B,
    })
    assert.equal(v.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(v.ok, true, 'warn mode never blocks')
    assert.equal(v.blocked, false)
    assert.equal(v.pinnedHash, HASH_A)
    assert.equal(v.hash, HASH_B)
    // Must NOT silently re-pin — the mismatch stays visible until an operator approves.
    assert.equal(ledger._approvals.length, 0)
    assert.match(v.message, /changed/i)
  })

  it('block mode: a changed hash BLOCKS the spawn (fail-safe)', () => {
    const ledger = makeLedger({ '/opt/homebrew/bin/codex': { sha256: HASH_A, firstSeen: 'x', approvedAt: 'x' } })
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'block',
      ledger,
      sha256File: () => HASH_B,
    })
    assert.equal(v.status, PROVENANCE_STATUS.HASH_MISMATCH)
    assert.equal(v.ok, false)
    assert.equal(v.blocked, true)
    assert.equal(ledger._approvals.length, 0)
    assert.ok(v.remediation && v.remediation.length > 0)
  })
})

describe('verifyProvenance — unreadable binary (fail-safe)', () => {
  it('block mode: an unreadable binary BLOCKS (cannot verify → deny)', () => {
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'block',
      ledger: makeLedger(),
      sha256File: () => { const e = new Error('boom'); e.code = 'EACCES'; throw e },
    })
    assert.equal(v.status, PROVENANCE_STATUS.UNREADABLE)
    assert.equal(v.ok, false)
    assert.equal(v.blocked, true)
  })

  it('warn mode: an unreadable binary is surfaced but ALLOWED', () => {
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      ledger: makeLedger(),
      sha256File: () => { throw new Error('boom') },
    })
    assert.equal(v.status, PROVENANCE_STATUS.UNREADABLE)
    assert.equal(v.ok, true)
    assert.equal(v.blocked, false)
  })
})

describe('verifyProvenance — macOS signature gate (opt-in, hard block)', () => {
  it('blocks a binary that fails spctl assessment when the gate is on', () => {
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'off',
      signatureGate: true,
      platform: 'darwin',
      ledger: makeLedger(),
      assessSignature: () => ({ ok: false, skipped: false, detail: 'rejected: source=Unnotarized' }),
    })
    assert.equal(v.status, PROVENANCE_STATUS.SIGNATURE_INVALID)
    assert.equal(v.ok, false)
    assert.equal(v.blocked, true)
    assert.match(v.message, /signature|notariz/i)
  })

  it('a notarized binary passes the gate (and still pins when pinning is on)', () => {
    const ledger = makeLedger()
    const v = verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      signatureGate: true,
      platform: 'darwin',
      ledger,
      assessSignature: () => ({ ok: true, skipped: false }),
      sha256File: () => HASH_A,
    })
    assert.equal(v.status, PROVENANCE_STATUS.PINNED)
    assert.equal(v.blocked, false)
    assert.equal(ledger._approvals.length, 1)
  })

  it('a signature-gate FAILURE is checked BEFORE pinning (a rejected binary is never pinned)', () => {
    const ledger = makeLedger()
    verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      signatureGate: true,
      platform: 'darwin',
      ledger,
      assessSignature: () => ({ ok: false, skipped: false, detail: 'rejected' }),
      sha256File: () => { throw new Error('must not hash a signature-rejected binary') },
    })
    assert.equal(ledger._approvals.length, 0)
  })

  it('the gate is a no-op on non-macOS platforms (skipped), pinning still runs', () => {
    const ledger = makeLedger()
    const v = verifyProvenance({
      resolvedPath: '/usr/bin/codex',
      mode: 'warn',
      signatureGate: true,
      platform: 'linux',
      ledger,
      // Real assessMacSignature returns skipped on non-darwin; the default is used here.
      sha256File: () => HASH_A,
    })
    assert.equal(v.status, PROVENANCE_STATUS.PINNED)
    assert.equal(v.blocked, false)
  })
})

describe('assessMacSignature', () => {
  it('returns skipped:true on non-darwin without invoking spctl', () => {
    let called = false
    const r = assessMacSignature('/usr/bin/codex', {
      platform: 'linux',
      execFile: () => { called = true; return '' },
    })
    assert.equal(r.skipped, true)
    assert.equal(r.ok, true)
    assert.equal(called, false)
  })

  it('invokes the ABSOLUTE spctl path (never a PATH lookup) on darwin', () => {
    let invokedWith = null
    const r = assessMacSignature('/opt/homebrew/bin/codex', {
      platform: 'darwin',
      execFile: (bin, args) => { invokedWith = { bin, args }; return 'accepted\n' },
    })
    assert.equal(invokedWith.bin, MACOS_SPCTL)
    assert.equal(MACOS_SPCTL, '/usr/sbin/spctl')
    assert.ok(invokedWith.args.includes('/opt/homebrew/bin/codex'))
    assert.equal(r.ok, true)
    assert.equal(r.skipped, false)
  })

  it('a non-zero spctl exit (throw) is reported as not-ok (fail-safe)', () => {
    const r = assessMacSignature('/opt/homebrew/bin/codex', {
      platform: 'darwin',
      execFile: () => { const e = new Error('rejected'); e.status = 3; e.stderr = 'source=Unnotarized'; throw e },
    })
    assert.equal(r.ok, false)
    assert.equal(r.skipped, false)
    assert.match(r.detail, /Unnotarized|rejected/)
  })
})

describe('sha256File', () => {
  it('hashes the raw bytes of the file via the injected reader', () => {
    const bytes = Buffer.from('hello-binary')
    const expected = createHash('sha256').update(bytes).digest('hex')
    const h = sha256File('/any/path', { readFileSync: () => bytes })
    assert.equal(h, expected)
    assert.match(h, /^[a-f0-9]{64}$/)
  })
})
