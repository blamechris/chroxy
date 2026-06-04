import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { PoolStatsPanel, type PoolStats } from './PoolStatsPanel'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFetch(handler: (init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url === '/api/pool/stats') return handler(init)
    return new Response('not found', { status: 404 })
  })
}

const ENABLED_STATS: PoolStats = {
  enabled: true,
  hits: 8,
  misses: 2,
  releases: 5,
  shutdowns: 1,
  hitRate: 0.8,
  totalSize: 3,
  buckets: [
    { key: 'node:22|/repo|512m|1|root', size: 2, oldestIdleMs: 65000 },
    { key: 'python:3.12|/app|512m|1|root', size: 1, oldestIdleMs: 5000 },
  ],
  evictionsByReason: { idle: 4, over_cap: 1 },
  recentEvictions: [
    { key: 'k', containerId: 'aaaaaaaaaaaa11', reason: 'idle', timestamp: 1000 },
    { key: 'k', containerId: 'bbbbbbbbbbbb22', reason: 'over_cap', timestamp: 2000 },
  ],
}

describe('PoolStatsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('sends the bearer token on the stats request', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ enabled: false }))
    render(
      <PoolStatsPanel
        fetchImpl={fetchImpl as unknown as typeof fetch}
        getToken={() => 'tok'}
        pollMs={0}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-disabled')).toBeTruthy()
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/pool/stats', expect.objectContaining({
      headers: { Authorization: 'Bearer tok' },
    }))
  })

  it('renders the disabled notice when the pool is off', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ enabled: false }))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-disabled')).toBeTruthy()
    })
    // The enabled body must not render.
    expect(screen.queryByTestId('pool-stats-body')).toBeNull()
  })

  it('renders hit rate, hits/misses, and total parked size when enabled', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(ENABLED_STATS))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-body')).toBeTruthy()
    })
    expect(screen.getByTestId('pool-stats-hitrate').textContent).toBe('80.0%')
    expect(screen.getByTestId('pool-stats-hitmiss').textContent).toBe('8 / 2')
    expect(screen.getByTestId('pool-stats-total-size').textContent).toBe('3')
  })

  it('renders per-key buckets with size and oldest idle age', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(ENABLED_STATS))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-bucket-node:22|/repo|512m|1|root')).toBeTruthy()
    })
    expect(screen.getByTestId('pool-bucket-python:3.12|/app|512m|1|root')).toBeTruthy()
    // 65000ms -> "1m 5s"
    expect(screen.getByText('1m 5s')).toBeTruthy()
  })

  it('renders eviction-by-reason counts', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(ENABLED_STATS))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-evictions-by-reason')).toBeTruthy()
    })
    expect(screen.getByTestId('pool-eviction-reason-idle')).toBeTruthy()
    expect(screen.getByTestId('pool-eviction-reason-over_cap')).toBeTruthy()
  })

  it('renders the recent evictions tail newest-first', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(ENABLED_STATS))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-recent-evictions')).toBeTruthy()
    })
    const rows = screen.getAllByTestId('pool-recent-eviction')
    expect(rows.length).toBe(2)
    // Newest (over_cap, ts 2000) first, then idle.
    expect(rows[0]?.textContent).toContain('bbbbbbbbbbbb')
    expect(rows[0]?.textContent).toContain('over_cap')
    expect(rows[1]?.textContent).toContain('aaaaaaaaaaaa')
  })

  it('shows empty states for buckets and evictions when none exist', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        enabled: true,
        hits: 0,
        misses: 0,
        hitRate: 0,
        totalSize: 0,
        buckets: [],
        evictionsByReason: {},
        recentEvictions: [],
      }),
    )
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-buckets-empty')).toBeTruthy()
    })
    expect(screen.getByTestId('pool-stats-evictions-empty')).toBeTruthy()
    // Hit rate with 0/0 must render 0.0%, not NaN.
    expect(screen.getByTestId('pool-stats-hitrate').textContent).toBe('0.0%')
  })

  it('surfaces an error when the endpoint fails', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ error: 'kaboom' }, 500))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-error').textContent).toBe('kaboom')
    })
  })

  it('refresh button re-fetches', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ enabled: false }))
    render(
      <PoolStatsPanel fetchImpl={fetchImpl as unknown as typeof fetch} getToken={() => 'tok'} pollMs={0} />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('pool-stats-disabled')).toBeTruthy()
    })
    const initial = fetchImpl.mock.calls.length
    fireEvent.click(screen.getByTestId('pool-stats-refresh'))
    await waitFor(() => {
      expect(fetchImpl.mock.calls.length).toBe(initial + 1)
    })
  })

  it('polls on the configured interval and clears the timer on unmount', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = makeFetch(() => jsonResponse({ enabled: false }))
      const { unmount } = render(
        <PoolStatsPanel
          fetchImpl={fetchImpl as unknown as typeof fetch}
          getToken={() => 'tok'}
          pollMs={1000}
        />,
      )
      // Initial mount fetch.
      await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBe(1))
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchImpl.mock.calls.length).toBe(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchImpl.mock.calls.length).toBe(3)
      // After unmount the timer must stop firing.
      unmount()
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchImpl.mock.calls.length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
