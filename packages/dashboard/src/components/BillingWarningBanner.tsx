/**
 * BillingWarningBanner (#5821, live billing-canary wiring) — dismissible banner
 * shown when the daemon's billing canary reports one or more warnings during the
 * 2026-06-15 programmatic-credit window. Driven by the `billingCanary` snapshot
 * the store seeds from `auth_ok` and updates from `billing_canary` broadcasts.
 *
 * Warnings surfaced:
 * - SILENT_METERED_DEFAULT: the configured default provider draws the metered
 *   programmatic-credit pool (e.g. a `claude-sdk` default without an API key) —
 *   the live signal.
 * - TUI_REPORTED_PROGRAMMATIC_COST: a `claude-tui` session reported programmatic
 *   cost (a dormant tripwire — claude-tui normally bills as subscription).
 *
 * Empty warnings (or a dismissed banner) render nothing. Dismissal is
 * per-connection; a later broadcast with a CHANGED warning set re-surfaces it
 * (handled in the store).
 */

export interface BillingWarning {
  code: string
  message: string
  provider?: string
  sessionId?: string
  costUsd?: number
}

export interface BillingWarningBannerProps {
  warnings: BillingWarning[]
  dismissed: boolean
  onDismiss: () => void
}

export function BillingWarningBanner({ warnings, dismissed, onDismiss }: BillingWarningBannerProps) {
  if (dismissed || !warnings || warnings.length === 0) return null

  return (
    // role="status" + aria-live="polite" per the dashboard convention
    // (see ExposureWarningBanner / StdinDisabledBanner): a billing warning is
    // informative, not an emergency interruption.
    <div
      className="exposure-warning-banner"
      data-testid="billing-warning-banner"
      role="status"
      aria-live="polite"
    >
      <span className="exposure-warning-icon" aria-hidden="true">
        $
      </span>
      <span className="exposure-warning-message" data-testid="billing-warning-message">
        {warnings.map((w) => w.message).join(' ')}
      </span>
      <button
        className="btn-retry"
        data-testid="billing-dismiss-button"
        onClick={onDismiss}
        type="button"
      >
        Dismiss
      </button>
    </div>
  )
}
