/**
 * PagesPanel (#5689) — dashboard surface for Chroxy Pages (epic #5683).
 *
 * The CLI shipped `chroxy publish` / `chroxy pages list|rm` (#5687); this panel
 * exposes the same so users never drop to a terminal. It lists published pages
 * (title, slug, created, size) with a one-click **copy share URL** and
 * **delete (revoke)**, reusing the existing primary-token-gated HTTP endpoints:
 *
 *   - GET    /api/pages          → { pages: [{ slug, title, createdAt, bytes, path }] }
 *   - DELETE /api/pages/<slug>   → { removed: boolean }  (idempotent)
 *
 * Modeled on PoolStatsPanel (#5053): single fetch on mount + a Refresh button,
 * injectable fetch / token / clipboard / origin seams for tests. The
 * "publish this artifact" affordance from #5689 is a separate follow-up.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from '../utils/auth'
import { writeText } from '../utils/clipboard'

export interface PageEntry {
  slug: string
  title: string
  createdAt: string
  bytes: number
  /** Server-relative page path, e.g. `/p/<slug>/`. */
  path: string
}

interface PagesPanelProps {
  /** Override the fetch impl. Tests inject a stub; production gets window.fetch. */
  fetchImpl?: typeof fetch
  /** Override the auth-token resolver. Tests pass a fixed string. */
  getToken?: () => string | null
  /** Override the clipboard writer. Tests inject a spy; production gets writeText. */
  copyImpl?: (text: string) => Promise<boolean>
  /** Override the share-URL origin. Tests pass a fixed value; production uses window.location.origin. */
  origin?: string
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCreated(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  return new Date(ms).toLocaleString()
}

export function PagesPanel({ fetchImpl, getToken, copyImpl, origin }: PagesPanelProps = {}) {
  const [pages, setPages] = useState<PageEntry[] | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)

  const resolvedFetch: typeof fetch =
    fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init))
  const resolvedGetToken = getToken ?? getAuthToken
  const resolvedCopy = copyImpl ?? writeText
  const resolvedOrigin = origin ?? (typeof window !== 'undefined' ? window.location.origin : '')

  const authHeaders = useCallback((): HeadersInit | undefined => {
    const token = resolvedGetToken()
    return token ? { Authorization: `Bearer ${token}` } : undefined
  }, [resolvedGetToken])

  const refresh = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await resolvedFetch('/api/pages', { headers: authHeaders() })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { pages?: PageEntry[] }
      setPages(Array.isArray(body.pages) ? body.pages : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pages')
    } finally {
      setLoading(false)
    }
  }, [resolvedFetch, authHeaders])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    void refreshRef.current()
  }, [])

  const handleCopy = useCallback(async (page: PageEntry) => {
    const ok = await resolvedCopy(`${resolvedOrigin}${page.path}`)
    if (ok) {
      setCopiedSlug(page.slug)
      setTimeout(() => setCopiedSlug((s) => (s === page.slug ? null : s)), 1500)
    }
  }, [resolvedCopy, resolvedOrigin])

  const handleDelete = useCallback(async (slug: string) => {
    setError(null)
    setDeletingSlug(slug)
    try {
      const res = await resolvedFetch(`/api/pages/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      // Optimistically drop the row; the server delete is idempotent.
      setPages((prev) => (prev ? prev.filter((p) => p.slug !== slug) : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to delete ${slug}`)
    } finally {
      setDeletingSlug((s) => (s === slug ? null : s))
    }
  }, [resolvedFetch, authHeaders])

  const list = pages ?? []

  return (
    <div className="environment-panel" data-testid="pages-panel">
      <div className="env-panel-header">
        <h2>Pages</h2>
        <button
          className="btn-env-new"
          data-testid="pages-refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div
          className="env-empty"
          data-testid="pages-error"
          style={{ color: 'var(--status-error, #ef4444)' }}
        >
          {error}
        </div>
      )}

      {!error && pages && list.length === 0 && (
        <div className="env-empty" data-testid="pages-empty">
          <p>No pages published yet.</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>
            Publish an HTML artifact with <code>chroxy publish &lt;file&gt;</code> and it
            appears here with a shareable link.
          </p>
        </div>
      )}

      {/* The list renders whenever pages are known — a transient action error
          (e.g. a failed delete) shows in the banner above WITHOUT blanking the
          still-valid list. Only an initial-load failure (pages === null) shows
          the error in place of the list. */}
      {list.length > 0 && (
        <div className="env-grid" data-testid="pages-list">
          {list.map((p) => (
            <div className="env-card" key={p.slug} data-testid={`page-card-${p.slug}`}>
              <div className="env-card-header">
                <span className="env-card-name" data-testid={`page-title-${p.slug}`}>{p.title || p.slug}</span>
              </div>
              <div className="env-card-details">
                <div className="env-card-row">
                  <span className="env-card-label">Slug</span>
                  <span className="env-card-value" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8em' }}>{p.slug}</span>
                </div>
                <div className="env-card-row">
                  <span className="env-card-label">Created</span>
                  <span className="env-card-value">{formatCreated(p.createdAt)}</span>
                </div>
                <div className="env-card-row">
                  <span className="env-card-label">Size</span>
                  <span className="env-card-value">{formatBytes(p.bytes)}</span>
                </div>
              </div>
              <div className="env-card-actions">
                <button
                  className="btn-env-action"
                  data-testid={`page-copy-${p.slug}`}
                  onClick={() => void handleCopy(p)}
                >
                  {copiedSlug === p.slug ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  className="btn-env-action btn-env-danger"
                  data-testid={`page-delete-${p.slug}`}
                  onClick={() => void handleDelete(p.slug)}
                  disabled={deletingSlug === p.slug}
                >
                  {deletingSlug === p.slug ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
