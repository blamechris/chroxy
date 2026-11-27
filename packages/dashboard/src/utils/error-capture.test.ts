import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installErrorCapture } from './error-capture'
import { ERROR_HISTORY_KEY, __resetErrorHistoryForTests, readErrorHistory } from './error-history'

let uninstall: () => void

beforeEach(() => {
  localStorage.clear()
  __resetErrorHistoryForTests()
  uninstall = installErrorCapture()
})
afterEach(() => {
  uninstall()
  vi.restoreAllMocks()
})

const propError = () => new TypeError("Cannot read properties of undefined (reading 'dimensions')")

describe('installErrorCapture', () => {
  it('records a window error event', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: propError(), message: 'PRIVATE message' }))
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    expect(list[0]!.category).toBe('window-error')
    expect(list[0]!.template).toBe('read-props-of')
    expect(localStorage.getItem(ERROR_HISTORY_KEY)!.includes('PRIVATE')).toBe(false)
  })

  it('records an unhandled rejection, omitting a non-Error reason', () => {
    const ev = new Event('unhandledrejection') as Event & { reason: unknown }
    ev.reason = 'PRIVATE reason string'
    window.dispatchEvent(ev)
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    expect(list[0]!.category).toBe('unhandled-rejection')
    expect(list[0]!.text).toBe('[message omitted]')
    expect(localStorage.getItem(ERROR_HISTORY_KEY)!.includes('PRIVATE')).toBe(false)
  })

  it('records an Error rejection reason by template', () => {
    const ev = new Event('unhandledrejection') as Event & { reason: unknown }
    ev.reason = propError()
    window.dispatchEvent(ev)
    expect(readErrorHistory()[0]!.template).toBe('read-props-of')
  })

  it('ignores a ResizeObserver loop notification that carries no Error object', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }))
    expect(readErrorHistory()).toEqual([])
  })

  it('swallows a throw inside the recorder (storage and time formatting hostile)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x') })
    vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => { throw new Error('clock') })
    // jsdom reports an exception thrown by a listener on window.onerror; the capture path must not throw at all.
    const seen = vi.fn()
    const guard = (e: ErrorEvent) => seen(e)
    uninstall()
    window.addEventListener('error', guard)
    uninstall = installErrorCapture()
    expect(() => window.dispatchEvent(new ErrorEvent('error', { error: propError() }))).not.toThrow()
    window.removeEventListener('error', guard)
    // The only error event our guard saw is the one we dispatched, not a second one raised by a listener throw.
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('stops recording after uninstall', () => {
    uninstall()
    // vitest reports an error event nobody listens to as an unhandled error; give it a listener.
    const noop = (): void => {}
    window.addEventListener('error', noop)
    window.dispatchEvent(new ErrorEvent('error', { error: propError() }))
    window.removeEventListener('error', noop)
    expect(readErrorHistory()).toEqual([])
  })
})
