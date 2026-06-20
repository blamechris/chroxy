/**
 * DeviceRuntimesSection (#6136, epic #5530) — the "Device runtimes" Control Room
 * tab. For this slice it surfaces iOS simulators (Android #6137 / WSL2 #6138 are
 * separate sub-issues that will add their own panels here later).
 *
 * Renders the `simulator_status_snapshot` the server returns: each simulator's
 * name / udid / state / runtime / device type, plus the headline **"Ready for
 * Maestro" verdict** — a booted simulator AND Metro (:8081) AND the mock server
 * (:9876) reachable — turning the manual Maestro pre-flight (CLAUDE.md "UI
 * Verification with Maestro") into one glance.
 *
 * Boot / shutdown actions follow the established per-row discipline (mirrors the
 * Containers tab): the server takes a `udid`, re-surveys + re-validates it as a
 * lookup key, and state-gates the action. Non-destructive (no data loss), so no
 * ConfirmDialog. `available:false` (off macOS / no xcrun) is a first-class state
 * — no tables, just a note. Same pull-on-Refresh flow as the sibling surveys.
 */
import { useConnectionStore } from '../store/connection'
import type { ServerSimulatorStatusSnapshotMessage } from '@chroxy/protocol'
import type { SimulatorActionResult } from '../store/types'
import { formatGeneratedAgo } from './ControlRoomSection'

type SimAction = 'boot' | 'shutdown'

/** ISO date (no time) for the eyebrow. */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

function ActionFeedback({ udid, pending, result }: { udid: string; pending: boolean; result: SimulatorActionResult | undefined }) {
  if (pending) return <span className="cr-dim" data-testid={`simulator-pending-${udid}`}>Working…</span>
  if (!result) return null
  if (result.error) return <span className="cr-bad" data-testid={`simulator-error-${udid}`} role="alert">{result.error}</span>
  return <span className="cr-ok" data-testid={`simulator-ok-${udid}`}>{result.note ?? 'done'}</span>
}

export interface DeviceRuntimesSectionProps {
  snapshot?: ServerSimulatorStatusSnapshotMessage | null
  loading?: boolean
  connected?: boolean
  onRefresh?: () => void
  actioningIds?: Set<string>
  actionResults?: Record<string, SimulatorActionResult>
  onAction?: (action: SimAction, udid: string) => void
  now?: () => number
}

export function DeviceRuntimesSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  actioningIds: actioningIdsProp,
  actionResults: actionResultsProp,
  onAction: onActionProp,
  now = Date.now,
}: DeviceRuntimesSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.simulatorStatus)
  const storeLoading = useConnectionStore((s) => s.simulatorStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestSimulatorStatus = useConnectionStore((s) => s.requestSimulatorStatus)
  const storeActioningIds = useConnectionStore((s) => s.simulatorActioningIds)
  const storeActionResults = useConnectionStore((s) => s.simulatorActionResults)
  const sendSimulatorAction = useConnectionStore((s) => s.sendSimulatorAction)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestSimulatorStatus
  const actioningIds = actioningIdsProp ?? storeActioningIds
  const actionResults = actionResultsProp ?? storeActionResults
  const onAction = onActionProp ?? sendSimulatorAction

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const verdict = snapshot?.readyForMaestro

  return (
    <div className="cr-section" data-testid="device-runtimes-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="device-runtimes-eyebrow">
          host · ios simulators{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Device runtimes</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="device-runtimes-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="device-runtimes-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !snapshot.available && (
          <p className="cr-callout" data-testid="device-runtimes-unavailable">
            {snapshot.note || 'iOS simulators are not available on this host.'}
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="device-runtimes-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="device-runtimes-empty">
          {loading ? (
            <span>Running the simulator survey…</span>
          ) : (
            <>
              <p>No simulator survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="device-runtimes-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="device-runtimes-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot?.available && verdict && (
        <>
          <section
            className={`cr-callout ${verdict.ready ? 'cr-callout-ok' : 'cr-callout-bad'}`}
            data-testid="device-runtimes-verdict"
            data-ready={verdict.ready ? 'true' : 'false'}
          >
            {verdict.ready ? (
              <p data-testid="device-runtimes-verdict-ready">
                <b>✓ Ready for Maestro</b>
                {verdict.bootedSimulator ? ` — ${verdict.bootedSimulator} booted, Metro + mock server reachable.` : ''}
              </p>
            ) : (
              <>
                <p data-testid="device-runtimes-verdict-not-ready"><b>✗ Not ready for Maestro</b></p>
                <ul className="cr-reasons" data-testid="device-runtimes-verdict-reasons">
                  {verdict.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {snapshot.devices.length === 0 ? (
            <p className="cr-dim" data-testid="device-runtimes-no-devices">
              No iOS simulators are installed on this host.
            </p>
          ) : (
            <section className="cr-table-wrap">
              <table className="cr-table" data-testid="device-runtimes-table">
                <thead>
                  <tr><th>Simulator</th><th>Runtime</th><th>State</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {snapshot.devices.map((d) => {
                    const isBooted = d.state === 'Booted'
                    const pending = actioningIds.has(d.udid)
                    return (
                      <tr key={d.udid} data-testid={`simulator-row-${d.udid}`}>
                        <td>
                          <b data-testid={`simulator-name-${d.udid}`}>{d.name}</b>{' '}
                          <span className="cr-dim cr-mono">{d.udid.slice(0, 8)}</span>
                          {d.deviceType && d.deviceType !== d.name && (
                            <div className="cr-dim" data-testid={`simulator-devicetype-${d.udid}`}>{d.deviceType}</div>
                          )}
                        </td>
                        <td className="cr-dim" data-testid={`simulator-runtime-${d.udid}`}>{d.runtime}</td>
                        <td>
                          <span
                            className={`cr-tag ${isBooted ? 'cr-tag-ok' : 'cr-tag-dim'}`}
                            data-testid={`simulator-state-${d.udid}`}
                          >
                            {d.state}
                          </span>
                        </td>
                        <td data-testid={`simulator-actions-${d.udid}`}>
                          {isBooted ? (
                            <button
                              type="button"
                              className="cr-action"
                              data-testid={`simulator-shutdown-${d.udid}`}
                              disabled={pending || !connected}
                              onClick={() => onAction('shutdown', d.udid)}
                              title="Shut down this simulator"
                            >
                              Shut down
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="cr-action"
                              data-testid={`simulator-boot-${d.udid}`}
                              disabled={pending || !connected}
                              onClick={() => onAction('boot', d.udid)}
                              title="Boot this simulator"
                            >
                              Boot
                            </button>
                          )}{' '}
                          <ActionFeedback udid={d.udid} pending={pending} result={actionResults[d.udid]} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  )
}
