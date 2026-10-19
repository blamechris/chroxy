import type { SessionDefaultsNotice as SessionDefaultsNoticeValue } from '../store/session-defaults'
import { PROVIDER_LABELS } from '../lib/provider-labels'

/** Message shared by New Session and Settings after a legacy default is cleared. */
export function sessionDefaultsNoticeText(notice: SessionDefaultsNoticeValue): string {
  const parts: string[] = []
  if (notice.provider) parts.push(`provider ${PROVIDER_LABELS[notice.provider] || notice.provider}`)
  if (notice.model) parts.push(`model ${notice.model}`)
  const follows: string[] = []
  if (notice.provider) follows.push("the server's default provider")
  if (notice.model) follows.push("the provider's own default model")
  return `A saved default from an older version was cleared (${parts.join(', ')}). New sessions now use ${follows.join(' and ')}. To keep the old choice, pick it again in Settings → Session Defaults.`
}

export function SessionDefaultsNotice({ notice, onDismiss }: {
  notice: SessionDefaultsNoticeValue
  onDismiss: () => void
}) {
  return (
    <div className="provider-fix-hint session-defaults-notice" role="status" data-testid="session-defaults-notice">
      <span className="provider-fix-hint-body">{sessionDefaultsNoticeText(notice)}</span>
      <button
        type="button"
        className="session-defaults-notice-dismiss"
        onClick={onDismiss}
        data-testid="session-defaults-notice-dismiss"
      >
        Dismiss
      </button>
    </div>
  )
}
