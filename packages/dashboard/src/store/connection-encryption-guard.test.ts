/**
 * #5632 — post-handshake plaintext guard (consensus C3 / Adversary F1), dashboard.
 *
 * Once E2E encryption is established, the socket.onmessage handler in
 * connection.ts must reject any non-`encrypted` frame that is not a permitted
 * cleartext handshake frame, failing closed on the same path a decrypt failure
 * takes (log + socket.close, no dispatch). Mirrors the app-side guard test.
 *
 * Harness mirrors connection-reconnect-backoff.test.ts (mock WebSocket + fetch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
  clear: () => { for (const k of Object.keys(store)) delete store[k] },
  get length() { return Object.keys(store).length },
  key: (i: number) => Object.keys(store)[i] ?? null,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  sent: string[] = []
  closed = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed += 1; this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore } = await import('./connection')
const { setEncryptionState, getEncryptionState, setPendingKeyPair } = await import('./message-handler')
const { createKeyPair, deriveSharedKey, encrypt, DIRECTION_SERVER } = await import('./crypto')

/** Open a connection and walk it through health check + WS construction. */
async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  if (!ws.onmessage) throw new Error('mock socket onmessage was not wired')
  return ws
}

/** Install a deterministic encryption state shared with a peer "server" key. */
function establishEncryption(): { serverShared: Uint8Array } {
  const clientKp = createKeyPair()
  const serverKp = createKeyPair()
  const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)
  const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
  setEncryptionState({ sharedKey: clientShared, sendNonce: 0, recvNonce: 0 })
  return { serverShared }
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  for (const k of Object.keys(store)) delete store[k]
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    userDisconnected: false,
    serverErrors: [],
  })
})

afterEach(() => {
  setEncryptionState(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#5632 post-handshake plaintext guard (dashboard)', () => {
  it('rejects a plaintext app frame received AFTER encryption is established', async () => {
    const socket = await openConnected()
    establishEncryption()

    expect(useConnectionStore.getState().serverErrors).toHaveLength(0)

    socket.onmessage!({ data: JSON.stringify({ type: 'server_error', error: 'pwned' }) })

    expect(socket.closed).toBe(1)
    expect(useConnectionStore.getState().serverErrors).toHaveLength(0)
  })

  it('still DISPATCHES cleartext terminal handshake frames (auth_fail) when encryption is active', async () => {
    const socket = await openConnected()
    establishEncryption()
    // Seed a non-null socket in the store so the handler's `set({ socket: null })`
    // is an observable side effect (the guard's reject path never nulls it).
    useConnectionStore.setState({ socket: socket as unknown as WebSocket, connectionPhase: 'connected' })

    // auth_fail is a terminal handshake frame the server may legitimately emit
    // cleartext — the guard must allow-list it so it reaches handleMessage. The
    // handler tears the connection down (connectionPhase → disconnected, socket →
    // null), which the guard's reject path never does — proving DISPATCH.
    socket.onmessage!({ data: JSON.stringify({ type: 'auth_fail', reason: 'token-expired' }) })

    expect(useConnectionStore.getState().connectionPhase).toBe('disconnected')
    expect(useConnectionStore.getState().socket).toBeNull()
  })

  it('DROPS a late plaintext auth_ok after encryption — no dispatch, socket stays open (#5632 Copilot)', async () => {
    const socket = await openConnected()
    establishEncryption()

    // Seed identity/UI state a re-entered handshake would clobber.
    useConnectionStore.setState({
      myClientId: 'client-real',
      connectedClients: [{ clientId: 'client-real', deviceName: 'real' } as never],
    })

    // A MITM injects a plaintext auth_ok AFTER encryption is established. It must
    // be DROPPED (logged + return) — not re-dispatched into the handshake state
    // machine — and the socket must stay OPEN.
    socket.onmessage!({
      data: JSON.stringify({ type: 'auth_ok', clientId: 'attacker', connectedClients: [] }),
    })

    expect(socket.closed).toBe(0)
    expect(useConnectionStore.getState().myClientId).toBe('client-real')
    expect(useConnectionStore.getState().connectedClients).toHaveLength(1)
  })

  it('DROPS a late plaintext key_exchange_ok after encryption — no dispatch, socket stays open (#5632 Copilot)', async () => {
    const socket = await openConnected()
    establishEncryption()
    // A re-key handler would run if dispatched. Keep a pending keypair set so the
    // handler WOULD have done work — proving the drop happened before dispatch.
    setPendingKeyPair(createKeyPair())
    const before = getEncryptionState()

    socket.onmessage!({ data: JSON.stringify({ type: 'key_exchange_ok', publicKey: 'attacker' }) })

    expect(socket.closed).toBe(0)
    // Encryption state untouched — the drop happened before any handler ran.
    expect(getEncryptionState()).toBe(before)
  })

  it('REJECTS a forged plaintext `error` frame after encryption (server now sends it encrypted) — closes socket', async () => {
    const socket = await openConnected()
    establishEncryption()

    // Since #5632 the server routes sendError() through the encrypting
    // transport, so a legitimate post-handshake `error` arrives as an
    // `encrypted` envelope. A plaintext `error` is therefore a forged/downgrade
    // frame and must be rejected + closed.
    socket.onmessage!({
      data: JSON.stringify({ type: 'error', code: 'INVALID_MODEL', message: 'pwned' }),
    })

    expect(socket.closed).toBe(1)
  })

  it('decrypts and dispatches a genuine encrypted frame when encryption is active', async () => {
    const socket = await openConnected()
    const { serverShared } = establishEncryption()

    const envelope = encrypt(
      JSON.stringify({ type: 'server_error', error: 'real' }),
      serverShared,
      0,
      DIRECTION_SERVER,
    )
    socket.onmessage!({ data: JSON.stringify(envelope) })

    expect(socket.closed).toBe(0)
    expect(useConnectionStore.getState().serverErrors.length).toBeGreaterThan(0)
    expect(getEncryptionState()?.recvNonce).toBe(1)
  })

  it('leaves plaintext-mode (encryption disabled) sessions unaffected', async () => {
    const socket = await openConnected()
    expect(getEncryptionState()).toBeNull()

    socket.onmessage!({ data: JSON.stringify({ type: 'server_error', error: 'plain' }) })

    expect(socket.closed).toBe(0)
    expect(useConnectionStore.getState().serverErrors.length).toBeGreaterThan(0)
  })
})
