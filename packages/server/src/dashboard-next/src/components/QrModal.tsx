/**
 * QrModal — modal displaying QR code for mobile app pairing.
 *
 * Fetches QR SVG from the server's /qr endpoint and renders it
 * in a centered modal with pairing instructions.
 */

import DOMPurify from 'dompurify'

export interface QrModalProps {
  open: boolean
  onClose: () => void
  qrSvg: string | null
  loading: boolean
  error?: string
}

export function QrModal({ open, onClose, qrSvg, loading, error }: QrModalProps) {
  if (!open) return null

  return (
    <div className="qr-modal-backdrop" data-testid="qr-modal-backdrop" onClick={onClose}>
      <div
        className="qr-modal"
        data-testid="qr-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="QR code for mobile pairing"
      >
        <button className="qr-modal-close" onClick={onClose} aria-label="Close" type="button">
          &times;
        </button>

        <h2 className="qr-modal-title">Pair Mobile App</h2>

        {loading && (
          <div className="qr-modal-loading" data-testid="qr-loading">
            <div className="qr-spinner" />
            <span>Loading QR code...</span>
          </div>
        )}

        {error && !loading && (
          <div className="qr-modal-error">{error}</div>
        )}

        {qrSvg && !loading && (
          <div className="qr-modal-content">
            <div
              className="qr-svg-container"
              data-testid="qr-svg-container"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(qrSvg, { USE_PROFILES: { svg: true } }),
              }}
            />
            <p className="qr-modal-instructions">
              Scan with Chroxy app to pair your phone
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
