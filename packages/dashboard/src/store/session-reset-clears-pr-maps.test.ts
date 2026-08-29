/**
 * #7470 (second site) — the two FULL-RESET actions must drop the per-session
 * PR/CI maps along with everything else session-scoped.
 *
 * `forgetSession()` (disconnect + forget this server) and `_resetSessionMemory()`
 * (switchServer, which preserves the old server's PERSISTED data but must not
 * carry its in-memory session state to the new one) both already clear
 * `sessions`, `sessionStates` and the Control Room `activity` tree. Leaving the
 * five PR/CI maps behind is worse than the unbounded growth #7470 was filed for:
 * these maps are keyed by SESSION ID, and session ids are minted per daemon —
 * so a surviving entry can be read against a DIFFERENT server's session of the
 * same id and render one machine's CI state on another machine's chip.
 *
 * Driven through the REAL store rather than a mock, because the thing under
 * test is the action's `set({ ... })` payload itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock localStorage before importing the store (same idiom as
// server-registry-store.test.ts — connection.ts reads persisted settings at
// module scope).
const lsStore: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => lsStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { lsStore[key] = value }),
  removeItem: vi.fn((key: string) => { delete lsStore[key] }),
  clear: vi.fn(() => { for (const k of Object.keys(lsStore)) delete lsStore[k] }),
  get length() { return Object.keys(lsStore).length },
  key: vi.fn((i: number) => Object.keys(lsStore)[i] ?? null),
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

const { useConnectionStore } = await import('./connection')
const { createEmptySessionState } = await import('./utils')

const A = 'sess-A'
const B = 'sess-B'

/** The five maps, populated for two sessions. */
function seedPrMaps() {
  useConnectionStore.setState({
    sessions: [{ sessionId: A }, { sessionId: B }] as never,
    activeSessionId: A,
    sessionStates: { [A]: createEmptySessionState(), [B]: createEmptySessionState() },
    sessionPrStatus: { [A]: { type: 'session_pr_status' } as never, [B]: { type: 'session_pr_status' } as never },
    sessionPrStatusLoading: { [A]: true, [B]: true },
    sessionPrStatusRequestedAt: { [A]: 1000, [B]: 2000 },
    sessionPrThreads: { [A]: { type: 'session_pr_threads' } as never, [B]: { type: 'session_pr_threads' } as never },
    sessionPrThreadsLoading: { [A]: true, [B]: true },
  })
}

/** Restore the store's PR/CI slice so this file cannot leak into another. */
function clearPrMaps() {
  useConnectionStore.setState({
    sessionPrStatus: {},
    sessionPrStatusLoading: {},
    sessionPrStatusRequestedAt: {},
    sessionPrThreads: {},
    sessionPrThreadsLoading: {},
  })
}

describe.each([
  ['forgetSession', () => useConnectionStore.getState().forgetSession()],
  ['_resetSessionMemory', () => useConnectionStore.getState()._resetSessionMemory()],
])('#7470 %s clears the per-session PR/CI maps', (_name, run) => {
  beforeEach(() => {
    clearPrMaps()
    seedPrMaps()
  })

  // A positive control for the whole block: the seed actually landed, so an
  // "everything is empty afterwards" assertion cannot pass because the fixture
  // was never applied.
  it('control: the seed populated all five maps for two sessions', () => {
    const s = useConnectionStore.getState()
    expect(Object.keys(s.sessionPrStatus)).toEqual([A, B])
    expect(Object.keys(s.sessionPrStatusLoading)).toEqual([A, B])
    expect(Object.keys(s.sessionPrStatusRequestedAt)).toEqual([A, B])
    expect(Object.keys(s.sessionPrThreads)).toEqual([A, B])
    expect(Object.keys(s.sessionPrThreadsLoading)).toEqual([A, B])
  })

  // One assertion per map: a reset that clears four of five must name the fifth.
  it('clears sessionPrStatus', () => {
    run()
    expect(useConnectionStore.getState().sessionPrStatus).toEqual({})
  })
  it('clears sessionPrStatusLoading', () => {
    run()
    expect(useConnectionStore.getState().sessionPrStatusLoading).toEqual({})
  })
  it('clears sessionPrStatusRequestedAt', () => {
    run()
    expect(useConnectionStore.getState().sessionPrStatusRequestedAt).toEqual({})
  })
  it('clears sessionPrThreads', () => {
    run()
    expect(useConnectionStore.getState().sessionPrThreads).toEqual({})
  })
  it('clears sessionPrThreadsLoading', () => {
    run()
    expect(useConnectionStore.getState().sessionPrThreadsLoading).toEqual({})
  })

  it('clears them as part of the same reset that drops sessionStates', () => {
    run()
    const s = useConnectionStore.getState()
    // Co-location check: these maps go with the session state they describe.
    // If sessionStates survived here the test above would be asserting the
    // wrong thing entirely.
    expect(s.sessionStates).toEqual({})
    expect(s.sessions).toEqual([])
  })
})
