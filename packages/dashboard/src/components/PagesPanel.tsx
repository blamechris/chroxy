/**
 * PagesPanel (#5689) — dashboard surface for Chroxy Pages (epic #5683).
 *
 * The CLI shipped `chroxy publish` / `chroxy pages list|rm` (#5687); this panel
 * exposes the same so users never drop to a terminal. It lists published pages
 * (title, slug, created, size) with a one-click **copy share URL** and
 * **delete (revoke)**, reusing the existing primary-token-gated HTTP endpoints:
 *
 *   - GET    /api/pages          → { pages: [{ slug, title, createdAt, bytes, path }] }
 *   - POST   /api/pages          → { slug, path, title, bytes, createdAt }  (#6110)
 *   - DELETE /api/pages/<slug>   → { removed: boolean }  (idempotent)
 *
 * Modeled on PoolStatsPanel (#5053): single fetch on mount + a Refresh button,
 * injectable fetch / token / clipboard / origin seams for tests. The
 * "publish this artifact" affordance (#6110) is the in-panel form: paste or load
 * an HTML artifact, POST it to /api/pages, and the returned share URL shows
 * inline (copyable) while the new page drops into the list below.
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
  // #6110: the "publish this artifact" form — paste/load an HTML artifact and
  // POST it to /api/pages, then surface the share URL inline. Form-scoped state
  // (its own error + result) so a publish failure never blanks the page list.
  const [showPublish, setShowPublish] = useState<boolean>(false)
  const [publishTitle, setPublishTitle] = useState<string>('')
  const [publishHtml, setPublishHtml] = useState<string>('')
  const [publishing, setPublishing] = useState<boolean>(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)
  const [publishedCopied, setPublishedCopied] = useState<boolean>(false)

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
  // The "Copied!" flash timer: held in a ref so a repeat click clears the
  // previous timer (one consistent 1.5s window from the latest click, no
  // overlapping timers) and so it's torn down on unmount.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    void refreshRef.current()
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopy = useCallback(async (page: PageEntry) => {
    const ok = await resolvedCopy(`${resolvedOrigin}${page.path}`)
    if (ok) {
      setCopiedSlug(page.slug)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null
        setCopiedSlug((s) => (s === page.slug ? null : s))
      }, 1500)
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

  // #6110: load an HTML file into the form (drop the chrome of pasting). Seeds
  // the title from the filename when the title is still blank.
  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    setPublishError(null)
    try {
      const text = await file.text()
      setPublishHtml(text)
      setPublishTitle((t) => t || file.name.replace(/\.html?$/i, ''))
    } catch {
      setPublishError(`Could not read ${file.name}`)
    }
  }, [])

  // #6110: POST the artifact to the existing primary-token-gated /api/pages,
  // surface the returned share URL inline (copyable), and refresh so the new
  // page appears in the list below. The 403 `primary_token_required` from the
  // endpoint propagates as the inline error (a bound token can't publish).
  const handlePublish = useCallback(async () => {
    if (!publishHtml.trim()) {
      setPublishError('Paste or load some HTML to publish.')
      return
    }
    setPublishError(null)
    setPublishedUrl(null)
    setPublishedCopied(false)
    setPublishing(true)
    try {
      const res = await resolvedFetch('/api/pages', {
        method: 'POST',
        headers: { ...(authHeaders() ?? {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: publishTitle.trim() || 'Untitled', html: publishHtml }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { path?: string; slug?: string }
      if (body.path) {
        setPublishedUrl(`${resolvedOrigin}${body.path}`)
      } else {
        // Published, but no path to link — surface a note rather than a dead
        // (empty-href) link. Defensive: today's server always returns a path.
        setPublishError('Published, but the server returned no share URL.')
      }
      setPublishTitle('')
      setPublishHtml('')
      // The new page now exists server-side — reflect it in the list.
      await refresh()
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Failed to publish')
    } finally {
      setPublishing(false)
    }
  }, [publishHtml, publishTitle, resolvedFetch, authHeaders, resolvedOrigin, refresh])

  const handleCopyPublished = useCallback(async () => {
    if (!publishedUrl) return
    const ok = await resolvedCopy(publishedUrl)
    if (ok) {
      setPublishedCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null
        setPublishedCopied(false)
      }, 1500)
    }
  }, [publishedUrl, resolvedCopy])

  const list = pages ?? []

  return (
    <div className="environment-panel" data-testid="pages-panel">
      <div className="env-panel-header">
        <h2>Pages</h2>
        <div style={{ display: 'flex', gap: '0.5em' }}>
          <button
            className="btn-env-new"
            data-testid="pages-publish-toggle"
            onClick={() => setShowPublish((v) => !v)}
            aria-expanded={showPublish}
          >
            {showPublish ? 'Cancel' : '+ Publish HTML'}
          </button>
          <button
            className="btn-env-new"
            data-testid="pages-refresh"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {showPublish && (
        <div className="env-card" data-testid="pages-publish-form" style={{ marginBottom: '0.75em' }}>
          <div className="env-card-details">
            <label className="env-card-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.25em' }}>
              <span className="env-card-label">Title</span>
              <input
                type="text"
                data-testid="pages-publish-title"
                value={publishTitle}
                onChange={(e) => setPublishTitle(e.target.value)}
                placeholder="Untitled"
                disabled={publishing}
              />
            </label>
            <label className="env-card-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.25em' }}>
              <span className="env-card-label">HTML</span>
              <textarea
                data-testid="pages-publish-html"
                value={publishHtml}
                onChange={(e) => setPublishHtml(e.target.value)}
                placeholder="Paste a self-contained HTML artifact, or load a .html file below"
                rows={6}
                disabled={publishing}
                style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8em', resize: 'vertical' }}
              />
            </label>
            <label className="env-card-row" style={{ gap: '0.5em' }}>
              <span className="env-card-label">Load file</span>
              <input
                type="file"
                accept=".html,.htm,text/html"
                data-testid="pages-publish-file"
                disabled={publishing}
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
            </label>
          </div>
          {publishError && (
            <div
              className="env-empty"
              data-testid="pages-publish-error"
              style={{ color: 'var(--status-error, #ef4444)' }}
            >
              {publishError}
            </div>
          )}
          {publishedUrl !== null && (
            <div className="env-card-row" data-testid="pages-publish-result" style={{ gap: '0.5em', alignItems: 'center' }}>
              <span className="env-card-label">Published</span>
              <a href={publishedUrl} target="_blank" rel="noreferrer" data-testid="pages-publish-result-url" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8em', wordBreak: 'break-all' }}>
                {publishedUrl}
              </a>
              <button
                className="btn-env-action"
                data-testid="pages-publish-result-copy"
                onClick={() => void handleCopyPublished()}
              >
                {publishedCopied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
          )}
          <div className="env-card-actions">
            <button
              className="btn-env-action"
              data-testid="pages-publish-submit"
              onClick={() => void handlePublish()}
              disabled={publishing || !publishHtml.trim()}
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        </div>
      )}

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
