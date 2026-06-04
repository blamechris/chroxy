/**
 * SnapshotsPanel (#5074) — list and manage docker-byok snapshots.
 *
 * docker-byok sessions can `snapshot({ name })` their writable layer
 * into a tagged image (chroxy-byok-snap:<rand>-<ts>) and write a
 * metadata sidecar to `${CHROXY_CONFIG_DIR ?? ~/.chroxy}/snapshots/`.
 * Until now the dashboard had no surface for those sidecars — operators
 * had to `ls ~/.chroxy/snapshots` and `docker image rm` by hand.
 *
 * This panel fetches GET /api/snapshots on mount + on a manual refresh,
 * renders one card per snapshot with name / createdAt / sourceCwd /
 * sourceSessionId / source image, and exposes a confirm-gated Delete
 * button that hits DELETE /api/snapshots/:slug.
 *
 * "Start session from snapshot" is explicitly deferred to a follow-up
 * (issue #5074 lists it as a separate bullet point — wiring
 * `snapshotImage` through SessionManager / the WS protocol is a larger
 * surface than this panel can own on its own).
 */
import { useCallback, useEffect, useState } from 'react'
import { getAuthToken } from '../utils/auth'

export interface Snapshot {
  tag: string
  name: string
  createdAt: string
  sourceCwd: string
  sourceImage: string
  sourceSessionId: string | null
  slug: string
}

interface SnapshotsPanelProps {
  /**
   * Override the fetch impl. Tests inject a stub; production omits it
   * and gets the real `window.fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * Override the auth token resolver. Tests skip the URL/cookie lookup
   * by passing a no-op or fixed string; production omits it and uses
   * the shared `getAuthToken()`.
   */
  getToken?: () => string | null
}

function formatTimestamp(iso: string): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const d = new Date(ms)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString()
}

function SnapshotCard({
  snapshot,
  onDelete,
  isDeleting,
}: {
  snapshot: Snapshot
  onDelete: (slug: string) => void
  isDeleting: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const created = formatTimestamp(snapshot.createdAt)

  return (
    <div className="env-card" data-testid={`snapshot-card-${snapshot.slug}`}>
      <div className="env-card-header">
        <span className="env-card-name" data-testid={`snapshot-name-${snapshot.slug}`}>
          {snapshot.name || snapshot.slug}
        </span>
        {created && (
          <span
            className="env-status-badge"
            data-testid={`snapshot-created-${snapshot.slug}`}
            style={{ color: 'var(--text-secondary)' }}
          >
            {created}
          </span>
        )}
      </div>
      <div className="env-card-details">
        <div className="env-card-row">
          <span className="env-card-label">Tag</span>
          <span
            className="env-card-value"
            style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.85em' }}
            data-testid={`snapshot-tag-${snapshot.slug}`}
          >
            {snapshot.tag}
          </span>
        </div>
        {snapshot.sourceCwd && (
          <div className="env-card-row">
            <span className="env-card-label">CWD</span>
            <span className="env-card-value">{snapshot.sourceCwd}</span>
          </div>
        )}
        {snapshot.sourceImage && (
          <div className="env-card-row">
            <span className="env-card-label">Base</span>
            <span className="env-card-value">{snapshot.sourceImage}</span>
          </div>
        )}
        {snapshot.sourceSessionId && (
          <div className="env-card-row">
            <span className="env-card-label">Session</span>
            <span
              className="env-card-value"
              style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.85em' }}
            >
              {snapshot.sourceSessionId}
            </span>
          </div>
        )}
      </div>
      <div className="env-card-actions">
        {!confirming ? (
          <button
            className="btn-env-destroy"
            data-testid={`snapshot-delete-${snapshot.slug}`}
            onClick={() => setConfirming(true)}
            disabled={isDeleting}
            title="Delete snapshot (removes Docker image + metadata)"
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        ) : (
          <div className="env-confirm-row">
            <span>Delete this snapshot?</span>
            <button
              className="btn-env-confirm-yes"
              data-testid={`snapshot-confirm-yes-${snapshot.slug}`}
              onClick={() => {
                setConfirming(false)
                onDelete(snapshot.slug)
              }}
            >
              Yes
            </button>
            <button
              className="btn-env-confirm-no"
              data-testid={`snapshot-confirm-no-${snapshot.slug}`}
              onClick={() => setConfirming(false)}
            >
              No
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function SnapshotsPanel({ fetchImpl, getToken }: SnapshotsPanelProps = {}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  // #5102 — partial-success notice: the sidecar dropped but `docker rmi`
  // failed (image still in use, daemon down). The row legitimately
  // disappears, so without this the leaked image would be invisible.
  const [warning, setWarning] = useState<string | null>(null)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)

  // Hoist for testability — production passes neither override and falls
  // back to the shared globals.
  const resolvedFetch: typeof fetch =
    fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init))
  const resolvedGetToken = getToken ?? getAuthToken

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const token = resolvedGetToken()
    try {
      const res = await resolvedFetch('/api/snapshots', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { snapshots: Snapshot[] }
      setSnapshots(Array.isArray(body.snapshots) ? body.snapshots : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshots')
    } finally {
      setLoading(false)
    }
  }, [resolvedFetch, resolvedGetToken])

  const handleDelete = useCallback(
    async (slug: string) => {
      setDeletingSlug(slug)
      setError(null)
      const token = resolvedGetToken()
      try {
        const res = await resolvedFetch(`/api/snapshots/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`)
        }
        const body = (await res
          .json()
          .catch(() => ({}))) as { tag?: string; imageRemoved?: boolean }
        // Drop locally so the row disappears even if a follow-up
        // /api/snapshots round-trip is slow. refresh() will reconcile.
        setSnapshots((prev) => prev.filter((s) => s.slug !== slug))
        // #5102 — the metadata is gone (row removed) but `docker rmi`
        // failed, so the image is still on disk. Surface the tag + the
        // manual cleanup command since the operator can no longer see it.
        if (body.imageRemoved === false) {
          const tag = body.tag || slug
          setWarning(
            `Snapshot deleted, but its Docker image (${tag}) could not be removed — ` +
              `it may still be in use or the daemon is unavailable. ` +
              `Run \`docker rmi ${tag}\` to clean it up manually.`,
          )
        }
        // Best-effort refresh to catch any other state drift.
        void refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete snapshot')
      } finally {
        setDeletingSlug(null)
      }
    },
    [refresh, resolvedFetch, resolvedGetToken],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="environment-panel" data-testid="snapshots-panel">
      <div className="env-panel-header">
        <h2>Snapshots</h2>
        <button
          className="btn-env-new"
          data-testid="snapshots-refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div
          className="env-empty"
          data-testid="snapshots-error"
          style={{ color: 'var(--status-error, #ef4444)' }}
        >
          {error}
        </div>
      )}

      {warning && (
        <div
          className="env-empty"
          data-testid="snapshots-warning"
          style={{
            color: 'var(--status-warning, #f59e0b)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            justifyContent: 'space-between',
          }}
        >
          <span>{warning}</span>
          <button
            className="btn-env-new"
            data-testid="snapshots-warning-dismiss"
            onClick={() => setWarning(null)}
            title="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {!error && !loading && snapshots.length === 0 && (
        <div className="env-empty" data-testid="snapshots-empty">
          <p>No snapshots saved yet.</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>
            Snapshots are committed Docker images from a docker-byok session's
            writable layer. Take one from a live session to preserve installed
            packages, auth state, or scratch files for later reuse.
          </p>
        </div>
      )}

      <div className="env-grid">
        {snapshots.map((snap) => (
          <SnapshotCard
            key={snap.slug}
            snapshot={snap}
            onDelete={handleDelete}
            isDeleting={deletingSlug === snap.slug}
          />
        ))}
      </div>
    </div>
  )
}
