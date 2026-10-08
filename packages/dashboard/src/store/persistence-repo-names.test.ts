/**
 * Sidebar repo-group rename persistence tests (#7330)
 *
 * The user-chosen group label is stored per group path (the same key the
 * repo order and per-repo session order use) and must:
 *   - Round-trip through localStorage (survive a reload)
 *   - Be server-scoped
 *   - Reject malformed payloads without throwing
 *   - Drop the entry when the record is empty
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  persistSidebarRepoNames,
  loadPersistedSidebarRepoNames,
  setServerScope,
  _resetForTesting,
} from './persistence'

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
})

describe('sidebar repo-name persistence (#7330)', () => {
  it('round-trips names keyed by group path', () => {
    persistSidebarRepoNames({ '/p/a': 'Alpha', '/p/b': 'Beta' })
    expect(loadPersistedSidebarRepoNames()).toEqual({ '/p/a': 'Alpha', '/p/b': 'Beta' })
  })

  it('returns {} when nothing has been persisted', () => {
    expect(loadPersistedSidebarRepoNames()).toEqual({})
  })

  it('isolates names by server scope', () => {
    setServerScope('srv_A')
    persistSidebarRepoNames({ '/p/a': 'A-name' })
    setServerScope('srv_B')
    expect(loadPersistedSidebarRepoNames()).toEqual({})
    persistSidebarRepoNames({ '/p/a': 'B-name' })
    setServerScope('srv_A')
    expect(loadPersistedSidebarRepoNames()).toEqual({ '/p/a': 'A-name' })
  })

  it('removes the stored entry when the record is empty', () => {
    persistSidebarRepoNames({ '/p/a': 'Alpha' })
    persistSidebarRepoNames({})
    expect(loadPersistedSidebarRepoNames()).toEqual({})
    expect(Object.keys(localStorage).some(k => k.includes('sidebar_repo_names'))).toBe(false)
  })

  it('tolerates malformed payloads', () => {
    persistSidebarRepoNames({ '/p/a': 'Alpha' })
    const key = Object.keys(localStorage).find(k => k.includes('sidebar_repo_names'))!
    for (const bad of ['not json', '[]', '"str"', 'null', '42']) {
      localStorage.setItem(key, bad)
      expect(loadPersistedSidebarRepoNames()).toEqual({})
    }
  })

  it('drops non-string and blank values on load', () => {
    persistSidebarRepoNames({ '/p/a': 'Alpha' })
    const key = Object.keys(localStorage).find(k => k.includes('sidebar_repo_names'))!
    localStorage.setItem(key, JSON.stringify({ '/p/a': 'Alpha', '/p/b': 7, '/p/c': '', '/p/d': '   ', '/p/e': null }))
    expect(loadPersistedSidebarRepoNames()).toEqual({ '/p/a': 'Alpha' })
  })

  describe('when storage throws', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('persist swallows a throwing setItem', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
      expect(() => persistSidebarRepoNames({ '/p/a': 'Alpha' })).not.toThrow()
    })

    it('persist swallows a throwing removeItem', () => {
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
      expect(() => persistSidebarRepoNames({})).not.toThrow()
    })

    it('load returns {} when getItem throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
      expect(loadPersistedSidebarRepoNames()).toEqual({})
    })
  })
})
