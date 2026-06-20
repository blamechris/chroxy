/**
 * RepoRuntimeConfigSection (#6139, epic #5530) — the "Repo Runtime Config"
 * Control Room tab. READ-ONLY.
 *
 * Renders the host-wide, per-repo survey of what governs container runtimes that
 * the server returns in a `repo_runtime_config_snapshot`: an eyebrow + title +
 * host-level defaults (effective backend + its source, isolation order, the
 * effective docker-image allowlist), a row of summary chips, and a table of every
 * managed repo showing devcontainer/compose config presence, the image the repo
 * would run (+ its source), and the docker-image allowlist verdict.
 *
 * Lives next to the Containers tab inside the Control Room (see ControlRoomView).
 * Same pull-on-Refresh data flow as the sibling surveys: the Refresh button
 * dispatches `repo_runtime_config_request` via the store's
 * `requestRepoRuntimeConfig`; the server replies with one
 * `repo_runtime_config_snapshot` handled into `repoRuntimeConfig`. No delta
 * stream — each refresh replaces the whole survey.
 */
import { useConnectionStore } from '../store/connection'
import type { ServerRepoRuntimeConfigSnapshotMessage } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'

type RepoEntry = ServerRepoRuntimeConfigSnapshotMessage['repos'][number]

/** ISO date (no time) for the eyebrow, e.g. "2026-06-19". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** A present/absent config cell: "✓ <detail>" (ok) or "—" (dim). */
function PresenceCell({ present, detail, testid }: { present: boolean; detail?: string; testid: string }) {
  if (!present) {
    return <td className="cr-dim" data-testid={testid}>—</td>
  }
  return (
    <td data-testid={testid}>
      <span className="cr-ok">✓</span>
      {detail ? <span className="cr-dim cr-mono"> {detail}</span> : null}
    </td>
  )
}

/** The allowlist verdict for a repo's image: allowed / denied / N/A (default). */
function VerdictCell({ entry }: { entry: RepoEntry }) {
  if (entry.error) {
    return <td className="cr-dim" data-testid={`repo-config-verdict-${entry.path}`}>—</td>
  }
  // imageAllowed is null for the built-in default image (never allowlist-checked)
  // — show N/A, not a (misleading) verdict.
  if (entry.imageAllowed === null) {
    return (
      <td className="cr-dim" data-testid={`repo-config-verdict-${entry.path}`} title="The built-in default image is not subject to the allowlist">
        n/a
      </td>
    )
  }
  const accent = entry.imageAllowed ? 'ok' : 'bad'
  return (
    <td data-testid={`repo-config-verdict-${entry.path}`}>
      <span className={`cr-tag cr-tag-${accent}`} data-accent={accent}>
        {entry.imageAllowed ? 'allowed' : 'denied'}
      </span>
    </td>
  )
}

function RepoRow({ entry }: { entry: RepoEntry }) {
  if (entry.error) {
    return (
      <tr data-testid={`repo-config-row-${entry.path}`}>
        <td>
          <b data-testid={`repo-config-name-${entry.path}`}>{entry.name || entry.path}</b>
          <div className="cr-dim cr-mono cr-branch">{entry.path}</div>
        </td>
        <td className="cr-bad" colSpan={4} data-testid={`repo-config-error-${entry.path}`} role="alert">
          {entry.error}
        </td>
      </tr>
    )
  }
  return (
    <tr data-testid={`repo-config-row-${entry.path}`}>
      <td>
        <b data-testid={`repo-config-name-${entry.path}`}>{entry.name || entry.path}</b>
        <div className="cr-dim cr-mono cr-branch">{entry.path}</div>
      </td>
      <PresenceCell
        present={entry.devcontainer.present}
        testid={`repo-config-devcontainer-${entry.path}`}
      />
      <PresenceCell
        present={entry.compose.present}
        detail={entry.compose.files.length > 0 ? entry.compose.files.join(', ') : undefined}
        testid={`repo-config-compose-${entry.path}`}
      />
      <td data-testid={`repo-config-image-${entry.path}`}>
        <span className="cr-mono">{entry.image ?? '—'}</span>
        {entry.imageSource ? <span className="cr-dim"> · {entry.imageSource}</span> : null}
      </td>
      <VerdictCell entry={entry} />
    </tr>
  )
}

export interface RepoRuntimeConfigSectionProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerRepoRuntimeConfigSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestRepoRuntimeConfig. */
  onRefresh?: () => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" string. */
  now?: () => number
}

export function RepoRuntimeConfigSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: RepoRuntimeConfigSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.repoRuntimeConfig)
  const storeLoading = useConnectionStore((s) => s.repoRuntimeConfigLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestRepoRuntimeConfig = useConnectionStore((s) => s.requestRepoRuntimeConfig)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestRepoRuntimeConfig

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  return (
    <div className="cr-section" data-testid="repo-config-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="repo-config-eyebrow">
          host · repo runtime config{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Repo Runtime Config</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="repo-config-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="repo-config-sub">
            {snapshot.summary.total} repo{snapshot.summary.total === 1 ? '' : 's'} — read-only view of what
            governs each repo&apos;s container runtimes.
          </p>
        )}
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="repo-config-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="repo-config-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="repo-config-empty">
          {loading ? (
            <span>Running the repo runtime config survey…</span>
          ) : (
            <>
              <p>No repo runtime config survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="repo-config-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="repo-config-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          {/* Host-level defaults that apply across all repos. */}
          <div className="cr-chips" data-testid="repo-config-defaults">
            <span className="cr-chip" data-testid="repo-config-backend">
              Backend: <b>{snapshot.backend}</b>
              <span className="cr-dim"> ({snapshot.backendSource})</span>
            </span>
            <span className="cr-chip" data-testid="repo-config-isolation">
              Isolation: <b>{snapshot.isolation}</b>
            </span>
            <span className="cr-chip" data-testid="repo-config-allowlist">
              Image allowlist: <b>{snapshot.allowlist.patterns.length}</b>
              <span className="cr-dim"> pattern{snapshot.allowlist.patterns.length === 1 ? '' : 's'} ({snapshot.allowlist.source})</span>
            </span>
          </div>

          <div className="cr-chips" data-testid="repo-config-summary">
            <span className="cr-chip" data-testid="repo-config-chip-total">
              Repos: <b>{snapshot.summary.total}</b>
            </span>
            <span className="cr-chip" data-testid="repo-config-chip-devcontainer">
              <span className="cr-dot cr-dot-ok" aria-hidden="true" />
              Devcontainer: <b>{snapshot.summary.withDevcontainer}</b>
            </span>
            <span className="cr-chip" data-testid="repo-config-chip-compose">
              <span className="cr-dot cr-dot-ok" aria-hidden="true" />
              Compose: <b>{snapshot.summary.withCompose}</b>
            </span>
            {snapshot.summary.imagesDenied > 0 && (
              <span className="cr-chip" data-testid="repo-config-chip-denied">
                <span className="cr-dot cr-dot-bad" aria-hidden="true" />
                Images denied: <b>{snapshot.summary.imagesDenied}</b>
              </span>
            )}
            {snapshot.summary.errored > 0 && (
              <span className="cr-chip" data-testid="repo-config-chip-errored">
                <span className="cr-dot cr-dot-bad" aria-hidden="true" />
                Errored: <b>{snapshot.summary.errored}</b>
              </span>
            )}
          </div>

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="repo-config-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Devcontainer</th>
                  <th>Compose</th>
                  <th>Image</th>
                  <th>Allowlist</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.repos.length === 0 ? (
                  <tr data-testid="repo-config-none">
                    <td colSpan={5} className="cr-dim">
                      No managed repos found.
                    </td>
                  </tr>
                ) : (
                  snapshot.repos.map((entry) => <RepoRow key={entry.path} entry={entry} />)
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
