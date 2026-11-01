/**
 * #8866 — continue an archived session (dashboard store), through the REAL
 * store and the REAL message handler.
 *
 * Claims:
 *   - restoreArchivedSession sends exactly one frame per record and marks it
 *     pending; a second click while pending sends nothing;
 *   - a reply settles the marker on EVERY outcome (a refusal included) and
 *     records what happened beside the row;
 *   - a success switches to the session it names, re-asks for the roster, and a
 *     failure does not switch;
 *   - a socket drop clears the pending marker (its reply can never arrive).
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
const { createEmptyInFlightMarkers } = await import('./utils')

type State = ReturnType<typeof useConnectionStore.getState>

const A = 'arch-aaaa'
const get = () => useConnectionStore.getState()
let sent: Array<Record<string, unknown>>
const ctx = () => ({ url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false })
const receive = (msg: Record<string, unknown>) => handleMessage(msg as never, ctx() as never)
const result = (over: Record<string, unknown> = {}) =>
  receive({ type: 'restore_archived_session_result', archiveId: A, mode: 'native', ok: true, sessionId: 'live-1', ...over })

beforeEach(() => {
  clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
  sent = []
  const socket = { readyState: WebSocket.OPEN, send: (d: string) => { sent.push(JSON.parse(d)) }, close: vi.fn() }
  useConnectionStore.setState({
    archivedSessions: null,
    archivedSessionsLoading: false,
    restoringArchiveIds: new Set<string>(),
    archiveRestoreResults: {},
    sessions: [{ sessionId: 'live-1', name: 'S', cwd: '/w' }],
    activeSessionId: 'other',
    sessionStates: {},
    connectionPhase: 'connected',
    socket,
  } as unknown as Partial<State>)
})
afterEach(() => { stopHeartbeat() })

describe('restoreArchivedSession', () => {
  it('sends one restore_archived_session frame with the mode and marks the record pending', () => {
    expect(get().restoreArchivedSession(A, 'new_thread')).toBe(true)
    expect(sent).toEqual([{ type: 'restore_archived_session', archiveId: A, mode: 'new_thread' }])
    expect(get().restoringArchiveIds.has(A)).toBe(true)
  })

  it('a second click while pending sends nothing', () => {
    get().restoreArchivedSession(A, 'native')
    expect(get().restoreArchivedSession(A, 'new_thread')).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('sends nothing on a closed socket and marks nothing', () => {
    useConnectionStore.setState({ socket: null } as unknown as Partial<State>)
    expect(get().restoreArchivedSession(A, 'native')).toBe(false)
    expect(get().restoringArchiveIds.size).toBe(0)
  })

  it('drops the previous outcome when a new attempt starts', () => {
    useConnectionStore.setState({ archiveRestoreResults: { [A]: { ok: false, code: 'X' } } } as unknown as Partial<State>)
    get().restoreArchivedSession(A, 'native')
    expect(get().archiveRestoreResults[A]).toBeUndefined()
  })
})

describe('restore_archived_session_result', () => {
  it('success: settles the marker, records the outcome, re-asks for the roster and switches to the session', () => {
    get().restoreArchivedSession(A, 'native')
    sent.length = 0
    result()
    expect(get().restoringArchiveIds.has(A)).toBe(false)
    expect(get().archiveRestoreResults[A]).toMatchObject({ ok: true, mode: 'native', sessionId: 'live-1' })
    expect(sent).toContainEqual({ type: 'list_archived_sessions' })
    expect(sent.some((m) => m.type === 'switch_session' && m.sessionId === 'live-1')).toBe(true)
  })

  it('records the record\'s name from the roster as of the reply, so a status line can name a row that has since left', () => {
    useConnectionStore.setState({ archivedSessions: { sessions: [{ archiveId: A, name: 'Flag work' }] } } as unknown as Partial<State>)
    get().restoreArchivedSession(A, 'native')
    result()
    expect(get().archiveRestoreResults[A]?.name).toBe('Flag work')
  })

  it('a new thread outcome keeps the seed counts for the row to state', () => {
    get().restoreArchivedSession(A, 'new_thread')
    result({ mode: 'new_thread', seed: { messagesIncluded: 4, messagesTotal: 9, bytes: 100 } })
    expect(get().archiveRestoreResults[A]?.seed).toEqual({ messagesIncluded: 4, messagesTotal: 9, bytes: 100 })
  })

  it('failure: settles the marker, records the reason, and does NOT switch', () => {
    get().restoreArchivedSession(A, 'native')
    sent.length = 0
    result({ ok: false, sessionId: undefined, code: 'ARCHIVE_RESTORE_LOCATOR_MISSING', message: 'no transcript' })
    expect(get().restoringArchiveIds.has(A)).toBe(false)
    expect(get().archiveRestoreResults[A]).toMatchObject({ ok: false, code: 'ARCHIVE_RESTORE_LOCATOR_MISSING', message: 'no transcript' })
    expect(sent.some((m) => m.type === 'switch_session')).toBe(false)
  })

  it('a refusal settles the marker but does not re-ask for a list that would be refused too', () => {
    get().restoreArchivedSession(A, 'native')
    sent.length = 0
    result({ ok: false, refused: true, sessionId: undefined, code: 'ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT' })
    expect(get().restoringArchiveIds.has(A)).toBe(false)
    expect(get().archiveRestoreResults[A]?.refused).toBe(true)
    expect(sent).toEqual([])
  })

  it('a reply naming no archive is ignored rather than writing under an empty key', () => {
    get().restoreArchivedSession(A, 'native')
    result({ archiveId: '' })
    expect(get().restoringArchiveIds.has(A)).toBe(true)
    expect(get().archiveRestoreResults['']).toBeUndefined()
  })
})

describe('socket scoping', () => {
  it('the pending marker is part of the in-flight roster, so a socket drop clears it', () => {
    expect(Object.keys(createEmptyInFlightMarkers())).toContain('restoringArchiveIds')
  })
})
