import { useConnectionStore } from '../store/connection'
import type { SessionDefaultsNotice as SessionDefaultsNoticeData } from '../store/session-defaults'
import { PROVIDER_LABELS } from '../lib/provider-labels'

/**
 * #8265: the one-time notice shown after migrateSessionDefaults cleared a
 * legacy saved default. A pure helper so the copy is unit-testable.
 */
export function sessionDefaultsNoticeText(notice: SessionDefaultsNoticeData): string {
  const parts: string[] = []
  if (notice.provider) parts.push(`provider ${PROVIDER_LABELS[notice.provider] || notice.provider}`)
  if (notice.model) parts.push(`model ${notice.model}`)
  const follows: string[] = []
  if (notice.provider) follows.push("the server's default provider")
  if (notice.model) follows.push("the provider's own default model")
  return `A saved default from an older version was cleared (${parts.join(', ')}). New sessions now use ${follows.join(' and ')}. To keep the old choice, pick it again in Settings → Session Defaults.`
}

/**
 * #8277: the migration notice, shared by New Session and Settings → Session
 * Defaults. Both read and dismiss the same store state, so dismissing in one
 * place clears it in the other. Renders nothing once dismissed.
 */
export function SessionDefaultsNotice() {
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
