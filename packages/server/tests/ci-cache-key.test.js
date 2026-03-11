import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

describe('CI workflow cache configuration', () => {
  let ciYml

  it('loads ci.yml', async () => {
    ciYml = await readFile(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8'
    )
    assert.ok(ciYml.length > 0)
  })

  it('uses glob pattern for npm cache-dependency-path', () => {
    // Every cache-dependency-path should use the glob pattern, not just the root lockfile
    const lines = ciYml.split('\n')
    const cacheDependencyLines = lines.filter(l => l.includes('cache-dependency-path:'))

    assert.ok(cacheDependencyLines.length > 0, 'should have cache-dependency-path entries')

    for (const line of cacheDependencyLines) {
      assert.ok(
        !line.includes("cache-dependency-path: package-lock.json") ||
        line.includes('**/package-lock.json'),
        `cache key should use glob pattern, found: ${line.trim()}`
      )
    }
  })

  it('does not use bare root-only lockfile path', () => {
    // Ensure no job uses just 'package-lock.json' without the glob
    const matches = ciYml.match(/cache-dependency-path:\s+package-lock\.json\s*$/gm)
    assert.equal(matches, null, 'should not have bare package-lock.json cache paths')
  })
})
