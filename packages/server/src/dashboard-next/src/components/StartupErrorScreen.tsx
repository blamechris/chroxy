/**
 * StartupErrorScreen — shown when the server fails to start (Tauri desktop).
 *
 * Displays the error message and, if available, the server's stdout/stderr
 * logs fetched via the `get_server_logs` Tauri IPC command.
 */

export interface StartupErrorScreenProps {
  error: string
  logs: string[] | null
  onRetry: () => void
  onStartServer?: () => void
}

export function StartupErrorScreen({ error, logs, onRetry, onStartServer }: StartupErrorScreenProps) {
  const hasLogs = logs && logs.length > 0

  return (
    <div className="startup-error-screen" data-testid="startup-error-screen">
      <div className="startup-error-content">
        <h2 className="startup-error-title">Server Failed to Start</h2>
        <p className="startup-error-message">{error}</p>

        {hasLogs && (
          <div className="startup-error-logs" data-testid="startup-error-logs">
            <h3 className="startup-error-logs-title">Server Logs</h3>
            <pre className="startup-error-logs-content">
              {logs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </pre>
          </div>
        )}

        <div className="startup-error-actions">
          {onStartServer && (
            <button
              className="startup-error-retry-btn startup-error-start-btn"
              onClick={onStartServer}
              type="button"
              aria-label="Start Server"
              data-testid="start-server-button"
            >
              Start Server
            </button>
          )}
          <button
            className="startup-error-retry-btn"
            onClick={onRetry}
            type="button"
            aria-label="Retry"
          >
            Reconnect
          </button>
        </div>
      </div>
    </div>
  )
}
