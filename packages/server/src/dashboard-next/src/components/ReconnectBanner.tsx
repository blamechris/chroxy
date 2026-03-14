/**
 * ReconnectBanner — connection lost notification with retry.
 */

export interface ReconnectBannerProps {
  visible: boolean
  attempt: number
  maxAttempts: number
  message?: string
  onRetry: () => void
  onStartServer?: () => void
}

export function ReconnectBanner({ visible, attempt, maxAttempts, message, onRetry, onStartServer }: ReconnectBannerProps) {
  if (!visible) return null

  return (
    <div className="reconnect-banner" data-testid="reconnect-banner" role="status" aria-live="polite">
      <span className="reconnect-message">
        {message || 'Connection lost. Reconnecting...'} (attempt {attempt}/{maxAttempts})
      </span>
      {onStartServer && (
        <button
          className="btn-retry"
          data-testid="start-server-button"
          onClick={onStartServer}
          type="button"
        >
          Start Server
        </button>
      )}
      <button
        className="btn-retry"
        data-testid="retry-button"
        onClick={onRetry}
        type="button"
      >
        Reconnect
      </button>
    </div>
  )
}
