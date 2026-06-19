/**
 * ContainersStatusSection (#6133, epic #5530) — the "Containers" Control Room tab.
 *
 * Renders the host-wide survey of chroxy-managed containers & environments the
 * server returns in a `containers_status_snapshot`: an eyebrow + title +
 * subtitle, a row of summary chips (total / running / stopped / other), and a
 * table of every environment grouped by its backing working directory (`cwd`),
 * each row showing status, backend, image, attached-session count, uptime, and a
 * best-effort `docker stats` snapshot (CPU% / memory).
 *
 * Lives next to the runner + integrations tables inside the Control Room (see
 * ControlRoomView). Same pull-on-Refresh data flow as the sibling surveys: the
 * Refresh button dispatches `containers_status_request` via the store's
 * `requestContainersStatus`; the server replies with one
 * `containers_status_snapshot` handled into `containersStatus`. No delta stream —
 * each refresh replaces the whole survey.
 *
 * Status → accent:
 *   - running → ok   (green)
 *   - stopped/exited/error → warn/bad (amber/red)
 *   - anything else → neutral
 */
import { useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerContainersStatusSnapshotMessage } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'

type Accent = 'ok' | 'warn' | 'bad' | 'neutral'

type ContainerEntry = ServerContainersStatusSnapshotMessage['containers'][number]

const STATUS_ACCENT: Record<string, Accent> = {
  running: 'ok',
  stopped: 'warn',
  exited: 'warn',
  error: 'bad',
}

function statusAccent(status: string): Accent {
  return STATUS_ACCENT[status] ?? 'neutral'
}

interface SummaryChip {
  key: keyof ServerContainersStatusSnapshotMessage['summary']
  label: string
  accent: Accent
}

// total first (neutral), then the buckets the operator scans (problems last).
const SUMMARY_CHIPS: readonly SummaryChip[] = [
  { key: 'total', label: 'Containers', accent: 'neutral' },
  { key: 'running', label: 'Running', accent: 'ok' },
  { key: 'stopped', label: 'Stopped', accent: 'warn' },
  { key: 'other', label: 'Other', accent: 'bad' },
]

/** ISO date (no time) for the eyebrow, e.g. "2026-06-19". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** Compact human uptime from ms: "2h 14m", "5m", "12s", or "—". */
function formatUptime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
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

function StatusTag({ container }: { container: ContainerEntry }) {
  const accent = statusAccent(container.status)
  return (
    <span className={`cr-tag cr-tag-${accent}`} data-testid={`container-status-${container.id}`} data-accent={accent}>
      {container.status}
    </span>
  )
}

/** Live resource cell: CPU% + memory, or "—" when stats are unavailable. */
function StatsCell({ container }: { container: ContainerEntry }) {
  const { stats } = container
  // null stats (not running / probe failed) OR a stats object whose individual
  // fields are all null (the protocol allows each to be nullable) → "—", never a
  // blank cell.
  if (!stats || (stats.cpuPercent === null && stats.memBytes === null && stats.memPercent === null)) {
    return <td className="cr-dim" data-testid={`container-stats-${container.id}`}>—</td>
  }
  return (
    <td data-testid={`container-stats-${container.id}`}>
      {stats.cpuPercent !== null && <span className="cr-mono">{stats.cpuPercent.toFixed(1)}% cpu</span>}
      {stats.memBytes !== null && (
        <span className="cr-dim cr-mono">
          {stats.cpuPercent !== null ? ' · ' : ''}{formatBytes(stats.memBytes)}
          {stats.memPercent !== null ? ` (${stats.memPercent.toFixed(1)}%)` : ''}
        </span>
      )}
    </td>
  )
}

function ContainerRow({ container }: { container: ContainerEntry }) {
  return (
    <tr data-testid={`container-row-${container.id}`}>
      <td>
        <b data-testid={`container-name-${container.id}`}>{container.name || container.id}</b>
        <div className="cr-dim cr-mono cr-branch">
          {container.backend}
          {container.containerId ? ` · ${container.containerId.slice(0, 12)}` : ''}
          {container.composeProject ? ` · ${container.composeProject}` : ''}
        </div>
      </td>
      <td><StatusTag container={container} /></td>
      <td className="cr-dim cr-mono">{container.image ?? '—'}</td>
      <td className="cr-dim" data-testid={`container-sessions-${container.id}`}>
        {container.sessionCount > 0 ? `${container.sessionCount}` : '—'}
      </td>
      <td className="cr-dim">{formatUptime(container.uptimeMs)}</td>
      <StatsCell container={container} />
    </tr>
  )
}

interface CwdGroup {
  cwd: string
  containers: ContainerEntry[]
}

/** Group the flat container list by `cwd` (the backing repo), preserving order. */
function groupByCwd(containers: readonly ContainerEntry[]): CwdGroup[] {
  const order: string[] = []
  const byCwd = new Map<string, ContainerEntry[]>()
  for (const c of containers) {
    const key = c.cwd || '(no workdir)'
    if (!byCwd.has(key)) {
      byCwd.set(key, [])
      order.push(key)
    }
    byCwd.get(key)!.push(c)
  }
  return order.map((cwd) => ({ cwd, containers: byCwd.get(cwd)! }))
}

function CwdGroupRows({ group }: { group: CwdGroup }) {
  return (
    <>
      <tr className="runner-repo-row" data-testid={`container-cwd-${group.cwd}`}>
        <td colSpan={6}>
          <b className="runner-repo-name cr-mono">{group.cwd}</b>
          <span className="cr-dim"> · {group.containers.length} container{group.containers.length === 1 ? '' : 's'}</span>
        </td>
      </tr>
      {group.containers.map((c) => (
        <ContainerRow key={c.id} container={c} />
      ))}
    </>
  )
}

export interface ContainersStatusSectionProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerContainersStatusSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestContainersStatus. */
  onRefresh?: () => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" string. */
  now?: () => number
}

export function ContainersStatusSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: ContainersStatusSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.containersStatus)
  const storeLoading = useConnectionStore((s) => s.containersStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestContainersStatus = useConnectionStore((s) => s.requestContainersStatus)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestContainersStatus

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const groups = useMemo(() => (snapshot ? groupByCwd(snapshot.containers) : []), [snapshot])
  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  return (
    <div className="cr-section" data-testid="containers-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="containers-eyebrow">
          host · containers &amp; environments{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Containers</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="containers-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="containers-sub">
            {snapshot.summary.total} container{snapshot.summary.total === 1 ? '' : 's'} across {groups.length} workdir
            {groups.length === 1 ? '' : 's'} — chroxy-managed environments only.
          </p>
        )}
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="containers-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot?.dockerStatsNote && (
          <p className="cr-dim" data-testid="containers-stats-note">{snapshot.dockerStatsNote}</p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="containers-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="containers-empty">
          {loading ? (
            <span>Running the containers survey…</span>
          ) : (
            <>
              <p>No containers survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="containers-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="containers-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="containers-chips">
            {SUMMARY_CHIPS.map((chip) => (
              <span className="cr-chip" key={chip.key} data-testid={`containers-chip-${chip.key}`}>
                {chip.accent !== 'neutral' && <span className={`cr-dot cr-dot-${chip.accent}`} aria-hidden="true" />}
                {chip.label}: <b data-testid={`containers-chip-count-${chip.key}`}>{snapshot.summary[chip.key]}</b>
              </span>
            ))}
          </div>

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="containers-table">
              <thead>
                <tr>
                  <th>Container / backend</th>
                  <th>Status</th>
                  <th>Image</th>
                  <th>Sessions</th>
                  <th>Uptime</th>
                  <th>Resources</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.containers.length === 0 ? (
                  <tr data-testid="containers-none">
                    <td colSpan={6} className="cr-dim">
                      No chroxy-managed containers or environments.
                    </td>
                  </tr>
                ) : (
                  groups.map((group) => <CwdGroupRows key={group.cwd} group={group} />)
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
