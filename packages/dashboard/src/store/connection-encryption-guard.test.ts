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

  it('still accepts cleartext handshake frames when encryption is active', async () => {
    const socket = await openConnected()
    establishEncryption()
    // Null the pending keypair so the key_exchange_ok handler early-returns —
    // the assertion is purely that the GUARD did not tear the socket down.
    setPendingKeyPair(null)

    socket.onmessage!({ data: JSON.stringify({ type: 'key_exchange_ok', publicKey: 'x' }) })
    expect(socket.closed).toBe(0)
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
