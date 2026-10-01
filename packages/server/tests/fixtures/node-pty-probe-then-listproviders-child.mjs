/**
 * #8151 round-2 review (S-b) — probes under a real (hook-forced) import
 * failure, THEN calls `listProviders()` with NO `nodePtyAvailable`
 * injection, so the only way it can know node-pty is unavailable is by
 * reading the module-level cache `probeNodePtyAvailable()` just warmed.
 * Prints whether claude-tui came back `auth.ready === false`.
 *
 * This is the gap between the two existing coverage pieces: the probe's
 * OWN boolean was tested directly (node-pty-probe-child.mjs), and
 * `listProviders({ nodePtyAvailable: false })`'s EXPLICIT-injection branch
 * was tested directly (provider-list-default-provider.test.js's first
 * describe block) — but nothing proved the two are actually WIRED
 * together the way production uses them: `listProviders()` called with NO
 * argument, reading whatever the boot-time probe already cached.
 */
import { probeNodePtyAvailable, resetNodePtyProbeForTest } from '../../src/utils/node-pty-probe.js'
import { listProviders } from '../../src/providers.js'

resetNodePtyProbeForTest()
await probeNodePtyAvailable()
const providers = listProviders() // no injection — must read the cache
const claudeTui = providers.find((p) => p.name === 'claude-tui')
console.log(JSON.stringify({ ready: claudeTui?.auth?.ready, hint: claudeTui?.auth?.hint ?? null }))
