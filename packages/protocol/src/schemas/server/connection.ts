/**
 * Connection lifecycle: auth-ok / pairing / background-task / claude-ready, plus the shared MAX_SANE_DURATION_MS and billing-canary shapes the auth handshake carries.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */

import { z } from 'zod'

/**
 * Sanity ceiling for any ms-typed numeric field (#3768).
 *
 * 24 h is well past every legitimate session-timeout / restart-eta /
 * permission TTL we emit today, and tight enough that an env-var typo
 * (`CHROXY_RESULT_TIMEOUT_MS=999999999999999`) gets rejected at the
 * schema boundary instead of corrupting `Date.now() + ms` arithmetic
 * on the client.
 *
 * **Convention for ms-typed fields (#3775):** any field whose value is a
 * duration in milliseconds — timeouts, TTLs, ETAs, intervals — MUST be
 * declared with the required constraint set
 * `z.number().finite().max(MAX_SANE_DURATION_MS)`, plus `.nonnegative()`
 * or `.positive()` chosen by the field's allowed range. Add `.int()` when
 * the field is intended to be a whole number of ms (most ms fields are);
 * omit it only when sub-ms / fractional values are legitimately expected.
 * This applies to both this file and `client.ts`. `client.ts` currently
 * has no ms-typed fields, so the sweep in #3773 was server-only; when the
 * first ms-typed client field is added, import this constant from
 * `./server` (or promote to `../constants.ts` shared module at that
 * point) and apply the same constraint set so server and client agree on
 * the sanity ceiling.
 */
export const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000

const ClientInfoSchema = z.object({
  clientId: z.string(),
  deviceName: z.string().nullable(),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
  platform: z.string(),
})

// Billing canary (#5821 live wiring). A single billing early-warning entry —
// `code` discriminates the kind (SILENT_METERED_DEFAULT, TUI_REPORTED_PROGRAMMATIC_COST,
// DATACENTER_EGRESS); `message` is the human-facing copy. `provider` / `sessionId`
// / `costUsd` are present only for the warnings that carry them. Defined ahead of
// ServerAuthOkSchema so the snapshot can seed `auth_ok` for late-joining clients.
export const BillingCanaryWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  provider: z.string().optional(),
  sessionId: z.string().optional(),
  costUsd: z.number().finite().optional(),
})

// The canary's current state (no `type` — embedded in auth_ok as a seed and
// extended into the billing_canary broadcast below). `warnings` empty = all clear.
export const BillingCanarySnapshotSchema = z.object({
  eraStarted: z.boolean(),
  defaultProvider: z.string(),
  defaultBillingClass: z.string(),
  warnings: z.array(BillingCanaryWarningSchema),
})

export const ServerAuthOkSchema = z.object({
  type: z.literal('auth_ok'),
  clientId: z.string(),
  serverMode: z.literal('cli'),
  serverVersion: z.string(),
  latestVersion: z.string().nullable(),
  serverCommit: z.string(),
  cwd: z.string().nullable(),
  connectedClients: z.array(ClientInfoSchema),
  encryption: z.enum(['required', 'disabled']),
  protocolVersion: z.number().int().min(1),
  minProtocolVersion: z.number().int().min(1),
  maxProtocolVersion: z.number().int().min(1),
  // #3272: server-advertised capability map. Keyed by feature name,
  // value=boolean. Lets the dashboard gate UI affordances on the
  // server actually supporting the matching WS message — e.g.
  // `skillTrustAccept` was added in #3269 and is needed by the
  // SkillsPanel Accept button (#3270). Older servers that don't
  // emit this field are treated as "no advertised capabilities" by
  // the dashboard, so feature-gated UI hides itself fail-closed.
  capabilities: z.record(z.string(), z.boolean()).optional(),
  // #3760: effective server inactivity timeout in ms. Surfaced so the
  // ActivityIndicator "approaching timeout" warning can render against
  // the real configured value instead of a hardcoded 20-min default.
  // Must be a positive finite int (ms). Optional because servers from
  // before #3763 don't emit it — the dashboard/app handlers fall back
  // to their hardcoded reference (DEFAULT_RESULT_TIMEOUT_MS = 20 min)
  // when absent.
  resultTimeoutMs: z.number().int().positive().finite().max(MAX_SANE_DURATION_MS).optional(),
  // #3905: effective server hard-kill inactivity timeout in ms (the
  // #3899 hard cap that follows the soft `resultTimeoutMs` warning).
  // Surfaced so the check-in chip can render an accurate "kill in Xh"
  // countdown instead of assuming the 2-hour default. Optional because
  // servers from before #3905 don't emit it — clients fall back to a
  // 2h default when absent. (The matching server-side constant is
  // `DEFAULT_HARD_TIMEOUT_MS` exported from `base-session.js` but is
  // not re-exported from this package.)
  hardTimeoutMs: z.number().int().positive().finite().max(MAX_SANE_DURATION_MS).optional(),
  // #4477: stream-stall recovery window in ms surfaced in auth_ok so the
  // dashboard chip (#4476) can render "Stream stalled — no response for
  // ${humanize(streamStallTimeoutMs)}" with the real configured value
  // instead of hardcoding the 5-min default.
  //
  // Semantics differ from resultTimeoutMs / hardTimeoutMs: 0 is a valid
  // emission meaning the operator explicitly disabled stream-stall
  // recovery (CHROXY_STREAM_STALL_TIMEOUT_MS=0). BaseSession's
  // `_armResultTimeout` skips arming the stall timer when
  // `_streamStallTimeoutMs === 0`, so the wire must be able to communicate
  // that state distinctly from "older server" (field absent). Hence
  // `.nonnegative()` not `.positive()`.
  //
  // Optional because servers from before #4477 don't emit it — clients
  // fall back to the 5-min default when absent. The matching server-side
  // constant is `DEFAULT_STREAM_STALL_TIMEOUT_MS` exported from
  // `base-session.js` but is not re-exported from this package.
  streamStallTimeoutMs: z.number().int().nonnegative().finite().max(MAX_SANE_DURATION_MS).optional(),
  // #5356 (visibility layer): exposure snapshot so clients can warn about the
  // server's network posture. `lanBind` = the HTTP/WS socket is bound to a
  // non-loopback interface (the historical 0.0.0.0 default included), so LAN
  // peers can reach the unauthenticated surface (/health fingerprint,
  // dashboard assets, rate-limited auth/pairing attempts). `quickTunnel` =
  // a public trycloudflare quick tunnel is configured, so the server is
  // internet-reachable at a random public URL (bearer-gated). `bindHost` is
  // the literal address passed to listen(). Optional — servers from before
  // #5356 don't emit it, and clients treat absence as "unknown" (no banner).
  exposure: z.object({
    lanBind: z.boolean(),
    bindHost: z.string().nullable(),
    quickTunnel: z.boolean(),
  }).optional(),
  // #5821 (live wiring) — current billing-canary snapshot, seeded into auth_ok
  // so a freshly-connected client renders the billing banner immediately rather
  // than waiting for the next broadcast. Optional: older servers omit it; live
  // changes still arrive via the `billing_canary` broadcast.
  billingCanary: BillingCanarySnapshotSchema.optional(),
  // #5555 (eager key exchange) — the server's ephemeral X25519 public key,
  // present ONLY when the client supplied a valid `eagerPublicKey` + `eagerSalt`
  // in its `auth` message AND encryption is required. When present, the client
  // derives the shared key immediately from this and the post-auth queue is
  // already un-gated server-side, so the discrete `key_exchange` round trip is
  // skipped. Field shape mirrors `key_exchange_ok`'s `publicKey`. Absent when:
  // the client sent no eager fields (old client), encryption is disabled, or
  // the server predates #5555 (old server) — in every absent case the client
  // falls back to the discrete `key_exchange` handshake. No flag day.
  serverPublicKey: z.string().max(512).optional(),
  // #5536 (E2E key pinning) — base64 Ed25519 signature over `serverPublicKey`,
  // present only on the eager path when the daemon has a pinned identity. A
  // pinned client verifies it against the identity key it captured at pairing
  // time before keying off `serverPublicKey`. Absent for unpinned daemons /
  // older servers — old clients ignore it (TOFU unchanged).
  serverKeySig: z.string().max(512).optional(),
  // #5616 (identity-key rotation handoff) — continuity-cert fields, present on
  // the eager path only when the daemon's identity has been rotated and a
  // continuity cert was minted at rotation time. `newIdentityKey` is the
  // daemon's CURRENT (post-rotation) base64 Ed25519 identity public key;
  // `rotationCert` is the base64 detached signature of `newIdentityKey` made by
  // the PREVIOUS (pinned) identity's secret key. A pinned client whose stored
  // pin no longer matches `serverKeySig` uses the pair to chain its pin forward
  // (verify old-signed-new + new signed THIS exchange key) instead of refusing.
  // Absent for un-rotated daemons / older servers — clients ignore them and the
  // pin-mismatch path is unchanged (refuse → manual re-pair). Same shape as
  // `serverKeySig` so the existing 512-char base64 bound applies.
  newIdentityKey: z.string().max(512).optional(),
  rotationCert: z.string().max(512).optional(),
  // #5555 (auth_bootstrap) — fold the static permission-mode enum into auth_ok
  // so a new client reads it here instead of waiting for the discrete
  // `available_permission_modes` burst frame (still sent for older clients).
  // Optional: servers from before #5555 omit it and clients fall back to the
  // discrete frame.
  // Object array — each entry is `{ id, label, description? }` (server
  // `PERMISSION_MODES`), the SAME shape as the discrete
  // `available_permission_modes` frame's `modes`. (#5592 review: a
  // `z.array(z.string())` here would reject a real new-server auth_ok.)
  availablePermissionModes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })).optional(),
}).passthrough()

export const ServerAuthFailSchema = z.object({
  type: z.literal('auth_fail'),
  reason: z.string(),
})

export const ServerPairFailSchema = z.object({
  type: z.literal('pair_fail'),
  reason: z.string(),
})

// -- Pairing-approval primitive (#5510, epic #5509) --
//
// The verify code travels ONLY server→surfaces: the requester receives it on
// `pair_request_pending` to display; the approver receives it on `pair_pending`
// to compare. The requester never sends the code back, so it cannot influence
// the value (mismatch is impossible by construction). The issued token is
// delivered EXACTLY once on `pair_result { ok: true }` — never logged.

// To the requester, immediately after the daemon queues its pair_request.
export const ServerPairRequestPendingSchema = z.object({
  type: z.literal('pair_request_pending'),
  requestId: z.string(),
  // 6-digit human-comparable verification code (string to preserve leading
  // zeros). Constrained to exactly 6 digits so a server-side regression to a
  // different alphabet/length is caught at the validation boundary.
  verifyCode: z.string().regex(/^\d{6}$/),
})

// Fanned out to HOST-LEVEL (unbound) approval surfaces. deviceName is
// attacker-controlled — capped at the schema and rendered as plain text.
export const ServerPairPendingSchema = z.object({
  type: z.literal('pair_pending'),
  requestId: z.string(),
  deviceName: z.string().max(64),
  // Exactly 6 digits — see ServerPairRequestPendingSchema.
  verifyCode: z.string().regex(/^\d{6}$/),
  // epoch ms when this request expires (lets the surface render a countdown
  // and drop the entry on TTL without a separate message).
  expiresAt: z.number().int().nonnegative().finite(),
})

// To the requester over its still-open connection. On approve: { ok: true,
// token }. On deny / timeout / approver-gone: { ok: false, reason }.
export const ServerPairResultSchema = z.object({
  type: z.literal('pair_result'),
  requestId: z.string(),
  ok: z.boolean(),
  token: z.string().optional(),
  reason: z.string().optional(),
})

// Sent to a host-level surface to RETRACT a pending request that has been
// resolved (approved/denied elsewhere, or expired) so every surface can drop
// its banner. No verify code — just the id and why.
export const ServerPairResolvedSchema = z.object({
  type: z.literal('pair_resolved'),
  requestId: z.string(),
  reason: z.string(),
})

/**
 * #5431 — one outstanding background task surfaced on `claude_ready`.
 *
 * `kind` maps the launching tool: a `run_in_background` Bash call, a
 * `run_in_background` Agent (subagent) call, or a Monitor stream. The
 * task is "outstanding" when its launch has no matching task-notification
 * in the session transcript yet. `startedAt` is epoch ms (the transcript
 * entry's timestamp), matching the `startedAt` convention used by
 * `pendingBackgroundShells` / `activeTools`.
 */
export const BackgroundTaskSchema = z.object({
  toolUseId: z.string(),
  kind: z.enum(['bash', 'agent', 'monitor']),
  description: z.string(),
  startedAt: z.number().int().nonnegative().finite(),
})

export const ServerClaudeReadySchema = z.object({
  type: z.literal('claude_ready'),
  // #5431: outstanding background work detected from the session
  // transcript when the readiness probe flips to "ready for input".
  // Both fields are OPTIONAL — servers from before #5431 (and session
  // providers without transcript access) never emit them, and clients
  // treat absence exactly like today's plain ready. An explicit empty
  // `backgroundTasks: []` means "previously-reported tasks have all
  // completed" so clients can clear a stale indicator.
  backgroundTasks: z.array(BackgroundTaskSchema).optional(),
  // #5431: a pending ScheduleWakeup — the agent ended its turn but
  // arranged to resume at `at` (epoch ms). Absent when no wakeup is
  // scheduled or it has already fired/been superseded.
  scheduledWakeup: z.object({
    at: z.number().int().nonnegative().finite(),
    reason: z.string(),
  }).optional(),
})

// #6323 (batch 1 of #6314): multi-client presence — broadcast to OTHER
// authenticated clients when a client connects (`client_joined`, with its
// device descriptor) or disconnects (`client_left`). Emitted by ws-broadcaster.
export const ServerClientJoinedSchema = z.object({
  type: z.literal('client_joined'),
  client: z.object({
    clientId: z.string(),
    deviceName: z.string().nullable(),
    deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
    platform: z.string(),
  }),
})

export const ServerClientLeftSchema = z.object({
  type: z.literal('client_left'),
  clientId: z.string(),
})

// #6332 (batch 2b of #6314): E2E key-exchange ack (ws-auth.js). `publicKey` (the
// server's ephemeral X25519 public key, base64) is always present; `serverKeySig`
// (#5536 Ed25519 sig over publicKey) is spread only when the daemon has a pinned
// identity, and `newIdentityKey` + `rotationCert` (#5616 rotation-continuity) are
// spread as a pair only alongside it — all three absent (not null) otherwise.
export const ServerKeyExchangeOkSchema = z.object({
  type: z.literal('key_exchange_ok'),
  publicKey: z.string(),
  serverKeySig: z.string().optional(),
  newIdentityKey: z.string().optional(),
  rotationCert: z.string().optional(),
})

// #6332: throttle notice (ws-server.js) — the client should back off for
// `retryAfterMs` before retrying. Identical field set at both emit sites.
export const ServerRateLimitedSchema = z.object({
  type: z.literal('rate_limited'),
  retryAfterMs: z.number(),
  message: z.string(),
})
