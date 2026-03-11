import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

describe('QR re-render on pairing refresh (#1894)', () => {
  it('server-cli.js listens for pairing_refreshed events', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(
      source.includes('pairing_refreshed'),
      'server-cli.js should listen for pairing_refreshed event'
    )
    const handlerPattern = /\.on\(\s*['"]pairing_refreshed['"]\s*,[\s\S]*?displayQr/
    assert.ok(
      handlerPattern.test(source),
      'pairing_refreshed handler should re-render QR (displayQr called in handler)'
    )
  })

  it('PairingManager emits pairing_refreshed on manual refresh', async () => {
    const { PairingManager } = await import(join(srcDir, 'pairing.js'))

    const pm = new PairingManager({})
    const firstId = pm.currentPairingId

    let emitted = null
    pm.on('pairing_refreshed', (event) => { emitted = event })
    pm.refresh()

    assert.ok(emitted, 'should have emitted pairing_refreshed')
    assert.ok(emitted.pairingId, 'event should contain new pairing ID')
    assert.notEqual(emitted.pairingId, firstId, 'should be a new ID')
    pm.destroy()
  })

  it('dashboard QR endpoint uses live pairing URL (not stale)', () => {
    const source = readFileSync(join(srcDir, 'http-routes.js'), 'utf-8')
    assert.ok(
      source.includes('currentPairingUrl'),
      'http-routes.js should read currentPairingUrl (always live)'
    )
  })
})
