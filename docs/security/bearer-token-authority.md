# Bearer Token Authority Threat Model

Chroxy's WebSocket and HTTP control surfaces accept four distinct token classes, each with a different authority scope — plus two intentionally **unauthenticated** surfaces (the LAN-bind fingerprint surface, §10, and Chroxy Pages share-slug URLs, §11). This document pins the design so future PRs that add HTTP endpoints, WebSocket message types, or new credential paths don't accidentally widen (or fail to narrow) the trust boundary.

For the transport-layer story (key exchange, message encryption, nonce handling), see [`encryption-threat-model.md`](encryption-threat-model.md). This doc covers **authorization**, not confidentiality.

## 1. Trust Model in One Sentence

> Any holder of the primary API token can do anything the owner of the server can do via Chroxy — read every session's history, send input to any session, switch models, change permission modes, and modify settings. Pairing-bound session tokens are scoped to one session. Per-session hook secrets are scoped to one session **and** to the CLI permission-hook callback endpoint (`POST /permission`) only — they are never accepted for user-facing permission-response handling. The daemon-level ingest secret is scoped to the ingest/mailbox endpoints (`POST /api/events`, `POST /api/mailbox*`): it feeds the notification pipeline and can trigger a bounded, fixed-string mailbox wakeup into an idle claude-tui recipient — but grants no reads (see §6).

The server is the user's own machine (see [`encryption-threat-model.md` §2](encryption-threat-model.md#2-trust-boundaries)). The primary token is therefore deliberately equivalent to local access on that machine.

## 2. The Four Token Classes

| Token | Issued by | Stored where | Scope | Used on |
|-------|-----------|--------------|-------|---------|
| **Primary API token** | `chroxy init` (or rotation via `TokenManager`) | OS keychain when available (server auto-migrates out of `~/.chroxy/config.json` on first boot — `server-cli.js` ~line 321); falls back to `~/.chroxy/config.json` on systems without keychain support; `expo-secure-store` on the app | Full session authority — no session scoping | WS `auth` message, HTTP `Authorization: Bearer ...`, dashboard cookie/query |
| **Pairing-bound session token** | `PairingManager.validatePairing()` on consumption of a one-shot pairing ID | Persisted **encrypted at rest** (`~/.chroxy/session-tokens.json`, 0600 — #6598); `expo-secure-store` on the app. Configurable **sliding** TTL (`sessionTokenTtl`, default 30d) that refreshes on each connect | Bound to exactly one `sessionId`; rejected by every session-scoped handler if the target session differs | Same wire paths as primary token; server distinguishes via `pairingManager.getSessionIdForToken()` |
| **Per-session hook secret** | `CliSession` constructor — `randomBytes(32).toString('hex')` | In-process only; passed to the `claude` CLI via `CHROXY_HOOK_SECRET` env var | Single session **and** single endpoint (`POST /permission`) | Permission-hook callbacks from the spawned CLI subprocess only |
| **Daemon-level ingest secret** (#5413) | Server startup — `randomBytes(32).toString('base64url')`, created once | `~/.chroxy/ingest-secret`, mode 0600 (`CHROXY_CONFIG_DIR` honored) — readable by same-user hook emitters | `POST /api/events` (notifications only) + `POST /api/mailbox*` (notification + a bounded, fixed-string wakeup into an idle claude-tui recipient — see §6); no reads | External Claude Code hook emitters (sessions chroxy did NOT launch) + the `agent-comm-system` mailbox emit hook |

The implementation files are:

- Primary token: [`packages/server/src/config.js`](../../packages/server/src/config.js), [`packages/server/src/token-manager.js`](../../packages/server/src/token-manager.js), [`packages/server/src/token-compare.js`](../../packages/server/src/token-compare.js)
- Pairing tokens: [`packages/server/src/pairing.js`](../../packages/server/src/pairing.js), [`packages/server/src/ws-auth.js`](../../packages/server/src/ws-auth.js)
- Hook secrets: [`packages/server/src/cli-session.js`](../../packages/server/src/cli-session.js) (creation), [`packages/server/src/ws-server.js`](../../packages/server/src/ws-server.js) (`_validateHookAuth`)
- Ingest secret: [`packages/server/src/event-ingest.js`](../../packages/server/src/event-ingest.js) (creation + validation + route handler)

## 3. Primary API Token — Full Session Authority

`_validateBearerAuth` (`ws-server.js`) and the WS auth handler (`ws-auth.js`) both call `_isTokenValid(token)`, which is a constant-time comparison against `this.apiToken` (plus any active rotation grace token, see §7). There is **no session scoping at this layer**. A request that presents a valid primary token can:

- Subscribe to events from any session (`subscribe_session` / `subscribedSessionIds`)
- List and switch the active session (`set_active_session`)
- Send input, create, destroy, and rename sessions
- Read session history (`history_request`, paged history)
- Change models, permission modes, and per-session rules
- Modify config and settings via the dashboard

This is by design. The token represents the operator of the host machine.

### Why HTTP `/permission-response` has no `subscribedSessionIds` analog

On the WebSocket, each client tracks `subscribedSessionIds` so a permission broadcast for session A is not delivered to a client only subscribed to session B (see [`ws-server.js`](../../packages/server/src/ws-server.js) — `_broadcastToSession`, which delegates to `WsBroadcaster._broadcastToSession`). HTTP requests are stateless and present only a bearer token, so there is no equivalent per-connection subscription set to consult.

For an HTTP caller presenting the **primary** token, this is consistent with the trust model: the primary token already grants full session authority, so cross-session HTTP `permission-response` calls are within the token's authority. For a caller presenting a **pairing-bound** token, the binding check in `handlePermissionResponseHttp()` ([`ws-permissions.js`](../../packages/server/src/ws-permissions.js) ~line 312, around the `callerBoundSessionId` branch) explicitly rejects mismatched sessions with a 403 + `SESSION_TOKEN_MISMATCH` payload, so bound tokens cannot cross sessions even on HTTP.

## 4. Pairing-Bound Session Tokens

A pairing flow turns a short-lived pairing ID (shown in a QR code) into a longer-lived session token without ever exposing the primary token on the wire.

### Pairing flow

1. The dashboard renders a QR containing `chroxy://<host>?pair=<pairingId>`. Pairing IDs live in `_activePairings`, expire after `DEFAULT_TTL_MS` (60s), and are single-use ([`pairing.js`](../../packages/server/src/pairing.js)).
2. The app scans the QR and opens a WebSocket to the host.
3. Before authenticating, the app sends `{ type: 'pair', pairingId }`.
4. The server calls `pairingManager.validatePairing(pairingId, activeSessionId)`. On success, a fresh 32-byte session token is issued, stored in `_sessionTokens` with a configurable **sliding** TTL (default 30d, #6598) and **persisted encrypted at rest** so it survives a daemon restart, and returned to the client.
5. The app stores the session token in `expo-secure-store` and uses it on subsequent connections via the normal `auth` message — the server's `_isTokenValid` accepts it because `PairingManager.isSessionTokenValid()` returns true.

Two creation paths differ in how the binding is set:

- **Linking mode** (`_generatePairing` / `_current`): the issued token's binding is taken from the `activeSessionId` parameter at validation time. WsServer always passes `null` for this parameter ([`ws-server.js`](../../packages/server/src/ws-server.js) ~line 624), so linking-mode tokens are **unbound** — they behave like the primary token for session listing/switching.
- **Share-a-session** (`generateBoundPairing(sessionId)`): the entry stores `boundSessionId` at creation time. `validatePairing` uses it unconditionally, ignoring the param. The resulting token is bound to that one session.

### What "bound" enforces

When `ws-auth.js` accepts a pair-issued token, it sets `client.boundSessionId` on the WebSocket client. Every session-scoped handler then filters by it:

- History (`ws-history.js`) restricts session lists, fetches, and resumes to `boundSessionId` only
- Broadcasts (`ws-server.js` — `_broadcastToSession`, `_subscribeAllClientsToSession`) skip bound clients whose binding does not match
- HTTP `/permission-response` (`handlePermissionResponseHttp()` in [`ws-permissions.js`](../../packages/server/src/ws-permissions.js)) requires `originSessionId === callerBoundSessionId`; mismatch returns 403 + the unified `SESSION_TOKEN_MISMATCH` payload
- The session list returned in `auth_ok` is filtered to the bound session ([`ws-server.js`](../../packages/server/src/ws-server.js) ~line 534)

Bound tokens cannot create, destroy, switch, or list sibling sessions. They can chat into their bound session and answer permissions for it. That's it.

### Host-level writes a bound token must NOT reach

These host-level mutations are gated against bound tokens even though they arrive on the same WS surface, because each one escalates beyond a single session's scope:

- **Auto permission mode** (`set_permission_mode` with `mode: 'auto'`, [`settings-handlers.js`](../../packages/server/src/handlers/settings-handlers.js)) — flipping a session to auto-approve is a privilege escalation, so a bound token is rejected with `AUTO_MODE_FORBIDDEN_BOUND_CLIENT`. Only the primary token (and only when `allowAutoPermissionMode` is set in the local config) can enable it.
- **Permission rules** (`set_permission_rules`, [`settings-handlers.js`](../../packages/server/src/handlers/settings-handlers.js)) — permission rules auto-allow execution-capable tools (Write, Edit, …), which is the same escalation as flipping auto mode for those tools, so a bound token is rejected with `PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT`. Only unbound clients (the primary token, or an unbound linking-mode pairing token) may manage them.
- **Provider credential writes** (`set_credential` / `delete_credential` and the BYOK `byok_set_credentials` / `byok_clear_credentials`, [`settings-handlers.js`](../../packages/server/src/handlers/settings-handlers.js) — `rejectCredentialWriteIfBound`) — a bound token can READ masked, value-free status, but writing lets the caller swap in a key it controls (billing redirection) or clear keys (DoS). That integrity risk is distinct from "use the credentials a session already resolves", so writes are rejected with `CREDENTIAL_WRITE_FORBIDDEN_BOUND_CLIENT` (#5155). Reads stay open to any authenticated client.
- **Skill trust** (`skill_trust_grant` / `skill_trust_accept`, [`settings-handlers.js`](../../packages/server/src/handlers/settings-handlers.js) — `rejectSkillTrustIfBound`) — a skill is **host-executable code**; granting trust to a community-skill author or re-accepting changed skill content whitelists that code to run on the host. That is a host-level integrity decision, so it is rejected with `SKILL_TRUST_FORBIDDEN_BOUND_CLIENT` (#5857). Note `skill_activate` / `skill_deactivate` are NOT gated — they only toggle already-installed, already-trusted local skills into a session, which is no more capability than the input a bound client can already send.
- **File / git mutations** (`write_file`, `git_stage`, `git_unstage`, `git_commit`, [`file-handlers.js`](../../packages/server/src/handlers/file-handlers.js) — `rejectMutationIfBound`) — these were path-confined (`validatePathWithinCwd`) but otherwise ungated, so a bound token could overwrite files or mutate git state in the session's cwd. A bound token is scoped to observe/collaborate on one session, not to mutate the host filesystem, so they are rejected with `FILE_MUTATION_FORBIDDEN_BOUND_CLIENT` (#6541). Reads (`read_file`, `browse_files`, `get_diff`, `git_status`, …) stay open to any authenticated client. The primary token and the app's unbound linking-mode token still write, so the existing FileEditor is unaffected.

All of these gates branch on `client.boundSessionId` and reject via `sendError` (a generic `error` message) — the canonical pattern for "this operation requires host-level authority" on the WS path. "Host-level authority" here means any unbound client (no `boundSessionId`), which includes unbound linking-mode pairing tokens, not strictly the primary token. New credential-touching or config-mutating handlers should follow it (see §9).

### HTTP endpoints a bound token must NOT reach (`_validatePrimaryBearerAuth`, #5533)

The WS path distinguishes a bound token via `client.boundSessionId`. HTTP requests are stateless, so the equivalent gate is **`_validatePrimaryBearerAuth(req, res)`** ([`ws-server.js`](../../packages/server/src/ws-server.js)): it accepts a token only if it validates **and** is NOT a `PairingManager`-issued session token, rejecting bound tokens with `403 { "error": "primary_token_required" }`. This is the HTTP analog of the WS host-authority gate — `403` (not `401`) because the token IS valid, just an insufficient class.

The following HTTP routes ([`http-routes.js`](../../packages/server/src/http-routes.js)) are gated on the primary token class. Each one either **mints/exposes live pairing material** (a bound device could otherwise transitively onboard further peers — "pairing-bound tokens can transitively mint peers"), **discloses the primary token itself**, or **performs a host-level mutation beyond a single session's scope**:

| Route | Why primary-only |
|---|---|
| `GET /qr` | Returns the linking-mode QR encoding a live pairing URL; scanning it onboards a new peer. |
| `GET /qr/session/:sessionId` | MINTS a fresh **bound** pairing id (`generateBoundPairing`) — the share-a-session QR. |
| `GET /pairing-code` | Returns the current typeable linking code (#5512) and extends its grace window. |
| `GET /connect` | Returns `connection.json`, which carries the **raw primary `apiToken`** and a `connectionUrl` embedding it whenever auth is required. A bound token reaching this escalates straight to the primary token. The body's redaction branch only fires when auth is *disabled*, so it is NOT the boundary. |
| `POST /pair-discord` | Mints a fresh approval-gated pairing id and posts its `chroxy://` link to Discord (#5513) — gated from day one. |
| `DELETE /api/snapshots/:slug` | Host-level mutation: removes a docker image + sidecar shared across all sessions, beyond one session's scope (#5074 / audit P1-6). The `GET /api/snapshots` list stays read-only on `_validateBearerAuth`. |
| `GET /api/paired-devices` | Enumerates the running daemon's paired-device roster (#6678). Unlike `GET /api/snapshots`, the LIST is primary-only too: the roster is host-level pairing state, and a scoped/paired device seeing its siblings is information disclosure. Wire ids are non-reversible digests — never token material. |
| `DELETE /api/paired-devices/:id` | Live per-device revoke (#6678): drops the token from `PairingManager`'s in-memory map, so the device's next auth fails without a daemon restart — a host-level mutation beyond one session's scope. Fail-CLOSED across a crash (#6902 — see §12). |
| `DELETE /api/paired-devices` | Live revoke-ALL — the operator panic button (#6678). Same host-level authority; every paired device must re-pair. Fail-CLOSED across a crash (#6902 — see §12). |

Both revoke routes return **500 `{ "error": "revoke not persisted", "revoked": 0 }`** (not a false `ok:true` / 404) if the durable store write fails — the token stays valid and the operator retries, rather than trusting a revoke a crash would undo (#6902, §12).

All are exercised only by the daemon's **own dashboard** (`getAuthToken()` → the host's primary token via `?token=`/cookie) or the local **CLI** (`chroxy pair-code` → `connection.json` apiToken). The desktop LAN client's "Have a code?" flow (#5512) does NOT fetch these over HTTP — it takes a code typed off the host's screen and drives the WebSocket `pair` handshake directly, so no legitimate caller relies on a pairing-bound token reaching these endpoints.

The remaining bearer-gated HTTP routes (`/version`, `/metrics`, `/diagnostics`, `GET /api/snapshots`, `/api/pool/stats`) are read-only operational telemetry that exposes no pairing or credential material, so they stay on `_validateBearerAuth` (any valid token). Note the `DELETE /api/snapshots/:slug` mutation is the exception — it is primary-only (see the table above).

### The WS primary-token gate (`client.isPrimaryToken`, #5985b)

For most WS operations, "host-level authority" means **any unbound client** (no `client.boundSessionId`) — which includes unbound linking-mode pairing tokens, i.e. an ordinary paired phone. That is the right bar for listing/switching sessions, but it is **too weak** for a capability that is arbitrary host code execution.

`handleAuthMessage` ([`ws-auth.js`](../../packages/server/src/ws-auth.js)) therefore stamps **`client.isPrimaryToken`** at auth time — the WS analog of HTTP's `_validatePrimaryBearerAuth`: a token is the primary class iff it is NOT a `PairingManager`-issued session token (`!pairingManager.isSessionTokenValid(token)`; `true` in no-auth mode). The `pair`-message path never sets it, so paired clients default to non-primary; gates check strict `=== true`.

**Capabilities that require `client.isPrimaryToken === true` (strictly NOT any pairing token):**

| Capability | Where | Why strict-primary |
|---|---|---|
| Create a `user-shell` session | `handleCreateSession` (`PRIMARY_TOKEN_REQUIRED`) | spawns the operator's `$SHELL` — arbitrary host code execution, not a sandboxed Claude session |
| `terminal_subscribe` to a `user-shell` PTY | `handleTerminalSubscribe` | streams raw shell output (live exfil of what the operator types/sees) |
| `terminal_resize` / `terminal_input` to a `user-shell` PTY | `handleTerminalResize` / `handleTerminalInput` | drives / types into a root shell |

User-shell sessions are additionally gated by the `userShell.enabled` config flag (default OFF), enforced authoritatively in `SessionManager.createSession` so it covers every spawn path (WS create, restore, internal). The terminal_* gates key on the positive `session.constructor.isUserShell` discriminator, so they are inert for every existing (non-shell) session type.

**Audit trail (#5985).** Every user-shell lifecycle event is recorded to the `shell-audit` log component (`packages/server/src/shell-audit.js`) as a single greppable `[shell-audit]` line: a `user_shell_create` entry (sessionId, authorizing `clientId` + `tokenClass`, cwd, resolved shell, device) emitted by the WS create handler — the only layer that knows the token class — and a matching `user_shell_destroy` entry (sessionId, the shell's natural exit code/reason when it ended before teardown, else a `null` code with `reason=destroyed` for a per-session destroy or `reason=shutdown` at process shutdown) emitted by `SessionManager` for both teardown paths. Per-keystroke command-input auditing is deliberately out of scope (volume + privacy); the create/destroy pair with the token class is the traceability anchor. Filter the server log on the `shell-audit` component to reconstruct who opened which shell, from where, and how it ended.

> **Always-on (#6001):** the trail is emitted via the logger's level-independent `audit()` path (tagged `[AUDIT] [shell-audit]`), so it is recorded regardless of `LOG_LEVEL` — a quiet `LOG_LEVEL=warn`/`error` daemon still captures every shell create/destroy. The lines are redacted and written to the daemon log file like any other.

## 5. Per-Session Hook Secrets

Each `CliSession` mints a 32-byte hex secret in its constructor ([`cli-session.js`](../../packages/server/src/cli-session.js) ~line 193) and exports it to the spawned `claude` CLI subprocess as `CHROXY_HOOK_SECRET`. The CLI uses it on outbound `POST /permission` callbacks.

`_validateHookAuth` ([`ws-server.js`](../../packages/server/src/ws-server.js) ~line 882) checks the bearer token against the registered set of hook secrets only — it never accepts the primary API token when at least one hook secret is registered. The fallback to `_isTokenValid` exists for legacy single-session setups and tests where no hook secret was registered; it is not reached in normal multi-session operation.

Hook secrets are in-process only. They are never persisted, never sent over the user-facing WebSocket, and never appear in QR codes.

## 6. Daemon-Level Ingest Secret (`POST /api/events` + `POST /api/mailbox*`, #5413)

External Claude Code sessions — ones chroxy did **not** launch — report lifecycle/activity events through `POST /api/events` ([`event-ingest.js`](../../packages/server/src/event-ingest.js), wired in [`http-routes.js`](../../packages/server/src/http-routes.js)). Neither of the two existing narrow classes fits this caller:

- **Per-session hook secrets don't exist for these sessions** — they are minted by `CliSession` when chroxy spawns the CLI, and these sessions were spawned by something else.
- **The primary token must NOT be handed to hook processes.** A hook emitter runs inside every external Claude Code session's hook environment; placing the primary token there would give full session authority (read all history, send input anywhere) to anything that can read a hook's env or the hook config.

So the endpoint accepts exactly one credential: a dedicated daemon-level secret, generated once at server startup (`ensureIngestSecret()` in `server-cli.js`, lazily re-created by the route if missing) and persisted 0600 at `~/.chroxy/ingest-secret`, where same-user hook emitters (the Phase-4 `packages/claude-hooks` package) read it. Properties:

- **`/api/events`: minimal authority.** The secret authorizes injecting schema-validated events (`IngestEventSchema` in `@chroxy/protocol` — strict envelope, bounded strings, capped `data` bag) into the notification pipeline. It cannot read anything, reach any session, or mutate any state beyond a notification being sent. A leaked ingest secret yields notification spam at worst — and four rate-limit layers bound even that: a pre-auth per-IP ceiling at the route (the hard total — a secret-holder rotating `source` to mint fresh buckets still hits it), per-source buckets behind auth, per-category limits in `PushManager`, and the per-project throttle in the Discord sink. `source` is also charset-restricted at the schema (alphanumeric + `._-`) so it can neither inject log lines nor inflate bucket cardinality with arbitrary bytes.
- **`/api/mailbox*`: notification + a *bounded* session wakeup (mailbox delivery).** The same secret also gates the mailbox live-interrupt routes ([`mailbox-route.js`](../../packages/server/src/mailbox-route.js)): `POST /api/mailbox/register` records an `agentCommId → sessionId` mapping, and `POST /api/mailbox` notifies (category `mailbox`) and, when the mapped recipient is a **live, idle claude-tui** session, injects a **fixed** wakeup string (`"You have N unread mailbox message(s) — run receive_next to process them.\r"`) into its PTY via the session's public `writeTerminalInput`. This is a deliberate, narrow widening of the ingest secret beyond "notification only": a holder can submit that one templated prompt to a session it can name and re-point the routing map. It is bounded — the injected text is not attacker-controlled (only the count varies), injection is skipped unless the session is idle (`!isRunning`), it is claude-tui-only, and it only reaches sessions an operator explicitly registered. It still grants **no reads** and cannot run arbitrary input. Treat the ingest secret accordingly: a leak now also permits triggering benign mailbox wakeups, not just notification spam.
  - **The `agentCommId → sessionId` map can ALSO be populated without the ingest secret**, at session-create time: the `create_session` WS message accepts an optional `agentCommId`, registered under the client's **normal session-create authority** (primary or pairing-bound token — the same authority that lets it spawn the session at all), not the ingest secret. This is a convenience that removes the separate `POST /api/mailbox/register` round-trip; it grants no new authority (a client that can create a session can already name it and drive its PTY). The id is validated by the same contract as the route (`SessionManager.registerAgentCommId`: ≤200 chars, no control characters — the latter matters because the id never reaches the injected PTY string, but the bound is enforced in one place). Registered ids are persisted with session state so they survive a daemon restart.
- **Constant-time validation** via `safeTokenCompare`, like every other token path. The presented token is never logged.
- **Fail closed.** Missing/invalid auth → `401` with an empty body (no detail about why). If the secret file cannot be read or created, every request is rejected.
- **Tunnel exposure.** Like `POST /permission`, the route is reachable through the Cloudflare tunnel when one is up; possession of the bearer secret is the boundary, not network position. The secret never travels except as the `Authorization` header of ingest requests (loopback or tunnel-TLS).
- **No primary-token fallback.** Unlike `_validateHookAuth`'s legacy branch, the ingest route never accepts the primary token — there is no deployment where the primary token is the right credential for a hook process.

## 7. Token Lifecycle

| | Primary | Pairing-bound | Hook secret | Ingest secret |
|---|---|---|---|---|
| Generation | `randomBytes(32).toString('base64url')` at `chroxy init` ([`cli/init-cmd.js`](../../packages/server/src/cli/init-cmd.js) ~line 110); can be regenerated by re-running `chroxy init` or rotated via `TokenManager` | `randomBytes(32).toString('base64url')` per pairing | `randomBytes(32).toString('hex')` per session | `randomBytes(32).toString('base64url')` once, at first server start (or first ingest request) |
| Persistence | OS keychain when available (preferred); otherwise `~/.chroxy/config.json`; `expo-secure-store` on the app | Persisted encrypted at rest (`~/.chroxy/session-tokens.json`, 0600 — #6598); `expo-secure-store` on the app | In-memory only | `~/.chroxy/ingest-secret`, 0600, atomic write |
| Default TTL | None (static) | Configurable **sliding** TTL (`sessionTokenTtl`, default 30d — #6598); refreshes on each connect, so only an idle device expires | Session lifetime | None (static) |
| Rotation | Optional via the `tokenExpiry` config key or `CHROXY_TOKEN_EXPIRY` env var ([`config.js`](../../packages/server/src/config.js)), driven by `TokenManager`; old token honored for a grace period (`DEFAULT_GRACE_MS = 5m`) and a `token_rotated` event (`reason: 'scheduled'`) is emitted — clients re-key transparently and live sessions survive | Sliding (#6598): each connect refreshes the token's clock; re-pair only after the TTL elapses idle | New secret per session | Delete the file + restart the daemon (a fresh secret is generated; hook emitters pick it up on their next read) |
| Revocation | Regenerate (via `chroxy init` or scheduled rotation; old token invalid after grace window), or `TokenManager.revoke()` — the panic button: old token invalid **immediately** (no grace), live user-shells severed, all connections forced to re-auth (`reason: 'revoke'`, §12, #6006) | Expiry (configurable sliding TTL, default 30d, #6598), `PairingManager.destroy()`, the restart-scoped `chroxy tokens revoke [handle] \| --all` CLI (#6599), or a **live** per-device / revoke-all from the dashboard Paired Devices panel (`PairingManager.revokeSessionTokenById` / `revokeAllSessionTokens` via the primary-only `DELETE /api/paired-devices[/:id]` routes — effective on the running daemon, no restart; #6678) | Session destroyed | Delete/replace the file + restart |

**Implication of static-by-default primary token:** if it leaks, an attacker has full authority until the user manually regenerates and re-pairs. The mitigation surface is:

- Constant-time comparison (`safeTokenCompare`) on every validation path to prevent timing oracles
- Exponential backoff rate limiting on auth failures (1s, 2s, 4s, ..., capped at 60s; `ws-auth.js`)
- Optional rotation via the `tokenExpiry` config key or `CHROXY_TOKEN_EXPIRY` env var for environments that want bounded blast radius

## 8. Audit Chain

Each step here tightened a real bug. Read the PRs in order if extending any of these surfaces:

- **#2806** — original session-binding enforcement on WS handlers (`boundSessionId` introduced)
- **#2832** — `SESSION_TOKEN_MISMATCH` failure mode + `[session-binding-*]` debug logs (see [`docs/troubleshooting/session-token-mismatch.md`](../troubleshooting/session-token-mismatch.md))
- **#4788 / #4794** — closed gaps where bound tokens could resolve cross-session permissions
- **#4798** — unified `SESSION_TOKEN_MISMATCH` payload across WS and HTTP error surfaces
- **#4820** — P0 fix for cross-session `permission_response` hijack on the WS path; the review of that PR is what motivated this doc (issue #4830)
- **#5155** — gated provider-credential WRITES (set/delete/clear, both the #3855 generalized and #4052 BYOK paths) behind host-level authority; bound tokens can read masked status but not overwrite or clear keys
- **#5533** — scoped the pairing-material / token-disclosing HTTP routes (`/qr`, `/qr/session/:id`, `/pairing-code`, `/connect`; `/pair-discord` was primary-only from day one) to the primary token class via `_validatePrimaryBearerAuth`, closing the transitive peer-minting path (a once-paired device could read the live QR/code) and the `/connect` primary-token disclosure
- **#5985b** (epic #5982) — introduced the WS `client.isPrimaryToken` primitive (the WS analog of `_validatePrimaryBearerAuth`) and gated the embedded user-shell capability on it: creating a `user-shell` session and all `terminal_*` ops (subscribe / resize / input) on a user-shell PTY now require the strict primary class, not merely an unbound client. Closes the gap where an unbound linking-mode pairing token (an ordinary paired phone) would have reached a root shell. Paired with the `userShell.enabled` default-OFF config gate (#5985a) and the `isClaudeTui` mailbox/PTY-injection fence (#5984).
- **#5985 audit** (epic #5982) — added the `shell-audit` lifecycle trail (`shell-audit.js`): user-shell create (with authorizing token class + client/device) and destroy (with exit code/reason) are logged so a powerful capability's usage is traceable. Completes #5985's "create/destroy audited" acceptance criterion. The `userShell` capability advertised in `auth_ok` is also tightened to require the primary token (not just the config flag), so paired clients never see a "New Shell" affordance they can't use (#5996/#5999 review).

## 9. Adding a New Endpoint or Message Type — Checklist

Before merging any PR that adds a new HTTP route or WebSocket message handler that touches session state:

1. **Decide which token classes you accept.** Most HTTP endpoints accept the primary token only. `/permission` accepts hook secrets. `/api/events` and `/api/mailbox*` accept the daemon-level ingest secret only (never the primary token). WS handlers accept primary + pairing-bound.
2. **If the operation is session-scoped**, branch on `client.boundSessionId` (WS) or call the equivalent of `pairingManager.getSessionIdForToken(token)` (HTTP) and reject mismatches with 403 + `buildSessionTokenMismatchPayload()`.
3. **If the operation is global** (e.g. listing all sessions, changing config) or **mints/exposes pairing material or the primary token**, explicitly reject bound tokens — do not let them silently see everything. On HTTP, use **`_validatePrimaryBearerAuth(req, res)`** (403 + `primary_token_required`); see §4's HTTP table. `_validateBearerAuth` accepts ANY valid token, including pairing-bound ones, so it is only for read-only operational routes that leak no pairing/credential material.
4. **Never log raw tokens.** `maskToken()` exists for a reason.
5. **Use `safeTokenCompare()`** for any byte-equality check against a token.

## 10. LAN-Bind Unauthenticated Surface (#5356)

By default the server binds **all interfaces** (`resolveBindHost()` in [`packages/server/src/bind-host.js`](../../packages/server/src/bind-host.js) returns `undefined` unless `--no-auth` or an explicit `host` is set, so `httpServer.listen(port)` binds `0.0.0.0`). Every device on the local network can therefore reach the HTTP/WS socket. Possession of a bearer token remains the authorization boundary — but the following is reachable **without any token**:

| Surface | What it leaks / allows |
|---|---|
| `GET /`, `GET /health` | `{ status, mode, version }` — fingerprints a running chroxy daemon and its exact version. This is the same probe the mobile app's LAN scanner uses, so it is also what a hostile subnet scan finds. |
| `GET /dashboard/*`, `GET /assets/xterm/*` | Static dashboard shell + JS only; no session data without a token. |
| WS pre-auth | `auth` (256-bit token, constant-time compare, exponential-backoff lockout) and `pair` (live 60-second, single-use, ~96-bit pairing ID) attempts; 10s pre-auth timeout, pre-auth connection cap. |
| `POST /api/events`, `GET /diagnostics` | Pre-auth per-IP rate limit, then secret-/bearer-gated (see §6). |
| `POST /api/mailbox`, `POST /api/mailbox/register` | Ingest-secret bearer-gated (see §6); body capped at 8 KB. |

So the unauthenticated blast radius on a LAN bind is **service fingerprinting (existence + version) plus an online brute-force surface** — not session access. Note also that direct LAN connections use `ws://` (no TLS), so when LAN mode is actually used the token travels plaintext on the local network — see [`encryption-threat-model.md` §8](encryption-threat-model.md).

Mitigations / visibility:

- **Opt-in loopback bind**: `--host 127.0.0.1`, `CHROXY_HOST=127.0.0.1`, or `"host": "127.0.0.1"` in `~/.chroxy/config.json` restricts the socket to the local machine. The Cloudflare tunnel is unaffected (cloudflared dials `http://localhost:<port>`); only mobile LAN mode and LAN-client flows need a non-loopback bind.
- **Startup warning** (`maybeWarnNonLoopbackBind()` in `bind-host.js`): one `log.warn` whenever the server binds non-loopback, naming the bind address and the restriction knob.
- **Quick-tunnel warning**: when a public trycloudflare quick tunnel comes up, the tunnel adapter warns that the URL is internet-reachable (bearer-gated, but fingerprintable).
- **Dashboard banner**: the auth_ok `exposure` snapshot (`{ lanBind, bindHost, quickTunnel }`) drives a dismissible dashboard warning banner reflecting the same two conditions.

Whether the *defaults* should change (loopback-by-default for the desktop app, explicit tunnel choice in the wizard) is tracked in issue #5356 and deliberately not decided here.

## 11. Page Share Slugs — Unauthenticated Capability URLs (Chroxy Pages, #5683)

Chroxy Pages serves a published HTML artifact at `GET /p/<slug>/…` ([`http-routes.js`](../../packages/server/src/http-routes.js), store in [`pages-store.js`](../../packages/server/src/pages-store.js)). This route is **intentionally unauthenticated** — it presents no bearer token. The **slug itself is the capability**: a `crypto.randomBytes(16)` base64url value (~128 bits) minted per page, so an unguessable link is the entire access grant. This lets a report be opened on any device without distributing the primary token, by design.

This is a deliberate exception to "every control surface is bearer-token gated," so it is fenced on every side:

| Control | Mechanism |
|---|---|
| **No JS, no network in served pages** | Every response (including 404s) carries `Content-Security-Policy: …; script-src 'none'; connect-src 'none'; sandbox; default-src 'none'; …` plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. This is the load-bearing control: `script-src 'none'` + `connect-src 'none'` make served pages fully static, so they cannot run code or reach any endpoint. (Defence-in-depth, *not* the sole guard: `_validateBearerAuth` is **header-only** — it does not accept a cookie (`ws-server.js`) — and the `chroxy_auth` cookie that `_authenticateDashboardRequest` does set is `Path=/dashboard`-scoped + `HttpOnly`, so it never reaches `/p/*` or `/api/*`. The scriptless+networkless CSP holds regardless of any future cookie-scope change, which is why it is the durable control.) Interactive (JS) pages are explicitly **not** served here — they would require an isolated origin (deferred follow-up). |
| **No arbitrary filesystem reads** | The slug is validated against the base64url charset *and* must exist in the manifest before any fs access. `resolveFile()` resolves under `~/.chroxy/pages/<slug>/` and rejects `..`, absolute paths, and **symlinks whose real path escapes the page directory** (`realpathSync` containment check). |
| **No slug scanning / disk DoS** | The route is per-IP rate-limited (`_pagesRateLimiter`) before any fs work. Per-page and total-size caps bound disk use; `chroxy pages rm <slug>` deletes the directory + manifest entry, revoking the link instantly. |
| **Scope** | The route only serves files under the pages directory — it can never read session state, credentials, or any other `~/.chroxy/` content. |

The unauthenticated blast radius is therefore: anyone who **already holds a valid slug** can read that one static page (which the publisher chose to share) — equivalent to handing someone the link. A scanner with no slug gets rate-limited 404s.

## 12. Known Risks

- **Static primary token is the default.** The QR shown at startup encodes an ephemeral pairing URL (not the primary token), so the leak surface is the OS keychain entry, a fallback `~/.chroxy/config.json` on systems without keychain support, or any environment / launcher that surfaces the token in process listings. If any of those are exfiltrated, the attacker has full authority until the user rotates. Rotation is opt-in.
- **No certificate pinning or out-of-band key verification.** See [`encryption-threat-model.md` §8 — Trust On First Use](encryption-threat-model.md#trust-on-first-use-tofu).
- **Pairing tokens are issued without device proof.** A pairing ID, if captured during the 60-second window, can be redeemed by any device. The window is short and the IDs are 12-byte base64url (~96 bits of entropy) precisely because the trust model assumes the QR is a physical-proximity channel.
- **Pairing-bound tokens last a configurable sliding window (default 30d, #6598) and persist across restarts** (encrypted at rest). A stolen bound token grants single-session access until it expires (idle) or is revoked. Longer TTLs trade convenience for a wider stolen-token window — the operator owns that dial via `sessionTokenTtl`, and per-device revocation (the safety valve) is available both restart-scoped (`chroxy tokens revoke`, #6599) and **live** from the dashboard Paired Devices panel (#6678, effective on the running daemon — the revoked device's next connect fails auth).

  **Live revoke is fail-CLOSED across a crash (#6902).** `PairingManager.revokeSessionTokenById` / `revokeAllSessionTokens` persist the post-removal snapshot to the encrypted store **BEFORE** they drop the token from the in-memory map (`_persistSessionTokensSnapshot`) — the reverse of the pre-fix delete-then-persist-best-effort order. The store write is atomic (temp file + rename via `writeFileRestricted`), so the on-disk `session-tokens.json` is always either the pre- or the post-removal state. A **daemon/process crash** at any instant therefore either keeps the token fully valid (memory + disk agree, operator re-tries) or leaves it revoked on disk — it can never **resurrect** on the next start, closing the asymmetry vs mint (mint's lost persist is fail-*safe* — the device simply re-pairs). (A power loss / kernel panic *within the OS writeback window* is out of scope: `writeFileRestricted` does not `fsync`, so the atomic rename can still be rolled back by the OS after a `200` — tracked in #6914.) If the durable write itself fails, the revoke method returns `{ revoked: 0, persistFailed: true }` and the HTTP route answers **500** rather than a false success. (In-memory-only mode — no store configured — has no durability to lose, so the revoke proceeds and reports success.)
- **`userShell.enabled` raises the blast radius of a leaked primary token.** With the embedded user-shell enabled (default OFF, #5982), a leaked primary token yields an **unmediated remote root shell** over the tunnel — not just Claude-session access (which Claude's permission engine still mediates). Operators who enable `userShell.enabled` should strongly prefer token rotation (`tokenExpiry` / `CHROXY_TOKEN_EXPIRY`) and a loopback bind.

  **Revoke vs scheduled rotation (#6006).** `TokenManager` now distinguishes the two via a `reason` on the `token_rotated` event:
  - **Scheduled/periodic rotation** (`rotate()`, fired by the `tokenExpiry` timer) is graceful: the old token stays valid through the grace period, encrypted clients receive the new token and transparently re-key, and **live user-shell sessions survive**. This is the path the recommended `tokenExpiry` config exercises, so it deliberately does not disrupt long-running shells.
  - **Revoke** (`TokenManager.revoke()`, the operator panic button) treats the old token as compromised: it is invalidated **immediately with no grace**, the server severs **every** live user-shell session (`SessionManager.destroyAllUserShellSessions`), and **every** WS connection is forced back to unauthenticated (`authenticated` + `isPrimaryToken` cleared). The dispatch gate then rejects all privileged ops — including a shell re-create on the same socket — until the connection re-authenticates with the *current* token, obtained out-of-band (re-pair / re-scan). The server never pushes the new token on a revoke, even to encrypted clients, so a compromised connection can't pick it up. This closes the bypass where a sever-only sweep was instantly undone by a re-create on the still-authenticated socket.
  - **Operator trigger:** the panic button is the `revoke_token` WS message (`token-handlers.js`), gated server-side on `client.isPrimaryToken === true` — a paired/pairing client gets `NOT_AUTHORIZED`, and `--no-auth` (no `TokenManager`) gets `REVOKE_UNAVAILABLE`. The dashboard surfaces it as a confirm-guarded **"Revoke token"** item in the header overflow menu, shown only when the server advertises the `tokenRevoke` capability (`auth_ok.capabilities` — true iff a `TokenManager` exists AND this client is primary), so non-primary / `--no-auth` clients never see a dead button.
  - **Current-token gate on shell create (#6004).** Creating a user-shell additionally requires the connection to have authed with the **current** token, not a grace/previous one. Each connection's auth token is recorded at auth time (`client.authToken`, in-memory — the client already holds the E2E shared key); the create gate rejects with `CURRENT_TOKEN_REQUIRED` unless `TokenManager.isCurrentToken(client.authToken)` (current-only, never the grace token). This closes the residual where, after a scheduled rotation, a connection authed with the now-grace token could create a **new** user-shell during the grace window — re-establishing shell access the rotation was meant to wind down. (Scheduled rotation keeps live shells; only revoke severs them, and revoke also de-auths the connection — so this gate is specifically the scheduled-rotation residual.) Skipped under `--no-auth` (no `TokenManager`; local trust).

  - **Keeping honest primaries connected (#6012).** When a scheduled rotation pushes the new token to an **encrypted** client, the server also refreshes that connection's recorded `client.authToken` to the new token — so an honest, still-connected encrypted primary can open a *new* shell straight away, without a reconnect. This is safe because scheduled rotation already hands the new token to every connected encrypted client (it is a graceful re-key, not a revocation); the attacker's vector — *reconnecting* with a leaked old token — still fails (it auths with the now-grace token → `isCurrentToken === false`). Two paths deliberately do NOT refresh `authToken`, so they still require a reconnect: **revoke** (never pushes the token, de-auths the connection) and **unencrypted** clients (never receive the pushed token).
  - **Host-local per-spawn shell approval (#6277, opt-in).** With `userShell.requireApproval: true`, a user-shell create is HELD pending the host operator's explicit OK rather than spawning on token authority alone — so a leaked primary token can no longer open an unmediated remote shell over the tunnel without a host-side confirmation. Design:
    - **Per-spawn, single-use, 60s TTL.** Each create is mediated individually; an approval is consumed once and there is no trust window (`shell-approval-store.js`).
    - **Approval channel is genuinely host-local.** The approve/deny/list API runs on a **separate `http.Server` bound to `127.0.0.1` on an ephemeral port that the Cloudflare tunnel never forwards** (cloudflared only proxies the main port). This is load-bearing: a loopback check on the *main* port would be **defeated** because cloudflared makes tunnel traffic arrive as `127.0.0.1`, so a leaked-token attacker over the tunnel could approve their own held shell. The separate, never-tunnelled listener closes that. The port is published to a `0600` `shell-approval.json` for the CLI; each request is additionally primary-token gated (rejects pairing-bound tokens).
    - **Operator flow.** The daemon logs a one-time approval id when a spawn is held; the host operator runs `chroxy shell approve <id>` (or `deny` / `list`). On approval the requester gets the normal `session_switched`; on deny a `session_error` (`SHELL_APPROVAL_DENIED`); the requester is told it's pending via `shell_pending_approval`.
    - **Posture (the decision):** acceptable-debt while user-shell stays opt-in (OFF by default), and this control should be **required before user-shell could ever ship default-on**. A future Tauri-tray approve/deny is the planned UX follow-up.
