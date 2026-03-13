import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@chroxy/protocol', () => {
  it('exports PROTOCOL_VERSION as a positive integer', async () => {
    const { PROTOCOL_VERSION } = await import('../src/index.ts')
    assert.equal(typeof PROTOCOL_VERSION, 'number')
    assert.ok(PROTOCOL_VERSION >= 1, 'PROTOCOL_VERSION should be >= 1')
    assert.equal(PROTOCOL_VERSION, Math.floor(PROTOCOL_VERSION), 'Should be an integer')
  })

  it('exports MIN_PROTOCOL_VERSION as a positive integer', async () => {
    const { MIN_PROTOCOL_VERSION } = await import('../src/index.ts')
    assert.equal(typeof MIN_PROTOCOL_VERSION, 'number')
    assert.ok(MIN_PROTOCOL_VERSION >= 1, 'MIN_PROTOCOL_VERSION should be >= 1')
  })

  it('MIN_PROTOCOL_VERSION <= PROTOCOL_VERSION', async () => {
    const { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } = await import('../src/index.ts')
    assert.ok(
      MIN_PROTOCOL_VERSION <= PROTOCOL_VERSION,
      `MIN (${MIN_PROTOCOL_VERSION}) should be <= current (${PROTOCOL_VERSION})`,
    )
  })

  it('protocol version matches server ws-server.js value', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { PROTOCOL_VERSION } = await import('../src/index.ts')

    const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
    const src = readFileSync(wsServerPath, 'utf-8')
    const match = src.match(/export const SERVER_PROTOCOL_VERSION = (\d+)/)
    assert.ok(match, 'Should find SERVER_PROTOCOL_VERSION in ws-server.js')
    assert.equal(PROTOCOL_VERSION, parseInt(match[1], 10),
      'Protocol package version should match server version')
  })
})
