/**
 * useSidebarOrdering — repo-group names (#7330). Drives the REAL hook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

let activeServerId: string | null = null
vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: { activeServerId: string | null }) => T): T =>
    selector({ activeServerId }),
}))

import { useSidebarOrdering } from './useSidebarOrdering'
import { loadPersistedSidebarRepoNames, setServerScope, _resetForTesting } from '../store/persistence'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
  activeServerId = null
})

describe('useSidebarOrdering repo names (#7330)', () => {
  it('stores a trimmed name by path and persists it', () => {
    const { result } = renderHook(() => useSidebarOrdering())
    act(() => result.current.handleRenameRepo('/p/a', '  Alpha  '))
    expect(result.current.sidebarRepoNames).toEqual({ '/p/a': 'Alpha' })
    expect(loadPersistedSidebarRepoNames()).toEqual({ '/p/a': 'Alpha' })
  })

  it('a blank name removes only that path and persists the removal', () => {
    const { result } = renderHook(() => useSidebarOrdering())
    act(() => result.current.handleRenameRepo('/p/a', 'Alpha'))
    act(() => result.current.handleRenameRepo('/p/b', 'Beta'))
    act(() => result.current.handleRenameRepo('/p/a', ' '))
    expect(result.current.sidebarRepoNames).toEqual({ '/p/b': 'Beta' })
    expect(loadPersistedSidebarRepoNames()).toEqual({ '/p/b': 'Beta' })
  })

  it('a fresh mount reads the persisted names back', () => {
    const first = renderHook(() => useSidebarOrdering())
    act(() => first.result.current.handleRenameRepo('/p/a', 'Alpha'))
    first.unmount()
    const second = renderHook(() => useSidebarOrdering())
    expect(second.result.current.sidebarRepoNames).toEqual({ '/p/a': 'Alpha' })
  })

  it('re-reads under the new scope when the active server changes', () => {
    setServerScope('srv_A')
    activeServerId = 'srv_A'
    const { result, rerender } = renderHook(() => useSidebarOrdering())
    act(() => result.current.handleRenameRepo('/p/a', 'A-name'))
    setServerScope('srv_B')
    activeServerId = 'srv_B'
    rerender()
    expect(result.current.sidebarRepoNames).toEqual({})
    setServerScope('srv_A')
    activeServerId = 'srv_A'
    rerender()
    expect(result.current.sidebarRepoNames).toEqual({ '/p/a': 'A-name' })
  })
})
