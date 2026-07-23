import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { PairedDevicesPanel, type PairedDevice } from './PairedDevicesPanel'

function makeDevice(overrides: Partial<PairedDevice> & { id: string }): PairedDevice {
  return {
    sessionId: null,
    createdAt: Date.now() - 5000,
    ageMs: 5000,
    deviceName: null,
    ...overrides,
  }
}

function makeFetch(handlers: {
  list?: (init?: RequestInit) => Response | Promise<Response>
  revoke?: (id: string, init?: RequestInit) => Response | Promise<Response>
  revokeAll?: (init?: RequestInit) => Response | Promise<Response>
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (init?.method === 'DELETE' && url === '/api/paired-devices') {
      if (handlers.revokeAll) return handlers.revokeAll(init)
      return new Response(JSON.stringify({ ok: true, revoked: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (init?.method === 'DELETE' && url.startsWith('/api/paired-devices/')) {
      const id = decodeURIComponent(url.slice('/api/paired-devices/'.length))
      if (handlers.revoke) return handlers.revoke(id, init)
      return new Response(JSON.stringify({ ok: true, revoked: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/paired-devices') {
      if (handlers.list) return handlers.list(init)
      return new Response(JSON.stringify({ devices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

function listOf(devices: PairedDevice[]) {
  return () =>
    new Response(JSON.stringify({ devices }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
}

describe('PairedDevicesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the empty state when no devices are paired', async () => {
    const fetchImpl = makeFetch({})
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-empty')).toBeTruthy()
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/paired-devices', expect.objectContaining({
      headers: { Authorization: 'Bearer tok' },
    }))
  })

  it('renders one card per device with access and last-seen', async () => {
    const fetchImpl = makeFetch({
      list: listOf([
        makeDevice({ id: 'dev-bound', sessionId: 'sess-123456789012345', ageMs: 30000 }),
        makeDevice({ id: 'dev-unbound', sessionId: null, ageMs: 3600_000 }),
      ]),
    })
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)

    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-bound')).toBeTruthy()
      expect(screen.getByTestId('paired-device-card-dev-unbound')).toBeTruthy()
    })
    expect(screen.getByTestId('paired-device-access-dev-bound').textContent).toBe('Single session')
    expect(screen.getByTestId('paired-device-access-dev-unbound').textContent).toBe('Full access (unbound)')
    // Bound token shows a truncated session handle.
    expect(screen.getByText('sess-1234567…')).toBeTruthy()
    expect(screen.getByTestId('paired-device-age-dev-unbound').textContent).toContain('Last seen 1h ago')
  })

  it('does not render the wire id as token material (id only used as a handle)', async () => {
    const fetchImpl = makeFetch({ list: listOf([makeDevice({ id: 'abc123handle' })]) })
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-abc123handle')).toBeTruthy()
    })
    // The id is not shown as visible text anywhere in the card body.
    expect(screen.queryByText('abc123handle')).toBeNull()
  })

  it('surfaces the error when the list fetch fails', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(JSON.stringify({ error: 'primary_token_required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-error').textContent).toBe('primary_token_required')
    })
  })

  it('revoke flow: confirm → DELETE :id → row removed', async () => {
    const seen: Array<{ url: string; method: string }> = []
    let listCalled = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      seen.push({ url, method: init?.method ?? 'GET' })
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, revoked: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      listCalled += 1
      const devices = listCalled === 1 ? [makeDevice({ id: 'dev-X' })] : []
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-X')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('paired-device-revoke-dev-X'))
    fireEvent.click(screen.getByTestId('paired-device-confirm-yes-dev-X'))

    await waitFor(() => {
      expect(screen.queryByTestId('paired-device-card-dev-X')).toBeNull()
    })
    const deleteCall = seen.find((c) => c.method === 'DELETE')
    expect(deleteCall?.url).toBe('/api/paired-devices/dev-X')
  })

  it('revoke cancel keeps the row and issues no DELETE', async () => {
    const fetchImpl = makeFetch({ list: listOf([makeDevice({ id: 'dev-keep' })]) })
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-keep')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('paired-device-revoke-dev-keep'))
    fireEvent.click(screen.getByTestId('paired-device-confirm-no-dev-keep'))
    expect(screen.getByTestId('paired-device-revoke-dev-keep')).toBeTruthy()
    const deleteCalls = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deleteCalls.length).toBe(0)
  })

  it('surfaces a revoke failure without removing the row', async () => {
    const fetchImpl = makeFetch({
      list: listOf([makeDevice({ id: 'dev-fail' })]),
      revoke: () =>
        new Response(JSON.stringify({ error: 'no such paired device', revoked: 0 }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-fail')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('paired-device-revoke-dev-fail'))
    fireEvent.click(screen.getByTestId('paired-device-confirm-yes-dev-fail'))
    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-error').textContent).toBe('no such paired device')
    })
    expect(screen.getByTestId('paired-device-card-dev-fail')).toBeTruthy()
  })

  it('revoke-all panic button: confirm → DELETE /api/paired-devices → all rows cleared', async () => {
    const seen: Array<{ url: string; method: string }> = []
    let listCalled = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      seen.push({ url, method: init?.method ?? 'GET' })
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, revoked: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      listCalled += 1
      const devices =
        listCalled === 1 ? [makeDevice({ id: 'dev-a' }), makeDevice({ id: 'dev-b' })] : []
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-a')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('paired-devices-revoke-all'))
    fireEvent.click(screen.getByTestId('paired-devices-revoke-all-yes'))

    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-empty')).toBeTruthy()
    })
    const del = seen.find((c) => c.method === 'DELETE')
    expect(del?.url).toBe('/api/paired-devices')
  })

  it('revoke-all is hidden when there are no devices', async () => {
    const fetchImpl = makeFetch({})
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-empty')).toBeTruthy()
    })
    expect(screen.queryByTestId('paired-devices-revoke-all')).toBeNull()
  })

  it('auto-clears the revoke-all confirmation when the device list drops to zero', async () => {
    let listCalled = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (init?.method === 'DELETE' && url.startsWith('/api/paired-devices/')) {
        return new Response(JSON.stringify({ ok: true, revoked: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      listCalled += 1
      // 1st call: initial load with a device. 2nd (post-revoke reconcile): empty.
      // 3rd+ (manual refresh): a new device reappears, e.g. a fresh pairing.
      const devices =
        listCalled === 1
          ? [makeDevice({ id: 'dev-a' })]
          : listCalled === 2
            ? []
            : [makeDevice({ id: 'dev-new' })]
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-a')).toBeTruthy()
    })

    // Open the "Revoke ALL devices?" confirmation.
    fireEvent.click(screen.getByTestId('paired-devices-revoke-all'))
    expect(screen.getByTestId('paired-devices-revoke-all-confirm')).toBeTruthy()

    // Revoke the last remaining device individually (not via revoke-all), so
    // the roster empties while `confirmingAll` is still true.
    fireEvent.click(screen.getByTestId('paired-device-revoke-dev-a'))
    fireEvent.click(screen.getByTestId('paired-device-confirm-yes-dev-a'))
    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-empty')).toBeTruthy()
    })

    // A device reappears (refresh / new pairing) — the stale "Revoke ALL
    // devices?" confirmation must not resurface.
    fireEvent.click(screen.getByTestId('paired-devices-refresh'))
    await waitFor(() => {
      expect(screen.getByTestId('paired-device-card-dev-new')).toBeTruthy()
    })
    expect(screen.queryByTestId('paired-devices-revoke-all-confirm')).toBeNull()
    expect(screen.getByTestId('paired-devices-revoke-all')).toBeTruthy()
  })

  it('refresh button re-fetches', async () => {
    const fetchImpl = makeFetch({ list: listOf([]) })
    render(<PairedDevicesPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('paired-devices-empty')).toBeTruthy()
    })
    const initial = fetchImpl.mock.calls.length
    fireEvent.click(screen.getByTestId('paired-devices-refresh'))
    await waitFor(() => {
      expect(fetchImpl.mock.calls.length).toBe(initial + 1)
    })
  })
})
