/**
 * DeviceRuntimesSection (#6136 / #6137 / #6138, epic #5530) — the "Device
 * runtimes" Control Room tab. Surfaces three device-runtime panels: iOS
 * simulators (#6136), Android emulators (#6137), and WSL2 distros (#6138,
 * Windows-host-only).
 *
 * The simulator/emulator panels render their `*_status_snapshot` with the
 * headline **"Ready for Maestro" verdict** — a booted/running device AND Metro
 * (:8081) AND the mock server (:9876) reachable — turning the manual Maestro
 * pre-flight (CLAUDE.md "UI Verification with Maestro") into one glance, plus
 * per-row lifecycle actions (simulator boot/shutdown; emulator boot/kill). The
 * WSL panel has no Maestro verdict (it's a host runtime, not a test target),
 * just the distro survey + per-row start/terminate. Each follows the established
 * per-row discipline: the server takes the device/distro id, re-surveys +
 * re-validates it as a lookup key, and state-gates the action. Non-destructive
 * (no data loss), so no ConfirmDialog. `available:false` (no SDK / off-platform)
 * is a first-class state — no tables, just a note.
 */
import { useEffect } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerSimulatorStatusSnapshotMessage, ServerEmulatorStatusSnapshotMessage, ServerWslStatusSnapshotMessage } from '@chroxy/protocol'
import type { SimulatorActionResult, EmulatorActionResult, WslActionResult } from '../store/types'
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
    <>
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
    <AndroidEmulatorPanel now={now} />
    <WslPanel now={now} />
    </>
  )
}

function WslActionFeedback({ distro, pending, result }: { distro: string; pending: boolean; result: WslActionResult | undefined }) {
  if (pending) return <span className="cr-dim" data-testid={`wsl-pending-${distro}`}>Working…</span>
  if (!result) return null
  if (result.error) return <span className="cr-bad" data-testid={`wsl-error-${distro}`} role="alert">{result.error}</span>
  return <span className="cr-ok" data-testid={`wsl-ok-${distro}`}>{result.note ?? 'done'}</span>
}

export interface WslPanelProps {
  snapshot?: ServerWslStatusSnapshotMessage | null
  loading?: boolean
  connected?: boolean
  onRefresh?: () => void
  actioningIds?: Set<string>
  actionResults?: Record<string, WslActionResult>
  onAction?: (action: 'start' | 'terminate', distro: string) => void
  now?: () => number
}

/**
 * #6138 — the WSL2 half of the Device runtimes tab. Windows-host-only: off
 * Windows / no wsl.exe the survey returns `available:false` and the panel shows
 * just a note. Mirrors the sibling panels' chrome (eyebrow + Refresh +
 * generated-ago + empty state), but there's no "Ready for Maestro" verdict — WSL
 * is a host runtime, not a Maestro target. Each distro row exposes a state-gated
 * Start (a Stopped distro) / Terminate (a Running distro) button; the server
 * re-surveys + re-validates the distro name (lookup key, never a trusted path)
 * and state-gates the action. The tab's generic auto-fetch only covers the iOS
 * survey, so this panel self-fetches the WSL survey once on connect.
 */
export function WslPanel({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  actioningIds: actioningIdsProp,
  actionResults: actionResultsProp,
  onAction: onActionProp,
  now = Date.now,
}: WslPanelProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.wslStatus)
  const storeLoading = useConnectionStore((s) => s.wslStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestWslStatus = useConnectionStore((s) => s.requestWslStatus)
  const storeActioningIds = useConnectionStore((s) => s.wslActioningIds)
  const storeActionResults = useConnectionStore((s) => s.wslActionResults)
  const sendWslAction = useConnectionStore((s) => s.sendWslAction)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestWslStatus
  const actioningIds = actioningIdsProp ?? storeActioningIds
  const actionResults = actionResultsProp ?? storeActionResults
  const onAction = onActionProp ?? sendWslAction

  // The tab's generic auto-fetch only requests the iOS survey, so kick the WSL
  // survey once when we first connect with no snapshot yet (same pattern as the
  // Android panel). A no-op when driven by props in tests.
  useEffect(() => {
    if (snapshotProp === undefined && storeConnected && storeSnapshot === null && !storeLoading) {
      requestWslStatus()
    }
  }, [snapshotProp, storeConnected, storeSnapshot, storeLoading, requestWslStatus])

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  return (
    <div className="cr-section" data-testid="wsl-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="wsl-eyebrow">
          host · wsl2 distros{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h2 className="cr-title">WSL2 distros</h2>
          <button
            type="button"
            className="cr-refresh"
            data-testid="wsl-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="wsl-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !snapshot.available && (
          <p className="cr-callout" data-testid="wsl-unavailable">
            {snapshot.note || 'WSL is not available on this host.'}
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="wsl-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="wsl-empty">
          {loading ? (
            <span>Running the WSL survey…</span>
          ) : (
            <>
              <p>No WSL survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="wsl-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="wsl-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot?.available && (
        snapshot.distros.length === 0 ? (
          <p className="cr-dim" data-testid="wsl-no-distros">
            No WSL distros are installed on this host.
          </p>
        ) : (
          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="wsl-table">
              <thead>
                <tr><th>Distro</th><th>Version</th><th>State</th><th>Action</th></tr>
              </thead>
              <tbody>
                {snapshot.distros.map((d) => {
                  const isRunning = d.state === 'Running'
                  const isStopped = d.state === 'Stopped'
                  const pending = actioningIds.has(d.name)
                  return (
                    <tr key={d.name} data-testid={`wsl-row-${d.name}`}>
                      <td>
                        <b data-testid={`wsl-name-${d.name}`}>{d.name}</b>{' '}
                        {d.isDefault && (
                          <span className="cr-tag cr-tag-ok" data-testid={`wsl-default-${d.name}`}>default</span>
                        )}
                      </td>
                      <td className="cr-dim" data-testid={`wsl-version-${d.name}`}>
                        {d.version === null ? '—' : `WSL ${d.version}`}
                      </td>
                      <td>
                        <span
                          className={`cr-tag ${isRunning ? 'cr-tag-ok' : 'cr-tag-dim'}`}
                          data-testid={`wsl-state-${d.name}`}
                        >
                          {d.state}
                        </span>
                      </td>
                      <td data-testid={`wsl-actions-${d.name}`}>
                        {isRunning ? (
                          <button
                            type="button"
                            className="cr-action"
                            data-testid={`wsl-terminate-${d.name}`}
                            disabled={pending || !connected}
                            onClick={() => onAction('terminate', d.name)}
                            title="Terminate this distro"
                          >
                            Terminate
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="cr-action"
                            data-testid={`wsl-start-${d.name}`}
                            disabled={pending || !connected || !isStopped}
                            onClick={() => onAction('start', d.name)}
                            title={isStopped ? 'Start this distro' : `Cannot start (state: ${d.state})`}
                          >
                            Start
                          </button>
                        )}{' '}
                        <WslActionFeedback distro={d.name} pending={pending} result={actionResults[d.name]} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )
      )}
    </div>
  )
}

function EmulatorActionFeedback({ id, pending, result }: { id: string; pending: boolean; result: EmulatorActionResult | undefined }) {
  if (pending) return <span className="cr-dim" data-testid={`emulator-pending-${id}`}>Working…</span>
  if (!result) return null
  if (result.error) return <span className="cr-bad" data-testid={`emulator-error-${id}`} role="alert">{result.error}</span>
  return <span className="cr-ok" data-testid={`emulator-ok-${id}`}>{result.note ?? 'done'}</span>
}

export interface AndroidEmulatorPanelProps {
  snapshot?: ServerEmulatorStatusSnapshotMessage | null
  loading?: boolean
  connected?: boolean
  onRefresh?: () => void
  actioningIds?: Set<string>
  actionResults?: Record<string, EmulatorActionResult>
  onAction?: (action: 'boot' | 'kill', opts: { avd?: string; serial?: string }) => void
  now?: () => number
}

/**
 * #6137 — the Android emulator half of the Device runtimes tab. Mirrors the iOS
 * panel above: the "Ready for Maestro" verdict + a per-device table with
 * state-aware Boot (a stopped AVD) / Kill (a live serial) buttons. The tab's
 * generic auto-fetch only covers the iOS survey, so this panel self-fetches the
 * emulator survey once on connect (and the Refresh button re-runs it).
 */
export function AndroidEmulatorPanel({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  actioningIds: actioningIdsProp,
  actionResults: actionResultsProp,
  onAction: onActionProp,
  now = Date.now,
}: AndroidEmulatorPanelProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.emulatorStatus)
  const storeLoading = useConnectionStore((s) => s.emulatorStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestEmulatorStatus = useConnectionStore((s) => s.requestEmulatorStatus)
  const storeActioningIds = useConnectionStore((s) => s.emulatorActioningIds)
  const storeActionResults = useConnectionStore((s) => s.emulatorActionResults)
  const sendEmulatorAction = useConnectionStore((s) => s.sendEmulatorAction)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestEmulatorStatus
  const actioningIds = actioningIdsProp ?? storeActioningIds
  const actionResults = actionResultsProp ?? storeActionResults
  const onAction = onActionProp ?? ((action: 'boot' | 'kill', opts: { avd?: string; serial?: string }) => sendEmulatorAction(action, opts))

  // The tab's generic auto-fetch only requests the iOS survey, so kick the
  // emulator survey once when we first connect with no snapshot yet. (When
  // driven by props in tests, the store selectors aren't used; this effect is a
  // no-op there because onRefresh is the injected prop.)
  useEffect(() => {
    if (snapshotProp === undefined && storeConnected && storeSnapshot === null && !storeLoading) {
      requestEmulatorStatus()
    }
  }, [snapshotProp, storeConnected, storeSnapshot, storeLoading, requestEmulatorStatus])

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN
  const verdict = snapshot?.readyForMaestro

  return (
    <div className="cr-section" data-testid="emulator-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="emulator-eyebrow">
          host · android emulators{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h2 className="cr-title">Android emulators</h2>
          <button
            type="button"
            className="cr-refresh"
            data-testid="emulator-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot?.error && (
          <p className="cr-callout cr-callout-bad" data-testid="emulator-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !snapshot.available && (
          <p className="cr-callout" data-testid="emulator-unavailable">
            {snapshot.note || 'Android emulators are not available on this host.'}
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="emulator-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="emulator-empty">
          {loading ? (
            <span>Running the emulator survey…</span>
          ) : (
            <>
              <p>No emulator survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="emulator-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="emulator-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot?.available && verdict && (
        <>
          <section
            className={`cr-callout ${verdict.ready ? 'cr-callout-ok' : 'cr-callout-bad'}`}
            data-testid="emulator-verdict"
            data-ready={verdict.ready ? 'true' : 'false'}
          >
            {verdict.ready ? (
              <p data-testid="emulator-verdict-ready">
                <b>✓ Ready for Maestro</b>
                {verdict.runningDevice ? ` — ${verdict.runningDevice} running, Metro + mock server reachable.` : ''}
              </p>
            ) : (
              <>
                <p data-testid="emulator-verdict-not-ready"><b>✗ Not ready for Maestro</b></p>
                <ul className="cr-reasons" data-testid="emulator-verdict-reasons">
                  {verdict.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {snapshot.devices.length === 0 ? (
            <p className="cr-dim" data-testid="emulator-no-devices">
              No AVDs are installed on this host.
            </p>
          ) : (
            <section className="cr-table-wrap">
              <table className="cr-table" data-testid="emulator-table">
                <thead>
                  <tr><th>Emulator</th><th>State</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {snapshot.devices.map((d) => {
                    const isLive = d.state !== 'stopped'
                    // Target id keys per-row pending/feedback. It matches the id
                    // sendEmulatorAction marks pending: serial for a live (kill)
                    // row, avd for a stopped (boot) row. A live row with no serial
                    // (schema-permitted, e.g. a just-starting emulator) falls back
                    // to its avd so pending/feedback still render under the row —
                    // the Kill button stays disabled (no serial → nothing to kill).
                    const targetId = isLive ? (d.serial ?? d.avd ?? '') : (d.avd ?? '')
                    const pending = targetId.length > 0 && actioningIds.has(targetId)
                    const rowKey = d.serial || d.avd || 'unknown'
                    return (
                      <tr key={rowKey} data-testid={`emulator-row-${rowKey}`}>
                        <td>
                          <b data-testid={`emulator-name-${rowKey}`}>{d.avd || d.serial || 'unknown'}</b>{' '}
                          {d.serial && <span className="cr-dim cr-mono">{d.serial}</span>}
                        </td>
                        <td>
                          <span
                            className={`cr-tag ${d.state === 'running' ? 'cr-tag-ok' : d.state === 'starting' ? 'cr-tag-warn' : 'cr-tag-dim'}`}
                            data-testid={`emulator-state-${rowKey}`}
                          >
                            {d.state}
                          </span>
                        </td>
                        <td data-testid={`emulator-actions-${rowKey}`}>
                          {isLive ? (
                            <button
                              type="button"
                              className="cr-action"
                              data-testid={`emulator-kill-${rowKey}`}
                              disabled={pending || !connected || !d.serial}
                              onClick={() => d.serial && onAction('kill', { serial: d.serial })}
                              title="Kill this emulator"
                            >
                              Kill
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="cr-action"
                              data-testid={`emulator-boot-${rowKey}`}
                              disabled={pending || !connected || !d.avd}
                              onClick={() => d.avd && onAction('boot', { avd: d.avd })}
                              title="Boot this emulator"
                            >
                              Boot
                            </button>
                          )}{' '}
                          {targetId.length > 0 && (
                            <EmulatorActionFeedback id={rowKey} pending={pending} result={actionResults[targetId]} />
                          )}
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
