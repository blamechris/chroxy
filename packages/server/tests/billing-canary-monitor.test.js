import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillingCanaryMonitor } from '../src/billing-canary-monitor.js'

const AFTER = Date.UTC(2026, 5, 16) // one day into the programmatic-credit era
const BEFORE = Date.UTC(2026, 5, 1) // before the cutover

function make(opts = {}) {
  const broadcasts = []
  const monitor = new BillingCanaryMonitor({
    broadcast: (m) => broadcasts.push(m),
    nowFn: () => opts.now ?? AFTER,
    getSessions: opts.getSessions || (() => []),
    getDefaultProvider: opts.getDefaultProvider || (() => 'claude-tui'),
    getApiKeyAuth: opts.getApiKeyAuth || (() => false),
    ...opts.extra,
  })
  return { monitor, broadcasts }
}

test('compute maps live sessions to the canary shape and reports the default billing class', () => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    getSessions: () => [{ sessionId: 's1', provider: 'claude-tui', cumulativeUsage: { costUsd: 0 } }],
  })
  const snap = monitor.compute()
  assert.equal(snap.eraStarted, true)
  assert.equal(snap.defaultProvider, 'claude-tui')
  assert.equal(snap.defaultBillingClass, 'subscription')
  assert.deepEqual(snap.warnings, [])
})

test('flags a silent metered default (claude-sdk, era, no key)', () => {
  const { monitor } = make({ getDefaultProvider: () => 'claude-sdk' })
  const snap = monitor.compute()
  assert.equal(snap.defaultBillingClass, 'programmatic-credit')
  assert.equal(snap.warnings.length, 1)
  assert.equal(snap.warnings[0].code, 'SILENT_METERED_DEFAULT')
})

test('does NOT flag claude-sdk default when apiKeyAuth (BYOK)', () => {
  const { monitor } = make({ getDefaultProvider: () => 'claude-sdk', getApiKeyAuth: () => true })
  const snap = monitor.compute()
  assert.equal(snap.defaultBillingClass, 'api-key')
  assert.deepEqual(snap.warnings, [])
})

test('reclassification tripwire is dormant for a zero-cost claude-tui session', () => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    getSessions: () => [{ sessionId: 's1', provider: 'claude-tui', cumulativeUsage: { costUsd: 0 } }],
  })
  assert.deepEqual(monitor.compute().warnings, [])
})

test('reclassification tripwire fires if a claude-tui session ever reports cost', () => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    getSessions: () => [{ sessionId: 's1', provider: 'claude-tui', cumulativeUsage: { costUsd: 0.5 } }],
  })
  const codes = monitor.compute().warnings.map((w) => w.code)
  assert.ok(codes.includes('TUI_REPORTED_PROGRAMMATIC_COST'))
})

test('refresh broadcasts on change, dedupes when unchanged, and broadcasts a clear', () => {
  let provider = 'claude-sdk' // metered default → warning
  const { monitor, broadcasts } = make({ getDefaultProvider: () => provider })

  monitor.refresh()
  assert.equal(broadcasts.length, 1)
  assert.equal(broadcasts[0].type, 'billing_canary')
  assert.equal(broadcasts[0].warnings.length, 1)

  monitor.refresh() // unchanged → no new broadcast
  assert.equal(broadcasts.length, 1)

  provider = 'claude-tui' // clears the warning → broadcast the all-clear
  monitor.refresh()
  assert.equal(broadcasts.length, 2)
  assert.deepEqual(broadcasts[1].warnings, [])
})

test('current() returns the latest snapshot, computing once if never refreshed', () => {
  const { monitor } = make({ getDefaultProvider: () => 'claude-sdk' })
  const c = monitor.current()
  assert.equal(c.defaultProvider, 'claude-sdk')
  assert.equal(c.warnings.length, 1)
})

test('pre-cutover: no metered warning even for a programmatic default', () => {
  const { monitor } = make({ now: BEFORE, getDefaultProvider: () => 'claude-sdk' })
  const snap = monitor.compute()
  assert.equal(snap.eraStarted, false)
  assert.deepEqual(snap.warnings, [])
})

test('start sets an unref-d timer and stop clears it', () => {
  const { monitor, broadcasts } = make({ getDefaultProvider: () => 'claude-sdk', extra: { intervalMs: 999999 } })
  monitor.start()
  assert.equal(broadcasts.length, 1) // initial refresh broadcast
  assert.ok(monitor._timer, 'timer should be set')
  monitor.stop()
  assert.equal(monitor._timer, null, 'timer should be cleared')
  monitor.stop() // idempotent
})

// #5828 — opt-in datacenter-egress detection.

test('egress check OFF by default: compute makes no egress warning even on a datacenter IP', () => {
  // No resolveEgressIp wired → _egressIp stays null → no DATACENTER_EGRESS.
  const { monitor } = make({ getDefaultProvider: () => 'claude-tui' })
  assert.deepEqual(monitor.compute().warnings, [])
})

test('_tick resolves the egress IP and folds a datacenter hit into the warnings', async () => {
  const { monitor, broadcasts } = make({
    getDefaultProvider: () => 'claude-tui',
    extra: { resolveEgressIp: async () => '5.9.1.2' }, // Hetzner prefix
  })
  await monitor._tick()
  const codes = monitor.current().warnings.map((w) => w.code)
  assert.ok(codes.includes('DATACENTER_EGRESS'))
  assert.ok(broadcasts.some((b) => b.warnings.some((w) => w.code === 'DATACENTER_EGRESS')))
})

test('_tick is fail-open: a throwing resolver leaves egress null and no warning', async () => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    extra: { resolveEgressIp: async () => { throw new Error('network down') } },
  })
  await monitor._tick()
  assert.equal(monitor._egressIp, null)
  assert.deepEqual(monitor.current().warnings, [])
})

test('getDatacenterPrefixes extends the built-in egress list', async () => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    extra: {
      resolveEgressIp: async () => '203.0.113.4',
      getDatacenterPrefixes: () => ['203.0.113.'],
    },
  })
  await monitor._tick()
  assert.ok(monitor.current().warnings.some((w) => w.code === 'DATACENTER_EGRESS'))
})

test('notify fires once per distinct non-empty warning set, not on all-clear', () => {
  const notified = []
  let provider = 'claude-sdk' // metered default → warning
  const { monitor } = make({
    getDefaultProvider: () => provider,
    extra: { notify: (w) => notified.push(w) },
  })

  monitor.refresh()
  assert.equal(notified.length, 1)
  assert.equal(notified[0][0].code, 'SILENT_METERED_DEFAULT')

  monitor.refresh() // unchanged warning set → no re-notify
  assert.equal(notified.length, 1)

  provider = 'claude-tui' // clears → must NOT notify on all-clear
  monitor.refresh()
  assert.equal(notified.length, 1)
})

test('notify re-fires when the warning set changes (new code appears)', async () => {
  const notified = []
  const { monitor } = make({
    getDefaultProvider: () => 'claude-sdk', // metered default warning from the start
    extra: {
      resolveEgressIp: async () => '5.9.1.2', // adds DATACENTER_EGRESS on the tick
      notify: (w) => notified.push(w.map((x) => x.code).sort()),
    },
  })
  monitor.refresh() // just SILENT_METERED_DEFAULT
  assert.deepEqual(notified, [['SILENT_METERED_DEFAULT']])
  await monitor._tick() // egress resolves → set grows
  assert.equal(notified.length, 2)
  assert.deepEqual(notified[1], ['DATACENTER_EGRESS', 'SILENT_METERED_DEFAULT'])
})

test('notify failure is swallowed (does not break refresh)', () => {
  const { monitor, broadcasts } = make({
    getDefaultProvider: () => 'claude-sdk',
    extra: { notify: () => { throw new Error('push down') } },
  })
  assert.doesNotThrow(() => monitor.refresh())
  assert.equal(broadcasts.length, 1) // broadcast still happened
})
