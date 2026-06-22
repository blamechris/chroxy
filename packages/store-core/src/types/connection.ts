/**
 * Connection / transport / multi-client presence types.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

export interface SavedConnection {
  /**
   * The URL the app should connect to. Historically the single saved endpoint;
   * still the canonical "what to dial" value for backward compatibility and the
   * manual-override path. Endpoint auto-selection (#5518) may transiently pick a
   * different endpoint (`lanUrl`/`tunnelUrl`) at connect time without mutating
   * this field.
   */
  url: string;
  token: string;
  /**
   * #5518 — optional direct LAN endpoint (`ws://<lan-ip>:<port>`) for a phone on
   * the same network as the daemon. Stored alongside the tunnel URL so connect
   * (and network-change) can race `/health` probes and prefer the local path.
   *
   * SECURITY: a LAN candidate is only ever AUTO-preferred when `lanVerified` is
   * true — meaning a full auth + key-exchange handshake against this exact
   * `ws://` URL has succeeded with this record's token at least once, proving it
   * is the same daemon (the token only validates against the real daemon). A
   * blind LAN-scan result is NOT auto-verified: the bearer token is sent in
   * plaintext before key exchange on `ws://` (see encryption-threat-model.md §8),
   * so we must never hand it to an endpoint that hasn't already proven its
   * identity by accepting that token. See endpoint-selector.ts.
   */
  lanUrl?: string;
  /**
   * #5518 — the canonical tunnel endpoint (`wss://…`). Falls back to `url` when
   * absent (older records / manual ws:// entries). Used as the always-available
   * fallback when the LAN probe fails (wifi drop, off-network).
   */
  tunnelUrl?: string;
  /**
   * #5518 — set true once `lanUrl` has completed a successful auth handshake with
   * this record's token. Gate for auto-preferring the LAN path. Never set from a
   * `/health` probe alone (a hostile LAN box can answer `/health`) — only from a
   * real authenticated connection. Cleared if the record's token changes.
   */
  lanVerified?: boolean;
  /**
   * #5536 — the daemon's pinned E2E identity public key (base64 Ed25519),
   * captured from the trusted pairing channel (QR / pairing-code `idk=`) and
   * pinned on first successful connect. On every subsequent handshake the
   * client verifies the server's signed ephemeral exchange key against this
   * pinned value; a mismatch refuses the connection (server-identity change /
   * MITM). Absent for records paired before this change or daemons with no
   * identity (encryption disabled / older server) — those stay TOFU and pin on
   * first use after upgrade (trust continuity).
   */
  pinnedIdentityKey?: string;
}

export interface ConnectedClient {
  clientId: string;
  deviceName: string | null;
  deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown';
  platform: string;
  isSelf: boolean;
}

export type ConnectionPhase =
  | 'disconnected'        // Not connected, no auto-reconnect
  | 'connecting'          // Initial connection attempt
  | 'connected'           // WebSocket open + authenticated
  | 'reconnecting'        // Auto-reconnecting after unexpected disconnect
  | 'server_restarting'   // Health check returns { status: 'restarting' }
  | 'server_down';        // Reconnect ladder gave up (#5698) — terminal, manual reconnect only

/** Context captured from connect() closure for use by the extracted handleMessage(). */
export interface ConnectionContext {
  url: string;
  token: string;
  isReconnect: boolean;
  silent: boolean;
  socket: WebSocket;
}

/** Queued message for offline send buffer */
export interface QueuedMessage {
  type: string;
  payload: unknown;
  queuedAt: number;
  maxAge: number;
}
