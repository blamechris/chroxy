/**
 * ErrorScreen — server startup failure display.
 *
 * Shows error details with a retry button.
 * Used when the server fails to start or health check times out.
 */

export interface ErrorScreenProps {
  /** Error heading */
  title: string
  /** Primary error description */
  message: string
  /** Additional details or troubleshooting steps */
  details?: string
  /** Retry callback */
  onRetry: () => void
}

export function ErrorScreen({ title, message, details, onRetry }: ErrorScreenProps) {
  return (
    <div className="error-screen" data-testid="error-screen">
      <div className="error-screen-container">
        <div className="error-screen-logo">Chroxy</div>

        <div className="error-screen-box">
          <h3 className="error-screen-title">{title}</h3>
          <p className="error-screen-message">{message}</p>
          {details && (
            <p className="error-screen-details" data-testid="error-details">
              {details}
            </p>
          )}
        </div>

        <button
          className="error-screen-retry"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      </div>
    </div>
  )
}
