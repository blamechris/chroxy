/**
 * Server-scoped persistence tests (#1647)
 *
 * Verifies that session data is isolated per server ID,
 * preventing data loss when switching between servers.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setServerScope,
  persistActiveSession,
  persistSessionMessages,
  persistSessionList,
  loadPersistedState,
  loadSessionMessages,
  loadSessionList,
  clearPersistedState,
  persistViewMode,
  _resetForTesting,
} from './persistence'

// We need to flush debounced persisters — use a small helper
function flushPersisters(): Promise<void> {
  return new Promise(r => setTimeout(r, 600))
}

beforeEach(() => {
  localStorage.clear()
  _resetForTesting()
  setServerScope(null)
})

describe('server-scoped persistence (#1647)', () => {
  it('isolates active session by server', () => {
    setServerScope('srv_A')
    persistActiveSession('session-1')

    setServerScope('srv_B')
    persistActiveSession('session-2')

    // Load from server A
    setServerScope('srv_A')
    const stateA = loadPersistedState()
    expect(stateA.activeSessionId).toBe('session-1')

    // Load from server B
    setServerScope('srv_B')
    const stateB = loadPersistedState()
    expect(stateB.activeSessionId).toBe('session-2')
  })

  it('isolates session messages by server', async () => {
    setServerScope('srv_A')
    persistSessionMessages('s1', [{ id: 'msg-1', type: 'user', content: 'hello A' } as never])
    await flushPersisters()

    setServerScope('srv_B')
    persistSessionMessages('s1', [{ id: 'msg-2', type: 'user', content: 'hello B' } as never])
    await flushPersisters()

    setServerScope('srv_A')
    const msgsA = loadSessionMessages('s1')
    expect(msgsA).toHaveLength(1)
    expect(msgsA[0]!.content).toBe('hello A')

    setServerScope('srv_B')
    const msgsB = loadSessionMessages('s1')
    expect(msgsB).toHaveLength(1)
    expect(msgsB[0]!.content).toBe('hello B')
  })

  it('isolates session list by server', async () => {
    setServerScope('srv_A')
    persistSessionList([{ id: 's1', name: 'Session A' } as never])
    await flushPersisters()

    setServerScope('srv_B')
    persistSessionList([{ id: 's2', name: 'Session B' } as never])
    await flushPersisters()

    setServerScope('srv_A')
    const listA = loadSessionList()
    expect(listA).toHaveLength(1)
    expect((listA[0] as { name: string }).name).toBe('Session A')

    setServerScope('srv_B')
    const listB = loadSessionList()
    expect(listB).toHaveLength(1)
    expect((listB[0] as { name: string }).name).toBe('Session B')
  })

  it('clearPersistedState only clears current server scope', () => {
    setServerScope('srv_A')
    persistActiveSession('session-A')

    setServerScope('srv_B')
    persistActiveSession('session-B')

    // Clear server B
    clearPersistedState()

    // Server A data should survive
    setServerScope('srv_A')
    const stateA = loadPersistedState()
    expect(stateA.activeSessionId).toBe('session-A')

    // Server B data should be gone
    setServerScope('srv_B')
    const stateB = loadPersistedState()
    expect(stateB.activeSessionId).toBeNull()
  })

  it('preserves global settings (view mode) across server switches', () => {
    persistViewMode('terminal')

    setServerScope('srv_A')
    const stateA = loadPersistedState()
    expect(stateA.viewMode).toBe('terminal')

    setServerScope('srv_B')
    const stateB = loadPersistedState()
    expect(stateB.viewMode).toBe('terminal')
  })

  it('falls back to unscoped keys when no server scope set', () => {
    // Simulate legacy unscoped data
    setServerScope(null)
    persistActiveSession('legacy-session')

    const state = loadPersistedState()
    expect(state.activeSessionId).toBe('legacy-session')
  })
})
