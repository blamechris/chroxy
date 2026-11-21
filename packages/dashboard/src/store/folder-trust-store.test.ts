/**
 * Per-folder trust: the store actions and the two server frames, driven through
 * the REAL store and message handler.
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
let sent: Array<Record<string, unknown>>

const summary = {
  files: [{ path: '/p/.mcp.json' }], mcpServers: [], hooks: [], statusLine: [], enabledPlugins: [],
  counts: { agents: 0, skills: 0, commands: 0 }, warnings: [], hasCommandBearingFiles: true, untrustable: false,
}
const digest = 'b'.repeat(64)

function resetSlice(socket: unknown = null) {
  useConnectionStore.setState({
    folderTrust: {},
    folderTrustPending: {},
    folderTrustError: {},
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

describe('folder_trust_state', () => {
  it('is kept per session, replaced wholesale, and without its type or sessionId', () => {
    receive({ type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', summary, digest, appliesFrom: 'restart' })
    expect(get().folderTrust.s1).toEqual({ status: 'untrusted', summary, digest, appliesFrom: 'restart' })
    receive({ type: 'folder_trust_state', sessionId: 's1', status: 'trusted', summary, appliesFrom: 'restart' })
    expect(get().folderTrust.s1!.status).toBe('trusted')
    receive({ type: 'folder_trust_state', sessionId: 's2', status: 'untrusted', appliesFrom: 'next_turn' })
    expect(get().folderTrust.s2).toEqual({ status: 'untrusted', appliesFrom: 'next_turn' })
    expect(get().folderTrust.s1!.status).toBe('trusted')
  })

  it('a frame without a session id changes nothing', () => {
    receive({ type: 'folder_trust_state', status: 'trusted', appliesFrom: 'restart' })
    expect(get().folderTrust).toEqual({})
  })
})

describe('trustFolder / untrustFolder', () => {
  const reviewed = () => receive({ type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', summary, digest, appliesFrom: 'restart' })

  it('trust sends the session id and the REVIEWED digest, with a requestId, and marks the session pending', () => {
    reviewed()
    expect(get().trustFolder('s1')).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'trust_folder', sessionId: 's1', digest })
    expect(Object.keys(sent[0]!).sort()).toEqual(['digest', 'requestId', 'sessionId', 'type'])
    expect(get().folderTrustPending.s1).toBe(true)
  })

  it('trust is not sent without a reviewed digest (a bound client never saw one)', () => {
    receive({ type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', appliesFrom: 'restart' })
    expect(get().trustFolder('s1')).toBe(false)
    expect(get().trustFolder('unknown')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('untrust sends untrust_folder (no digest needed)', () => {
    expect(get().untrustFolder('s1')).toBe(true)
    expect(sent[0]).toMatchObject({ type: 'untrust_folder', sessionId: 's1' })
  })

  it('refuses a second change for the same session while one is in flight, and does nothing without a socket', () => {
    reviewed()
    get().trustFolder('s1')
    expect(get().trustFolder('s1')).toBe(false)
    expect(sent).toHaveLength(1)
    resetSlice(null)
    expect(get().trustFolder('s1')).toBe(false)
  })
})

describe('folder_trust_result', () => {
  it('settles the pending marker and clears the error on success', () => {
    get().trustFolder('s1')
    receive({ type: 'folder_trust_result', sessionId: 's1', ok: true, status: 'trusted' })
    expect(get().folderTrustPending.s1).toBeUndefined()
    expect(get().folderTrustError.s1).toBeUndefined()
  })

  it('settles the marker on a failure and keeps the reason; the next attempt clears it', () => {
    receive({ type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', summary, digest, appliesFrom: 'restart' })
    get().trustFolder('s1')
    receive({ type: 'folder_trust_result', sessionId: 's1', ok: false, status: 'untrusted', error: 'could not be saved' })
    expect(get().folderTrustPending.s1).toBeUndefined()
    expect(get().folderTrustError.s1).toBe('could not be saved')
    get().trustFolder('s1')
    expect(get().folderTrustError.s1).toBeUndefined()
  })

  it('an error envelope attaches to the session it names, and only that session', () => {
    receive({ type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', summary, digest, appliesFrom: 'restart' })
    receive({ type: 'folder_trust_state', sessionId: 's2', status: 'untrusted', summary, digest, appliesFrom: 'restart' })
    get().trustFolder('s1')
    get().trustFolder('s2')
    receive({ type: 'error', code: 'FOLDER_TRUST_CHANGED', message: 'The folder changed since it was reviewed', sessionId: 's1', requestId: 'x' })
    expect(get().folderTrustPending.s1).toBeUndefined()
    expect(get().folderTrustError.s1).toBe('The folder changed since it was reviewed')
    expect(get().folderTrustPending.s2).toBe(true)
    expect(get().folderTrustError.s2).toBeUndefined()
  })
})
