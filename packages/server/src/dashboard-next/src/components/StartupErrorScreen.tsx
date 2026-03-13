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
}

export function StartupErrorScreen({ error, logs, onRetry }: StartupErrorScreenProps) {
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

        <button
          className="startup-error-retry-btn"
          onClick={onRetry}
          type="button"
          aria-label="Retry"
        >
          Retry
        </button>
      </div>
    </div>
  )
}
