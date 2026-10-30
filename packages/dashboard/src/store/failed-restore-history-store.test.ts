/**
 * #8860 — the read-only history view of a parked failed restore, driven through
 * the REAL store and the REAL message handler (no mocked `set`).
 *
 * Claims that matter, each with a control so it cannot pass for the wrong reason:
 *   - opening requests offset 0 / limit 50 and creates the view; "Load more"
 *     asks for the page AFTER what is shown (offset = entries.length);
 *   - a reply is applied only to a view that is open AND waiting, and only if it
 *     echoes the offset that view asked for (closed / superseded / unsolicited
 *     replies are dropped, not allowed to resurrect or corrupt a panel);
 *   - a refusal and a not-found land as an error beside the entries, not as an
 *     empty history;
 *   - a second request while one is in flight is refused;
 *   - a roster reply drops a view whose entry is gone, but a REFUSED roster
 *     (empty by construction) does not;
 *   - the views are per-daemon: a different-daemon reset clears them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

vi.mock('../utils/auth', () => ({ getAuthToken: () => 'local-token' }))

const { useConnectionStore } = await import('./connection')
const { handleMessage, stopHeartbeat, clearDeltaBuffers, clearPermissionSplits, resetReplayFlags } =
  await import('./message-handler')

type State = ReturnType<typeof useConnectionStore.getState>

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const page = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: 'message', messageType: 'response', content: `m${from + i}` }))

let sent: Array<Record<string, unknown>>
const ctx = () => ({ url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false })
const reply = (over: Record<string, unknown>) =>
  handleMessage({ type: 'failed_restore_history', sessionId: A, ok: true, ...over } as never, ctx() as never)
const views = () => useConnectionStore.getState().failedRestoreHistories
const row = (sessionId: string) => ({
  sessionId, name: 'n', provider: 'codex', errorCode: 'CODEX_NATIVE_LOCATOR_MISSING', errorMessage: 'm', historyLength: 9,
})

function resetSlice(socket: unknown = null) {
  useConnectionStore.setState({
    failedRestoreHistories: {},
    failedRestores: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    connectionPhase: 'connected',
    socket,
  } as unknown as Partial<State>)
}

beforeEach(() => {
  clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
  sent = []
  const socket = { readyState: WebSocket.OPEN, send: (d: string) => { sent.push(JSON.parse(d)) }, close: vi.fn() }
  resetSlice(socket)
})
afterEach(() => { stopHeartbeat(); resetSlice() })

describe('requestFailedRestoreHistory (#8860)', () => {
  it('opens a view and asks for the first page (offset 0, limit 50)', () => {
    expect(useConnectionStore.getState().requestFailedRestoreHistory(A)).toBe(true)

    expect(sent).toEqual([{ type: 'get_failed_restore_history', sessionId: A, offset: 0, limit: 50 }])
    expect(views()[A]).toMatchObject({ entries: [], total: null, loading: true, pendingOffset: 0 })
  })

  it('Load more asks for the page after what is shown, and keeps the entries', () => {
    useConnectionStore.getState().requestFailedRestoreHistory(A)
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    sent.length = 0

    expect(useConnectionStore.getState().requestFailedRestoreHistory(A, true)).toBe(true)

    expect(sent).toEqual([{ type: 'get_failed_restore_history', sessionId: A, offset: 50, limit: 50 }])
    expect(views()[A]!.entries).toHaveLength(50)
    expect(views()[A]).toMatchObject({ loading: true, pendingOffset: 50, total: 120 })
  })

  it('refuses a second request while one is in flight (no ambiguous offset)', () => {
    useConnectionStore.getState().requestFailedRestoreHistory(A)
    sent.length = 0
    expect(useConnectionStore.getState().requestFailedRestoreHistory(A, true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('does nothing without an open socket or an id', () => {
    useConnectionStore.setState({ socket: null } as unknown as Partial<State>)
    expect(useConnectionStore.getState().requestFailedRestoreHistory(A)).toBe(false)
    expect(views()).toEqual({})
    expect(useConnectionStore.getState().requestFailedRestoreHistory('')).toBe(false)
  })

  it('close drops the view and its entries', () => {
    useConnectionStore.getState().requestFailedRestoreHistory(A)
    reply({ total: 1, offset: 0, entries: page(0, 1) })
    useConnectionStore.getState().closeFailedRestoreHistory(A)
    expect(views()[A]).toBeUndefined()
  })
})

describe('failed_restore_history reply (#8860)', () => {
  beforeEach(() => { useConnectionStore.getState().requestFailedRestoreHistory(A) })

  it('fills the first page and clears loading', () => {
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    expect(views()[A]).toMatchObject({ total: 120, loading: false, pendingOffset: null })
    expect(views()[A]!.entries).toHaveLength(50)
    expect(views()[A]!.error).toBeUndefined()
  })

  it('appends the next page after the first, oldest first', () => {
    reply({ total: 60, offset: 0, entries: page(0, 50) })
    useConnectionStore.getState().requestFailedRestoreHistory(A, true)
    reply({ total: 60, offset: 50, entries: page(50, 10) })

    const entries = views()[A]!.entries
    expect(entries).toHaveLength(60)
    expect(entries[0]!.content).toBe('m0')
    expect(entries[59]!.content).toBe('m59')
    expect(views()[A]!.loading).toBe(false)
  })

  it('drops a reply whose offset is not the one asked for (stale)', () => {
    reply({ total: 120, offset: 50, entries: page(50, 50) })
    // CONTROL: the same frame with the right offset is applied.
    expect(views()[A]).toMatchObject({ loading: true, pendingOffset: 0 })
    expect(views()[A]!.entries).toEqual([])
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    expect(views()[A]!.entries).toHaveLength(50)
  })

  it('drops a reply for a view that was closed meanwhile instead of reopening it', () => {
    useConnectionStore.getState().closeFailedRestoreHistory(A)
    reply({ total: 1, offset: 0, entries: page(0, 1) })
    expect(views()[A]).toBeUndefined()
  })

  it('drops an unsolicited reply to a view that is not waiting', () => {
    reply({ total: 1, offset: 0, entries: page(0, 1) })
    expect(views()[A]!.entries).toHaveLength(1)
    reply({ total: 2, offset: 1, entries: page(1, 1) })
    expect(views()[A]!.entries).toHaveLength(1)
  })

  it('ignores a reply for another session id', () => {
    reply({ sessionId: B, total: 1, offset: 0, entries: page(0, 1) })
    expect(views()[B]).toBeUndefined()
    expect(views()[A]).toMatchObject({ loading: true })
  })

  it('records a bound-client refusal as an error, not as an empty history', () => {
    reply({ ok: false, refused: true, code: 'FAILED_RESTORE_HISTORY_FORBIDDEN_BOUND_CLIENT', message: 'no' })
    expect(views()[A]).toMatchObject({ loading: false, pendingOffset: null, total: null })
    expect(views()[A]!.error).toEqual({ code: 'FAILED_RESTORE_HISTORY_FORBIDDEN_BOUND_CLIENT', message: 'no', refused: true })
  })

  it('records not-found as an error and keeps the entries already shown', () => {
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    useConnectionStore.getState().requestFailedRestoreHistory(A, true)
    reply({ ok: false, code: 'FAILED_RESTORE_NOT_FOUND', message: 'gone' })
    expect(views()[A]!.entries).toHaveLength(50)
    expect(views()[A]!.error).toMatchObject({ code: 'FAILED_RESTORE_NOT_FOUND', refused: false })
    expect(views()[A]!.loading).toBe(false)
  })

  it('a new request clears the previous error', () => {
    reply({ ok: false, code: 'X', message: 'boom' })
    useConnectionStore.getState().requestFailedRestoreHistory(A)
    expect(views()[A]!.error).toBeUndefined()
  })

  it('treats a malformed entries field as an empty page and ends the list', () => {
    reply({ total: 120, offset: 0, entries: 'nope' })
    expect(views()[A]!.entries).toEqual([])
    // total is clamped to what was actually received, so Load more cannot spin
    // re-requesting the same offset forever.
    expect(views()[A]!.total).toBe(0)
  })
})

describe('roster interaction and daemon lifetime (#8860)', () => {
  beforeEach(() => {
    useConnectionStore.getState().requestFailedRestoreHistory(A)
    useConnectionStore.getState().requestFailedRestoreHistory(B)
  })

  it('a roster reply drops the view of an entry that is no longer parked', () => {
    handleMessage({ type: 'failed_restores_list', generatedAt: 'x', restores: [row(B)] } as never, ctx() as never)
    expect(views()[A]).toBeUndefined()
    expect(views()[B]).toBeDefined()
  })

  it('a REFUSED roster (empty by construction) leaves the views alone', () => {
    handleMessage({ type: 'failed_restores_list', generatedAt: 'x', restores: [], refused: true } as never, ctx() as never)
    expect(views()[A]).toBeDefined()
    expect(views()[B]).toBeDefined()
  })

  it('forgetSession (a different daemon) clears every view', () => {
    expect(Object.keys(views())).toHaveLength(2)
    useConnectionStore.getState().forgetSession()
    expect(views()).toEqual({})
  })

  it('disconnect clears every view', () => {
    expect(Object.keys(views())).toHaveLength(2)
    useConnectionStore.getState().disconnect()
    expect(views()).toEqual({})
  })
})
