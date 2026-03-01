/**
 * ReconnectBanner — connection lost notification with retry.
 */

export interface ReconnectBannerProps {
  visible: boolean
  attempt: number
  maxAttempts: number
  message?: string
  onRetry: () => void
}

export function ReconnectBanner({ visible, attempt, maxAttempts, message, onRetry }: ReconnectBannerProps) {
  if (!visible) return null

  return (
    <div className="reconnect-banner" data-testid="reconnect-banner" role="status">
      <span className="reconnect-message">
        {message || 'Connection lost. Reconnecting...'} (attempt {attempt}/{maxAttempts})
      </span>
      <button
        className="btn-retry"
        data-testid="retry-button"
        onClick={onRetry}
        type="button"
      >
        Retry
      </button>
    </div>
  )
}
