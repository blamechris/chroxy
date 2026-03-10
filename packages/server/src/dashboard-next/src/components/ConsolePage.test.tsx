import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ConsolePage } from './ConsolePage'

// Mock LogPanel to avoid connection store dependency
vi.mock('./LogPanel', () => ({
  LogPanel: () => <div data-testid="log-panel-mock" />,
}))

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock clipboard API (save original for restore)
const originalClipboard = navigator.clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined)
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
})

// Mock getAuthToken — inject via cookie
function setAuthCookie(token: string) {
  Object.defineProperty(document, 'cookie', {
    writable: true,
    value: `chroxy_auth=${token}`,
  })
}

/** Helper: always-fresh mock that returns the same data for every call */
function mockConnectAndQr(
  info: Record<string, string>,
  qrSvg = '<svg>mock-qr</svg>',
) {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/connect')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...info }),
      })
    }
    if (typeof url === 'string' && url.startsWith('/qr')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(qrSvg),
      })
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  })
}

describe('ConsolePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setAuthCookie('test-token-123')
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', mockFetch)
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    })
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: '',
    })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    if (originalClipboard) {
      Object.assign(navigator, { clipboard: originalClipboard })
    }
  })

  it('renders connection info heading', () => {
    mockConnectAndQr({ httpUrl: 'https://x', apiToken: 'x', tunnelMode: 'quick', wsUrl: 'wss://x', connectionUrl: 'chroxy://x' })
    render(<ConsolePage />)
    expect(screen.getByText('Connection Info')).toBeTruthy()
  })

  it('fetches and displays connection info on mount', async () => {
    mockConnectAndQr({
      connectionUrl: 'chroxy://abc123.trycloudflare.com?token=test-token-123',
      wsUrl: 'wss://abc123.trycloudflare.com/ws',
      httpUrl: 'https://abc123.trycloudflare.com',
      apiToken: 'test-token-123',
      tunnelMode: 'quick',
    })

    render(<ConsolePage />)

    await waitFor(() => {
      expect(screen.getAllByTestId('tunnel-url').length).toBeGreaterThan(0)
    })

    const tunnelEl = screen.getAllByTestId('tunnel-url')[0]!
    expect(tunnelEl.textContent).toBe('https://abc123.trycloudflare.com')

    // Verify /connect was fetched with auth
    const connectCalls = mockFetch.mock.calls.filter((c: unknown[]) => c[0] === '/connect')
    expect(connectCalls.length).toBeGreaterThan(0)
    expect((connectCalls[0]![1] as { headers: { Authorization: string } }).headers.Authorization).toBe('Bearer test-token-123')
  })

  it('masks API token by default with reveal toggle', async () => {
    mockConnectAndQr({
      connectionUrl: 'chroxy://host?token=secret-token',
      wsUrl: 'wss://host/ws',
      httpUrl: 'https://host',
      apiToken: 'secret-token',
      tunnelMode: 'quick',
    })

    render(<ConsolePage />)

    await waitFor(() => {
      expect(screen.getAllByTestId('token-value').length).toBeGreaterThan(0)
    })

    // Token should be masked
    const tokenEl = screen.getAllByTestId('token-value')[0]!
    expect(tokenEl.textContent).toContain('••••••••')

    // Click reveal button
    const revealBtn = screen.getAllByTestId('token-reveal')[0]!
    fireEvent.click(revealBtn)

    // Token should now be visible
    expect(screen.getAllByTestId('token-value')[0]!.textContent).toContain('secret-token')
  })

  it('copies tunnel URL to clipboard on click', async () => {
    mockConnectAndQr({
      connectionUrl: 'chroxy://myhost.com?token=tok',
      wsUrl: 'wss://myhost.com/ws',
      httpUrl: 'https://myhost.com',
      apiToken: 'tok',
      tunnelMode: 'quick',
    })

    render(<ConsolePage />)

    await waitFor(() => {
      expect(screen.getAllByTestId('copy-tunnel-url').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByTestId('copy-tunnel-url')[0]!)

    expect(mockWriteText).toHaveBeenCalledWith('https://myhost.com')
  })

  it('fetches and displays QR code', async () => {
    mockConnectAndQr({
      connectionUrl: 'chroxy://host?token=tok',
      wsUrl: 'wss://host/ws',
      httpUrl: 'https://host',
      apiToken: 'tok',
      tunnelMode: 'quick',
    })

    render(<ConsolePage />)

    await waitFor(() => {
      const containers = screen.getAllByTestId('qr-container')
      expect(containers.length).toBeGreaterThan(0)
      expect(containers[0]!.innerHTML).toContain('mock-qr')
    })
  })

  it('shows error state when /connect fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/connect')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: 'No connection info available' }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    })

    render(<ConsolePage />)

    await waitFor(() => {
      expect(screen.getByText('No connection info available')).toBeTruthy()
    })
  })

  it('shows tunnel mode label', async () => {
    mockConnectAndQr({
      connectionUrl: 'chroxy://host?token=tok',
      wsUrl: 'wss://host/ws',
      httpUrl: 'https://host',
      apiToken: 'tok',
      tunnelMode: 'named',
    })

    render(<ConsolePage />)

    await waitFor(() => {
      expect(screen.getAllByText('named').length).toBeGreaterThan(0)
    })
  })
})
