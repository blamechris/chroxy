/**
 * IntegrationsSection (#5499, epic #5498) — the "Integrations" Control Room tab.
 *
 * Renders the per-repo integration survey the server returns in an
 * `integration_status_snapshot`: an eyebrow + title + subtitle, a row of
 * summary chips (repos / configured / not configured / degraded / relay
 * tallies), optional missing-CLI callouts, and a table with one row per
 * surveyed repo. The columns are grouped under two headers:
 *
 *   - repo-memory (#5499): configured (summarizer + tool groups), cache
 *     presence + size, hit ratio, tokens saved, stale entries, last activity,
 *     and the #5500 Reindex action. A repo without `.repo-memory.json`
 *     renders a quiet "not configured" row — absence is signal, not an error.
 *   - repo-relay (#5501): verdict chip (ok / failing / drifted / not
 *     installed / unknown), version pin vs latest release (drift
 *     highlighted; a bare sha pin renders the short sha with a drift-unknown
 *     tooltip), last run conclusion + age with the Actions deep link, and the
 *     failure streak. Degraded cells carry the per-repo `reason` as tooltip;
 *     a repo without the workflow file is a quiet "Not installed" row.
 *
 * #5500 adds the control half: a per-row Reindex button for configured repos
 * that dispatches `integration_action` (repo_memory_reindex) via the store's
 * `sendRepoMemoryReindex`. The row shows "Reindexing…" (keyed by repoPath in
 * `reindexingRepoPaths`) until the `integration_action_ack` /
 * INTEGRATION_ACTION_FAILED session_error lands, then renders the ack's
 * scanned/summarized/fresh/skipped counts (or the failure reason) inline
 * from `reindexResults`.
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
import type { IntegrationRepo, RepoMemoryStatus, RepoRelayStatus, RepoRelayVerdict, ServerIntegrationStatusSnapshotMessage } from '@chroxy/protocol'
import type { ReindexResult } from '../store/types'
import { formatGeneratedAgo } from './ControlRoomSection'

type Accent = 'ok' | 'warn' | 'bad'

interface SummaryChip {
  key: keyof ServerIntegrationStatusSnapshotMessage['summary']
  label: string
  accent: Accent | 'neutral'
}

// Chip order mirrors the summary row: total first (neutral), then the healthy
// bucket, then the ones the operator scans for. The #5501 relay tallies are
// optional on pre-relay summaries — counts default to 0.
const SUMMARY_CHIPS: readonly SummaryChip[] = [
  { key: 'total', label: 'Repos', accent: 'neutral' },
  { key: 'configured', label: 'Configured', accent: 'ok' },
  { key: 'notConfigured', label: 'Not configured', accent: 'neutral' },
  { key: 'degraded', label: 'Degraded', accent: 'warn' },
  { key: 'relayInstalled', label: 'Relay installed', accent: 'neutral' },
  { key: 'relayFailing', label: 'Relay failing', accent: 'bad' },
  { key: 'relayDrifted', label: 'Relay drifted', accent: 'warn' },
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

// ---------------------------------------------------------------------------
// #5501 — repo-relay cells.
// ---------------------------------------------------------------------------

/** Verdict → tag label + accent (mirrors the runner tab's chip style). */
const RELAY_VERDICT_META: Record<RepoRelayVerdict, { label: string; accent: Accent | 'neutral' }> = {
  ok: { label: 'OK', accent: 'ok' },
  failing: { label: 'Failing', accent: 'bad' },
  drifted: { label: 'Drifted', accent: 'warn' },
  not_installed: { label: 'Not installed', accent: 'neutral' },
  unknown: { label: 'Unknown', accent: 'neutral' },
}

/**
 * A missing `repoRelay` block (pre-#5501 producer) renders the same quiet
 * cells as a not-installed one — the table never breaks on an old snapshot.
 */
function relayOf(repo: IntegrationRepo): RepoRelayStatus | null {
  return repo.repoRelay ?? null
}

function RelayStatusTag({ repo }: { repo: IntegrationRepo }) {
  const relay = relayOf(repo)
  const { label, accent } = RELAY_VERDICT_META[relay?.verdict ?? 'not_installed']
  return (
    <span
      className={`cr-tag${accent === 'neutral' ? '' : ` cr-tag-${accent}`}`}
      data-testid={`integration-relay-status-${repo.name}`}
      data-accent={accent}
      title={relay?.reason ?? undefined}
    >
      {label}
    </span>
  )
}

/**
 * Version cell: `pinned → latest` with a drift highlight when the verdict is
 * drifted; a bare sha pin renders the short sha with a drift-unknown tooltip;
 * a single side renders alone; nothing known renders "—".
 */
function RelayVersionCell({ repo }: { repo: IntegrationRepo }) {
  const relay = relayOf(repo)
  if (!relay || !relay.installed) {
    return <td className="cr-dim" data-testid={`integration-relay-version-${repo.name}`}>—</td>
  }
  const pinnedLabel = relay.pinnedVersion
    ?? (relay.pinnedSha ? relay.pinnedSha.slice(0, 7) : null)
  const drifted = relay.verdict === 'drifted'
  const title = relay.driftUnknown
    ? 'pin does not resolve to a version (no # vX.Y.Z comment) — drift unknown'
    : undefined
  if (!pinnedLabel && !relay.latestVersion) {
    return <td className="cr-dim" data-testid={`integration-relay-version-${repo.name}`} title={title}>—</td>
  }
  return (
    <td className="cr-mono" data-testid={`integration-relay-version-${repo.name}`} title={title}>
      <span className={drifted ? 'cr-warn' : undefined}>{pinnedLabel ?? '—'}</span>
      {relay.latestVersion && pinnedLabel !== relay.latestVersion && (
        <span className="cr-dim"> → {relay.latestVersion}</span>
      )}
    </td>
  )
}

/** Last-run cell: latest run's conclusion/status + age, with the Actions deep link. */
function RelayLastRunCell({ repo, now }: { repo: IntegrationRepo; now: number }) {
  const relay = relayOf(repo)
  const latest = relay?.runs[0] ?? null
  if (!relay || !relay.installed || !latest) {
    return (
      <td className="cr-dim" data-testid={`integration-relay-lastrun-${repo.name}`} title={relay?.reason ?? undefined}>
        {relay?.workflowUrl ? (
          <a
            href={relay.workflowUrl}
            target="_blank"
            rel="noreferrer"
            data-testid={`integration-relay-link-${repo.name}`}
            title="Open the workflow in the GitHub Actions UI"
          >
            —
          </a>
        ) : (
          '—'
        )}
      </td>
    )
  }
  const state = latest.conclusion ?? latest.status ?? 'unknown'
  const stateClass = latest.conclusion === 'success' ? 'cr-ok' : latest.conclusion === 'failure' ? 'cr-bad' : 'cr-dim'
  return (
    <td data-testid={`integration-relay-lastrun-${repo.name}`} title={relay.reason ?? undefined}>
      <span className={stateClass}>{state}</span>
      <span className="cr-dim"> · {formatAgo(latest.createdAt, now)}</span>
      {relay.workflowUrl && (
        <>
          {' '}
          <a
            href={relay.workflowUrl}
            target="_blank"
            rel="noreferrer"
            data-testid={`integration-relay-link-${repo.name}`}
            title="Open the workflow in the GitHub Actions UI"
          >
            ↗
          </a>
        </>
      )}
    </td>
  )
}

/** Failure-streak cell: consecutive failed runs, "—" when clean/unknown. */
function RelayStreakCell({ repo }: { repo: IntegrationRepo }) {
  const relay = relayOf(repo)
  if (!relay || !relay.installed || relay.failureStreak === 0) {
    return <td className="cr-dim" data-testid={`integration-relay-streak-${repo.name}`}>—</td>
  }
  return (
    <td data-testid={`integration-relay-streak-${repo.name}`}>
      <span className="cr-bad">{relay.failureStreak}×</span>
    </td>
  )
}

/**
 * #5500 — per-row Reindex action cell. Only configured repos get the button
 * (an unconfigured repo has nothing to index into). The button disables while
 * this repo's request is pending OR the socket is down (a dead-socket click
 * would silently do nothing — sendRepoMemoryReindex refuses to queue). The
 * last outcome renders inline under the button: the ack's counts, a neutral
 * "reindexed" note when the server couldn't parse the CLI report (Refresh
 * shows the cache truth), or the INTEGRATION_ACTION_FAILED reason.
 */
function ReindexCell({
  repo,
  reindexing,
  result,
  connected,
  onReindex,
}: {
  repo: IntegrationRepo
  reindexing: boolean
  result: ReindexResult | undefined
  connected: boolean
  onReindex: (repoPath: string) => void
}) {
  if (repo.repoMemory?.configured !== true) {
    return <td className="cr-dim" data-testid={`integration-actions-${repo.name}`}>—</td>
  }
  const disabled = reindexing || !connected
  return (
    <td data-testid={`integration-actions-${repo.name}`}>
      <button
        type="button"
        className="cr-refresh"
        data-testid={`integration-reindex-${repo.name}`}
        onClick={() => { if (!disabled) onReindex(repo.path) }}
        disabled={disabled}
        aria-busy={reindexing}
        title={connected ? 'Run repo-memory index to refresh the summary cache' : 'Not connected — reconnect to reindex'}
      >
        {reindexing ? 'Reindexing…' : 'Reindex'}
      </button>
      {!reindexing && result && result.error !== null && (
        <div className="cr-bad" data-testid={`integration-reindex-error-${repo.name}`}>
          {result.error}
        </div>
      )}
      {!reindexing && result && result.error === null && (
        <div className="cr-dim" data-testid={`integration-reindex-result-${repo.name}`}>
          {result.counts
            ? `✓ ${result.counts.summarized} summarized · ${result.counts.fresh} fresh · ${result.counts.skipped} skipped`
            : '✓ reindexed — refresh for cache stats'}
        </div>
      )}
    </td>
  )
}

function IntegrationRow({
  repo,
  now,
  reindexing,
  reindexResult,
  connected,
  onReindex,
}: {
  repo: IntegrationRepo
  now: number
  reindexing: boolean
  reindexResult: ReindexResult | undefined
  connected: boolean
  onReindex: (repoPath: string) => void
}) {
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
      <ReindexCell
        repo={repo}
        reindexing={reindexing}
        result={reindexResult}
        connected={connected}
        onReindex={onReindex}
      />
      <td><RelayStatusTag repo={repo} /></td>
      <RelayVersionCell repo={repo} />
      <RelayLastRunCell repo={repo} now={now} />
      <RelayStreakCell repo={repo} />
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
  /** #5500: repo paths with an in-flight reindex. Defaults to the store. */
  reindexingRepoPaths?: Set<string>
  /** #5500: last reindex outcome per repo path. Defaults to the store. */
  reindexResults?: Record<string, ReindexResult>
  /** #5500: Reindex action. Defaults to the store's sendRepoMemoryReindex. */
  onReindex?: (repoPath: string) => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" / activity cells. */
  now?: () => number
}

export function IntegrationsSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  reindexingRepoPaths: reindexingProp,
  reindexResults: reindexResultsProp,
  onReindex: onReindexProp,
  now = Date.now,
}: IntegrationsSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.integrationStatus)
  const storeLoading = useConnectionStore((s) => s.integrationStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestIntegrationStatus = useConnectionStore((s) => s.requestIntegrationStatus)
  const storeReindexing = useConnectionStore((s) => s.reindexingRepoPaths)
  const storeReindexResults = useConnectionStore((s) => s.reindexResults)
  const sendRepoMemoryReindex = useConnectionStore((s) => s.sendRepoMemoryReindex)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestIntegrationStatus
  const reindexingRepoPaths = reindexingProp ?? storeReindexing
  const reindexResults = reindexResultsProp ?? storeReindexResults
  const onReindex = onReindexProp ?? sendRepoMemoryReindex

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
            repo-memory and repo-relay status across {snapshot.repos.length} repo{snapshot.repos.length === 1 ? '' : 's'} under{' '}
            <span className="cr-mono">{snapshot.root}</span> — config, cache, and telemetry from the read-only CLI
            report; workflow presence, version drift, and run health from the filesystem + gh.
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
                {chip.label}: <b data-testid={`integration-chip-count-${chip.key}`}>{snapshot.summary[chip.key] ?? 0}</b>
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

          {snapshot.ghCli && !snapshot.ghCli.found && (
            <div className="cr-callout" data-testid="integration-gh-note">
              <b>gh CLI unavailable:</b> {snapshot.ghCli.note ?? 'binary not found'} — relay install and version-pin
              columns still populate from the filesystem; the run and release columns are degraded for every repo.
            </div>
          )}

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="integration-table">
              <thead>
                {/* #5501: two-row header — the repo-memory and repo-relay
                    column families are grouped so the wide table stays
                    legible. */}
                <tr>
                  <th rowSpan={2}>Repo</th>
                  <th colSpan={8} className="cr-th-group" data-testid="integration-group-memory">repo-memory</th>
                  <th colSpan={4} className="cr-th-group" data-testid="integration-group-relay">repo-relay</th>
                </tr>
                <tr>
                  <th>Status</th>
                  <th>Summarizer / tools</th>
                  <th>Cache</th>
                  <th>Hit ratio</th>
                  <th>Tokens saved</th>
                  <th>Entries</th>
                  <th>Last activity</th>
                  <th>Actions</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Last run</th>
                  <th>Streak</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.repos.length === 0 ? (
                  <tr data-testid="integration-no-repos">
                    <td colSpan={13} className="cr-dim">
                      No repos found under {snapshot.root}.
                    </td>
                  </tr>
                ) : (
                  snapshot.repos.map((repo) => (
                    <IntegrationRow
                      key={repo.path}
                      repo={repo}
                      now={nowMs}
                      reindexing={reindexingRepoPaths.has(repo.path)}
                      reindexResult={reindexResults[repo.path]}
                      connected={connected}
                      onReindex={onReindex}
                    />
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
