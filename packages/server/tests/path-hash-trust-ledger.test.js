import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { PathHashTrustLedger } from '../src/path-hash-trust-ledger.js'

/**
 * Unit tests for the #5580 PathHashTrustLedger base — the shared core of the
 * skills + session-preset trust ledgers. Exercises the contract the two
 * subclasses inherit: trust lifecycle, hash-mismatch re-gate, fail-open-to-empty
 * on corruption, atomic 0600 write, and the per-pid + random temp suffix.
 *
 * The base is exercised through a minimal concrete subclass (the same shape a
 * real subclass uses) so we test the inherited mechanics, not subclass extras.
 */

const sha = (s) => createHash('sha256').update(s).digest('hex')
const noopLog = { warn() {}, info() {} }

// Minimal concrete ledger: identity key normaliser, `approvedAt` field,
// `records` wrapper key, best-effort flush. Mirrors how a subclass wires it.
class TestLedger extends PathHashTrustLedger {
  constructor({ filePath, throwOnFlushError } = {}) {
    super({
      filePath,
      log: noopLog,
      normalizeKey: (p) => (typeof p === 'string' ? p : ''),
      approvalField: 'approvedAt',
      wrapperKey: 'records',
      throwOnFlushError: throwOnFlushError === true,
    })
    const loaded = this._loadRecords()
    this._records = loaded.records
    this._migrated = loaded.migratedLegacy
    this._dirty = loaded.migratedLegacy || false
  }
}

describe('PathHashTrustLedger (#5580)', () => {
  let dir
  let ledgerPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phtl-'))
    ledgerPath = join(dir, 'ledger.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('constructor validation', () => {
    it('throws without filePath', () => {
      assert.throws(() => new PathHashTrustLedger({ log: noopLog, normalizeKey: (p) => p }), /filePath is required/)
    })
    it('throws without log', () => {
      assert.throws(() => new PathHashTrustLedger({ filePath: ledgerPath, normalizeKey: (p) => p }), /log is required/)
    })
    it('throws without normalizeKey', () => {
      assert.throws(() => new PathHashTrustLedger({ filePath: ledgerPath, log: noopLog }), /normalizeKey is required/)
    })
  })

  describe('trust lifecycle (approve / isTrusted / getRecord / revoke)', () => {
    it('an unseen path is untrusted', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.isTrusted('/x/file', sha('a')), false)
      assert.equal(l.getRecord('/x/file'), null)
    })

    it('approve records the hash and marks it trusted', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      const h = sha('body')
      assert.equal(l.approve('/x/file', h), true)
      assert.equal(l.isTrusted('/x/file', h), true)
      const rec = l.getRecord('/x/file')
      assert.equal(rec.sha256, h)
      assert.ok(typeof rec.firstSeen === 'string')
      assert.ok(typeof rec.approvedAt === 'string')
    })

    it('approve rejects a non-hex hash', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.approve('/x/file', 'not-a-hash'), false)
      assert.equal(l.approve('/x/file', ''), false)
    })

    it('approve preserves the original firstSeen on re-approval', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/file', sha('v1'))
      const firstSeen = l.getRecord('/x/file').firstSeen
      l.approve('/x/file', sha('v2'))
      assert.equal(l.getRecord('/x/file').firstSeen, firstSeen)
      assert.equal(l.getRecord('/x/file').sha256, sha('v2'))
    })

    it('getRecord returns a clone — caller mutation does not poison the ledger', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      const h = sha('body')
      l.approve('/x/file', h)
      const rec = l.getRecord('/x/file')
      rec.sha256 = 'tampered'
      assert.equal(l.isTrusted('/x/file', h), true)
    })

    it('revoke drops the record so the path goes untrusted', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      const h = sha('body')
      l.approve('/x/file', h)
      assert.equal(l.revoke('/x/file'), true)
      assert.equal(l.isTrusted('/x/file', h), false)
      assert.equal(l.getRecord('/x/file'), null)
    })

    it('revoke on an unseen path is a no-op returning false', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.revoke('/x/never'), false)
    })
  })

  describe('hash-mismatch re-gate', () => {
    it('a changed hash is no longer trusted (re-gated)', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      const oldHash = sha('original')
      l.approve('/x/file', oldHash)
      assert.equal(l.isTrusted('/x/file', oldHash), true)
      // Content changed → different hash → untrusted until re-approved.
      const newHash = sha('tampered')
      assert.equal(l.isTrusted('/x/file', newHash), false)
      l.approve('/x/file', newHash)
      assert.equal(l.isTrusted('/x/file', newHash), true)
      assert.equal(l.isTrusted('/x/file', oldHash), false)
    })
  })

  describe('persistence round-trip', () => {
    it('an approved record survives a reload from disk', () => {
      const h = sha('body')
      const l1 = new TestLedger({ filePath: ledgerPath })
      l1.approve('/x/file', h)
      const l2 = new TestLedger({ filePath: ledgerPath })
      assert.equal(l2.isTrusted('/x/file', h), true)
    })

    it('on-disk shape nests records under the wrapper key', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      const h = sha('body')
      l.approve('/x/file', h)
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.records, 'records wrapper key present')
      assert.equal(onDisk.records['/x/file'].sha256, h)
    })
  })

  describe('corruption fail-open-to-empty', () => {
    it('a malformed JSON file loads as empty (no throw)', () => {
      writeFileSync(ledgerPath, '{ not valid json')
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.isTrusted('/x/file', sha('a')), false)
    })

    it('a non-object root (array) loads as empty', () => {
      writeFileSync(ledgerPath, '[1,2,3]')
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.getRecord('/x/file'), null)
    })

    it('an unrecognised-shape object loads as empty', () => {
      writeFileSync(ledgerPath, JSON.stringify({ somethingElse: { a: 1 } }))
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.getRecord('/x/file'), null)
    })

    it('records missing required fields are dropped on load', () => {
      writeFileSync(ledgerPath, JSON.stringify({
        records: {
          '/good': { sha256: sha('a'), firstSeen: '2026-01-01T00:00:00.000Z' },
          '/nohash': { firstSeen: '2026-01-01T00:00:00.000Z' },
          '/badhash': { sha256: 'xyz', firstSeen: '2026-01-01T00:00:00.000Z' },
          '/nofirstseen': { sha256: sha('c') },
        },
      }))
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.isTrusted('/good', sha('a')), true)
      assert.equal(l.getRecord('/nohash'), null)
      assert.equal(l.getRecord('/badhash'), null)
      assert.equal(l.getRecord('/nofirstseen'), null)
    })

    it('a missing file is treated as empty', () => {
      const l = new TestLedger({ filePath: join(dir, 'does-not-exist.json') })
      assert.equal(l.getRecord('/x/file'), null)
    })

    it('the approvalField falls back to firstSeen when missing on disk', () => {
      writeFileSync(ledgerPath, JSON.stringify({
        records: { '/x': { sha256: sha('a'), firstSeen: '2026-01-01T00:00:00.000Z' } },
      }))
      const l = new TestLedger({ filePath: ledgerPath })
      assert.equal(l.getRecord('/x').approvedAt, '2026-01-01T00:00:00.000Z')
    })
  })

  describe('atomic write + per-pid/random temp suffix', () => {
    it('writes to the target and leaves no fixed .tmp sibling', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/file', sha('a'))
      assert.ok(existsSync(ledgerPath))
      assert.ok(!existsSync(`${ledgerPath}.tmp`), 'no fixed .tmp orphan')
    })

    it('writes the target at mode 0600 (POSIX)', { skip: process.platform === 'win32' }, () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/file', sha('a'))
      assert.equal(statSync(ledgerPath).mode & 0o777, 0o600)
    })

    it('creates the parent directory if missing', () => {
      const nested = join(dir, 'a', 'b', 'c', 'ledger.json')
      const l = new TestLedger({ filePath: nested })
      l.approve('/x/file', sha('a'))
      assert.ok(existsSync(nested))
    })

    it('a stale fixed .tmp orphan does not break a fresh flush', () => {
      writeFileSync(`${ledgerPath}.tmp`, '{ partial orphan')
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/file', sha('a'))
      assert.equal(l.isTrusted('/x/file', sha('a')), true)
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.records['/x/file'])
    })

    it('two ledgers flushing to the same path do not collide (same-process)', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath })
      a.approve('/x/a', sha('a'))
      b.approve('/x/b', sha('b'))
      a.approve('/x/a2', sha('a2'))
      // Neither flush threw; the target is valid JSON.
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk && typeof onDisk === 'object')
    })

    it('best-effort flush swallows a write failure when throwOnFlushError is false', () => {
      // Point at a directory so the open/rename fails.
      const l = new TestLedger({ filePath: dir })
      // approve() calls flush() internally; must not throw in best-effort mode.
      assert.doesNotThrow(() => l.approve('/x/file', sha('a')))
    })

    it('re-throws a write failure when throwOnFlushError is true', () => {
      const l = new TestLedger({ filePath: dir, throwOnFlushError: true })
      assert.throws(() => l.approve('/x/file', sha('a')), /EISDIR|illegal operation|EEXIST|EPERM|EACCES/)
    })

    it('a failed flush elsewhere does not corrupt an unrelated good target', () => {
      const good = new TestLedger({ filePath: ledgerPath })
      good.approve('/x/file', sha('original'))
      const before = readFileSync(ledgerPath, 'utf8')
      const bad = new TestLedger({ filePath: dir, throwOnFlushError: true })
      assert.throws(() => bad.approve('/x/y', sha('a')))
      assert.equal(readFileSync(ledgerPath, 'utf8'), before)
    })
  })

  describe('flush is a no-op when clean', () => {
    it('does not write the file when nothing changed', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.flush()
      assert.equal(existsSync(ledgerPath), false, 'clean flush must not create the file')
    })
  })
})
