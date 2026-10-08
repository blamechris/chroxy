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

  it('never serves a KNOWN provider an untagged roster', () => {
    const map = mergePermissionModesByProvider({}, undefined, TUI)
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
