/**
 * Dispatch test for the `billing_canary` handler (#5821).
 *
 * Locks the store-update behavior: a billing_canary broadcast stores the
 * snapshot, and the per-connection banner dismissal resets ONLY when the
 * warning set changes — so an unchanged re-broadcast can't un-dismiss a banner
 * the user already dismissed, but a new/cleared warning re-surfaces it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import {
  handleMessage,
  setStore,
  setConnectionContext,
  stopHeartbeat,
} from './message-handler'
import type { ConnectionState } from './types'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (
      s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>),
    ) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function baseState(): Partial<ConnectionState> {
  const serverErrors: unknown[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectedClients: [],
    serverErrors,
    addServerError: (e: unknown) => { serverErrors.push(e) },
    appendTerminalData: () => undefined,
    serverProtocolVersion: null,
    billingCanary: null,
    billingBannerDismissed: false,
  } as unknown as Partial<ConnectionState>
}

const meteredMsg = {
  type: 'billing_canary',
  eraStarted: true,
  defaultProvider: 'claude-sdk',
  defaultBillingClass: 'programmatic-credit',
  warnings: [{ code: 'SILENT_METERED_DEFAULT', message: 'metered', provider: 'claude-sdk' }],
}

describe('dashboard message-handler — billing_canary (#5821)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
    setConnectionContext(ctx() as any)
  })

  afterEach(() => {
    stopHeartbeat()
    setConnectionContext(null)
  })

  it('stores the snapshot from a billing_canary broadcast', () => {
    handleMessage(meteredMsg, ctx() as any)
    const bc = store.getState().billingCanary!
    expect(bc.defaultProvider).toBe('claude-sdk')
    expect(bc.warnings).toHaveLength(1)
    expect(bc.warnings[0]!.code).toBe('SILENT_METERED_DEFAULT')
  })

  it('drops a malformed payload (safeParse) without crashing', () => {
    handleMessage({ type: 'billing_canary', warnings: 'nope' }, ctx() as any)
    expect(store.getState().billingCanary).toBeNull()
  })

  it('does NOT un-dismiss the banner on an unchanged re-broadcast', () => {
    handleMessage(meteredMsg, ctx() as any)
    store.setState({ billingBannerDismissed: true }) // user dismisses
    handleMessage(meteredMsg, ctx() as any) // identical warning set
    expect(store.getState().billingBannerDismissed).toBe(true)
  })

  it('re-surfaces the banner when the warning set changes', () => {
    handleMessage(meteredMsg, ctx() as any)
    store.setState({ billingBannerDismissed: true })
    handleMessage(
      { ...meteredMsg, warnings: [{ code: 'TUI_REPORTED_PROGRAMMATIC_COST', message: 'cost', sessionId: 's1', costUsd: 1 }] },
      ctx() as any,
    )
    expect(store.getState().billingBannerDismissed).toBe(false)
  })

  it('clears warnings (all-clear broadcast) and re-surfaces (set changed)', () => {
    handleMessage(meteredMsg, ctx() as any)
    store.setState({ billingBannerDismissed: true })
    handleMessage({ ...meteredMsg, warnings: [] }, ctx() as any)
    expect(store.getState().billingCanary!.warnings).toHaveLength(0)
    expect(store.getState().billingBannerDismissed).toBe(false)
  })
})
