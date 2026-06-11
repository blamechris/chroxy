/**
 * PendingPairRequests — host-level approval surface for the pairing-approval
 * primitive (#5510, epic #5509).
 *
 * A camera-less device requests pairing without a QR; the daemon fans the
 * request out to host surfaces as `pair_pending`. This banner shows the
 * requesting device's name and the 6-digit verify code to COMPARE against the
 * code shown on the new device, with Approve / Deny actions. Approving sends
 * `pair_approve` (the server issues a session token to the requester); denying
 * sends `pair_deny`.
 *
 * Security: `deviceName` is attacker-controlled and rendered as plain text
 * (React escapes — no markdown/HTML interpolation). The verify code travels
 * ONLY server→surface; the operator confirms it out-of-band by eyeballing both
 * screens. Mirrors the NotificationBanners stacked-banner pattern.
 */
import type { ServerPairPendingMessage } from '@chroxy/protocol'

export interface PendingPairRequestsProps {
  requests: ServerPairPendingMessage[]
  onApprove: (requestId: string) => void
  onDeny: (requestId: string) => void
}

export function PendingPairRequests({ requests, onApprove, onDeny }: PendingPairRequestsProps) {
  // Defensive: a missing/undefined store slice must not white-screen the whole
  // dashboard — render nothing rather than throw on `.length`/`.map`.
  if (!requests || requests.length === 0) return null

  return (
    <div
      className="pair-requests"
      data-testid="pair-requests"
      // role="log" (not "alertdialog") — this is a non-modal stacked banner
      // with no focus management/containment, matching NotificationBanners.
      role="log"
      aria-label="Pending device pairing requests"
    >
      {requests.map((r) => (
        <div
          key={r.requestId}
          className="pair-request-banner"
          data-testid={`pair-request-${r.requestId}`}
        >
          <div className="pair-request-content">
            <span className="pair-request-title">Pairing request</span>
            <span className="pair-request-device" data-testid="pair-request-device">
              {r.deviceName || 'Unknown device'}
            </span>
            <span className="pair-request-compare">
              Compare this code with the new device:
            </span>
            <span className="pair-request-code" data-testid="pair-request-code">
              {r.verifyCode}
            </span>
          </div>
          <div className="pair-request-actions">
            <button
              type="button"
              className="pair-request-btn pair-request-btn--approve"
              data-testid="pair-request-approve"
              aria-label={`Approve pairing for ${r.deviceName || 'unknown device'}`}
              onClick={() => onApprove(r.requestId)}
            >
              Approve
            </button>
            <button
              type="button"
              className="pair-request-btn pair-request-btn--deny"
              data-testid="pair-request-deny"
              aria-label={`Deny pairing for ${r.deviceName || 'unknown device'}`}
              onClick={() => onDeny(r.requestId)}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
