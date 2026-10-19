import { useConnectionStore } from '../store/connection'
import type { SessionDefaultsNotice } from '../store/session-defaults'
import { PROVIDER_LABELS } from '../lib/provider-labels'

/**
 * #8265: the one-time notice shown after migrateSessionDefaults cleared a
 * legacy saved default. A pure helper so the copy is unit-testable.
 */
export function sessionDefaultsNoticeText(notice: SessionDefaultsNotice): string {
  const parts: string[] = []
  if (notice.provider) parts.push(`provider ${PROVIDER_LABELS[notice.provider] || notice.provider}`)
  if (notice.model) parts.push(`model ${notice.model}`)
  const follows: string[] = []
  if (notice.provider) follows.push("the server's default provider")
  if (notice.model) follows.push("the provider's own default model")
  return `A saved default from an older version was cleared (${parts.join(', ')}). New sessions now use ${follows.join(' and ')}. To keep the old choice, pick it again in Settings → Session Defaults.`
}

/**
 * #8277: the undismissed migration notice with its dismiss control. Rendered
 * in New Session and in Settings → Session Defaults, so a user who changes
 * defaults in either place sees it, and dismissing in one clears it in both
 * (one store field). Renders nothing when there is no notice.
 */
export function SessionDefaultsNoticeBanner() {
  const notice = useConnectionStore(s => s.sessionDefaultsNotice)
  const dismiss = useConnectionStore(s => s.dismissSessionDefaultsNotice)
  if (!notice) return null
  return (
    <div className="provider-fix-hint session-defaults-notice" role="status" data-testid="session-defaults-notice">
      <span className="provider-fix-hint-body">{sessionDefaultsNoticeText(notice)}</span>
      <button
        type="button"
        className="session-defaults-notice-dismiss"
        onClick={dismiss}
        data-testid="session-defaults-notice-dismiss"
      >
        Dismiss
      </button>
    </div>
  )
}
