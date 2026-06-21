/**
 * Auth + connection message handlers (audit P2-3 split).
 *
 * Extracted verbatim from ./index.ts: the auth_ok / auth_fail / key_exchange_ok
 * / server_mode family (with its ServerMode / AuthOk* types), the connect-time
 * auth_bootstrap + tunnel_url_changed pair, and the token_rotated + pair_fail
 * handlers. Re-exported through the ./index barrel so the public surface is
 * unchanged. No side effects — see the per-function docs.
 *
 * handleAuthOk folds the available-permission-modes list into its payload, so it
 * imports handleAvailablePermissionModes + PermissionMode back from ./permission
 * (where the permission-mode handlers live). No cycle: ./permission never
 * imports ./auth or ./index.
 */

import { parseEnumField, parseRawStringField } from './_shared'
import { handleAvailablePermissionModes } from './permission'
import type { PermissionMode } from './permission'

/**
 * Server mode advertised by the WS protocol.
 *
 * Historically the server could in principle have run in a `'terminal'`
 * (PTY/tmux) mode, but the wire protocol only ever emits `'cli'` — the
 * `ServerAuthOkSchema` is a `z.literal('cli')` and the server hardcodes
 * `this.serverMode = 'cli'` (see #4810). The shared handler validates the
 * field and returns null for any non-`'cli'` value so the call site can
 * surface a hardened "unknown server" branch.
 */
export type ServerMode = 'cli'

const VALID_SERVER_MODES: readonly ServerMode[] = ['cli']

/**
 * Validated `webFeatures` map advertised by the server. Each flag is a hard
 * boolean — the parser coerces missing/malformed values to `false` so a
 * misshapen wire message can't accidentally light up a feature gate. Both
 * clients fall back to `{ available: false, remote: false, teleport: false }`
 * when the field is absent so consumer call sites get a uniform shape.
 */
export interface AuthOkWebFeatures {
  available: boolean
  remote: boolean
  teleport: boolean
}

/**
 * Typed payload extracted from an `auth_ok` message.
 *
 * Side-effects (reset replay flags, save connection, start heartbeat, kick
 * off key exchange, register push tokens, sync ConnectionLifecycleStore,
 * update lastConnectedUrl, etc.) stay at the call site — every one of those
 * is platform-specific (the mobile app has push notifications + biometric
 * setup; the dashboard owns lastConnectedUrl tracking) and out of scope for
 * the data-extraction seam.
 *
 * #4766 — fields below were previously decoded inline in both clients,
 * which let `streamStallTimeoutMs` silently drop on mobile (StreamStallChip
 * couldn't humanise the headline phrase). The parser now owns the full
 * wire-shape decode; consumers assemble their platform-specific state
 * patches around the shared payload. The connected-clients roster is
 * parsed separately in `parseConnectedClients` (in ./client.ts) so the
 * roster shape doesn't bloat `AuthOkPayload`.
 */
export interface AuthOkPayload {
  /** Validated server mode (`'cli'`, or null when unknown). */
  serverMode: ServerMode | null
  /** Raw `cwd` string (NOT trimmed — empty string preserved). */
  sessionCwd: string | null
  /** Raw `defaultCwd` string. */
  defaultCwd: string | null
  /** Raw `serverVersion` string. */
  serverVersion: string | null
  /** Raw `latestVersion` string. */
  latestVersion: string | null
  /** Raw `serverCommit` string. */
  serverCommit: string | null
  /** Validated integer >= 1, else null. */
  protocolVersion: number | null
  /**
   * #3760 — server-advertised inactivity timeout in ms. Validated positive
   * finite number, else null (older servers omit the field; consumers fall
   * back to their built-in reference timeout).
   */
  resultTimeoutMs: number | null
  /**
   * #4497 / #4477 — server-advertised stream-stall window in ms. 0 is the
   * protocol's explicit "disabled" sentinel and is treated as absent so the
   * chip falls back to the generic phrase. Was previously dropped on mobile
   * (#4766 latent bug — fixed by unifying the parser).
   */
  streamStallTimeoutMs: number | null
  /** Raw encryption directive from the server (`'required'` or other). */
  encryption: string | null
  /**
   * `sessionToken` issued via the pairing flow. Only the mobile app currently
   * consumes this; the dashboard ignores it. Exposed in the shared payload so
   * the wire-shape decode lives in one place.
   */
  sessionToken: string | null
  /** Self-identifying clientId issued by the server, null when missing/malformed. */
  myClientId: string | null
  /** Validated webFeatures flags with hardened defaults — never null. */
  webFeatures: AuthOkWebFeatures
  /**
   * #4560 / #3272 — server-advertised capability map. Keys are feature names,
   * values are strict booleans (`true` only when the wire value was literally
   * `true`). Empty object when the field is absent so consumers can blindly
   * spread it into state without an existence check.
   */
  serverCapabilities: Record<string, boolean>
  /**
   * #5555 (eager key exchange) — the server's ephemeral X25519 public key,
   * present only when this client sent `eagerPublicKey` + `eagerSalt` in its
   * `auth` message AND the server honoured the eager path. When non-null the
   * client derives the shared key immediately and skips the discrete
   * `key_exchange` round trip; null means fall back to the discrete handshake
   * (old server, encryption disabled, or no eager fields were sent). Same
   * validation as `handleKeyExchangeOk`'s `publicKey`.
   */
  serverPublicKey: string | null
  /**
   * #5536 (E2E key pinning) — the server's Ed25519 signature (base64) over the
   * eager `serverPublicKey`, present only on the eager path when the daemon has
   * a pinned identity. A client that pinned this daemon's identity public key
   * (at pairing time) MUST verify this signature against the pinned key before
   * keying off `serverPublicKey`; a mismatch is a refusal (MITM key swap). Null
   * when absent (unpinned daemon / discrete path) — see the connect-flow's
   * pin-or-TOFU decision. Same string validation as `serverPublicKey`.
   */
  serverKeySig: string | null
  /**
   * #5616 (identity-key rotation handoff) — the daemon's CURRENT (post-rotation)
   * base64 Ed25519 identity public key, present only when the daemon rotated its
   * identity and minted a continuity cert. Paired with {@link rotationCert}. A
   * pinned client whose stored pin no longer verifies `serverKeySig` re-pins to
   * THIS key once the cert chain checks out. Null when absent (un-rotated daemon
   * / older server) — same `typeof === 'string' && truthy` validation as
   * `serverKeySig`.
   */
  newIdentityKey: string | null
  /**
   * #5616 — base64 Ed25519 detached signature of {@link newIdentityKey} made by
   * the PREVIOUS (pinned) identity's secret key (the "old signs new" continuity
   * cert, minted at rotation time). The client verifies it against its stored
   * pin before chaining forward. Null when absent.
   */
  rotationCert: string | null
  /**
   * #5555 (auth_bootstrap) — the static permission-mode enum folded into
   * auth_ok so a new client doesn't have to wait for the discrete
   * `available_permission_modes` burst frame. Validated with the same shape
   * checks as `handleAvailablePermissionModes`. Null when the field is absent
   * (older server) — consumers then fall back to the discrete frame.
   */
  availablePermissionModes: PermissionMode[] | null
}

const DEFAULT_WEB_FEATURES: AuthOkWebFeatures = {
  available: false,
  remote: false,
  teleport: false,
}

/** Validated positive finite number, else null. Used for both timeout fields. */
function parsePositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Extract typed server-context fields from an `auth_ok` message. */
export function handleAuthOk(msg: Record<string, unknown>): AuthOkPayload {
  const protoRaw = msg.protocolVersion
  const protocolVersion =
    typeof protoRaw === 'number' &&
    Number.isFinite(protoRaw) &&
    Number.isInteger(protoRaw) &&
    protoRaw >= 1
      ? protoRaw
      : null

  // webFeatures: object → boolean-coerced subset; otherwise hardened defaults.
  const webFeaturesRaw = msg.webFeatures
  const webFeatures: AuthOkWebFeatures =
    webFeaturesRaw && typeof webFeaturesRaw === 'object' && !Array.isArray(webFeaturesRaw)
      ? {
          available: !!(webFeaturesRaw as Record<string, unknown>).available,
          remote: !!(webFeaturesRaw as Record<string, unknown>).remote,
          teleport: !!(webFeaturesRaw as Record<string, unknown>).teleport,
        }
      : { ...DEFAULT_WEB_FEATURES }

  // capabilities: object → strict-true boolean map; absent/non-object → {}.
  // Skip prototype-pollution-prone keys (`__proto__`, `constructor`,
  // `prototype`) so a malformed server payload can't mutate Object.prototype
  // even though both consumers spread the map into Zustand state (which
  // doesn't re-walk the prototype chain at runtime, but defence-in-depth is
  // cheap here). Capability gates are fail-closed elsewhere — dropping a
  // dangerous key just leaves the gate unset, which is the safe default.
  const capabilitiesRaw = msg.capabilities
  const serverCapabilities: Record<string, boolean> = {}
  if (capabilitiesRaw && typeof capabilitiesRaw === 'object' && !Array.isArray(capabilitiesRaw)) {
    for (const [k, v] of Object.entries(capabilitiesRaw)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      serverCapabilities[k] = v === true
    }
  }

  return {
    serverMode: parseEnumField(msg, 'serverMode', VALID_SERVER_MODES),
    sessionCwd: parseRawStringField(msg, 'cwd'),
    defaultCwd: parseRawStringField(msg, 'defaultCwd'),
    serverVersion: parseRawStringField(msg, 'serverVersion'),
    latestVersion: parseRawStringField(msg, 'latestVersion'),
    serverCommit: parseRawStringField(msg, 'serverCommit'),
    protocolVersion,
    resultTimeoutMs: parsePositiveFiniteNumber(msg.resultTimeoutMs),
    streamStallTimeoutMs: parsePositiveFiniteNumber(msg.streamStallTimeoutMs),
    encryption: parseRawStringField(msg, 'encryption'),
    sessionToken: parseRawStringField(msg, 'sessionToken'),
    myClientId: parseRawStringField(msg, 'clientId'),
    webFeatures,
    serverCapabilities,
    // #5555 — null for missing/empty/non-string, exactly the "fall back to
    // discrete key_exchange" signal the call sites key off. Mirrors
    // handleKeyExchangeOk's `typeof raw === 'string' && raw` validation so an
    // empty-string serverPublicKey is treated as absent, not a usable key.
    serverPublicKey:
      typeof msg.serverPublicKey === 'string' && msg.serverPublicKey ? msg.serverPublicKey : null,
    // #5536 — identity signature over the eager serverPublicKey. Null for
    // missing/empty/non-string (unpinned daemon / discrete path).
    serverKeySig:
      typeof msg.serverKeySig === 'string' && msg.serverKeySig ? msg.serverKeySig : null,
    // #5616 — identity-rotation continuity cert. Null for missing/empty/non-
    // string (un-rotated daemon / older server), exactly the "no cert → can't
    // chain forward → refuse" signal the pin-decision keys off.
    newIdentityKey:
      typeof msg.newIdentityKey === 'string' && msg.newIdentityKey ? msg.newIdentityKey : null,
    rotationCert:
      typeof msg.rotationCert === 'string' && msg.rotationCert ? msg.rotationCert : null,
    // #5555 — reuse the discrete-frame parser on the folded field. Absent /
    // non-array → null so the consumer falls back to the discrete frame.
    availablePermissionModes: Array.isArray(msg.availablePermissionModes)
      ? handleAvailablePermissionModes({ modes: msg.availablePermissionModes })
      : null,
  }
}

/**
 * Extract the failure reason from an `auth_fail` message, falling back to
 * `'Invalid token'` when missing or non-string. Matches the prior inline
 * `(msg.reason as string) || 'Invalid token'` guard.
 */
export function handleAuthFail(msg: Record<string, unknown>): { reason: string } {
  const raw = msg.reason
  const reason = typeof raw === 'string' && raw ? raw : 'Invalid token'
  return { reason }
}

/**
 * Extract the validated `publicKey` from a `key_exchange_ok` message.
 *
 * Returns null when the field is missing, empty, or non-string — matches the
 * prior inline guard `if (!msg.publicKey || typeof msg.publicKey !== 'string')`.
 *
 * The actual key-derivation side effects (deriveSharedKey, deriveConnectionKey,
 * setting `_encryptionState`, sending post-auth WS messages) stay at the call
 * site — they touch crypto state and the websocket directly.
 */
export function handleKeyExchangeOk(msg: Record<string, unknown>): {
  publicKey: string | null
  serverKeySig: string | null
  newIdentityKey: string | null
  rotationCert: string | null
} {
  const raw = msg.publicKey
  const sig = msg.serverKeySig
  return {
    publicKey: typeof raw === 'string' && raw ? raw : null,
    // #5536 — Ed25519 signature (base64) over publicKey, present when the daemon
    // has a pinned identity. Null when absent (unpinned daemon / older server).
    serverKeySig: typeof sig === 'string' && sig ? sig : null,
    // #5616 — identity-rotation continuity cert on the discrete path. Same
    // validation + null semantics as the eager (auth_ok) path.
    newIdentityKey:
      typeof msg.newIdentityKey === 'string' && msg.newIdentityKey ? msg.newIdentityKey : null,
    rotationCert:
      typeof msg.rotationCert === 'string' && msg.rotationCert ? msg.rotationCert : null,
  }
}

/**
 * Extract and validate the mode enum from a `server_mode` message.
 *
 * Returns null for unknown modes; the call site is expected to surface an
 * "Invalid Server Mode" alert (matches dashboard's prior inline behaviour).
 * The wire protocol only emits `'cli'` (#4810) — any other value is treated
 * as null.
 */
export function handleServerMode(msg: Record<string, unknown>): { mode: ServerMode | null } {
  return { mode: parseEnumField(msg, 'mode', VALID_SERVER_MODES) }
}

/**
 * #5555 (auth_bootstrap) — parse the connect-time bootstrap burst into the
 * three list-replacement arrays. The frame folds `list_providers` /
 * `list_slash_commands` / `list_agents` responses into one server-initiated
 * push so a new client skips its connect-time request round trip.
 *
 * Each list is independent and defaults to `[]` when missing/non-array so a
 * partial server compute (e.g. an unreadable agents dir shipped `[]` for that
 * list only) still applies the lists that ARE present. Element shape is NOT
 * validated here — consumers reuse the same per-list casts they apply to the
 * discrete `provider_list` / `slash_commands` / `agent_list` messages.
 *
 * No session-id guard: providers are server-wide, and the slash/agent lists
 * are scoped to the active session the server just restored for this connect
 * (the same session the client lands on), so a connect-time burst is always
 * for the right session. The optional `sessionId` is surfaced so a consumer
 * CAN drop a stale burst if it has already switched away.
 */
export function handleAuthBootstrap(
  msg: Record<string, unknown>,
): {
  providers: unknown[]
  slashCommands: unknown[]
  agents: unknown[]
  sessionId: string | null
  tunnelUrl: string | null
} {
  const providers: unknown[] = Array.isArray(msg.providers) ? (msg.providers as unknown[]) : []
  const slashCommands: unknown[] = Array.isArray(msg.slashCommands) ? (msg.slashCommands as unknown[]) : []
  const agents: unknown[] = Array.isArray(msg.agents) ? (msg.agents as unknown[]) : []
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null
  // #5555 (sub-item 7): the server's live public tunnel URL, when a tunnel is
  // up. Lets a reconnecting client re-learn a URL that rotated while it was
  // offline. Absent in LAN / no-tunnel deployments. Validated as `wss://` here
  // (not just non-empty) so the parser matches its documented contract and a
  // bogus scheme is dropped before either client's apply step.
  const tunnelUrl = asWssUrl(msg.tunnelUrl)
  return { providers, slashCommands, agents, sessionId, tunnelUrl }
}

/**
 * #5555 (sub-item 7) — coerce a wire value to a `wss://` URL string, or null.
 * The tunnel URL is always a secure WebSocket endpoint; rejecting any other
 * scheme (or non-string) here keeps the shared tunnel-URL parsers honest so the
 * platform apply steps never have to re-defend against `ws://`/garbage.
 */
function asWssUrl(value: unknown): string | null {
  return typeof value === 'string' && /^wss:\/\//i.test(value) ? value : null
}

/**
 * #5555 (sub-item 7) — parse a `tunnel_url_changed` push (quick-tunnel URL
 * rotation). Returns the new `wss://` URL and the previous URL (when the server
 * knew it), or null when the payload is malformed so the caller skips it.
 *
 * The tunnel URL is connection metadata, not a secret (the QR code shares it),
 * so this is delivered to every authenticated client. Both clients apply it the
 * same way conceptually — repoint the stored endpoint their reconnect path
 * dials — but the STORAGE differs per platform (mobile: SecureStore-backed
 * SavedConnection.tunnelUrl; dashboard: the server-registry entry's wsUrl in
 * localStorage), so the apply step stays platform-local rather than living in
 * the shared dispatch table.
 */
export function handleTunnelUrlChanged(
  msg: Record<string, unknown>,
): { url: string; previousUrl: string | null } | null {
  // Validate as `wss://` (the parser's documented contract) rather than just
  // non-empty, so a malformed scheme is dropped here instead of relying on each
  // client's apply step to re-check it.
  const url = asWssUrl(msg.url)
  if (!url) return null
  const previousUrl = asWssUrl(msg.previousUrl)
  return { url, previousUrl }
}

// ---------------------------------------------------------------------------
// token_rotated
// ---------------------------------------------------------------------------

/**
 * Extract the new bearer token from a `token_rotated` message.
 *
 * Returns the token verbatim when it is a string (including the empty
 * string), else null. Both call sites gate the "seamless update" path on a
 * truthy check — so `''` takes the legacy "re-authentication required" path
 * exactly as it did with the prior inline
 * `typeof msg.token === 'string' ? msg.token : null` guard.
 *
 * Side effects are platform-specific and stay at the call site: the app
 * persists the token via `saveConnection` (or disconnects + alerts on the
 * legacy path); the dashboard rewrites the `token` query param in the
 * browser URL.
 */
export function handleTokenRotated(msg: Record<string, unknown>): { token: string | null } {
  return { token: typeof msg.token === 'string' ? msg.token : null }
}

// ---------------------------------------------------------------------------
// pair_fail
// ---------------------------------------------------------------------------

/**
 * User-facing copy for the known `pair_fail` reasons. Worded for the QR-code
 * pairing flow — the mobile app uses these verbatim. The dashboard's
 * paste-a-pairing-URL flow (#5297) keeps its plain `Pairing failed: <reason>`
 * template at the call site, since "Scan the latest QR code" does not match
 * that surface's UX.
 */
export const PAIR_FAIL_MESSAGES: Record<string, string> = {
  expired: 'This QR code has expired. Scan the latest QR code from your server.',
  already_used: 'This QR code has already been used. Scan the latest QR code from your server.',
  invalid_pairing_id: 'Invalid pairing code. Scan the latest QR code from your server.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
}

/** Parsed payload from a `pair_fail` message. */
export interface PairFailPayload {
  /** The server-sent reason, or `fallbackReason` when missing/empty/non-string. */
  reason: string
  /**
   * QR-flow alert copy: the friendly message for known reasons, else
   * `Pairing failed: <reason>`.
   */
  alertMessage: string
}

/**
 * Parse a `pair_fail` message.
 *
 * `fallbackReason` is injected because the two clients historically used
 * different fallbacks (app: `'pairing_failed'`, dashboard: `'unknown'`) and
 * the alert copy renders the reason verbatim — changing either fallback would
 * change user-visible text.
 *
 * Non-string and empty-string reasons both resolve to the fallback. (The
 * app's prior inline guard was `(msg.reason as string) || fallback` — a
 * truthy check — so this is byte-identical for it; the dashboard's prior
 * guard passed `''` through, which only affected the cosmetic
 * `Pairing failed: ` string.)
 *
 * Socket teardown, lifecycle-phase flips, and registry cleanup (#5281) are
 * platform glue and stay at the call sites.
 */
export function handlePairFail(
  msg: Record<string, unknown>,
  fallbackReason: string,
): PairFailPayload {
  const reason =
    typeof msg.reason === 'string' && msg.reason.length > 0 ? msg.reason : fallbackReason
  return {
    reason,
    alertMessage: PAIR_FAIL_MESSAGES[reason] ?? `Pairing failed: ${reason}`,
  }
}
