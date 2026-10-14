/**
 * #5281 ③ PR 2 — connect()'s pairing-vs-auth handshake selection, and the
 * one-shot pairing-id lifecycle that prevents an armed id leaking into the next
 * connect. Exercises the real connect()→health-check→WebSocket→onopen path via
 * fetch + WebSocket mocks.
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
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore } = await import('./connection')
const { getEncryptionState, getConnectionContext, prepareEagerKeyExchange } = await import('./message-handler')
const { createKeyPair, createSigningKeyPair, signExchangeKey, encrypt, decrypt, DIRECTION_CLIENT, DIRECTION_SERVER } = await import('@chroxy/store-core/crypto')

/** Wait until a WebSocket for `urlPart` exists, then return it. */
async function socketFor(urlPart: string): Promise<MockWebSocket> {
  for (let i = 0; i < 50; i++) {
    const s = MockWebSocket.instances.find((w) => w.url.includes(urlPart))
    if (s) return s
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`no socket for ${urlPart}`)
}

function lastSent(ws: MockWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[ws.sent.length - 1]!)
}

beforeEach(() => {
  MockWebSocket.instances = []
  for (const k of Object.keys(store)) delete store[k]
  useConnectionStore.setState({ serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected', wsUrl: null })
})

describe('connect pairing handshake (#5281 ③ PR 2)', () => {
  it('sends {type:pair} on open when started via pairServer', async () => {
    useConnectionStore.getState().pairServer('LAN', 'ws://192.168.1.50:8765/ws', 'PAIR-1')
    const ws = await socketFor('192.168.1.50')
    ws.onopen?.()
    const frame = lastSent(ws)
    expect(frame.type).toBe('pair')
    expect(frame.pairingId).toBe('PAIR-1')
    expect(frame.token).toBeUndefined()
  })

  it('does NOT leak an armed pairing id into a later, unrelated connect', async () => {
    // Arm + start a pairing connect (consumes the one-shot id into ITS closure).
    useConnectionStore.getState().pairServer('LAN', 'ws://192.168.1.50:8765/ws', 'PAIR-1')
    // Now switch to a normal token server before the pairing socket is used.
    const other = useConnectionStore.getState().addServer('Remote', 'wss://remote.example.com/ws', 'real-token')
    useConnectionStore.getState().switchServer(other.id)

    const ws = await socketFor('remote.example.com')
    ws.onopen?.()
    const frame = lastSent(ws)
    // Must authenticate normally — the pairing id belonged to the first connect.
    expect(frame.type).toBe('auth')
    expect(frame.token).toBe('real-token')
    expect(frame.pairingId).toBeUndefined()
  })

  it('a normal switchServer connect sends {type:auth} with its token', async () => {
    const srv = useConnectionStore.getState().addServer('Remote', 'wss://remote.example.com/ws', 'real-token')
    useConnectionStore.getState().switchServer(srv.id)
    const ws = await socketFor('remote.example.com')
    ws.onopen?.()
    const frame = lastSent(ws)
    expect(frame.type).toBe('auth')
    expect(frame.token).toBe('real-token')
  })
})

it('waits for the post-auth credential before writing the paired registry and saved connection', async () => {
  useConnectionStore.getState().pairServer('LAN', 'ws://192.168.1.50:8765/ws', 'PAIR-1')
  const ws = await socketFor('192.168.1.50')
  ws.onopen?.()
  const serverId = useConnectionStore.getState().activeServerId
  ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', encryption: 'disabled',
    sessionToken: 'fixture-issued-token', capabilities: { pairedCredentialConfirmation: true } }) })
  expect(useConnectionStore.getState().apiToken).toBe('')
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === serverId)?.token).toBe('')
  expect(useConnectionStore.getState().savedConnection?.token).not.toBe('fixture-issued-token')
  ws.onmessage?.({ data: JSON.stringify({ type: 'auth_bootstrap', sessionToken: 'fixture-issued-token' }) })
  expect(useConnectionStore.getState().apiToken).toBe('fixture-issued-token')
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === serverId)?.token).toBe('fixture-issued-token')
  expect(useConnectionStore.getState().savedConnection?.token).toBe('fixture-issued-token')
  useConnectionStore.getState().disconnect()
})

afterEach(() => { useConnectionStore.getState().disconnect() })

function receive(ws: MockWebSocket, message: Record<string, unknown>) {
  ws.onmessage?.({ data: JSON.stringify(message) })
}
function receiveEncrypted(ws: MockWebSocket, message: Record<string, unknown>) {
  const state = getEncryptionState()!
  receive(ws, encrypt(JSON.stringify(message), state.sharedKey, state.recvNonce, DIRECTION_SERVER) as unknown as Record<string, unknown>)
}

it.each(['eager', 'discrete'])('settles a paired credential after the %s encrypted handshake', async (path) => {
  const identity = createSigningKeyPair()
  const exchange = createKeyPair()
  const signature = signExchangeKey(exchange.publicKey, identity.secretKey, { domainSeparated: true })
  useConnectionStore.getState().pairServer('Remote', 'wss://paired.example.test/ws', 'PAIR-1', identity.publicKey)
  const ws = await socketFor('paired.example.test')
  ws.onopen?.()
  const serverId = useConnectionStore.getState().activeServerId
  if (path === 'eager') prepareEagerKeyExchange()
  receive(ws, { type: 'auth_ok', encryption: 'required', capabilities: { pairedCredentialConfirmation: true },
    ...(path === 'eager' ? { serverPublicKey: exchange.publicKey, serverKeySig: signature } : {}) })
  expect(getConnectionContext()?.token).toBe('')
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === serverId)?.token).toBe('')
  if (path === 'discrete') {
    receive(ws, { type: 'auth_bootstrap', sessionToken: 'fixture-issued-token' })
    expect(useConnectionStore.getState().savedConnection?.token).not.toBe('fixture-issued-token')
    receive(ws, { type: 'key_exchange_ok', publicKey: exchange.publicKey, serverKeySig: signature })
  }
  expect(getEncryptionState()).not.toBeNull()
  expect(useConnectionStore.getState().apiToken).toBe('')
  receiveEncrypted(ws, { type: 'auth_bootstrap', sessionToken: 'fixture-issued-token' })
  expect(getConnectionContext()?.token).toBe('fixture-issued-token')
  expect(useConnectionStore.getState().apiToken).toBe('fixture-issued-token')
  expect(useConnectionStore.getState().savedConnection?.token).toBe('fixture-issued-token')
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === serverId)?.token).toBe('fixture-issued-token')
  receiveEncrypted(ws, { type: 'auth_bootstrap', sessionToken: 'fixture-later' })
  expect(getConnectionContext()?.token).toBe('fixture-issued-token')
})

it('refuses older-peer pairing without credential writes', async () => {
  useConnectionStore.getState().pairServer('Remote', 'wss://paired.example.test/ws', 'PAIR-1')
  const ws = await socketFor('paired.example.test')
  ws.onopen?.()
  receive(ws, { type: 'auth_ok', encryption: 'disabled', sessionToken: 'fixture-issued-token' })
  expect(ws.readyState).toBe(3)
  expect(useConnectionStore.getState().apiToken).not.toBe('fixture-issued-token')
  expect(useConnectionStore.getState().savedConnection?.token).not.toBe('fixture-issued-token')
  expect(useConnectionStore.getState().serverRegistry[0]?.token).toBe('')
})

it('identity refusal leaves the paired credential unpersisted', async () => {
  const identity = createSigningKeyPair()
  useConnectionStore.getState().pairServer('Remote', 'wss://paired.example.test/ws', 'PAIR-1', identity.publicKey)
  const ws = await socketFor('paired.example.test')
  ws.onopen?.()
  receive(ws, { type: 'auth_ok', encryption: 'disabled', capabilities: { pairedCredentialConfirmation: true } })
  receive(ws, { type: 'auth_bootstrap', sessionToken: 'fixture-issued-token' })
  expect(ws.readyState).toBe(3)
  expect(useConnectionStore.getState().serverRegistry[0]?.token).toBe('')
  expect(useConnectionStore.getState().savedConnection?.token).not.toBe('fixture-issued-token')
})

it('updates admitted rotation details together for a registry socket', async () => {
  const entry = useConnectionStore.getState().addServer('Remote', 'wss://rotate.example.test/ws', 'fixture-original');
  useConnectionStore.getState().connectToServer(entry.id);
  const ws = await socketFor('rotate.example.test');
  ws.onopen?.();
  receive(ws, { type: 'auth_ok', encryption: 'disabled' });
  receive(ws, { type: 'token_rotated', token: 'fixture-updated' });
  expect(getConnectionContext()?.token).toBe('fixture-updated');
  expect(useConnectionStore.getState().apiToken).toBe('fixture-updated');
  expect(useConnectionStore.getState().savedConnection?.token).toBe('fixture-updated');
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === entry.id)?.token).toBe('fixture-updated');
});

it('publishes connected only after discrete credential admission', async () => {
  useConnectionStore.getState().pairServer('Remote', 'wss://ready.example.test/ws', 'PAIR-1');
  const ws = await socketFor('ready.example.test');
  ws.onopen?.();
  receive(ws, { type: 'auth_ok', encryption: 'required', capabilities: { pairedCredentialConfirmation: true } });
  expect(useConnectionStore.getState().connectionPhase).not.toBe('connected');
  expect(useConnectionStore.getState().socket).toBeNull();
  useConnectionStore.getState().fetchConversationHistory();
  expect(ws.sent.map(raw => JSON.parse(raw).type)).not.toContain('list_conversations');
  const exchange = createKeyPair();
  receive(ws, { type: 'key_exchange_ok', publicKey: exchange.publicKey });
  expect(useConnectionStore.getState().connectionPhase).not.toBe('connected');
  expect(useConnectionStore.getState().socket).toBeNull();
  receiveEncrypted(ws, { type: 'auth_bootstrap', credentialConfirmation: true, sessionToken: 'fixture-issued' });
  expect(useConnectionStore.getState().connectionPhase).toBe('connected');
  useConnectionStore.getState().fetchConversationHistory();
  const envelope = JSON.parse(ws.sent[ws.sent.length - 1]!);
  expect(envelope.type).toBe('encrypted');
  expect(decrypt(envelope, getEncryptionState()!.sharedKey, envelope.n, DIRECTION_CLIENT).type).toBe('list_conversations');
});

it.each([false, true])('automatic reconnect uses the admitted rotation for registry=%s', async (registry) => {
  const url = registry ? 'wss://scheduled.example.test/ws' : 'ws://localhost:8765/ws';
  let serverId: string | null = null;
  if (registry) {
    const entry = useConnectionStore.getState().addServer('Remote', url, 'fixture-original');
    serverId = entry.id;
    useConnectionStore.getState().connectToServer(entry.id);
  } else {
    useConnectionStore.getState().connect(url, 'fixture-original');
  }
  const ws = await socketFor(registry ? 'scheduled.example.test' : 'localhost');
  ws.onopen?.();
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  try {
    receive(ws, { type: 'auth_ok', encryption: 'disabled' });
    receive(ws, { type: 'token_rotated', token: 'fixture-updated' });
    expect(useConnectionStore.getState().savedConnection?.token).toBe('fixture-updated');
    if (serverId) expect(useConnectionStore.getState().serverRegistry.find(s => s.id === serverId)?.token).toBe('fixture-updated');
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const next = MockWebSocket.instances[1]!;
    next.onopen?.();
    expect(JSON.parse(next.sent[0]!).token).toBe('fixture-updated');
  } finally {
    useConnectionStore.getState().disconnect();
    random.mockRestore();
    vi.useRealTimers();
  }
});

it('keeps a superseded socket from changing the current owned credentials', async () => {
  const original = useConnectionStore.getState().addServer('Original', 'wss://original.example.test/ws', 'fixture-original');
  useConnectionStore.getState().connectToServer(original.id);
  const old = await socketFor('original.example.test');
  old.onopen?.();
  receive(old, { type: 'auth_ok', encryption: 'disabled' });
  const callback = old.onmessage;
  const current = useConnectionStore.getState().addServer('Current', 'wss://current.example.test/ws', 'fixture-current');
  useConnectionStore.getState().connectToServer(current.id);
  const socket = await socketFor('current.example.test');
  socket.onopen?.();
  receive(socket, { type: 'auth_ok', encryption: 'disabled' });
  callback?.({ data: JSON.stringify({ type: 'token_rotated', token: 'fixture-later-original' }) });
  expect(useConnectionStore.getState().apiToken).toBe('fixture-current');
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === original.id)?.token).toBe('fixture-original');
  expect(useConnectionStore.getState().serverRegistry.find(s => s.id === current.id)?.token).toBe('fixture-current');
});
