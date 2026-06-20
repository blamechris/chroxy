/**
 * ByokPoolSection (#6135, epic #5530) — the "BYOK Pool" Control Room tab.
 *
 * Renders the host-wide BYOK warm-container pool the server returns in a
 * `byok_pool_status_snapshot`: whether the pool is enabled (off by default — a
 * first-class state, not an error), its configured limits (idle TTL, per-key /
 * total caps, max lifetime), live rolling stats (hits / misses / hit-rate /
 * evictions-by-reason), and a table of the per-resource-shape warm buckets.
 *
 * Mutating actions (#6135 slice 2) follow the Containers tab's discipline:
 *   - Drain   — evict ALL idle warm containers (pool-wide; behind a confirm).
 *   - Recycle — evict ONE resource-shape bucket (per-row; behind a confirm).
 *   - Resize  — tighten the runtime per-key / total caps (the server clamps to
 *               the operator-configured ceiling; no confirm — it only frees).
 *
 * Same pull-on-Refresh data flow as the sibling surveys: Refresh dispatches
 * `byok_pool_status_request` via the store's `requestByokPoolStatus`; the server
 * replies with one `byok_pool_status_snapshot` handled into `byokPoolStatus`. No
 * delta stream — each refresh replaces the whole survey. Actions reply with a
 * `byok_pool_action_ack` (or BYOK_POOL_ACTION_FAILED) handled into the
 * per-target pending/result state.
 */
import { useMemo, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerByokPoolStatusSnapshotMessage } from '@chroxy/protocol'
import type { ByokPoolActionResult } from '../store/types'
import { formatGeneratedAgo } from './ControlRoomSection'
import { ConfirmDialog } from './ConfirmDialog'

/** The pool actions the BYOK Pool tab can dispatch. */
type ByokPoolAction = 'drain' | 'recycle' | 'resize'

type ByokBucket = NonNullable<ServerByokPoolStatusSnapshotMessage['stats']>['buckets'][number]

/** Pending/result target id, matching the store's sendByokPoolAction keys. */
function targetId(action: ByokPoolAction, key?: string): string {
  return action === 'recycle' && key ? `recycle:${key}` : action
}

/** ISO date (no time) for the eyebrow, e.g. "2026-06-19". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** Compact human duration from ms: "2h 14m", "5m", "12s", "∞", or "—". */
function formatDurationMs(ms: number | null): string {
  if (ms === null) return '∞'
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 24) return remM > 0 ? `${h}h ${remM}m` : `${h}h`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`
}

/** Inline pending/result note for a settled (or in-flight) action target. */
function ActionFeedback({ id, pending, result }: { id: string; pending: boolean; result: ByokPoolActionResult | undefined }) {
  if (pending) {
    return <span className="cr-dim" data-testid={`byok-action-pending-${id}`}>Working…</span>
  }
  if (!result) return null
  if (result.error) {
    return <span className="cr-bad" data-testid={`byok-action-error-${id}`} role="alert">{result.error}</span>
  }
  return <span className="cr-ok" data-testid={`byok-action-ok-${id}`}>{result.note ?? 'done'}</span>
}

function BucketRow({
  bucket,
  pending,
  result,
  connected,
  onRecycle,
}: {
  bucket: ByokBucket
  pending: boolean
  result: ByokPoolActionResult | undefined
  connected: boolean
  onRecycle: (key: string) => void
}) {
  return (
    <tr data-testid={`byok-bucket-row-${bucket.key}`}>
      <td>
        <b className="cr-mono" data-testid={`byok-bucket-key-${bucket.key}`}>{bucket.key}</b>
      </td>
      <td className="cr-dim" data-testid={`byok-bucket-size-${bucket.key}`}>{bucket.size}</td>
      <td className="cr-dim" data-testid={`byok-bucket-idle-${bucket.key}`}>{formatDurationMs(bucket.oldestIdleMs)}</td>
      <td data-testid={`byok-bucket-actions-${bucket.key}`}>
        <div className="cr-actions">
          <button
            type="button"
            className="cr-action cr-action-danger"
            data-testid={`byok-recycle-${bucket.key}`}
            disabled={pending || !connected}
            onClick={() => onRecycle(bucket.key)}
            title="Evict all warm containers for this resource shape"
          >
            Recycle
          </button>
        </div>
        <ActionFeedback id={`recycle:${bucket.key}`} pending={pending} result={result} />
      </td>
    </tr>
  )
}

export interface ByokPoolSectionProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerByokPoolStatusSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestByokPoolStatus. */
  onRefresh?: () => void
  /** Action target ids with an in-flight action. Defaults to the store set. */
  actioningIds?: Set<string>
  /** Per-target last action outcome. Defaults to the store map. */
  actionResults?: Record<string, ByokPoolActionResult>
  /**
   * Dispatch a BYOK pool action. Defaults to the store's sendByokPoolAction.
   * Drain/recycle are always routed through the confirmation dialog first.
   */
  onAction?: (action: ByokPoolAction, opts?: { key?: string; maxPerKey?: number; maxTotal?: number }) => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" string. */
  now?: () => number
}

export function ByokPoolSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  actioningIds: actioningIdsProp,
  actionResults: actionResultsProp,
  onAction: onActionProp,
  now = Date.now,
}: ByokPoolSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.byokPoolStatus)
  const storeLoading = useConnectionStore((s) => s.byokPoolStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestByokPoolStatus = useConnectionStore((s) => s.requestByokPoolStatus)
  const storeActioningIds = useConnectionStore((s) => s.byokPoolActioningIds)
  const storeActionResults = useConnectionStore((s) => s.byokPoolActionResults)
  const sendByokPoolAction = useConnectionStore((s) => s.sendByokPoolAction)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestByokPoolStatus
  const actioningIds = actioningIdsProp ?? storeActioningIds
  const actionResults = actionResultsProp ?? storeActionResults
  const onAction = onActionProp ?? sendByokPoolAction

  // Drain + recycle are destructive — route through a confirmation dialog.
  // `confirm` holds the pending action ({ action: 'drain' } or { action:
  // 'recycle', key }); null = dialog closed.
  const [confirm, setConfirm] = useState<{ action: 'drain' | 'recycle'; key?: string } | null>(null)

  // Resize inputs are local until Apply. They start EMPTY (the current effective
  // caps show as the input placeholders); an empty field is left unchanged on
  // submit, so the operator only sends the caps they actually typed.
  const [maxPerKeyInput, setMaxPerKeyInput] = useState<string>('')
  const [maxTotalInput, setMaxTotalInput] = useState<string>('')

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const stats = snapshot?.stats ?? null
  const limits = snapshot?.limits ?? null
  const buckets = useMemo(() => stats?.buckets ?? [], [stats])
  const evictionEntries = useMemo(
    () => (stats ? Object.entries(stats.evictionsByReason).filter(([, n]) => n > 0) : []),
    [stats],
  )

  const drainPending = actioningIds.has('drain')
  const resizePending = actioningIds.has('resize')

  const handleResize = () => {
    if (resizePending || !connected) return
    const perKey = maxPerKeyInput.trim() === '' ? undefined : Number(maxPerKeyInput)
    const total = maxTotalInput.trim() === '' ? undefined : Number(maxTotalInput)
    const opts: { maxPerKey?: number; maxTotal?: number } = {}
    if (Number.isInteger(perKey) && (perKey as number) >= 1) opts.maxPerKey = perKey
    if (Number.isInteger(total) && (total as number) >= 1) opts.maxTotal = total
    if (opts.maxPerKey === undefined && opts.maxTotal === undefined) return
    onAction('resize', opts)
  }

  return (
    <div className="cr-section" data-testid="byok-pool-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="byok-pool-eyebrow">
          host · BYOK warm-container pool{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">BYOK Pool</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="byok-pool-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="byok-pool-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !snapshot.enabled && snapshot.note && (
          <p className="cr-callout" data-testid="byok-pool-disabled">{snapshot.note}</p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="byok-pool-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="byok-pool-empty">
          {loading ? (
            <span>Running the BYOK pool survey…</span>
          ) : (
            <>
              <p>No BYOK pool survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="byok-pool-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="byok-pool-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && snapshot.enabled && (
        <>
          <div className="cr-chips" data-testid="byok-pool-chips">
            <span className="cr-chip" data-testid="byok-pool-chip-warm">
              Warm: <b data-testid="byok-pool-chip-warm-count">{stats?.totalSize ?? 0}</b>
            </span>
            <span className="cr-chip" data-testid="byok-pool-chip-hitrate">
              Hit rate: <b>{stats ? `${(stats.hitRate * 100).toFixed(0)}%` : '—'}</b>
            </span>
            <span className="cr-chip" data-testid="byok-pool-chip-hits">
              Hits: <b>{stats?.hits ?? 0}</b>
            </span>
            <span className="cr-chip" data-testid="byok-pool-chip-misses">
              Misses: <b>{stats?.misses ?? 0}</b>
            </span>
            <span className="cr-chip" data-testid="byok-pool-chip-releases">
              Releases: <b>{stats?.releases ?? 0}</b>
            </span>
          </div>

          {limits && (
            <div className="cr-chips" data-testid="byok-pool-limit-chips">
              <span className="cr-chip" data-testid="byok-pool-chip-idle">
                Idle TTL: <b>{formatDurationMs(limits.idleTimeoutMs)}</b>
              </span>
              <span className="cr-chip" data-testid="byok-pool-chip-perkey">
                Per-shape cap: <b>{limits.maxPerKey}</b>
              </span>
              <span className="cr-chip" data-testid="byok-pool-chip-total">
                Total cap: <b>{limits.maxTotal}</b>
              </span>
              <span className="cr-chip" data-testid="byok-pool-chip-maxage">
                Max age: <b>{formatDurationMs(limits.maxAgeMs)}</b>
              </span>
            </div>
          )}

          {evictionEntries.length > 0 && (
            <p className="cr-dim" data-testid="byok-pool-evictions">
              Evictions:{' '}
              {evictionEntries.map(([reason, n], i) => (
                <span key={reason} className="cr-mono">
                  {i > 0 ? ' · ' : ''}{reason} {n}
                </span>
              ))}
            </p>
          )}

          {/* Pool-wide actions: drain + resize. */}
          <section className="cr-actions-bar" data-testid="byok-pool-actions">
            <div className="cr-actions">
              <button
                type="button"
                className="cr-action cr-action-danger"
                data-testid="byok-pool-drain"
                disabled={drainPending || !connected}
                onClick={() => setConfirm({ action: 'drain' })}
                title="Evict every idle warm container across all shapes"
              >
                Drain all
              </button>
            </div>
            <ActionFeedback id="drain" pending={drainPending} result={actionResults['drain']} />

            <div className="cr-resize" data-testid="byok-pool-resize">
              <label>
                Per-shape cap
                <input
                  type="number"
                  min={1}
                  data-testid="byok-pool-resize-perkey"
                  value={maxPerKeyInput}
                  placeholder={limits ? String(limits.maxPerKey) : ''}
                  onChange={(e) => setMaxPerKeyInput(e.target.value)}
                  disabled={resizePending || !connected}
                />
              </label>
              <label>
                Total cap
                <input
                  type="number"
                  min={1}
                  data-testid="byok-pool-resize-total"
                  value={maxTotalInput}
                  placeholder={limits ? String(limits.maxTotal) : ''}
                  onChange={(e) => setMaxTotalInput(e.target.value)}
                  disabled={resizePending || !connected}
                />
              </label>
              <button
                type="button"
                className="cr-action"
                data-testid="byok-pool-resize-apply"
                disabled={resizePending || !connected}
                onClick={handleResize}
                title="Tighten the runtime caps (the server clamps to the host-configured ceiling)"
              >
                Resize
              </button>
              <ActionFeedback id="resize" pending={resizePending} result={actionResults['resize']} />
            </div>
          </section>

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="byok-pool-table">
              <thead>
                <tr>
                  <th>Resource shape (key)</th>
                  <th>Warm</th>
                  <th>Oldest idle</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {buckets.length === 0 ? (
                  <tr data-testid="byok-pool-no-buckets">
                    <td colSpan={4} className="cr-dim">No warm containers parked right now.</td>
                  </tr>
                ) : (
                  buckets.map((b) => (
                    <BucketRow
                      key={b.key}
                      bucket={b}
                      pending={actioningIds.has(targetId('recycle', b.key))}
                      result={actionResults[targetId('recycle', b.key)]}
                      connected={connected}
                      onRecycle={(key) => setConfirm({ action: 'recycle', key })}
                    />
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.action === 'drain' ? 'Drain the BYOK pool?' : 'Recycle this shape?'}
        danger
        confirmLabel={confirm?.action === 'drain' ? 'Drain all' : 'Recycle'}
        message={
          confirm?.action === 'drain' ? (
            <>This evicts <b>every</b> idle warm container across all resource shapes. In-flight sessions keep their containers; the next acquire creates fresh ones.</>
          ) : confirm?.action === 'recycle' ? (
            <>This evicts every idle warm container for <b className="cr-mono">{confirm.key}</b>. The next acquire for that shape creates a fresh container.</>
          ) : null
        }
        onConfirm={() => {
          if (confirm?.action === 'drain') onAction('drain')
          else if (confirm?.action === 'recycle' && confirm.key) onAction('recycle', { key: confirm.key })
          setConfirm(null)
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
