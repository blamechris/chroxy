/**
 * Endpoint selection for dual-endpoint connection records (#5518, epic #5514).
 *
 * A phone on the same network as its daemon currently hairpins every byte
 * through a Cloudflare colo because the saved connection is a single
 * `wss://…trycloudflare.com` URL. This module lets a connection record carry a
 * direct LAN candidate (`ws://<lan-ip>:<port>`) alongside the tunnel URL and
 * choose the local path when it is reachable — racing cheap `/health` probes,
 * not the full WebSocket handshake.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SECURITY (merge requirement — see docs/security/encryption-threat-model.md)
 * ──────────────────────────────────────────────────────────────────────────
 * The bearer token is sent in PLAINTEXT in the `auth` message *before* the
 * X25519 key exchange runs (encryption-threat-model.md §8). On the tunnel that
 * is fine — `wss://` is TLS. On a direct LAN `ws://` socket there is no TLS, so
 * the token is exposed to anyone sniffing that local network.
 *
 * Two rules fall out of that and are enforced here:
 *
 *  1. **Never hand the token to an unverified LAN box.** `/health` is an
 *     unauthenticated fingerprint endpoint (bearer-token-authority.md §10) — a
 *     hostile box on the subnet can answer `{ status: 'ok' }`. So a `/health`
 *     answer alone is NOT identity. We only ever auto-prefer a LAN candidate
 *     whose `lanVerified` flag is set, which the connect path sets *only after*
 *     a full auth + key-exchange handshake against that exact `ws://` URL has
 *     succeeded with this record's token — proof it is the real daemon (the
 *     token validates against nothing else). A blind LAN-scan result is never
 *     auto-verified; the user must connect to it explicitly once first.
 *
 *  2. **The probe carries no secret.** `selectConnectEndpoint` only issues a
 *     `GET /health` — no `Authorization` header, no token. The decision of
 *     *which* URL to dial is made here; the token only travels later, on the
 *     URL this module returns, and only ever a verified one for the LAN path.
 *
 * The message-content E2E layer (XSalsa20-Poly1305) still wraps every
 * post-handshake message on `ws://` exactly as it does on `wss://`, so chat
 * content / terminal output / permissions are not newly exposed by LAN mode —
 * only the pre-handshake auth token and traffic metadata are (documented in
 * the threat model §8/§10).
 */
import type { SavedConnection } from '@chroxy/store-core';
import { probeHealth } from './lan-scanner';

/** Which transport the selector chose. Surfaced on the connection-quality UI. */
export type ConnectionPath = 'lan' | 'tunnel';

export interface EndpointSelection {
  /** The ws/wss URL to dial. */
  url: string;
  /** Whether the chosen URL is the direct LAN path or the tunnel fallback. */
  path: ConnectionPath;
}

export interface SelectOptions {
  /**
   * Skip the LAN probe and go straight to the tunnel. Used for the manual
   * override path and when the device is known to be off the daemon's network.
   */
  preferTunnel?: boolean;
  /** Per-probe timeout. Short by default so connect isn't gated on a dead LAN. */
  probeTimeoutMs?: number;
}

/** Default LAN `/health` probe budget — short so a missing LAN path is cheap. */
export const LAN_PROBE_TIMEOUT_MS = 1200;

/**
 * True when `url` is a plaintext `ws://` endpoint — i.e. a non-TLS LAN socket,
 * as opposed to a `wss://` tunnel. The whole LAN-vs-tunnel security distinction
 * keys off this: `ws://` means "token travels in cleartext on this network".
 */
export function isLanWsUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^ws:\/\//i.test(url.trim());
}

/**
 * The tunnel (TLS) endpoint to fall back to, or `null` if the record has none.
 *
 * A record whose only URL is a bare `ws://` (LAN-only, e.g. scanned then
 * connected on the local network) has no tunnel — we must NOT synthesize a
 * `wss://` from it, since that would dial a host that may not exist on TLS.
 */
export function deriveTunnelUrl(saved: SavedConnection): string | null {
  if (saved.tunnelUrl) return saved.tunnelUrl;
  if (saved.url && !isLanWsUrl(saved.url)) return saved.url;
  return null;
}

/**
 * Produce the connection record to persist after a SUCCESSFUL auth handshake.
 *
 * `connectedUrl` is the URL the handshake actually completed against. If it is
 * a `ws://` LAN URL, this proves the token works against the daemon at that
 * address → mark it as the verified LAN candidate. If it is the tunnel, leave
 * the LAN candidate as-is UNLESS the token changed, in which case the prior LAN
 * verification no longer holds and is cleared (a token rotation means the old
 * `lanVerified` was for a different credential).
 *
 * Pure — callers persist the result via the connection store.
 */
export function recordVerifiedLanCandidate(
  saved: SavedConnection,
  connectedUrl: string,
  token: string,
): SavedConnection {
  const tokenChanged = saved.token !== token;

  if (isLanWsUrl(connectedUrl)) {
    return {
      ...saved,
      token,
      lanUrl: connectedUrl,
      lanVerified: true,
      // Preserve any known tunnel; don't overwrite it with the LAN URL.
      tunnelUrl: saved.tunnelUrl ?? (isLanWsUrl(saved.url) ? undefined : saved.url),
    };
  }

  // Connected over the tunnel (or a wss URL). Record it as the tunnel endpoint.
  const next: SavedConnection = { ...saved, token, tunnelUrl: connectedUrl };
  if (tokenChanged) {
    // The verified-LAN flag was earned by the OLD token. Drop it (and the
    // candidate) so we never replay a stale verification with a new credential.
    delete next.lanUrl;
    next.lanVerified = false;
  }
  return next;
}

/**
 * Choose which endpoint to dial for this connection record.
 *
 * Races a single cheap `/health` probe against the *verified* LAN candidate and
 * prefers it when it answers; otherwise returns the tunnel. Never probes — and
 * never returns — an unverified LAN candidate (see the module security note).
 */
export async function selectConnectEndpoint(
  saved: SavedConnection,
  opts: SelectOptions = {},
): Promise<EndpointSelection> {
  const tunnelUrl = deriveTunnelUrl(saved);
  // Final fallback if a record somehow has neither a tunnel nor a usable LAN
  // path: hand back the record's own url so the normal connect() health-check
  // and retry/error path runs against it.
  const fallback: EndpointSelection = {
    url: tunnelUrl ?? saved.url,
    path: 'tunnel',
  };

  if (opts.preferTunnel) return fallback;

  // SECURITY GATE: only a token-verified LAN candidate is eligible. An
  // unverified candidate (e.g. a raw scan result) is never probed or dialed.
  const lanUrl = saved.lanUrl;
  if (!lanUrl || !saved.lanVerified || !isLanWsUrl(lanUrl)) {
    return fallback;
  }

  const timeout = opts.probeTimeoutMs ?? LAN_PROBE_TIMEOUT_MS;
  const health = await probeHealth(lanUrl, timeout);
  if (health) {
    return { url: lanUrl, path: 'lan' };
  }
  return fallback;
}
