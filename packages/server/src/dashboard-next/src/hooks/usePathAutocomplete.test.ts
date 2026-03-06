/**
 * usePathAutocomplete tests (#1435)
 *
 * Tests the path splitting logic and debounced autocomplete behavior.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { splitPath, usePathAutocomplete } from './usePathAutocomplete'

// Stable mock functions (never reassigned — prevents infinite re-render loops)
const mockRequestDirectoryListing = vi.fn()
let capturedCallback: ((listing: unknown) => void) | null = null
const stableSetCallback = (cb: ((listing: unknown) => void) | null) => {
  capturedCallback = cb
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      requestDirectoryListing: mockRequestDirectoryListing,
      setDirectoryListingCallback: stableSetCallback,
    }
    return selector(state)
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  mockRequestDirectoryListing.mockClear()
  capturedCallback = null
})

afterEach(() => {
  // Flush any pending debounce timers before cleanup
  vi.runAllTimers()
  cleanup()
  vi.useRealTimers()
})

describe('splitPath', () => {
  it('returns empty for empty input', () => {
    expect(splitPath('')).toEqual({ parent: '', partial: '' })
  })

  it('splits /home/user/pro into parent and partial', () => {
    expect(splitPath('/home/user/pro')).toEqual({ parent: '/home/user', partial: 'pro' })
  })

  it('handles root-level path', () => {
    expect(splitPath('/usr')).toEqual({ parent: '/', partial: 'usr' })
  })

  it('handles path without leading slash', () => {
    expect(splitPath('foo')).toEqual({ parent: '', partial: 'foo' })
  })

  it('handles tilde paths', () => {
    expect(splitPath('~/projects/my')).toEqual({ parent: '~/projects', partial: 'my' })
  })

  it('handles trailing slash (directory listing request)', () => {
    expect(splitPath('/home/user/')).toEqual({ parent: '/home/user', partial: '' })
  })
})

describe('usePathAutocomplete', () => {
  it('returns empty suggestions for empty input', () => {
    const { result } = renderHook(() => usePathAutocomplete(''))
    expect(result.current.suggestions).toEqual([])
  })

  it('returns empty suggestions for short input (< 2 chars)', () => {
    const { result } = renderHook(() => usePathAutocomplete('/'))
    expect(result.current.suggestions).toEqual([])
  })

  it('debounces server requests by 200ms', () => {
    const { rerender } = renderHook(
      ({ input }) => usePathAutocomplete(input),
      { initialProps: { input: '/home/us' } },
    )

    // No request yet — debounce hasn't fired
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()

    // Advance past debounce
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/home')

    // Type more — should debounce again
    mockRequestDirectoryListing.mockClear()
    rerender({ input: '/home/user' })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/home')
  })

  it('filters directory entries by prefix match', () => {
    const { result } = renderHook(() => usePathAutocomplete('/home/us'))

    act(() => { vi.advanceTimersByTime(200) })

    // Simulate server response
    act(() => {
      capturedCallback?.({
        path: '/home',
        parentPath: null,
        entries: [
          { name: 'user', isDirectory: true },
          { name: 'usr', isDirectory: true },
          { name: 'utils', isDirectory: false }, // not a directory
          { name: 'bin', isDirectory: true },     // doesn't match prefix
        ],
        error: null,
      })
    })

    expect(result.current.suggestions).toEqual(['/home/user', '/home/usr'])
  })

  it('returns empty on server error', () => {
    const { result } = renderHook(() => usePathAutocomplete('/nonexistent/pa'))

    act(() => { vi.advanceTimersByTime(200) })

    act(() => {
      capturedCallback?.({
        path: null,
        parentPath: null,
        entries: [],
        error: 'Directory not found',
      })
    })

    expect(result.current.suggestions).toEqual([])
  })
})
