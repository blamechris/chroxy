import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'fs'
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

// #8072 review S1: a TestLedger whose `_serialize()` throws exactly once, so
// a test can force ONE failed flush (the write itself fails, not the re-read)
// and then verify the retry recovers every pin, proving `_changedKeys` is not
// cleared until the write actually succeeds.
class FlakyLedger extends TestLedger {
  constructor(opts) {
    super(opts)
    this._failNextSerialize = false
  }

  _serialize() {
    if (this._failNextSerialize) {
      this._failNextSerialize = false
      throw new Error('boom (forced failure)')
    }
    return super._serialize()
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

    // #8073: revoke() used to consult only this instance's own in-memory
    // `_records` — a miss ended the call right there (`false`, nothing
    // removed) even when a DIFFERENT instance had pinned this exact path
    // since this instance's own last load. That left a genuine on-disk pin
    // un-revokable from any instance that did not personally load it.
    it('revoke() on an instance that never loaded the path removes a pin a different instance wrote', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath }) // constructed before a's pin lands — never loads it

      a.approve('/x/p', sha('genuine'))
      assert.equal(b.getRecord('/x/p'), null, 'b never loaded the record a wrote')

      assert.equal(b.revoke('/x/p'), true, 'revoke must refresh from disk before deciding there is nothing to remove')
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).records['/x/p'], undefined,
        'the pin must actually be gone from disk, not merely hidden from b\'s own view')

      // a still holds the (now-revoked) record in memory but never itself
      // touches it again — a's next flush must not resurrect it.
      a.approve('/x/other', sha('other'))
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')).records
      assert.equal(onDisk['/x/p'], undefined, 'the revoke stays revoked after both instances flush again')
      assert.ok(onDisk['/x/other'], 'the unrelated pin still lands')
    })

    it('revoke() still returns false when the path truly has no record anywhere, even after refreshing', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/other', sha('other')) // ensure the file exists with unrelated content
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

  // #8068: `binary-trust.json` gained a second writer PROCESS (`chroxy
  // resume` alongside the daemon) — each a `PathHashTrustLedger` subclass
  // instance loaded once, independently, from the same file. The old
  // flush() re-serialised only its own in-memory snapshot, so whichever
  // instance flushed LAST silently erased every pin the other had written
  // since its own load. flush() now re-reads the file and merges in only
  // the keys THIS instance actually changed.
  describe('flush merges instead of overwriting another instance\'s writes (#8068)', () => {
    it('a pin written by a second instance survives this instance\'s next flush (exact issue repro)', () => {
      // daemon = new BinaryProvenanceLedger({ filePath })   // daemon start
      // cli    = new BinaryProvenanceLedger({ filePath })   // chroxy resume, later
      const daemon = new TestLedger({ filePath: ledgerPath })
      const cli = new TestLedger({ filePath: ledgerPath })

      cli.approve('/usr/local/bin/claude', sha('claude-binary'))
      // Before #8068 this flush would have overwritten the file with only
      // what `daemon` itself knew about, dropping the claude pin above.
      daemon.approve('/opt/homebrew/bin/codex', sha('codex-binary'))

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.records['/usr/local/bin/claude'], 'the CLI instance\'s pin must survive')
      assert.ok(onDisk.records['/opt/homebrew/bin/codex'], 'the daemon instance\'s own pin is still there')
    })

    it('a revoke by one instance is not resurrected by another instance\'s flush', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath })

      a.approve('/x/pinned', sha('v1'))
      // `b` loaded before the approve above, so it never saw the record.
      assert.equal(b.getRecord('/x/pinned'), null, 'b never loaded the record a wrote')

      // c loads AFTER a's write, so it does see the record — and revokes it.
      const c = new TestLedger({ filePath: ledgerPath })
      assert.equal(c.revoke('/x/pinned'), true)
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).records['/x/pinned'], undefined)

      // a still has the (now-revoked) record in memory but never itself
      // touched it again — a's next flush must not resurrect it.
      a.approve('/x/other', sha('v2'))
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/pinned'], undefined, 'revoke must stay revoked')
      assert.ok(onDisk.records['/x/other'], 'the unrelated new pin still lands')
    })

    it('the same path approved by both — the LATER flusher\'s value wins', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath })

      a.approve('/x/shared', sha('a-value'))
      // b flushes second — by design, it wins: it re-reads first (picking
      // up a's value) and then re-applies its own change on top.
      b.approve('/x/shared', sha('b-value'))

      assert.equal(b.isTrusted('/x/shared', sha('b-value')), true)
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/shared'].sha256, sha('b-value'),
        'the later flush (b) must win over the earlier one (a)')
    })

    it('a change made by this instance keeps winning even after a later merge', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath })

      a.approve('/x/a', sha('a'))
      b.approve('/x/b', sha('b'))
      // a flushes again for an unrelated path; its earlier '/x/a' write must
      // not be lost just because it wasn't re-touched this time.
      a.approve('/x/a2', sha('a2'))

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')).records
      assert.ok(onDisk['/x/a'], 'a\'s first pin survives')
      assert.ok(onDisk['/x/b'], 'b\'s pin survives')
      assert.ok(onDisk['/x/a2'], 'a\'s second pin lands')
    })

    it('refreshes this instance\'s in-memory records from the merge, so a later read sees the other pin', () => {
      const daemon = new TestLedger({ filePath: ledgerPath })
      const cli = new TestLedger({ filePath: ledgerPath })

      cli.approve('/usr/local/bin/claude', sha('claude-binary'))
      daemon.approve('/opt/homebrew/bin/codex', sha('codex-binary'))

      // The daemon instance never itself loaded or approved the claude pin,
      // but its own flush must have refreshed its in-memory map from the
      // merge so a subsequent in-process read (no reload) sees it too.
      assert.equal(daemon.isTrusted('/usr/local/bin/claude', sha('claude-binary')), true,
        'flush() must refresh in-memory state from the merged result')
    })

    // #8072 review C2/S2: the original version of this test only asserted
    // "does not throw" and "the NEW write lands" — it passed even on the
    // pre-#8072 whole-snapshot flush AND on the #8072-head bug where a
    // failed re-read became an EMPTY merge base. The assertion that
    // actually distinguishes correct behaviour is that a pin approved
    // BEFORE the corruption survives the flush that hits it.
    it('a corrupt on-disk file at flush time keeps this instance\'s own pins (fail-open, not fail-EMPTY)', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/earlier', sha('earlier'))

      // Corrupt the file directly, simulating another writer's crash mid-
      // write (or an operator edit) landing between this instance's load
      // and its next flush.
      writeFileSync(ledgerPath, '{ this is not valid json, corrupted mid-write')

      assert.doesNotThrow(() => l.approve('/x/file', sha('a')),
        'flush must not throw on a corrupt on-disk file — same fail-open contract as load')

      // The pin from BEFORE the corruption must survive — a failed re-read
      // must fall back to this instance's own records, not an empty map.
      assert.equal(l.getRecord('/x/earlier').sha256, sha('earlier'),
        'a pin approved before the corruption must survive a flush that hits a corrupt re-read')
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.records['/x/earlier'], 'the earlier pin must still be on disk, not wiped')
      assert.ok(onDisk.records['/x/file'], 'the new write must still land despite the prior corruption')
    })

    // #8072 review S4 (round 2): an I/O error on the re-read (EACCES/EIO/
    // EMFILE — the READ CALL failed) says nothing about whether disk's
    // CURRENT content is good, unlike the malformed-JSON case above where
    // the bytes came back but are known-bad. Repair-overwriting on an I/O
    // error would risk clobbering a healthy pin a different process just
    // wrote — the #8068 loss again, scoped to this one flush. So this flush
    // SKIPS the write entirely instead of falling back to this instance's
    // own records: `_dirty`/`_changedKeys` stay pending for a retry.
    it('an unreadable (EACCES) file at flush time SKIPS the write and retries later, rather than repair-overwriting', { skip: process.platform === 'win32' }, () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/earlier', sha('earlier'))

      chmodSync(ledgerPath, 0o000)
      try {
        assert.doesNotThrow(() => l.approve('/x/file', sha('a')),
          'a swallowed I/O-error flush must not throw (best-effort ledger)')
      } finally {
        // Restore permissions so afterEach's rmSync can clean up the dir.
        chmodSync(ledgerPath, 0o600)
      }

      // The write must have been SKIPPED — on-disk content is untouched by
      // this flush attempt, not repair-overwritten from memory.
      const onDiskDuring = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDiskDuring.records['/x/earlier'], 'the file itself is untouched by the skipped flush')
      assert.equal(onDiskDuring.records['/x/file'], undefined,
        'the new pin must NOT land yet — an I/O error is not evidence disk is safe to overwrite')
      assert.equal(l._dirty, true, 'the ledger must stay dirty so a retry is attempted')

      // A later flush, once the file is readable again, retries and lands it.
      l.flush()
      const onDiskAfter = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDiskAfter.records['/x/earlier'])
      assert.ok(onDiskAfter.records['/x/file'], 'the retried flush must land the pin once the file is readable again')
    })

    it('an I/O read error at flush time does not clobber a DIFFERENT writer\'s valid pin (#8072 review S4)', { skip: process.platform === 'win32' }, () => {
      const other = new TestLedger({ filePath: ledgerPath })
      other.approve('/x/other-writer', sha('genuine')) // a different process's pin, already on disk

      const l = new TestLedger({ filePath: ledgerPath }) // this instance never loaded that pin
      chmodSync(ledgerPath, 0o000)
      try {
        assert.doesNotThrow(() => l.approve('/x/mine', sha('mine')))
      } finally {
        chmodSync(ledgerPath, 0o600)
      }

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.records['/x/other-writer'],
        'the other writer\'s pin must survive an I/O-error flush untouched — a repair-overwrite from `l`\'s own (incomplete) records would have erased it')
      assert.equal(onDisk.records['/x/mine'], undefined, 'this instance\'s own change must not have been written yet')
      assert.equal(l._dirty, true, 'the local change must stay pending for a retry')
      assert.equal(l._changedKeys.get(l._normalizeKey('/x/mine')), 'set', 'the change is still tracked, not lost')
    })

    it('a genuinely missing file (ENOENT) still resets to empty — only a real failure keeps the in-memory base', () => {
      // Distinguishes "no file at all" (an operator deleting the ledger to
      // reset it — must behave as a clean reset) from "the file exists but
      // failed to re-read" (must NOT reset — see the tests above).
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/earlier', sha('earlier'))
      rmSync(ledgerPath, { force: true })

      l.approve('/x/new', sha('new'))

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.ok(onDisk.records['/x/new'])
      // Whether `/x/earlier` also survives is incidental here (this
      // instance's own in-memory `_records` still has it, and the merge
      // base for a genuine ENOENT is an empty DISK map, not this instance's
      // memory) — the point of this test is only that ENOENT does not throw
      // and does not need the readFailed fallback.
    })
  })

  // #8072 review C1: a plain-object merge target (`{ ...spread }`) lets a
  // key named `constructor`/`toString`/`valueOf`/`__proto__` resolve through
  // the prototype chain to a truthy value instead of a real own-property
  // miss — a security bypass for any caller doing a bracket-key truthiness
  // check against the merged map (skills' `isCommunityTrusted`).
  describe('the merge stays null-prototype (#8072 review C1)', () => {
    it('_records stays null-prototype after a flush, so prototype-named keys are never "trusted"', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/file', sha('a')) // dirties + flushes, exercising the merge path

      assert.equal(Object.getPrototypeOf(l._records), null,
        '_records must stay a null-prototype object after a flush')
      for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
        assert.equal(l.isTrusted(name, sha('anything')), false, `${name} must not resolve through the prototype chain`)
        assert.equal(l.getRecord(name), null, `${name} must not resolve through the prototype chain`)
      }
    })
  })

  // #8072 review S1: mutant m3 ("clear _changedKeys before the write") killed
  // by this test — moving the clear before `saveJsonState` throws away the
  // pending change the moment the write fails, instead of only once it
  // actually lands.
  describe('_changedKeys retention across a failed write (#8072 review S1)', () => {
    it('retains every pending pin across a failed write, so the next flush retries them all', () => {
      const l = new FlakyLedger({ filePath: ledgerPath })
      l.approve('/x/a', sha('a')) // succeeds and flushes cleanly

      l._failNextSerialize = true
      l.approve('/x/b', sha('b')) // this flush's write throws; best-effort swallows it

      l.approve('/x/c', sha('c')) // retries — must include a, b AND c

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')).records
      assert.ok(onDisk['/x/a'], 'a survives (flushed before the failure)')
      assert.ok(onDisk['/x/b'],
        'b must land on the retry — _changedKeys must not have been cleared before the failed write')
      assert.ok(onDisk['/x/c'], 'c lands too (approved after the retry-triggering flush)')
    })
  })

  // #8072 review C3: TOFU first-sight pins and lastVerified-style bumps are
  // not operator decisions — they're written from a possibly-stale
  // snapshot, so the merge must not let them override a pin/decision this
  // instance never saw. Exercised at the base level via `approve(path, hash,
  // { firstSight: true })`; the skills-specific inspect()/acceptHash
  // scenarios live in skills-trust.test.js, and the binary-ledger scenario
  // (this option's real caller) lives in binary-provenance-trust.test.js.
  describe('a first-sight (TOFU) pin never overrides a pin this instance never saw (#8072 review C3)', () => {
    it('a stale instance\'s TOFU write does not overwrite another instance\'s genuine pin for the same path', () => {
      const cli = new TestLedger({ filePath: ledgerPath })
      const daemon = new TestLedger({ filePath: ledgerPath }) // stale: constructed before cli's pin lands

      cli.approve('/usr/local/bin/claude', sha('genuine'), { firstSight: true })
      // daemon never reloaded, so from its perspective this also looks like
      // first sight — but it must not clobber cli's now-genuine pin.
      daemon.approve('/usr/local/bin/claude', sha('stale-swap'), { firstSight: true })

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/usr/local/bin/claude'].sha256, sha('genuine'),
        'the genuine pin must survive the stale TOFU write')
      assert.equal(daemon.isTrusted('/usr/local/bin/claude', sha('stale-swap')), false,
        'the daemon\'s own in-memory state must self-heal to the genuine pin after its flush')
      assert.equal(daemon.isTrusted('/usr/local/bin/claude', sha('genuine')), true)
    })

    it('a TOFU write DOES apply when nobody else holds a pin for that path', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/first', sha('a'), { firstSight: true })
      assert.equal(l.isTrusted('/x/first', sha('a')), true)
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/first'].sha256, sha('a'))
    })

    it('an explicit approve (no firstSight) still always wins, even over another instance\'s pin', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath })
      a.approve('/x/shared', sha('a'), { firstSight: true })
      // An explicit (operator) approve is a decision, not a guess — it wins
      // even though b never saw a's pin, unlike the TOFU case above.
      b.approve('/x/shared', sha('b'))
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/shared'].sha256, sha('b'))
    })
  })

  // #8093 round 2 (C2): `approve(path, hash, { expect })` — a compare-and-
  // swap write, tagged `'migrate'`. Unlike a plain `approve()` (tagged
  // `'set'`, which always wins the merge regardless of what a fresh re-read
  // finds), a `'migrate'` write is applied ONLY when disk still holds a
  // record matching `expect` at the moment of the flush's own re-read. This
  // is what makes a caller's post-write `getRecord()` a REAL check instead of
  // always reading back its own just-applied value (`_setRecord` applies to
  // `_records` synchronously, before any merge ever runs) — mirrors how
  // `'tofu'` is conditioned above, just against an explicit snapshot instead
  // of "is there any record at all".
  describe('a migrate (compare-and-swap) write only applies when disk still matches `expect` (#8093 round 2, C2)', () => {
    it('applies when nobody else has touched the record — the plain, single-process case', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/p', sha('legacy'))
      l.approve('/x/p', sha('tree'), { expect: { sha256: sha('legacy') } })
      assert.equal(l.isTrusted('/x/p', sha('tree')), true)
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/p'].sha256, sha('tree'))
    })

    // The reviewer's exact two-instance interleaving: A reads the legacy
    // record, decides a migration is safe, but a DIFFERENT instance (B)
    // writes to the SAME path before A's own write lands.
    it('the reviewer\'s exact repro: a genuine write landing after A read but before A wrote is NOT overwritten', () => {
      const seeder = new TestLedger({ filePath: ledgerPath })
      seeder.approve('/x/p', sha('legacy')) // the shared starting point

      const daemonA = new TestLedger({ filePath: ledgerPath }) // loads the legacy record
      const daemonB = new TestLedger({ filePath: ledgerPath }) // loads the SAME legacy record

      // B completes a real migration first and flushes it — genuine, valid,
      // persisted.
      daemonB.approve('/x/p', sha('genuine-tree'), { expect: { sha256: sha('legacy') } })
      assert.equal(daemonB.isTrusted('/x/p', sha('genuine-tree')), true, 'sanity: B\'s own migration must succeed')

      // A proceeds exactly as the migration branch does — no further reload
      // — attempting to migrate from the SAME legacy snapshot it originally
      // read, now stale.
      daemonA.approve('/x/p', sha('attacker-tree'), { expect: { sha256: sha('legacy') } })

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/p'].sha256, sha('genuine-tree'),
        'B\'s genuine tree pin must survive completely untouched — A\'s stale CAS must be rejected, not silently overwrite it')
      assert.equal(daemonA.isTrusted('/x/p', sha('attacker-tree')), false,
        'A\'s own in-memory view must self-heal to reflect the rejection, not keep believing its own write landed')
      assert.equal(daemonA.isTrusted('/x/p', sha('genuine-tree')), true)
      assert.equal(daemonA.getRecord('/x/p').sha256, sha('genuine-tree'),
        'the post-write getRecord() re-read a caller performs must see the ACTUAL merged result, not a value only this instance ever held')
    })

    it('a migrate write matching `expect` on more than one field only applies when ALL of them still match', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      // extraFields is empty for TestLedger, so simulate an extra field via
      // a manually-constructed expect that simply never matches a bare
      // sha256-only record — proves the comparison checks every named field,
      // not merely the first one.
      l.approve('/x/p', sha('legacy'))
      l.approve('/x/p', sha('tree'), { expect: { sha256: sha('legacy'), kind: 'file' } })
      // `kind` is not a real field on this record (TestLedger declares no
      // extraFields), so `baseRec.kind` is `undefined`, never `'file'` —
      // the CAS must fail on that mismatch alone.
      assert.equal(l.isTrusted('/x/p', sha('tree')), false, 'a field named in `expect` that does not match must reject the whole CAS')
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/p'].sha256, sha('legacy'), 'the original record must be untouched')
    })

    it('does not apply, and is not resurrected later, once disk has moved on (R2-C1-style forget-not-retry)', () => {
      const seeder = new TestLedger({ filePath: ledgerPath })
      seeder.approve('/x/p', sha('legacy'))

      // `failing` is the stale instance: it loads the legacy record, exactly
      // like `daemonA` in the repro test above, but its first flush is
      // forced to fail so the blanket `_changedKeys.clear()` on a successful
      // flush does not run and mask the bug.
      const failing = new FlakyLedger({ filePath: ledgerPath })
      const daemonB = new TestLedger({ filePath: ledgerPath })
      daemonB.approve('/x/p', sha('genuine-tree'), { expect: { sha256: sha('legacy') } })

      failing._failNextSerialize = true
      failing.approve('/x/p', sha('attacker-tree'), { expect: { sha256: sha('legacy') } })
      // The skip already self-healed failing's in-memory state to B's
      // genuine record, regardless of the write failure.
      assert.equal(failing.isTrusted('/x/p', sha('genuine-tree')), true)

      // The failed flush must not leave a 'migrate' op queued to be replayed
      // against a LATER disk state — approve an unrelated key to force
      // another flush and confirm P is still untouched.
      failing.approve('/x/q', sha('q'))

      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/p'].sha256, sha('genuine-tree'), 'B\'s genuine pin must still be untouched after a retried flush')
      assert.ok(onDisk.records['/x/q'], 'the unrelated later write still lands')
    })
  })

  // #8098: a migrate that legitimately WINS the CAS had its
  // `_migrateExpectations` entry deleted unconditionally inside the merge —
  // which runs BEFORE the physical `saveJsonState()` write is known to
  // succeed (see flush()). If that persist then fails, `_changedKeys` keeps
  // `'migrate'` for the key (best-effort flushes always retain the pending
  // op — same as every other op), so the NEXT flush re-enters this op's
  // merge branch — but with the expectation already gone, `expect` reads
  // back `undefined`, the CAS reads as "disk moved on", and the still-valid
  // migration is silently reverted to the legacy record it migrated FROM.
  // Fail-safe (nothing is bypassed — it reverts to a still-valid pin), but
  // it breaks the documented "a failed flush retries" invariant for this one
  // op and wastes a re-migration. The fix defers clearing the expectation
  // until AFTER a successful persist, mirroring how `_changedKeys.clear()`
  // is itself deferred (#8072 review S1, exercised above).
  describe('a winning migrate survives a failed persist and completes on retry (#8098)', () => {
    it('a winning migrate whose first persist fails is completed by the NEXT flush — not reverted to the legacy record', () => {
      const l = new FlakyLedger({ filePath: ledgerPath })
      l.approve('/x/p', sha('legacy')) // flushed cleanly

      l._failNextSerialize = true
      l.approve('/x/p', sha('tree'), { expect: { sha256: sha('legacy') } }) // CAS wins, but this flush's write throws
      assert.equal(l.isTrusted('/x/p', sha('tree')), true,
        'the win self-applies to memory regardless of the write failure')

      let onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')).records
      assert.equal(onDisk['/x/p'].sha256, sha('legacy'), 'sanity: the failed write never reached disk')

      // Force a retry via an unrelated approve — best-effort flushes retain
      // pending ops across a failure, so this must complete the migrate too.
      l.approve('/x/q', sha('q'))

      onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')).records
      assert.equal(onDisk['/x/p'].sha256, sha('tree'),
        'the retry must persist the still-valid migration, not revert it to the legacy record')
      assert.ok(onDisk['/x/q'], 'the unrelated later write still lands')
    })

    it('clears the migrate expectation once the persist actually succeeds — no leaked state', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/p', sha('legacy'))
      l.approve('/x/p', sha('tree'), { expect: { sha256: sha('legacy') } }) // wins, and this flush succeeds outright

      assert.equal(l._migrateExpectations.size, 0,
        'a migrate expectation must not outlive the successful persist that resolved it')
    })
  })

  // #8072 review round 2, R2-C1: when the merge SKIPS a 'tofu'/'touch' write
  // because disk already resolved that key, the tracked op must be FORGOTTEN
  // — not merely left in place for a later flush to replay. Without this, a
  // swallowed write failure on THIS flush leaves `_changedKeys` holding
  // `key -> 'tofu'` while `_records[key]` already holds the OTHER process's
  // record (adopted from disk during the skip). A LATER flush then
  // re-evaluates that stale op against whatever disk shows AT THAT POINT —
  // if the key was since revoked, disk no longer has it, the skip condition
  // ("disk already has a record") no longer holds, and the stale op writes
  // the removed pin back.
  describe('a resolved implicit op is forgotten, not retried (#8072 review round 2, R2-C1)', () => {
    it('a revoked pin is not resurrected by a stale first-sight write retained across a failed flush', () => {
      const cli = new FlakyLedger({ filePath: ledgerPath })
      const daemon = new FlakyLedger({ filePath: ledgerPath }) // stale: constructed before cli's pin lands

      // 1. cli approves P.
      cli.approve('/x/p', sha('genuine'))

      // 2. The stale daemon runs a first-sight write for the SAME path (it
      //    never saw cli's pin) — the merge skips it (disk already has P)
      //    and self-heals daemon's memory, but the write itself is forced
      //    to fail this once, so the blanket `_changedKeys.clear()` on a
      //    successful flush does not run and mask the bug.
      daemon._failNextSerialize = true
      daemon.approve('/x/p', sha('stale-swap'), { firstSight: true })
      // Sanity: the skip already self-healed daemon's in-memory state to
      // the genuine pin, regardless of the write failure (the C3 guarantee,
      // not R2-C1's — kept separate here so a future regression in either
      // one is attributed correctly).
      assert.equal(daemon.isTrusted('/x/p', sha('genuine')), true)

      // 3. cli revokes P.
      cli.revoke('/x/p')

      // 4. The daemon approves an unrelated path Q — this flush would,
      //    WITHOUT the R2-C1 fix, still be carrying a retained 'tofu' entry
      //    for P from step 2's failed write, and would replay it now that
      //    disk no longer has P.
      daemon.approve('/x/q', sha('q'))

      // 5. Assert P is absent on disk.
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      assert.equal(onDisk.records['/x/p'], undefined,
        'a revoked pin must stay revoked, even through a stale instance\'s failed-then-retried flush')
      assert.ok(onDisk.records['/x/q'], 'the unrelated later pin still lands')
    })

    // A skipped 'touch' only falls through to the resurrecting "apply" path
    // when disk's hash happens to match this instance's stale hash again
    // (a narrower case — see N2 in the round-2 review, filed separately as
    // metadata staleness, not a trust bypass). This test instead asserts
    // the mechanical fix directly: a skipped touch forgets its op the same
    // way a skipped tofu does, so it is never available to be replayed
    // against a different disk state on a later flush.
    it('a skipped touch also forgets its retained op after a failed write (defensive symmetry with tofu)', () => {
      const a = new FlakyLedger({ filePath: ledgerPath })
      a.approve('/x/p', sha('v1'))
      const bStale = new FlakyLedger({ filePath: ledgerPath }) // constructed after a's pin — sees v1

      // Someone else re-approves P with a different hash — bStale never
      // sees this.
      const other = new FlakyLedger({ filePath: ledgerPath })
      other.approve('/x/p', sha('v2'))

      // bStale, unaware, tries to bump its (now-superseded) v1 record's
      // approval timestamp — a 'touch', the way `inspect()`'s verified
      // branch does it (TestLedger has no throttle-gated inspect() of its
      // own, so the base `_setRecord` helper is used directly). The merge
      // skips it (disk's hash differs from what bStale verified against),
      // self-healing bStale to v2, but the write is forced to fail this once.
      bStale._failNextSerialize = true
      const key = bStale._normalizeKey('/x/p')
      bStale._setRecord(key, { ...bStale._records[key], approvedAt: new Date().toISOString() }, 'touch')
      bStale.flush()

      assert.equal(bStale.isTrusted('/x/p', sha('v2')), true, 'the skip must self-heal bStale to v2 regardless of the write failure')
      assert.equal(bStale._changedKeys.has(key), false,
        'a skipped touch must forget its retained op — not just self-heal in memory — so a later flush cannot replay it against a different disk state')
    })

    // #8072 review round 3 S5 — pins round 2's N2 fix. A matching-hash touch
    // applies ONLY the bumped approval timestamp on top of the BASE record;
    // every other field comes from disk, which may reflect a revoke-then-
    // re-approve (same hash) this instance never saw. Reverting to the
    // wholesale `merged[key] = this._records[key]` write puts this
    // instance's stale metadata back on disk.
    it('a matching-hash touch applies only the approval timestamp on top of the disk record (#8072 review round 3 S5)', () => {
      writeFileSync(ledgerPath, JSON.stringify({ records: {
        '/x/p': { sha256: sha('v1'), approvedAt: '2026-01-01T00:00:00.000Z', firstSeen: 'stale-instance-view' },
      } }))
      const bStale = new TestLedger({ filePath: ledgerPath })

      // Another process revokes and re-approves P with the SAME hash, which
      // rewrites the record's metadata — bStale never reloads.
      writeFileSync(ledgerPath, JSON.stringify({ records: {
        '/x/p': { sha256: sha('v1'), approvedAt: '2026-06-01T00:00:00.000Z', firstSeen: 're-approved-elsewhere' },
      } }))

      const key = bStale._normalizeKey('/x/p')
      const bumped = '2026-09-28T00:00:00.000Z'
      bStale._setRecord(key, { ...bStale._records[key], approvedAt: bumped }, 'touch')
      bStale.flush()

      const rec = JSON.parse(readFileSync(ledgerPath, 'utf8')).records['/x/p']
      assert.equal(rec.sha256, sha('v1'))
      assert.equal(rec.approvedAt, bumped, 'the touch\'s own bumped timestamp lands')
      assert.equal(rec.firstSeen, 're-approved-elsewhere',
        'every other field must come from the disk record, not this instance\'s stale copy')
    })
  })

  // #8073: #8068/#8072 fixed WHAT a flush writes; they did not change WHEN
  // an instance's own view of the world refreshes — that still only happened
  // at this instance's OWN next flush. A trust decision made from a
  // getRecord()/`_records[key]` miss (verify-provenance.js's first-sight
  // TOFU pin, revoke()'s "nothing to remove" check) was therefore still
  // deciding from a snapshot that could be stale by an arbitrary amount.
  // `reload()` re-reads and merges (reusing flush()'s own merge rule)
  // without writing, so a caller about to treat a miss as meaningful can
  // check disk first.
  describe('reload() refreshes from disk without writing (#8073)', () => {
    it('a pin written by a different instance becomes visible after reload, and reload never writes to disk', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      const b = new TestLedger({ filePath: ledgerPath }) // constructed before a's pin lands — stale

      a.approve('/x/p', sha('genuine'))
      assert.equal(b.getRecord('/x/p'), null, 'b never loaded the record a wrote')

      const before = readFileSync(ledgerPath, 'utf8')
      const changed = b.reload()
      assert.equal(changed, true, 'a successful reload reports true')
      assert.equal(readFileSync(ledgerPath, 'utf8'), before, 'reload must never write to disk')
      assert.equal(b.isTrusted('/x/p', sha('genuine')), true, 'b sees the pin after reload, with no flush of its own')
      // #8073 review round 1 S3 (mutant M6): reload must not mark the
      // ledger dirty just because it picked up someone else's pin — nothing
      // about b's OWN state changed. A reload that marks dirty would make
      // every refreshing instance write on its next flush for no reason —
      // for a per-session store like SkillsTrustStore, a miss that resolves
      // to "verified" would then rewrite the trust file on every load,
      // exactly what #3231's throttle exists to prevent, and it is one more
      // participant in the #8080 rename race for nothing.
      assert.equal(b._dirty, false, 'reload must never mark the ledger dirty')
    })

    it('reload keeps this instance\'s own pending SET op over whatever is on disk', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      a.approve('/x/other', sha('other')) // seed the file so it exists

      const b = new TestLedger({ filePath: ledgerPath })
      const key = b._normalizeKey('/x/mine')
      b._setRecord(key, { sha256: sha('mine'), firstSeen: 'x', approvedAt: 'x' }, 'set') // pending, not yet flushed

      b.reload()
      assert.equal(b.isTrusted('/x/mine', sha('mine')), true, 'the pending set survives a reload')
      assert.equal(b._changedKeys.get(key), 'set', 'the op is still tracked for the next flush')

      b.flush()
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')).records
      assert.ok(onDisk['/x/mine'], 'the pending set still lands on the next flush')
    })

    it('reload keeps this instance\'s own pending DELETE over a record still on disk', () => {
      const a = new TestLedger({ filePath: ledgerPath })
      a.approve('/x/p', sha('v1')) // flushed, on disk

      const b = new TestLedger({ filePath: ledgerPath }) // loads a's pin too
      assert.equal(b.isTrusted('/x/p', sha('v1')), true)
      b._deleteRecord(b._normalizeKey('/x/p')) // pending delete — disk still has the record

      b.reload()
      assert.equal(b.getRecord('/x/p'), null,
        'the pending delete survives a reload even though disk still has the record')

      b.flush()
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).records['/x/p'], undefined,
        'the delete lands on the next flush')
    })

    it('reload does not let a pending TOFU write override a disk pin', () => {
      const cli = new TestLedger({ filePath: ledgerPath })
      const daemon = new TestLedger({ filePath: ledgerPath }) // stale: constructed before cli's pin lands

      cli.approve('/x/p', sha('genuine')) // a real decision, flushed

      const key = daemon._normalizeKey('/x/p')
      // Pending, not yet flushed — mirrors verify-provenance.js's TOFU write
      // (`approve(path, hash, { firstSight: true })`) happening BEFORE the
      // reload this test exercises directly, at the base level.
      daemon._setRecord(key, { sha256: sha('stale-swap'), firstSeen: 'x', approvedAt: 'x' }, 'tofu')

      daemon.reload()
      assert.equal(daemon.isTrusted('/x/p', sha('genuine')), true,
        'the disk pin wins over the pending tofu — a stale first-sight write must never override a real pin')
      assert.equal(daemon._changedKeys.has(key), false,
        'the resolved tofu op is forgotten, not retried against a later disk state')
    })
  })

  // #8073: a failed re-read (corrupt bytes, or the read call itself throwing)
  // must never be treated as "there is nothing to keep" — a reload exists so
  // a caller can check disk BEFORE deciding a miss is real; if the check
  // itself fails, the only safe outcome is "nothing learned", never "assume
  // empty and drop what I already hold".
  describe('reload() fails safe on a re-read failure (#8073)', () => {
    it('a corrupt on-disk file leaves every in-memory pin untouched', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/earlier', sha('earlier'))

      writeFileSync(ledgerPath, '{ this is not valid json, corrupted mid-write')

      const changed = l.reload()
      assert.equal(changed, false, 'a failed reload reports false')
      assert.equal(l.getRecord('/x/earlier').sha256, sha('earlier'),
        'the pin approved before the corruption must survive a reload that hits a corrupt re-read')
    })

    it('an unreadable (EACCES) file leaves every in-memory pin untouched', { skip: process.platform === 'win32' }, () => {
      const l = new TestLedger({ filePath: ledgerPath })
      l.approve('/x/earlier', sha('earlier'))

      chmodSync(ledgerPath, 0o000)
      let changed
      try {
        changed = l.reload()
      } finally {
        chmodSync(ledgerPath, 0o600)
      }
      assert.equal(changed, false, 'a failed reload reports false')
      assert.equal(l.getRecord('/x/earlier').sha256, sha('earlier'),
        'the pin must survive an EACCES reload, not be reset to empty')
    })

    // #8073 review round 1 S3 (mutant M7): the tofu-forget guard
    // (`if (!readFailed) this._changedKeys.delete(key)`) must stay
    // conditioned on `readFailed` — forgetting unconditionally would be
    // WORSE for reload() than for flush(), because reload() never writes.
    // A pending tofu whose own flush already failed once, then hits a
    // corrupt/EACCES reload, must stay tracked so a LATER good reload (or
    // flush) can still resolve it correctly — forgetting it here would drop
    // the pin from `_changedKeys` without it ever having been persisted
    // anywhere, and the path would be first-sighted again from scratch.
    it('a corrupt reload does not forget a pending TOFU op — only a SUCCESSFUL re-read that resolves it may forget it', () => {
      const l = new TestLedger({ filePath: ledgerPath })
      const key = l._normalizeKey('/x/p')
      l._setRecord(key, { sha256: sha('stale-swap'), firstSeen: 'x', approvedAt: 'x' }, 'tofu') // pending, not flushed

      writeFileSync(ledgerPath, '{ this is not valid json, corrupted mid-write')

      l.reload()
      assert.equal(l._changedKeys.get(key), 'tofu',
        'a readFailed reload must not forget a pending tofu op — nothing reliable was learned about disk this round')
    })
  })
})
