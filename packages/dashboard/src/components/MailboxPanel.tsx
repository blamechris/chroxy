/**
 * MailboxPanel (#5914 follow-up) — the "Mailbox" Control Room tab.
 *
 * Observability for the agent-to-agent mailbox live-interrupt path. Renders the
 * daemon's `mailbox_status_snapshot`: the live `agentCommId → session`
 * registrations (which mailbox ids are addressable, the session each resolves
 * to, and whether that session is busy / claude-tui — the conditions the route
 * injects under) plus a bounded ring buffer of recent delivery attempts.
 *
 * Same pull-on-Refresh data flow as the host / runner surveys: the Refresh
 * button dispatches `mailbox_status_request` via the store's
 * `requestMailboxStatus`; the server replies with one `mailbox_status_snapshot`
 * handled into `mailboxStatus`. No delta stream — each refresh replaces the
 * whole snapshot.
 *
 * Outcome → accent (mirrors handleMailboxPing's `reason`):
 *   - injected   → ok   (green) — woke the idle claude-tui recipient now.
 *   - busy       → warn (amber) — recipient mid-turn; notified, the idle hook drains it.
 *   - not-tui    → warn (amber) — non-tui session; notify-only.
 *   - no-session → bad  (red)   — no session registered for that id.
 *   - pty-dead   → bad  (red)   — the recipient's PTY write failed.
 */
import { useConnectionStore } from '../store/connection'
import type { ServerMailboxStatusSnapshotMessage, MailboxDeliveryEvent, MailboxRegistration } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'

type Accent = 'ok' | 'warn' | 'bad' | 'neutral'
type Outcome = MailboxDeliveryEvent['outcome']

const OUTCOME_ACCENT: Record<Outcome, Accent> = {
  injected: 'ok',
  busy: 'warn',
  'not-tui': 'warn',
  'no-session': 'bad',
  'pty-dead': 'bad',
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  injected: 'Woke session',
  busy: 'Busy · notified',
  'not-tui': 'Notified',
  'no-session': 'No session',
  'pty-dead': 'PTY closed',
}

/** ISO date (no time) for the eyebrow, e.g. "2026-06-16". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** Deterministic UTC clock (HH:MM:SS) for an event timestamp (epoch ms). */
function eventClock(at: number): string {
  if (!Number.isFinite(at)) return '—'
  return new Date(at).toISOString().slice(11, 19)
}

function OutcomeTag({ outcome }: { outcome: Outcome }) {
  const accent = OUTCOME_ACCENT[outcome]
  return (
    <span className={`cr-tag cr-tag-${accent}`} data-testid={`mailbox-outcome-${outcome}`} data-accent={accent} title={outcome}>
      {OUTCOME_LABEL[outcome]}
    </span>
  )
}

function RegistrationRow({ reg }: { reg: MailboxRegistration }) {
  return (
    <tr data-testid={`mailbox-reg-${reg.agentCommId}`}>
      <td>
        <b className="cr-mono" data-testid={`mailbox-reg-id-${reg.agentCommId}`}>{reg.agentCommId}</b>
      </td>
      <td>
        <span data-testid={`mailbox-reg-session-${reg.agentCommId}`}>{reg.sessionName ?? '(unnamed)'}</span>
        <div className="cr-dim cr-mono cr-branch" title={reg.sessionId}>{reg.sessionId}</div>
      </td>
      <td>
        {reg.isBusy ? (
          <span className="cr-warn" data-testid={`mailbox-reg-state-${reg.agentCommId}`}>Busy</span>
        ) : (
          <span className="cr-ok" data-testid={`mailbox-reg-state-${reg.agentCommId}`}>Idle</span>
        )}
      </td>
      <td className="cr-dim" data-testid={`mailbox-reg-pty-${reg.agentCommId}`}>
        {reg.isTui ? 'claude-tui' : 'notify-only'}
      </td>
    </tr>
  )
}

function DeliveryRow({ event, index }: { event: MailboxDeliveryEvent; index: number }) {
  return (
    <tr data-testid={`mailbox-event-${index}`}>
      <td className="cr-dim cr-mono" data-testid={`mailbox-event-time-${index}`} title={new Date(event.at).toISOString()}>
        {eventClock(event.at)}
      </td>
      <td className="cr-mono">{event.to}</td>
      <td className="cr-dim">{event.from}</td>
      <td className="cr-dim cr-mono" data-testid={`mailbox-event-unread-${index}`}>
        {event.unreadCount === null ? '—' : event.unreadCount}
      </td>
      <td><OutcomeTag outcome={event.outcome} /></td>
    </tr>
  )
}

export interface MailboxPanelProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerMailboxStatusSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestMailboxStatus. */
  onRefresh?: () => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" string. */
  now?: () => number
}

export function MailboxPanel({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: MailboxPanelProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.mailboxStatus)
  const storeLoading = useConnectionStore((s) => s.mailboxStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestMailboxStatus = useConnectionStore((s) => s.requestMailboxStatus)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestMailboxStatus

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  return (
    <div className="cr-section" data-testid="mailbox-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="mailbox-eyebrow">
          host · mailbox{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Mailbox</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="mailbox-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="mailbox-sub">
            {snapshot.registrations.length} registration{snapshot.registrations.length === 1 ? '' : 's'} ·{' '}
            {snapshot.recentEvents.length} recent deliver{snapshot.recentEvents.length === 1 ? 'y' : 'ies'} — agents
            addressable by the live-interrupt route, and what it did with the last pings.
          </p>
        )}
        {snapshot && snapshot.error && (
          <p className="cr-callout cr-callout-bad" data-testid="mailbox-error" role="alert">
            <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="mailbox-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="mailbox-empty">
          {loading ? (
            <span>Loading the mailbox snapshot…</span>
          ) : (
            <>
              <p>No mailbox snapshot yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="mailbox-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Load snapshot
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="mailbox-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="mailbox-chips">
            <span className="cr-chip" data-testid="mailbox-chip-registrations">
              Registered: <b data-testid="mailbox-chip-count-registrations">{snapshot.registrations.length}</b>
            </span>
            <span className="cr-chip" data-testid="mailbox-chip-deliveries">
              Recent deliveries: <b data-testid="mailbox-chip-count-deliveries">{snapshot.recentEvents.length}</b>
            </span>
          </div>

          <div className="cr-callout" data-testid="mailbox-callout">
            <b>How delivery works:</b> when mail arrives, chroxy notifies and — if the recipient is a{' '}
            <b>live, idle claude-tui</b> session — injects a "run receive_next" wakeup (<b>Woke session</b>).{' '}
            A <b>busy</b> recipient is notified and drains on its next idle via the portable hook. A{' '}
            <b>non-tui</b> session is notify-only. <b>No session</b> / <b>PTY closed</b> mean the id resolved to
            nothing live.
          </div>

          <section className="cr-table-wrap">
            <h2 className="cr-subtitle" data-testid="mailbox-registrations-title">Registrations</h2>
            <table className="cr-table" data-testid="mailbox-registrations-table">
              <thead>
                <tr>
                  <th>Mailbox id</th>
                  <th>Session</th>
                  <th>State</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.registrations.length === 0 ? (
                  <tr data-testid="mailbox-no-registrations">
                    <td colSpan={4} className="cr-dim">No sessions are registered as mailbox recipients.</td>
                  </tr>
                ) : (
                  snapshot.registrations.map((reg) => <RegistrationRow key={reg.agentCommId} reg={reg} />)
                )}
              </tbody>
            </table>
          </section>

          <section className="cr-table-wrap">
            <h2 className="cr-subtitle" data-testid="mailbox-deliveries-title">Recent deliveries</h2>
            <table className="cr-table" data-testid="mailbox-deliveries-table">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>To</th>
                  <th>From</th>
                  <th>Unread</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recentEvents.length === 0 ? (
                  <tr data-testid="mailbox-no-deliveries">
                    <td colSpan={5} className="cr-dim">No mailbox deliveries recorded yet.</td>
                  </tr>
                ) : (
                  snapshot.recentEvents.map((event, i) => <DeliveryRow key={`${event.at}-${i}`} event={event} index={i} />)
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
