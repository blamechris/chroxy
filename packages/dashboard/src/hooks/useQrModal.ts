import { useState, useCallback, useEffect } from 'react'
import { getAuthToken } from '../utils/auth'

/** Result of a host-triggered Discord pairing-link delivery (#5513). */
export type PostPairLinkResult =
  | { posted: true; expiresInSeconds?: number }
  | { posted: false; reason: string }

export interface QrModalState {
  qrModalOpen: boolean
  setQrModalOpen: (open: boolean) => void
  qrSvg: string | null
  qrLoading: boolean
  qrError: string | null
  qrPairingCode: string | null
  qrShareMode: 'link' | 'share'
  handleShowQr: () => void
  handleShareSession: () => void
  handlePostPairLinkToDiscord: () => Promise<PostPairLinkResult>
}

/**
 * Owns the QR-modal surface (#5560): linking-mode QR, per-session "Share" QR
 * (#3070), the typeable pairing code (#5512), and the host-triggered Discord
 * pairing-link delivery (#5513).
 *
 * Pure move out of App.tsx — the fetch paths, the share-mode reset effect, and
 * the pairing-ID auto-refresh effect (#2916) are byte-identical to the inline
 * versions, including their original deps arrays and eslint-disable lines.
 *
 * @param activeSessionId active session id (gates the per-session share QR)
 * @param pairingRefreshedCount store counter that triggers a QR auto-refresh
 */
export function useQrModal(
  activeSessionId: string | null,
  pairingRefreshedCount: number,
): QrModalState {
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  // #5512 — the typeable short pairing code shown beside the linking-mode QR so
  // camera-less devices can type it instead of scanning. The QR encodes the same
  // id. Null for per-session "Share" QRs (those carry a session-bound token).
  const [qrPairingCode, setQrPairingCode] = useState<string | null>(null)

  const fetchQrInto = useCallback(async (path: string) => {
    setQrModalOpen(true)
    setQrLoading(true)
    setQrError(null)
    setQrSvg(null)
    setQrPairingCode(null)
    const token = getAuthToken()
    if (!token) {
      setQrLoading(false)
      setQrError('No auth token available')
      return
    }
    // The typeable code (#5512) only applies to the linking-mode QR — per-session
    // "Share" QRs (/qr/session/…) issue a session-bound token with no displayed
    // code. Fetch the code in parallel with the QR for the linking-mode path.
    const isLinkingQr = path === '/qr'
    try {
      const [qrRes, codeRes] = await Promise.all([
        fetch(path, { headers: { Authorization: `Bearer ${token}` } }),
        isLinkingQr
          ? fetch('/pairing-code', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
          : Promise.resolve(null),
      ])
      if (!qrRes.ok) {
        const body = await qrRes.json().catch(() => ({ error: 'Request failed' }))
        setQrError(body.error || `HTTP ${qrRes.status}`)
        setQrSvg(null)
      } else {
        const svg = await qrRes.text()
        setQrSvg(svg)
        setQrError(null)
      }
      if (codeRes && codeRes.ok) {
        const body = await codeRes.json().catch(() => null)
        if (body?.code) setQrPairingCode(String(body.code))
      }
    } catch (err) {
      setQrError(err instanceof Error ? err.message : 'Failed to fetch QR code')
      setQrSvg(null)
    } finally {
      setQrLoading(false)
    }
  }, [])

  const handleShowQr = useCallback(() => fetchQrInto('/qr'), [fetchQrInto])

  // #5513 — host-triggered Discord pairing-link delivery. POSTs to the daemon's
  // primary-class-gated /pair-discord, which mints a FRESH approval-gated id and
  // posts only the chroxy:// link. Redeeming it from the channel still needs host
  // approval, so the channel grants nothing on its own. Returns a result the
  // QrModal renders inline. Never surfaces token material.
  const handlePostPairLinkToDiscord = useCallback(async (): Promise<PostPairLinkResult> => {
    const token = getAuthToken()
    if (!token) return { posted: false as const, reason: 'no_token' }
    try {
      const res = await fetch('/pair-discord', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.posted) {
        return { posted: true as const, expiresInSeconds: body.expiresInSeconds }
      }
      // Auth/availability failures arrive as { error: ... }, not { reason: ... }.
      return { posted: false as const, reason: body?.reason || body?.error || `http_${res.status}` }
    } catch {
      return { posted: false as const, reason: 'post_failed' }
    }
  }, [])

  // #3070: per-session "Share this session" QR. Issues a token bound to the
  // active session — the scanner can chat into it but cannot list/switch
  // others. Distinct from the linking-mode QR above, which lets the paired
  // device manage every session.
  const [qrShareMode, setQrShareMode] = useState<'link' | 'share'>('link')
  const handleShareSession = useCallback(() => {
    if (!activeSessionId) return
    setQrShareMode('share')
    void fetchQrInto(`/qr/session/${encodeURIComponent(activeSessionId)}`)
  }, [activeSessionId, fetchQrInto])
  // Reset share-mode label whenever the modal reopens via the regular QR
  // button so the title reflects the actual content.
  useEffect(() => {
    if (qrModalOpen && qrShareMode === 'share') return
    if (!qrModalOpen) setQrShareMode('link')
  }, [qrModalOpen, qrShareMode])

  // Auto-refresh QR when the server regenerates the pairing ID (#2916).
  // Only refresh while the modal is open — guarding on qrSvg would reopen
  // the modal after the user closes it if qrSvg was not cleared on close.
  useEffect(() => {
    if (pairingRefreshedCount === 0) return
    if (!qrModalOpen) return
    handleShowQr()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingRefreshedCount])

  return {
    qrModalOpen,
    setQrModalOpen,
    qrSvg,
    qrLoading,
    qrError,
    qrPairingCode,
    qrShareMode,
    handleShowQr,
    handleShareSession,
    handlePostPairLinkToDiscord,
  }
}
