import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const wsServerSrc = readFileSync(join(__dirname, '../src/ws-server.js'), 'utf-8')

describe('#1922 — replace uuid package with native crypto.randomUUID', () => {
  it('does not import from uuid package', () => {
    assert.ok(
      !wsServerSrc.includes("from 'uuid'"),
      'ws-server.js should not import from uuid package'
    )
  })

  it('imports randomUUID from crypto', () => {
    assert.ok(
      wsServerSrc.includes('randomUUID'),
      'ws-server.js should use randomUUID from crypto'
    )
  })

  it('uses randomUUID() for client ID generation', () => {
    assert.ok(
      wsServerSrc.includes('randomUUID()'),
      'ws-server.js should call randomUUID() for client IDs'
    )
  })
})
