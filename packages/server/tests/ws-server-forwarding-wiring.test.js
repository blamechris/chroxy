import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * #7895 — `ws-server.js`'s `setupForwarding({ ... })` call must thread
 * `defaultProvider` through to `ws-forwarding.js`, or the two `available_models`
 * send sites there (`models_updated` forward + the legacy single-session path)
 * silently fall back to `resolveRosterProvider`'s own `DEFAULT_PROVIDER`
 * constant regardless of what THIS daemon was actually started with
 * (`--provider` / `config.provider`) — reproducing the exact "wrong tag,
 * discarded by the client" bug this issue fixes, just one level up.
 *
 * No test in this suite constructs a real `WsServer`, starts it, and drives a
 * `models_updated` event through a live socket to a real client (the
 * behavioural coverage for the resolution itself lives in
 * `ws-forwarding.test.js`, against a synthetic `ctx`) — so, like the two
 * analogous pins in `models-overlay-reload-broadcast.test.js` for
 * `createOverlayReloadBroadcaster`'s `defaultProvider` wiring, this is a
 * source pin: deleting the argument, or hardcoding a literal instead of
 * `this.config?.provider || DEFAULT_PROVIDER` (the SAME resolution
 * `createOverlayReloadBroadcaster`'s own call site uses, and the same
 * `config.provider || DEFAULT_PROVIDER` `billingCanaryMonitor`'s
 * `getDefaultProvider` uses), goes red here even though no unit test can
 * observe the live daemon.
 *
 * A single contiguous token sequence, not a wildcard spanning the object
 * literal's body — `models-overlay-reload-broadcast.test.js`'s own comment on
 * its sibling wiring tests documents why a bounded `{[\s\S]{0,N}?...}` span is
 * a false NEGATIVE waiting to happen the moment that literal grows past the
 * cap.
 */
describe('ws-server.js setupForwarding wiring (#7895)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/ws-server.js', import.meta.url)), 'utf-8')

  it('setupForwarding({...}) passes defaultProvider: this.config?.provider || DEFAULT_PROVIDER', () => {
    const wiring = /defaultProvider:\s*this\.config\?\.provider\s*\|\|\s*DEFAULT_PROVIDER/
    assert.ok(wiring.test(src), 'setupForwarding(...) must pass defaultProvider: this.config?.provider || DEFAULT_PROVIDER')
  })

  it('imports DEFAULT_PROVIDER so the wiring above cannot reference an undefined name', () => {
    const importLine = /import\s*\{[^}]*\bDEFAULT_PROVIDER\b[^}]*\}\s*from\s*['"]\.\/providers\.js['"]/
    assert.ok(importLine.test(src), 'ws-server.js must import DEFAULT_PROVIDER from ./providers.js')
  })
})
