/**
 * Pairing-URL parsing for the dashboard (#5281 ③ PR 2).
 *
 * Desktops can't scan a QR, so the parity form of "QR pairing" is pasting the
 * `chroxy://…?pair=<id>` URL a daemon displays (the same string its QR encodes).
 * This turns that paste into a connectable `ws(s)://…/ws` URL + pairing id; the
 * caller then runs the pairing handshake (no permanent token typed).
 *
 * Scheme inference: the `chroxy://` scheme drops ws/wss. The server always
 * builds a LAN pairing URL with an explicit port (`ws://host:PORT`) and a tunnel
 * URL without one (`wss://domain` on 443) — see pairing.js `currentPairingUrl`.
 * So **port present ⇒ ws (LAN), port absent ⇒ wss (tunnel)** is a reliable
 * inference. A directly-pasted `ws://`/`wss://…?pair=` URL keeps its own scheme,
 * which is the override for the rare port-bearing-wss (custom proxy) case.
 */
export interface ParsedPairing {
  /** Connectable endpoint, e.g. `ws://192.168.1.5:8765/ws` or `wss://x.tld/ws`. */
  wsUrl: string
  /** Present for the pairing flow (`?pair=`). */
  pairingId?: string
  /** Present for the legacy token flow (`?token=`). */
  token?: string
}

/**
 * Parse a `chroxy://`, `ws://`, or `wss://` URL carrying `?pair=` or `?token=`.
 * Returns null when the input isn't a recognizable connection URL or carries
 * neither credential.
 */
export function parsePairingUrl(raw: string): ParsedPairing | null {
  const trimmed = raw.trim()
  let u: URL
  let scheme: 'ws' | 'wss'
  try {
    if (trimmed.startsWith('chroxy://')) {
      // Reparse under https so the URL parser yields host/port/searchParams.
      u = new URL(trimmed.replace(/^chroxy:\/\//, 'https://'))
      // Explicit port ⇒ LAN plain-ws; bare host ⇒ tunnel wss (see header).
      scheme = u.port ? 'ws' : 'wss'
    } else if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
      u = new URL(trimmed)
      scheme = trimmed.startsWith('wss://') ? 'wss' : 'ws'
    } else {
      return null
    }
  } catch {
    return null
  }

  const pairingId = u.searchParams.get('pair') ?? undefined
  const token = u.searchParams.get('token') ?? undefined
  if (!pairingId && !token) return null

  const wsUrl = `${scheme}://${u.host}/ws`
  return { wsUrl, ...(pairingId ? { pairingId } : {}), ...(token ? { token } : {}) }
}

/** True when a string looks like a pairing URL (carries `?pair=`). */
export function isPairingUrl(raw: string): boolean {
  return parsePairingUrl(raw)?.pairingId != null
}
