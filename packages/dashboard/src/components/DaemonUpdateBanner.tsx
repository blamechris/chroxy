/**
 * DaemonUpdateBanner (#8331) — the dashboard face of the daily daemon's idle-only
 * auto-deploy (#8324), the way an app's auto-update looks: a merge queues an
 * update, the daemon restarts itself when idle, and you can see it, hurry it, hold
 * it off, and tell afterwards that it happened.
 *
 * Three independent surfaces, all fed by the server's `daemon_update_status`
 * (which only a strict-primary client ever receives — a paired phone's store never
 * holds one, so nothing here renders for it):
 *
 *   - the BANNER: an update is waiting. "Update ready (<sha>) — restarts when
 *     idle" with Restart now / Postpone 1h; once postponed, "postponed until
 *     HH:MM" with Restart now; once a request is on its way, "Restarting to apply
 *     <sha>…".
 *   - the CONFIRM dialog: Restart now met busy sessions and the server wrote
 *     nothing yet. It lists what would be interrupted; "Restart anyway" re-sends
 *     with `confirmBusy`. The server, not this component, decides `force`.
 *   - the NOTICE: after a deploy, "Updated to <sha> — <subject>" once per commit,
 *     or "Update <sha> failed and was rolled back". "Once" is localStorage keyed
 *     per outcome + commit; storage that throws just means it may show again.
 *
 * Tap targets are 44px (see CLAUDE.md), and every control has a data-testid for
 * the smoke run.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ServerDaemonUpdateConfirmRequiredMessage, ServerDaemonUpdateStatusMessage } from '@chroxy/protocol'
import { ConfirmDialog } from './ConfirmDialog'

const NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** A restart request the script has not picked up after this long is waiting for its next scheduled check. */
export const REQUEST_SLOW_MS = 30_000
const SEEN_PREFIX = 'chroxy.daemonUpdate.notice.'

export type DaemonUpdateNotice = {
  /** localStorage key: one per outcome and commit. */
  key: string
  kind: 'updated' | 'rolled-back' | 'rollback-failed'
  sha: string
  subject: string
  /** An honest caveat riding a success (the tunnel never answered). */
  note: string | null
}

export const shortSha = (sha: string): string => sha.slice(0, 7)

/** HH:MM in the viewer's own clock. */
export function formatClock(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * What, if anything, the last deploy result says to the owner.
 *
 * `result` strings are the deploy script's own (scripts/deploy-daemon.mjs
 * `recordResult`): `ok`, `deployed-tunnel-unverified`, `rolled-back-build`,
 * `rolled-back-restart`, `rolled-back`, `rollback-failed`, `rollback-manual-restart`.
 * Which commit FAILED differs by result: for the first two rollbacks the record's
 * `to` is the failed target, but for a health-failure `rolled-back` the record is
 * written bad -> good, so the failed commit is `from`. Anything else (including an
 * owed-rollback bookkeeping result) is not news.
 */
export function deriveNotice(status: ServerDaemonUpdateStatusMessage, nowMs: number): DaemonUpdateNotice | null {
  const last = status.lastDeploy
  if (!last) return null
  const age = nowMs - Date.parse(last.at)
  if (!Number.isFinite(age) || age > NOTICE_WINDOW_MS) return null
  const make = (kind: DaemonUpdateNotice['kind'], sha: string, note: string | null = null): DaemonUpdateNotice => ({
    key: `${SEEN_PREFIX}${kind}.${sha}`,
    kind,
    sha,
    subject: last.subject,
    note,
  })
  const r = last.result
  if (r === 'ok' || r.startsWith('ok (') || r === 'deployed-tunnel-unverified') {
    // "Updated to X" is only true while the daemon is KNOWN to be running X. A daemon
    // that cannot say what it runs (null), or that runs another commit (a manual
    // restart since), makes the record history, not news: with no evidence there is
    // no claim.
    if (status.running === null || status.running !== last.to) return null
    return make('updated', last.to, r === 'deployed-tunnel-unverified' ? 'the tunnel did not answer yet' : null)
  }
  if (r === 'rolled-back-build' || r === 'rolled-back-restart') return make('rolled-back', last.to)
  if (r === 'rolled-back') return last.from ? make('rolled-back', last.from) : null
  if (r === 'rollback-failed') return make('rollback-failed', last.to)
  return null
}

function wasSeen(key: string): boolean {
  try { return window.localStorage.getItem(key) !== null } catch { return false }
}
function markSeen(key: string): void {
  try { window.localStorage.setItem(key, '1') } catch { /* private window / blocked storage: it may show again */ }
}

export interface DaemonUpdateBannerProps {
  status: ServerDaemonUpdateStatusMessage | null
  /** A restart-now / postpone request is in flight. */
  busy: boolean
  confirm: ServerDaemonUpdateConfirmRequiredMessage | null
  error: string | null
  onRestartNow: (target: string) => void
  onPostpone: (target: string) => void
  /** The confirm dialog's "Restart anyway". */
  onConfirmRestart: (target: string) => void
  onCancelConfirm: () => void
  onDismissError: () => void
  /** Clock seam for tests. */
  now?: () => number
}

export function DaemonUpdateBanner({
  status, busy, confirm, error,
  onRestartNow, onPostpone, onConfirmRestart, onCancelConfirm, onDismissError, now = Date.now,
}: DaemonUpdateBannerProps) {
  const pending = status?.pending ?? null
  const notice = useMemo(() => (status ? deriveNotice(status, now()) : null), [status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Once per commit. `announced` outlives a StrictMode double-effect (same
  // instance, same refs), so the second pass re-shows what the first one marked
  // seen instead of finding the key already written and hiding it.
  const [shownKey, setShownKey] = useState<string | null>(null)
  const announced = useRef(new Set<string>())
  const dismissed = useRef(new Set<string>())
  const noticeKey = notice?.key ?? null
  useEffect(() => {
    if (!noticeKey) { setShownKey(null); return }
    if (dismissed.current.has(noticeKey)) return
    if (announced.current.has(noticeKey)) { setShownKey(noticeKey); return }
    if (wasSeen(noticeKey)) return
    markSeen(noticeKey)
    announced.current.add(noticeKey)
    setShownKey(noticeKey)
  }, [noticeKey])
  const shownNotice = notice && shownKey === notice.key ? notice : null

  // A request the script has not picked up for 30 s is waiting for its next scheduled
  // check (launchd runs it every 10 minutes unless a WatchPaths entry fires it sooner).
  const waitingOnRequest = Boolean(pending && status?.requestPending && !status?.applying)
  const [requestSlow, setRequestSlow] = useState(false)
  const pendingTarget = pending?.target ?? null
  useEffect(() => {
    if (!waitingOnRequest) { setRequestSlow(false); return }
    const t = setTimeout(() => setRequestSlow(true), REQUEST_SLOW_MS)
    return () => clearTimeout(t)
  }, [waitingOnRequest, pendingTarget])

  let bannerText = ''
  let bannerState: 'restarting' | 'requested' | 'postponed' | 'unknown' | 'ready' = 'ready'
  if (pending) {
    const sha = shortSha(pending.target)
    if (status?.applying) { bannerState = 'restarting'; bannerText = `Restarting to apply ${sha}…` }
    else if (status?.requestPending) {
      if (requestSlow) { bannerState = 'requested'; bannerText = 'Restart requested — applies at the next scheduled check' }
      else { bannerState = 'restarting'; bannerText = `Restarting to apply ${sha}…` }
    }
    else if (status?.postponedUntil) { bannerState = 'postponed'; bannerText = `Update ${sha} postponed until ${formatClock(status.postponedUntil)}` }
    // The daemon could not confirm it is idle: Restart now cannot help (a forced restart never covers an unknown daemon), so it is not offered.
    else if (pending.reason === 'unknown') { bannerState = 'unknown'; bannerText = `Update ready (${sha}) — can't confirm the daemon is idle` }
    else bannerText = `Update ready (${sha}) — restarts when idle`
  }

  const reasons = confirm?.reasons ?? []
  const sessionNames = (confirm?.sessions ?? []).map((s) => s.name || s.sessionId)

  return (
    <>
      {(pending || shownNotice || error) && (
        <div className="daemon-update-region" data-testid="daemon-update-region">
          {pending && (
            <div className="daemon-update-banner" data-testid="daemon-update-banner" data-state={bannerState} role="status" aria-live="polite">
              <span className="daemon-update-message" data-testid="daemon-update-message">{bannerText}</span>
              {pending.subject && (
                <span className="daemon-update-subject" data-testid="daemon-update-subject" title={pending.subject}>
                  {pending.subject}
                  {pending.commitsAhead !== null && pending.commitsAhead > 1 ? ` (+${pending.commitsAhead - 1} more)` : ''}
                </span>
              )}
              {bannerState !== 'restarting' && bannerState !== 'requested' && (
                <span className="daemon-update-actions">
                  {bannerState !== 'unknown' && (
                    <button type="button" className="daemon-update-btn" data-testid="daemon-update-restart-now" disabled={busy} onClick={() => onRestartNow(pending.target)}>
                      Restart now
                    </button>
                  )}
                  {(bannerState === 'ready' || bannerState === 'unknown') && (
                    <button type="button" className="daemon-update-btn" data-testid="daemon-update-postpone" disabled={busy} onClick={() => onPostpone(pending.target)}>
                      Postpone 1h
                    </button>
                  )}
                </span>
              )}
            </div>
          )}
          {shownNotice && (
            <div
              className={`daemon-update-notice${shownNotice.kind === 'updated' ? '' : ' daemon-update-notice--bad'}`}
              data-testid="daemon-update-notice"
              data-kind={shownNotice.kind}
              role="status"
              aria-live="polite"
            >
              <span className="daemon-update-message" data-testid="daemon-update-notice-message">
                {shownNotice.kind === 'updated' && `Updated to ${shortSha(shownNotice.sha)}${shownNotice.subject ? ` — ${shownNotice.subject}` : ''}${shownNotice.note ? ` (${shownNotice.note})` : ''}`}
                {shownNotice.kind === 'rolled-back' && `Update ${shortSha(shownNotice.sha)} failed and was rolled back`}
                {shownNotice.kind === 'rollback-failed' && `Update ${shortSha(shownNotice.sha)} failed and the rollback failed too — check the daemon`}
              </span>
              <button
                type="button"
                className="daemon-update-btn"
                data-testid="daemon-update-notice-dismiss"
                onClick={() => { dismissed.current.add(shownNotice.key); setShownKey(null) }}
              >
                Dismiss
              </button>
            </div>
          )}
          {error && (
            <div className="daemon-update-notice daemon-update-notice--bad" data-testid="daemon-update-error" role="alert">
              <span className="daemon-update-message">{error}</span>
              <button type="button" className="daemon-update-btn" data-testid="daemon-update-error-dismiss" onClick={onDismissError}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(confirm)}
        title="Restart the daemon now?"
        danger
        confirmLabel="Restart anyway"
        cancelLabel="Cancel"
        onConfirm={() => { if (confirm) onConfirmRestart(confirm.target) }}
        onCancel={onCancelConfirm}
        message={(
          <div data-testid="daemon-update-confirm">
            <p>Restarting now will interrupt work in progress:</p>
            {reasons.length > 0 || sessionNames.length > 0 ? (
              <ul data-testid="daemon-update-confirm-reasons">
                {(reasons.length > 0 ? reasons : sessionNames).map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            ) : (
              <p data-testid="daemon-update-confirm-unknown">The daemon could not confirm that it is idle.</p>
            )}
          </div>
        )}
      />
    </>
  )
}
