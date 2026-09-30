/**
 * PermissionExpiredSummary — end-of-turn summary for permission prompts that
 * expired unanswered during a turn (#7365).
 *
 * Distinct from — and does not replace — the per-prompt marker rendered by
 * `PermissionPrompt.tsx` ("Permission expired — Claude will continue without
 * this tool"), which stays exactly as it was. That marker is easy to miss
 * once the turn has moved on (one collapsed row in a long transcript); this
 * is the persistent, aggregate surface attached to the turn: how many
 * prompts expired, which tools they were for, and a jump back to the first
 * one.
 *
 * No native notification here by design — the permission notification
 * already fired when the prompt was raised (#7364); a second one per turn
 * for the same event would be noise.
 */
import { useCallback } from 'react'

export interface PermissionExpiredSummaryProps {
  /** Number of permission prompts in this turn that expired unanswered. */
  count: number
  /** Tool name for each expired prompt, same order as the underlying requestIds. */
  tools: string[]
  /**
   * `requestId` of the FIRST expired prompt in the turn — the jump target.
   * Matches `PermissionPrompt.tsx`'s `id={`perm-desc-${requestId}`}` anchor,
   * so no change to that component is needed to make the link land.
   */
  firstRequestId: string
}

function summaryText(count: number, tools: string[]): string {
  const uniqueTools = Array.from(new Set(tools))
  const noun = count === 1 ? 'permission' : 'permissions'
  return `${count} ${noun} expired without a response — ${uniqueTools.join(', ')}`
}

export function PermissionExpiredSummary({ count, tools, firstRequestId }: PermissionExpiredSummaryProps) {
  const targetId = `perm-desc-${firstRequestId}`

  // Real anchor-navigation (`href`) is the fallback for a target that isn't
  // currently mounted (a windowed-out row in a long transcript — see
  // ChatView.tsx's virtualization); `scrollIntoView` gives a smooth,
  // centered landing for the common case where it IS mounted. Both paths
  // land on the same element, so there is nothing to keep in sync.
  const handleJump = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      const target = document.getElementById(targetId)
      if (!target) return
      e.preventDefault()
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.focus({ preventScroll: true })
    },
    [targetId],
  )

  return (
    <div className="permission-expired-summary" data-testid="permission-expired-summary" role="status">
      <span className="permission-expired-summary-text" data-testid="permission-expired-summary-text">
        {summaryText(count, tools)}
      </span>
      <a
        className="permission-expired-summary-jump"
        data-testid="permission-expired-summary-jump"
        href={`#${targetId}`}
        onClick={handleJump}
      >
        Jump to prompt
      </a>
    </div>
  )
}
