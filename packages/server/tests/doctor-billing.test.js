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

test('classifyEgressIp flags datacenter prefixes, not residential', () => {
  assert.equal(classifyEgressIp('95.216.1.2').datacenter, true)
  assert.equal(classifyEgressIp('95.216.1.2').code, 'DATACENTER_EGRESS')
  assert.equal(classifyEgressIp('73.162.4.10').datacenter, false) // residential-ish
  assert.equal(classifyEgressIp('').datacenter, false)
  assert.equal(classifyEgressIp(undefined).datacenter, false)
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
