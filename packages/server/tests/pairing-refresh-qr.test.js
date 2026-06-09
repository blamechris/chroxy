import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

describe('QR re-render on pairing refresh (#1894)', () => {
  // #5368 slice (b): the pairing_refreshed → QR re-render moved from
  // server-cli.js into StartupDisplay (server-cli now wires it via
  // wireReRenderListeners). Follow the code to its new home + assert the wiring.
  it('StartupDisplay re-renders the QR on pairing_refreshed, wired by server-cli.js', () => {
    const startupDisplay = readFileSync(join(srcDir, 'server-cli/startup-display.js'), 'utf-8')
    assert.ok(
      startupDisplay.includes('pairing_refreshed'),
      'startup-display.js should listen for pairing_refreshed event'
    )
    const handlerPattern = /\.on\(\s*['"]pairing_refreshed['"]\s*,[\s\S]*?displayQr/
    assert.ok(
      handlerPattern.test(startupDisplay),
      'pairing_refreshed handler should re-render QR (displayQr called in handler)'
    )
    const serverCli = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(
      serverCli.includes('wireReRenderListeners'),
      'server-cli.js should wire the re-render listeners via StartupDisplay'
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
