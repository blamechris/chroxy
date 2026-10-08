/**
 * PermissionOutcomeRecord — the compact transcript line for a permission prompt
 * that has ENDED (#7353, #8348).
 *
 * A prompt that expired or was answered is the only trace of a tool call the
 * agent asked for, so it stays in the transcript as a muted line with no
 * controls and no countdown. Two things render it:
 *
 *   - `PermissionPrompt`, when an expired card is dismissed (#7353): the card
 *     collapses to this line instead of vanishing;
 *   - `useMessageRenderer`, for a `permission_outcome` the server replayed
 *     (#8348), so the line survives a session switch or a reload — the live card
 *     does not, because `permission_request` frames are never in history.
 *
 * `stopped` (#8374) is a prompt the user cancelled with Stop: nothing timed out
 * and nobody refused it, so it says neither "expired" nor "denied". It is the
 * record for both a live Stop and a replayed one.
 *
 * The `expired` wording and test id are #7353's, unchanged. It keeps the
 * `perm-desc-<id>` anchor the end-of-turn expired summary's "Jump to prompt"
 * link lands on. The `title` carries the full text for the 3-line clamp.
 */
import type { PermissionOutcomeKind } from '@chroxy/store-core'

export interface PermissionOutcomeRecordProps {
  requestId: string
  tool: string
  description: string
  outcome: PermissionOutcomeKind
}

const LEAD: Record<PermissionOutcomeKind, string> = {
  expired: 'Permission expired',
  allowed: 'Permission allowed',
  denied: 'Permission denied',
  stopped: 'Permission stopped',
}

export function PermissionOutcomeRecord({ requestId, tool, description, outcome }: PermissionOutcomeRecordProps) {
  const expired = outcome === 'expired'
  return (
    <div
      className="permission-prompt permission-prompt-dropped"
      // #7353's id for the expired line; the answered lines are new (#8348).
      data-testid={expired ? 'perm-dropped-record' : 'perm-outcome-record'}
      data-outcome={outcome}
      role="status"
      title={`${tool}: ${description}`}
    >
      <span className="perm-dropped-text" id={`perm-desc-${requestId}`} tabIndex={-1}>
        {LEAD[outcome]} — <span className="perm-tool">{tool}</span>: {description}
        {expired ? ' — dropped' : ''}
        {outcome === 'stopped' ? ' — not run' : ''}
      </span>
    </div>
  )
}
