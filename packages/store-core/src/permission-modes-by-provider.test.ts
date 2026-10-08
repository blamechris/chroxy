import { describe, it, expect } from 'vitest'
import {
  EMPTY_PERMISSION_MODES,
  mergePermissionModesByProvider,
  selectPermissionModesForProvider,
} from './permission-modes-by-provider'

const TUI = [{ id: 'plan', label: 'Plan (unavailable)', supported: false }]
const SDK = [{ id: 'plan', label: 'Plan', supported: true }]

describe('permission-modes-by-provider (#8224)', () => {
  it('serves the active provider its own roster, however many others arrived after', () => {
    let map = mergePermissionModesByProvider({}, 'claude-sdk', SDK)
    map = mergePermissionModesByProvider(map, 'claude-tui', TUI)
    expect(selectPermissionModesForProvider(map, 'claude-sdk')).toBe(SDK)
    expect(selectPermissionModesForProvider(map, 'claude-tui')).toBe(TUI)
  })

  it('never serves a KNOWN provider another provider\'s roster', () => {
    const map = mergePermissionModesByProvider({}, 'claude-tui', TUI)
    expect(selectPermissionModesForProvider(map, 'claude-sdk')).toBe(EMPTY_PERMISSION_MODES)
  })

  it('serves a KNOWN provider the untagged roster when it has none of its own (daemon from before #8224)', () => {
    // An installed daemon sends every roster untagged but names each session's
    // provider in session_list; the picker must not disappear.
    const map = mergePermissionModesByProvider({}, undefined, SDK)
    expect(selectPermissionModesForProvider(map, 'claude-sdk')).toBe(SDK)
  })

  it('prefers a provider\'s own roster over the untagged one', () => {
    let map = mergePermissionModesByProvider({}, undefined, TUI)
    map = mergePermissionModesByProvider(map, 'claude-sdk', SDK)
    expect(selectPermissionModesForProvider(map, 'claude-sdk')).toBe(SDK)
  })

  it('does not serve the untagged roster as another provider\'s TAGGED one (still no cross-provider leak)', () => {
    const map = mergePermissionModesByProvider({}, 'claude-tui', TUI)
    expect(selectPermissionModesForProvider(map, 'claude-sdk')).toBe(EMPTY_PERMISSION_MODES)
  })

  it('serves the only roster when the provider is unknown (pre-provider daemon)', () => {
    const map = mergePermissionModesByProvider({}, undefined, SDK)
    expect(selectPermissionModesForProvider(map, null)).toBe(SDK)
  })

  it('serves nothing when the provider is unknown and several rosters are in play', () => {
    let map = mergePermissionModesByProvider({}, 'claude-sdk', SDK)
    map = mergePermissionModesByProvider(map, 'claude-tui', TUI)
    expect(selectPermissionModesForProvider(map, null)).toBe(EMPTY_PERMISSION_MODES)
  })

  it('treats a padded tag as the same provider on write and read', () => {
    const map = mergePermissionModesByProvider({}, ' codex ', SDK)
    expect(selectPermissionModesForProvider(map, 'codex')).toBe(SDK)
  })

  it('tolerates a missing map', () => {
    expect(selectPermissionModesForProvider(undefined, 'codex')).toBe(EMPTY_PERMISSION_MODES)
  })
})
