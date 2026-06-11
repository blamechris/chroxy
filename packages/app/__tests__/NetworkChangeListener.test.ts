import fs from 'fs'
import path from 'path'

// #5518 — source-level assertions on the network-change endpoint re-evaluation
// listener (mirrors AppStateListener.test.ts, which guards the resume listener).
// A behavioural test would require mocking expo-network's native event emitter;
// the listener's gating logic is what matters and is asserted directly here, with
// the pure selection logic covered in utils/endpoint-selector.test.ts.
const src = fs.readFileSync(
  path.resolve(__dirname, '../src/store/connection.ts'),
  'utf-8',
)

describe('Network change listener (#5518)', () => {
  test('subscription handle is stored in an exported const (removable)', () => {
    expect(src).toMatch(/export const _networkSub\s*=\s*Network\.addNetworkStateListener/)
    expect(src).not.toMatch(/^\s*Network\.addNetworkStateListener/m)
  })

  test('cleans up a prior subscription on hot-reload', () => {
    expect(src).toMatch(/global\.__chroxy_networkSub\.remove\(\)/)
  })

  test('only re-evaluates when a verified LAN candidate exists', () => {
    // The whole point: never re-route to LAN unless the record carries a
    // token-verified LAN candidate. Guard must check both fields.
    expect(src).toMatch(/savedConnection\.lanUrl\s*\|\|\s*!savedConnection\.lanVerified/)
  })

  test('skips when the user explicitly disconnected', () => {
    expect(src).toMatch(/userDisconnected\b/)
  })

  test('debounces network-change reconnects', () => {
    expect(src).toMatch(/NETWORK_CHANGE_COOLDOWN_MS/)
    expect(src).toMatch(/now - _lastNetworkReconnectAt < NETWORK_CHANGE_COOLDOWN_MS/)
  })

  test('routes through connectAuto (endpoint re-selection), not raw connect', () => {
    expect(src).toMatch(/connectAuto\(savedConnection,\s*\{\s*silent:\s*true\s*\}\)/)
  })
})
