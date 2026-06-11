/**
 * QrModal — modal displaying QR code for mobile app pairing.
 *
 * Composes the generic Modal component for consistent Escape key,
 * aria-modal, and backdrop behavior.
 */

import { useState } from 'react'
import DOMPurify from 'dompurify'
import { Modal } from './Modal'

/** Result of a host-triggered Discord pairing-link post (#5513). */
export type PostToDiscordResult =
  | { posted: true; expiresInSeconds?: number }
  | { posted: false; reason?: string }

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
  /**
   * Host-triggered Discord pairing-link delivery (#5513). When provided, a
   * "Post link to Discord" button appears beside the code. It posts a FRESH
   * approval-gated pairing id — redeeming it from the channel still needs host
   * approval, so the channel grants nothing on its own. Omitted for the
   * per-session "Share" QR (no Discord delivery there).
   */
  onPostToDiscord?: () => Promise<PostToDiscordResult>
}

/** Human-readable failure copy for a post_failed/not_configured reason. */
function discordFailureMessage(reason?: string): string {
  if (reason === 'not_configured') {
    return 'No Discord webhook is configured on the host.'
  }
  if (reason === 'post_failed') {
    return 'Discord rejected the post — check the webhook.'
  }
  if (reason === 'no_token' || reason === 'unauthorized') {
    return 'Not authorized — reconnect to the daemon and try again.'
  }
  if (reason === 'primary_token_required') {
    return 'Only the primary device can post pairing links.'
  }
  return `Could not post to Discord${reason ? `: ${reason}` : ''}.`
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
  onPostToDiscord,
}: QrModalProps) {
  const [posting, setPosting] = useState(false)
  const [postStatus, setPostStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const handlePostToDiscord = async () => {
    if (!onPostToDiscord || posting) return
    setPosting(true)
    setPostStatus(null)
    try {
      const result = await onPostToDiscord()
      if (result.posted) {
        const ttl = typeof result.expiresInSeconds === 'number' ? result.expiresInSeconds : 60
        setPostStatus({ ok: true, text: `Posted to Discord — expires in ${ttl}s, approval required on the host.` })
      } else {
        setPostStatus({ ok: false, text: discordFailureMessage(result.reason) })
      }
    } catch {
      setPostStatus({ ok: false, text: discordFailureMessage() })
    } finally {
      setPosting(false)
    }
  }

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
          {onPostToDiscord && (
            <div className="qr-modal-discord" data-testid="qr-post-discord">
              <button
                type="button"
                className="qr-modal-discord-btn"
                data-testid="qr-post-discord-btn"
                onClick={handlePostToDiscord}
                disabled={posting}
              >
                {posting ? 'Posting…' : 'Post link to Discord'}
              </button>
              {postStatus && (
                <span
                  className={postStatus.ok ? 'qr-modal-discord-ok' : 'qr-modal-discord-err'}
                  data-testid="qr-post-discord-status"
                  role={postStatus.ok ? undefined : 'alert'}
                >
                  {postStatus.text}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
