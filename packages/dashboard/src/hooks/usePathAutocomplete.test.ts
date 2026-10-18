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


describe('prefilled directory check', () => {
  it('checks the exact prefilled directory separately from its parent', () => {
    const { result } = renderHook(() => usePathAutocomplete('/outside/project', '/outside/project'))
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/outside/project', expect.any(String))
    act(() => capturedCallback?.({ path: '/outside', entries: [], error: 'Access denied' }))
    expect(result.current.pathCheck).toBeNull()
    act(() => capturedCallback?.({ path: '/outside/project', entries: [], error: 'Access denied' }))
    expect(result.current.pathCheck).toEqual({ path: '/outside/project', error: 'Access denied' })
  })
  it('accepts an allowed prefill even when its parent cannot be browsed', () => {
    const { result } = renderHook(() => usePathAutocomplete('/workspace/root', '/workspace/root'))
    act(() => { vi.advanceTimersByTime(200) })
    act(() => capturedCallback?.({ path: '/workspace/root', entries: [], error: null }))
    act(() => capturedCallback?.({ path: '/workspace', entries: [], error: 'Access denied' }))
    expect(result.current.pathCheck).toEqual({ path: '/workspace/root', error: null })
  })
  it('checks the inherited default when input is blank and suspends during Browse', () => {
    const { result, rerender } = renderHook(({ enabled }) => usePathAutocomplete('', '/default', enabled), { initialProps: { enabled: true } })
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockRequestDirectoryListing).toHaveBeenCalledWith('/default', expect.any(String))
    act(() => capturedCallback?.({ path: '/default', entries: [], error: 'Access denied' }))
    expect(result.current.pathCheck?.error).toBe('Access denied')
    mockRequestDirectoryListing.mockClear()
    rerender({ enabled: false })
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockRequestDirectoryListing).not.toHaveBeenCalled()
  })
})


describe('prefill reply correlation', () => {
  it.each([
    ['/outside//project', '/outside/project'],
    ['../outside/project', '/server/outside/project'],
    ['~/outside', '/home/user/outside'],
    ['C:\\outside\\project', 'C:/outside/project'],
  ])('checks normalized %s replies without relying on path spelling', (requested, resolved) => {
    const { result } = renderHook(() => usePathAutocomplete(requested, requested))
    act(() => { vi.advanceTimersByTime(200) })
    const requestId = mockRequestDirectoryListing.mock.calls.find(call => call[0] === requested)?.[1]
    expect(requestId).toEqual(expect.any(String))
    act(() => capturedCallback?.({ path: resolved, requestId, entries: [], error: 'Access denied' }))
    expect(result.current.pathCheck).toEqual({ path: requested, error: 'Access denied' })
  })

  it('ignores overlapping parent and superseded check replies', () => {
    const { result, rerender } = renderHook(({ path }) => usePathAutocomplete(path, path), { initialProps: { path: '/outside//old' } })
    act(() => { vi.advanceTimersByTime(200) })
    const oldId = mockRequestDirectoryListing.mock.calls.find(call => call[0] === '/outside//old')?.[1]
    rerender({ path: '/outside//new' })
    act(() => { vi.advanceTimersByTime(200) })
    const currentId = mockRequestDirectoryListing.mock.calls.find(call => call[0] === '/outside//new')?.[1]
    expect(currentId).toEqual(expect.any(String))
    expect(currentId).not.toBe(oldId)
    act(() => capturedCallback?.({ path: '/outside/new', requestId: oldId, entries: [], error: 'stale' }))
    act(() => capturedCallback?.({ path: '/outside', entries: [], error: 'parent' }))
    expect(result.current.pathCheck).toBeNull()
    act(() => capturedCallback?.({ path: '/outside/new', requestId: currentId, entries: [], error: 'Access denied' }))
    expect(result.current.pathCheck?.error).toBe('Access denied')
  })
})
