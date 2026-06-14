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
