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

  // Windows path support (#1553)
  it('splits Windows path with backslashes', () => {
    expect(splitPath('C:\\Users\\dev\\pro')).toEqual({ parent: 'C:\\Users\\dev', partial: 'pro' })
  })

  it('handles Windows root-level path', () => {
    expect(splitPath('C:\\Users')).toEqual({ parent: 'C:\\', partial: 'Users' })
  })

  it('handles trailing backslash', () => {
    expect(splitPath('C:\\Users\\dev\\')).toEqual({ parent: 'C:\\Users\\dev', partial: '' })
  })

  it('handles mixed separators', () => {
    expect(splitPath('C:\\Users/dev\\pro')).toEqual({ parent: 'C:\\Users/dev', partial: 'pro' })
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

describe('exact directory access probe', () => {
  const listing = (path: string, error: string | null = null) => ({ path, error, entries: [{ name: 'project', isDirectory: true }] })

  it('checks the exact cwd and keeps parent suggestions when its probe is rejected', () => {
    const { result } = renderHook(() => usePathAutocomplete('/workspace/pro', { checkDirectory: true }))
    expect(result.current.directoryAccess?.status).toBe('pending')
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/workspace/pro', expect.any(String))
    act(() => { capturedCallback?.(listing('/workspace')) })
    expect(result.current.suggestions).toEqual(['/workspace/project'])
    act(() => { capturedCallback?.(listing('/workspace/pro', 'Access denied')) })
    expect(result.current.directoryAccess).toEqual({ path: '/workspace/pro', status: 'denied', error: 'Access denied' })
    expect(result.current.suggestions).toEqual(['/workspace/project'])
  })

  it('accepts an exact success and ignores stale successes and errors', () => {
    const { result, rerender } = renderHook(({ input }) => usePathAutocomplete(input, { checkDirectory: true }), { initialProps: { input: '/old/project' } })
    act(() => { vi.advanceTimersByTime(200) })
    const oldCallback = capturedCallback
    rerender({ input: '/new/project' })
    act(() => { vi.advanceTimersByTime(200) })
    act(() => {
      oldCallback?.(listing('/old/project'))
      oldCallback?.(listing('/old/project', 'Access denied'))
      capturedCallback?.(listing('/old/project', 'Access denied'))
    })
    expect(result.current.directoryAccess?.status).toBe('pending')
    act(() => { capturedCallback?.(listing('/new/project')) })
    expect(result.current.directoryAccess).toEqual({ path: '/new/project', status: 'allowed', error: null })
  })

  it('does not clear current suggestions for a stale parent error', () => {
    const { result } = renderHook(() => usePathAutocomplete('/new/pro', { checkDirectory: true }))
    act(() => { vi.advanceTimersByTime(200) })
    act(() => { capturedCallback?.(listing('/new')) })
    act(() => { capturedCallback?.(listing('/old', 'Access denied')) })
    expect(result.current.suggestions).toEqual(['/new/project'])
  })

  it('bounds no-response pending state and never calls it allowed', () => {
    const { result } = renderHook(() => usePathAutocomplete('/workspace/project', { checkDirectory: true }))
    act(() => { vi.advanceTimersByTime(2200) })
    expect(result.current.directoryAccess).toEqual({ path: '/workspace/project', status: 'unknown', error: null })
  })

  it('suspends requests while Browse owns the callback and ignores its old probe', () => {
    const { result, rerender } = renderHook(({ enabled }) => usePathAutocomplete('/workspace/project', { checkDirectory: true, enabled }), { initialProps: { enabled: true } })
    act(() => { vi.advanceTimersByTime(200) })
    const oldCallback = capturedCallback
    const browseCallback = vi.fn()
    stableSetCallback(browseCallback)
    rerender({ enabled: false })
    mockRequestDirectoryListing.mockClear()
    act(() => { vi.advanceTimersByTime(5000); oldCallback?.(listing('/workspace/project')) })
    expect(capturedCallback).toBe(browseCallback)
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
    expect(result.current.directoryAccess?.status).not.toBe('allowed')
  })
})

describe('directory correlation after server normalization', () => {
  it.each(['/workspace//project', '/workspace/child/../project', '~/project', 'project'])('correlates normalized success and rejection for %s by request id', input => {
    const { result } = renderHook(() => usePathAutocomplete(input, { checkDirectory: true }))
    act(() => { vi.advanceTimersByTime(200) })
    const requestId = mockRequestDirectoryListing.mock.calls.find(call => call[0] === input)?.[1]
    expect(typeof requestId).toBe('string')
    act(() => { capturedCallback?.({ path: '/workspace/project', entries: [], error: null, requestId }) })
    expect(result.current.directoryAccess?.status).toBe('allowed')
    act(() => { capturedCallback?.({ path: '/workspace/project', entries: [], error: 'Access denied', requestId }) })
    expect(result.current.directoryAccess?.status).toBe('denied')
  })
})

describe('directory request generations', () => {
  it('ignores an old nonce even when a later request returns to the same path', () => {
    const { result, rerender } = renderHook(({ input }) => usePathAutocomplete(input, { checkDirectory: true }), { initialProps: { input: '/workspace/project' } })
    act(() => { vi.advanceTimersByTime(200) })
    const oldId = mockRequestDirectoryListing.mock.calls[mockRequestDirectoryListing.mock.calls.length - 1]?.[1]
    rerender({ input: '/workspace/other' })
    act(() => { vi.advanceTimersByTime(200) })
    rerender({ input: '/workspace/project' })
    act(() => { vi.advanceTimersByTime(200) })
    const currentId = mockRequestDirectoryListing.mock.calls[mockRequestDirectoryListing.mock.calls.length - 1]?.[1]
    expect(currentId).not.toBe(oldId)
    for (const error of [null, 'Access denied']) {
      act(() => { capturedCallback?.({ path: '/workspace/project', entries: [], error, requestId: oldId }) })
      expect(result.current.directoryAccess?.status).toBe('pending')
    }
    act(() => { capturedCallback?.({ path: '/workspace/project', entries: [], error: null, requestId: currentId }) })
    expect(result.current.directoryAccess?.status).toBe('allowed')
  })
})
