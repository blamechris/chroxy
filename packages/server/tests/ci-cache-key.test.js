import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

describe('CI workflow cache configuration', () => {
  let ciYml

  before(async () => {
    ciYml = await readFile(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8'
    )
  })

  it('loads ci.yml', () => {
    assert.ok(ciYml.length > 0)
  })

  it('uses glob pattern for npm cache-dependency-path', () => {
    // Every cache-dependency-path should use the glob pattern, not just the root lockfile
    const lines = ciYml.split('\n')
    const cacheDependencyLines = lines.filter(l => l.includes('cache-dependency-path:'))

    assert.ok(cacheDependencyLines.length > 0, 'should have cache-dependency-path entries')

    for (const line of cacheDependencyLines) {
      const parts = line.split('cache-dependency-path:')
      if (parts.length < 2) continue

      let value = parts[1].trim()
      // Strip matching surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }

      assert.equal(
        value,
        '**/package-lock.json',
        `cache-dependency-path should use glob pattern '**/package-lock.json', found: ${line.trim()}`
      )
    }
  })

  it('does not use bare root-only lockfile path', () => {
    // Ensure no job uses just 'package-lock.json' without the glob
    const matches = ciYml.match(/cache-dependency-path:\s+['"]?package-lock\.json['"]?(?:\s+#.*)?$/gm)
    assert.equal(matches, null, 'should not have bare package-lock.json cache paths')
  })
})
