import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillingCanaryMonitor } from '../src/billing-canary-monitor.js'

const AFTER = Date.UTC(2026, 5, 16) // one day past the announced cutover
const BEFORE = Date.UTC(2026, 5, 1) // before the announced cutover

/**
 * #7333 — the era is gated on an operator flag now, not the calendar, because
 * Anthropic paused the programmatic-credit change on 2026-06-15 and it never
 * shipped. The canary only has anything to say when the regime is actually in
 * force, so `AFTER` alone no longer turns it on. Default-off behaviour is
 * asserted at the bottom of this file.
 */
function withEraEnabled(body) {
  const saved = process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
  process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = '1'
  const restore = () => {
    if (saved === undefined) delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
    else process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = saved
  }
  // Promise-aware on purpose. A plain try/finally restores the flag the moment
  // an ASYNC body returns its promise — i.e. before the body has run — so the
  // assertions execute with the era already off. That silently un-did the
  // wrapper for one async test here, and would have done the same to the next
  // async test added to the sibling copies of this helper.
  let out
  try {
    out = body()
  } catch (err) {
    restore()
    throw err
  }
  if (out && typeof out.then === 'function') return out.finally(restore)
  restore()
  return out
}

/**
 * The mirror of {@link withEraEnabled}, and just as necessary. An era-OFF
 * assertion that merely relies on the flag being absent from the ambient
 * environment tests nothing on a machine where an operator HAS set it: the
 * premise silently inverts and the case either fails for the wrong reason or
 * stops covering the default it exists to pin. Same class as #7360.
 */
function withEraDisabled(body) {
  const saved = process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
  delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
  const restore = () => {
    if (saved === undefined) delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
    else process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = saved
  }
  let out
  try {
    out = body()
  } catch (err) {
    restore()
    throw err
  }
  if (out && typeof out.then === 'function') return out.finally(restore)
  restore()
  return out
}

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

test('compute maps live sessions to the canary shape and reports the default billing class', () => withEraEnabled(() => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    getSessions: () => [{ sessionId: 's1', provider: 'claude-tui', cumulativeUsage: { costUsd: 0 } }],
  })
  const snap = monitor.compute()
  assert.equal(snap.eraStarted, true)
  assert.equal(snap.defaultProvider, 'claude-tui')
  assert.equal(snap.defaultBillingClass, 'subscription')
  assert.deepEqual(snap.warnings, [])
}))

test('flags a silent metered default (claude-sdk, era, no key)', () => withEraEnabled(() => {
  const { monitor } = make({ getDefaultProvider: () => 'claude-sdk' })
  const snap = monitor.compute()
  assert.equal(snap.defaultBillingClass, 'programmatic-credit')
  assert.equal(snap.warnings.length, 1)
  assert.equal(snap.warnings[0].code, 'SILENT_METERED_DEFAULT')
}))

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

test('reclassification tripwire fires if a claude-tui session ever reports cost', () => withEraEnabled(() => {
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui',
    getSessions: () => [{ sessionId: 's1', provider: 'claude-tui', cumulativeUsage: { costUsd: 0.5 } }],
  })
  const codes = monitor.compute().warnings.map((w) => w.code)
  assert.ok(codes.includes('TUI_REPORTED_PROGRAMMATIC_COST'))
}))

test('refresh broadcasts on change, dedupes when unchanged, and broadcasts a clear', () => withEraEnabled(() => {
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
}))

test('current() returns the latest snapshot, computing once if never refreshed', () => withEraEnabled(() => {
  const { monitor } = make({ getDefaultProvider: () => 'claude-sdk' })
  const c = monitor.current()
  assert.equal(c.defaultProvider, 'claude-sdk')
  assert.equal(c.warnings.length, 1)
}))

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

test('notify fires once per distinct non-empty set, then once on the clear transition (#5828)', () => withEraEnabled(() => {
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

  provider = 'claude-tui' // clears → fire the all-clear once with an empty array
  monitor.refresh()
  assert.equal(notified.length, 2)
  assert.deepEqual(notified[1], [])

  monitor.refresh() // stays clear → no repeated all-clear
  assert.equal(notified.length, 2)
}))

test('notify does NOT fire a spurious all-clear at startup (never warned)', () => {
  const notified = []
  const { monitor } = make({
    getDefaultProvider: () => 'claude-tui', // clean from the start
    extra: { notify: (w) => notified.push(w) },
  })
  monitor.refresh()
  monitor.refresh()
  assert.equal(notified.length, 0)
})

test('notify re-fires when the warning set changes (new code appears)', async () => withEraEnabled(async () => {
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
}))

test('_tick after stop() does not refresh (in-flight egress lookup during shutdown)', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { monitor, broadcasts } = make({
    getDefaultProvider: () => 'claude-sdk',
    extra: { resolveEgressIp: async () => { await gate; return '5.9.1.2' } },
  })
  monitor.start()
  const before = broadcasts.length
  // start() kicks an async _tick whose egress lookup is parked on `gate`.
  monitor.stop()      // shutdown lands mid-lookup
  release('go')       // resolver completes after stop()
  await new Promise((r) => setTimeout(r, 0))
  // No extra broadcast from the post-stop tick.
  assert.equal(broadcasts.length, before)
})

test('notify failure is swallowed (does not break refresh)', () => {
  const { monitor, broadcasts } = make({
    getDefaultProvider: () => 'claude-sdk',
    extra: { notify: () => { throw new Error('push down') } },
  })
  assert.doesNotThrow(() => monitor.refresh())
  assert.equal(broadcasts.length, 1) // broadcast still happened
})

test('the monitor raises no metering warning by default, at any date (#7333)', () => withEraDisabled(() => {
  // The user-visible fix at the monitor layer: with no operator flag, the
  // canary must not broadcast advice about the paused regime — at the
  // announced cutover or any time after it.
  for (const now of [AFTER, Date.UTC(2027, 0, 1)]) {
    const { monitor } = make({ now, getDefaultProvider: () => 'claude-sdk' })
    const snap = monitor.compute()
    const codes = (snap.warnings ?? []).map((w) => w.code)
    assert.equal(codes.includes('SILENT_METERED_DEFAULT'), false, `warned at ${now}`)
  }
}))

test('...but it does warn once an operator declares the era (control)', () => {
  // Without this the assertion above is satisfied by a monitor that never
  // warns about anything.
  withEraEnabled(() => {
    const { monitor } = make({ now: AFTER, getDefaultProvider: () => 'claude-sdk' })
    const codes = (monitor.compute().warnings ?? []).map((w) => w.code)
    assert.ok(codes.includes('SILENT_METERED_DEFAULT'))
  })
})
