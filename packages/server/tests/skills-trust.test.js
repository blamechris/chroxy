import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SkillsTrustStore,
  sha256Hex,
  _normalizePathKey,
  TRUST_MODE_WARN,
  TRUST_MODE_BLOCK,
} from '../src/skills-trust.js'

/**
 * Tests for the #3204 trust store. Always supplies an explicit `filePath`
 * pointing at a temp directory so the developer's real
 * `~/.chroxy/skills-trust.json` is never touched.
 */

// #8072 review S1: a SkillsTrustStore whose `_serialize()` throws exactly
// once, so a test can force ONE failed flush and verify the retry recovers
// every pending grant. Skills re-throws (`throwOnFlushError: true`), so the
// failure surfaces to the caller instead of being swallowed.
class FlakySkillsTrustStore extends SkillsTrustStore {
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

describe('skills-trust', () => {
  let dir
  let trustPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-trust-'))
    trustPath = join(dir, 'trust.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('sha256Hex', () => {
    it('returns a 64-character lowercase hex digest', () => {
      const h = sha256Hex('hello')
      assert.ok(/^[0-9a-f]{64}$/.test(h), `expected 64 hex chars, got ${h}`)
    })

    it('is deterministic across calls', () => {
      assert.equal(sha256Hex('payload'), sha256Hex('payload'))
    })

    it('changes when input changes', () => {
      assert.notEqual(sha256Hex('a'), sha256Hex('b'))
    })

    it('handles non-string input as empty string', () => {
      // sha256("") must be the canonical empty-string digest.
      assert.equal(
        sha256Hex(undefined),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      )
    })
  })

  describe('inspect — first activation', () => {
    it('records hash on first inspect, returns status `recorded`', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      const r = store.inspect('/abs/skill.md', 'body')
      assert.equal(r.status, 'recorded')
      assert.ok(/^[0-9a-f]{64}$/.test(r.hash))
    })

    it('persists firstSeen + sha256 to the trust file after flush', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body content')
      store.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      // v2 format: records are nested under `skills`
      assert.ok(persisted.skills['/abs/skill.md'])
      assert.equal(persisted.skills['/abs/skill.md'].sha256, sha256Hex('body content'))
      assert.ok(typeof persisted.skills['/abs/skill.md'].firstSeen === 'string')
      assert.ok(typeof persisted.skills['/abs/skill.md'].lastVerified === 'string')
    })

    it('verified inspect updates lastVerified but never touches the recorded sha256', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()
      const beforeRecord = JSON.parse(readFileSync(trustPath, 'utf8')).skills['/abs/skill.md']

      // Re-inspect with the same body — `lastVerified` may bump if the ISO
      // timestamp changes, but `sha256` and `firstSeen` must stay pinned.
      const store2 = new SkillsTrustStore({ filePath: trustPath })
      const r = store2.inspect('/abs/skill.md', 'body')
      store2.flush()
      assert.equal(r.status, 'verified')
      // v2 format: records are nested under `skills`
      const afterRecord = JSON.parse(readFileSync(trustPath, 'utf8')).skills['/abs/skill.md']
      assert.equal(afterRecord.sha256, beforeRecord.sha256, 'sha256 must remain stable')
      assert.equal(afterRecord.firstSeen, beforeRecord.firstSeen, 'firstSeen must remain stable')
    })
  })

  // #3205: getRecord is the read-only accessor used by the
  // dashboard's skills metadata UI. Returns the recorded entry
  // without mutating the ledger; returns null when no record exists.
  describe('getRecord (#3205)', () => {
    it('returns null for a path the trust store has never seen', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.getRecord('/never-seen.md'), null)
    })

    it('returns the recorded sha256 + firstSeen + lastVerified on hit', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/known.md', 'hello')
      const rec = store.getRecord('/abs/known.md')
      assert.ok(rec, 'expected a record')
      assert.equal(typeof rec.sha256, 'string')
      assert.equal(rec.sha256.length, 64)
      assert.equal(typeof rec.firstSeen, 'string')
      assert.equal(typeof rec.lastVerified, 'string')
    })

    it('does not mutate ledger state (read-only accessor)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/known.md', 'hello')
      store.flush()
      // After the flush the store is clean — getRecord must NOT
      // mark it dirty (otherwise the next destroy would re-flush
      // unnecessarily and the test "amortise writes" intent breaks).
      assert.equal(store._dirty, false)
      store.getRecord('/abs/known.md')
      assert.equal(store._dirty, false, 'getRecord must be a pure read')
    })

    it('returns clones — caller mutation does not poison the ledger', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/known.md', 'hello')
      const rec = store.getRecord('/abs/known.md')
      rec.sha256 = 'tampered'
      const fresh = store.getRecord('/abs/known.md')
      assert.notEqual(fresh.sha256, 'tampered',
        'getRecord must return a defensive copy so callers can\'t mutate the in-memory ledger')
    })
  })

  describe('inspect — verified', () => {
    it('returns status `verified` when content matches the recorded hash', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()

      const store2 = new SkillsTrustStore({ filePath: trustPath })
      const r = store2.inspect('/abs/skill.md', 'body')
      assert.equal(r.status, 'verified')
    })

    // PR #3231 Copilot #5: lastVerified was being bumped on every load
    // because the millisecond-fresh `now` always differed from the
    // recorded value. The result was that the trust file got rewritten
    // on every session start, contradicting the "amortise writes"
    // intent. The fix throttles the bump (default 24h).
    it('does NOT bump lastVerified within the throttle window (default 24h, default not exceeded)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()
      const before = JSON.parse(readFileSync(trustPath, 'utf8')).skills['/abs/skill.md'].lastVerified

      // Re-load and re-inspect. With the default 24h throttle the
      // record's lastVerified should NOT advance, and the store should
      // not be marked dirty (no rewrite).
      const store2 = new SkillsTrustStore({ filePath: trustPath })
      const r = store2.inspect('/abs/skill.md', 'body')
      assert.equal(r.status, 'verified')
      assert.equal(store2._dirty, false,
        'verified-with-fresh-record path must not mark the store dirty')

      // Force a flush and confirm the persisted record was not
      // rewritten with a newer timestamp.
      store2.flush()
      const after = JSON.parse(readFileSync(trustPath, 'utf8')).skills['/abs/skill.md'].lastVerified
      assert.equal(after, before,
        'lastVerified must not advance inside the throttle window')
    })

    it('DOES bump lastVerified once the throttle window has elapsed (verifyThrottleMs: 0)', async () => {
      const store = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      store.inspect('/abs/skill.md', 'body')
      store.flush()
      const before = JSON.parse(readFileSync(trustPath, 'utf8')).skills['/abs/skill.md'].lastVerified

      // Sleep just long enough for the ISO timestamp to advance — 1ms
      // can land on the same string with low resolution clocks, so use
      // a small but reliable gap. throttle=0 means "always eligible".
      await new Promise((resolve) => setTimeout(resolve, 5))

      const store2 = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      store2.inspect('/abs/skill.md', 'body')
      assert.equal(store2._dirty, true, 'throttle=0 should always bump and mark dirty')
      store2.flush()
      const after = JSON.parse(readFileSync(trustPath, 'utf8')).skills['/abs/skill.md'].lastVerified
      assert.notEqual(after, before, 'lastVerified must advance once the throttle has elapsed')
    })
  })

  describe('inspect — mismatch (warn mode)', () => {
    it('returns status `mismatch` with old + new hashes when content changes', () => {
      const store = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_WARN })
      store.inspect('/abs/skill.md', 'original')
      store.flush()

      const store2 = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_WARN })
      const r = store2.inspect('/abs/skill.md', 'changed')
      assert.equal(r.status, 'mismatch')
      assert.equal(r.oldHash, sha256Hex('original'))
      assert.equal(r.newHash, sha256Hex('changed'))
      assert.equal(r.blocked, false)
    })

    it('does NOT overwrite the recorded hash on mismatch (warn mode)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_WARN })
      store.inspect('/abs/skill.md', 'original')
      store.flush()

      const store2 = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_WARN })
      store2.inspect('/abs/skill.md', 'changed')
      store2.flush()

      // The persisted record should still be the original hash — operator
      // must explicitly accept the new value via `acceptHash`.
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/skill.md'].sha256, sha256Hex('original'))
    })
  })

  describe('inspect — mismatch (block mode)', () => {
    it('flags blocked=true so the loader can filter the skill out', () => {
      const store = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_BLOCK })
      store.inspect('/abs/skill.md', 'original')
      store.flush()

      const store2 = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_BLOCK })
      const r = store2.inspect('/abs/skill.md', 'changed')
      assert.equal(r.status, 'mismatch')
      assert.equal(r.blocked, true)
    })
  })

  describe('acceptHash', () => {
    it('replaces the recorded hash for an existing path', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'original')
      store.flush()

      store.acceptHash('/abs/skill.md', 'new content')
      store.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/skill.md'].sha256, sha256Hex('new content'))
    })

    it('records a brand-new entry if the path was unseen', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.acceptHash('/abs/never-seen.md', 'body')
      store.flush()
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/never-seen.md'].sha256, sha256Hex('body'))
    })

    // #3235 acceptance criterion: round-trip through the loader. Mismatch
    // in block mode → skill filtered → operator accepts → next load → skill
    // loads. This is the exact recovery flow the new `skill_trust_accept`
    // WS handler triggers.
    it('block-mode round trip: mismatch filters → acceptHash → skill reloads (#3235)', async () => {
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-trust-skills-'))
      try {
        const skillPath = join(skillsDir, 's.md')
        const { loadActiveSkillsLayered } = await import('../src/skills-loader.js')

        // Step 1: first load with body 'v1' records the hash.
        writeFileSync(skillPath, 'v1 body\n')
        const store = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_BLOCK })
        const initial = loadActiveSkillsLayered({ globalDir: skillsDir, trustStore: store })
        assert.equal(initial.length, 1, 'first load records the hash and emits the skill')
        store.flush()

        // Step 2: modify the skill body. Block mode now filters it.
        writeFileSync(skillPath, 'v2 body\n')
        const blocked = loadActiveSkillsLayered({ globalDir: skillsDir, trustStore: store })
        assert.equal(blocked.length, 0, 'block mode filters the changed skill')

        // Step 3: operator accepts the new content. The handler reads the
        // skill body via `_getSkills()` — for the round-trip test we just
        // call the store directly with what the handler would have read
        // (the realpath + the in-memory body it was about to load).
        const realPath = realpathSync(skillPath)
        store.acceptHash(realPath, 'v2 body\n')
        store.flush()

        // Step 4: next load — skill is back, hash matches new content.
        const reloaded = loadActiveSkillsLayered({ globalDir: skillsDir, trustStore: store })
        assert.equal(reloaded.length, 1,
          'after acceptHash + flush, the next load must include the previously-filtered skill')
        assert.equal(reloaded[0].name, 's')

        // And the persisted ledger reflects the new hash.
        const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
        // v2 format: records nested under `skills`
        const records = persisted.skills || persisted
        const recordedHash = records[realPath]?.sha256 || records[_normalizePathKey(realPath)]?.sha256
        assert.equal(recordedHash, sha256Hex('v2 body\n'))
      } finally {
        rmSync(skillsDir, { recursive: true, force: true })
      }
    })
  })

  describe('malformed trust files', () => {
    it('treats a corrupted JSON file as empty (does not crash)', () => {
      writeFileSync(trustPath, '{ this is not json')
      const store = new SkillsTrustStore({ filePath: trustPath })
      const r = store.inspect('/abs/x.md', 'body')
      assert.equal(r.status, 'recorded',
        'corrupted file must be treated as empty so first-seen recording proceeds')
    })

    it('treats a missing file as empty (no-op on flush when nothing changed)', () => {
      assert.ok(!existsSync(trustPath), 'sanity: file should not exist')
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.flush()
      // Nothing was inspected, nothing dirty — flush is a no-op.
      assert.ok(!existsSync(trustPath))
    })

    it('drops records missing required fields (sha256 must match /^[0-9a-f]{64}$/)', () => {
      // Use v2 format so the parser reaches the record validation step.
      const bad = {
        skills: {
          '/abs/x.md': { sha256: 'not-hex', firstSeen: '2024-01-01T00:00:00.000Z' },
          '/abs/y.md': { sha256: sha256Hex('y'), firstSeen: '2024-01-01T00:00:00.000Z' },
          '/abs/z.md': null,
        },
      }
      writeFileSync(trustPath, JSON.stringify(bad))

      const store = new SkillsTrustStore({ filePath: trustPath })
      // /abs/x.md had a malformed sha so it's dropped — first inspect with
      // any body records cleanly (status 'recorded').
      assert.equal(store.inspect('/abs/x.md', 'fresh').status, 'recorded')
      // /abs/y.md had a clean record so it's retained.
      assert.equal(store.inspect('/abs/y.md', 'y').status, 'verified')
      // /abs/z.md had a null record — also dropped → first-seen.
      assert.equal(store.inspect('/abs/z.md', 'z').status, 'recorded')
    })

    it('treats a non-object root (array) as empty', () => {
      writeFileSync(trustPath, JSON.stringify(['not', 'an', 'object']))
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.inspect('/abs/x.md', 'body').status, 'recorded')
    })
  })

  describe('persistence resilience', () => {
    it('does not throw if the trust file directory does not yet exist (mkdir)', () => {
      const nestedPath = join(dir, 'deeper', 'than', 'before', 'trust.json')
      const store = new SkillsTrustStore({ filePath: nestedPath })
      store.inspect('/abs/x.md', 'body')
      store.flush()
      assert.ok(existsSync(nestedPath), 'mkdirSync recursive should have created the directory')
    })

    it('throws on write failure so callers can surface persistence errors', () => {
      // Point at a directory path so writeFileSync errors with EISDIR.
      const store = new SkillsTrustStore({ filePath: dir })
      store.inspect('/abs/x.md', 'body')
      // flush() re-throws after cleanup so handlers can return TRUST_FLUSH_FAILED.
      assert.throws(() => store.flush(), /EISDIR|illegal operation/)
    })
  })

  describe('mode coercion', () => {
    it('defaults to warn when mode is omitted', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.mode, TRUST_MODE_WARN)
    })

    it('coerces unknown values to warn', () => {
      const store = new SkillsTrustStore({ filePath: trustPath, mode: 'banana' })
      assert.equal(store.mode, TRUST_MODE_WARN)
    })

    it('accepts an explicit block mode', () => {
      const store = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_BLOCK })
      assert.equal(store.mode, TRUST_MODE_BLOCK)
    })
  })

  // #3232: atomic write (temp+rename) + chmod 0600.
  describe('atomic write + 0600 (#3232)', () => {
    it('writes through <path>.tmp then renames to the target', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()

      // Target file exists and parses cleanly.
      assert.ok(existsSync(trustPath), 'target file should exist after flush')
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      // v2 format: records are nested under `skills`. Lookup uses the platform-normalised key.
      const expectedKey = _normalizePathKey('/abs/skill.md')
      assert.ok(persisted.skills[expectedKey], 'record should be persisted under normalised key')

      // Temp file should NOT linger after a clean flush — the rename
      // moved it onto the target. Anything left at <path>.tmp is a
      // leak / orphan.
      assert.ok(!existsSync(`${trustPath}.tmp`),
        '.tmp sibling must be cleaned up by rename')
    })

    it('writes file with mode 0600 (POSIX only)', { skip: process.platform === 'win32' }, () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()

      const stat = statSync(trustPath)
      // Lower 9 bits = perm; mask off type bits. 0o600 = owner rw, no group/other.
      const perm = stat.mode & 0o777
      assert.equal(perm, 0o600,
        `expected mode 0600, got 0${perm.toString(8)}`)
    })

    it('does not corrupt the target file when a stale .tmp pre-exists (orphan from prior crash)', () => {
      // Each writer now uses a unique temp path (pid + random suffix)
      // to avoid the concurrent-writer race fixed in PR #3238 review.
      // A stale `<path>.tmp` at the legacy fixed path therefore stays —
      // we don't touch other writers' temps. The two correctness
      // properties this test pins:
      //   1. The fresh flush writes a clean target (independent of
      //      any orphan temp).
      //   2. `_load()` (covered in the sibling test below) ignores
      //      the stale .tmp at read time, so the orphan can't poison
      //      future reads.
      const legacyTmpPath = `${trustPath}.tmp`
      writeFileSync(legacyTmpPath, '{ partial json — orphan from prior crash')

      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      const expectedKey = _normalizePathKey('/abs/skill.md')
      // v2 format: records nested under `skills`
      assert.ok(persisted.skills[expectedKey], 'fresh record should land cleanly despite stale orphan')

      // The orphan persists (we don't touch other writers' temps to
      // preserve the concurrent-writer fix from #3238 review). It's
      // ignored by `_load()` — see the next test for that assertion.
      // Cleanup is the operator's responsibility (or a future periodic
      // sweep — tracked separately).
    })

    // Regression for the Copilot review on #3238: BaseSession constructs
    // one SkillsTrustStore per session pointing at the same default
    // ledger, so two concurrent flushes must not collide on the same
    // .tmp filename and accidentally invalidate each other's open fd.
    // Fixed by giving each writer a unique pid+random temp suffix.
    it('two concurrent flushes do not race on the same .tmp filename', () => {
      const storeA = new SkillsTrustStore({ filePath: trustPath })
      const storeB = new SkillsTrustStore({ filePath: trustPath })
      storeA.inspect('/abs/skill-a.md', 'body-a')
      storeB.inspect('/abs/skill-b.md', 'body-b')

      // Interleaved flushes — neither should clobber the other or
      // throw an ENOENT-on-rename error.
      storeA.flush()
      storeB.flush()
      storeA.flush()
      storeB.flush()

      // #8068: flush() now merges with what's on disk instead of
      // overwriting it, so BOTH records survive the interleaving — not
      // just whichever writer happened to land last.
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted && typeof persisted === 'object', 'target must be valid JSON')
      assert.ok(persisted.skills['/abs/skill-a.md'], 'storeA\'s record must survive storeB\'s flush')
      assert.ok(persisted.skills['/abs/skill-b.md'], 'storeB\'s record must survive storeA\'s flush')
    })

    it('_load ignores a stale .tmp file (does not parse it as the ledger)', () => {
      // Set up a valid target...
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()

      // ...and a corrupt sibling temp from a crashed write.
      writeFileSync(`${trustPath}.tmp`, '{ this is broken')

      // A fresh store should ONLY consult the target — the corrupt
      // temp must not poison the load.
      const store2 = new SkillsTrustStore({ filePath: trustPath })
      const r = store2.inspect('/abs/skill.md', 'body')
      assert.equal(r.status, 'verified',
        'load must read the canonical target and ignore the .tmp orphan')
    })

    it('throws on write failure without corrupting an unrelated target', () => {
      // Seed a valid target file.
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'original')
      store.flush()
      const before = readFileSync(trustPath, 'utf8')

      // Now point the store at a directory path so the rename target
      // is invalid and the atomic-write throws. The cleanup path must
      // leave the unrelated good file untouched.
      const badStore = new SkillsTrustStore({ filePath: dir })
      badStore.inspect('/abs/x.md', 'body')
      assert.throws(() => badStore.flush(), /EISDIR|illegal operation/)

      // The original good file is untouched.
      assert.equal(readFileSync(trustPath, 'utf8'), before,
        'unrelated good file must not be affected by a failed flush elsewhere')
    })
  })

  // #3233: case-insensitive ledger key normalisation (macOS APFS, Windows NTFS).
  describe('case-insensitive key normalisation (#3233)', () => {
    it('_normalizePathKey lowercases on macOS / Windows, leaves Linux verbatim', () => {
      const path = '/Users/Me/.chroxy/skills/Foo.md'
      const norm = _normalizePathKey(path)
      if (process.platform === 'darwin' || process.platform === 'win32') {
        assert.equal(norm, path.toLowerCase(),
          'case-insensitive FS should fold to lower case')
      } else {
        assert.equal(norm, path,
          'case-sensitive FS should leave the key verbatim')
      }
    })

    it('_normalizePathKey handles non-string input', () => {
      assert.equal(_normalizePathKey(null), '')
      assert.equal(_normalizePathKey(undefined), '')
      assert.equal(_normalizePathKey(42), '')
    })

    // The interesting macOS / Windows invariant: a write under one
    // casing must round-trip cleanly when read back under another.
    // We can only verify the behaviour the helper actually picks for
    // the current platform.
    it('lookup is case-insensitive on macOS / Windows', { skip: !(process.platform === 'darwin' || process.platform === 'win32') }, () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      // Record under one casing.
      store.inspect('/Users/me/.chroxy/skills/Foo.md', 'body')
      store.flush()

      // Re-inspect under a different casing of the same logical path.
      const r = store.inspect('/users/ME/.chroxy/skills/foo.md', 'body')
      assert.equal(r.status, 'verified',
        'case-only differences must resolve to the same record on case-insensitive FS')
    })

    it('lookup is case-sensitive on Linux (#3233 leaves verbatim)', { skip: process.platform !== 'linux' }, () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/Foo.md', 'body')
      store.flush()

      // Different casing must NOT match on Linux — same legitimate file
      // with a distinct realpath.
      const r = store.inspect('/abs/foo.md', 'body')
      assert.equal(r.status, 'recorded',
        'case-sensitive FS must treat differing casings as distinct keys')
    })

    it('persists ledger keys in normalised form (so future loads still find them)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/Some/Mixed/Case/skill.md', 'body')
      store.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      const expectedKey = _normalizePathKey('/Some/Mixed/Case/skill.md')
      // v2 format: records nested under `skills`
      assert.ok(persisted.skills[expectedKey],
        `expected key ${expectedKey} in persisted ledger`)
    })

    it('upgrades a verbatim-cased pre-#3233 ledger entry on next read (case-insensitive FS)', { skip: !(process.platform === 'darwin' || process.platform === 'win32') }, () => {
      // Hand-write a ledger entry with mixed casing — simulates a
      // ledger written by an older chroxy before #3233.
      const sha = sha256Hex('body')
      writeFileSync(trustPath, JSON.stringify({
        '/Users/Me/.chroxy/skills/Foo.md': {
          sha256: sha,
          firstSeen: '2024-01-01T00:00:00.000Z',
          lastVerified: '2024-01-01T00:00:00.000Z',
        },
      }))

      // Now open the ledger fresh — _load should normalise the key —
      // and inspect under a different casing.
      const store = new SkillsTrustStore({ filePath: trustPath })
      const r = store.inspect('/users/me/.chroxy/skills/foo.md', 'body')
      assert.equal(r.status, 'verified',
        'pre-#3233 verbatim-cased entries must still be found after normalisation')
    })
  })

  // #3297: v2 schema migration from v1 flat format.
  describe('v2 schema migration (#3297)', () => {
    it('migrates v1 flat format to v2 on next flush', () => {
      const sha = sha256Hex('body')
      writeFileSync(trustPath, JSON.stringify({
        '/abs/skill.md': { sha256: sha, firstSeen: '2024-01-01T00:00:00.000Z', lastVerified: '2024-01-01T00:00:00.000Z' },
      }))

      const store = new SkillsTrustStore({ filePath: trustPath })
      // Legacy records should still be accessible
      assert.equal(store.inspect('/abs/skill.md', 'body').status, 'verified')
      // Migration marks the store dirty so flush rewrites
      assert.equal(store._dirty, true, 'v1 migration should mark store dirty')
      store.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      // After migration, the file should be in v2 format
      assert.ok(persisted.skills, 'v2 format should have a `skills` key')
      assert.ok(persisted.communityTrust, 'v2 format should have a `communityTrust` key')
      assert.ok(persisted.skills[_normalizePathKey('/abs/skill.md')], 'migrated record should exist under `skills`')
    })

    it('loads v2 format without migration (no dirty flag)', () => {
      const sha = sha256Hex('body')
      writeFileSync(trustPath, JSON.stringify({
        skills: {
          '/abs/skill.md': { sha256: sha, firstSeen: '2024-01-01T00:00:00.000Z', lastVerified: '2024-01-01T00:00:00.000Z' },
        },
        communityTrust: { 'by-author': {}, 'by-path': {} },
      }))

      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store._dirty, false, 'v2 load should not mark store dirty')
      assert.equal(store.inspect('/abs/skill.md', 'body').status, 'verified')
    })

    it('empty v1 file (no records) is treated as fresh v2', () => {
      writeFileSync(trustPath, JSON.stringify({}))
      const store = new SkillsTrustStore({ filePath: trustPath })
      // Empty flat object treated as v2 with no records, not v1 migration
      assert.equal(store._dirty, false)
      assert.equal(store.inspect('/abs/x.md', 'body').status, 'recorded')
    })

    // #3306: a single corrupted v1 entry must NOT cause the entire file to be
    // discarded. The v1 classifier was a strict `every()` so a missing /
    // malformed `sha256` on one record made `looksLikeV1 === false` and the
    // whole file fell through to "unrecognised shape" — wiping every other
    // legitimately-recorded skill. Tolerate malformed entries: classify as v1
    // when at least one entry passes the sha256 test and rely on the per-entry
    // loop to drop the bad record.
    it('migrates v1 file with one malformed entry and keeps the valid records', () => {
      const shaA = sha256Hex('body-a')
      const shaC = sha256Hex('body-c')
      writeFileSync(trustPath, JSON.stringify({
        '/abs/a.md': { sha256: shaA, firstSeen: '2024-01-01T00:00:00.000Z', lastVerified: '2024-01-01T00:00:00.000Z' },
        // Malformed entry: sha256 is the wrong length (not 64 hex chars).
        '/abs/b.md': { sha256: 'not-a-real-hash', firstSeen: '2024-01-01T00:00:00.000Z' },
        '/abs/c.md': { sha256: shaC, firstSeen: '2024-01-02T00:00:00.000Z', lastVerified: '2024-01-02T00:00:00.000Z' },
      }))

      const store = new SkillsTrustStore({ filePath: trustPath })
      // The two valid entries survive the migration.
      assert.equal(store.inspect('/abs/a.md', 'body-a').status, 'verified')
      assert.equal(store.inspect('/abs/c.md', 'body-c').status, 'verified')
      // The malformed entry is dropped — first inspect re-records it.
      assert.equal(store.inspect('/abs/b.md', 'body-b').status, 'recorded')
    })

    it('treats v1 file with all-malformed entries as unrecognised (fail open)', () => {
      writeFileSync(trustPath, JSON.stringify({
        '/abs/a.md': { sha256: 'short', firstSeen: '2024-01-01T00:00:00.000Z' },
        '/abs/b.md': { firstSeen: '2024-01-01T00:00:00.000Z' },
      }))
      const store = new SkillsTrustStore({ filePath: trustPath })
      // No entries pass the sha256 test → not v1 → fail open with empty state.
      assert.equal(store._dirty, false)
      assert.equal(store.inspect('/abs/a.md', 'body').status, 'recorded')
    })

    // #3511: the v1 classifier must require BOTH sha256 (correct shape) AND
    // firstSeen — otherwise a file whose entries carry a valid-looking
    // sha256 but no firstSeen would classify as v1, the per-entry parse loop
    // would drop every record (firstSeen is required there too), migration
    // would proceed with an empty ledger, and the next flush would wipe the
    // file to an empty v2 shape. Requiring firstSeen in the classifier makes
    // these files fall through to "unrecognised" and fail open without
    // overwriting the existing on-disk content.
    it('treats v1 file with valid sha256 but no firstSeen as unrecognised (fail open)', () => {
      const shaA = sha256Hex('body-a')
      const shaB = sha256Hex('body-b')
      writeFileSync(trustPath, JSON.stringify({
        // Valid-looking sha256 but no firstSeen on every entry.
        '/abs/a.md': { sha256: shaA },
        '/abs/b.md': { sha256: shaB },
      }))
      const store = new SkillsTrustStore({ filePath: trustPath })
      // Classifier rejects the file → not v1 → load/migration path leaves
      // the store with an empty ledger and `_dirty = false`. (A subsequent
      // `inspect()` for any skill will of course flip `_dirty = true` and
      // BaseSession's `flush()` would then persist a fresh v2 ledger —
      // that's the intended fail-open recovery, NOT a destructive overwrite
      // of the original v1 records, because the classifier rejected those
      // records and the in-memory ledger started empty.)
      assert.equal(store._dirty, false, 'unrecognised file must not mark store dirty')
      assert.equal(
        store.inspect('/abs/a.md', 'body-a').status,
        'recorded',
        'sha256-only entries must be treated as first-seen, not verified',
      )
    })

    // #3511 defence-in-depth: array-valued entries pass the bare
    // `typeof === 'object'` check so the tightened predicate
    // explicitly rejects them with `!Array.isArray(v)`. Standard
    // JSON serialisation drops named properties on arrays so the
    // array branch is unreachable from a normal JSON file — the
    // guard exists to catch a hand-crafted or out-of-band parser
    // path. This test verifies a JSON array in the entry slot is
    // treated as unrecognised.
    it('treats v1 file with array-valued entries as unrecognised (fail open)', () => {
      // Direct JSON literal so the parsed value is a real array.
      writeFileSync(trustPath, '{"/abs/a.md": ["a", "b"]}')
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store._dirty, false, 'array-valued entry must not classify as v1')
      assert.equal(store.inspect('/abs/a.md', 'body').status, 'recorded')
    })

    // #3511 PR #3531 review: the previous array test only proved that
    // an array without sha256/firstSeen fails the predicate (which it
    // would even without the new `!Array.isArray` guard). To actually
    // exercise the new guard, the array must satisfy
    // `typeof v.sha256 === 'string'` AND `typeof v.firstSeen === 'string'`.
    // The only way to achieve that on a JSON-parsed value is via
    // Array.prototype pollution. We do that here in a try/finally so
    // the prototype is restored even if the assertion fails — leaving
    // residual prototype properties would corrupt every subsequent
    // test run. Without `!Array.isArray(v)` the polluted array would
    // satisfy the predicate, classify the file as v1, and the
    // per-entry parse loop would (depending on iteration semantics)
    // either drop or accept it. The guard rejects it outright.
    it('rejects array entries even when sha256/firstSeen exist on Array.prototype', () => {
      const sha = sha256Hex('body')
      const firstSeen = '2024-01-01T00:00:00.000Z'
      try {
        Object.defineProperty(Array.prototype, 'sha256', {
          value: sha,
          configurable: true,
          enumerable: false,
        })
        Object.defineProperty(Array.prototype, 'firstSeen', {
          value: firstSeen,
          configurable: true,
          enumerable: false,
        })
        // Sanity: a polluted array now reports the predicate's would-be
        // matchers as truthy — exactly what `!Array.isArray(v)` must reject.
        const probe = []
        assert.equal(typeof probe.sha256, 'string')
        assert.equal(typeof probe.firstSeen, 'string')

        // Direct JSON literal so the parsed value is a real array.
        writeFileSync(trustPath, '{"/abs/a.md": ["payload"]}')
        const store = new SkillsTrustStore({ filePath: trustPath })
        // Without the `!Array.isArray` guard this would have classified
        // as v1 and set `migratedLegacy = true` (via prototype lookup of
        // sha256 + firstSeen). The guard rejects it → empty load.
        assert.equal(store._dirty, false, 'array entry must not classify as v1 even with prototype pollution')
        assert.equal(store.inspect('/abs/a.md', 'body').status, 'recorded')
      } finally {
        delete Array.prototype.sha256
        delete Array.prototype.firstSeen
      }
    })
  })

  // #3297: isCommunityTrusted method.
  describe('isCommunityTrusted (#3297)', () => {
    it('returns false when neither author nor path is trusted', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.isCommunityTrusted('/community/alice/skill.md', 'alice'), false)
    })

    it('returns true when author is trusted (byAuthor index)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.communityTrust.byAuthor['alice'] = { grantedAt: new Date().toISOString(), grantedBy: 'user' }
      assert.equal(store.isCommunityTrusted('/community/alice/skill.md', 'alice'), true)
    })

    it('returns true when path is trusted (byPath index)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.communityTrust.byPath['/community/alice/skill.md'] = { grantedAt: new Date().toISOString() }
      assert.equal(store.isCommunityTrusted('/community/alice/skill.md', 'alice'), true)
    })

    it('handles missing/invalid arguments gracefully', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.isCommunityTrusted(null, null), false)
      assert.equal(store.isCommunityTrusted('', ''), false)
      assert.equal(store.isCommunityTrusted(undefined, undefined), false)
    })
  })

  // #3297: grantCommunityTrust method.
  describe('grantCommunityTrust (#3297)', () => {
    it('records author in byAuthor index', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.grantCommunityTrust('alice')
      assert.ok(store.communityTrust.byAuthor['alice'], 'byAuthor should have alice')
      assert.equal(typeof store.communityTrust.byAuthor['alice'].grantedAt, 'string')
      assert.equal(store.communityTrust.byAuthor['alice'].grantedBy, 'user')
    })

    it('records realPath in byPath index when provided', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' })
      assert.ok(store.communityTrust.byPath['/community/alice/skill.md'], 'byPath should have the path')
    })

    it('persists community trust to disk in v2 format', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' })

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted.communityTrust, 'must have communityTrust key')
      assert.ok(persisted.communityTrust['by-author']['alice'], 'by-author must have alice')
      assert.ok(persisted.communityTrust['by-path']['/community/alice/skill.md'], 'by-path must have path')
    })

    it('makes isCommunityTrusted return true after grant', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.isCommunityTrusted('/community/alice/skill.md', 'alice'), false)
      store.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' })
      assert.equal(store.isCommunityTrusted('/community/alice/skill.md', 'alice'), true)
    })

    it('round-trips through reload: granted trust persists after reload', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' })

      const store2 = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store2.isCommunityTrusted('/community/alice/skill.md', 'alice'), true,
        'community trust must survive a store reload')
    })

    it('ignores invalid author (non-string / empty)', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.grantCommunityTrust(null)
      store.grantCommunityTrust('')
      store.grantCommunityTrust(undefined)
      // No entries should have been recorded
      assert.equal(Object.keys(store.communityTrust.byAuthor).length, 0)
    })

    // #8068: BaseSession constructs one SkillsTrustStore PER SESSION against
    // the same default ledger, so this is the same two-writer shape as the
    // binary-trust.json bug — just with many more instances in practice. A
    // grant from one session must not be lost at another session's next
    // flush, the same way a records-map pin must not be.
    it('a grant from one instance is not lost at another instance\'s next flush', () => {
      const storeA = new SkillsTrustStore({ filePath: trustPath })
      const storeB = new SkillsTrustStore({ filePath: trustPath })

      storeA.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' })
      // storeB loaded before storeA's grant, so it never saw alice — but its
      // own grant must not erase alice's on the flush that follows.
      storeB.grantCommunityTrust('bob', { realPath: '/community/bob/skill.md' })

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted.communityTrust['by-author']['alice'], 'alice\'s grant must survive')
      assert.ok(persisted.communityTrust['by-author']['bob'], 'bob\'s grant is still there too')
      assert.ok(persisted.communityTrust['by-path']['/community/alice/skill.md'])
      assert.ok(persisted.communityTrust['by-path']['/community/bob/skill.md'])
    })

    // #8072 review round 2, S2: `_mergeExtra` must be SKIPPED on a
    // `readFailed` flush the same way the base's `_records` merge falls
    // back to memory — calling it anyway with a null `parsed` re-merges
    // `communityTrust` from an EMPTY disk view, which drops every grant
    // this instance holds but did not itself change this flush (alice's,
    // below), in memory AND on disk, even though nothing about alice's
    // grant was actually lost or corrupted.
    it('a community grant this instance did not change survives a flush that hits a corrupt re-read', () => {
      const storeA = new SkillsTrustStore({ filePath: trustPath })
      storeA.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' })

      // storeB is constructed AFTER storeA's grant, so it holds alice's
      // grant in memory too — the exact shape that `_mergeExtra` must
      // preserve when it can't reliably read what's on disk right now.
      const storeB = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(storeB.isCommunityTrusted('/community/alice/skill.md', 'alice'), true)

      // Corrupt the file directly, simulating a crash mid-write from a
      // THIRD process landing between storeB's load and its next flush.
      writeFileSync(trustPath, '{ this is not valid json, corrupted mid-write')

      // storeB grants bob — a change it DID make this flush.
      storeB.grantCommunityTrust('bob', { realPath: '/community/bob/skill.md' })

      // alice's grant — which storeB never touched — must survive, both in
      // storeB's own memory and on disk.
      assert.equal(storeB.isCommunityTrusted('/community/alice/skill.md', 'alice'), true,
        'alice\'s grant must survive in memory even though the re-read failed')
      assert.equal(storeB.isCommunityTrusted('/community/bob/skill.md', 'bob'), true)

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted.communityTrust['by-author']['alice'],
        'alice\'s grant must survive ON DISK — a corrupt re-read must fall back to this instance\'s own records, not an empty communityTrust')
      assert.ok(persisted.communityTrust['by-author']['bob'])
    })
  })

  // #8068: `inspect()`'s first-seen / lastVerified-bump paths route through
  // the base's `_setRecord` (not a direct `_records[key] = …` assignment) so
  // they participate in flush()'s merge the same way `approve()` does.
  describe('records merge across instances (#8068)', () => {
    it('a first-seen record from one instance survives another instance\'s next flush', () => {
      const storeA = new SkillsTrustStore({ filePath: trustPath })
      const storeB = new SkillsTrustStore({ filePath: trustPath })

      storeA.inspect('/abs/a.md', 'body-a')
      storeA.flush()
      storeB.inspect('/abs/b.md', 'body-b')
      storeB.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted.skills['/abs/a.md'], 'storeA\'s record must survive storeB\'s flush')
      assert.ok(persisted.skills['/abs/b.md'], 'storeB\'s record is still there too')
    })
  })

  // #8072 review C1: a plain-object merge target (`{ ...spread }`) lets an
  // author/path named `constructor`/`toString`/`valueOf`/`__proto__` resolve
  // through the prototype chain to a truthy value in `isCommunityTrusted`'s
  // bracket-key check — a repo-local `community/constructor/*.md` would be
  // trusted without ever being granted.
  describe('the merge stays null-prototype (#8072 review C1)', () => {
    it('does not trust prototype-named authors/paths after a flush', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      // Any flush at all must exercise the merge path — a plain skill
      // record is enough to dirty the store.
      store.inspect('/abs/skill.md', 'body')
      store.flush()

      for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
        assert.equal(store.isCommunityTrusted('/x', name), false, `author "${name}" must not be trusted`)
        assert.equal(store.isCommunityTrusted(name, 'nobody'), false, `path "${name}" must not be trusted`)
      }
      assert.equal(Object.getPrototypeOf(store._records), null,
        '_records must stay null-prototype after a flush')
      assert.equal(Object.getPrototypeOf(store.communityTrust.byAuthor), null,
        'communityTrust.byAuthor must stay null-prototype after a flush')
      assert.equal(Object.getPrototypeOf(store.communityTrust.byPath), null,
        'communityTrust.byPath must stay null-prototype after a flush')
    })
  })

  // #8072 review S1: mutant m3 ("clear the change-set before the write")
  // killed by this test for skills' OWN `_changedAuthors`/`_changedByPaths`
  // tracking — the base-class `_changedKeys` retention is covered in
  // path-hash-trust-ledger.test.js, but `communityTrust` is skills-specific
  // state the base's retry guarantee doesn't reach on its own.
  describe('_changedAuthors/_changedByPaths retention across a failed write (#8072 review S1)', () => {
    it('retains every pending grant across a failed write, so the next flush retries them all', () => {
      const store = new FlakySkillsTrustStore({ filePath: trustPath })
      store.grantCommunityTrust('alice', { realPath: '/community/alice/skill.md' }) // succeeds

      store._failNextSerialize = true
      // Skills re-throws on a failed flush (throwOnFlushError: true).
      assert.throws(() => store.grantCommunityTrust('bob', { realPath: '/community/bob/skill.md' }), /boom/)

      store.grantCommunityTrust('carol', { realPath: '/community/carol/skill.md' }) // retries

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted.communityTrust['by-author']['alice'])
      assert.ok(persisted.communityTrust['by-author']['bob'],
        'bob must land on the retry — _changedAuthors must not have been cleared before the failed write')
      assert.ok(persisted.communityTrust['by-author']['carol'])
      assert.ok(persisted.communityTrust['by-path']['/community/bob/skill.md'],
        '_changedByPaths must also survive the failed write')
    })
  })

  // #8072 review C3: TOFU first-sight pins (`inspect()`'s `recorded` branch)
  // and `lastVerified` bumps (`inspect()`'s `verified` branch) are not
  // operator decisions — they're written from a possibly-stale snapshot, so
  // the merge must not let them override a pin/decision this instance never
  // saw. Only `acceptHash`/`grantCommunityTrust` (explicit operator actions)
  // are last-writer-wins.
  describe('implicit writes never override an explicit decision (#8072 review C3)', () => {
    it('a stale instance\'s TOFU of a tampered hash does not overwrite another instance\'s real pin (block mode)', () => {
      // 1. A is constructed — before B's pin exists on disk.
      const a = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_BLOCK })
      // 2. B pins s.md = v1 and flushes it.
      const b = new SkillsTrustStore({ filePath: trustPath, mode: TRUST_MODE_BLOCK })
      const v1 = 'v1 body'
      assert.equal(b.inspect('/abs/s.md', v1).status, 'recorded')
      b.flush()

      // 3. s.md is tampered with (simulated: a different body from here on).
      const tampered = 'tampered body'

      // 4. A inspect()s the tampered body. A never loaded b's pin (it was
      //    constructed before b flushed), so this looks like first sight to
      //    A too — a TOFU record of the TAMPERED hash.
      assert.equal(a.inspect('/abs/s.md', tampered).status, 'recorded')

      // 5. B inspect()s the tampered body — B DOES have the v1 record, so
      //    this is a genuine mismatch/blocked detection.
      const bMismatch = b.inspect('/abs/s.md', tampered)
      assert.equal(bMismatch.status, 'mismatch')
      assert.equal(bMismatch.blocked, true)

      // A's stale TOFU pin of the tampered hash reaches disk here — it must
      // not override b's genuine v1 pin.
      a.flush()

      // 6. B flushes for an unrelated first-seen skill.
      b.inspect('/abs/unrelated.md', 'unrelated body')
      b.flush()

      // 7. B inspect()s again — must still detect the mismatch, not
      //    silently "verify" against whatever a's flush might have written.
      const finalResult = b.inspect('/abs/s.md', tampered)
      assert.equal(finalResult.status, 'mismatch', 'b must still detect the tampered content, not adopt it')
      assert.equal(finalResult.blocked, true)

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/s.md'].sha256, sha256Hex(v1),
        'disk must still hold the genuine v1 pin, not the tampered hash')
    })

    it('a lastVerified touch bump does not revert another session\'s acceptHash', () => {
      const a = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      const original = 'original body'
      assert.equal(a.inspect('/abs/s.md', original).status, 'recorded')
      a.flush()

      // b loads the same original hash (sees a's pin).
      const b = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      assert.equal(b.getRecord('/abs/s.md').sha256, sha256Hex(original))

      // An operator (via a's session) explicitly accepts a NEW hash for
      // this path.
      const accepted = 'accepted new body'
      a.acceptHash('/abs/s.md', accepted)
      a.flush()

      // b, still holding the OLD hash in memory, re-inspects with the OLD
      // body (its own copy of the skill hasn't been re-read from disk) and
      // gets a "verified" bump against its own now-superseded hash — that
      // bump must not revert a's explicit acceptHash on disk.
      const bResult = b.inspect('/abs/s.md', original)
      assert.equal(bResult.status, 'verified', 'b still thinks its own copy matches — expected, not the bug')
      b.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/s.md'].sha256, sha256Hex(accepted),
        'b\'s touch bump must not revert a\'s explicit acceptHash')
    })

    it('a TOFU record DOES apply when nobody else holds a record for that path', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      assert.equal(store.inspect('/abs/new.md', 'body').status, 'recorded')
      store.flush()
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/new.md'].sha256, sha256Hex('body'))
    })
  })

  // #8072 review round 2, S3: `_recordChange`'s "never downgrade" rule
  // (set/delete outrank tofu outranks touch) is what keeps an explicit
  // decision from being silently demoted to a skippable implicit write
  // within the SAME dirty window. Mutants OWN1 (always take the latest op,
  // no priority check) and OWN2 (rank tofu above set/delete) both break a
  // real sequence without touching any of the other #8072 tests.
  describe('a tracked op is never silently downgraded within one dirty window (#8072 review round 2, S3)', () => {
    it('an acceptHash is not lost to a same-window touch bump checked against another instance\'s hash (kills OWN1)', () => {
      const stale = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      assert.equal(stale.inspect('/abs/s.md', 'v0').status, 'recorded')
      stale.flush() // disk: v0

      // A different instance re-approves the path with its own hash first —
      // `stale` never sees this.
      const other = new SkillsTrustStore({ filePath: trustPath })
      other.acceptHash('/abs/s.md', 'e0d274-body')
      other.flush() // disk: e0d274-body's hash

      // `stale`, unaware, makes its OWN explicit decision (acceptHash —
      // tagged 'set') for the same path...
      stale.acceptHash('/abs/s.md', 'fb04dc-body')
      // ...then, in the SAME dirty window (before flushing), re-inspects
      // with that SAME body it just accepted — a 'verified' hit against its
      // own now-current record, which (with verifyThrottleMs: 0) always
      // bumps `lastVerified`, a 'touch'. The tracked op for this key must
      // NOT be demoted from 'set' to 'touch' by this — 'set' is an explicit
      // decision and must keep winning the merge.
      const verified = stale.inspect('/abs/s.md', 'fb04dc-body')
      assert.equal(verified.status, 'verified')

      stale.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/s.md'].sha256, sha256Hex('fb04dc-body'),
        'the explicit acceptHash must win — a same-window touch must not silently downgrade it to a skippable implicit write')
    })

    it('a revoke is not lost to a same-window TOFU re-record after its own flush failed (kills OWN1 and OWN2)', () => {
      const stale = new FlakySkillsTrustStore({ filePath: trustPath })
      assert.equal(stale.inspect('/abs/s.md', 'body').status, 'recorded')
      stale.flush() // disk: recorded

      // The operator revokes the path — an explicit decision — but the
      // write itself is forced to fail, so the blanket clear() on success
      // does not run and the tracked 'delete' op is retained.
      stale._failNextSerialize = true
      assert.throws(() => stale.revoke('/abs/s.md'), /boom/) // skills re-throws
      assert.equal(stale.getRecord('/abs/s.md'), null, 'the revoke\'s effect on OWN memory lands regardless of the write failure')

      // In the SAME dirty window, the path is "seen" again (e.g. a re-load
      // in the same session) — since `stale`'s own records no longer have
      // it, this looks like first sight: a TOFU record. The tracked op for
      // this key must NOT be demoted from 'delete' to 'tofu' by this — the
      // operator's revoke is an explicit decision and must keep winning,
      // even though disk (where the revoke never actually landed) still
      // has the old record.
      assert.equal(stale.inspect('/abs/s.md', 'body').status, 'recorded')

      stale.flush()

      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted.skills['/abs/s.md'], undefined,
        'the revoke must eventually land — a same-window TOFU re-record must not silently downgrade it to a skippable implicit write')
    })
  })
})
