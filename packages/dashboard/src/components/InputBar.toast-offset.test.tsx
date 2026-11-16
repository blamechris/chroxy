/**
 * #8596 — the composer publishes its distance from the viewport bottom as
 * --toast-bottom-offset (so the toast stack rests above it) and cleans up.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { StrictMode } from 'react'
import { InputBar } from './InputBar'

const VAR = '--toast-bottom-offset'
type RO = { cb: () => void; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }
let instances: RO[]
let top = 0

beforeEach(() => {
  instances = []
  top = 700
  class FakeRO {
    cb: () => void
    observed: Element[] = []
    disconnect = vi.fn()
    constructor(cb: () => void) { this.cb = cb; instances.push(this as unknown as RO) }
    observe(e: Element) { this.observed.push(e) }
  }
  vi.stubGlobal('ResizeObserver', FakeRO)
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top, bottom: top + 50, height: 50, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty(VAR)
})

const bar = () => <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />
const live = () => instances.filter((i) => i.disconnect.mock.calls.length === 0)

describe('InputBar --toast-bottom-offset (#8596)', () => {
  it('publishes window.innerHeight - composer top, and re-publishes on resize observation and window resize', () => {
    render(bar())
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('100px')
    top = 600
    instances[0]!.cb()
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('200px')
    top = 650
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('150px')
  })

  it('observes the composer itself', () => {
    render(bar())
    expect(instances[0]!.observed.some((e) => e.getAttribute('data-testid') === 'input-bar')).toBe(true)
  })

  it('observes later siblings of the composer chain (e.g. the footer bar below it)', () => {
    const footer = document.createElement('footer')
    const host = document.createElement('div')
    document.body.append(host, footer)
    render(bar(), { container: host.appendChild(document.createElement('div')) })
    expect(instances[0]!.observed).toContain(footer)
    footer.remove(); host.remove()
  })

  it('removes the variable, disconnects and stops listening on unmount', () => {
    const { unmount } = render(bar())
    unmount()
    expect(live()).toHaveLength(0)
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
    top = 100
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
  })

  it('survives StrictMode (mount/cleanup/mount): variable set, exactly one live observer, cleaned on unmount', () => {
    const { unmount } = render(<StrictMode>{bar()}</StrictMode>)
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('100px')
    expect(live()).toHaveLength(1)
    unmount()
    expect(live()).toHaveLength(0)
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
  })

  it('publishes nothing without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render(bar())
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
  })
})
