import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
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
      assert.ok(persisted['/abs/skill.md'])
      assert.equal(persisted['/abs/skill.md'].sha256, sha256Hex('body content'))
      assert.ok(typeof persisted['/abs/skill.md'].firstSeen === 'string')
      assert.ok(typeof persisted['/abs/skill.md'].lastVerified === 'string')
    })

    it('verified inspect updates lastVerified but never touches the recorded sha256', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'body')
      store.flush()
      const beforeRecord = JSON.parse(readFileSync(trustPath, 'utf8'))['/abs/skill.md']

      // Re-inspect with the same body — `lastVerified` may bump if the ISO
      // timestamp changes, but `sha256` and `firstSeen` must stay pinned.
      const store2 = new SkillsTrustStore({ filePath: trustPath })
      const r = store2.inspect('/abs/skill.md', 'body')
      store2.flush()
      assert.equal(r.status, 'verified')
      const afterRecord = JSON.parse(readFileSync(trustPath, 'utf8'))['/abs/skill.md']
      assert.equal(afterRecord.sha256, beforeRecord.sha256, 'sha256 must remain stable')
      assert.equal(afterRecord.firstSeen, beforeRecord.firstSeen, 'firstSeen must remain stable')
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
      const before = JSON.parse(readFileSync(trustPath, 'utf8'))['/abs/skill.md'].lastVerified

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
      const after = JSON.parse(readFileSync(trustPath, 'utf8'))['/abs/skill.md'].lastVerified
      assert.equal(after, before,
        'lastVerified must not advance inside the throttle window')
    })

    it('DOES bump lastVerified once the throttle window has elapsed (verifyThrottleMs: 0)', async () => {
      const store = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      store.inspect('/abs/skill.md', 'body')
      store.flush()
      const before = JSON.parse(readFileSync(trustPath, 'utf8'))['/abs/skill.md'].lastVerified

      // Sleep just long enough for the ISO timestamp to advance — 1ms
      // can land on the same string with low resolution clocks, so use
      // a small but reliable gap. throttle=0 means "always eligible".
      await new Promise((resolve) => setTimeout(resolve, 5))

      const store2 = new SkillsTrustStore({ filePath: trustPath, verifyThrottleMs: 0 })
      store2.inspect('/abs/skill.md', 'body')
      assert.equal(store2._dirty, true, 'throttle=0 should always bump and mark dirty')
      store2.flush()
      const after = JSON.parse(readFileSync(trustPath, 'utf8'))['/abs/skill.md'].lastVerified
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
      assert.equal(persisted['/abs/skill.md'].sha256, sha256Hex('original'))
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
      assert.equal(persisted['/abs/skill.md'].sha256, sha256Hex('new content'))
    })

    it('records a brand-new entry if the path was unseen', () => {
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.acceptHash('/abs/never-seen.md', 'body')
      store.flush()
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.equal(persisted['/abs/never-seen.md'].sha256, sha256Hex('body'))
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
      const bad = {
        '/abs/x.md': { sha256: 'not-hex', firstSeen: '2024-01-01T00:00:00.000Z' },
        '/abs/y.md': { sha256: sha256Hex('y'), firstSeen: '2024-01-01T00:00:00.000Z' },
        '/abs/z.md': null,
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

    it('survives a write failure without throwing (fail-open)', () => {
      // Point at a directory path so writeFileSync errors with EISDIR.
      const store = new SkillsTrustStore({ filePath: dir })
      store.inspect('/abs/x.md', 'body')
      // Should not throw — write failure is logged but swallowed.
      store.flush()
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
      // Lookup uses the platform-normalised key.
      const expectedKey = _normalizePathKey('/abs/skill.md')
      assert.ok(persisted[expectedKey], 'record should be persisted under normalised key')

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
      assert.ok(persisted[expectedKey], 'fresh record should land cleanly despite stale orphan')

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

      // Whichever writer landed last wins (they each only know about
      // their own record). The key assertion is that NEITHER flush
      // throws and the target ledger is parseable JSON.
      const persisted = JSON.parse(readFileSync(trustPath, 'utf8'))
      assert.ok(persisted && typeof persisted === 'object', 'target must be valid JSON')
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

    it('survives a write failure without throwing or corrupting target (fail-open)', () => {
      // Seed a valid target file.
      const store = new SkillsTrustStore({ filePath: trustPath })
      store.inspect('/abs/skill.md', 'original')
      store.flush()
      const before = readFileSync(trustPath, 'utf8')

      // Now point the store at a directory path so the rename target
      // is invalid and writeFileSync would have thrown EISDIR. The
      // atomic-write path catches the error and leaves the original
      // good file untouched.
      const badStore = new SkillsTrustStore({ filePath: dir })
      badStore.inspect('/abs/x.md', 'body')
      badStore.flush() // must not throw

      // The original good file is untouched (different path, but the
      // important guarantee is that a failed flush doesn't leave a
      // half-baked target on disk).
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
      assert.ok(persisted[expectedKey],
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
})
