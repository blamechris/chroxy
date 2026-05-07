/**
 * Deterministic-order tests for the community walk in skills-loader.js (#3302).
 *
 * The community walk under `<root>/community/<author>/<file>` reads two
 * directory levels via `readdirSync`. The top-level `entries` array is sorted
 * alphabetically before the walk, but `authorEntries` (returned by
 * `readdirSync(communityPath)`) and `authorFiles` (returned by
 * `readdirSync(authorPath)`) were appended in raw filesystem order.
 *
 * Filesystem readdir order is platform-dependent (and ext4/APFS allow it to
 * shift over time on the same machine). When a tier budget cuts off skills
 * mid-walk, the set of accepted skills could differ between runs even on a
 * single host. This test pins the post-fix behaviour: regardless of the order
 * `readdirSync` returns, the loader processes community entries in
 * alphabetical order so the budget cutoff is deterministic.
 *
 * Mock strategy: `mock.module('fs', { namedExports })` BEFORE importing
 * skills-loader.js so the named imports (`readdirSync`, `statSync`,
 * `realpathSync`, etc.) bind to our wrapper. We only mutate `readdirSync`'s
 * return order — every other fs op is delegated to the real module so the
 * tmpdir-backed test fixture works end-to-end.
 *
 * Refs #3302
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

if (typeof mock.module !== 'function') {
  describe('community walk deterministic order (#3302)', () => {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
    })
  })
} else {
  const realFs = await import('fs')

  // Path-keyed reorder map. When `readdirSync(p)` is called and `p` is a key
  // in this map, return the mapped value verbatim instead of the real entries.
  // Tests populate this in beforeEach to inject reverse-alphabetical order.
  let reorderByPath = Object.create(null)

  const mockedFs = {}
  for (const key of Object.keys(realFs)) {
    mockedFs[key] = realFs[key]
  }

  mockedFs.readdirSync = (p, ...rest) => {
    if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(reorderByPath, p)) {
      return reorderByPath[p].slice()
    }
    return realFs.readdirSync(p, ...rest)
  }

  mock.module('fs', { namedExports: mockedFs })
  const { loadActiveSkills } = await import('../src/skills-loader.js?community-walk-3302')

  describe('community walk deterministic order (#3302)', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-community-order-'))
      reorderByPath = Object.create(null)
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('orders community author dirs alphabetically even when readdirSync returns reverse order', () => {
      // Two trusted authors, each with one skill. Each skill is ~600 bytes.
      // Budget fits exactly one — the alphabetically first author's skill must win.
      const body = 'A'.repeat(600)
      mkdirSync(join(dir, 'community', 'alice'), { recursive: true })
      mkdirSync(join(dir, 'community', 'zeta'), { recursive: true })
      writeFileSync(join(dir, 'community', 'alice', 'skill.md'), body)
      writeFileSync(join(dir, 'community', 'zeta', 'skill.md'), body)

      // Force readdirSync(<root>/community) to return ['zeta', 'alice'] —
      // the OPPOSITE of alphabetical. Without the sort fix the walk pushes
      // zeta first and the tier budget admits zeta's skill while rejecting
      // alice's. With the fix both orderings produce the same result.
      reorderByPath[join(dir, 'community')] = ['zeta', 'alice']

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 1024, // fits one ~600-byte skill, second pushes over
        communityTrustChecker: () => true,
      })

      assert.equal(skills.length, 1, 'tier budget admits exactly one skill')
      assert.equal(
        skills[0].communityAuthor,
        'alice',
        'alphabetically-first author must win the budget cutoff regardless of readdirSync order',
      )
    })

    it('produces the same skill set when readdirSync returns shuffled vs sorted authors and files', () => {
      // Three authors × two skills each. Budget admits exactly two of the
      // six skills. Compare two runs: sorted readdir vs reversed readdir.
      const body = 'C'.repeat(600)
      const authors = ['alice', 'bob', 'charlie']
      for (const author of authors) {
        mkdirSync(join(dir, 'community', author), { recursive: true })
        writeFileSync(join(dir, 'community', author, 'one.md'), body)
        writeFileSync(join(dir, 'community', author, 'two.md'), body)
      }

      // Run 1: no reorder — readdirSync uses real (sorted on most FSes) order.
      const sortedRun = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 600 * 2 + 100, // admits exactly two skills
        communityTrustChecker: () => true,
      })

      // Run 2: reverse the author dir order AND each author's file order.
      reorderByPath[join(dir, 'community')] = ['charlie', 'bob', 'alice']
      reorderByPath[join(dir, 'community', 'alice')] = ['two.md', 'one.md']
      reorderByPath[join(dir, 'community', 'bob')] = ['two.md', 'one.md']
      reorderByPath[join(dir, 'community', 'charlie')] = ['two.md', 'one.md']

      const reversedRun = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 600 * 2 + 100,
        communityTrustChecker: () => true,
      })

      const fingerprint = (skills) =>
        skills.map((s) => `${s.communityAuthor}/${s.name}`).sort().join(',')

      assert.equal(
        fingerprint(reversedRun),
        fingerprint(sortedRun),
        'budget cutoff must produce the same skill set regardless of readdirSync order',
      )
      assert.equal(reversedRun.length, 2)
    })
  })
}
