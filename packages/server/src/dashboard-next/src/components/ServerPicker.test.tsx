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

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const store = {
      serverRegistry: storeState.serverRegistry ?? [],
      activeServerId: storeState.activeServerId ?? null,
      connectionPhase: storeState.connectionPhase ?? 'disconnected',
      addServer: mockAddServer,
      removeServer: mockRemoveServer,
      switchServer: mockSwitchServer,
    }
    return selector(store)
  },
}))

const FAKE_NOW = 1_741_348_800_000 // 2025-03-07T12:00:00Z

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(FAKE_NOW)
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
})
