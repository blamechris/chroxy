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
  /**
   * #5536 — the daemon's pinned E2E identity public key (base64 Ed25519),
   * conveyed over the trusted pairing channel as `?idk=`. Pinned on first
   * connect; absent for older daemons / encryption-off.
   */
  identityKey?: string
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

  // #5536 — the pinned identity rides the same trusted pairing URL.
  const identityKey = u.searchParams.get('idk') ?? undefined

  const wsUrl = `${scheme}://${u.host}/ws`
  return {
    wsUrl,
    ...(pairingId ? { pairingId } : {}),
    ...(token ? { token } : {}),
    ...(identityKey ? { identityKey } : {}),
  }
}

/** True when a string looks like a pairing URL (carries `?pair=`). */
export function isPairingUrl(raw: string): boolean {
  return parsePairingUrl(raw)?.pairingId != null
}

/**
 * Normalize a typed pairing code (#5512): uppercase, strip whitespace and dashes.
 * Mirrors the server's `normalizePairingCode` so a code read off the host screen
 * validates regardless of case or the spaces/dashes people add when reading aloud.
 */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase()
}

/**
 * Build a ParsedPairing from a separately-typed host (or full ws/chroxy URL) and a
 * pairing code (#5512, the TV-app pattern). This is the camera-less equivalent of
 * pasting a `chroxy://host?pair=<code>` URL — it synthesizes that URL and reuses
 * `parsePairingUrl`, so the resulting wsUrl + pairingId drive the exact same pair
 * request as the QR/paste path. Returns null when host or code is empty/unparsable.
 *
 * `host` may be a bare `host[:port]`, or a full `ws://`/`wss://`/`chroxy://` URL
 * (a `?pair=` already present is ignored — the typed code wins).
 */
export function parsePairingCodeEntry(host: string, code: string): ParsedPairing | null {
  const normalizedCode = normalizePairingCode(code.trim())
  if (!normalizedCode) return null
  const trimmedHost = host.trim()
  if (!trimmedHost) return null

  // Reduce whatever the user typed to a scheme + host[:port], then synthesize the
  // canonical chroxy://host?pair=<code> string parsePairingUrl already understands.
  let scheme: 'chroxy' | 'ws' | 'wss' = 'chroxy'
  let hostPart = trimmedHost
  try {
    if (/^wss?:\/\//i.test(trimmedHost)) {
      const u = new URL(trimmedHost)
      scheme = trimmedHost.toLowerCase().startsWith('wss://') ? 'wss' : 'ws'
      hostPart = u.host
    } else if (/^chroxy:\/\//i.test(trimmedHost)) {
      const u = new URL(trimmedHost.replace(/^chroxy:\/\//i, 'https://'))
      hostPart = u.host
    } else {
      // Bare host[:port] — strip any path/query the user may have pasted.
      hostPart = trimmedHost.replace(/^\/+/, '').split('/')[0]?.split('?')[0] ?? ''
    }
  } catch {
    return null
  }
  if (!hostPart) return null

  const synthesized = `${scheme}://${hostPart}?pair=${encodeURIComponent(normalizedCode)}`
  return parsePairingUrl(synthesized)
}
