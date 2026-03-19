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
}

export function QrModal({ open, onClose, qrSvg, loading, error }: QrModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Pair Mobile App" maxWidth="400px">
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
            Scan with Chroxy app to pair your phone
          </p>
        </div>
      )}
    </Modal>
  )
}
