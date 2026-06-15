import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectBillingReclassification,
  detectSilentMeteredDefault,
  classifyEgressIp,
  runBillingCanary,
} from '../src/doctor-billing.js'

const AFTER = Date.UTC(2026, 5, 16) // one day into the programmatic-credit era
const BEFORE = Date.UTC(2026, 5, 1) // before the cutover

test('detectBillingReclassification flags a claude-tui session reporting programmatic cost', () => {
  const w = detectBillingReclassification(
    [{ id: 's1', provider: 'claude-tui', totalCostUsd: 0.42 }],
    AFTER,
  )
  assert.equal(w.length, 1)
  assert.equal(w[0].code, 'TUI_REPORTED_PROGRAMMATIC_COST')
  assert.equal(w[0].sessionId, 's1')
  assert.equal(w[0].costUsd, 0.42)
})

test('detectBillingReclassification ignores zero-cost and non-tui sessions', () => {
  const w = detectBillingReclassification(
    [
      { id: 's1', provider: 'claude-tui', totalCostUsd: 0 },
      { id: 's2', provider: 'claude-sdk', totalCostUsd: 5 },
      { id: 's3', provider: 'claude-tui' },
    ],
    AFTER,
  )
  assert.equal(w.length, 0)
})

test('detectSilentMeteredDefault flags a programmatic default in the era only', () => {
  assert.equal(detectSilentMeteredDefault('claude-sdk', AFTER).length, 1)
  assert.equal(detectSilentMeteredDefault('claude-sdk', AFTER)[0].code, 'SILENT_METERED_DEFAULT')
  assert.equal(detectSilentMeteredDefault('claude-sdk', BEFORE).length, 0) // subscription before cutover
  assert.equal(detectSilentMeteredDefault('claude-tui', AFTER).length, 0) // always subscription
  assert.equal(detectSilentMeteredDefault('claude-byok', AFTER).length, 0) // api-key
})

test('detectSilentMeteredDefault does NOT flag claude-sdk when apiKeyAuth (BYOK)', () => {
  // claude-sdk + explicit ANTHROPIC_API_KEY = raw-API billing, not the credit
  // pool — so a BYOK default must not trip the silent-metered warning.
  assert.equal(detectSilentMeteredDefault('claude-sdk', AFTER, { apiKeyAuth: true }).length, 0)
  // ...but without the key it still warns.
  assert.equal(detectSilentMeteredDefault('claude-sdk', AFTER, { apiKeyAuth: false }).length, 1)
})

test('detectSilentMeteredDefault derives the cutover date from the shared constant', () => {
  // Guards against a hardcoded date drifting from PROGRAMMATIC_CREDIT_ERA_START.
  assert.match(detectSilentMeteredDefault('claude-sdk', AFTER)[0].message, /since 2026-06-15\b/)
})

test('detectBillingReclassification stays silent before the cutover (era-gated)', () => {
  // Matches the docstring: a cost reading is only a reclassification signal
  // on/after the boundary; before it everything bills flat subscription.
  const w = detectBillingReclassification(
    [{ id: 's1', provider: 'claude-tui', totalCostUsd: 0.99 }],
    BEFORE,
  )
  assert.equal(w.length, 0)
})

test('classifyEgressIp flags datacenter prefixes, not residential', () => {
  assert.equal(classifyEgressIp('95.216.1.2').datacenter, true)
  assert.equal(classifyEgressIp('95.216.1.2').code, 'DATACENTER_EGRESS')
  assert.equal(classifyEgressIp('73.162.4.10').datacenter, false) // residential-ish
  assert.equal(classifyEgressIp('').datacenter, false)
  assert.equal(classifyEgressIp(undefined).datacenter, false)
})

test('classifyEgressIp does NOT flag coarse /8 blocks (false-positive guard)', () => {
  // These broad AWS/GCP /8 prefixes were removed because they span huge
  // amounts of residential/ISP space too. A false hit erodes trust in the
  // warning, so the classifier stays conservative until a real cloud-IP
  // dataset is plumbed in. Lock that out so they can't creep back.
  for (const ip of ['13.52.1.1', '18.200.1.1', '34.120.1.1', '35.1.2.3', '52.10.20.30', '54.1.2.3']) {
    assert.equal(classifyEgressIp(ip).datacenter, false, `${ip} must not be flagged`)
  }
})

test('classifyEgressIp honours operator-supplied extra prefixes (#5828)', () => {
  // A residential-looking IP is clean by default but flagged once the operator
  // adds their cloud's range via config.billing.datacenterPrefixes.
  assert.equal(classifyEgressIp('203.0.113.9').datacenter, false)
  assert.equal(classifyEgressIp('203.0.113.9', ['203.0.113.']).datacenter, true)
  // The built-in list still applies alongside the extras.
  assert.equal(classifyEgressIp('95.216.1.2', ['203.0.113.']).datacenter, true)
  // Junk entries in the extras list are ignored, not crashed on.
  assert.equal(classifyEgressIp('203.0.113.9', ['', null, 42]).datacenter, false)
})

test('runBillingCanary threads datacenterPrefixes into the egress classifier (#5828)', () => {
  const out = runBillingCanary({
    defaultProvider: 'claude-tui',
    egressIp: '198.51.100.5',
    datacenterPrefixes: ['198.51.100.'],
    now: AFTER,
  })
  assert.ok(out.warnings.some((w) => w.code === 'DATACENTER_EGRESS'))
})

test('runBillingCanary aggregates all three signals', () => {
  const out = runBillingCanary({
    sessions: [{ id: 's1', provider: 'claude-tui', totalCostUsd: 1.5 }],
    defaultProvider: 'claude-sdk',
    egressIp: '5.9.10.11',
    now: AFTER,
  })
  assert.equal(out.eraStarted, true)
  const codes = out.warnings.map((w) => w.code).sort()
  assert.deepEqual(codes, ['DATACENTER_EGRESS', 'SILENT_METERED_DEFAULT', 'TUI_REPORTED_PROGRAMMATIC_COST'])
})

test('runBillingCanary is quiet before the era with a clean setup', () => {
  const out = runBillingCanary({
    sessions: [{ id: 's1', provider: 'claude-tui', totalCostUsd: 0 }],
    defaultProvider: 'claude-sdk',
    egressIp: '73.162.4.10',
    now: BEFORE,
  })
  assert.equal(out.eraStarted, false)
  assert.equal(out.warnings.length, 0)
})
