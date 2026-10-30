/**
 * Session archive (dashboard store) — driven through the REAL store and the REAL
 * message handler (no mocked `set`). The history-page rules are shared with the
 * failed-restore path (store/history-views.ts), so the reply guard is exercised
 * here for the archive map AND pinned for both maps in the parity block.
 *
 * Claims, each with a control so it cannot pass for the wrong reason:
 *   - opening asks offset 0 / limit 50; Load more asks offset = entries.length;
 *   - a reply lands only on an open AND waiting view echoing the asked offset;
 *   - refusal / not-found land as an error beside the entries, not as empty;
 *   - a list reply drops vanished views (not when REFUSED) and normalises rows;
 *   - delete (one / all) marks pending, sends exactly one frame, and on success
 *     drops the view(s) and re-asks for the list; a failure keeps the row and
 *     records the error;
 *   - a socket drop settles a pending page and clears delete markers;
 *   - the daemon-lifetime reset sites clear the archive state.
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

const A = 'arch-aaaa'
const B = 'arch-bbbb'

const page = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: 'message', messageType: 'response', content: `m${from + i}` }))

let sent: Array<Record<string, unknown>>
const ctx = () => ({ url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false })
const receive = (msg: Record<string, unknown>) => handleMessage(msg as never, ctx() as never)
const reply = (over: Record<string, unknown>) =>
  receive({ type: 'archived_session_history', archiveId: A, ok: true, ...over })
const views = () => useConnectionStore.getState().archivedSessionHistories
const get = () => useConnectionStore.getState()
const meta = (archiveId: string) => ({
  archiveId, sessionId: `sid-${archiveId}`, name: 'n', provider: 'claude', cwd: '/w', model: null,
  reason: 'closed', archivedAt: 1, lastActivityAt: 1, createdAt: 1, historyLength: 9, bytes: 10,
})
const policy = { enabled: true, maxEntries: 200, maxAgeDays: 30, maxMegabytes: 256 }
const list = (ids: string[], over: Record<string, unknown> = {}) =>
  receive({ type: 'archived_sessions_list', generatedAt: 'x', policy, sessions: ids.map(meta), ...over })

function resetSlice(socket: unknown = null) {
  useConnectionStore.setState({
    archivedSessions: null,
    archivedSessionsLoading: false,
    archivedSessionHistories: {},
    deletingArchiveIds: new Set<string>(),
    deletingAllArchives: false,
    archiveDeleteError: null,
    failedRestoreHistories: {},
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

describe('requestArchivedSessions', () => {
  it('flips the loading flag and sends list_archived_sessions', () => {
    expect(get().requestArchivedSessions()).toBe(true)
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
    expect(get().archivedSessionsLoading).toBe(true)
  })

  it('does not set loading when the socket is closed', () => {
    useConnectionStore.setState({ socket: null } as unknown as Partial<State>)
    expect(get().requestArchivedSessions()).toBe(false)
    expect(get().archivedSessionsLoading).toBe(false)
  })
})

describe('archived_sessions_list', () => {
  it('stores the whole message, normalises sessions, and clears loading', () => {
    get().requestArchivedSessions()
    list([A, B])
    expect(get().archivedSessions?.sessions.map((s) => s.archiveId)).toEqual([A, B])
    expect(get().archivedSessions?.policy).toEqual(policy)
    expect(get().archivedSessionsLoading).toBe(false)

    receive({ type: 'archived_sessions_list', generatedAt: 'y', policy, sessions: 'nope' })
    expect(get().archivedSessions?.sessions).toEqual([])
  })

  it('a refused reply clears loading too (or Refresh would be disabled for good)', () => {
    get().requestArchivedSessions()
    list([], { refused: true, code: 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT' })
    expect(get().archivedSessionsLoading).toBe(false)
    expect(get().archivedSessions?.refused).toBe(true)
  })

  it('drops the view of a record that is no longer listed', () => {
    get().requestArchivedSessionHistory(A)
    get().requestArchivedSessionHistory(B)
    list([B])
    expect(views()[A]).toBeUndefined()
    expect(views()[B]).toBeDefined()
  })

  it('a REFUSED list (empty by construction) leaves the views alone', () => {
    get().requestArchivedSessionHistory(A)
    list([], { refused: true })
    expect(views()[A]).toBeDefined()
  })
})

describe('requestArchivedSessionHistory', () => {
  it('opens a view and asks for the first page (offset 0, limit 50)', () => {
    expect(get().requestArchivedSessionHistory(A)).toBe(true)
    expect(sent).toEqual([{ type: 'get_archived_session_history', archiveId: A, offset: 0, limit: 50 }])
    expect(views()[A]).toMatchObject({ entries: [], total: null, loading: true, pendingOffset: 0 })
  })

  it('Load more asks for the page after what is shown, keeping the entries', () => {
    get().requestArchivedSessionHistory(A)
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    sent.length = 0
    expect(get().requestArchivedSessionHistory(A, true)).toBe(true)
    expect(sent).toEqual([{ type: 'get_archived_session_history', archiveId: A, offset: 50, limit: 50 }])
    expect(views()[A]!.entries).toHaveLength(50)
    expect(views()[A]).toMatchObject({ loading: true, pendingOffset: 50, total: 120 })
  })

  it('refuses a second request while one is in flight', () => {
    get().requestArchivedSessionHistory(A)
    sent.length = 0
    expect(get().requestArchivedSessionHistory(A, true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('does nothing without a socket or an id', () => {
    useConnectionStore.setState({ socket: null } as unknown as Partial<State>)
    expect(get().requestArchivedSessionHistory(A)).toBe(false)
    expect(views()).toEqual({})
    expect(get().requestArchivedSessionHistory('')).toBe(false)
  })

  it('close drops the view', () => {
    get().requestArchivedSessionHistory(A)
    get().closeArchivedSessionHistory(A)
    expect(views()[A]).toBeUndefined()
  })
})

describe('archived_session_history reply', () => {
  beforeEach(() => { get().requestArchivedSessionHistory(A) })

  it('fills the first page and appends the next, oldest first', () => {
    reply({ total: 60, offset: 0, entries: page(0, 50) })
    expect(views()[A]).toMatchObject({ total: 60, loading: false, pendingOffset: null })
    get().requestArchivedSessionHistory(A, true)
    reply({ total: 60, offset: 50, entries: page(50, 10) })
    expect(views()[A]!.entries).toHaveLength(60)
    expect(views()[A]!.entries[59]!.content).toBe('m59')
  })

  it('drops a reply whose offset is not the one asked for (stale), then applies the right one', () => {
    reply({ total: 120, offset: 50, entries: page(50, 50) })
    expect(views()[A]).toMatchObject({ loading: true, pendingOffset: 0 })
    expect(views()[A]!.entries).toEqual([])
    // CONTROL: the same frame with the right offset is applied.
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    expect(views()[A]!.entries).toHaveLength(50)
  })

  it('drops a reply for a view closed meanwhile instead of reopening it', () => {
    get().closeArchivedSessionHistory(A)
    reply({ total: 1, offset: 0, entries: page(0, 1) })
    expect(views()[A]).toBeUndefined()
  })

  it('drops an unsolicited reply to a view that is not waiting', () => {
    reply({ total: 1, offset: 0, entries: page(0, 1) })
    reply({ total: 2, offset: 1, entries: page(1, 1) })
    expect(views()[A]!.entries).toHaveLength(1)
  })

  it('drops an offset-less reply to a view that is not waiting', () => {
    reply({ total: 1, offset: 0, entries: page(0, 1) })
    reply({ total: 2, entries: page(1, 1) })
    expect(views()[A]!.entries).toHaveLength(1)
  })

  it('ignores a reply for another archive id', () => {
    reply({ archiveId: B, total: 1, offset: 0, entries: page(0, 1) })
    expect(views()[B]).toBeUndefined()
    expect(views()[A]).toMatchObject({ loading: true })
  })

  it('records a bound-client refusal as an error, not an empty history', () => {
    reply({ ok: false, refused: true, code: 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT', message: 'no' })
    expect(views()[A]).toMatchObject({ loading: false, pendingOffset: null, total: null })
    expect(views()[A]!.error).toEqual({ code: 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT', message: 'no', refused: true })
  })

  it('records not-found as an error and keeps the entries already shown', () => {
    reply({ total: 120, offset: 0, entries: page(0, 50) })
    get().requestArchivedSessionHistory(A, true)
    reply({ ok: false, code: 'ARCHIVED_SESSION_NOT_FOUND', message: 'gone' })
    expect(views()[A]!.entries).toHaveLength(50)
    expect(views()[A]!.error).toMatchObject({ code: 'ARCHIVED_SESSION_NOT_FOUND', refused: false })
  })

  it('a zero-length page ends the list instead of spinning on the same offset', () => {
    reply({ total: 120, offset: 0, entries: 'nope' })
    expect(views()[A]!.total).toBe(0)
  })
})

describe('the shared reply guard serves BOTH history maps', () => {
  it('a stale offset is dropped on the failed-restore map exactly as on the archive map', () => {
    get().requestFailedRestoreHistory('sess-1')
    receive({ type: 'failed_restore_history', sessionId: 'sess-1', ok: true, total: 9, offset: 50, entries: page(0, 1) })
    expect(get().failedRestoreHistories['sess-1']).toMatchObject({ loading: true, entries: [] })
    get().requestArchivedSessionHistory(A)
    reply({ total: 9, offset: 50, entries: page(0, 1) })
    expect(views()[A]).toMatchObject({ loading: true, entries: [] })
  })

  it('the two maps do not see each other\'s ids', () => {
    get().requestFailedRestoreHistory('sess-1')
    reply({ archiveId: 'sess-1', total: 1, offset: 0, entries: page(0, 1) })
    expect(views()['sess-1']).toBeUndefined()
    expect(get().failedRestoreHistories['sess-1']).toMatchObject({ loading: true })
  })
})

describe('delete', () => {
  it('deleteArchivedSession marks pending, sends one frame, and refuses a duplicate', () => {
    expect(get().deleteArchivedSession(A)).toBe(true)
    expect(sent).toEqual([{ type: 'delete_archived_session', archiveId: A }])
    expect([...get().deletingArchiveIds]).toEqual([A])
    expect(get().deleteArchivedSession(A)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('deleteAllArchivedSessions sends { all: true } and does not send an archiveId', () => {
    expect(get().deleteAllArchivedSessions()).toBe(true)
    expect(sent).toEqual([{ type: 'delete_archived_session', all: true }])
    expect(get().deletingAllArchives).toBe(true)
    expect(get().deleteAllArchivedSessions()).toBe(false)
  })

  it('does nothing without a socket', () => {
    useConnectionStore.setState({ socket: null } as unknown as Partial<State>)
    expect(get().deleteArchivedSession(A)).toBe(false)
    expect(get().deleteAllArchivedSessions()).toBe(false)
    expect(get().deletingArchiveIds.size).toBe(0)
    expect(get().deletingAllArchives).toBe(false)
  })

  it('success clears pending, drops that view only, and re-asks for the list', () => {
    get().requestArchivedSessionHistory(A)
    get().requestArchivedSessionHistory(B)
    get().deleteArchivedSession(A)
    sent.length = 0
    receive({ type: 'delete_archived_session_result', ok: true, deleted: 1, archiveId: A })
    expect(get().deletingArchiveIds.size).toBe(0)
    expect(views()[A]).toBeUndefined()
    expect(views()[B]).toBeDefined()
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
    expect(get().archiveDeleteError).toBeNull()
  })

  it('an id-less (delete-all) reply settles ONLY the delete-all marker, not a per-row delete still in flight', () => {
    get().deleteArchivedSession(B)
    get().deleteAllArchivedSessions()
    receive({ type: 'delete_archived_session_result', ok: true, deleted: 1 })
    expect(get().deletingAllArchives).toBe(false)
    expect([...get().deletingArchiveIds]).toEqual([B])
  })

  it('delete-all success clears the flag, drops every view, re-asks', () => {
    get().requestArchivedSessionHistory(A)
    get().deleteAllArchivedSessions()
    sent.length = 0
    receive({ type: 'delete_archived_session_result', ok: true, deleted: 2 })
    expect(get().deletingAllArchives).toBe(false)
    expect(views()).toEqual({})
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
  })

  it('a failure keeps the view and the row, records the error, and re-asks for the list', () => {
    get().requestArchivedSessionHistory(A)
    get().deleteArchivedSession(A)
    sent.length = 0
    receive({ type: 'delete_archived_session_result', ok: false, deleted: 0, archiveId: A, code: 'ARCHIVED_SESSION_DELETE_FAILED', message: 'disk' })
    expect(get().deletingArchiveIds.size).toBe(0)
    expect(views()[A]).toBeDefined()
    expect(get().archiveDeleteError).toEqual({ archiveId: A, code: 'ARCHIVED_SESSION_DELETE_FAILED', message: 'disk', refused: false })
    // The record may still exist: the fresh list is what shows what is left.
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
  })

  it('a PARTIAL delete-all keeps every view, shows a section-level error, then the list reply prunes only the records that went', () => {
    get().requestArchivedSessionHistory(A)
    get().requestArchivedSessionHistory(B)
    get().deleteAllArchivedSessions()
    sent.length = 0
    receive({ type: 'delete_archived_session_result', ok: false, deleted: 1, code: 'ARCHIVED_SESSIONS_DELETE_PARTIAL', message: '1 could not be removed' })

    expect(get().deletingAllArchives).toBe(false)
    // No view is dropped on a failure: either record may remain.
    expect(Object.keys(views()).sort()).toEqual([A, B])
    expect(get().archiveDeleteError).toEqual({ archiveId: undefined, code: 'ARCHIVED_SESSIONS_DELETE_PARTIAL', message: '1 could not be removed', refused: false })
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])

    // The server says only B is left.
    list([B])
    expect(Object.keys(views())).toEqual([B])
    expect(get().archiveDeleteError).not.toBeNull()
  })

  it('not-found means the record is gone: drop the view and re-ask', () => {
    get().requestArchivedSessionHistory(A)
    get().deleteArchivedSession(A)
    sent.length = 0
    receive({ type: 'delete_archived_session_result', ok: false, deleted: 0, archiveId: A, code: 'ARCHIVED_SESSION_NOT_FOUND' })
    expect(views()[A]).toBeUndefined()
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
  })

  it('a refusal is recorded as refused and nothing is dropped', () => {
    get().deleteAllArchivedSessions()
    receive({ type: 'delete_archived_session_result', ok: false, deleted: 0, refused: true, code: 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT' })
    expect(get().deletingAllArchives).toBe(false)
    expect(get().archiveDeleteError).toMatchObject({ refused: true })
    expect(sent.some((m) => m.type === 'list_archived_sessions')).toBe(false)
  })

  it('the next delete clears the previous error', () => {
    useConnectionStore.setState({ archiveDeleteError: { code: 'X' } } as unknown as Partial<State>)
    get().deleteArchivedSession(A)
    expect(get().archiveDeleteError).toBeNull()
  })
})

describe('daemon lifetime', () => {
  const populate = () => {
    get().requestArchivedSessions()
    list([A])
    get().requestArchivedSessionHistory(A)
    useConnectionStore.setState({ archiveDeleteError: { code: 'X' } } as unknown as Partial<State>)
  }

  it('forgetSession (a different daemon) clears the archive state', () => {
    populate()
    get().forgetSession()
    expect(get().archivedSessions).toBeNull()
    expect(views()).toEqual({})
    expect(get().archiveDeleteError).toBeNull()
  })

  it('_resetSessionMemory (the server switch from an already-disconnected tab) clears the archive state', () => {
    // A failed connect rests at `disconnected`, so a server switch reaches
    // `_resetSessionMemory()` ALONE: without these lines daemon A's archived
    // sessions (absolute cwds, session names, open transcripts) show as daemon B's.
    populate()
    get()._resetSessionMemory()
    expect(get().archivedSessions).toBeNull()
    expect(views()).toEqual({})
    expect(get().archiveDeleteError).toBeNull()
  })

  it('disconnect clears the archive state and the delete markers', () => {
    populate()
    get().deleteArchivedSession(A)
    get().deleteAllArchivedSessions()
    get().disconnect()
    expect(get().archivedSessions).toBeNull()
    expect(views()).toEqual({})
    expect(get().archiveDeleteError).toBeNull()
    expect(get().deletingArchiveIds.size).toBe(0)
    expect(get().deletingAllArchives).toBe(false)
    expect(get().archivedSessionsLoading).toBe(false)
  })
})
