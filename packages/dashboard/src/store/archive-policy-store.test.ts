/**
 * Session archive policy (#8869) — the store setter and its reply, driven through
 * the REAL store and message handler. Each claim has a control.
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

const get = () => useConnectionStore.getState()
const ctx = () => ({ url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false })
const receive = (msg: Record<string, unknown>) => handleMessage(msg as never, ctx() as never)
const policy = { enabled: true, maxEntries: 200, maxAgeDays: 30, maxMegabytes: 256 }
const next = { enabled: false, maxEntries: 50, maxAgeDays: 7, maxMegabytes: 64 }
let sent: Array<Record<string, unknown>>

const snapshot = (over: Record<string, unknown> = {}) => ({
  type: 'archived_sessions_list', generatedAt: 'x', policy, sessions: [], ...over,
})

function resetSlice(socket: unknown = null) {
  useConnectionStore.setState({
    archivedSessions: null,
    archivedSessionsLoading: false,
    sessionArchivePolicySaving: false,
    sessionArchivePolicyError: null,
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
  resetSlice({ readyState: WebSocket.OPEN, send: (d: string) => { sent.push(JSON.parse(d)) }, close: vi.fn() })
})
afterEach(() => { stopHeartbeat(); resetSlice() })

describe('setSessionArchivePolicy', () => {
  it('sends the WHOLE policy with a requestId, marks saving, and omits purge by default', () => {
    const id = get().setSessionArchivePolicy(next)
    expect(id).toMatch(/^archive-policy-/)
    expect(sent).toEqual([{ type: 'set_session_archive_policy', ...next, requestId: id }])
    expect(get().sessionArchivePolicySaving).toBe(true)
  })

  it('sends purge:true only when asked', () => {
    get().setSessionArchivePolicy(next, { purge: true })
    expect(sent[0]!.purge).toBe(true)
    sent.length = 0
    resetSlice(get().socket)
    get().setSessionArchivePolicy(next, { purge: false })
    expect('purge' in sent[0]!).toBe(false)
  })

  it('refuses a second save while one is in flight, and does nothing without a socket', () => {
    get().setSessionArchivePolicy(next)
    expect(get().setSessionArchivePolicy(next)).toBeNull()
    expect(sent).toHaveLength(1)
    resetSlice(null)
    expect(get().setSessionArchivePolicy(next)).toBeNull()
    expect(get().sessionArchivePolicySaving).toBe(false)
  })

  it('clears the previous error when a new save starts', () => {
    useConnectionStore.setState({ sessionArchivePolicyError: { code: 'X' } } as unknown as Partial<State>)
    get().setSessionArchivePolicy(next)
    expect(get().sessionArchivePolicyError).toBeNull()
  })
})

describe('session_archive_policy_result', () => {
  const asked = () => { receive(snapshot()); get().setSessionArchivePolicy(next); sent.length = 0 }

  it('ok: writes the daemon policy into the snapshot, settles saving, and re-asks for the list', () => {
    asked()
    receive({ type: 'session_archive_policy_result', ok: true, policy: next })
    expect(get().archivedSessions?.policy).toEqual(next)
    expect(get().sessionArchivePolicySaving).toBe(false)
    expect(get().sessionArchivePolicyError).toBeNull()
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
  })

  it('a PARTIAL purge records the error AND still applies the policy that stood', () => {
    asked()
    receive({ type: 'session_archive_policy_result', ok: false, policy: next, deleted: 2, code: 'SESSION_ARCHIVE_PURGE_PARTIAL', message: 'one stayed' })
    expect(get().archivedSessions?.policy).toEqual(next)
    expect(get().sessionArchivePolicyError).toMatchObject({ code: 'SESSION_ARCHIVE_PURGE_PARTIAL', message: 'one stayed' })
    expect(sent).toEqual([{ type: 'list_archived_sessions' }])
  })

  it('invalid / persist-failed: keeps the old policy, records the error, does not re-ask', () => {
    asked()
    receive({ type: 'session_archive_policy_result', ok: false, code: 'SESSION_ARCHIVE_POLICY_PERSIST_FAILED', message: 'disk' })
    expect(get().archivedSessions?.policy).toEqual(policy)
    expect(get().sessionArchivePolicySaving).toBe(false)
    expect(get().sessionArchivePolicyError).toMatchObject({ code: 'SESSION_ARCHIVE_POLICY_PERSIST_FAILED', message: 'disk' })
    expect(sent).toEqual([])
  })

  it('a refusal settles saving (Save must not stay disabled), records refused, and does not re-ask', () => {
    asked()
    receive({ type: 'session_archive_policy_result', ok: false, refused: true, code: 'SESSION_ARCHIVE_POLICY_FORBIDDEN_BOUND_CLIENT' })
    expect(get().sessionArchivePolicySaving).toBe(false)
    expect(get().sessionArchivePolicyError).toMatchObject({ refused: true })
    expect(sent).toEqual([])
  })
})

describe('daemon lifetime', () => {
  const populate = () => {
    receive(snapshot())
    get().setSessionArchivePolicy(next)
    useConnectionStore.setState({ sessionArchivePolicyError: { code: 'X' } } as unknown as Partial<State>)
  }
  it('disconnect clears the saving marker and the error', () => {
    populate()
    get().disconnect()
    expect(get().sessionArchivePolicySaving).toBe(false)
    expect(get().sessionArchivePolicyError).toBeNull()
  })
  it('forgetSession clears the error', () => {
    populate()
    get().forgetSession()
    expect(get().sessionArchivePolicyError).toBeNull()
  })
  it('_resetSessionMemory clears the error', () => {
    populate()
    get()._resetSessionMemory()
    expect(get().sessionArchivePolicyError).toBeNull()
  })
})
