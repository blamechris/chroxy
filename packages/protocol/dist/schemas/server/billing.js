/**
 * Error envelope + credentials/notification-prefs + shutdown/pong + cost/budget/billing-canary + web-task + extension + evaluate-draft/evaluator-rewrite shapes.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
import { BillingCanarySnapshotSchema, MAX_SANE_DURATION_MS } from "./connection.js";
import { CumulativeUsageSchema } from "./session.js";
// #4178: generic server `error` envelope shape — the catch-all schema for
// `type: 'error'` messages that aren't covered by a code-specific variant
// like `ServerSkillTrustGrantInvalidAuthorSchema`. `fatal: false` was
// introduced by #4145 (MAX_TOOL_ROUNDS_REACHED) and is consumed by
// #4176's warning-toast branch in the dashboard. Declaring it here lets
// other clients (mobile app, future tools) consume the same shape via
// the shared store-core `handleError` parser. `fatal` defaults unset
// (treated as `true` by consumers) so omitting it preserves the
// pre-#4145 contract.
//
// `correlationId` + `details` are emitted by the server's INVALID_MESSAGE
// schema-rejection path (`ws-server.js:1314`) and any handler that calls
// `handler-utils.sendError(ws, requestId, code, message, data)` — the
// `data` arg is merged onto the envelope (`handler-utils.js:420-435`)
// after a reserved-field guard. `.passthrough()` matches the wire and
// preserves code-specific fields (e.g. `actualAuthor` on INVALID_AUTHOR,
// `boundSessionId` on SESSION_TOKEN_MISMATCH) so future consumers parsing
// against this generic schema don't silently lose context.
export const ServerErrorEnvelopeSchema = z.object({
    type: z.literal('error'),
    requestId: z.string().nullable().optional(),
    code: z.string().optional(),
    message: z.string(),
    fatal: z.boolean().optional(),
    correlationId: z.string().optional(),
    details: z.string().optional(),
}).passthrough();
// #4141: BYOK credentials status — emitted by handleByokGetCredentialsStatus /
// handleByokSetCredentials / handleByokClearCredentials and broadcast to all
// connected clients on set/clear (#4142). Dashboard previously type-cast the
// payload with raw `as` casts at message-handler.ts:2660 which accepted any
// status/source string from the wire — a malformed server could store
// `status: 'unknown'` into the store. This schema constrains the shape.
//
// fileExists: tracks the on-disk credentials file presence (#4144). When
// status === 'missing' but fileExists === true, the dashboard shows the
// stale-file notice (#4175) — broaden contract handled separately.
export const ServerByokCredentialsStatusSchema = z.object({
    type: z.literal('byok_credentials_status'),
    requestId: z.string().nullable().optional(),
    status: z.enum(['set', 'missing']),
    source: z.enum(['env', 'file', 'none']),
    masked: z.string().optional(),
    reason: z.string().optional(),
    fileExists: z.boolean().optional(),
}).passthrough();
// #3855: generalized provider-credential status. One entry per known
// credential env var. The raw value is NEVER on the wire — only `masked`
// (a redacted preview) when status === 'set'. `source` adds 'store' (the
// ~/.chroxy/credentials.json store) and 'oauth' (a detected OAuth credential
// for the provider) to the BYOK set. Sent only to the requesting client
// (admin state, no broadcast) plus a no-requestId broadcast after set/delete
// so additional dashboards stay in sync.
const ServerCredentialEntrySchema = z.object({
    key: z.string(),
    provider: z.string(),
    label: z.string(),
    kind: z.enum(['api-key', 'oauth-token']),
    status: z.enum(['set', 'missing']),
    source: z.enum(['env', 'store', 'oauth', 'none']),
    masked: z.string().optional(),
    oauth: z.boolean(),
}).passthrough();
export const ServerCredentialsStatusSchema = z.object({
    type: z.literal('credentials_status'),
    requestId: z.string().nullable().optional(),
    credentials: z.array(ServerCredentialEntrySchema),
    fileExists: z.boolean().optional(),
    fileError: z.string().nullable().optional(),
}).passthrough();
// #3855: result of a `test_credential` ping. `ok` true means the provider
// accepted the credential. Never carries the raw value.
export const ServerCredentialTestResultSchema = z.object({
    type: z.literal('credential_test_result'),
    requestId: z.string().nullable().optional(),
    key: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    model: z.string().optional(),
    latencyMs: z.number().optional(),
}).passthrough();
// #3544: cumulative stdin_dropped totals broadcast to clients bound to the
// session whenever a SidecarProcess pre-dial-cap drop occurs. Operators not
// tailing the server log (mobile users, dashboard-only operators) see a live
// "X bytes lost over N drops" indicator instead of a hung turn. Emitted on
// every drop (not only the loud-signal escalations) so the counter stays
// fresh; `escalated` mirrors the server-side log level so the UI can
// differentiate routine warn-level updates from first-drop / threshold-cross
// / every-Nth error-level moments. `sessionId` is null for legacy single-CLI
// mode where there is no per-session scoping. Transient — not replayed on
// reconnect, but the cumulative counters are session-lifetime so the next
// drop re-publishes the running total.
export const ServerStdinDroppedTotalsSchema = z.object({
    type: z.literal('stdin_dropped_totals'),
    sessionId: z.string().nullable(),
    bytes: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    reason: z.string(),
    escalated: z.boolean(),
});
export const ServerErrorSchema = z.object({
    type: z.literal('server_error'),
    category: z.string().optional(),
    message: z.string(),
    recoverable: z.boolean(),
});
export const ServerPushTokenErrorSchema = z.object({
    type: z.literal('push_token_error'),
    message: z.string(),
});
// #4541: notification preferences snapshot. Emitted by
// `handleNotificationPrefsGet` and again after every `notification_prefs_set`.
// Mirrors the on-disk shape (~/.chroxy/notification-prefs.json) without the
// header — the wire payload IS the prefs object.
//
// `categories` is an open-ended map keyed by RATE_LIMITS category names from
// `push.js`. The server-side loader sanitises unknown keys at the storage
// boundary, so the wire shape stays permissive — adding a new push category
// in `push.js` does not require a protocol bump.
//
// `requestId` is echoed on the response to the originating client; the
// broadcast variant emitted after a set carries no requestId so all
// connected clients update in lockstep.
const NotificationPrefsCategoriesSchema = z.record(z.string().min(1).max(64), z.boolean());
// #4544: quiet-hours window carries an IANA timezone; per-device entries
// may also carry their own `quietHours` and `bypassCategories` (the
// device-level fields REPLACE the global value, see `notification-prefs.js`).
const NotificationPrefsQuietHoursSchema = z.union([
    z.null(),
    z.object({
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1).max(64),
    }),
]);
const NotificationPrefsBypassListSchema = z.array(z.string().min(1).max(64)).max(64);
const NotificationPrefsDevicesSchema = z.record(z.string().min(1).max(512), z.object({
    categories: NotificationPrefsCategoriesSchema.optional(),
    quietHours: NotificationPrefsQuietHoursSchema.optional(),
    bypassCategories: NotificationPrefsBypassListSchema.optional(),
}).passthrough());
export const ServerNotificationPrefsSchema = z.object({
    type: z.literal('notification_prefs'),
    requestId: z.string().nullable().optional(),
    prefs: z.object({
        categories: NotificationPrefsCategoriesSchema,
        devices: NotificationPrefsDevicesSchema,
        quietHours: NotificationPrefsQuietHoursSchema,
        // #4544: globally-applied bypass list. Optional in the wire schema so
        // older servers that omit the field still parse — clients should treat
        // `undefined` as "use the documented defaults" (permission + activity_error).
        bypassCategories: NotificationPrefsBypassListSchema.optional(),
    }).passthrough(),
}).passthrough();
export const ServerShutdownSchema = z.object({
    type: z.literal('server_shutdown'),
    // 'crash' is emitted from uncaughtException/unhandledRejection handlers in
    // server-cli.js / server-cli-child.js via broadcastShutdown('crash', 0).
    reason: z.enum(['restart', 'shutdown', 'crash']),
    restartEtaMs: z.number().int().nonnegative().finite().max(MAX_SANE_DURATION_MS),
});
export const ServerPongSchema = z.object({
    type: z.literal('pong'),
    // #5515: optional wall-clock stamp so clients can split the ping/pong RTT
    // into uplink (ping send → serverTs) and downlink (serverTs → pong recv)
    // halves. See ServerStreamDeltaSchema for the wall-clock/skew caveat.
    serverTs: z.number().int().nonnegative().finite().optional(),
});
export const ServerCostUpdateSchema = z.object({
    type: z.literal('cost_update'),
    sessionCost: z.number().nullable().optional(),
    totalCost: z.number().nullable().optional(),
    budget: z.number().nullable().optional(),
});
export const ServerSessionUsageSchema = z.object({
    type: z.literal('session_usage'),
    // sessionId is injected by _broadcastToSession; optional in the schema
    // so consumers can construct the message without it pre-broadcast.
    sessionId: z.string().optional(),
    cumulativeUsage: CumulativeUsageSchema,
});
// #4075: soft per-session cost-threshold crossing. Fires ONCE per
// session when cumulativeUsage.costUsd >= the configured threshold.
//
// costUsd is finite but kept unconstrained-sign: in practice it's the
// running cumulative at the crossing point so always positive, but the
// schema doesn't enforce that to stay consistent with CumulativeUsage
// where refunds (#4099) can in principle drive the cumulative
// negative. thresholdUsd is non-negative by setter contract.
export const ServerSessionCostThresholdCrossedSchema = z.object({
    type: z.literal('session_cost_threshold_crossed'),
    sessionId: z.string().optional(),
    costUsd: z.number().finite(),
    thresholdUsd: z.number().finite().nonnegative(),
});
export const ServerBudgetWarningSchema = z.object({
    type: z.literal('budget_warning'),
    sessionCost: z.number(),
    budget: z.number(),
    percent: z.number(),
    message: z.string(),
});
export const ServerBudgetExceededSchema = z.object({
    type: z.literal('budget_exceeded'),
    sessionCost: z.number(),
    budget: z.number(),
    percent: z.number(),
    message: z.string(),
});
// #5821 (live wiring) — billing-canary broadcast. Pushed when the daemon's
// billing early-warning state changes (silent metered default; the dormant
// claude-tui reclassification tripwire). Empty `warnings` = all clear, so the
// client clears its banner. The same snapshot also seeds `auth_ok` for late
// joiners. Shares BillingCanarySnapshotSchema (defined near the top) so the
// broadcast and the seed can't drift.
export const ServerBillingCanarySchema = BillingCanarySnapshotSchema.extend({
    type: z.literal('billing_canary'),
});
// #5752: positive ack for an actioned `resume_budget` request. The substantive
// state change (un-pausing) is still broadcast as `budget_resumed` — but ONLY
// when the session was actually paused, because that message injects a "session
// resumed" chat note. The ack is sent to the *requesting* client unconditionally
// so the resume control is never a dead button: a click on an already-resumed
// session (e.g. a second client in a shared session, or a stale tap) resolves
// cleanly with `wasPaused: false` instead of silence. Mirrors the
// `cancel_activity_ack` correlation contract (#5277).
export const ServerBudgetResumeAckSchema = z.object({
    type: z.literal('budget_resume_ack'),
    sessionId: z.string().optional(),
    // True when this request actually un-paused the session (a `budget_resumed`
    // broadcast accompanied it); false when the session was not paused (no-op).
    wasPaused: z.boolean(),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #5665: machine-wide monthly programmatic-credit budget meter. Broadcast to
// ALL clients after each programmatic-credit-billed turn, and sent once on
// connect as a snapshot. `budgetUsd`/`percent` are null when no cap is
// configured (chroxy can't detect the plan tier). `justWarned`/`justExceeded`
// mark one-shot threshold crossings on the live event and are omitted from the
// on-connect snapshot.
export const ServerMonthlyBudgetSchema = z.object({
    type: z.literal('monthly_budget'),
    month: z.string(), // "YYYY-MM" (UTC calendar month)
    spentUsd: z.number().finite().nonnegative(),
    turnsBilled: z.number().int().nonnegative(),
    budgetUsd: z.number().finite().nonnegative().nullable(),
    warningPercent: z.number().finite(),
    percent: z.number().finite().nullable(),
    warning: z.boolean(),
    exceeded: z.boolean(),
    justWarned: z.boolean().optional(),
    justExceeded: z.boolean().optional(),
});
// -- Web task schemas --
const WebTaskSchema = z.object({
    taskId: z.string(),
    prompt: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    createdAt: z.number(),
    updatedAt: z.number(),
    result: z.string().nullable(),
    error: z.string().nullable(),
    cwd: z.string().optional(),
});
export const ServerWebFeatureStatusSchema = z.object({
    type: z.literal('web_feature_status'),
    available: z.boolean(),
    remote: z.boolean(),
    teleport: z.boolean(),
});
export const ServerWebTaskCreatedSchema = z.object({
    type: z.literal('web_task_created'),
    task: WebTaskSchema,
});
export const ServerWebTaskUpdatedSchema = z.object({
    type: z.literal('web_task_updated'),
    task: WebTaskSchema,
});
/**
 * Emitted when a web (cloud) task command fails. Two failure shapes share this
 * envelope:
 *
 * 1. **Generic task failure** — only `taskId` and `message` are populated
 *    (e.g. missing prompt, validation error, downstream task error).
 * 2. **`SESSION_TOKEN_MISMATCH` rejection** — emitted when a client bound to
 *    one session attempts a `web_task_*` command against a different session.
 *    In this case the payload also carries the canonical four-field contract
 *    documented in `docs/error-taxonomy.md`: `code`, `message`, `boundSessionId`,
 *    `boundSessionName`. The same four fields appear on every envelope that
 *    can carry SESSION_TOKEN_MISMATCH (`session_error`, `error`, this schema,
 *    and the HTTP 403 body) and originate from
 *    `buildSessionTokenMismatchPayload()` in `packages/server/src/handler-utils.js`.
 *
 * Note that `code` is generic — it may also be populated for non-bound-session
 * web-task failures (e.g. `WEB_TASK_PROMPT_TOO_LARGE`). The two fields that
 * are *only* populated on SESSION_TOKEN_MISMATCH are `boundSessionId` and
 * `boundSessionName`.
 */
export const ServerWebTaskErrorSchema = z.object({
    type: z.literal('web_task_error'),
    taskId: z.string().nullable().optional(),
    message: z.string(),
    /**
     * Machine-readable error code. May be set for specific web-task failures
     * — e.g. `'SESSION_TOKEN_MISMATCH'` (bound-session rejections, paired with
     * `boundSessionId`/`boundSessionName`) or `'WEB_TASK_PROMPT_TOO_LARGE'`
     * (prompt-size guard in `feature-handlers.js`) — and absent for generic
     * task failures. Clients may branch on this field; the bound-session
     * recovery context is carried in `boundSessionId`/`boundSessionName`. See
     * `docs/error-taxonomy.md` § SESSION_TOKEN_MISMATCH. Bounded to 64 chars
     * to mirror `ServerMessageSchema.code`.
     */
    code: z.string().max(64).optional(),
    /**
     * The session ID the client's auth token is bound to. Populated on
     * `SESSION_TOKEN_MISMATCH` rejections so the client can surface which
     * session the device is paired to. `null` when the caller has no binding
     * (HTTP fallback path); a stale or unresolvable session ID is preserved
     * as-is. Sourced from `buildSessionTokenMismatchPayload()`.
     */
    boundSessionId: z.string().nullable().optional(),
    /**
     * Display name of the bound session, looked up at emit time via
     * `sessionManager.getSession()`. `null` when `boundSessionId` is null or
     * the session can no longer be resolved. Used by clients to render
     * actionable messages like "Device paired to _My Project_". Sourced from
     * `buildSessionTokenMismatchPayload()`.
     */
    boundSessionName: z.string().nullable().optional(),
});
export const ServerWebTaskListSchema = z.object({
    type: z.literal('web_task_list'),
    tasks: z.array(WebTaskSchema),
});
// -- Extension message (server → client) --
export const ServerExtensionMessageSchema = z.object({
    type: z.literal('extension_message'),
    provider: z.string().min(1),
    subtype: z.string().min(1),
    data: z.unknown(),
    sessionId: z.string().optional(),
});
// -- Prompt evaluator result (#3068, manual on-demand variant) --
//
// Modelled as a union of two mutually-exclusive shapes so clients can rely on
// the contract: a parsed value either carries a `verdict` (and verdict-specific
// fields) OR an `error`, never both. The `z.never().optional()` guards on each
// branch reject payloads that try to set both — earlier permissive shape would
// happily parse mixed payloads and let bugs slip through.
const ServerEvaluateDraftSuccessSchema = z.object({
    type: z.literal('evaluate_draft_result'),
    // Echoes the client's requestId so the dashboard can correlate to the click
    // that triggered evaluation. Always present (null when client omitted it).
    requestId: z.string().nullable(),
    verdict: z.enum(['forward', 'rewrite', 'clarify']),
    // Populated when verdict === 'rewrite'
    rewritten: z.string().nullable().optional(),
    // Populated when verdict === 'clarify'
    clarification: z.string().nullable().optional(),
    // 1-2 sentence explanation, always set on success
    reasoning: z.string(),
    error: z.never().optional(),
});
const ServerEvaluateDraftErrorSchema = z.object({
    type: z.literal('evaluate_draft_result'),
    requestId: z.string().nullable(),
    error: z.object({
        code: z.string(),
        message: z.string(),
        // #3100: numeric upstream HTTP status, present only for API errors
        // where the Anthropic SDK exposed a status (401/403/429/5xx etc.).
        // Omitted for network errors, NO_API_KEY, BAD_RESPONSE, etc.
        status: z.number().int().optional(),
    }),
    verdict: z.never().optional(),
    rewritten: z.never().optional(),
    clarification: z.never().optional(),
    reasoning: z.never().optional(),
});
export const ServerEvaluateDraftResultSchema = z.union([
    ServerEvaluateDraftSuccessSchema,
    ServerEvaluateDraftErrorSchema,
]);
// -- Auto-evaluator broadcast events (#3208) --
//
// Unlike `evaluate_draft_result` (request/response, manual flow), these two
// events are broadcast to clients bound to `sessionId` WITHOUT a triggering
// client request. They fire when the auto-evaluation hook (#3186) lands on
// a `rewrite` or `clarify` verdict for a `user_input` message that was
// gated through `session.config.promptEvaluator`.
//
// `evaluatorIterationId` is a server-generated monotonic-per-session id
// used by the dashboard to dedup events received over a reconnect replay.
// `evaluatorIteration` (clarify only) is the 1-based clarify-loop counter.
// The server clamps it to its configured `maxIterations` (currently 3, see
// #3186) before emit; the wire schema enforces a 10-iteration sanity ceiling
// so a misconfiguration or counter overflow can't surface as e.g.
// "Iteration 999/3" in the dashboard. Tighten the ceiling in lock-step if
// future server-side caps land below 10.
export const ServerEvaluatorRewriteSchema = z.object({
    type: z.literal('evaluator_rewrite'),
    sessionId: z.string(),
    originalDraft: z.string(),
    rewritten: z.string(),
    reasoning: z.string(),
    evaluatorIterationId: z.string(),
});
export const ServerEvaluatorClarifySchema = z.object({
    type: z.literal('evaluator_clarify'),
    sessionId: z.string(),
    originalDraft: z.string(),
    clarification: z.string(),
    reasoning: z.string(),
    evaluatorIterationId: z.string(),
    evaluatorIteration: z.number().int().min(1).max(10),
});
