import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'child_process'
import { CloudflareTunnelAdapter as TunnelManager } from '../src/tunnel/cloudflare.js'

// #8096: this suite spawns a REAL `cloudflared` and opens a REAL
// trycloudflare.com tunnel over the network — it must never run in a
// default/CI test invocation. The OLD gate here probed availability with a
// PATH deliberately AUGMENTED with common install locations (`/opt/homebrew/
// bin`, `/usr/local/bin`), independent of whatever PATH the test process
// actually inherited. On a host where cloudflared is installed at one of
// those two fixed paths but NOT on the process's real, unmodified PATH —
// exactly the stripped PATH this repo's test-safety convention requires (see
// CLAUDE.md and the harness rule this issue was filed under) — the probe
// reported "available" and let the suite run, and the REAL spawn inside
// `TunnelManager` (a bare `cloudflared` name, resolved off the process's REAL,
// un-augmented PATH — `_spawnCloudflared`, `src/tunnel/cloudflare.js`) then
// failed with `spawn cloudflared ENOENT` instead of skipping cleanly.
//
// Same convention as `keychain.test.js`'s `CHROXY_TEST_REAL_KEYCHAIN=1`: gate
// behind an explicit opt-in env var so this never runs by accident, and only
// probe real availability — using the process's OWN, unmodified PATH, no
// augmentation — once that opt-in is set. `CHROXY_TEST_ALLOW_REAL_BINARY` is
// also set here (not just the cloudflared-specific opt-in below) so the
// `test-real-binary-tripwire.mjs` guard installed suite-wide doesn't refuse
// the very spawns this opt-in exists to allow.
let hasCloudflared = false
if (process.env.CHROXY_TEST_REAL_CLOUDFLARED === '1') {
  process.env.CHROXY_TEST_ALLOW_REAL_BINARY = '1'
  try {
    execSync('which cloudflared', { stdio: 'ignore' })
    hasCloudflared = true
  } catch {}
}
const suite = hasCloudflared ? describe : describe.skip

suite('TunnelManager Integration (requires cloudflared)', () => {
  let tunnel

  afterEach(async () => {
    if (tunnel) {
      await tunnel.stop()
      tunnel = null
    }
  })

  it('spawns quick tunnel and returns valid URLs', { timeout: 90000 }, async () => {
    tunnel = new TunnelManager({ port: 19876, mode: 'quick' })
    const { httpUrl, wsUrl } = await tunnel.start()

    assert.match(httpUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/, 'httpUrl should be a trycloudflare URL')
    assert.match(wsUrl, /^wss:\/\/[a-z0-9-]+\.trycloudflare\.com$/, 'wsUrl should be a wss trycloudflare URL')
    assert.ok(tunnel.process, 'cloudflared process should be running')
    assert.equal(tunnel.url, httpUrl, 'tunnel.url should match httpUrl')
  })

  it('recovers after cloudflared is killed', { timeout: 90000 }, async () => {
    tunnel = new TunnelManager({ port: 19876, mode: 'quick' })
    const { httpUrl: originalUrl } = await tunnel.start()

    assert.ok(originalUrl, 'should have an initial URL')

    // Shorten backoffs for faster test
    tunnel.recoveryBackoffs = [1000, 2000, 4000]

    const pid = tunnel.process.pid
    assert.ok(pid, 'should have a process PID')

    // Listen for recovery
    const recoveredPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tunnel_recovered not emitted within 60s')), 60000)
      tunnel.once('tunnel_recovered', (info) => {
        clearTimeout(timeout)
        resolve(info)
      })
      tunnel.once('tunnel_failed', (info) => {
        clearTimeout(timeout)
        reject(new Error(`tunnel_failed: ${info.message}`))
      })
    })

    // Kill cloudflared
    process.kill(pid, 'SIGKILL')

    const recovered = await recoveredPromise
    assert.ok(recovered.httpUrl, 'recovered event should have httpUrl')
    assert.match(recovered.httpUrl, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/)
    assert.ok(recovered.attempt >= 1, 'should report at least 1 recovery attempt')
  })

  it('does not attempt recovery after intentional stop', { timeout: 10000 }, async () => {
    tunnel = new TunnelManager({ port: 19876, mode: 'quick' })
    await tunnel.start()

    // Shorten backoffs
    tunnel.recoveryBackoffs = [500, 1000]

    let recoveryFired = false
    tunnel.on('tunnel_recovering', () => {
      recoveryFired = true
    })

    // Intentional stop
    await tunnel.stop()

    // Wait a bit to confirm no recovery is triggered
    await new Promise(resolve => setTimeout(resolve, 2000))

    assert.equal(recoveryFired, false, 'should not attempt recovery after intentional stop')
    assert.equal(tunnel.process, null, 'process should be null')
    assert.equal(tunnel.url, null, 'url should be null')

    // Prevent afterEach double-stop
    tunnel = null
  })
})
