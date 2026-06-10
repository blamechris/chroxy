/**
 * Exposure-banner store lifecycle tests (#5356 / #5459 / #5460).
 *
 * The ExposureWarningBanner component has its own render tests; these pin the
 * subtle part of the feature — the store-level dismissal lifecycle:
 *
 *   - fresh (non-reconnect) auth_ok resets exposureBannerDismissed to false
 *   - silent reconnect preserves the dismissal while refreshing serverExposure
 *   - explicit disconnect clears both (serverExposure: null, dismissed: false)
 *   - server_status { phase: 'ready', tunnelMode: 'quick' } merges
 *     quickTunnel: true into the snapshot, preserving lanBind
 *   - auth_ok without exposure (older server) yields serverExposure: null
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  stopHeartbeat,
} from './message-handler'
import type { ConnectionState } from './types'

// ---------------------------------------------------------------------------
// Test helpers (same shape as auth-ok-handler.test.ts)
// ---------------------------------------------------------------------------

/** Create a mock store compatible with setStore(). */
function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  const store = {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
  return store
}

/** Create a mock WebSocket with a send spy. */
function createMockSocket(): WebSocket {
  return {
    send: () => {},
    close: () => {},
    readyState: WebSocket.OPEN,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as WebSocket
}

/** Build a minimal auth_ok message. */
function createAuthOkMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'auth_ok',
    serverMode: 'cli',
    cwd: '/home/user/project',
    defaultCwd: '/home/user',
    serverVersion: '0.9.0',
    serverCommit: 'abc1234',
    protocolVersion: 3,
    clientId: 'client-1',
    connectedClients: [],
    ...overrides,
  }
}

function createInitialState(overrides: Partial<ConnectionState> = {}) {
  return {
    connectionPhase: 'connecting',
    socket: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectionError: null,
    connectionRetryCount: 0,
    serverExposure: null,
    exposureBannerDismissed: false,
    ...overrides,
  } as unknown as ConnectionState
}

function makeCtx(socket: WebSocket, isReconnect: boolean) {
  return {
    url: 'wss://test.example.com',
    token: 'tok',
    socket,
    isReconnect,
    silent: isReconnect,
  }
}

describe('exposure banner store lifecycle (#5356)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  beforeEach(() => {
    localStorage.clear()
    clearDeltaBuffers()
    mockSocket = createMockSocket()
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
  })

  describe('auth_ok exposure decoding', () => {
    it('stores the exposure snapshot from auth_ok (strict-boolean coercion)', () => {
      store = createMockStore(createInitialState())
      setStore(store)

      handleMessage(
        createAuthOkMessage({ exposure: { lanBind: true, bindHost: '0.0.0.0', quickTunnel: false } }) as never,
        makeCtx(mockSocket, false) as never,
      )

      expect(store.getState().serverExposure).toEqual({ lanBind: true, quickTunnel: false })
    })

    it('yields serverExposure: null when auth_ok omits exposure (older server)', () => {
      store = createMockStore(createInitialState({
        // Stale snapshot from a previous server must not survive the new auth.
        serverExposure: { lanBind: true, quickTunnel: true },
      }))
      setStore(store)

      handleMessage(createAuthOkMessage() as never, makeCtx(mockSocket, false) as never)

      expect(store.getState().serverExposure).toBeNull()
    })

    it('treats a malformed exposure field as null (no banner)', () => {
      store = createMockStore(createInitialState())
      setStore(store)

      handleMessage(
        createAuthOkMessage({ exposure: 'wide open' }) as never,
        makeCtx(mockSocket, false) as never,
      )

      expect(store.getState().serverExposure).toBeNull()
    })
  })

  describe('dismissal lifecycle', () => {
    it('fresh (non-reconnect) auth_ok resets exposureBannerDismissed to false', () => {
      store = createMockStore(createInitialState({ exposureBannerDismissed: true }))
      setStore(store)

      handleMessage(
        createAuthOkMessage({ exposure: { lanBind: true, quickTunnel: false } }) as never,
        makeCtx(mockSocket, false) as never,
      )

      const state = store.getState()
      expect(state.exposureBannerDismissed).toBe(false)
      expect(state.serverExposure).toEqual({ lanBind: true, quickTunnel: false })
    })

    it('silent reconnect preserves the dismissal while refreshing serverExposure', () => {
      store = createMockStore(createInitialState({
        exposureBannerDismissed: true,
        serverExposure: { lanBind: true, quickTunnel: false },
      }))
      setStore(store)

      // Same server, tunnel now active — the snapshot refreshes but the
      // user's dismissal must survive the silent reconnect.
      handleMessage(
        createAuthOkMessage({ exposure: { lanBind: true, quickTunnel: true } }) as never,
        makeCtx(mockSocket, true) as never,
      )

      const state = store.getState()
      expect(state.exposureBannerDismissed).toBe(true)
      expect(state.serverExposure).toEqual({ lanBind: true, quickTunnel: true })
    })

    it('explicit disconnect clears the snapshot and the dismissal (real store)', async () => {
      const { useConnectionStore } = await import('./connection')
      useConnectionStore.setState({
        socket: null,
        serverExposure: { lanBind: true, quickTunnel: true },
        exposureBannerDismissed: true,
      })

      useConnectionStore.getState().disconnect()

      const state = useConnectionStore.getState()
      expect(state.connectionPhase).toBe('disconnected')
      expect(state.serverExposure).toBeNull()
      expect(state.exposureBannerDismissed).toBe(false)
    })

    it('dismissExposureBanner sets the flag without touching the snapshot (real store)', async () => {
      const { useConnectionStore } = await import('./connection')
      useConnectionStore.setState({
        serverExposure: { lanBind: true, quickTunnel: false },
        exposureBannerDismissed: false,
      })

      useConnectionStore.getState().dismissExposureBanner()

      const state = useConnectionStore.getState()
      expect(state.exposureBannerDismissed).toBe(true)
      expect(state.serverExposure).toEqual({ lanBind: true, quickTunnel: false })
    })
  })

  describe('server_status ready merge (mid-warming quick tunnel)', () => {
    it('merges quickTunnel: true into the snapshot, preserving lanBind', () => {
      store = createMockStore(createInitialState({
        serverExposure: { lanBind: true, quickTunnel: false },
      }))
      setStore(store)

      handleMessage(
        { type: 'server_status', phase: 'ready', tunnelMode: 'quick' } as never,
        makeCtx(mockSocket, false) as never,
      )

      expect(store.getState().serverExposure).toEqual({ lanBind: true, quickTunnel: true })
    })

    it('builds a snapshot from scratch when auth_ok predated the tunnel (lanBind defaults false)', () => {
      store = createMockStore(createInitialState({ serverExposure: null }))
      setStore(store)

      handleMessage(
        { type: 'server_status', phase: 'ready', tunnelMode: 'quick' } as never,
        makeCtx(mockSocket, false) as never,
      )

      expect(store.getState().serverExposure).toEqual({ lanBind: false, quickTunnel: true })
    })

    it('does not touch the snapshot for a non-quick tunnel ready', () => {
      store = createMockStore(createInitialState({
        serverExposure: { lanBind: false, quickTunnel: false },
      }))
      setStore(store)

      handleMessage(
        { type: 'server_status', phase: 'ready', tunnelMode: 'named' } as never,
        makeCtx(mockSocket, false) as never,
      )

      expect(store.getState().serverExposure).toEqual({ lanBind: false, quickTunnel: false })
    })
  })
})
