# Bearer Token Authority Threat Model

Chroxy's WebSocket and HTTP control surfaces accept three distinct token classes, each with a different authority scope. This document pins the design so future PRs that add HTTP endpoints, WebSocket message types, or new credential paths don't accidentally widen (or fail to narrow) the trust boundary.

For the transport-layer story (key exchange, message encryption, nonce handling), see [`encryption-threat-model.md`](encryption-threat-model.md). This doc covers **authorization**, not confidentiality.

## 1. Trust Model in One Sentence

> Any holder of the primary API token can do anything the owner of the server can do via Chroxy — read every session's history, send input to any session, switch models, change permission modes, and modify settings. Pairing-bound session tokens are scoped to one session. Per-session hook secrets are scoped to one session **and** to permission responses only.

The server is the user's own machine (see [`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries)). The primary token is therefore deliberately equivalent to local access on that machine.

## 2. The Three Token Classes

| Token | Issued by | Stored where | Scope | Used on |
|-------|-----------|--------------|-------|---------|
| **Primary API token** | `chroxy init` (or rotation via `TokenManager`) | `~/.chroxy/config.json` (server), `expo-secure-store` (app) | Full session authority — no session scoping | WS `auth` message, HTTP `Authorization: Bearer ...`, dashboard cookie/query |
| **Pairing-bound session token** | `PairingManager.validatePairing()` on consumption of a one-shot pairing ID | In-memory only (server `_sessionTokens` map, 24h TTL); `expo-secure-store` on the app | Bound to exactly one `sessionId`; rejected by every session-scoped handler if the target session differs | Same wire paths as primary token; server distinguishes via `pairingManager.getSessionIdForToken()` |
| **Per-session hook secret** | `CliSession` constructor — `randomBytes(32).toString('hex')` | In-process only; passed to the `claude` CLI via `CHROXY_HOOK_SECRET` env var | Single session **and** single endpoint (`POST /permission`) | Permission-hook callbacks from the spawned CLI subprocess only |

The implementation files are:

- Primary token: [`packages/server/src/config.js`](../../packages/server/src/config.js), [`packages/server/src/token-manager.js`](../../packages/server/src/token-manager.js), [`packages/server/src/token-compare.js`](../../packages/server/src/token-compare.js)
- Pairing tokens: [`packages/server/src/pairing.js`](../../packages/server/src/pairing.js), [`packages/server/src/ws-auth.js`](../../packages/server/src/ws-auth.js)
- Hook secrets: [`packages/server/src/cli-session.js`](../../packages/server/src/cli-session.js) (creation), [`packages/server/src/ws-server.js`](../../packages/server/src/ws-server.js) (`_validateHookAuth`)

## 3. Primary API Token — Full Session Authority

`_validateBearerAuth` (`ws-server.js`) and the WS auth handler (`ws-auth.js`) both call `_isTokenValid(token)`, which is a constant-time comparison against `this.apiToken` (plus any active rotation grace token, see §6). There is **no session scoping at this layer**. A request that presents a valid primary token can:

- Subscribe to events from any session (`subscribe_session` / `subscribedSessionIds`)
- List and switch the active session (`set_active_session`)
- Send input, create, destroy, and rename sessions
- Read session history (`history_request`, paged history)
- Change models, permission modes, and per-session rules
- Modify config and settings via the dashboard

This is by design. The token represents the operator of the host machine.

### Why HTTP `/permission-response` has no `subscribedSessionIds` analog

On the WebSocket, each client tracks `subscribedSessionIds` so a permission broadcast for session A is not delivered to a client only subscribed to session B (see [`ws-server.js`](../../packages/server/src/ws-server.js) — `broadcastToSession`). HTTP requests are stateless and present only a bearer token, so there is no equivalent per-connection subscription set to consult.

For an HTTP caller presenting the **primary** token, this is consistent with the trust model: the primary token already grants full session authority, so cross-session HTTP `permission-response` calls are within the token's authority. For a caller presenting a **pairing-bound** token, the binding check in `_handlePermissionResponse` ([`ws-permissions.js`](../../packages/server/src/ws-permissions.js) ~line 312) explicitly rejects mismatched sessions with a 403 + `SESSION_TOKEN_MISMATCH` payload, so bound tokens cannot cross sessions even on HTTP.

## 4. Pairing-Bound Session Tokens

A pairing flow turns a short-lived pairing ID (shown in a QR code) into a longer-lived session token without ever exposing the primary token on the wire.

### Pairing flow

1. The dashboard renders a QR containing `chroxy://<host>?pair=<pairingId>`. Pairing IDs live in `_activePairings`, expire after `DEFAULT_TTL_MS` (60s), and are single-use ([`pairing.js`](../../packages/server/src/pairing.js)).
2. The app scans the QR and opens a WebSocket to the host.
3. Before authenticating, the app sends `{ type: 'pair', pairingId }`.
4. The server calls `pairingManager.validatePairing(pairingId, activeSessionId)`. On success, a fresh 32-byte session token is issued, stored in `_sessionTokens` with a 24h TTL, and returned to the client.
5. The app stores the session token in `expo-secure-store` and uses it on subsequent connections via the normal `auth` message — the server's `_isTokenValid` accepts it because `PairingManager.isSessionTokenValid()` returns true.

Two creation paths differ in how the binding is set:

- **Linking mode** (`_generatePairing` / `_current`): the issued token's binding is taken from the `activeSessionId` parameter at validation time. WsServer always passes `null` for this parameter ([`ws-server.js`](../../packages/server/src/ws-server.js) ~line 624), so linking-mode tokens are **unbound** — they behave like the primary token for session listing/switching.
- **Share-a-session** (`generateBoundPairing(sessionId)`): the entry stores `boundSessionId` at creation time. `validatePairing` uses it unconditionally, ignoring the param. The resulting token is bound to that one session.

### What "bound" enforces

When `ws-auth.js` accepts a pair-issued token, it sets `client.boundSessionId` on the WebSocket client. Every session-scoped handler then filters by it:

- History (`ws-history.js`) restricts session lists, fetches, and resumes to `boundSessionId` only
- Broadcasts (`ws-server.js` — `broadcastToSession`, `_subscribeAllClientsToSession`) skip bound clients whose binding does not match
- HTTP `/permission-response` ([`ws-permissions.js`](../../packages/server/src/ws-permissions.js)) requires `originSessionId === callerBoundSessionId`; mismatch returns 403 + the unified `SESSION_TOKEN_MISMATCH` payload
- The session list returned in `auth_ok` is filtered to the bound session ([`ws-server.js`](../../packages/server/src/ws-server.js) ~line 534)

Bound tokens cannot create, destroy, switch, or list sibling sessions. They can chat into their bound session and answer permissions for it. That's it.

## 5. Per-Session Hook Secrets

Each `CliSession` mints a 32-byte hex secret in its constructor ([`cli-session.js`](../../packages/server/src/cli-session.js) ~line 193) and exports it to the spawned `claude` CLI subprocess as `CHROXY_HOOK_SECRET`. The CLI uses it on outbound `POST /permission` callbacks.

`_validateHookAuth` ([`ws-server.js`](../../packages/server/src/ws-server.js) ~line 882) checks the bearer token against the registered set of hook secrets only — it never accepts the primary API token when at least one hook secret is registered. The fallback to `_isTokenValid` exists for legacy single-session setups and tests where no hook secret was registered; it is not reached in normal multi-session operation.

Hook secrets are in-process only. They are never persisted, never sent over the user-facing WebSocket, and never appear in QR codes.

## 6. Token Lifecycle

| | Primary | Pairing-bound | Hook secret |
|---|---|---|---|
| Generation | `crypto.randomUUID()` at `chroxy init`; can be regenerated via CLI or rotated via `TokenManager` | `randomBytes(32).toString('base64url')` per pairing | `randomBytes(32).toString('hex')` per session |
| Persistence | `~/.chroxy/config.json` (server), secure storage on app | In-memory only (server `_sessionTokens`) | In-memory only |
| Default TTL | None (static) | 24h after pairing (`DEFAULT_SESSION_TOKEN_TTL_MS`) | Session lifetime |
| Rotation | Optional via `--token-expiry` / `TokenManager`; old token honored for a grace period (`DEFAULT_GRACE_MS = 5m`) and a `token_rotated` event is emitted | None (re-pair to refresh) | New secret per session |
| Revocation | Regenerate (via `chroxy init` or rotation); old token invalid after grace window | Server restart, `PairingManager.destroy()`, or 24h TTL | Session destroyed |

**Implication of static-by-default primary token:** if it leaks, an attacker has full authority until the user manually regenerates and re-pairs. The mitigation surface is:

- Constant-time comparison (`safeTokenCompare`) on every validation path to prevent timing oracles
- Exponential backoff rate limiting on auth failures (1s, 2s, ..., 60s; `ws-auth.js`)
- Optional rotation via `--token-expiry` for environments that want bounded blast radius

## 7. Audit Chain

Each step here tightened a real bug. Read the PRs in order if extending any of these surfaces:

- **#2806** — original session-binding enforcement on WS handlers (`boundSessionId` introduced)
- **#2832** — `SESSION_TOKEN_MISMATCH` failure mode + `[session-binding-*]` debug logs (see [`docs/troubleshooting/session-token-mismatch.md`](../troubleshooting/session-token-mismatch.md))
- **#4788 / #4794** — closed gaps where bound tokens could resolve cross-session permissions
- **#4798** — unified `SESSION_TOKEN_MISMATCH` payload across WS and HTTP error surfaces
- **#4820** — P0 fix for cross-session `permission_response` hijack on the WS path; the review of that PR is what motivated this doc (issue #4830)

## 8. Adding a New Endpoint or Message Type — Checklist

Before merging any PR that adds a new HTTP route or WebSocket message handler that touches session state:

1. **Decide which token classes you accept.** Most HTTP endpoints accept the primary token only. `/permission` accepts hook secrets. WS handlers accept primary + pairing-bound.
2. **If the operation is session-scoped**, branch on `client.boundSessionId` (WS) or call the equivalent of `pairingManager.getSessionIdForToken(token)` (HTTP) and reject mismatches with 403 + `buildSessionTokenMismatchPayload()`.
3. **If the operation is global** (e.g. listing all sessions, changing config), explicitly reject bound tokens — do not let them silently see everything.
4. **Never log raw tokens.** `maskToken()` exists for a reason.
5. **Use `safeTokenCompare()`** for any byte-equality check against a token.

## 9. Known Risks

- **Static primary token is the default.** If the QR is photographed or the config file is exfiltrated, the attacker has full authority. Rotation is opt-in.
- **No certificate pinning or out-of-band key verification.** See [`encryption-threat-model.md` §8 — Trust On First Use](encryption-threat-model.md#trust-on-first-use-tofu).
- **Pairing tokens are issued without device proof.** A pairing ID, if captured during the 60-second window, can be redeemed by any device. The window is short and the IDs are 12-byte base64url (~96 bits of entropy) precisely because the trust model assumes the QR is a physical-proximity channel.
- **Pairing-bound tokens last 24h by default.** A stolen bound token grants single-session access for up to a day. Server restart invalidates the entire `_sessionTokens` map.
