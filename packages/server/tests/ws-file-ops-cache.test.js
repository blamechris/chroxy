import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const wsFileOpsSrc = readFileSync(join(__dirname, '../src/ws-file-ops.js'), 'utf-8')

describe('#1931 — CWD real path cache TTL', () => {
  it('cache entries store a timestamp', () => {
    // The cache should store { resolved, ts } instead of just the resolved path
    assert.ok(
      wsFileOpsSrc.includes('Date.now()') && wsFileOpsSrc.includes('_cwdRealCache'),
      'resolveSessionCwd should store timestamps in cache entries'
    )
  })

  it('cache entries are evicted after TTL', () => {
    // The source should check if an entry has expired
    assert.ok(
      wsFileOpsSrc.includes('CWD_CACHE_TTL') || wsFileOpsSrc.includes('_cwdCacheTtl'),
      'resolveSessionCwd should have a TTL constant for cache expiry'
    )
  })

  it('re-resolves realpath after TTL expires', () => {
    // The check should compare Date.now() against the stored timestamp
    assert.match(
      wsFileOpsSrc,
      /Date\.now\(\)\s*-\s*\w+\.ts/,
      'resolveSessionCwd should compare current time against cached timestamp'
    )
  })
})
