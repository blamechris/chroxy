/**
 * ServerPicker — tests for multi-server management UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ServerPicker } from './ServerPicker'
import type { ServerEntry } from '../store/types'

let storeState: Record<string, unknown> = {}
const mockAddServer = vi.fn(() => ({ id: 'srv_new', name: 'New', wsUrl: 'wss://new/ws', token: 't', lastConnectedAt: null }))
const mockRemoveServer = vi.fn()
const mockSwitchServer = vi.fn()
const mockConnectLocal = vi.fn()

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

const FAKE_NOW = 1_741_348_800_000 // 2025-03-07T12:00:00Z

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(FAKE_NOW)
  mockIsTauri = false
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
      const item = await screen.findByTestId('server-discover-item-192.168.1.9')
      expect(item).toHaveTextContent('devbox')
      expect(item).toHaveTextContent('192.168.1.9:8765')
      expect(item).toHaveTextContent('v0.9.44')
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
})
