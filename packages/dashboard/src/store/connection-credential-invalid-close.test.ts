/**
 * A server that ends a connection because the pairing token it authenticated
 * with is no longer valid sends an authenticated `credential_invalidated` notice
 * and then closes with 4401. The close code alone (forgeable on a plain ws://
 * link) only stops auto-reconnect; the notice is what forgets the credential.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// The literal the server sends (ws-server.js WS_CLOSE_CREDENTIAL_INVALID).
const WS_CLOSE_CREDENTIAL_INVALID = 4401

const lsStore: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v },
    removeItem: (k: string) => { delete lsStore[k] },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
    get length() { return Object.keys(lsStore).length },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
  },
  writable: true,
})
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send() {}
  close() { this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) })

const { useConnectionStore } = await import('./connection')
const { resetReconnectAttempt, handleMessage, setEncryptionState } = await import('./message-handler')

const URL_A = 'wss://server-a.example.com/ws'
const URL_B = 'wss://server-b.example.com/ws'

async function connectToA(authenticate = true): Promise<{ socket: MockWebSocket; serverId: string }> {
  const s = useConnectionStore.getState()
  const a = s.addServer('A', URL_A, 'tok-a')
  vi.advanceTimersByTime(5) // ids are time + random based; both are frozen here
  s.addServer('B', URL_B, 'tok-b')
  useConnectionStore.setState({ activeServerId: a.id, savedConnection: { url: URL_A, token: 'tok-a' } })
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(URL_A, 'tok-a')
  await vi.advanceTimersByTimeAsync(0)
  const socket = MockWebSocket.instances[before]!
  socket.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  if (authenticate) {
    // A real auth_ok through the production onmessage path.
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
  }
  return { socket, serverId: a.id }
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(okFetch)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useConnectionStore.setState({
    serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected',
    wsUrl: null, userDisconnected: false, connectionError: null, savedConnection: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const frame = (socket: MockWebSocket, msg: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(msg) })

describe('close code 4401 alone (not authenticated evidence)', () => {
  it('control: an ordinary drop reconnects with the saved credential', async () => {
    const { socket } = await connectToA()
    const before = MockWebSocket.instances.length
    socket.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(MockWebSocket.instances.length).toBeGreaterThan(before)
  })

  it('stops reconnecting, shows the pair-again copy, and erases nothing', async () => {
    const { socket, serverId } = await connectToA()
    const before = MockWebSocket.instances.length
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockWebSocket.instances.length).toBe(before)
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).toBe('disconnected')
    expect(s.connectionError).toMatch(/pair it again/i)
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
    expect(s.savedConnection).toEqual({ url: URL_A, token: 'tok-a' })
  })

  it('does not reconnect when an error armed the retry before the close arrived', async () => {
    const { socket } = await connectToA()
    const before = MockWebSocket.instances.length
    socket.onerror?.()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockWebSocket.instances.length).toBe(before)
    expect(useConnectionStore.getState().connectionPhase).toBe('disconnected')
  })

  it('a 4401 on a connection that never authenticated changes nothing durable', async () => {
    const { socket, serverId } = await connectToA(false)
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    const s = useConnectionStore.getState()
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
    expect(s.savedConnection).toEqual({ url: URL_A, token: 'tok-a' })
  })
})

// An ENCRYPTED frame is the authenticated evidence: the production transport hands
// handleMessage `encryptedFrame = true` only after decrypting under the session key.
const encryptedNotice = (reason: string) => handleMessage({ type: 'credential_invalidated', reason }, undefined, true)

describe('the credential_invalidated notice', () => {
  it('an encrypted notice forgets the credential of that server entry only, and does not reconnect', async () => {
    const { socket, serverId } = await connectToA()
    const before = MockWebSocket.instances.length
    encryptedNotice('revoked')
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    await vi.advanceTimersByTimeAsync(120_000)
    const s = useConnectionStore.getState()
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('')
    expect(s.serverRegistry.find((e) => e.wsUrl === URL_B)?.token).toBe('tok-b')
    expect(s.savedConnection).toBeNull()
    expect(s.connectionPhase).toBe('disconnected')
    expect(s.connectionError).toMatch(/pair it again/i)
    expect(MockWebSocket.instances.length).toBe(before)
  })

  it('the close that follows still runs the connection teardown', async () => {
    const { socket } = await connectToA()
    expect(useConnectionStore.getState().socket).not.toBeNull()
    encryptedNotice('expired')
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    expect(useConnectionStore.getState().socket).toBeNull()
  })

  it('an accepted notice closes the socket', async () => {
    const { socket } = await connectToA()
    expect(socket.readyState).toBe(1)
    encryptedNotice('revoked')
    expect(socket.readyState).toBe(3)
  })

  it('a notice that does not forget still marks the token suspect, so a later invalid_token erases it', async () => {
    const { serverId } = await connectToA()
    encryptedNotice('destroyed')
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
    const before = MockWebSocket.instances.length
    useConnectionStore.getState().connect(URL_A, 'tok-a')
    await vi.advanceTimersByTimeAsync(0)
    const next = MockWebSocket.instances[before]!
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    frame(next, { type: 'auth_fail', reason: 'invalid_token' })
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('')
  })

  it('does not blank a server entry that was re-paired since this connection began', async () => {
    const { serverId } = await connectToA()
    useConnectionStore.getState().updateServer(serverId, { token: 'tok-new' })
    encryptedNotice('revoked')
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-new')
  })

  it('does not reconnect after notice then error', async () => {
    const { socket } = await connectToA()
    const before = MockWebSocket.instances.length
    encryptedNotice('expired')
    socket.onerror?.()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockWebSocket.instances.length).toBe(before)
  })

  it.each(['destroyed', 'invalid', 'something-new'])('an encrypted notice with reason %s stops reconnecting but erases nothing', async (reason) => {
    const { serverId } = await connectToA()
    encryptedNotice(reason)
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).toBe('disconnected')
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
    expect(s.savedConnection).toEqual({ url: URL_A, token: 'tok-a' })
  })

  it('a plaintext notice before auth_ok is dropped: nothing erased, still connecting', async () => {
    const { socket, serverId } = await connectToA(false)
    frame(socket, { type: 'credential_invalidated', reason: 'revoked' })
    const s = useConnectionStore.getState()
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
    expect(s.savedConnection).toEqual({ url: URL_A, token: 'tok-a' })
    expect(s.connectionPhase).not.toBe('disconnected')
  })

  it('a plaintext notice while encryption is in use is dropped', async () => {
    const { serverId } = await connectToA()
    setEncryptionState({ sharedKey: new Uint8Array(32), sendNonce: 0, recvNonce: 0 })
    try {
      handleMessage({ type: 'credential_invalidated', reason: 'revoked' }, undefined, false)
    } finally {
      setEncryptionState(null)
    }
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).toBe('connected')
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
  })

  it('a plaintext notice on an authenticated unencrypted connection only stops reconnecting', async () => {
    const { socket, serverId } = await connectToA()
    frame(socket, { type: 'credential_invalidated', reason: 'revoked' })
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).toBe('disconnected')
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
    expect(s.savedConnection).toEqual({ url: URL_A, token: 'tok-a' })
  })

  it('does not clear a saved connection that belongs to a different server', async () => {
    const { serverId } = await connectToA()
    useConnectionStore.setState({ savedConnection: { url: URL_B, token: 'tok-b' } })
    encryptedNotice('revoked')
    const s = useConnectionStore.getState()
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('')
    expect(s.savedConnection).toEqual({ url: URL_B, token: 'tok-b' })
  })
})

describe('an auth_fail on a later attempt', () => {
  async function laterAttempt(): Promise<MockWebSocket> {
    const before = MockWebSocket.instances.length
    useConnectionStore.getState().connect(URL_A, 'tok-a')
    await vi.advanceTimersByTimeAsync(0)
    const next = MockWebSocket.instances[before]!
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    return next
  }

  it('invalid_token for the token a bare 4401 ended on forgets it', async () => {
    const { socket, serverId } = await connectToA()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    const next = await laterAttempt()
    frame(next, { type: 'auth_fail', reason: 'invalid_token' })
    const s = useConnectionStore.getState()
    expect(s.serverRegistry.find((e) => e.id === serverId)?.token).toBe('')
    expect(s.serverRegistry.find((e) => e.wsUrl === URL_B)?.token).toBe('tok-b')
  })

  it('another server signing in does not clear the suspect token', async () => {
    const { socket, serverId } = await connectToA()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    // Server B connects and authenticates.
    const beforeB = MockWebSocket.instances.length
    useConnectionStore.getState().connect(URL_B, 'tok-b')
    await vi.advanceTimersByTimeAsync(0)
    const b = MockWebSocket.instances[beforeB]!
    b.onopen?.()
    b.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
    // Back to A: its token is refused outright.
    const next = await laterAttempt()
    frame(next, { type: 'auth_fail', reason: 'invalid_token' })
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('')
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.wsUrl === URL_B)?.token).toBe('tok-b')
  })

  it('invalid_token with no preceding authenticated drop erases nothing', async () => {
    const { serverId } = await connectToA()
    useConnectionStore.setState({ connectionPhase: 'disconnected' })
    const next = await laterAttempt()
    frame(next, { type: 'auth_fail', reason: 'invalid_token' })
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
  })

  it('signing in again clears the suspect token, so a later invalid_token erases nothing', async () => {
    const { socket, serverId } = await connectToA()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    const ok = await laterAttempt()
    frame(ok, { type: 'auth_ok', serverMode: 'cli' })
    await vi.advanceTimersByTimeAsync(0)
    const again = await laterAttempt()
    frame(again, { type: 'auth_fail', reason: 'invalid_token' })
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
  })

  it('a 4401 on a connection that never authenticated does not make a later invalid_token erase', async () => {
    const { socket, serverId } = await connectToA(false)
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    const next = await laterAttempt()
    frame(next, { type: 'auth_fail', reason: 'invalid_token' })
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
  })

  it('a different failure reason after a bare 4401 erases nothing', async () => {
    const { socket, serverId } = await connectToA()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    const next = await laterAttempt()
    frame(next, { type: 'auth_fail', reason: 'rate_limited' })
    expect(useConnectionStore.getState().serverRegistry.find((e) => e.id === serverId)?.token).toBe('tok-a')
  })
})
