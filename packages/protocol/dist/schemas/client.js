/**
 * Client → Server message Zod schemas.
 *
 * Moved from packages/server/src/ws-schemas.js to enable shared validation
 * across server, app, and dashboard.
 *
 * **ms-typed fields (#3775):** if you add a field whose value is a duration
 * in milliseconds (timeout, TTL, ETA, interval), follow the convention
 * documented next to `MAX_SANE_DURATION_MS` in `./server` — import that
 * constant (or promote to a shared `../constants.ts` module if more than one
 * client schema needs it) and declare the field with
 * `z.number().finite().max(MAX_SANE_DURATION_MS)` plus `.nonnegative()` /
 * `.positive()` (and `.int()` when the field is a whole number of ms — most
 * are). This keeps server and client schemas on a single sanity ceiling.
 */
import { z } from 'zod';
// -- Attachment schema (reusable) --
const BinaryAttachmentSchema = z.object({
    type: z.enum(['image', 'document']),
    mediaType: z.string().max(256),
    data: z.string().max(10_000_000),
    name: z.string().max(256),
});
const FileRefAttachmentSchema = z.object({
    type: z.literal('file_ref'),
    path: z.string().max(4096),
    name: z.string().max(256).optional(),
});
const AttachmentSchema = z.union([BinaryAttachmentSchema, FileRefAttachmentSchema]);
// -- Device info (optional in auth) --
const DeviceInfoSchema = z.object({
    deviceId: z.string().max(256).optional(),
    deviceName: z.string().max(256).optional(),
    deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']).optional(),
    platform: z.string().max(256).optional(),
}).passthrough();
// -- Individual message schemas --
export const AuthSchema = z.object({
    type: z.literal('auth'),
    token: z.string().max(512),
    protocolVersion: z.number().int().min(0).optional(),
    deviceInfo: DeviceInfoSchema.optional(),
    capabilities: z.array(z.string()).optional().catch([]).default([]),
}).passthrough();
export const PairSchema = z.object({
    type: z.literal('pair'),
    pairingId: z.string().min(1).max(256),
    protocolVersion: z.number().int().min(0).optional(),
    deviceInfo: DeviceInfoSchema.optional(),
    capabilities: z.array(z.string()).optional().catch([]).default([]),
}).passthrough();
// -- Pairing-approval primitive (#5510, epic #5509) --
//
// A camera-less device requests pairing without a QR/URL; the user approves it
// from a trusted surface (host dashboard/tray). `pair_request` is UNAUTHENTICATED
// — same exposure class as `pair` (handled pre-auth in ws-server.js, rate-limited
// + TTL'd + queue-capped server-side), so it is NOT part of ClientMessageSchema.
//
// `deviceName` is attacker-controlled — hard length cap (64) here so it cannot be
// used to inflate the pending-queue payload or any surface that renders it. It is
// treated as PLAIN TEXT everywhere (React escapes on render; never interpolated
// into a server log format).
export const PairRequestSchema = z.object({
    type: z.literal('pair_request'),
    // Free-text device label shown to the approver. Capped at 64 chars.
    deviceName: z.string().max(64).optional(),
    // Client-generated correlation id echoed on pair_request_pending / pair_result.
    requestId: z.string().min(1).max(128),
    protocolVersion: z.number().int().min(0).optional(),
}).passthrough();
// `pair_approve` / `pair_deny` — host-level authority ONLY (an unbound client;
// a session-bound pairing token is rejected, like host_status_request). These
// ARE part of ClientMessageSchema (post-auth). The verify code never travels
// from approver→server: the approver only confirms `requestId`, so the requester
// cannot influence the code by construction.
export const PairApproveSchema = z.object({
    type: z.literal('pair_approve'),
    requestId: z.string().min(1).max(128),
}).passthrough();
export const PairDenySchema = z.object({
    type: z.literal('pair_deny'),
    requestId: z.string().min(1).max(128),
}).passthrough();
export const InputSchema = z.object({
    type: z.literal('input'),
    data: z.string().max(100_000).optional(),
    attachments: z.array(AttachmentSchema).optional(),
    isVoice: z.boolean().optional(),
}).passthrough();
export const InterruptSchema = z.object({
    type: z.literal('interrupt'),
}).passthrough();
// #5270 (Control Room Phase 2a): cancel a single in-flight activity node
// (currently a Task subagent) by its activity-tree entry id. `sessionId` is
// optional — the server resolves the target session from it or the caller's
// bound/active session, mirroring `interrupt`. Whole-turn interruption stays on
// the `interrupt` message; this is the per-node control action.
export const CancelActivitySchema = z.object({
    type: z.literal('cancel_activity'),
    activityId: z.string().min(1).max(512),
    sessionId: z.string().max(256).optional(),
    // #5277: opaque client-generated correlation id echoed back on the
    // `cancel_activity_ack` (success) and the `CANCEL_ACTIVITY_FAILED`
    // session_error (failure), so the dashboard can tie a specific cancel click
    // to its outcome without inferring it from the terminal activity_delta.
    requestId: z.string().max(128).optional(),
}).passthrough();
export const SetModelSchema = z.object({
    type: z.literal('set_model'),
    model: z.string().max(256),
}).passthrough();
export const SetPermissionModeSchema = z.object({
    type: z.literal('set_permission_mode'),
    mode: z.enum(['approve', 'auto', 'plan', 'acceptEdits']),
    confirmed: z.boolean().optional(),
}).passthrough();
export const SetThinkingLevelSchema = z.object({
    type: z.literal('set_thinking_level'),
    level: z.enum(['default', 'high', 'max']),
    sessionId: z.string().max(256).optional(),
}).passthrough();
export const PermissionRuleSchema = z.object({
    tool: z.string().min(1).max(256),
    decision: z.enum(['allow', 'deny']),
});
// -- BYOK credentials (#4052) --
/**
 * Request the current BYOK credentials status. Server replies with a
 * byok_credentials_status server message containing the masked preview.
 */
export const ByokGetCredentialsStatusSchema = z.object({
    type: z.literal('byok_get_credentials_status'),
    requestId: z.string().max(128).optional(),
}).passthrough();
/**
 * Persist a new Anthropic API key to ~/.chroxy/credentials.json (mode 0600).
 * The server validates that the key starts with `sk-ant-`.
 */
export const ByokSetCredentialsSchema = z.object({
    type: z.literal('byok_set_credentials'),
    requestId: z.string().max(128).optional(),
    // No upper bound on key length — Anthropic key format may evolve. The
    // server's z.string() max in the persisted file is unbounded too.
    anthropicApiKey: z.string().min(1),
}).passthrough();
/**
 * Remove the credentials file. No-op if no file is present.
 */
export const ByokClearCredentialsSchema = z.object({
    type: z.literal('byok_clear_credentials'),
    requestId: z.string().max(128).optional(),
}).passthrough();
// -- Provider credentials (#3855) --
//
// Generalizes the single-key BYOK store above to every known provider
// credential env var (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN,
// GEMINI_API_KEY, OPENAI_API_KEY). The server's credential-store.js owns the
// canonical key list; these schemas only constrain the wire shape. All four
// sit behind the existing WS auth-token gate and the raw value is never echoed
// back — the server replies with the masked status only.
/**
 * Request the masked status for every known provider credential. Server replies
 * with a `credentials_status` server message.
 */
export const GetCredentialsStatusSchema = z.object({
    type: z.literal('get_credentials_status'),
    requestId: z.string().max(128).optional(),
}).passthrough();
/**
 * Persist a credential value. `key` must be one of the server's known
 * credential keys (validated server-side against credential-store.js); `value`
 * is the raw secret. No upper length bound — provider key formats evolve.
 */
export const SetCredentialSchema = z.object({
    type: z.literal('set_credential'),
    requestId: z.string().max(128).optional(),
    key: z.string().min(1).max(128),
    value: z.string().min(1),
}).passthrough();
/**
 * Remove a single stored credential. No-op if not present.
 */
export const DeleteCredentialSchema = z.object({
    type: z.literal('delete_credential'),
    requestId: z.string().max(128).optional(),
    key: z.string().min(1).max(128),
}).passthrough();
/**
 * Lightweight credential ping. Server resolves the value (env > store), makes a
 * minimal provider API call, and replies with `credential_test_result`.
 */
export const TestCredentialSchema = z.object({
    type: z.literal('test_credential'),
    requestId: z.string().max(128).optional(),
    key: z.string().min(1).max(128),
}).passthrough();
export const SetPermissionRulesSchema = z.object({
    type: z.literal('set_permission_rules'),
    rules: z.array(PermissionRuleSchema).max(1000),
    sessionId: z.string().max(256).optional(),
});
// #3185: per-session promptEvaluator toggle. Strict boolean — the server
// rejects anything else with a `session_error`. `sessionId` is optional;
// the handler falls back to the client's bound active session.
export const SetPromptEvaluatorSchema = z.object({
    type: z.literal('set_prompt_evaluator'),
    value: z.boolean(),
    sessionId: z.string().max(256).optional(),
});
// #3639: per-session promptEvaluatorSkipPattern (regex source string).
// Companion to SetPromptEvaluatorSchema — when the per-session toggle is
// on, this pattern is consulted BEFORE the server-wide
// `config.promptEvaluatorSkipPattern` (#3187) so different sessions can
// pick their own skip heuristics. `null` or empty string clears the
// override; the global default still applies. Wire-level cap at 1024
// chars so a malicious payload can't bloat session-state.json.
export const SetPromptEvaluatorSkipPatternSchema = z.object({
    type: z.literal('set_prompt_evaluator_skip_pattern'),
    value: z.union([z.string().max(1024), z.null()]),
    sessionId: z.string().max(256).optional(),
});
// #3805: per-session opt-in Chroxy context hint. When true, the server
// prepends a short paragraph to the system prompt telling the model it's
// running inside Chroxy so it can adjust output for mobile clients.
// Default OFF — only forwarded when an explicit boolean is sent.
// `sessionId` is optional; the handler falls back to the client's bound
// active session.
export const SetChroxyContextHintSchema = z.object({
    type: z.literal('set_chroxy_context_hint'),
    value: z.boolean(),
    sessionId: z.string().max(256).optional(),
});
// #4660: per-session user-authored preamble prepended to the system prompt
// every turn. Wire cap at 4096 — slightly above the server-side
// SESSION_PREAMBLE_MAX_LENGTH (4000) so a tiny ahead-of-server trim doesn't
// reject submissions; the server is the authoritative coercion site.
// `sessionId` is optional; the handler falls back to the client's bound
// active session. Empty string clears the preamble.
export const SetSessionPreambleSchema = z.object({
    type: z.literal('set_session_preamble'),
    value: z.string().max(4096),
    sessionId: z.string().max(256).optional(),
});
// #3209: runtime activate/deactivate of a manual skill. The skill name
// is the loader-resolved name (the file's basename without extension);
// the server validates it matches a real skill before mutating state.
// `sessionId` is optional — the handler falls back to the client's
// bound active session.
export const SkillActivateSchema = z.object({
    type: z.literal('skill_activate'),
    skillName: z.string().min(1).max(256),
    sessionId: z.string().max(256).optional(),
});
export const SkillDeactivateSchema = z.object({
    type: z.literal('skill_deactivate'),
    skillName: z.string().min(1).max(256),
    sessionId: z.string().max(256).optional(),
});
// #3235: re-trust a skill after a content-hash mismatch (skill_changed
// event). Operator confirms "yes, this is the new content I want" — the
// server calls SkillsTrustStore.acceptHash with the loaded body and
// flushes the ledger. `sessionId` is optional (falls back to the client's
// active session); `requestId` lets the dashboard correlate the broadcast
// `skill_trust_accepted` event to a specific user click.
export const SkillTrustAcceptSchema = z.object({
    type: z.literal('skill_trust_accept'),
    skillName: z.string().min(1).max(256),
    sessionId: z.string().max(256).optional(),
    requestId: z.string().max(256).optional(),
});
// #3297: grant community-skill first-activation trust. `author` is the
// subdirectory name under community/ (e.g. 'alice' for community/alice/).
// `scope` is reserved for future granularity (e.g. 'path' | 'author');
// currently both indexes (byAuthor + byPath) are always written.
export const SkillTrustGrantSchema = z.object({
    type: z.literal('skill_trust_grant'),
    skillName: z.string().min(1).max(256),
    author: z.string().min(1).max(256),
    scope: z.string().max(64).optional(),
    sessionId: z.string().max(256).optional(),
    requestId: z.string().max(256).optional(),
});
export const PermissionResponseSchema = z.object({
    type: z.literal('permission_response'),
    requestId: z.string().min(1).max(256),
    decision: z.enum(['allow', 'allowAlways', 'deny']),
});
export const QueryPermissionAuditSchema = z.object({
    type: z.literal('query_permission_audit'),
    sessionId: z.string().max(256).optional(),
    auditType: z.enum(['mode_change', 'decision']).optional(),
    since: z.number().optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
});
export const ListSessionsSchema = z.object({
    type: z.literal('list_sessions'),
});
export const SwitchSessionSchema = z.object({
    type: z.literal('switch_session'),
    sessionId: z.string().max(256),
});
// -- Sandbox settings schema (mirrors SDK SandboxSettings) --
// Exported for reuse by clients; nested objects use .passthrough() to avoid
// silently stripping fields added by newer SDK versions.
export const SandboxSchema = z.object({
    network: z.object({
        allowedDomains: z.array(z.string().max(256)).max(256).optional(),
    }).passthrough().optional(),
    filesystem: z.object({
        allowedPaths: z.array(z.string().max(4096)).max(256).optional(),
        deniedPaths: z.array(z.string().max(4096)).max(256).optional(),
    }).passthrough().optional(),
    bash: z.object({
        allowedCommands: z.array(z.string().max(256)).max(256).optional(),
    }).passthrough().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
}).passthrough();
export const CreateSessionSchema = z.object({
    type: z.literal('create_session'),
    name: z.string().max(200).optional(),
    cwd: z.string().max(4096).optional(),
    provider: z.string().max(256).optional(),
    model: z.string().max(256).optional(),
    permissionMode: z.enum(['approve', 'acceptEdits', 'auto', 'plan']).optional(),
    worktree: z.boolean().optional(),
    sandbox: SandboxSchema.optional(),
    isolation: z.enum(['none', 'worktree', 'sandbox', 'container']).optional(),
    environmentId: z.string().max(256).optional(),
    // #4208: opt-in to spawning the claude TUI with
    // `--dangerously-skip-permissions`. Only the `claude-tui` provider honours
    // this — other providers ignore it harmlessly. The dashboard surfaces it
    // as a TUI-only checkbox with explicit warning copy; the server still
    // applies the flag if a non-TUI provider request includes it (no-op).
    skipPermissions: z.boolean().optional(),
});
export const DestroySessionSchema = z.object({
    type: z.literal('destroy_session'),
    sessionId: z.string().max(256),
});
export const RenameSessionSchema = z.object({
    type: z.literal('rename_session'),
    sessionId: z.string().max(256),
    name: z.string().max(200),
});
export const RegisterPushTokenSchema = z.object({
    type: z.literal('register_push_token'),
    token: z.string().min(1).max(512),
});
// -- Notification preferences (#4541) --
//
// Foundation for user-controllable notification settings (parent #4349).
// Three layers persisted at ~/.chroxy/notification-prefs.json:
//   1. global category toggles (`categories` map, keyed by RATE_LIMITS keys
//      from `push.js`)
//   2. per-device overrides (`devices` keyed by push token)
//   3. quiet-hours window (parsed today, time-of-day enforcement deferred
//      to sub-issue #4544)
//
// The per-category toggle map is intentionally open-ended (z.record) so the
// wire shape doesn't need to be re-bumped each time a new push category
// lands in `push.js` RATE_LIMITS. The server's loader sanitises unknown
// keys at the storage boundary — see notification-prefs.js.
/** Inner shape of a global / per-device category toggle map. */
const NotificationCategoryMapSchema = z.record(z.string().min(1).max(64), z.boolean());
/**
 * Quiet-hours window (#4541 shape, extended in #4544).
 *
 * `null` clears the window; otherwise `start`/`end` are HH:MM and
 * `timezone` is an IANA zone string (e.g. `America/Los_Angeles`).
 *
 * The timezone is REQUIRED at the wire layer because the server-side
 * enforcer (`isInQuietHoursIn` in `notification-prefs.js`) refuses to
 * evaluate a window without one — a half-shape would silently fail-open
 * every notification, which is the worst possible failure mode for a
 * notification system. Clients should always pick a sensible default
 * (e.g. `Intl.DateTimeFormat().resolvedOptions().timeZone`).
 *
 * 64 chars is a generous ceiling for IANA zones — `America/Argentina/ComodRivadavia`
 * is the longest registered name at 33 chars.
 */
const NotificationQuietHoursSchema = z.union([
    z.null(),
    z.object({
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1).max(64),
    }),
]);
/**
 * Per-category bypass list (#4544). Categories named here fire even
 * during quiet hours. Defaults to `permission` + `activity_error` so
 * operator-blocking events don't get muted; the user can extend or
 * shrink the list (empty array = "nothing bypasses, not even errors").
 */
const NotificationBypassListSchema = z.array(z.string().min(1).max(64)).max(64);
/**
 * Per-device override entry (#4544 extended, #4587 added metadata).
 *
 * Per-device fields REPLACE the corresponding global value entirely:
 *   - `quietHours: null` opts the device out of muting even if global is set.
 *   - `bypassCategories: []` opts the device out of all bypasses even if
 *     global lists them.
 * See `notification-prefs.js` for the precedence rationale.
 *
 * #4587: `lastSeenAt` (epoch ms) is stamped by the server every time the
 * entry is patched or its push token re-registers. `platform`
 * (`ios`/`android`/`web`/`desktop`/`unknown` or a future value) is read
 * from the connecting client's `deviceInfo` during auth and persisted with
 * the entry. Both are optional on the wire so a pre-#4587 server snapshot
 * still validates cleanly; the dashboard + mobile per-device lists hide
 * the meta when absent.
 */
const NotificationDeviceEntrySchema = z.object({
    categories: NotificationCategoryMapSchema.optional(),
    quietHours: NotificationQuietHoursSchema.optional(),
    bypassCategories: NotificationBypassListSchema.optional(),
    lastSeenAt: z.number().int().positive().optional(),
    platform: z.string().min(1).max(32).optional(),
}).passthrough();
/**
 * Patch shape accepted by `notification_prefs_set`. Every top-level field
 * is optional — the server shallow-merges, so an inbound patch that only
 * mentions `categories.result` will not wipe `categories.permission`.
 *
 * The device map is bounded at 1000 entries to keep a malicious client
 * from bloating the on-disk file; in practice users have at most a
 * handful of devices.
 *
 * #4564: per-device entries also accept `null` as a sentinel meaning
 * "delete this device entry". The "Clear" buttons in Settings emit
 * `devices: { [token]: null }` to drain orphan entries left behind by
 * push-token refresh, app reinstall, or browser-storage wipe. Server-side
 * `setPrefs` interprets the null sentinel and removes the key from the
 * persisted devices map.
 */
export const NotificationPrefsPatchSchema = z.object({
    categories: NotificationCategoryMapSchema.optional(),
    devices: z.record(z.string().min(1).max(512), z.union([NotificationDeviceEntrySchema, z.null()]))
        .refine((obj) => Object.keys(obj).length <= 1000, { message: 'Too many device entries (max 1000)' })
        .optional(),
    quietHours: NotificationQuietHoursSchema.optional(),
    bypassCategories: NotificationBypassListSchema.optional(),
});
/**
 * Request the current notification preferences. Server replies with a
 * `notification_prefs` snapshot. `requestId` is optional for correlation.
 */
export const NotificationPrefsGetSchema = z.object({
    type: z.literal('notification_prefs_get'),
    requestId: z.string().max(128).optional(),
}).passthrough();
/**
 * Patch the notification preferences and re-emit the resulting snapshot.
 * The server shallow-merges over the existing prefs and persists the
 * merged result atomically (temp+rename) to ~/.chroxy/notification-prefs.json.
 */
export const NotificationPrefsSetSchema = z.object({
    type: z.literal('notification_prefs_set'),
    requestId: z.string().max(128).optional(),
    prefs: NotificationPrefsPatchSchema,
}).passthrough();
/**
 * #4735 / #4731 / #4621 — per-question answer wire format.
 *
 * `answers` is a map keyed by question text. Values are either:
 * - `string` — single-select label or a free-form ("Other"/text) answer
 * - `string[]` — multi-select labels (one entry per selected option)
 *
 * Pre-#4621 clients JSON-stringified multi-select arrays into a single
 * string so the wire shape `Record<string, string>` was preserved; the
 * widened union accepts the native array form so newer dashboard / app
 * builds can submit multi-select answers without the JSON envelope. The
 * server-side consumers (`PermissionManager.respondToQuestion`,
 * `ClaudeTuiSession.respondToQuestion`) already accept both shapes —
 * see `resolveQuestionDigits` in `claude-tui-session.js` for the TUI
 * path that handles the array variant directly.
 *
 * The server normalizes arrays to the SDK's canonical comma-separated
 * format inside `PermissionManager.respondToQuestion` (the SDK's
 * `AskUserQuestionOutput.answers` is typed `{ [questionText]: string }`
 * and the spec is explicit: "multi-select answers are comma-separated").
 * Older dashboards' JSON-stringified array payloads are unwrapped on the
 * same path, so all variants converge before reaching the SDK.
 *
 * Bounds:
 *   - Array max length: 100 entries per question (mirrors the per-answer-
 *     map cap; chroxy never sees forms past 4 options in practice, so
 *     this is a generous safety margin).
 *   - Per-array-entry char cap: 10_000. Multi-select values are option
 *     labels (short by construction) — capping at 10_000 chars keeps the
 *     per-answer worst case bounded at ~1MB without the legacy
 *     100_000-char cap on the string path, which exists to cover the
 *     JSON-stringified-array shape sent by pre-#4621 dashboards (and is
 *     itself bounded by the top-level CHROXY_MAX_PAYLOAD).
 */
const UserQuestionAnswerValueSchema = z.union([
    z.string().max(100_000),
    z.array(z.string().max(10_000)).max(100),
]);
export const UserQuestionResponseSchema = z.object({
    type: z.literal('user_question_response'),
    answer: z.string().max(100_000),
    answers: z.record(z.string(), UserQuestionAnswerValueSchema).refine((obj) => Object.keys(obj).length <= 100, { message: 'Too many answers (max 100)' }).optional(),
    toolUseId: z.string().max(256).optional(),
    // #4651 — single-question "Other" / freeform path. When set, the server
    // resolves the chosen option (`answer`) to its 1-indexed digit, writes
    // the digit to open claude TUI's text-input prompt, then writes
    // `freeformText` + Enter to submit. Mutually exclusive with `answers`
    // (multi-question forms are out of scope per #4648 / #4651).
    freeformText: z.string().max(100_000).optional(),
});
export const ListDirectorySchema = z.object({
    type: z.literal('list_directory'),
    path: z.string().max(4096).optional(),
});
export const BrowseFilesSchema = z.object({
    type: z.literal('browse_files'),
    path: z.string().max(4096).nullable().optional(),
}).passthrough();
export const ReadFileSchema = z.object({
    type: z.literal('read_file'),
    path: z.string().max(4096),
}).passthrough();
export const WriteFileSchema = z.object({
    type: z.literal('write_file'),
    path: z.string().max(4096),
    content: z.string().max(10_000_000),
}).passthrough();
export const ListFilesSchema = z.object({
    type: z.literal('list_files'),
    query: z.string().max(1000).optional(),
}).passthrough();
export const ListSlashCommandsSchema = z.object({
    type: z.literal('list_slash_commands'),
}).passthrough();
export const ListAgentsSchema = z.object({
    type: z.literal('list_agents'),
}).passthrough();
export const RequestFullHistorySchema = z.object({
    type: z.literal('request_full_history'),
    sessionId: z.string().max(256).optional(),
});
export const KeyExchangeSchema = z.object({
    type: z.literal('key_exchange'),
    publicKey: z.string().max(512),
    // base64-encoded 32-byte connection salt for per-connection key derivation.
    // REQUIRED as of the 2026-04-11 production readiness audit — without this
    // field the server would fall back to the raw DH shared key with nonce=0,
    // re-introducing the nonce-reuse-on-reconnect vulnerability fixed in
    // 1fa8eda5e. The server now rejects key_exchange messages that omit salt
    // with code KEY_EXCHANGE_SALT_REQUIRED.
    salt: z.string().max(512),
});
export const PingSchema = z.object({
    type: z.literal('ping'),
});
export const RequestSessionContextSchema = z.object({
    type: z.literal('request_session_context'),
    sessionId: z.string().max(256).optional(),
});
export const GetDiffSchema = z.object({
    type: z.literal('get_diff'),
}).passthrough();
export const GitStatusSchema = z.object({
    type: z.literal('git_status'),
}).passthrough();
export const GitBranchesSchema = z.object({
    type: z.literal('git_branches'),
}).passthrough();
export const GitStageSchema = z.object({
    type: z.literal('git_stage'),
    files: z.array(z.string().max(4096)).min(1),
}).passthrough();
export const GitUnstageSchema = z.object({
    type: z.literal('git_unstage'),
    files: z.array(z.string().max(4096)).min(1),
}).passthrough();
export const GitCommitSchema = z.object({
    type: z.literal('git_commit'),
    message: z.string().min(1).max(10_000),
}).passthrough();
export const ResumeBudgetSchema = z.object({
    type: z.literal('resume_budget'),
    sessionId: z.string().max(256).optional(),
});
export const ListCheckpointsSchema = z.object({
    type: z.literal('list_checkpoints'),
});
export const RestoreCheckpointSchema = z.object({
    type: z.literal('restore_checkpoint'),
    checkpointId: z.string().max(256),
});
export const CreateCheckpointSchema = z.object({
    type: z.literal('create_checkpoint'),
    name: z.string().max(256).optional(),
    description: z.string().max(1000).optional(),
});
export const DeleteCheckpointSchema = z.object({
    type: z.literal('delete_checkpoint'),
    checkpointId: z.string().max(256),
});
export const CloseDevPreviewSchema = z.object({
    type: z.literal('close_dev_preview'),
    port: z.number().int(),
    sessionId: z.string().max(256).optional(),
});
// -- Web task schemas --
export const LaunchWebTaskSchema = z.object({
    type: z.literal('launch_web_task'),
    prompt: z.string().min(1).max(10_000),
    cwd: z.string().max(4096).optional(),
});
export const ListWebTasksSchema = z.object({
    type: z.literal('list_web_tasks'),
});
export const TeleportWebTaskSchema = z.object({
    type: z.literal('teleport_web_task'),
    taskId: z.string().min(1).max(256),
});
// -- Conversation history schemas --
export const ListConversationsSchema = z.object({
    type: z.literal('list_conversations'),
});
export const ResumeConversationSchema = z.object({
    type: z.literal('resume_conversation'),
    conversationId: z.string().max(256),
    cwd: z.string().max(4096).optional(),
    name: z.string().max(200).optional(),
});
export const SearchConversationsSchema = z.object({
    type: z.literal('search_conversations'),
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().min(1).max(100).optional(),
});
export const RequestCostSummarySchema = z.object({
    type: z.literal('request_cost_summary'),
});
// -- Session subscription schemas --
export const SubscribeSessionsSchema = z.object({
    type: z.literal('subscribe_sessions'),
    sessionIds: z.array(z.string().max(256)).min(1).max(20),
});
export const UnsubscribeSessionsSchema = z.object({
    type: z.literal('unsubscribe_sessions'),
    sessionIds: z.array(z.string().max(256)).min(1).max(20),
});
// #3404: client signals foreground/background state. Mobile app sends
// {visible:false} on AppState background/inactive so the server stops
// treating its still-alive WS connection as an active viewer and lets
// completion push notifications fire.
export const ClientVisibleSchema = z.object({
    type: z.literal('client_visible'),
    visible: z.boolean(),
});
// -- Repo management schemas --
export const ListProvidersSchema = z.object({
    type: z.literal('list_providers'),
});
export const ListSkillsSchema = z.object({
    type: z.literal('list_skills'),
});
export const ListReposSchema = z.object({
    type: z.literal('list_repos'),
});
export const AddRepoSchema = z.object({
    type: z.literal('add_repo'),
    path: z.string().min(1).max(4096),
    name: z.string().max(256).optional(),
});
export const RemoveRepoSchema = z.object({
    type: z.literal('remove_repo'),
    path: z.string().min(1).max(4096),
});
// -- Extension message --
export const ExtensionMessageSchema = z.object({
    type: z.literal('extension_message'),
    provider: z.string().min(1).max(256),
    subtype: z.string().min(1).max(256),
    data: z.unknown(),
    sessionId: z.string().max(256).optional(),
});
// -- Environment management --
export const CreateEnvironmentSchema = z.object({
    type: z.literal('create_environment'),
    name: z.string().max(200),
    cwd: z.string().max(4096),
    image: z.string().max(256).optional(),
    memoryLimit: z.string().max(64).optional(),
    cpuLimit: z.string().max(64).optional(),
});
export const ListEnvironmentsSchema = z.object({
    type: z.literal('list_environments'),
});
export const DestroyEnvironmentSchema = z.object({
    type: z.literal('destroy_environment'),
    environmentId: z.string().max(256),
});
export const GetEnvironmentSchema = z.object({
    type: z.literal('get_environment'),
    environmentId: z.string().max(256),
});
// -- Prompt evaluator (#3068, manual on-demand variant) --
export const EvaluateDraftSchema = z.object({
    type: z.literal('evaluate_draft'),
    // The draft message the user is considering sending. Capped server-side
    // to ~50KB to bound model cost and message-pump throughput.
    draft: z.string().min(1).max(50_000),
    // Optional sessionId to scope the evaluator's contextual hints (e.g. cwd).
    // Falls back to the client's active session when omitted.
    sessionId: z.string().optional(),
    // Optional correlation id so the dashboard can match the result to the
    // specific Evaluate click that triggered it.
    requestId: z.string().max(128).optional(),
});
// #5171: Control Room v2 — request a Host/Repo Status survey. The server runs
// the survey across `config.repos ∪ auto-discovered repos under the configured
// root` and replies with a single `host_status_snapshot` (see server.ts). This
// is a pull (the Refresh button) — the snapshot is not pushed on a timer. The
// optional `requestId` lets the dashboard correlate a particular Refresh click
// to the snapshot it produced (same pattern as `evaluate_draft` above).
export const HostStatusRequestSchema = z.object({
    type: z.literal('host_status_request'),
    requestId: z.string().max(128).optional(),
});
// #5253: Control Room — request a self-hosted runner status survey. The server
// scans the runner-install root, probes each runner's service, optionally
// enriches via `gh`, and replies with a single `runner_status_snapshot` (see
// server.ts). Pull-on-Refresh, same as `host_status_request`. The optional
// `requestId` lets the dashboard correlate a Refresh click to its snapshot.
export const RunnerStatusRequestSchema = z.object({
    type: z.literal('runner_status_request'),
    requestId: z.string().max(128).optional(),
});
// #5499 (epic #5498): the dashboard's Control Room "Integrations" tab asks the
// server to survey integration status across the host's repos — repo-memory
// for this slice (config presence, cache stats, telemetry report); repo-relay
// is the follow-up (#5498 sub-issues). The server resolves the same repo set
// as `host_status_request` and replies with a single
// `integration_status_snapshot` (see server.ts). Pull-on-Refresh, same as the
// host and runner surveys. The optional `requestId` lets the dashboard
// correlate a Refresh click to its snapshot.
export const IntegrationStatusRequestSchema = z.object({
    type: z.literal('integration_status_request'),
    requestId: z.string().max(128).optional(),
});
// #5500 (epic #5498): a MUTATING Control Room integration action — the
// observe half of the tab is `integration_status_request`; this is the
// control half. Actions:
//   - `repo_memory_reindex` (#5500): runs `repo-memory index <repoRoot>`
//     host-side to prewarm/refresh the summary cache (no watcher exists —
//     the cache only refreshes on agent reads or an explicit index run).
//   - `repo_relay_rerun` (#5502): re-runs a FAILED repo-relay workflow run
//     via `gh run rerun <databaseId>`. Requires `runId` (server-enforced).
//
// Designed as an extensible envelope: `action` is a CLOSED enum so an
// unknown/mistyped action is rejected at the schema layer before it reaches
// the handler — no new message type per action. `repoPath` identifies the
// target repo; the server MUST validate it against the surveyed repo set
// before any exec (bearer-token-authority checklist) — the schema bound here
// is only a sanity cap, not the security boundary.
//
// Correlation contract clones `cancel_activity` (#5277): the optional
// client-generated `requestId` is echoed on the `integration_action_ack`
// (success) and the `INTEGRATION_ACTION_FAILED` session_error (failure), so
// the dashboard can tie a specific Reindex / Re-run click to its outcome.
export const IntegrationActionSchema = z.object({
    type: z.literal('integration_action'),
    action: z.enum(['repo_memory_reindex', 'repo_relay_rerun']),
    repoPath: z.string().min(1).max(4096),
    // #5502: the GitHub Actions run to re-run (the `databaseId` the
    // observability snapshot surfaced). Optional at the schema layer because
    // the envelope is shared across actions — the server validates it as
    // required-for-rerun, then RE-FETCHES the run list and only execs when the
    // id names a run it itself surfaced with conclusion 'failure' (the client
    // id is a lookup key, never a trusted exec target).
    runId: z.number().int().nonnegative().finite().optional(),
    requestId: z.string().max(128).optional(),
}).passthrough();
// -- Encrypted envelope --
export const EncryptedEnvelopeSchema = z.object({
    type: z.literal('encrypted'),
    d: z.string().max(10_000_000),
    n: z.number().int().nonnegative(),
});
// -- Discriminated union of all client->server message types --
// Note: auth, key_exchange, pair, ping, and encrypted are handled before
// the main switch in ws-server.js and are not included in this union.
export const ClientMessageSchema = z.discriminatedUnion('type', [
    InputSchema,
    InterruptSchema,
    CancelActivitySchema,
    SetModelSchema,
    SetPermissionModeSchema,
    SetThinkingLevelSchema,
    SetPermissionRulesSchema,
    SetPromptEvaluatorSchema,
    SetPromptEvaluatorSkipPatternSchema,
    SetChroxyContextHintSchema,
    SetSessionPreambleSchema,
    SkillActivateSchema,
    SkillDeactivateSchema,
    SkillTrustAcceptSchema,
    SkillTrustGrantSchema,
    PermissionResponseSchema,
    ListSessionsSchema,
    SwitchSessionSchema,
    CreateSessionSchema,
    DestroySessionSchema,
    RenameSessionSchema,
    RegisterPushTokenSchema,
    NotificationPrefsGetSchema,
    NotificationPrefsSetSchema,
    UserQuestionResponseSchema,
    ListDirectorySchema,
    BrowseFilesSchema,
    ReadFileSchema,
    WriteFileSchema,
    ListFilesSchema,
    ListSlashCommandsSchema,
    ListAgentsSchema,
    RequestFullHistorySchema,
    RequestSessionContextSchema,
    GetDiffSchema,
    GitStatusSchema,
    GitBranchesSchema,
    GitStageSchema,
    GitUnstageSchema,
    GitCommitSchema,
    ResumeBudgetSchema,
    ListCheckpointsSchema,
    RestoreCheckpointSchema,
    CreateCheckpointSchema,
    DeleteCheckpointSchema,
    CloseDevPreviewSchema,
    LaunchWebTaskSchema,
    ListWebTasksSchema,
    TeleportWebTaskSchema,
    ListConversationsSchema,
    ResumeConversationSchema,
    SearchConversationsSchema,
    RequestCostSummarySchema,
    SubscribeSessionsSchema,
    UnsubscribeSessionsSchema,
    ClientVisibleSchema,
    ListProvidersSchema,
    ByokGetCredentialsStatusSchema,
    ByokSetCredentialsSchema,
    ByokClearCredentialsSchema,
    GetCredentialsStatusSchema,
    SetCredentialSchema,
    DeleteCredentialSchema,
    TestCredentialSchema,
    ListSkillsSchema,
    ListReposSchema,
    AddRepoSchema,
    RemoveRepoSchema,
    QueryPermissionAuditSchema,
    ExtensionMessageSchema,
    CreateEnvironmentSchema,
    ListEnvironmentsSchema,
    DestroyEnvironmentSchema,
    GetEnvironmentSchema,
    EvaluateDraftSchema,
    HostStatusRequestSchema,
    RunnerStatusRequestSchema,
    IntegrationStatusRequestSchema,
    IntegrationActionSchema,
    PairApproveSchema,
    PairDenySchema,
]);
