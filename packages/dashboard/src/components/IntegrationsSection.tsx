/**
 * IntegrationsSection (#5499, epic #5498) — the "Integrations" Control Room tab.
 *
 * Renders the per-repo integration survey the server returns in an
 * `integration_status_snapshot`: an eyebrow + title + subtitle, a row of
 * summary chips (repos / configured / not configured / degraded), an optional
 * missing-CLI callout, and a table with one row per surveyed repo showing its
 * repo-memory status — configured (summarizer + tool groups), cache presence
 * + size, hit ratio, tokens saved, stale entries, and last activity. A repo
 * without `.repo-memory.json` renders a quiet "not configured" row — absence
 * is signal, not an error. A sibling repo-relay column block lands in the
 * follow-up issue (#5498 sub-issues).
 *
 * Lives next to the Project status and Self-hosted runners tables inside the
 * Control Room (see ControlRoomView). Same pull-on-Refresh data flow as the
 * sibling surveys: the Refresh button dispatches `integration_status_request`
 * via the store's `requestIntegrationStatus`; the server replies with one
 * `integration_status_snapshot` handled into `integrationStatus`. No delta
 * stream — each refresh replaces the whole survey.
 *
 * Status → accent:
 *   - configured (report present)  → ok      (green)  — live repo-memory.
 *   - degraded (report failed)     → warn    (amber)  — config present but the
 *     CLI cell couldn't populate; the row carries the reason.
 *   - not configured               → neutral (dim)    — quiet, not an error.
 */
import { useConnectionStore } from '../store/connection'
import type { IntegrationRepo, RepoMemoryStatus, ServerIntegrationStatusSnapshotMessage } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'

type Accent = 'ok' | 'warn' | 'bad'

interface SummaryChip {
  key: keyof ServerIntegrationStatusSnapshotMessage['summary']
  label: string
  accent: Accent | 'neutral'
}

// Chip order mirrors the summary row: total first (neutral), then the healthy
// bucket, then the ones the operator scans for.
const SUMMARY_CHIPS: readonly SummaryChip[] = [
  { key: 'total', label: 'Repos', accent: 'neutral' },
  { key: 'configured', label: 'Configured', accent: 'ok' },
  { key: 'notConfigured', label: 'Not configured', accent: 'neutral' },
  { key: 'degraded', label: 'Degraded', accent: 'warn' },
]

/** ISO date (no time) for the eyebrow, e.g. "2026-06-10". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** Human-readable byte count, e.g. "2.2 MB" / "412 KB" / "96 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Relative "ago" string for a cell (no "generated" prefix), or "—". */
function formatAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  const deltaSec = Math.floor((nowMs - ms) / 1000)
  if (!Number.isFinite(deltaSec) || deltaSec < 60) return 'just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

/** repo-memory row status bucket for the tag + accent. */
function repoMemoryStatusKind(rm: RepoMemoryStatus | null): { label: string; accent: Accent | 'neutral' } {
  if (!rm || !rm.configured) return { label: 'Not configured', accent: 'neutral' }
  if (rm.reason !== null) return { label: 'Degraded', accent: 'warn' }
  return { label: 'Configured', accent: 'ok' }
}

function StatusTag({ repo }: { repo: IntegrationRepo }) {
  const { label, accent } = repoMemoryStatusKind(repo.repoMemory)
  return (
    <span
      className={`cr-tag${accent === 'neutral' ? '' : ` cr-tag-${accent}`}`}
      data-testid={`integration-status-${repo.name}`}
      data-accent={accent}
      title={repo.repoMemory?.reason ?? undefined}
    >
      {label}
    </span>
  )
}

/** Cache cell: size (+ "empty" when configured but no db yet), or "—". */
function CacheCell({ repo }: { repo: IntegrationRepo }) {
  const rm = repo.repoMemory
  if (!rm || !rm.configured || !rm.cache) {
    return <td className="cr-dim" data-testid={`integration-cache-${repo.name}`}>—</td>
  }
  if (!rm.cache.present) {
    return <td className="cr-dim" data-testid={`integration-cache-${repo.name}`}>no cache yet</td>
  }
  return (
    <td data-testid={`integration-cache-${repo.name}`}>
      <span className="cr-mono">{formatBytes(rm.cache.sizeBytes)}</span>
    </td>
  )
}

/** Hit-ratio cell: "75% (90/120)" from the report, or the degraded "—". */
function HitRatioCell({ repo }: { repo: IntegrationRepo }) {
  const report = repo.repoMemory?.report ?? null
  if (!report) {
    return <td className="cr-dim" data-testid={`integration-ratio-${repo.name}`}>—</td>
  }
  const lookups = report.cacheHits + report.cacheMisses
  if (lookups === 0) {
    return <td className="cr-dim" data-testid={`integration-ratio-${repo.name}`}>no events</td>
  }
  return (
    <td data-testid={`integration-ratio-${repo.name}`}>
      <span className="cr-ok">{(report.cacheHitRatio * 100).toFixed(1)}%</span>
      <span className="cr-dim cr-mono"> ({report.cacheHits}/{lookups})</span>
    </td>
  )
}

function IntegrationRow({ repo, now }: { repo: IntegrationRepo; now: number }) {
  const rm = repo.repoMemory
  const report = rm?.report ?? null
  const configured = rm?.configured === true
  const lastActivity = report?.lastActivity ?? rm?.cache?.lastModified ?? null
  return (
    <tr data-testid={`integration-row-${repo.name}`}>
      <td>
        <b data-testid={`integration-name-${repo.name}`}>{repo.name}</b>
        <div className="cr-dim cr-mono cr-branch" title={repo.path}>{repo.path}</div>
      </td>
      <td><StatusTag repo={repo} /></td>
      <td className="cr-dim" data-testid={`integration-config-${repo.name}`}>
        {configured ? (
          <>
            {rm!.summarizer ?? '—'}
            {rm!.toolGroups.length > 0 && <span className="cr-mono"> · {rm!.toolGroups.join(', ')}</span>}
          </>
        ) : (
          '—'
        )}
      </td>
      <CacheCell repo={repo} />
      <HitRatioCell repo={repo} />
      <td className="cr-dim cr-mono" data-testid={`integration-tokens-${repo.name}`}>
        {report ? `~${report.estimatedTokensSaved.toLocaleString('en-US')}` : '—'}
      </td>
      <td className="cr-dim" data-testid={`integration-stale-${repo.name}`}>
        {report && report.cacheEntryCount !== null
          ? `${report.cacheEntryCount}${report.staleEntryCount !== null && report.staleEntryCount > 0 ? ` (${report.staleEntryCount} stale)` : ''}`
          : '—'}
      </td>
      <td className="cr-dim" data-testid={`integration-activity-${repo.name}`}>
        {formatAgo(lastActivity, now)}
      </td>
    </tr>
  )
}

export interface IntegrationsSectionProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerIntegrationStatusSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestIntegrationStatus. */
  onRefresh?: () => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" / activity cells. */
  now?: () => number
}

export function IntegrationsSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: IntegrationsSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.integrationStatus)
  const storeLoading = useConnectionStore((s) => s.integrationStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestIntegrationStatus = useConnectionStore((s) => s.requestIntegrationStatus)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestIntegrationStatus

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const nowMs = now()

  return (
    <div className="cr-section" data-testid="integration-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="integration-eyebrow">
          host · integrations{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Integrations</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="integration-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="integration-sub">
            repo-memory status across {snapshot.repos.length} repo{snapshot.repos.length === 1 ? '' : 's'} under{' '}
            <span className="cr-mono">{snapshot.root}</span> — config, cache, and telemetry from the read-only CLI report.
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="integration-generated">
            {formatGeneratedAgo(generatedAtMs, nowMs)}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="integration-empty">
          {loading ? (
            <span>Running the integrations survey…</span>
          ) : (
            <>
              <p>No integrations survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="integration-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="integration-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="integration-chips">
            {SUMMARY_CHIPS.map((chip) => (
              <span className="cr-chip" key={chip.key} data-testid={`integration-chip-${chip.key}`}>
                {chip.accent !== 'neutral' && <span className={`cr-dot cr-dot-${chip.accent}`} aria-hidden="true" />}
                {chip.label}: <b data-testid={`integration-chip-count-${chip.key}`}>{snapshot.summary[chip.key]}</b>
              </span>
            ))}
          </div>

          {snapshot.error && (
            <div className="cr-callout" data-testid="integration-error">
              <b>Survey degraded:</b> {snapshot.error.message} <span className="cr-dim cr-mono">({snapshot.error.code})</span>
            </div>
          )}

          {snapshot.repoMemoryCli && !snapshot.repoMemoryCli.found && (
            <div className="cr-callout" data-testid="integration-cli-note">
              <b>repo-memory CLI unavailable:</b> {snapshot.repoMemoryCli.note ?? 'binary not found'} — config and
              cache columns still populate; the telemetry columns are degraded for every configured repo.
            </div>
          )}

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="integration-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>repo-memory</th>
                  <th>Summarizer / tools</th>
                  <th>Cache</th>
                  <th>Hit ratio</th>
                  <th>Tokens saved</th>
                  <th>Entries</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.repos.length === 0 ? (
                  <tr data-testid="integration-no-repos">
                    <td colSpan={8} className="cr-dim">
                      No repos found under {snapshot.root}.
                    </td>
                  </tr>
                ) : (
                  snapshot.repos.map((repo) => <IntegrationRow key={repo.path} repo={repo} now={nowMs} />)
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
