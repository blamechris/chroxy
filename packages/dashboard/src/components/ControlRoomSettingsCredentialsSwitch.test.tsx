/**
 * #8419 — the Control Room Settings tab re-asks the NEW daemon for its
 * credentials after a Server Picker switch.
 *
 * The Settings tab passes a constant `isOpen`, so the two refresh effects that
 * were keyed on `isOpen` alone fired once at mount and never again. #7579 made a
 * switch clear `credentialsStatus` / `byokCredentialsStatus`, so the tab was left
 * reading "Missing" / an empty list for a daemon nobody had asked. This drives
 * the REAL store (no mocked selectors) through the switch the Server Picker runs
 * and counts the frames that actually go onto the socket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

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

const { useConnectionStore } = await import('../store/connection')
const { handleMessage, stopHeartbeat, clearDeltaBuffers, clearPermissionSplits, resetReplayFlags } =
  await import('../store/message-handler')
const { createEmptyDaemonSnapshots } = await import('../store/utils')
const { ControlRoomView } = await import('./ControlRoomView')

type State = ReturnType<typeof useConnectionStore.getState>

const SERVER_A_URL = 'wss://server-a/ws'
const SERVER_B_URL = 'wss://server-b/ws'

const CREDENTIALS = 'get_credentials_status'
const BYOK = 'byok_get_credentials_status'

function fakeSocket() {
  const sent: string[] = []
  const socket = {
    readyState: 1,
    close: vi.fn(),
    send: vi.fn((data: string) => {
      try { sent.push((JSON.parse(data) as { type: string }).type) } catch { /* not JSON */ }
    }),
  }
  return { socket, sent }
}

function count(sent: string[], type: string): number {
  return sent.filter((t) => t === type).length
}

function authOk(socket: unknown, url: string) {
  handleMessage(
    {
      type: 'auth_ok', serverMode: 'cli', cwd: '/x', defaultCwd: '/x', serverVersion: '0.9.0',
      protocolVersion: 3, clientId: `client-${url}`, connectedClients: [],
    },
    { url, token: 'tok', socket, isReconnect: false, silent: true } as never,
  )
}

function resetSlice() {
  useConnectionStore.setState({
    ...createEmptyDaemonSnapshots(),
    failedRestores: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    socket: null,
  } as unknown as Partial<State>)
}

beforeEach(() => {
  clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
  for (const k of Object.keys(lsStore)) delete lsStore[k]
  resetSlice()
})
afterEach(() => { cleanup(); stopHeartbeat(); resetSlice(); vi.restoreAllMocks() })

describe('#8419 Control Room Settings tab credentials follow the connection', () => {
  it('re-requests both snapshots from the new daemon after a Server Picker switch', () => {
    const a = fakeSocket()
    const b = fakeSocket()
    // `connect` is stubbed: the handshake is replayed by hand below, so the
    // frames counted are exactly the ones the panels send.
    useConnectionStore.setState({ connect: vi.fn() } as unknown as Partial<State>)
    const serverA = useConnectionStore.getState().addServer('A', SERVER_A_URL, 'tok-a')
    const serverB = useConnectionStore.getState().addServer('B', SERVER_B_URL, 'tok-b')
    useConnectionStore.setState({
      activeServerId: serverA.id, wsUrl: SERVER_A_URL, connectionPhase: 'connected',
      socket: a.socket as unknown as WebSocket,
    } as unknown as Partial<State>)

    act(() => { render(<ControlRoomView initialTab="settings" />) })
    expect(screen.getByTestId('cr-settings-tab'), 'control: the Settings tab is the open one').toBeTruthy()

    // First open: one request each (no double fire from isOpen + connected).
    expect(count(a.sent, CREDENTIALS), 'first open: provider credentials').toBe(1)
    expect(count(a.sent, BYOK), 'first open: BYOK').toBe(1)

    // The daemon answers; the tab shows A's data.
    useConnectionStore.setState({
      credentialsStatus: { credentials: [], fileExists: true, fileError: null },
      byokCredentialsStatus: { status: 'set', source: 'file', masked: 'sk-ant-A', fileExists: true },
    } as unknown as Partial<State>)

    // The switch: teardown clears A's readings (#7579), nothing is asked while the
    // new handshake is in flight...
    act(() => { useConnectionStore.getState().switchServer(serverB.id) })
    expect(useConnectionStore.getState().credentialsStatus, 'control: the switch cleared A\'s reading').toBeNull()
    expect(useConnectionStore.getState().connectionPhase).not.toBe('connected')
    expect(count(a.sent, CREDENTIALS) + count(b.sent, CREDENTIALS), 'nothing asked while disconnected').toBe(1)
    expect(count(a.sent, BYOK) + count(b.sent, BYOK), 'nothing asked while disconnected').toBe(1)

    // ...and the new daemon is asked as soon as it is up.
    act(() => { authOk(b.socket, SERVER_B_URL) })
    expect(useConnectionStore.getState().connectionPhase).toBe('connected')
    expect(count(b.sent, CREDENTIALS), 'B was never asked for provider credentials (#8419)').toBe(1)
    expect(count(b.sent, BYOK), 'B was never asked for BYOK status (#8419)').toBe(1)
    // And A, which is gone, was not asked again.
    expect(count(a.sent, CREDENTIALS)).toBe(1)
    expect(count(a.sent, BYOK)).toBe(1)
  })

  it('a reconnect to the SAME daemon re-asks once, like the survey tabs', () => {
    const first = fakeSocket()
    const second = fakeSocket()
    useConnectionStore.setState({
      wsUrl: SERVER_A_URL, connectionPhase: 'connected', socket: first.socket as unknown as WebSocket,
    } as unknown as Partial<State>)
    act(() => { render(<ControlRoomView initialTab="settings" />) })
    expect(count(first.sent, CREDENTIALS)).toBe(1)

    // The transport drops; connect() sets 'reconnecting', then the handshake completes.
    act(() => { useConnectionStore.setState({ connectionPhase: 'reconnecting', socket: null } as unknown as Partial<State>) })
    expect(count(first.sent, CREDENTIALS), 'nothing asked into the dead socket').toBe(1)
    act(() => {
      useConnectionStore.setState({
        connectionPhase: 'connected', socket: second.socket as unknown as WebSocket,
      } as unknown as Partial<State>)
    })
    expect(count(second.sent, CREDENTIALS)).toBe(1)
    expect(count(second.sent, BYOK)).toBe(1)
  })

  it('sends nothing at all while the tab is open on a disconnected store', () => {
    const idle = fakeSocket()
    useConnectionStore.setState({
      connectionPhase: 'disconnected', socket: idle.socket as unknown as WebSocket,
    } as unknown as Partial<State>)
    act(() => { render(<ControlRoomView initialTab="settings" />) })
    expect(idle.sent.filter((t) => t === CREDENTIALS || t === BYOK)).toEqual([])
  })
})
