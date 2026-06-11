/**
 * ServerPicker — tests for multi-server management UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ServerPicker } from './ServerPicker'
import type { ServerEntry } from '../store/types'

let storeState: Record<string, unknown> = {}
const mockAddServer = vi.fn(() => ({ id: 'srv_new', name: 'New', wsUrl: 'wss://new/ws', token: 't', lastConnectedAt: null }))
const mockRemoveServer = vi.fn()
const mockSwitchServer = vi.fn()
const mockConnectLocal = vi.fn()
const mockPairServer = vi.fn(() => ({ id: 'srv_paired', name: 'Paired', wsUrl: 'ws://192.168.1.5:8765/ws', token: '', lastConnectedAt: null }))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const store = {
      serverRegistry: storeState.serverRegistry ?? [],
      activeServerId: storeState.activeServerId ?? null,
      connectionPhase: storeState.connectionPhase ?? 'disconnected',
      hasLocalServer: storeState.hasLocalServer ?? false,
      addServer: mockAddServer,
      removeServer: mockRemoveServer,
      switchServer: mockSwitchServer,
      connectLocal: mockConnectLocal,
      pairServer: mockPairServer,
    }
    return selector(store)
  },
}))

// #5281 ③ — LAN discovery deps. isTauri gates the section; discoverLanServers
// is stubbed per-test.
let mockIsTauri = false
const mockDiscover = vi.fn()
vi.mock('../utils/tauri', () => ({ isTauri: () => mockIsTauri }))
vi.mock('../utils/discovery', () => ({ discoverLanServers: () => mockDiscover() }))

// #5511 — request-pairing primitive (landed in #5527). The RequestPairPanel
// drives requestPairing(); we capture its args + the onState callback so tests
// can step the requesting → code-shown → approved/denied/expired phases without
// a real WebSocket.
type PairState = {
  phase: 'requesting' | 'code-shown' | 'approved' | 'denied' | 'expired' | 'error'
  verifyCode: string | null
  token: string | null
  reason: string | null
}
let lastPairArgs: { wsUrl: string; deviceName: string; onState: (s: PairState) => void } | null = null
const mockPairCancel = vi.fn()
const mockRequestPairing = vi.fn(
  (wsUrl: string, deviceName: string, onState: (s: PairState) => void) => {
    lastPairArgs = { wsUrl, deviceName, onState }
    // Initial 'requesting' tick, mirroring the real util's first emit().
    onState({ phase: 'requesting', verifyCode: null, token: null, reason: null })
    return { cancel: mockPairCancel }
  },
)
vi.mock('../utils/request-pairing', () => ({
  requestPairing: (
    wsUrl: string,
    deviceName: string,
    onState: (s: PairState) => void,
  ) => mockRequestPairing(wsUrl, deviceName, onState),
}))

const FAKE_NOW = 1_741_348_800_000 // 2025-03-07T12:00:00Z

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(FAKE_NOW)
  mockIsTauri = false
  lastPairArgs = null
  storeState = {
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
  }
})

const SERVERS: ServerEntry[] = [
  { id: 'srv_1', name: 'Dev Machine', wsUrl: 'wss://dev.example.com/ws', token: 'abc', lastConnectedAt: FAKE_NOW - 330_000 },
  { id: 'srv_2', name: 'Production', wsUrl: 'wss://prod.example.com/ws', token: 'def', lastConnectedAt: null },
]

describe('ServerPicker', () => {
  it('shows empty state when no servers', () => {
    render(<ServerPicker />)
    expect(screen.getByTestId('server-empty')).toBeTruthy()
    expect(screen.getByText('No servers configured.')).toBeTruthy()
  })

  it('pins a "This machine" local item when a local server is available', () => {
    storeState.hasLocalServer = true
    storeState.activeServerId = null
    storeState.connectionPhase = 'connected'
    render(<ServerPicker />)
    const local = screen.getByTestId('server-item-local')
    expect(local).toBeTruthy()
    expect(screen.getByText('This machine')).toBeTruthy()
    // active (activeServerId === null) + connected → shows Connected
    expect(local.className).toContain('active')
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('does not pin a local item when no local server is available', () => {
    storeState.hasLocalServer = false
    render(<ServerPicker />)
    expect(screen.queryByTestId('server-item-local')).toBeNull()
  })

  it('hides empty state when only the local server is available', () => {
    storeState.hasLocalServer = true
    storeState.serverRegistry = []
    render(<ServerPicker />)
    expect(screen.queryByTestId('server-empty')).toBeNull()
    expect(screen.getByTestId('server-item-local')).toBeTruthy()
  })

  it('local item is inactive when a remote server is active', () => {
    storeState.hasLocalServer = true
    storeState.serverRegistry = SERVERS
    storeState.activeServerId = 'srv_1'
    storeState.connectionPhase = 'connected'
    render(<ServerPicker />)
    expect(screen.getByTestId('server-item-local').className).not.toContain('active')
  })

  it('calls connectLocal when clicking the local item', () => {
    storeState.hasLocalServer = true
    render(<ServerPicker />)
    fireEvent.click(screen.getByText('This machine'))
    expect(mockConnectLocal).toHaveBeenCalledTimes(1)
  })

  it('shows server list', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    const items = screen.getAllByTestId('server-item')
    expect(items).toHaveLength(2)
  })

  it('shows server names', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    expect(screen.getByText('Dev Machine')).toBeTruthy()
    expect(screen.getByText('Production')).toBeTruthy()
  })

  it('shows shortened URLs', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    expect(screen.getByText('dev.example.com')).toBeTruthy()
    expect(screen.getByText('prod.example.com')).toBeTruthy()
  })

  it('shows connected status for active server', () => {
    storeState.serverRegistry = SERVERS
    storeState.activeServerId = 'srv_1'
    storeState.connectionPhase = 'connected'
    render(<ServerPicker />)
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('shows last connected time for inactive servers', () => {
    storeState.serverRegistry = SERVERS
    storeState.activeServerId = 'srv_2'
    storeState.connectionPhase = 'connected'
    render(<ServerPicker />)
    // srv_1 is inactive → shows relative time
    expect(screen.getByText('5m ago')).toBeTruthy()
    // srv_2 is active + connected → shows "Connected"
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('adds aria-label to status dots', () => {
    storeState.serverRegistry = SERVERS
    storeState.activeServerId = 'srv_1'
    storeState.connectionPhase = 'connected'
    render(<ServerPicker />)
    const dots = document.querySelectorAll('.server-dot')
    expect(dots[0]!.getAttribute('aria-label')).toBe('Connected')
    expect(dots[1]!.getAttribute('aria-label')).toBe('Idle')
  })

  it('links server button to status via aria-describedby', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    const buttons = screen.getAllByTitle(/Connect to/)
    expect(buttons[0]!.getAttribute('aria-describedby')).toBe('server-status-srv_1')
    expect(buttons[1]!.getAttribute('aria-describedby')).toBe('server-status-srv_2')
  })

  it('highlights the active server', () => {
    storeState.serverRegistry = SERVERS
    storeState.activeServerId = 'srv_1'
    render(<ServerPicker />)
    const items = screen.getAllByTestId('server-item')
    expect(items[0]!.className).toContain('active')
    expect(items[1]!.className).not.toContain('active')
  })

  it('calls switchServer when clicking a server', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    fireEvent.click(screen.getByText('Dev Machine'))
    expect(mockSwitchServer).toHaveBeenCalledWith('srv_1')
  })

  it('shows add form when clicking + button', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    expect(screen.getByTestId('server-add-form')).toBeTruthy()
  })

  it('hides empty state when add form is shown', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    expect(screen.queryByTestId('server-empty')).toBeNull()
  })

  it('calls addServer with form values', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.change(screen.getByTestId('server-name-input'), { target: { value: 'My Server' } })
    fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://my/ws' } })
    fireEvent.change(screen.getByTestId('server-token-input'), { target: { value: 'tok123' } })
    fireEvent.click(screen.getByTestId('server-add-submit'))
    expect(mockAddServer).toHaveBeenCalledWith('My Server', 'wss://my/ws', 'tok123')
  })

  it('auto-connects after adding server', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://x/ws' } })
    fireEvent.change(screen.getByTestId('server-token-input'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByTestId('server-add-submit'))
    expect(mockSwitchServer).toHaveBeenCalledWith('srv_new')
  })

  it('cancels add form', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.click(screen.getByTestId('server-add-cancel'))
    expect(screen.queryByTestId('server-add-form')).toBeNull()
  })

  it('shows remove confirmation on X click', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    const removeBtns = screen.getAllByTestId('server-remove-btn')
    fireEvent.click(removeBtns[0]!)
    expect(screen.getByTestId('server-remove-confirm')).toBeTruthy()
  })

  it('removes server after confirmation', () => {
    storeState.serverRegistry = SERVERS
    render(<ServerPicker />)
    const removeBtns = screen.getAllByTestId('server-remove-btn')
    fireEvent.click(removeBtns[0]!)
    fireEvent.click(screen.getByTestId('server-remove-confirm'))
    expect(mockRemoveServer).toHaveBeenCalledWith('srv_1')
  })

  it('disables add button when URL and token are empty', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    const submit = screen.getByTestId('server-add-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('submits form on Enter key in token input', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://x/ws' } })
    fireEvent.change(screen.getByTestId('server-token-input'), { target: { value: 'tok' } })
    fireEvent.submit(screen.getByTestId('server-add-form'))
    expect(mockAddServer).toHaveBeenCalledWith('wss://x/ws', 'wss://x/ws', 'tok')
  })

  it('does not submit form when required fields are empty', () => {
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.submit(screen.getByTestId('server-add-form'))
    expect(mockAddServer).not.toHaveBeenCalled()
  })

  it('shows inline error when addServer throws on invalid URL', () => {
    mockAddServer.mockImplementationOnce(() => { throw new Error('URL must start with ws:// or wss://') })
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'http://bad' } })
    fireEvent.change(screen.getByTestId('server-token-input'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByTestId('server-add-submit'))
    expect(screen.getByTestId('server-url-error')).toBeTruthy()
    expect(screen.getByText('URL must start with ws:// or wss://')).toBeTruthy()
    // Form should still be visible (not closed)
    expect(screen.getByTestId('server-add-form')).toBeTruthy()
  })

  it('clears error when cancel is clicked', () => {
    mockAddServer.mockImplementationOnce(() => { throw new Error('Invalid URL format') })
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'bad' } })
    fireEvent.change(screen.getByTestId('server-token-input'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByTestId('server-add-submit'))
    expect(screen.getByTestId('server-url-error')).toBeTruthy()
    fireEvent.click(screen.getByTestId('server-add-cancel'))
    // Re-open form — error should be gone
    fireEvent.click(screen.getByTestId('server-add-btn'))
    expect(screen.queryByTestId('server-url-error')).toBeNull()
  })

  it('error element has role="alert" for accessibility', () => {
    mockAddServer.mockImplementationOnce(() => { throw new Error('URL is required') })
    render(<ServerPicker />)
    fireEvent.click(screen.getByTestId('server-add-btn'))
    fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'x' } })
    fireEvent.change(screen.getByTestId('server-token-input'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByTestId('server-add-submit'))
    const errorEl = screen.getByTestId('server-url-error')
    expect(errorEl.getAttribute('role')).toBe('alert')
  })

  describe('LAN discovery (#5281 ③)', () => {
    const DISCOVERED = [
      { name: 'devbox', host: '192.168.1.9', port: 8765, wsUrl: 'ws://192.168.1.9:8765/ws', version: '0.9.44' },
    ]

    it('does not render the Discover button outside Tauri', () => {
      mockIsTauri = false
      render(<ServerPicker />)
      expect(screen.queryByTestId('server-discover-btn')).toBeNull()
    })

    it('renders the Discover button in Tauri and lists results', async () => {
      mockIsTauri = true
      mockDiscover.mockResolvedValue(DISCOVERED)
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-discover-btn'))
      expect(mockDiscover).toHaveBeenCalledTimes(1)
      const row = await screen.findByTestId('server-discover-row-192.168.1.9')
      expect(row).toHaveTextContent('devbox')
      expect(row).toHaveTextContent('192.168.1.9:8765')
      expect(row).toHaveTextContent('v0.9.44')
      // Each discovered row offers both the one-click pair action (#5511) and the
      // token-entry fallback (#5281 ③).
      expect(screen.getByTestId('server-discover-pair-192.168.1.9')).toBeTruthy()
      expect(screen.getByTestId('server-discover-item-192.168.1.9')).toBeTruthy()
    })

    it('clicking a discovered server opens the add form pre-filled with its URL', async () => {
      mockIsTauri = true
      mockDiscover.mockResolvedValue(DISCOVERED)
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-discover-btn'))
      fireEvent.click(await screen.findByTestId('server-discover-item-192.168.1.9'))
      const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement
      const nameInput = screen.getByTestId('server-name-input') as HTMLInputElement
      expect(urlInput.value).toBe('ws://192.168.1.9:8765/ws')
      expect(nameInput.value).toBe('devbox')
      // Token is intentionally NOT pre-filled — the user supplies it.
      expect((screen.getByTestId('server-token-input') as HTMLInputElement).value).toBe('')
    })

    it('hides discovered daemons already in the registry', async () => {
      mockIsTauri = true
      storeState.serverRegistry = [
        { id: 'srv_known', name: 'devbox', wsUrl: 'ws://192.168.1.9:8765/ws', token: 't', lastConnectedAt: null },
      ]
      mockDiscover.mockResolvedValue(DISCOVERED)
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-discover-btn'))
      expect(await screen.findByTestId('server-discover-allknown')).toBeTruthy()
      expect(screen.queryByTestId('server-discover-item-192.168.1.9')).toBeNull()
    })

    it('surfaces a discovery error', async () => {
      mockIsTauri = true
      mockDiscover.mockRejectedValue(new Error('mDNS init failed'))
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-discover-btn'))
      const err = await screen.findByTestId('server-discover-error')
      expect(err).toHaveTextContent('mDNS init failed')
      expect(err.getAttribute('role')).toBe('alert')
    })
  })

  describe('pairing URL (#5281 ③ PR 2)', () => {
    it('switches to pairing mode when a chroxy://…?pair= URL is entered', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-url-input'), {
        target: { value: 'chroxy://192.168.1.5:8765?pair=ABC123' },
      })
      // Token field is replaced by a "no token needed" hint; submit says "Pair".
      expect(screen.getByTestId('server-pairing-hint')).toBeTruthy()
      expect(screen.queryByTestId('server-token-input')).toBeNull()
      expect(screen.getByTestId('server-add-submit')).toHaveTextContent('Pair')
      expect((screen.getByTestId('server-add-submit') as HTMLButtonElement).disabled).toBe(false)
    })

    it('submitting a pairing URL calls pairServer with the inferred ws URL', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-url-input'), {
        target: { value: 'chroxy://192.168.1.5:8765?pair=ABC123' },
      })
      fireEvent.click(screen.getByTestId('server-add-submit'))
      expect(mockPairServer).toHaveBeenCalledWith('192.168.1.5:8765', 'ws://192.168.1.5:8765/ws', 'ABC123')
      // Not the manual add path.
      expect(mockAddServer).not.toHaveBeenCalled()
    })

    it('uses the typed name when pairing', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-name-input'), { target: { value: 'Studio Mac' } })
      fireEvent.change(screen.getByTestId('server-url-input'), {
        target: { value: 'chroxy://my-tunnel.trycloudflare.com?pair=XYZ' },
      })
      fireEvent.click(screen.getByTestId('server-add-submit'))
      expect(mockPairServer).toHaveBeenCalledWith('Studio Mac', 'wss://my-tunnel.trycloudflare.com/ws', 'XYZ')
    })

    it('stays in manual mode (token required) for a plain ws URL', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://host/ws' } })
      expect(screen.getByTestId('server-token-input')).toBeTruthy()
      expect(screen.queryByTestId('server-pairing-hint')).toBeNull()
      expect(screen.getByTestId('server-add-submit')).toHaveTextContent('Add')
    })

    it('uses the embedded token from a legacy chroxy://…?token= URL', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-url-input'), {
        target: { value: 'chroxy://192.168.1.5:8765?token=embedded-tok' },
      })
      // Token field hidden (URL carries it); button still "Add" (not pairing).
      expect(screen.queryByTestId('server-token-input')).toBeNull()
      expect(screen.getByTestId('server-pairing-hint')).toHaveTextContent('includes a token')
      expect(screen.getByTestId('server-add-submit')).toHaveTextContent('Add')
      fireEvent.click(screen.getByTestId('server-add-submit'))
      expect(mockAddServer).toHaveBeenCalledWith('192.168.1.5:8765', 'ws://192.168.1.5:8765/ws', 'embedded-tok')
      expect(mockPairServer).not.toHaveBeenCalled()
    })
  })

  // #5511 — one-click Request-to-pair on discovered LAN daemons. The requester
  // primitive (requestPairing + RequestPairPanel) landed in #5527; these tests
  // wire it onto the discovered rows and assert token-storage parity with the
  // chroxy://?pair= flow, plus the requesting/code-shown/approved/denied/expired
  // states.
  describe('discovered daemon Request-to-pair (#5511)', () => {
    const DISCOVERED = [
      { name: 'devbox', host: '192.168.1.9', port: 8765, wsUrl: 'ws://192.168.1.9:8765/ws', version: '0.9.45' },
    ]

    async function discover() {
      mockIsTauri = true
      mockDiscover.mockResolvedValue(DISCOVERED)
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-discover-btn'))
      await screen.findByTestId('server-discover-item-192.168.1.9')
    }

    it('renders a Request-to-pair button on each discovered daemon row', async () => {
      await discover()
      expect(screen.getByTestId('server-discover-pair-192.168.1.9')).toBeTruthy()
    })

    it('clicking Request-to-pair opens the request panel and calls requestPairing with the daemon URL', async () => {
      await discover()
      fireEvent.click(screen.getByTestId('server-discover-pair-192.168.1.9'))
      expect(screen.getByTestId('request-pair-panel')).toBeTruthy()
      expect(mockRequestPairing).toHaveBeenCalledTimes(1)
      expect(lastPairArgs?.wsUrl).toBe('ws://192.168.1.9:8765/ws')
      // The daemon name is forwarded as the device label / stored name.
      expect(lastPairArgs?.deviceName).toBe('devbox')
    })

    it('shows the requesting state then the verify code (code-shown)', async () => {
      await discover()
      fireEvent.click(screen.getByTestId('server-discover-pair-192.168.1.9'))
      expect(screen.getByTestId('request-pair-status')).toHaveTextContent(/Requesting/i)
      act(() => {
        lastPairArgs!.onState({ phase: 'code-shown', verifyCode: '123456', token: null, reason: null })
      })
      expect(screen.getByTestId('request-pair-code')).toHaveTextContent('123456')
      expect(screen.getByTestId('request-pair-status')).toHaveTextContent(/Waiting for approval/i)
    })

    it('stores the issued token + connects on approval, like the ?pair= flow', async () => {
      await discover()
      fireEvent.click(screen.getByTestId('server-discover-pair-192.168.1.9'))
      act(() => {
        lastPairArgs!.onState({ phase: 'approved', verifyCode: '123456', token: 'issued-tok', reason: null })
      })
      // Token-storage parity: addServer(name, wsUrl, token) then switchServer.
      expect(mockAddServer).toHaveBeenCalledWith('devbox', 'ws://192.168.1.9:8765/ws', 'issued-tok')
      expect(mockSwitchServer).toHaveBeenCalledWith('srv_new')
      // No token was ever typed by the user (parity with pairing, not manual add).
      expect(mockPairServer).not.toHaveBeenCalled()
    })

    it('shows a denied state with a legible retry (Cancel) affordance', async () => {
      await discover()
      fireEvent.click(screen.getByTestId('server-discover-pair-192.168.1.9'))
      act(() => {
        lastPairArgs!.onState({ phase: 'denied', verifyCode: null, token: null, reason: 'denied' })
      })
      expect(screen.getByTestId('request-pair-denied')).toBeTruthy()
      expect(mockAddServer).not.toHaveBeenCalled()
    })

    it('shows an expired state when the 120s TTL elapses', async () => {
      await discover()
      fireEvent.click(screen.getByTestId('server-discover-pair-192.168.1.9'))
      act(() => {
        lastPairArgs!.onState({ phase: 'expired', verifyCode: null, token: null, reason: 'expired' })
      })
      expect(screen.getByTestId('request-pair-expired')).toBeTruthy()
      expect(screen.getByTestId('request-pair-expired')).toHaveTextContent(/Try again/i)
    })

    it('cancelling the panel cancels the in-flight request', async () => {
      await discover()
      fireEvent.click(screen.getByTestId('server-discover-pair-192.168.1.9'))
      fireEvent.click(screen.getByTestId('request-pair-cancel'))
      expect(mockPairCancel).toHaveBeenCalled()
      expect(screen.queryByTestId('request-pair-panel')).toBeNull()
    })

    it('still offers the token-entry Add path on discovered rows', async () => {
      await discover()
      // The existing pre-fill-the-add-form action remains available.
      fireEvent.click(screen.getByTestId('server-discover-item-192.168.1.9'))
      expect((screen.getByTestId('server-url-input') as HTMLInputElement).value).toBe('ws://192.168.1.9:8765/ws')
    })
  })

  // #5511 — manually-entered hosts: the "Request to pair" button on the add form
  // already landed in #5527 (a typed wss:// URL with no token). These component
  // tests cover it here (it had only a util-level test before).
  describe('manual-host Request-to-pair (landed in #5527, test-covered here)', () => {
    it('offers Request-to-pair for a plain wss:// URL with no token', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://host/ws' } })
      const btn = screen.getByTestId('server-request-pair') as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })

    it('disables Request-to-pair until a ws(s):// URL is entered', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      expect((screen.getByTestId('server-request-pair') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'not-a-url' } })
      expect((screen.getByTestId('server-request-pair') as HTMLButtonElement).disabled).toBe(true)
    })

    it('clicking Request-to-pair opens the panel and drives requestPairing', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-name-input'), { target: { value: 'Studio Mac' } })
      fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://host/ws' } })
      fireEvent.click(screen.getByTestId('server-request-pair'))
      expect(screen.getByTestId('request-pair-panel')).toBeTruthy()
      expect(lastPairArgs?.wsUrl).toBe('wss://host/ws')
      expect(lastPairArgs?.deviceName).toBe('Studio Mac')
    })

    it('stores the issued token + connects on approval (manual host parity)', () => {
      render(<ServerPicker />)
      fireEvent.click(screen.getByTestId('server-add-btn'))
      fireEvent.change(screen.getByTestId('server-url-input'), { target: { value: 'wss://host/ws' } })
      fireEvent.click(screen.getByTestId('server-request-pair'))
      act(() => {
        lastPairArgs!.onState({ phase: 'approved', verifyCode: '999111', token: 'manual-tok', reason: null })
      })
      expect(mockAddServer).toHaveBeenCalledWith('wss://host/ws', 'wss://host/ws', 'manual-tok')
      expect(mockSwitchServer).toHaveBeenCalledWith('srv_new')
    })
  })
})
