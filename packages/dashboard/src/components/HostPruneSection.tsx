/**
 * HostPruneSection (#6140, epic #5530) — the "Host prune" Control Room tab.
 *
 * Renders reclaimable, chroxy-scoped, ORPHAN-ONLY host docker pressure the server
 * returns in a `host_prune_status_snapshot`: stopped `chroxy-env-*` containers and
 * chroxy snapshot images (`chroxy-env`/`chroxy-byok-snap`) NOT tracked by a live
 * env, with per-resource sizes + a summary (counts + estimated reclaimable bytes).
 * The container analog of `chroxy worktree gc`.
 *
 * Prune actions (drain/recycle-style) follow the established discipline: each is
 * destructive and gated behind a ConfirmDialog; the server takes only a `kind`
 * (containers/images/all) and re-surveys the chroxy-scoped orphan set itself, so
 * the dashboard can never widen the blast radius. `dockerAvailable:false` is a
 * first-class state (the host has no docker) — no tables, just a note.
 *
 * Same pull-on-Refresh flow as the sibling surveys.
 */
import { useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerHostPruneStatusSnapshotMessage } from '@chroxy/protocol'
import type { HostPruneActionResult } from '../store/types'
import { formatGeneratedAgo } from './ControlRoomSection'
import { ConfirmDialog } from './ConfirmDialog'

type PruneKind = 'containers' | 'images' | 'all'

/** Compact bytes ("45.2 MiB", "1.95 GiB", "512 B", or "—"). */
function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}

/** ISO date (no time) for the eyebrow. */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

function ActionFeedback({ id, pending, result }: { id: string; pending: boolean; result: HostPruneActionResult | undefined }) {
  if (pending) return <span className="cr-dim" data-testid={`host-prune-pending-${id}`}>Pruning…</span>
  if (!result) return null
  if (result.error) return <span className="cr-bad" data-testid={`host-prune-error-${id}`} role="alert">{result.error}</span>
  return <span className="cr-ok" data-testid={`host-prune-ok-${id}`}>{result.note ?? 'done'}</span>
}

export interface HostPruneSectionProps {
  snapshot?: ServerHostPruneStatusSnapshotMessage | null
  loading?: boolean
  connected?: boolean
  onRefresh?: () => void
  actioningIds?: Set<string>
  actionResults?: Record<string, HostPruneActionResult>
  onAction?: (kind: PruneKind) => void
  now?: () => number
}

export function HostPruneSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  actioningIds: actioningIdsProp,
  actionResults: actionResultsProp,
  onAction: onActionProp,
  now = Date.now,
}: HostPruneSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.hostPruneStatus)
  const storeLoading = useConnectionStore((s) => s.hostPruneStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestHostPruneStatus = useConnectionStore((s) => s.requestHostPruneStatus)
  const storeActioningIds = useConnectionStore((s) => s.hostPruneActioningIds)
  const storeActionResults = useConnectionStore((s) => s.hostPruneActionResults)
  const sendHostPruneAction = useConnectionStore((s) => s.sendHostPruneAction)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestHostPruneStatus
  const actioningIds = actioningIdsProp ?? storeActioningIds
  const actionResults = actionResultsProp ?? storeActionResults
  const onAction = onActionProp ?? sendHostPruneAction

  // Every prune is destructive → route through a confirmation. Holds the pending
  // kind (null = dialog closed).
  const [confirmKind, setConfirmKind] = useState<PruneKind | null>(null)

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const anyActioning = actioningIds.size > 0
  const hasContainers = (snapshot?.summary.containerCount ?? 0) > 0
  const hasImages = (snapshot?.summary.imageCount ?? 0) > 0
  const nothingToPrune = snapshot != null && snapshot.dockerAvailable && !hasContainers && !hasImages

  const PRUNE_LABEL: Record<PruneKind, string> = {
    containers: 'Prune containers',
    images: 'Prune images',
    all: 'Prune all',
  }

  return (
    <div className="cr-section" data-testid="host-prune-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="host-prune-eyebrow">
          host · reclaimable docker pressure{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Host prune</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="host-prune-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="host-prune-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !snapshot.dockerAvailable && (
          <p className="cr-callout" data-testid="host-prune-no-docker">
            {snapshot.note || 'docker is unavailable on this host.'}
          </p>
        )}
        {snapshot?.dockerAvailable && snapshot.note && (
          <p className="cr-dim" data-testid="host-prune-note">{snapshot.note}</p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="host-prune-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="host-prune-empty">
          {loading ? (
            <span>Running the host prune survey…</span>
          ) : (
            <>
              <p>No host prune survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="host-prune-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="host-prune-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot?.dockerAvailable && (
        <>
          <div className="cr-chips" data-testid="host-prune-chips">
            <span className="cr-chip" data-testid="host-prune-chip-containers">
              Stopped containers: <b data-testid="host-prune-chip-containers-count">{snapshot.summary.containerCount}</b>
            </span>
            <span className="cr-chip" data-testid="host-prune-chip-images">
              Orphan images: <b data-testid="host-prune-chip-images-count">{snapshot.summary.imageCount}</b>
            </span>
            <span className="cr-chip" data-testid="host-prune-chip-reclaimable">
              Reclaimable: <b>~{formatBytes(snapshot.summary.reclaimableBytes)}</b>
            </span>
          </div>

          <section className="cr-actions-bar" data-testid="host-prune-actions">
            <div className="cr-actions">
              <button
                type="button"
                className="cr-action cr-action-danger"
                data-testid="host-prune-containers"
                disabled={anyActioning || !connected || !hasContainers}
                onClick={() => setConfirmKind('containers')}
                title="Remove all stopped chroxy containers"
              >
                {PRUNE_LABEL.containers}
              </button>
              <button
                type="button"
                className="cr-action cr-action-danger"
                data-testid="host-prune-images"
                disabled={anyActioning || !connected || !hasImages}
                onClick={() => setConfirmKind('images')}
                title="Remove all orphan chroxy snapshot images"
              >
                {PRUNE_LABEL.images}
              </button>
              <button
                type="button"
                className="cr-action cr-action-danger"
                data-testid="host-prune-all"
                disabled={anyActioning || !connected || (!hasContainers && !hasImages)}
                onClick={() => setConfirmKind('all')}
                title="Remove all reclaimable chroxy containers + images"
              >
                {PRUNE_LABEL.all}
              </button>
            </div>
            <ActionFeedback id="containers" pending={actioningIds.has('containers')} result={actionResults['containers']} />
            <ActionFeedback id="images" pending={actioningIds.has('images')} result={actionResults['images']} />
            <ActionFeedback id="all" pending={actioningIds.has('all')} result={actionResults['all']} />
          </section>

          {nothingToPrune && (
            <p className="cr-dim" data-testid="host-prune-clean">Nothing reclaimable — no stopped chroxy containers or orphan snapshot images.</p>
          )}

          {hasContainers && (
            <section className="cr-table-wrap">
              <table className="cr-table" data-testid="host-prune-containers-table">
                <thead>
                  <tr><th>Stopped container</th><th>State</th><th>Size</th></tr>
                </thead>
                <tbody>
                  {snapshot.containers.map((c) => (
                    <tr key={c.id} data-testid={`host-prune-container-${c.id}`}>
                      <td><b className="cr-mono">{c.name}</b> <span className="cr-dim cr-mono">{c.id.slice(0, 12)}</span></td>
                      <td className="cr-dim">{c.state}</td>
                      <td className="cr-dim">{formatBytes(c.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {hasImages && (
            <section className="cr-table-wrap">
              <table className="cr-table" data-testid="host-prune-images-table">
                <thead>
                  <tr><th>Orphan image</th><th>Size</th></tr>
                </thead>
                <tbody>
                  {snapshot.images.map((img) => (
                    <tr key={img.id} data-testid={`host-prune-image-${img.id}`}>
                      <td><b className="cr-mono">{img.ref}</b> <span className="cr-dim cr-mono">{img.id.slice(0, 12)}</span></td>
                      <td className="cr-dim">{formatBytes(img.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmKind !== null}
        title="Prune chroxy docker resources?"
        danger
        confirmLabel={confirmKind ? PRUNE_LABEL[confirmKind] : 'Prune'}
        message={
          confirmKind ? (
            <>
              This permanently removes{' '}
              {confirmKind === 'containers' ? 'all stopped chroxy containers'
                : confirmKind === 'images' ? 'all orphan chroxy snapshot images'
                : 'all reclaimable chroxy containers and orphan snapshot images'}
              . Retained snapshots and live environments are never touched. This cannot be undone.
            </>
          ) : null
        }
        onConfirm={() => {
          if (confirmKind) onAction(confirmKind)
          setConfirmKind(null)
        }}
        onCancel={() => setConfirmKind(null)}
      />
    </div>
  )
}
