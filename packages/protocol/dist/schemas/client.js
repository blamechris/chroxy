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
export const InputSchema = z.object({
    type: z.literal('input'),
    data: z.string().max(100_000).optional(),
    attachments: z.array(AttachmentSchema).optional(),
    isVoice: z.boolean().optional(),
}).passthrough();
export const InterruptSchema = z.object({
    type: z.literal('interrupt'),
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
 * #4621 — `answers` values are widened to `string | string[]` so the
 * multi-question form (#4604 Chunk B) can ship native arrays for
 * `multiSelect: true` questions instead of JSON-stringifying them.
 * The legacy JSON-encoded string shape is still accepted for back-compat
 * with in-flight payloads during deploy and with older dashboards that
 * haven't picked up the new wire shape. Array values are capped at 100
 * entries (mirroring the per-answer-map cap) to bound parse cost.
 */
export const UserQuestionResponseSchema = z.object({
    type: z.literal('user_question_response'),
    answer: z.string().max(100_000),
    answers: z.record(z.string(), z.union([
        z.string().max(100_000),
        z.array(z.string().max(100_000)).max(100),
    ])).refine((obj) => Object.keys(obj).length <= 100, { message: 'Too many answers (max 100)' }).optional(),
    toolUseId: z.string().max(256).optional(),
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
]);
