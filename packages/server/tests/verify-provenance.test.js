import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import {
  PROVENANCE_STATUS,
  sha256File,
  assessMacSignature,
  verifyProvenance,
  MACOS_SPCTL,
  sha256FileCached,
  assessMacSignatureCached,
  SIGNATURE_CACHE_TTL_MS,
  _resetProvenanceCacheForTest,
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

// #8030 — stat-identity caches for the per-spawn re-verification gate. Both
// caches are module-level, so every test resets them in beforeEach to avoid
// leaking identities across tests that reuse the same fake path.
function statOf({ dev = 1, ino = 1, size = 100, mtimeMs = 1, ctimeMs = 1 } = {}) {
  return () => ({ dev, ino, size, mtimeMs, ctimeMs })
}

describe('sha256FileCached (#8030)', () => {
  beforeEach(() => _resetProvenanceCacheForTest())

  it('caches a hit for the SAME stat identity — readFileSync is not called twice', () => {
    let reads = 0
    const statSync = statOf({ ino: 10, mtimeMs: 100, ctimeMs: 100 })
    const readFileSync = () => { reads += 1; return Buffer.from('abc') }
    const first = sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' })
    const second = sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' })
    assert.equal(first, second)
    assert.equal(reads, 1, 'the second call must be served from cache, not re-read')
  })

  it('holds ONE entry per path — a new identity replaces the old one instead of accumulating (#8030 review)', () => {
    let reads = 0
    const readFileSync = () => { reads += 1; return Buffer.from(`v${reads}`) }
    const idA = statOf({ ino: 30, mtimeMs: 300, ctimeMs: 300 })
    const idB = statOf({ ino: 31, mtimeMs: 301, ctimeMs: 301 })
    sha256FileCached('/fake/claude', { statSync: idA, readFileSync, platform: 'linux' })
    sha256FileCached('/fake/claude', { statSync: idB, readFileSync, platform: 'linux' })
    sha256FileCached('/fake/claude', { statSync: idA, readFileSync, platform: 'linux' })
    assert.equal(reads, 3, 'identity A must have been replaced by B, not retained alongside it')
  })

  it('keeps separate paths in separate entries — caching one path never evicts another', () => {
    let reads = 0
    const readFileSync = () => { reads += 1; return Buffer.from('x') }
    const statSync = statOf({ ino: 32, mtimeMs: 302, ctimeMs: 302 })
    sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' })
    sha256FileCached('/fake/codex', { statSync, readFileSync, platform: 'linux' })
    sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' })
    assert.equal(reads, 2, 'the /fake/claude entry must survive a /fake/codex insert')
  })

  it('never caches on win32 — NTFS ChangeTime is owner-settable, so the identity is not trusted there', () => {
    let reads = 0
    const statSync = statOf({ ino: 33, mtimeMs: 303, ctimeMs: 303 })
    const readFileSync = () => { reads += 1; return Buffer.from('x') }
    sha256FileCached('C:\\fake\\claude.exe', { statSync, readFileSync, platform: 'win32' })
    sha256FileCached('C:\\fake\\claude.exe', { statSync, readFileSync, platform: 'win32' })
    assert.equal(reads, 2, 'every win32 call must re-hash')
  })

  it('re-reads when ONLY ctimeMs changes — utimes can restore mtime but not ctime', () => {
    let reads = 0
    const readFileSync = () => { reads += 1; return Buffer.from(`v${reads}`) }
    sha256FileCached('/fake/claude', { statSync: statOf({ ino: 20, mtimeMs: 200, ctimeMs: 200 }), readFileSync, platform: 'linux' })
    sha256FileCached('/fake/claude', { statSync: statOf({ ino: 20, mtimeMs: 200, ctimeMs: 999 }), readFileSync, platform: 'linux' })
    assert.equal(reads, 2, 'an unchanged mtime with a changed ctime must still bust the cache')
  })

  it('does not cache when the identity changes ACROSS the read itself (a swap mid-hash)', () => {
    let reads = 0
    let statCalls = 0
    // Odd calls (the BEFORE read) report one identity; even calls (the AFTER
    // read) report a different one — simulating the file changing while it
    // was being hashed. Every invocation of sha256FileCached calls statSync
    // exactly twice (before + after), so this alternates per-invocation too.
    const statSync = () => {
      statCalls += 1
      return statCalls % 2 === 1
        ? { dev: 1, ino: 1, size: 100, mtimeMs: 1, ctimeMs: 1 }
        : { dev: 1, ino: 1, size: 100, mtimeMs: 2, ctimeMs: 2 }
    }
    const readFileSync = () => { reads += 1; return Buffer.from('x') }
    sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' })
    sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' })
    assert.equal(reads, 2, 'a hash whose identity changed across the read must never be cached')
  })

  it('propagates (and never caches) a hash read error', () => {
    let reads = 0
    const statSync = statOf({ ino: 30, mtimeMs: 300, ctimeMs: 300 })
    const readFileSync = () => { reads += 1; const e = new Error('EACCES'); throw e }
    assert.throws(() => sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' }))
    assert.throws(() => sha256FileCached('/fake/claude', { statSync, readFileSync, platform: 'linux' }))
    assert.equal(reads, 2, 'a failed hash must never be cached — every call re-reads')
  })
})

describe('assessMacSignatureCached (#8030)', () => {
  beforeEach(() => _resetProvenanceCacheForTest())

  it('caches a PASSING, non-skipped verdict for the SAME identity', () => {
    let calls = 0
    const statSync = statOf({ ino: 40, mtimeMs: 400, ctimeMs: 400 })
    const execFile = () => { calls += 1; return 'accepted' }
    const first = assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile })
    const second = assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(calls, 1, 'the second call must be served from cache, not re-assessed')
  })

  it('re-assesses a cached PASS once SIGNATURE_CACHE_TTL_MS has elapsed (a revocation leaves the file unchanged)', () => {
    let calls = 0
    let clock = 1_000_000
    const now = () => clock
    const statSync = statOf({ ino: 45, mtimeMs: 450, ctimeMs: 450 })
    const execFile = () => { calls += 1; return 'accepted' }
    assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile, now })
    clock += SIGNATURE_CACHE_TTL_MS - 1
    assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile, now })
    assert.equal(calls, 1, 'inside the TTL the pass is served from cache')
    clock += 1
    assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile, now })
    assert.equal(calls, 2, 'at the TTL the pass must be re-assessed')
  })

  it('holds ONE entry per path — a new identity replaces the old one (#8030 review)', () => {
    let calls = 0
    const execFile = () => { calls += 1; return 'accepted' }
    const idA = statOf({ ino: 55, mtimeMs: 550, ctimeMs: 550 })
    const idB = statOf({ ino: 56, mtimeMs: 551, ctimeMs: 551 })
    assessMacSignatureCached('/fake/claude', { statSync: idA, platform: 'darwin', execFile })
    assessMacSignatureCached('/fake/claude', { statSync: idB, platform: 'darwin', execFile })
    assessMacSignatureCached('/fake/claude', { statSync: idA, platform: 'darwin', execFile })
    assert.equal(calls, 3, 'identity A must have been replaced by B, not retained alongside it')
  })

  it('re-assesses when the stat identity changes', () => {
    let calls = 0
    const execFile = () => { calls += 1; return 'accepted' }
    assessMacSignatureCached('/fake/claude', { statSync: statOf({ ino: 50, mtimeMs: 500, ctimeMs: 500 }), platform: 'darwin', execFile })
    assessMacSignatureCached('/fake/claude', { statSync: statOf({ ino: 50, mtimeMs: 500, ctimeMs: 999 }), platform: 'darwin', execFile })
    assert.equal(calls, 2)
  })

  it('does NOT cache a REJECTED verdict — every call re-assesses (a later PASS is never masked)', () => {
    let calls = 0
    const statSync = statOf({ ino: 60, mtimeMs: 600, ctimeMs: 600 })
    const execFile = () => { calls += 1; const e = new Error('rejected'); e.stderr = 'rejected: source=Unnotarized'; throw e }
    const first = assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile })
    const second = assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile })
    assert.equal(first.ok, false)
    assert.equal(second.ok, false)
    assert.equal(calls, 2, 'a rejected verdict must never be cached')
  })

  it('does NOT cache a skipped verdict — a later real assessment on the same identity still runs spctl', () => {
    let calls = 0
    const statSync = statOf({ ino: 70, mtimeMs: 700, ctimeMs: 700 })
    const execFile = () => { calls += 1; return 'accepted' }
    // Seed with a skipped (non-macOS) verdict, then ask on darwin for the SAME
    // identity: a cached skip would be returned without ever running spctl.
    const first = assessMacSignatureCached('/fake/claude', { statSync, platform: 'linux', execFile })
    const second = assessMacSignatureCached('/fake/claude', { statSync, platform: 'darwin', execFile })
    assert.equal(first.skipped, true)
    assert.equal(second.skipped, false, 'the darwin call must be a real assessment, not the cached skip')
    assert.equal(second.ok, true)
    assert.equal(calls, 1)
  })
})

describe('verifyProvenance defaults to the CACHED hash/signature seams (#8030)', () => {
  beforeEach(() => _resetProvenanceCacheForTest())

  it('an injected sha256File/assessSignature seam is unaffected by the new defaults', () => {
    // Existing callers that inject their own seam (every test above this
    // block) must see byte-identical behaviour — the cache only activates
    // when nothing is injected.
    let hashCalls = 0
    const ledger = makeLedger()
    verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      ledger,
      sha256File: () => { hashCalls += 1; return HASH_A },
    })
    verifyProvenance({
      resolvedPath: '/opt/homebrew/bin/codex',
      mode: 'warn',
      ledger,
      sha256File: () => { hashCalls += 1; return HASH_A },
    })
    assert.equal(hashCalls, 2, 'an injected seam must run every call — caching is a DEFAULT, not baked into verifyProvenance itself')
  })
})
