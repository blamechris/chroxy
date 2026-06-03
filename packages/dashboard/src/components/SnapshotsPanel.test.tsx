import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SnapshotsPanel, type Snapshot } from './SnapshotsPanel'

function makeSnap(overrides: Partial<Snapshot> & { slug: string }): Snapshot {
  return {
    tag: `chroxy-byok-snap:${overrides.slug}`,
    name: '',
    createdAt: '2024-06-01T12:00:00Z',
    sourceCwd: '/repo',
    sourceImage: 'node:22-slim',
    sourceSessionId: null,
    ...overrides,
  }
}

function makeFetch(handlers: {
  list?: (init?: RequestInit) => Response | Promise<Response>
  del?: (slug: string, init?: RequestInit) => Response | Promise<Response>
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (init?.method === 'DELETE' && url.startsWith('/api/snapshots/')) {
      const slug = decodeURIComponent(url.slice('/api/snapshots/'.length))
      if (handlers.del) return handlers.del(slug, init)
      return new Response(JSON.stringify({ ok: true, tag: '', imageRemoved: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/snapshots') {
      if (handlers.list) return handlers.list(init)
      return new Response(JSON.stringify({ snapshots: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('SnapshotsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows empty state when the server returns no snapshots', async () => {
    const fetchImpl = makeFetch({})
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('snapshots-empty')).toBeTruthy()
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/snapshots', expect.objectContaining({
      headers: { Authorization: 'Bearer tok' },
    }))
  })

  it('renders one card per snapshot with name, tag, cwd, base image, session', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(
          JSON.stringify({
            snapshots: [
              makeSnap({
                slug: 'snap-1',
                name: 'feature-a',
                tag: 'chroxy-byok-snap:abc-1',
                sourceCwd: '/Users/dev/projA',
                sourceImage: 'node:22-slim',
                sourceSessionId: 'sess-123',
              }),
              makeSnap({
                slug: 'snap-2',
                name: 'bugfix-b',
                tag: 'chroxy-byok-snap:abc-2',
                sourceCwd: '/Users/dev/projB',
                sourceImage: 'python:3.12',
              }),
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)

    await waitFor(() => {
      expect(screen.getByTestId('snapshot-card-snap-1')).toBeTruthy()
      expect(screen.getByTestId('snapshot-card-snap-2')).toBeTruthy()
    })

    expect(screen.getByTestId('snapshot-name-snap-1').textContent).toBe('feature-a')
    expect(screen.getByTestId('snapshot-tag-snap-1').textContent).toBe('chroxy-byok-snap:abc-1')
    expect(screen.getByText('/Users/dev/projA')).toBeTruthy()
    expect(screen.getByText('sess-123')).toBeTruthy()

    expect(screen.getByTestId('snapshot-name-snap-2').textContent).toBe('bugfix-b')
    expect(screen.getByText('python:3.12')).toBeTruthy()
  })

  it('falls back to slug when name is empty', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(
          JSON.stringify({
            snapshots: [makeSnap({ slug: 'snap-only', name: '' })],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('snapshot-name-snap-only').textContent).toBe('snap-only')
    })
  })

  it('shows the error when /api/snapshots fails', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('snapshots-error').textContent).toBe('boom')
    })
  })

  it('refresh button re-fetches the list', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(JSON.stringify({ snapshots: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('snapshots-empty')).toBeTruthy()
    })
    const initialCalls = fetchImpl.mock.calls.length
    fireEvent.click(screen.getByTestId('snapshots-refresh'))
    await waitFor(() => {
      expect(fetchImpl.mock.calls.length).toBe(initialCalls + 1)
    })
  })

  it('delete flow: confirm → DELETE call → row removed', async () => {
    const seen: Array<{ url: string; method: string }> = []
    let listCalled = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      seen.push({ url, method: init?.method ?? 'GET' })
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, tag: 'chroxy-byok-snap:x', imageRemoved: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      listCalled += 1
      // First list returns one row, every subsequent list returns nothing
      // so we exercise both the optimistic removal path AND the refresh
      // reconciliation that follows a successful delete.
      const snaps = listCalled === 1 ? [makeSnap({ slug: 'snap-X', tag: 'chroxy-byok-snap:x' })] : []
      return new Response(JSON.stringify({ snapshots: snaps }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)

    await waitFor(() => {
      expect(screen.getByTestId('snapshot-card-snap-X')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('snapshot-delete-snap-X'))
    fireEvent.click(screen.getByTestId('snapshot-confirm-yes-snap-X'))

    await waitFor(() => {
      expect(screen.queryByTestId('snapshot-card-snap-X')).toBeNull()
    })

    // Last DELETE must have hit the right URL.
    const deleteCall = seen.find((c) => c.method === 'DELETE')
    expect(deleteCall?.url).toBe('/api/snapshots/snap-X')
  })

  it('delete cancel keeps the row', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(
          JSON.stringify({ snapshots: [makeSnap({ slug: 'snap-keep' })] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)

    await waitFor(() => {
      expect(screen.getByTestId('snapshot-card-snap-keep')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('snapshot-delete-snap-keep'))
    fireEvent.click(screen.getByTestId('snapshot-confirm-no-snap-keep'))

    // Still rendered, delete button is back.
    expect(screen.getByTestId('snapshot-delete-snap-keep')).toBeTruthy()
    // And we never issued a DELETE.
    const deleteCalls = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deleteCalls.length).toBe(0)
  })

  it('surfaces a delete failure error without removing the row', async () => {
    const fetchImpl = makeFetch({
      list: () =>
        new Response(
          JSON.stringify({ snapshots: [makeSnap({ slug: 'snap-fail' })] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      del: () =>
        new Response(JSON.stringify({ error: 'rmi blocked' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    render(<SnapshotsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} />)
    await waitFor(() => {
      expect(screen.getByTestId('snapshot-card-snap-fail')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('snapshot-delete-snap-fail'))
    fireEvent.click(screen.getByTestId('snapshot-confirm-yes-snap-fail'))
    await waitFor(() => {
      expect(screen.getByTestId('snapshots-error').textContent).toBe('rmi blocked')
    })
    expect(screen.getByTestId('snapshot-card-snap-fail')).toBeTruthy()
  })
})
