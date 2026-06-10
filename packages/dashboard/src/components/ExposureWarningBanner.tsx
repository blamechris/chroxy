/**
 * ExposureWarningBanner (#5356, visibility layer) — dismissible warning shown
 * when the server reports an exposed network posture in its auth_ok
 * `exposure` snapshot:
 *
 * - `lanBind`: the server is bound to a non-loopback interface (the
 *   historical 0.0.0.0 default included), so devices on the local network
 *   can reach its auth/pairing endpoints (bearer-gated, but the server is
 *   fingerprintable via /health).
 * - `quickTunnel`: a public trycloudflare quick tunnel is configured —
 *   recorded by the server before tunnel startup, so this is a posture
 *   signal, not proof the tunnel is established. Once it comes up, the
 *   server is internet-reachable at a random public URL (bearer-gated).
 *
 * This banner changes no defaults — it only surfaces the current posture and
 * how to restrict it. Dismissal is per-connection (store flag, reset on a
 * fresh non-reconnect auth); see `exposureBannerDismissed` in the store.
 */

export interface ExposureWarningBannerProps {
  lanBind: boolean
  quickTunnel: boolean
  onDismiss: () => void
}

export function ExposureWarningBanner({ lanBind, quickTunnel, onDismiss }: ExposureWarningBannerProps) {
  if (!lanBind && !quickTunnel) return null

  const parts: string[] = []
  if (lanBind) {
    parts.push(
      'Server is listening on all network interfaces — devices on your network can reach its auth and pairing endpoints. Restrict with --host 127.0.0.1.',
    )
  }
  if (quickTunnel) {
    parts.push(
      'A public quick tunnel is configured — once established, anyone with its URL can probe this server (bearer-token gated). Use --tunnel none or --tunnel named to change this.',
    )
  }

  return (
    // role="status" + aria-live="polite" per the dashboard convention
    // (see StdinDisabledBanner / Toast): a posture warning is informative,
    // not an emergency interruption.
    <div
      className="exposure-warning-banner"
      data-testid="exposure-warning-banner"
      role="status"
      aria-live="polite"
    >
      <span className="exposure-warning-icon" aria-hidden="true">
        !
      </span>
      <span className="exposure-warning-message" data-testid="exposure-warning-message">
        {parts.join(' ')}
      </span>
      <button
        className="btn-retry"
        data-testid="exposure-dismiss-button"
        onClick={onDismiss}
        type="button"
      >
        Dismiss
      </button>
    </div>
  )
}
