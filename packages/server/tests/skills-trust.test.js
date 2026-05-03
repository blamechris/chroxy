import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SkillsTrustStore,
  sha256Hex,
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
})
