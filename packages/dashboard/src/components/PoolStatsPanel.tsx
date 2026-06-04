/**
 * PoolStatsPanel (#5053) — docker-byok container pool observability.
 *
 * The server pool (#5051) emits structured lifecycle events; a server-side
 * aggregator (#5053) accumulates them into a rolling snapshot exposed at
 * GET /api/pool/stats. This panel polls that endpoint and renders:
 *
 *   - Pool size: total parked containers + a per-key breakdown
 *     (size + oldest idle age, from pool.inspect()).
 *   - Hit rate: hits / (hits + misses) over the aggregator's lifetime.
 *   - Recent evictions: the tail of the last N evictions, newest-first,
 *     plus an eviction-by-reason summary (idle / over_cap / shutdown /
 *     over_age / soiled / …).
 *
 * The pool is default-OFF (CHROXY_DOCKER_BYOK_POOL=1). The endpoint returns
 * `{ enabled: false }` when the pool is disabled; this panel renders a short
 * "disabled" notice in that case (App.tsx still mounts the tab, but the body
 * is driven by the snapshot's `enabled` flag).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from '../utils/auth'

export interface PoolBucket {
  key: string
  size: number
  oldestIdleMs: number
}

export interface PoolEviction {
  key: string
  containerId: string | null
  reason: string
  timestamp: number
}

export interface PoolStats {
  enabled: boolean
  hits?: number
  misses?: number
  releases?: number
  shutdowns?: number
  hitRate?: number
  totalSize?: number
  buckets?: PoolBucket[]
  evictionsByReason?: Record<string, number>
  recentEvictions?: PoolEviction[]
}

interface PoolStatsPanelProps {
  /**
   * Override the fetch impl. Tests inject a stub; production omits it and
   * gets the real `window.fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * Override the auth token resolver. Tests pass a fixed string; production
   * omits it and uses the shared `getAuthToken()`.
   */
  getToken?: () => string | null
  /**
   * Poll interval in ms. Tests pass 0 to disable the timer (single fetch on
   * mount). Production omits it and gets the default.
   */
  pollMs?: number
}

const DEFAULT_POLL_MS = 5000

function formatHitRate(rate: number | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

function formatIdle(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return d.toLocaleTimeString()
}

export function PoolStatsPanel({ fetchImpl, getToken, pollMs }: PoolStatsPanelProps = {}) {
  const [stats, setStats] = useState<PoolStats | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Hoist for testability — production passes neither override.
  const resolvedFetch: typeof fetch =
    fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init))
  const resolvedGetToken = getToken ?? getAuthToken
  const interval = pollMs ?? DEFAULT_POLL_MS

  // Keep the latest fetch in a ref so the polling effect can call it without
  // re-subscribing the timer on every render.
  const refresh = useCallback(async () => {
    setError(null)
    const token = resolvedGetToken()
    try {
      const res = await resolvedFetch('/api/pool/stats', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as PoolStats
      setStats(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pool stats')
    } finally {
      setLoading(false)
    }
  }, [resolvedFetch, resolvedGetToken])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    void refreshRef.current()
    if (interval <= 0) return
    const id = setInterval(() => {
      void refreshRef.current()
    }, interval)
    return () => clearInterval(id)
  }, [interval])

  const enabled = stats?.enabled === true
  const buckets = stats?.buckets ?? []
  const recent = stats?.recentEvictions ?? []
  const byReason = stats?.evictionsByReason ?? {}
  const reasonEntries = Object.entries(byReason).sort((a, b) => b[1] - a[1])

  return (
    <div className="environment-panel" data-testid="pool-stats-panel">
      <div className="env-panel-header">
        <h2>Container Pool</h2>
        <button
          className="btn-env-new"
          data-testid="pool-stats-refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div
          className="env-empty"
          data-testid="pool-stats-error"
          style={{ color: 'var(--status-error, #ef4444)' }}
        >
          {error}
        </div>
      )}

      {!error && stats && !enabled && (
        <div className="env-empty" data-testid="pool-stats-disabled">
          <p>The docker-byok container pool is disabled.</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>
            Set <code>CHROXY_DOCKER_BYOK_POOL=1</code> on the server to enable
            cross-session container reuse, then this panel will show pool size,
            hit rate, and recent evictions.
          </p>
        </div>
      )}

      {!error && enabled && stats && (
        <div data-testid="pool-stats-body">
          {/* Headline counters */}
          <div className="env-card" data-testid="pool-stats-summary">
            <div className="env-card-details">
              <div className="env-card-row">
                <span className="env-card-label">Hit rate</span>
                <span className="env-card-value" data-testid="pool-stats-hitrate">
                  {formatHitRate(stats.hitRate)}
                </span>
              </div>
              <div className="env-card-row">
                <span className="env-card-label">Hits / Misses</span>
                <span className="env-card-value" data-testid="pool-stats-hitmiss">
                  {stats.hits ?? 0} / {stats.misses ?? 0}
                </span>
              </div>
              <div className="env-card-row">
                <span className="env-card-label">Parked containers</span>
                <span className="env-card-value" data-testid="pool-stats-total-size">
                  {stats.totalSize ?? 0}
                </span>
              </div>
              {typeof stats.shutdowns === 'number' && stats.shutdowns > 0 && (
                <div className="env-card-row">
                  <span className="env-card-label">Shutdowns</span>
                  <span className="env-card-value">{stats.shutdowns}</span>
                </div>
              )}
            </div>
          </div>

          {/* Per-key parked buckets */}
          <h3 style={{ marginTop: '1rem' }}>Parked by key</h3>
          {buckets.length === 0 ? (
            <div className="env-empty" data-testid="pool-stats-buckets-empty">
              No containers parked.
            </div>
          ) : (
            <div className="env-grid">
              {buckets.map((b) => (
                <div
                  className="env-card"
                  key={b.key}
                  data-testid={`pool-bucket-${b.key}`}
                >
                  <div className="env-card-header">
                    <span
                      className="env-card-name"
                      style={{
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: '0.8em',
                        wordBreak: 'break-all',
                      }}
                    >
                      {b.key}
                    </span>
                  </div>
                  <div className="env-card-details">
                    <div className="env-card-row">
                      <span className="env-card-label">Size</span>
                      <span className="env-card-value">{b.size}</span>
                    </div>
                    <div className="env-card-row">
                      <span className="env-card-label">Oldest idle</span>
                      <span className="env-card-value">{formatIdle(b.oldestIdleMs)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Eviction-by-reason summary */}
          <h3 style={{ marginTop: '1rem' }}>Evictions by reason</h3>
          {reasonEntries.length === 0 ? (
            <div className="env-empty" data-testid="pool-stats-evictions-empty">
              No evictions recorded.
            </div>
          ) : (
            <div className="env-card" data-testid="pool-stats-evictions-by-reason">
              <div className="env-card-details">
                {reasonEntries.map(([reason, count]) => (
                  <div className="env-card-row" key={reason}>
                    <span
                      className="env-card-label"
                      data-testid={`pool-eviction-reason-${reason}`}
                    >
                      {reason}
                    </span>
                    <span className="env-card-value">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent evictions tail (newest-first) */}
          {recent.length > 0 && (
            <>
              <h3 style={{ marginTop: '1rem' }}>Recent evictions</h3>
              <div className="env-card" data-testid="pool-stats-recent-evictions">
                <div className="env-card-details">
                  {recent
                    .slice()
                    .reverse()
                    .map((e, i) => (
                      <div
                        className="env-card-row"
                        key={`${e.containerId ?? 'x'}-${e.timestamp}-${i}`}
                        data-testid="pool-recent-eviction"
                      >
                        <span
                          className="env-card-label"
                          style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8em' }}
                        >
                          {e.containerId ? e.containerId.slice(0, 12) : '—'}
                        </span>
                        <span className="env-card-value">
                          {e.reason}
                          {Number.isFinite(e.timestamp) && (
                            <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
                              {formatTimestamp(e.timestamp)}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
