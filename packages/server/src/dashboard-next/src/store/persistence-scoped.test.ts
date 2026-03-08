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
  persistTerminalBuffer,
  loadPersistedState,
  loadSessionMessages,
  loadSessionList,
  clearPersistedState,
  clearPersistedTerminalBuffer,
  flushPendingWrites,
  persistViewMode,
  _resetForTesting,
} from './persistence'

// We need to flush debounced persisters — use a small helper
// Terminal persister has 1000ms delay, so wait 1100ms
function flushPersisters(): Promise<void> {
  return new Promise(r => setTimeout(r, 1100))
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

describe('debounce race condition (#1689)', () => {
  it('debounced terminal buffer writes land in the correct scope', async () => {
    setServerScope('srv_A')
    persistTerminalBuffer('buffer-for-A')

    // Switch scope before debounce fires
    setServerScope('srv_B')
    persistTerminalBuffer('buffer-for-B')
    await flushPersisters()

    // Server A should have its buffer
    setServerScope('srv_A')
    const stateA = loadPersistedState()
    expect(stateA.terminalBuffer).toBe('buffer-for-A')

    // Server B should have its buffer
    setServerScope('srv_B')
    const stateB = loadPersistedState()
    expect(stateB.terminalBuffer).toBe('buffer-for-B')
  })

  it('debounced session list writes land in the correct scope', async () => {
    setServerScope('srv_A')
    persistSessionList([{ id: 's1', name: 'List A' } as never])

    // Switch scope before debounce fires
    setServerScope('srv_B')
    persistSessionList([{ id: 's2', name: 'List B' } as never])
    await flushPersisters()

    setServerScope('srv_A')
    const listA = loadSessionList()
    expect(listA).toHaveLength(1)
    expect((listA[0] as { name: string }).name).toBe('List A')

    setServerScope('srv_B')
    const listB = loadSessionList()
    expect(listB).toHaveLength(1)
    expect((listB[0] as { name: string }).name).toBe('List B')
  })

  it('debounced message writes land in the correct scope', async () => {
    setServerScope('srv_A')
    persistSessionMessages('s1', [{ id: 'msg-A', type: 'user', content: 'A' } as never])

    // Switch scope before debounce fires
    setServerScope('srv_B')
    persistSessionMessages('s1', [{ id: 'msg-B', type: 'user', content: 'B' } as never])
    await flushPersisters()

    setServerScope('srv_A')
    const msgsA = loadSessionMessages('s1')
    expect(msgsA).toHaveLength(1)
    expect(msgsA[0]!.content).toBe('A')

    setServerScope('srv_B')
    const msgsB = loadSessionMessages('s1')
    expect(msgsB).toHaveLength(1)
    expect(msgsB[0]!.content).toBe('B')
  })
})

describe('setServerScope flushes pending writes (#1689)', () => {
  it('flushing on scope change writes immediately', () => {
    setServerScope('srv_A')
    persistTerminalBuffer('pending-data')

    // Scope change should flush — data written immediately
    setServerScope('srv_B')

    // Verify the data landed in server A's scope
    const key = 'chroxy_persist_srv_A_terminal_buffer'
    expect(localStorage.getItem(key)).toBe('pending-data')
  })
})

describe('clearPersistedTerminalBuffer (#1689)', () => {
  it('clears server-scoped terminal buffer', () => {
    setServerScope('srv_A')
    persistTerminalBuffer('some-data')
    flushPendingWrites()

    expect(loadPersistedState().terminalBuffer).toBe('some-data')

    clearPersistedTerminalBuffer()
    expect(loadPersistedState().terminalBuffer).toBeNull()
  })

  it('does not clear other server scoped terminal buffer', () => {
    setServerScope('srv_A')
    persistTerminalBuffer('data-A')
    flushPendingWrites()

    setServerScope('srv_B')
    persistTerminalBuffer('data-B')
    flushPendingWrites()

    // Clear only server B
    clearPersistedTerminalBuffer()

    setServerScope('srv_A')
    expect(loadPersistedState().terminalBuffer).toBe('data-A')
  })
})

describe('flushPendingWrites (#1689)', () => {
  it('flushes all pending debounced writes synchronously', () => {
    setServerScope('srv_A')
    persistTerminalBuffer('flush-me')
    persistSessionList([{ id: 's1', name: 'flush-list' } as never])

    // Flush without waiting for timers
    flushPendingWrites()

    expect(loadPersistedState().terminalBuffer).toBe('flush-me')
    expect(loadSessionList()).toHaveLength(1)
  })
})
