/**
 * Per-session signals: focus/inactivity, multi-question, MCP servers, plan mode, cumulative usage, session list/restore/persist/stopped, provider list, auth bootstrap, tunnel url, skills list + skill-trust handshake.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */

import { z } from 'zod'

import { MAX_SANE_DURATION_MS } from './connection.ts'
import { ServerPendingBackgroundShellSchema } from './stream.ts'

export const ServerClientFocusChangedSchema = z.object({
  type: z.literal('client_focus_changed'),
  clientId: z.string(),
  sessionId: z.string(),
  timestamp: z.number(),
})

// #3899: soft inactivity warning. Replaces the pre-#3899 kill-on-timeout
// behaviour with a check-in flow — the server fires this event after
// `resultTimeoutMs` of silence (default 30 min), the client renders a
// transient chip with a one-click `prefab` follow-up message ("Status
// update?"). The session stays alive (busy state preserved, pending
// permissions left pending). If silence continues past `hardTimeoutMs`
// (default 2h) with no user check-in, the existing kill path still fires
// — that's the absolute backstop for genuinely stuck sessions.
//
// `idleMs` is the elapsed silence at the moment the soft timer fired —
// equals `resultTimeoutMs` on the first warning but may differ on later
// firings if the server has been adjusted at runtime.
export const ServerInactivityWarningSchema = z.object({
  type: z.literal('inactivity_warning'),
  messageId: z.string(),
  // `idleMs` matches the duration-field discipline in this file: integer,
  // positive (zero is meaningless for an elapsed-silence value), finite,
  // bounded by MAX_SANE_DURATION_MS (24h). The soft window defaults to
  // 30 min and is operator-configurable down to 30s, so positive is the
  // correct floor — never zero, never negative, never NaN/Infinity.
  idleMs: z.number().int().positive().finite().max(MAX_SANE_DURATION_MS),
  prefab: z.string(),
})

// #4653: chroxy-side intervention surfaced to the user. Currently only the
// multi-question AskUserQuestion deny shipped in #4648 fires this event.
// The dashboard / mobile app append a SessionIntervention entry to the
// targeted session's interventions ring and render a FooterBar counter
// chip + (first-time only) inline system ChatMessage so users can tell
// chroxy intervened — without this surface the deny is invisible.
//
// `reason` is a discriminator that lets future intervention kinds land
// without a wire version bump (sibling-deny from #4668 would extend the
// enum here). `questionCount >= 2` because the permission-hook only
// denies multi-question forms — single-question is the happy path.
export const ServerMultiQuestionInterventionSchema = z.object({
  type: z.literal('multi_question_intervention'),
  // Stable id of the tool_use the hook denied. Dashboard dedups by this
  // so a stuck model re-emitting the same payload doesn't inflate the
  // counter falsely (the #4666 / #4668 failure mode).
  toolUseId: z.string(),
  // Question count from the denied AskUserQuestion form. Hook only fires
  // for length > 1, so the floor is 2 — defence-in-depth against a server
  // bug that would otherwise inject a "0 questions" entry into the UI.
  questionCount: z.number().int().min(2).finite(),
  reason: z.literal('multi_question'),
  // Server wall-clock when the deny happened. Allowed to be 0 (epoch) so
  // a clock-skewed dev environment doesn't bounce the event off the wire,
  // but typical values are 1.7e12+ (post-2023). The client renders relative
  // ("3s ago") from this.
  timestamp: z.number().int().min(0).finite(),
})

export const ServerMcpServersSchema = z.object({
  type: z.literal('mcp_servers'),
  servers: z.array(z.object({
    name: z.string(),
    status: z.string(),
  })),
})

export const ServerPlanStartedSchema = z.object({
  type: z.literal('plan_started'),
})

export const ServerPlanReadySchema = z.object({
  type: z.literal('plan_ready'),
  allowedPrompts: z.array(z.any()).optional(),
})

// #4091: cumulative per-session token + cost totals. Emitted by
// _trackUsage on every priced result event; consumed by the dashboard
// sidebar cost badge (#4073) and mobile session-header badge (#4074).
//
// Token counts + turnsBilled are non-negative integers — they are
// monotonic counters that only grow on priced result events. costUsd
// is finite but intentionally kept unconstrained-sign: a refund /
// credit-adjustment turn (#4099) subtracts from the running total,
// and a session that received only refunds could legitimately end up
// with a negative cumulative.
//
// Declared up here (and not next to the other event-emit schemas
// further down the file) so it can be reused inline by
// `ServerSessionListEntrySchema` below — keeps the snapshot field and
// the event-emit shape in lockstep when either changes.
export const CumulativeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite(),
  turnsBilled: z.number().int().nonnegative(),
})

/**
 * One entry in a `session_list` payload (and the equivalent shape returned
 * by `SessionManager.listSessions()` server-side).
 *
 * `passthrough()` so future field additions don't break older clients that
 * haven't bumped the schema yet — only the keys we care about for cross-
 * package validation are listed explicitly. New clients can rely on the
 * documented optional fields below; older clients see them as `undefined`
 * and fall back to their pre-existing defaults.
 *
 * Documented hydration fields:
 *   - `stdinForwardingDisabled` (#3540): latched stdin_disabled flag so
 *     reconnecting clients see the disabled state without waiting for a
 *     fresh `error` event.
 *   - `stdinDroppedBytes` / `stdinDroppedCount` (#3573): cumulative
 *     `stdin_dropped` byte / drop counters maintained for the session
 *     lifetime by SdkSession. Lets a dashboard / mobile client connecting
 *     after one or more drops happened paint the "X bytes lost over N
 *     drops" indicator immediately, instead of waiting for the next drop
 *     to fire the runtime `stdin_dropped_totals` event. Non-SDK providers
 *     (CliSession, Codex, Gemini) round-trip as `0`.
 */
export const ServerSessionListEntrySchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  // cwd is conventionally always set by the server, but the schema accepts
  // it as optional so test fixtures and minimal mock managers (which omit
  // it for brevity) still validate. Real session_list payloads always carry
  // a string `cwd`.
  cwd: z.string().optional(),
  model: z.string().nullable().optional(),
  permissionMode: z.string().optional(),
  isBusy: z.boolean().optional(),
  createdAt: z.number().optional(),
  lastActivityAt: z.number().optional(),
  conversationId: z.string().nullable().optional(),
  provider: z.string().optional(),
  // #5630/#5629: per-session era-aware billing class (mirrors the provider
  // auth field) so the dashboard token view labels each session's cost row by
  // class. Optional — older servers omit it; the client falls back to deriving
  // it from `provider`.
  billingClass: z.enum(['api-key', 'subscription', 'programmatic-credit']).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  worktree: z.boolean().optional(),
  repoCwd: z.string().nullable().optional(),
  isolation: z.string().optional(),
  promptEvaluator: z.boolean().optional(),
  // #3639: per-session skip-pattern source (or null when unset). The
  // dashboard can show / edit this; the server falls back to
  // `config.promptEvaluatorSkipPattern` when null.
  promptEvaluatorSkipPattern: z.union([z.string(), z.null()]).optional(),
  // #3805: per-session opt-in Chroxy context hint flag. Optional because
  // older servers (pre-#3805) omit the field; the dashboard treats
  // `undefined` as `false` (toggle off).
  chroxyContextHint: z.boolean().optional(),
  // #4660: per-session user-authored preamble (free text prepended to
  // the system prompt every turn). Optional because older servers
  // (pre-#4660) omit the field; the dashboard treats `undefined` as
  // empty string (no preamble injected).
  sessionPreamble: z.string().optional(),
  stdinForwardingDisabled: z.boolean().optional(),
  // #3573: cumulative stdin_dropped totals seeded into the handshake so a
  // late-joining client sees the running counter without waiting for the
  // next drop. SDK-backed sessions report real values; non-SDK providers
  // serialize as 0.
  stdinDroppedBytes: z.number().int().nonnegative().optional(),
  stdinDroppedCount: z.number().int().nonnegative().optional(),
  // #4091: per-session running token + cost totals included in the
  // session_list snapshot (#4072 / #4088). Optional because older
  // servers omit it entirely; consumers should treat `undefined` as
  // "no data yet" and an all-zero block as "session has had no priced
  // turns yet" (e.g. subscription-billed providers).
  //
  // Token counts + turnsBilled are non-negative integers; cumulative
  // costUsd is finite but intentionally allowed to be negative — a
  // refund / credit-adjustment turn (#4099) can subtract from the
  // running total, and a session that received only refunds could
  // legitimately end up with a negative cumulative.
  cumulativeUsage: CumulativeUsageSchema.optional(),
  // #4307: pending backgrounded shells. Empty array when no work is
  // pending — never `undefined` from a #4307-aware server (mirrors the
  // `cumulativeUsage` shape, which always carries a zero block once
  // present). Optional in the schema so pre-#4307 servers that omit
  // the field still parse; consumers should treat `undefined` as `[]`.
  pendingBackgroundShells: z.array(ServerPendingBackgroundShellSchema).optional(),
}).passthrough()

export const ServerSessionListSchema = z.object({
  type: z.literal('session_list'),
  sessions: z.array(ServerSessionListEntrySchema),
})

/**
 * Emitted when a session in the persisted state file could not be restored
 * at server startup (e.g. missing env var for a Codex/Gemini provider).
 *
 * History on disk is preserved (`originalHistoryPreserved: true`) so the user
 * can retry after fixing the underlying issue. Dashboards / mobile UIs should
 * surface the failed session in a "needs attention" state with the reported
 * error and a retry affordance. See issue #2954 (Guardian FM-01).
 */
export const ServerSessionRestoreFailedSchema = z.object({
  type: z.literal('session_restore_failed'),
  sessionId: z.string(),
  name: z.string(),
  provider: z.string(),
  cwd: z.string().optional(),
  model: z.string().nullable().optional(),
  permissionMode: z.string().nullable().optional(),
  errorCode: z.string(),
  errorMessage: z.string(),
  originalHistoryPreserved: z.boolean(),
  historyLength: z.number().optional(),
})

/**
 * #5714 / #5701: emitted when a session-list mutation (create / rename / destroy)
 * could not be flushed to disk — disk full, locked file, read-only home. The
 * write is atomic so on-disk state isn't corrupted, but the in-memory change
 * will be lost on the next restart. Clients surface this as an error banner so
 * the operator knows their change wasn't saved (instead of silently believing it
 * was). `name` is null when the entry was already removed before the flush
 * (destroy path) and no label could be resolved.
 */
export const ServerSessionPersistFailedSchema = z.object({
  type: z.literal('session_persist_failed'),
  sessionId: z.string(),
  name: z.string().nullable(),
})

/**
 * #4756: user-initiated Stop confirmation broadcast. CliSession emits a
 * `stopped` event from `_handleChildClose` when the child process exits
 * cleanly after a Stop click (interrupt() set `_intentionalStop`). The
 * SessionManager + ws-forwarding paths surface it as this `session_stopped`
 * wire message so clients can render a quiet "Session stopped." confirmation
 * — distinct from `session_error` (crash) which fires for unexpected exits
 * that trigger the auto-respawn path.
 *
 * `sessionId` is injected by `_broadcastToSession` on the multi-session
 * path, so it's optional on the schema for consumers that construct the
 * message without it pre-broadcast (matches the `cost_update` / `session_usage`
 * pattern). The legacy-cli path doesn't carry a sessionId at all.
 *
 * `code` is the child process exit code (number). Typically 0 on a clean
 * SIGINT exit, but kept on the wire so clients can render the numeric code
 * for non-zero exits (e.g. 143 = SIGTERM). Optional because future providers
 * that adopt the `stopped` event for parity (see #4756 follow-up) may not
 * have a meaningful exit code (e.g. in-process SDK session).
 */
export const ServerSessionStoppedSchema = z.object({
  type: z.literal('session_stopped'),
  sessionId: z.string().optional(),
  code: z.number().int().optional(),
})

// #3404 audit (F1+F5): per-provider auth/billing summary so clients can
// grey-out unusable providers and surface billing-identity confidence.
// Optional on the wire so older servers stay parseable.
const ProviderAuthSchema = z.object({
  ready: z.boolean(),
  source: z.enum(['env', 'oauth', 'none']),
  envVar: z.string().nullable(),
  envVars: z.array(z.string()),
  hint: z.string(),
  detail: z.string(),
  // #5630/#5629: era-aware billing class so the client can label the cost row
  // per class (api-key → "Cost (BYOK)", programmatic-credit → "Credit spend",
  // subscription → "Included (subscription)"). Optional so older servers that
  // omit it still parse; clients fall back to a static per-provider default.
  billingClass: z.enum(['api-key', 'subscription', 'programmatic-credit']).optional(),
})

export const ServerProviderListSchema = z.object({
  type: z.literal('provider_list'),
  providers: z.array(z.object({
    name: z.string(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
    auth: ProviderAuthSchema.optional(),
  })),
})

// #5555 (auth_bootstrap) — single connect-time burst frame that carries the
// provider / slash-command / agent lists right after auth_ok, so a new client
// can SKIP its 3-request `list_providers` / `list_slash_commands` /
// `list_agents` round trip. Payloads mirror the respective request responses
// (`provider_list`, `slash_commands`, `agent_list`) so clients reuse their
// existing per-list handlers to consume them. Each list is optional and
// defaults to empty so a partial server compute (e.g. an unreadable agents
// dir) still parses. `passthrough()` keeps the frame forward-compatible.
export const ServerAuthBootstrapSchema = z.object({
  type: z.literal('auth_bootstrap'),
  providers: z.array(z.object({
    name: z.string(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
    auth: ProviderAuthSchema.optional(),
  })).default([]),
  slashCommands: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
  })).default([]),
  agents: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
  })).default([]),
  // The active session id this burst was scoped to, when applicable. Lets a
  // client ignore a stale burst if it has already switched sessions.
  sessionId: z.string().optional(),
  // #5555 (sub-item 7) — the server's current public tunnel URL as a `wss://`
  // endpoint, when a tunnel is up. Carried in every connect-time bootstrap so a
  // reconnecting client always re-learns the live URL (covers the case where a
  // quick-tunnel rotation happened while the client was offline and it could
  // not receive the live `tunnel_url_changed` push). Absent in LAN / no-tunnel
  // deployments. Never a secret — the QR code already shares this URL.
  tunnelUrl: z.string().optional(),
}).passthrough()

// #5555 (sub-item 7) — quick-tunnel recovery rotates the public URL. The
// server pushes this to every connected client so they can update the stored
// endpoint their reconnect path dials instead of hammering the dead URL.
//
// TIMING / BEST-EFFORT: when the tunnel URL rotates, tunnel-connected clients
// are reaching the server THROUGH the old tunnel, which has just died — they
// usually will NOT receive this frame (the socket is already gone). It is
// genuinely best-effort for them; the durable recovery path for those clients
// is `tunnelUrl` in the `auth_bootstrap` burst on their next reconnect. The
// real beneficiaries are LAN-connected clients (desktop dashboard over
// localhost, LAN clients) whose socket survives the rotation — they get the
// fresh URL immediately and persist it.
//
// SECURITY: the tunnel URL is connection metadata, not a secret (it is shared
// in the QR code), so it is broadcast to ALL authenticated clients including
// pairing-bound ones — a bound client already knows the URL it connected to,
// and a rotated URL is the same trust level. See
// docs/security/bearer-token-authority.md.
export const ServerTunnelUrlChangedSchema = z.object({
  type: z.literal('tunnel_url_changed'),
  // The new public endpoint as a `wss://` URL the client should dial on its
  // next reconnect.
  url: z.string(),
  // The previous `wss://` URL, when known — lets a client match the rotation
  // against a specific stored entry instead of guessing.
  previousUrl: z.string().optional(),
}).passthrough()

export const ServerSkillsListSchema = z.object({
  type: z.literal('skills_list'),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    // #3067: 'global' for ~/.chroxy/skills, 'repo' for <cwd>/.chroxy/skills.
    // Optional so v1 clients keep parsing pre-#3067 payloads cleanly.
    source: z.enum(['global', 'repo']).optional(),
    // #3209: activation mode + per-session active state. Optional so
    // older servers (pre-#3209) without these fields still parse —
    // the dashboard treats absence as `auto`/`active=true`.
    activation: z.enum(['auto', 'manual']).optional(),
    active: z.boolean().optional(),
    // #3205: skills metadata UI fields. All optional — `version` is
    // emitted only when the skill's frontmatter declared one;
    // `hashPrefix`, `firstSeen`, `lastVerified` come from the
    // SkillsTrustStore and are present only when trust is enabled
    // (`trustMismatchMode` set to 'warn' / 'block' on the session)
    // and the skill has been seen at least once. Pre-#3205 servers
    // omit them entirely; the dashboard renders the panel without
    // those columns rather than showing fake data.
    version: z.string().optional(),
    hashPrefix: z.string().length(8).regex(/^[0-9a-f]{8}$/).optional(),
    // #3250: ISO-8601 strings emitted by SkillsTrustStore.getRecord().
    // Tightened from `z.string()` to `z.string().datetime()` so a future
    // serialization drift (e.g. someone passing `Date.toString()` instead
    // of `Date.toISOString()`) fails fast at the schema layer rather
    // than reaching the dashboard's `formatTimestamp` defensive fallback,
    // which would render the malformed string verbatim with no error
    // signal — the regression would silently slip past review.
    //
    // The producer (settings-handlers.handleListSkills) validates each
    // trust-ledger timestamp against `Number.isFinite(Date.parse(...))`
    // before forwarding so a hand-edited or corrupted
    // `~/.chroxy/skills-trust.json` cannot fail the entire `skills_list`
    // payload — malformed values are dropped from the per-skill entry
    // and the response still parses.
    firstSeen: z.string().datetime().optional(),
    lastVerified: z.string().datetime().optional(),
  })),
})

/**
 * Skill content-hash mismatch event (#3234).
 *
 * Emitted when the loader detects that a skill's body has changed since the
 * SkillsTrustStore (#3204) recorded its first-seen hash. Carries only 8-char
 * hash prefixes on the wire — the full SHA-256 never leaves the server,
 * matching the sanitised warn-log format from #3215.
 *
 * `mode` mirrors the active trust mode at detection time:
 *   - `'warn'`  — the skill still loaded; the dashboard should surface a
 *                 banner / prompt so the operator can `acceptHash` or roll
 *                 the change back.
 *   - `'block'` — the skill was filtered out of the active set; stronger UX
 *                 (modal / red badge) is appropriate.
 *
 * `sessionId` is the session this skill was being loaded for, or `null` for
 * legacy single-CLI mode where there is no per-session scoping. Transient —
 * not replayed on reconnect, since the loader re-checks hashes every time
 * skills are scanned.
 */
export const ServerSkillChangedSchema = z.object({
  type: z.literal('skill_changed'),
  skillName: z.string(),
  sessionId: z.string().nullable(),
  // 8-char prefixes of the recorded vs. new SHA-256 (lower-case hex).
  oldHashPrefix: z.string().length(8).regex(/^[0-9a-f]{8}$/),
  newHashPrefix: z.string().length(8).regex(/^[0-9a-f]{8}$/),
  mode: z.enum(['warn', 'block']),
})

// #3209: runtime manual-skill toggle broadcast. Sent to every client
// bound to `sessionId` whenever a `skill_activate` / `skill_deactivate`
// flips the session's active set. Idempotent — only emitted on actual
// state change (the handler returns early on no-op).
export const ServerSkillActivatedSchema = z.object({
  type: z.literal('skill_activated'),
  sessionId: z.string(),
  skillName: z.string(),
})

export const ServerSkillDeactivatedSchema = z.object({
  type: z.literal('skill_deactivated'),
  sessionId: z.string(),
  skillName: z.string(),
})

// #3235: operator confirmed re-trust of a skill after a content-hash
// mismatch. Broadcast to every client bound to `sessionId` so any
// mismatch badge in the dashboard can clear in lock-step. Pairs with
// the `skill_changed` event from #3234 — where `skill_changed` says
// "the content drifted from the recorded hash", `skill_trust_accepted`
// says "the operator accepted the new content as the source of truth".
export const ServerSkillTrustAcceptedSchema = z.object({
  type: z.literal('skill_trust_accepted'),
  sessionId: z.string(),
  skillName: z.string(),
})

// #3297: community skill pending first-activation trust grant. Transient.
export const ServerSkillTrustRequestSchema = z.object({
  type: z.literal('skill_trust_request'),
  skillName: z.string(),
  author: z.string(),
  source: z.string(),
  description: z.string(),
  path: z.string(),
  sessionId: z.string().nullable(),
})

// #3297: community skill trust granted by operator.
export const ServerSkillTrustGrantedSchema = z.object({
  type: z.literal('skill_trust_granted'),
  sessionId: z.string(),
  skillName: z.string(),
  author: z.string(),
})

// #3297: ack sent to the requesting client after a successful skill_trust_grant.
export const ServerSkillTrustGrantOkSchema = z.object({
  type: z.literal('skill_trust_grant_ok'),
  requestId: z.string().nullable(),
  sessionId: z.string(),
  skillName: z.string(),
  author: z.string(),
})

// #3538: structured error response for `skill_trust_grant` when the per-author
// resolve lands on a different community author than the caller claims (the
// #3307 symlink branch and the #3500 shallow-scan branch). The wire shape is
// the canonical handler error (`type: 'error'`, `code`, `message`) plus an
// `actualAuthor` field carrying the real owner so dashboard clients can branch
// on `code === 'INVALID_AUTHOR'` and read the field directly instead of
// regex-parsing the human-readable `message` (which is intentionally not
// stable wording). Other `INVALID_AUTHOR` causes (empty `author` validation)
// do NOT include `actualAuthor` — the field is only present for the
// cross-author variants.
export const ServerSkillTrustGrantInvalidAuthorSchema = z.object({
  type: z.literal('error'),
  requestId: z.string().nullable(),
  code: z.literal('INVALID_AUTHOR'),
  message: z.string(),
  actualAuthor: z.string(),
})
