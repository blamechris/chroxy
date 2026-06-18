/**
 * RunnerStatusSection (#5253) — the "Self-hosted runners" Control Room tab.
 *
 * Renders the host-wide self-hosted GitHub Actions runner survey the server
 * returns in a `runner_status_snapshot`: an eyebrow + title + subtitle, a row
 * of summary chips (total / idle / busy / stopped / offline / unregistered), a
 * "how to read the verdict" callout, and a table of every project that has
 * runners installed on the host — each project a group header (with a deep link
 * to its GitHub runner settings) followed by one row per runner showing its
 * verdict, local service state (running + pid + last-exit), GitHub's view
 * (online/offline, busy), OS, and labels.
 *
 * Lives next to the Project status table inside the Control Room (see
 * ControlRoomView). Same pull-on-Refresh data flow as the host survey: the
 * Refresh button dispatches `runner_status_request` via the store's
 * `requestRunnerStatus`; the server replies with one `runner_status_snapshot`
 * handled into `runnerStatus`. No delta stream — each refresh replaces the
 * whole survey.
 *
 * Verdict → accent:
 *   - busy  → ok   (green)  — running a job right now (healthy).
 *   - idle  → ok   (green)  — running + ready (or locally healthy, no GH view).
 *   - stopped → warn (amber) — service registered but not running.
 *   - unregistered → warn (amber) — install dir with no registered service.
 *   - offline → bad (red)   — local/GitHub mismatch worth a look.
 */
import { useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import type { RunnerVerdict, RepoRunners, RunnerInfo, ServerRunnerStatusSnapshotMessage } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'

type Accent = 'ok' | 'warn' | 'bad'

const VERDICT_ACCENT: Record<RunnerVerdict, Accent> = {
  busy: 'ok',
  idle: 'ok',
  stopped: 'warn',
  unregistered: 'warn',
  offline: 'bad',
}

const VERDICT_LABEL: Record<RunnerVerdict, string> = {
  busy: 'Busy',
  idle: 'Idle',
  stopped: 'Stopped',
  unregistered: 'Unregistered',
  offline: 'Offline',
}

interface SummaryChip {
  key: keyof ServerRunnerStatusSnapshotMessage['summary']
  label: string
  accent: Accent | 'neutral'
}

// Chip order mirrors the summary row: total first (neutral), then the buckets
// the operator scans for (problems amber/red last so the eye lands on them).
const SUMMARY_CHIPS: readonly SummaryChip[] = [
  { key: 'total', label: 'Runners', accent: 'neutral' },
  { key: 'idle', label: 'Idle', accent: 'ok' },
  { key: 'busy', label: 'Busy', accent: 'ok' },
  { key: 'stopped', label: 'Stopped', accent: 'warn' },
  { key: 'unregistered', label: 'Unregistered', accent: 'warn' },
  { key: 'offline', label: 'Offline', accent: 'bad' },
]

/** ISO date (no time) for the eyebrow, e.g. "2026-06-06". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

function VerdictTag({ runner }: { runner: RunnerInfo }) {
  const accent = VERDICT_ACCENT[runner.verdict]
  return (
    <span className={`cr-tag cr-tag-${accent}`} data-testid={`runner-verdict-${runner.name}`} data-accent={accent}>
      {VERDICT_LABEL[runner.verdict]}
    </span>
  )
}

/** Local service state cell: running + pid, or stopped + last-exit, or none. */
function ServiceCell({ runner }: { runner: RunnerInfo }) {
  const { service } = runner
  if (service.manager === 'none' || !service.label) {
    return <td className="cr-dim" data-testid={`runner-svc-${runner.name}`}>no service</td>
  }
  if (service.running) {
    return (
      <td data-testid={`runner-svc-${runner.name}`}>
        <span className="cr-ok">running</span>
        {service.pid !== null && <span className="cr-dim cr-mono"> pid {service.pid}</span>}
      </td>
    )
  }
  // Stopped — surface a non-zero last exit as the "it crashed" signal.
  const crashed = service.lastExitCode !== null && service.lastExitCode !== 0
  return (
    <td data-testid={`runner-svc-${runner.name}`}>
      <span className={crashed ? 'cr-bad' : 'cr-dim'}>stopped</span>
      {service.lastExitCode !== null && (
        <span className="cr-dim cr-mono"> exit {service.lastExitCode}</span>
      )}
    </td>
  )
}

/** GitHub's view of the runner: online/offline + busy, or "—" when unknown. */
function GithubCell({ runner }: { runner: RunnerInfo }) {
  if (runner.githubStatus === null) {
    return <td className="cr-dim" data-testid={`runner-gh-${runner.name}`}>—</td>
  }
  const online = runner.githubStatus === 'online'
  return (
    <td data-testid={`runner-gh-${runner.name}`}>
      <span className={online ? 'cr-ok' : 'cr-bad'}>{runner.githubStatus}</span>
      {runner.busy && <span className="cr-dim"> · busy</span>}
    </td>
  )
}

function RunnerRow({ runner }: { runner: RunnerInfo }) {
  return (
    <tr data-testid={`runner-row-${runner.name}`}>
      <td>
        <b data-testid={`runner-name-${runner.name}`}>{runner.name}</b>
        <div className="cr-dim cr-mono cr-branch" title={runner.dir}>{runner.dir}</div>
      </td>
      <td><VerdictTag runner={runner} /></td>
      <ServiceCell runner={runner} />
      <GithubCell runner={runner} />
      <td className="cr-dim">{runner.os ?? '—'}</td>
      <td className="cr-dim cr-mono">{runner.labels.length > 0 ? runner.labels.join(', ') : '—'}</td>
    </tr>
  )
}

function RepoGroup({ group }: { group: RepoRunners }) {
  return (
    <>
      <tr className="runner-repo-row" data-testid={`runner-repo-${group.name}`}>
        <td colSpan={6}>
          <b className="runner-repo-name">{group.name}</b>
          <span className="cr-dim"> · {group.runners.length} runner{group.runners.length === 1 ? '' : 's'}</span>
          {group.runnersUrl && (
            <a
              className="cr-action runner-settings-link"
              data-testid={`runner-settings-${group.name}`}
              href={group.runnersUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${group.name}'s runner settings on GitHub`}
            >
              Runner settings
            </a>
          )}
        </td>
      </tr>
      {group.runners.map((r) => (
        <RunnerRow key={r.dir} runner={r} />
      ))}
    </>
  )
}

export interface RunnerStatusSectionProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerRunnerStatusSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestRunnerStatus. */
  onRefresh?: () => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" string. */
  now?: () => number
}

export function RunnerStatusSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: RunnerStatusSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.runnerStatus)
  const storeLoading = useConnectionStore((s) => s.runnerStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestRunnerStatus = useConnectionStore((s) => s.requestRunnerStatus)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestRunnerStatus

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const runnerCount = useMemo(
    () => (snapshot ? snapshot.repos.reduce((n, r) => n + r.runners.length, 0) : 0),
    [snapshot],
  )
  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  return (
    <div className="cr-section" data-testid="runner-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="runner-eyebrow">
          host · self-hosted runners{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Self-hosted runners</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="runner-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="runner-sub">
            {runnerCount} runner{runnerCount === 1 ? '' : 's'} across {snapshot.repos.length} project
            {snapshot.repos.length === 1 ? '' : 's'} under{' '}
            <span className="cr-mono">{snapshot.root}</span> — local service state cross-checked against GitHub.
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="runner-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="runner-empty">
          {loading ? (
            <span>Running the runner survey…</span>
          ) : (
            <>
              <p>No self-hosted runner survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="runner-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="runner-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="runner-chips">
            {SUMMARY_CHIPS.map((chip) => (
              <span className="cr-chip" key={chip.key} data-testid={`runner-chip-${chip.key}`}>
                {chip.accent !== 'neutral' && <span className={`cr-dot cr-dot-${chip.accent}`} aria-hidden="true" />}
                {chip.label}: <b data-testid={`runner-chip-count-${chip.key}`}>{snapshot.summary[chip.key]}</b>
              </span>
            ))}
          </div>

          <div className="cr-callout" data-testid="runner-callout">
            <b>How to read the verdict:</b> <b>Idle</b> = service running and GitHub-online, ready for jobs.{' '}
            <b>Busy</b> = running a job now. <b>Stopped</b> = the runner service is registered but not running
            (a non-zero exit means it crashed). <b>Unregistered</b> = an install directory with no service.{' '}
            <b>Offline</b> = the local service and GitHub disagree — worth a look.
          </div>

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="runner-table">
              <thead>
                <tr>
                  <th>Runner / dir</th>
                  <th>Status</th>
                  <th>Service</th>
                  <th>GitHub</th>
                  <th>OS</th>
                  <th>Labels</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.repos.length === 0 ? (
                  <tr data-testid="runner-no-repos">
                    <td colSpan={6} className="cr-dim">
                      No self-hosted runners found under {snapshot.root}.
                    </td>
                  </tr>
                ) : (
                  snapshot.repos.map((group) => <RepoGroup key={group.githubUrl} group={group} />)
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
