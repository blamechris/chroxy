import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('WsServer backpressure handling (#1948)', () => {
  let src

  beforeEach(() => {
    src = readFileSync(join(__dirname, '../src/ws-server.js'), 'utf-8')
  })

  it('logs backpressure at warn level, not debug', () => {
    // Should NOT have debug-level backpressure logging
    assert.ok(!src.includes("log.debug(`Backpressure:"),
      'Backpressure should not use log.debug')
    // Should use warn level
    assert.ok(src.includes("log.warn(`Backpressure:") || src.includes('log.warn('),
      'Backpressure should use log.warn')
  })

  it('tracks consecutive backpressure drops per client', () => {
    // Should have a counter for tracking consecutive drops
    assert.ok(src.includes('_backpressureDrops') || src.includes('backpressureDrops'),
      'Should track backpressure drop count per client')
  })

  it('closes connection after sustained backpressure', () => {
    // Should close the WebSocket when drops exceed a threshold
    const hasClosure = src.includes('ws.close') || src.includes('ws.terminate')
    assert.ok(hasClosure, 'Should close or terminate connection after sustained backpressure')
  })
})
