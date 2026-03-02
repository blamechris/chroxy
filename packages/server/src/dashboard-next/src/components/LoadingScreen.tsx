/**
 * LoadingScreen — startup progress for Tauri single-window boot.
 *
 * Shows spinner, stage progression, and QR code when ready.
 * Replaces the static dist/index.html fallback page.
 */

export interface LoadingScreenProps {
  /** Current startup stage: 1=starting, 2=health check, 3=almost ready */
  stage: number
  /** Status text shown below the spinner */
  statusText: string
  /** QR code SVG markup (shown when available, replaces stages) */
  qrSvg?: string
  /** Label shown below QR code */
  qrLabel?: string
  /** Callback for "Open Dashboard" button */
  onOpenDashboard?: () => void
}

const stages = [
  'Starting server...',
  'Waiting for health check...',
  'Almost ready...',
]

export function LoadingScreen({
  stage,
  statusText,
  qrSvg,
  qrLabel,
  onOpenDashboard,
}: LoadingScreenProps) {
  const showQr = !!qrSvg

  return (
    <div className="loading-screen" data-testid="loading-screen">
      <div className="loading-container">
        <div className="loading-logo">Chroxy</div>

        {!showQr && (
          <>
            <div className="loading-spinner" data-testid="loading-spinner" />
            <div className="loading-status">{statusText}</div>
            <ul className="loading-stages">
              {stages.map((label, i) => {
                const stageNum = i + 1
                let className = ''
                if (stageNum < stage) className = 'done'
                else if (stageNum === stage) className = 'active'
                return (
                  <li key={stageNum} className={className}>
                    <span className="loading-stage-icon">
                      {stageNum < stage ? '\u2713' : '\u25CF'}
                    </span>
                    {label}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {showQr && (
          <div className="loading-qr-section">
            <div
              className="loading-qr-container"
              data-testid="qr-container"
              dangerouslySetInnerHTML={{ __html: qrSvg! }}
            />
            <div className="loading-qr-label">
              {qrLabel || 'Scan with Chroxy app to pair your phone'}
            </div>
            {onOpenDashboard && (
              <button
                className="loading-dashboard-btn"
                onClick={onOpenDashboard}
                type="button"
              >
                Open Dashboard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
