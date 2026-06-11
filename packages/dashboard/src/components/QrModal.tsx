/**
 * QrModal — modal displaying QR code for mobile app pairing.
 *
 * Composes the generic Modal component for consistent Escape key,
 * aria-modal, and backdrop behavior.
 */

import DOMPurify from 'dompurify'
import { Modal } from './Modal'

export interface QrModalProps {
  open: boolean
  onClose: () => void
  qrSvg: string | null
  loading: boolean
  error?: string
  /** Modal title — defaults to "Pair Mobile App". */
  title?: string
  /** Body line shown under the QR — defaults to the link-mode text. */
  instructions?: string
  /**
   * Typeable short pairing code shown beside the QR (#5512). The QR encodes the
   * SAME id, so a camera-less device can type this code instead of scanning.
   * Omitted for per-session "Share" QRs (those issue a session-bound token).
   */
  pairingCode?: string | null
}

export function QrModal({
  open,
  onClose,
  qrSvg,
  loading,
  error,
  title = 'Pair Mobile App',
  instructions = 'Scan with Chroxy app to pair your phone',
  pairingCode = null,
}: QrModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="400px">
      <button className="qr-modal-close" onClick={onClose} aria-label="Close" type="button">
        &times;
      </button>

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
            {instructions}
          </p>
          {pairingCode && (
            <div className="qr-modal-code" data-testid="qr-pairing-code">
              <span className="qr-modal-code-label">Or type this code:</span>
              <code className="qr-modal-code-value" data-testid="qr-pairing-code-value">
                {pairingCode}
              </code>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
