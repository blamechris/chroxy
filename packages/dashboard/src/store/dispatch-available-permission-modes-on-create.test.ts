/**
 * #8224 — the permission-mode roster follows the ACTIVE session's provider,
 * including the moment a freshly created session becomes active.
 *
 * Which modes a provider can honour differs: claude-tui has no plan mode (its
 * roster lists "Plan (unavailable)"), claude-sdk does. The client used to keep
 * ONE flat `availablePermissionModes` list that the server refreshed only on an
 * explicit `switch_session` and at connect. Creating a session — which
 * auto-switches the creator, with no `switch_session` — left the previous
 * session's list in place, so a new claude-sdk session opened beside an active
 * claude-tui one showed a disabled "Plan (unavailable)" until the tab was
 * re-selected.
 *
 * The roster is now filed under the provider it describes and the active
 * session's is DERIVED (`selectPermissionModesForProvider`), so these tests drive
 * the REAL message-handler with the frame sequence the server actually sends for
 * a create (`finalizeShellCreate`: `session_switched`, then `sendSessionInfo` —
 * `available_models`, the provider-tagged `available_permission_modes`, ... —
 * then `session_list`) and read the roster the way `App.tsx` does.
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

import { selectPermissionModesForProvider } from '@chroxy/store-core'
import { handleMessage, setStore, setConnectionContext, stopHeartbeat } from './message-handler'
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

// The server's `getPermissionModes` output for the two providers (shape and
// labels as `packages/server/src/handler-utils.js` produces them).
const mode = (id: string, label: string, supported = true) => ({
  id, label, supported, enforcement: supported ? 'chroxy' : 'unsupported',
})
const TUI_ROSTER = [
  mode('approve', 'Approve'),
  mode('acceptEdits', 'Accept Edits'),
  mode('auto', 'Auto'),
  mode('plan', 'Plan (unavailable)', false),
]
const SDK_ROSTER = [
  mode('approve', 'Approve'),
  mode('acceptEdits', 'Accept Edits'),
  mode('auto', 'Auto'),
  mode('plan', 'Plan'),
]

const TUI_SESSION = { sessionId: 'tui-1', name: 'tui', cwd: '/w', type: 'cli', hasTerminal: false, model: null, permissionMode: 'approve', isBusy: false, provider: 'claude-tui' }
const SDK_SESSION = { ...TUI_SESSION, sessionId: 'sdk-1', name: 'sdk', provider: 'claude-sdk' }

describe('dashboard store — permission-mode roster follows the active session (#8224)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })
  const send = (msg: Record<string, unknown>) => handleMessage(msg, ctx() as never)

  /** What `App.tsx` renders: the active session's provider's roster. */
  const activeRoster = () => {
    const s = store.getState()
    const provider = s.sessions.find((x) => x.sessionId === s.activeSessionId)?.provider ?? null
    return selectPermissionModesForProvider(s.permissionModesByProvider, provider)
  }
  const planOf = () => activeRoster().find((m) => m.id === 'plan')

  beforeEach(() => {
    vi.clearAllMocks()
    mockSocket = createMockSocket()
    const serverErrors: unknown[] = []
    store = createMockStore({
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
      fetchSlashCommands: () => undefined,
      fetchCustomAgents: () => undefined,
      serverProtocolVersion: null,
      modelsByProvider: {},
      permissionModesByProvider: {},
    } as unknown as Partial<ConnectionState>)
    setStore(store)
    setConnectionContext(ctx() as never)

    // Connect with a claude-tui session active: the post-auth burst.
    send({ type: 'session_list', sessions: [TUI_SESSION] })
    send({ type: 'session_switched', sessionId: 'tui-1', name: 'tui', cwd: '/w' })
    send({ type: 'available_permission_modes', modes: TUI_ROSTER, provider: 'claude-tui' })
  })

  afterEach(() => {
    stopHeartbeat()
    setConnectionContext(null)
  })

  it('control: with claude-tui active, Plan is unavailable', () => {
    expect(store.getState().activeSessionId).toBe('tui-1')
    expect(planOf()?.supported).toBe(false)
    expect(planOf()?.label).toBe('Plan (unavailable)')
  })

  it('a create-and-auto-switch to claude-sdk offers Plan (the server\'s create frame sequence)', () => {
    // finalizeShellCreate: session_switched, then sendSessionInfo, then the list.
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' })
    send({ type: 'available_permission_modes', modes: SDK_ROSTER, provider: 'claude-sdk' })
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] })

    expect(store.getState().activeSessionId).toBe('sdk-1')
    expect(planOf()?.supported).toBe(true)
    expect(planOf()?.label).toBe('Plan')
  })

  it('never serves the previous session\'s roster while the new one\'s has not arrived', () => {
    // The window the bug lived in: the creator is already on the new session,
    // and no roster for ITS provider has been heard. The old flat slot kept
    // answering with claude-tui's, "Plan (unavailable)" included.
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' })
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] })

    expect(planOf()).toBeUndefined()
    expect(activeRoster()).toEqual([])
  })

  it('the reverse switch removes it again', () => {
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' })
    send({ type: 'available_permission_modes', modes: SDK_ROSTER, provider: 'claude-sdk' })
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] })
    expect(planOf()?.supported).toBe(true)

    // Back to claude-tui. Even if NO roster frame accompanies the switch, the
    // derivation reads the claude-tui roster it already holds.
    send({ type: 'session_switched', sessionId: 'tui-1', name: 'tui', cwd: '/w' })
    expect(store.getState().activeSessionId).toBe('tui-1')
    expect(planOf()?.supported).toBe(false)
  })

  it('a roster for a session that is NOT the active one does not displace the active picker', () => {
    // subscribe_sessions pushes session info for sessions the client is not
    // viewing; their roster must be stored, not shown.
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] })
    send({ type: 'available_permission_modes', modes: SDK_ROSTER, provider: 'claude-sdk' })

    expect(store.getState().activeSessionId).toBe('tui-1')
    expect(planOf()?.supported).toBe(false)
  })

  it('a daemon from before #8224 (untagged roster, provider named in session_list) still gets its picker', () => {
    // Reset to a fresh client, then speak the OLD daemon's dialect: the roster
    // frame carries no provider, session_list does.
    store.setState({ permissionModesByProvider: {} } as never)
    send({ type: 'session_list', sessions: [TUI_SESSION, SDK_SESSION] })
    send({ type: 'session_switched', sessionId: 'sdk-1', name: 'sdk', cwd: '/w' })
    send({ type: 'available_permission_modes', modes: SDK_ROSTER })

    expect(store.getState().activeSessionId).toBe('sdk-1')
    expect(planOf()?.supported).toBe(true)
  })
})
