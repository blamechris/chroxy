/**
 * #8596 — AppHeader publishes its measured bottom edge as --app-header-height so
 * the fixed toast stack can sit below it (the header wraps at narrow widths).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('./ChatSettingsDropdown', () => ({ ChatSettingsDropdown: () => null }))
vi.mock('./NotificationsWidget', () => ({ NotificationsWidget: () => null }))
vi.mock('./HeaderOverflowMenu', () => ({ HeaderOverflowMenu: () => null }))
vi.mock('./StatusBar', () => ({ StatusBar: () => null }))
vi.mock('./DevPreviewChip', () => ({ DevPreviewChip: () => null }))
vi.mock('./SessionCiChip', () => ({ SessionCiChip: () => null }))

const { AppHeader } = await import('./AppHeader')

const VAR = '--app-header-height'
let instances: Array<{ cb: () => void; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }>
let bottom = 0

beforeEach(() => {
  instances = []
  bottom = 73.2
  class RO {
    cb: () => void
    disconnect = vi.fn()
    observe = vi.fn()
    constructor(cb: () => void) { this.cb = cb; instances.push(this) }
  }
  vi.stubGlobal('ResizeObserver', RO)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ bottom, top: 0, height: bottom, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty(VAR)
})

function renderHeader() {
  const props = { serverVersion: '0.11.4', connectionPhase: 'connected', serverPhase: null, isConnected: true, tunnelReady: true, devPreviews: [], sessionNotifications: [] }
  return render(<AppHeader {...(props as unknown as Parameters<typeof AppHeader>[0])} />)
}

describe('AppHeader --app-header-height (#8596)', () => {
  it('publishes the measured bottom edge and re-publishes when the header resizes', () => {
    renderHeader()
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('74px')
    expect(instances).toHaveLength(1)
    expect(instances[0]!.observe).toHaveBeenCalledTimes(1)
    bottom = 140 // header wrapped to more rows
    instances[0]!.cb()
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('140px')
  })

  it('stops observing and removes the variable on unmount', () => {
    const { unmount } = renderHeader()
    unmount()
    expect(instances[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
  })

  it('leaves the variable unset (stylesheet fallback) without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    renderHeader()
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
  })
})
