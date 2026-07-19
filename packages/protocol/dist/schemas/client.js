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
    // Bounded to stop an adversarial auth/pair from sending a giant capabilities
    // array (the server does `new Set(authData.capabilities)` with no count guard,
    // so a huge array is a CPU/memory DoS at Set construction). Feature-flag list —
    // 64 entries × 256 chars is far above any real client.
    capabilities: z.array(z.string().max(256)).max(64).optional().catch([]).default([]),
    // #5555 (eager key exchange) — optional ephemeral X25519 public key + salt
    // sent WITH the auth message so the server can derive the shared key and
    // return its public key in auth_ok, collapsing the discrete `key_exchange`
    // round trip. Field shapes mirror KeyExchangeSchema's `publicKey` / `salt`
    // (same base64 size cap, same per-connection salt semantics) — the eager
    // path is cryptographically identical to the discrete one, only the
    // transport timing differs. Both fields are optional and only honoured
    // together: old clients omit them and the server falls back to the discrete
    // `key_exchange`; a new client talking to an old server gets no
    // `serverPublicKey` in auth_ok and falls back the same way. No flag day.
    eagerPublicKey: z.string().max(512).optional(),
    eagerSalt: z.string().max(512).optional(),
    // #5555.3 (lastSeq delta replay) — optional per-session history cursor map
    // ({ [sessionId]: lastSeq }). On reconnect the client sends the highest
    // `historySeq` it has applied for each session it has cached, so the server
    // replays ONLY entries newer than that cursor instead of the full ring
    // buffer. Old clients omit the field and get the full replay unchanged; a
    // new client talking to an old server gets a full replay too (the server
    // ignores the field). The server falls back to a full replay (flagged with
    // `fullHistory: true` on `history_replay_start`) whenever it cannot honour a
    // cursor — history trimmed past it, unknown session, or a server restart
    // reset the seqs. `seq` is a non-negative finite int; an INVALID value
    // rejects the auth (#5555.3 — this contract predates the size cap and must
    // hold). The `.refine` also rejects an absurdly large map (>256 keys): a
    // legit client sends at most MAX_CLIENT_HISTORY_CURSORS (64), and the server
    // independently caps the honoured keys, so a fat map can't bloat the replay
    // path. No `.catch` here — unlike `capabilities` (graceful by design), this
    // field rejects malformed input rather than silently degrading it.
    historyCursors: z.record(z.string().max(256), z.number().int().nonnegative()).refine((m) => Object.keys(m).length <= 256, { message: 'too many history cursors (max 256)' }).optional(),
}).passthrough();
export const PairSchema = z.object({
    type: z.literal('pair'),
    pairingId: z.string().min(1).max(256),
    protocolVersion: z.number().int().min(0).optional(),
    deviceInfo: DeviceInfoSchema.optional(),
    // Bounded to stop an adversarial auth/pair from sending a giant capabilities
    // array (the server does `new Set(authData.capabilities)` with no count guard,
    // so a huge array is a CPU/memory DoS at Set construction). Feature-flag list —
    // 64 entries × 256 chars is far above any real client.
    capabilities: z.array(z.string().max(256)).max(64).optional().catch([]).default([]),
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
// #5943 (epic #5935): cancel a SINGLE queued send-while-busy follow-up by its
// `clientMessageId`, removing it from the server's per-session outgoing queue
// (`base-session.js` `_outgoingQueue`) before it flushes. The server emits
// `message_dequeued { reason: 'cancelled' }` so every client removes the queued
// bubble. Authority mirrors `interrupt` — acting on your OWN bound/active
// session, not a privilege escalation — so the server resolves the target from
// `sessionId` or the caller's binding. Whole-queue cancellation stays on
// `interrupt`; this is the per-item control action (the queue analogue of
// `cancel_activity`).
export const CancelQueuedSchema = z.object({
    type: z.literal('cancel_queued'),
    // Identifies the queued entry to drop: the client-generated message id the
    // entry was enqueued under (the server's resolved `messageId`, echoed as
    // `clientMessageId` on `message_queued` / `message_dequeued`). Same 128-char
    // cap the server applies to that id.
    clientMessageId: z.string().min(1).max(128),
    sessionId: z.string().max(256).optional(),
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
    // #6803 — OPTIONAL path/glob SCOPE. When present, the rule only matches a
    // tool call whose target path(s) resolve UNDER this scope (a directory prefix
    // like `src/`, or a glob like `src/**/*.ts`). ABSENT → the rule matches every
    // path exactly as before (unscoped, no behaviour change). This lets a user
    // express "allow Write under src/ only" instead of an attractive-but-blunt
    // all-paths `allow Write`. The server (permission-manager._ruleScopeMatches)
    // resolves the scope against the session cwd; a scoped rule for a tool whose
    // input carries no concrete path never matches (falls through to a prompt).
    // #6873 review — reject a whitespace-only scope via `.refine` (NOT `.catch`,
    // the #6436 swallow trap) so the wire contract matches the server's
    // `!rule.path.trim()` guard rather than admitting a useless blank scope.
    path: z.string().min(1).max(1024).refine((s) => s.trim().length > 0, {
        message: 'path scope must not be whitespace-only',
    }).optional(),
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
    // #6771: optional durable per-project rule set. When present it FULLY REPLACES
    // the persisted "always allow / deny" rules for the target session's project
    // cwd (the client "manage / remove persistent rule" path — send the reduced
    // list to drop one). Absent → session rules only, unchanged behaviour.
    projectRules: z.array(PermissionRuleSchema).max(1000).optional(),
    sessionId: z.string().max(256).optional(),
});
// #6824: per-server MCP enable/disable. Runtime, per-session toggle of an
// ALREADY-CONFIGURED MCP server (not add/remove — that mutates ~/.claude.json
// and is a separate follow-up). `enabled: false` parks the server's fleet
// client (its tools/prompts/resources vanish from the next turn and it stops
// respawning); `enabled: true` restarts it through the same trust gate
// (already-trusted servers reconnect silently). Only BYOK-lane providers run
// an in-daemon MCP fleet, so the server rejects this on other providers with
// an `MCP_SERVER_TOGGLE_UNSUPPORTED` capability error. `requestId` (optional)
// echoes back on rejection so a client can roll back its optimistic toggle.
// `sessionId` is optional; the handler falls back to the client's bound
// active session — and a pairing-bound token may only target its own session.
export const SetMcpServerEnabledSchema = z.object({
    type: z.literal('set_mcp_server_enabled'),
    server: z.string().min(1).max(256),
    enabled: z.boolean(),
    sessionId: z.string().max(256).optional(),
    requestId: z.string().max(256).optional(),
});
// #6822: submit a pasted OAuth authorization code for a remote MCP server that
// reported `status: 'oauth-required'`. The daemon holds the PKCE verifier +
// state server-side; the user completed consent in a browser on THEIR device
// and pastes back the code (the universal fallback when the daemon's loopback
// callback isn't reachable from a remote/tunneled browser). The daemon redeems
// the code, persists the tokens encrypted at rest, and reconnects the server
// authenticated — then re-emits `mcp_servers` so all clients converge. Only the
// BYOK lane runs an in-daemon MCP fleet, so other providers reject this with an
// `MCP_AUTH_UNSUPPORTED` capability error. `requestId` (optional) echoes back on
// rejection. `sessionId` is optional; the handler falls back to the client's
// bound active session — and a pairing-bound token may only target its own
// session (the same own-session gate as `set_mcp_server_enabled`). The `code`
// is a short-lived one-time authorization code, never logged.
export const SubmitMcpAuthCodeSchema = z.object({
    type: z.literal('submit_mcp_auth_code'),
    server: z.string().min(1).max(256),
    code: z.string().min(1).max(4096),
    sessionId: z.string().max(256).optional(),
    requestId: z.string().max(256).optional(),
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
    // #6543 (IDE P3 feature B): optional per-hunk-review edits for an `allow` —
    // a client that reviewed the agent's proposed Write/Edit and dropped some
    // hunks sends the reduced CONTENT here. The server merges ONLY the whitelisted
    // content field(s) per tool (Write→content, Edit→new_string) and NEVER the
    // path/anchor fields, so an edit can narrow the write but can't redirect where
    // it lands. Ignored on deny, and for tools with no editable content field. A
    // loose object — the server-side whitelist (permission-manager.js) is the
    // enforcement point.
    editedInput: z.record(z.string(), z.unknown()).optional(),
});
// #6543 (IDE P3 feature B): pull the FULL secret-redacted tool input for a
// pending permission, so a client can build a per-hunk pre-write diff. The
// `permission_request` broadcast truncates `input` (~10K, secret-safe); this
// fetches the un-truncated (still redacted) version by requestId. Session-bound:
// the server only returns input for a permission the client's session owns. The
// reply is a single `permission_input` (see server.ts).
export const GetPermissionInputSchema = z.object({
    type: z.literal('get_permission_input'),
    requestId: z.string().min(1).max(256),
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
    // #6638: per-session Codex sandbox mode (codex provider only; ignored by
    // others). Overrides the server-wide CHROXY_CODEX_SANDBOX / the default.
    codexSandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    isolation: z.enum(['none', 'worktree', 'sandbox', 'container']).optional(),
    environmentId: z.string().max(256).optional(),
    // #4208: opt-in to spawning the claude TUI with
    // `--dangerously-skip-permissions`. Only the `claude-tui` provider honours
    // this — other providers ignore it harmlessly. The dashboard surfaces it
    // as a TUI-only checkbox with explicit warning copy; the server still
    // applies the flag if a non-TUI provider request includes it (no-op).
    skipPermissions: z.boolean().optional(),
    // Mailbox (agent-to-agent) — optional mailbox identity (AGENT_COMM_ID) to
    // register for this session at creation, so the daemon's mailbox
    // live-interrupt route (POST /api/mailbox) can resolve agent -> session
    // WITHOUT a separate POST /api/mailbox/register round-trip. Omitted for
    // sessions that don't participate in the mailbox. Same 200-char bound as the
    // route's field sanitiser; control chars are rejected server-side.
    agentCommId: z.string().max(200).optional(),
});
export const DestroySessionSchema = z.object({
    type: z.literal('destroy_session'),
    sessionId: z.string().max(256),
    // #5710 — force escape hatch: bypass the #5695 "is running" guard to delete a
    // wedged session whose `isRunning` is stuck true (a crashed provider that never
    // emits turn-end, or a leaked background-shell tracker entry). The client gates
    // this behind an explicit "delete anyway?" confirm. Omitted/false = the normal
    // guarded path.
    force: z.boolean().optional(),
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
    // #6502 — optional monotonic request nonce. The server echoes it back on the
    // `file_content` reply so the dashboard can correlate replies to the latest
    // in-flight request (path-agnostic), instead of relying on path tail-matching.
    requestId: z.string().max(200).optional(),
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
// #6471 (epic #6469): request the workspace symbol table (regex-parsed
// server-side). `path` optionally scopes the scan to a single file or directory
// within the session workspace; omitted ⇒ the whole (bounded) workspace.
// Gated behind the opt-in `features.ide` flag — handled only when enabled.
export const ListSymbolsSchema = z.object({
    type: z.literal('list_symbols'),
    path: z.string().max(4096).optional(),
    sessionId: z.string().max(256).optional(),
}).passthrough();
// #6475 (epic #6469): resolve a clicked symbol NAME to its declaration for
// go-to-definition (server → `symbol_location`). `file` is the file the click
// came from — used only to break ranking ties, so a local helper resolves in
// place while an imported symbol jumps to its exported definition. Gated behind
// the opt-in `features.ide` flag — handled only when enabled.
export const ResolveSymbolSchema = z.object({
    type: z.literal('resolve_symbol'),
    symbol: z.string().min(1).max(256),
    file: z.string().max(4096).optional(),
    sessionId: z.string().max(256).optional(),
}).passthrough();
// #6474 (epic #6469): find-in-project content grep (server → `code_search_results`).
// `query` is the case-insensitive needle (2+ chars); `path` optionally scopes the
// search to a sub-dir/file. Gated behind the opt-in `features.ide` flag.
export const SearchContentSchema = z.object({
    type: z.literal('search_content'),
    query: z.string().min(1).max(1024),
    path: z.string().max(4096).optional(),
    sessionId: z.string().max(256).optional(),
}).passthrough();
// #6477 (epic #6469): find-all-references (server → `references_result`). Whole-
// word, case-sensitive grep for a symbol name (alt/option+click a token in the
// file viewer; cmd/ctrl+click is go-to-definition). `file` is the originating file
// (accepted for symmetry). Gated behind the opt-in `features.ide` flag.
export const FindReferencesSchema = z.object({
    type: z.literal('find_references'),
    symbol: z.string().min(1).max(256),
    file: z.string().max(4096).optional(),
    sessionId: z.string().max(256).optional(),
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
    // #5752: opaque client-generated correlation id echoed back on the
    // `budget_resume_ack`, so a client can tie a specific Resume click to its
    // outcome. Capped at 128 inbound (single enforcement point) so the echoed
    // ack always satisfies ServerBudgetResumeAckSchema — clones the
    // `cancel_activity` correlation contract (#5277).
    requestId: z.string().max(128).optional(),
}).passthrough();
export const ListCheckpointsSchema = z.object({
    type: z.literal('list_checkpoints'),
});
export const RestoreCheckpointSchema = z.object({
    type: z.literal('restore_checkpoint'),
    checkpointId: z.string().max(256),
    // #6767: selective restore. 'files' reverts only the working tree (current
    // session/conversation continue — no new session); 'conversation' branches
    // the conversation at the checkpoint (working tree untouched — fork-capable
    // providers only, else rejected); 'both' (default, and the pre-#6767
    // behaviour) does both. Optional so older clients that omit it get 'both'.
    mode: z.enum(['files', 'conversation', 'both']).optional(),
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
// #5835 Phase 1: opt in / out of LIVE TERMINAL output (the claude-tui PTY
// remote-viewer mirror) for one session. Kept separate from subscribe_sessions
// so a client viewing the Chat tab doesn't receive a session's raw PTY bytes —
// only a client that opted into its terminal does. One message carries one
// sessionId; the server tracks opt-ins as a SET, so a client may hold more than
// one (the typical client opts into exactly the terminal it's viewing and opts
// out on leave). Pair each subscribe with an unsubscribe.
export const TerminalSubscribeSchema = z.object({
    type: z.literal('terminal_subscribe'),
    sessionId: z.string().max(256),
});
export const TerminalUnsubscribeSchema = z.object({
    type: z.literal('terminal_unsubscribe'),
    sessionId: z.string().max(256),
});
// #5835 Phase 2: request a resize of a session's live PTY (the claude-tui
// remote-viewer mirror). A client whose Output pane is larger than the default
// grid asks the server to resize the real TUI so it uses the available space.
// The PTY has ONE size: the server applies this only for the session's primary
// owner (or an unclaimed session) — observers ride along and re-letterbox to
// the authoritative `terminal_size` the server broadcasts back. cols/rows are
// clamped server-side; the bounds here just reject obviously-bogus frames early.
export const TerminalResizeSchema = z.object({
    type: z.literal('terminal_resize'),
    sessionId: z.string().max(256),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
});
// #5835 Phase 3: raw keystroke forwarding to a session's live PTY — true remote
// control (the mirror becomes interactive). `data` is opaque terminal bytes (a
// keypress, an escape sequence, or a bracketed-paste chunk) written verbatim to
// the PTY. Authority mirrors `input`: a pairing-bound token may only drive its
// bound session, and the server's primary-ownership gate keeps a single driver
// (an observer's keystroke is rejected with input_conflict). The 100k cap bounds
// a single message (a keystroke is a few bytes; the ceiling covers a paste).
export const TerminalInputSchema = z.object({
    type: z.literal('terminal_input'),
    sessionId: z.string().max(256),
    data: z.string().max(100000),
});
// #6313: request a fresh repaint of a session's live PTY mirror. The mirror
// streams raw coalesced ANSI bytes with no replay, so a WS-backpressure-dropped
// `terminal_output` frame silently desyncs the xterm grid — and since the mirror
// is interactive (#5835 Phase 3) keystrokes then land at the wrong cursor. A
// client asks for a resync on (re)subscribe and via a manual "refresh" affordance;
// the server forces the PTY to redraw (a SIGWINCH grid size-toggle). Authority
// mirrors terminal_resize: a session viewer, primary-owner gated, and (for a
// user-shell) primary-token gated.
export const TerminalResyncSchema = z.object({
    type: z.literal('terminal_resync'),
    sessionId: z.string().max(256),
});
// #3404: client signals foreground/background state. Mobile app sends
// {visible:false} on AppState background/inactive so the server stops
// treating its still-alive WS connection as an active viewer and lets
// completion push notifications fire.
export const ClientVisibleSchema = z.object({
    type: z.literal('client_visible'),
    visible: z.boolean(),
});
// #5563 (blocker for #5281 shared-session join): explicit primary-ownership
// claim / hand-off. Without `force`, the claim succeeds only if the session is
// unclaimed (or the client is already primary) — a claim against a session
// another client owns is rejected (observe-only). With `force: true` it is an
// operator-driven hand-off / take-over that overrides the current owner. The
// server replies with `session_role` (granted) or a `session_error` of
// category `input_conflict` (rejected). Additive: a client that never sends
// this keeps today's first-input-adopts-primary behaviour.
export const ClaimPrimarySchema = z.object({
    type: z.literal('claim_primary'),
    sessionId: z.string().max(256),
    force: z.boolean().optional(),
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
// #5553: per-repo session presets — two channels configured per repo, both
// optional: a PREAMBLE auto-folded into `sessionPreamble` at create time
// (model-facing, every turn) and a SEED staged editable into the composer
// (operator-facing, once). Sourced from `.chroxy/session.json` (walk-up) with a
// daemon-side override map in `~/.chroxy/config.json` (daemon entry wins).
// Repo-local presets are TRUST-GATED — inert until the operator approves the
// content hash. The four messages below are HOST-AUTHORITY (server rejects a
// session-bound pairing client): they read/write the host-wide preset config.
//
// `cwd` is the repo path; the server walks up + applies the daemon-override
// precedence + the trust gate (the same resolution createSession uses). The
// optional `requestId` correlates a UI action to its `session_preset_snapshot`
// reply (see server.ts), mirroring the integration-action correlation contract.
// Read the resolved preset for a repo path (the per-repo drawer's load).
export const SessionPresetGetSchema = z.object({
    type: z.literal('session_preset_get'),
    cwd: z.string().min(1).max(4096),
    requestId: z.string().max(128).optional(),
});
// Write (or clear) the DAEMON-side override for a repo path. A daemon override
// is pre-trusted (the operator wrote it). `preset: null` clears the override.
// The server validates/coerces the preset to the canonical shape before
// persisting; oversized fields are capped at write time, never at run time.
export const SessionPresetSetSchema = z.object({
    type: z.literal('session_preset_set'),
    cwd: z.string().min(1).max(4096),
    preset: z
        .object({
        preamble: z.string().max(8192).optional(),
        seed: z.string().max(16384).optional(),
        enabled: z.boolean().optional(),
    })
        .nullable(),
    requestId: z.string().max(128).optional(),
});
// Approve the CURRENT content hash of a repo-local preset so it becomes
// trusted + active for future sessions. The server re-resolves to obtain the
// live hash (a stale client value can't pin a different version).
export const SessionPresetApproveSchema = z.object({
    type: z.literal('session_preset_approve'),
    cwd: z.string().min(1).max(4096),
    requestId: z.string().max(128).optional(),
});
// Revoke trust for a repo-local preset so it goes inert (pending) again.
export const SessionPresetRevokeSchema = z.object({
    type: z.literal('session_preset_revoke'),
    cwd: z.string().min(1).max(4096),
    requestId: z.string().max(128).optional(),
});
// -- Token revoke (operator panic button, #6006) --
// Primary-token-only request to immediately REVOKE the current API token: the
// server kills the old token (no grace), severs every live user-shell session,
// and forces every connection to re-authenticate with the new token (obtained
// out-of-band). Distinct from scheduled rotation. Gated server-side on
// `client.isPrimaryToken === true` — a paired/pairing client cannot revoke.
export const RevokeTokenSchema = z.object({
    type: z.literal('revoke_token'),
    requestId: z.string().max(128).optional(),
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
// Mailbox (#5914 follow-up): the Control Room "Mailbox" tab asks the server for
// a point-in-time mailbox snapshot — the live agentCommId → session
// registrations plus a bounded ring buffer of recent live-interrupt deliveries.
// Host-level survey (a session-bound token is rejected, like
// `host_status_request`). Pull-on-Refresh; the reply is a single
// `mailbox_status_snapshot` (see server.ts). The optional `requestId` lets the
// dashboard correlate a Refresh click to its snapshot.
export const MailboxStatusRequestSchema = z.object({
    type: z.literal('mailbox_status_request'),
    requestId: z.string().max(128).optional(),
});
// #5969 (epic #5422 phase 4): Control Room mission control — request a
// point-in-time snapshot of the LIVE external Claude Code sessions the daemon
// learned about via `POST /api/events` (sessions it did NOT launch). Host-level
// survey (a session-bound token is rejected, like `host_status_request`).
// Pull-on-open; the reply is a single `external_sessions_snapshot` (see
// server.ts). The optional `requestId` lets the dashboard correlate the reply.
export const ExternalSessionsRequestSchema = z.object({
    type: z.literal('external_sessions_request'),
    requestId: z.string().max(128).optional(),
});
// #5966 (epic #5422 phase 5): Control Room — request a point-in-time snapshot of
// the GitHub-webhook repo events the daemon buffers in its bounded RepoEventStore
// (#6468). Host-level survey (a session-bound token is rejected, like
// `host_status_request`). Pull-on-open / Refresh; the reply is a single
// `repo_events_snapshot` (see server.ts). The optional `requestId` lets the
// dashboard correlate the reply.
export const RepoEventsRequestSchema = z.object({
    type: z.literal('repo_events_request'),
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
// #6133 (epic #5530): Control Room — request a survey of the chroxy-managed
// containers & environments (Docker / Compose, and k8s/rancher as they're
// validated). The server enumerates the EnvironmentManager's records, enriches
// running containers with a best-effort `docker stats` snapshot, and replies
// with a single `containers_status_snapshot` (see server.ts). Pull-on-Refresh,
// same as the host/runner/integration surveys. The optional `requestId` lets the
// dashboard correlate a Refresh click to its snapshot.
export const ContainersStatusRequestSchema = z.object({
    type: z.literal('containers_status_request'),
    requestId: z.string().max(128).optional(),
});
// #6139 (epic #5530): the dashboard's Control Room "Repo Runtime Config" tab
// asks the server to survey, per managed repo, what governs its container
// runtimes (devcontainer/compose config presence, the image it would run + the
// allowlist verdict) plus host-level defaults (effective backend, isolation
// order, effective image allowlist). Read-only — the server resolves the same
// repo set as host_status_request and replies with one
// repo_runtime_config_snapshot (see server.ts). Pull-on-Refresh, like the
// sibling surveys. The optional requestId lets the dashboard correlate the
// reply to a Refresh click.
export const RepoRuntimeConfigRequestSchema = z.object({
    type: z.literal('repo_runtime_config_request'),
    requestId: z.string().max(128).optional(),
});
// #6135 (epic #5530): the dashboard's Control Room "BYOK pool" surface asks the
// server for the docker-byok warm-container pool stats — whether it's enabled,
// its configured bounds, and the live rolling stats (hits/misses/evictions + the
// per-key warm buckets). Read-only — the server replies with one
// byok_pool_status_snapshot (see server.ts). Pull-on-Refresh, like the sibling
// surveys. The optional requestId lets the dashboard correlate the reply.
export const ByokPoolStatusRequestSchema = z.object({
    type: z.literal('byok_pool_status_request'),
    requestId: z.string().max(128).optional(),
});
// #6140 (epic #5530): the Control Room "Host prune" tab asks the server to
// survey reclaimable, chroxy-scoped, orphan-only host docker pressure (stopped
// chroxy-env-* containers + chroxy snapshot images NOT tracked by a live env).
// The server replies with a single host_prune_status_snapshot (see server.ts).
// Pull-on-Refresh, like the sibling surveys.
export const HostPruneStatusRequestSchema = z.object({
    type: z.literal('host_prune_status_request'),
    requestId: z.string().max(128).optional(),
});
// #6136 (epic #5530): the Control Room "Device runtimes" tab asks the server to
// survey iOS simulators (`xcrun simctl list devices`) + the "Ready for Maestro"
// verdict. The server replies with a single simulator_status_snapshot (see
// server.ts). Off macOS / no xcrun → a first-class available:false snapshot.
export const SimulatorStatusRequestSchema = z.object({
    type: z.literal('simulator_status_request'),
    requestId: z.string().max(128).optional(),
});
// #6137 (epic #5530): the same Control Room "Device runtimes" tab also asks the
// server to survey Android emulators (`emulator -list-avds` + `adb devices`) +
// the "Ready for Maestro" verdict. The server replies with a single
// emulator_status_snapshot (see server.ts). No Android SDK → first-class
// available:false snapshot.
export const EmulatorStatusRequestSchema = z.object({
    type: z.literal('emulator_status_request'),
    requestId: z.string().max(128).optional(),
});
// #6138 (epic #5530): the same Control Room "Device runtimes" tab also asks the
// server to survey WSL2 distros (`wsl.exe -l -v`) on Windows hosts. The server
// replies with a single wsl_status_snapshot (see server.ts). Off Windows / no
// wsl.exe → a first-class available:false snapshot.
export const WslStatusRequestSchema = z.object({
    type: z.literal('wsl_status_request'),
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
// #5554 (epic #5159): the dashboard's Control Room "Skills" tab asks the server
// for an inventory of installed chroxy skills — the global `~/.chroxy/skills/`
// tier plus the per-repo `.chroxy/skills/` overlays for the surveyed repos, with
// descriptions, trust state, content hashes, install dates, and per-skill usage
// history (last used / count / repos). The server scans on request only (NOT in
// the periodic survey — overlay scans are too costly to run on the survey
// cadence) and replies with a single `skills_inventory_snapshot` (see
// server.ts). Pull-on-Refresh, same host-level authority as the host / runner /
// integration surveys. The optional `requestId` lets the dashboard correlate a
// Refresh click to its snapshot.
export const SkillsInventoryRequestSchema = z.object({
    type: z.literal('skills_inventory_request'),
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
// #6134 (epic #5530): a lifecycle action on a chroxy-managed container /
// environment surfaced by the containers survey (#6133). `environmentId` is the
// EnvironmentManager id — the server validates it against its OWN survey (the id
// must name a live environment) before acting, so the client id is a lookup key,
// never a trusted target. `destroy` is destructive (the UI requires a
// confirmation). The optional `requestId` is echoed on the
// `containers_action_ack` (success) and the `CONTAINER_ACTION_FAILED`
// session_error (failure), mirroring the integration_action correlation contract.
export const ContainersActionSchema = z.object({
    type: z.literal('containers_action'),
    action: z.enum(['stop', 'restart', 'destroy']),
    environmentId: z.string().min(1).max(256),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #6135 slice 2 (epic #5530) — BYOK warm-container pool mutating action. Host
// authority (a session-bound token cannot run host actions, enforced server
// side). Three actions, all bounded by the pool's OWN state / operator config:
//   - 'drain'   — evict every idle pooled container across all keys.
//   - 'recycle' — evict idle containers for ONE resource-shape key; the key is
//     validated against the pool's live survey (`inspect()`), never trusted as
//     a path — an unknown key is rejected.
//   - 'resize'  — set runtime per-key / total caps, each clamped server-side to
//     `[1, the operator-configured ceiling]` (resize can only TIGHTEN, never
//     raise host limits). At least one of maxPerKey / maxTotal is required.
// The optional `requestId` is echoed on the `byok_pool_action_ack` (success)
// and the BYOK_POOL_ACTION_FAILED session_error (failure), mirroring the
// containers_action correlation contract. Destructive (drain/recycle evict warm
// containers) — the dashboard gates them behind a confirmation affordance.
export const ByokPoolActionSchema = z.object({
    type: z.literal('byok_pool_action'),
    action: z.enum(['drain', 'recycle', 'resize']),
    // Required for 'recycle' (the target resource-shape key); ignored otherwise.
    key: z.string().min(1).max(1024).optional(),
    // For 'resize' only — new caps, clamped server-side to the configured ceiling.
    maxPerKey: z.number().int().positive().max(1024).optional(),
    maxTotal: z.number().int().positive().max(4096).optional(),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #6140 (epic #5530): prune reclaimable, chroxy-scoped, orphan-only host docker
// resources. `kind` selects what to remove (stopped chroxy containers / chroxy
// snapshot images / both). Host authority (server-enforced). The server takes NO
// target list from the client — it re-surveys the chroxy-scoped orphan set
// server-side and removes only those ids, so a malicious/stale client can never
// widen the blast radius. Destructive — the dashboard gates it behind a confirm.
// The optional `requestId` is echoed on the host_prune_action_ack (success) and
// the HOST_PRUNE_ACTION_FAILED session_error (failure).
export const HostPruneActionSchema = z.object({
    type: z.literal('host_prune_action'),
    kind: z.enum(['containers', 'images', 'all']),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #6136 slice 2 (epic #5530): boot / shutdown an iOS simulator from the Control
// Room "Device runtimes" tab. Host authority (server-enforced). `udid` is a
// LOOKUP KEY, never a trusted target — the server re-surveys `xcrun simctl list
// devices` and rejects any udid the survey didn't enumerate, plus state-guards
// (boot only a non-booted device, shutdown only a booted one). Non-destructive,
// so no confirm gate. The optional `requestId` is echoed on the
// simulator_action_ack (success) and the SIMULATOR_ACTION_FAILED session_error.
export const SimulatorActionSchema = z.object({
    type: z.literal('simulator_action'),
    action: z.enum(['boot', 'shutdown']),
    udid: z.string().min(1).max(128),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #6137 (epic #5530): boot an AVD / kill a running Android emulator from the
// Control Room "Device runtimes" tab. Host authority (server-enforced). boot
// targets an `avd` (the survey enumerated, currently stopped) with an optional
// `headless` (`-no-window`); kill targets a running `serial`. Both are LOOKUP
// KEYS — the server re-surveys and rejects any avd/serial the survey didn't
// enumerate, plus state-gates. The optional `requestId` is echoed on the
// emulator_action_ack (success) and the EMULATOR_ACTION_FAILED session_error.
export const EmulatorActionSchema = z.object({
    type: z.literal('emulator_action'),
    action: z.enum(['boot', 'kill']),
    avd: z.string().min(1).max(256).optional(),
    serial: z.string().min(1).max(128).optional(),
    headless: z.boolean().optional(),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #6138 (epic #5530): start / terminate a WSL2 distro from the Control Room
// "Device runtimes" tab (Windows hosts). Host authority (server-enforced).
// `distro` is a LOOKUP KEY — the server re-surveys `wsl.exe -l -v` and rejects
// any distro the survey didn't enumerate, plus state-gates (start a non-running
// distro, terminate a running one). terminate is destructive (drops the running
// distro's processes) so the dashboard gates it behind a confirm. The optional
// `requestId` is echoed on the wsl_action_ack / WSL_ACTION_FAILED session_error.
export const WslActionSchema = z.object({
    type: z.literal('wsl_action'),
    action: z.enum(['start', 'terminate']),
    distro: z.string().min(1).max(256),
    requestId: z.string().max(128).optional(),
}).passthrough();
// #5547: summarize a session's persisted history into a continuation brief.
// The server reads the session's `SessionMessageHistory` (the universal,
// restart-surviving source — works even when the provider subprocess is gone),
// windows long histories, and runs a ONE-SHOT model call (default: the
// session's own provider/model, override via `summarize.{provider,model}` in
// config). The reply is a single `summarize_session_result` (see server.ts);
// failures surface as a `SUMMARIZE_FAILED` session_error. The optional
// `requestId` correlates a specific right-click click to its outcome, mirroring
// the `integration_action` correlation contract.
//
// Authority (server-enforced, bearer-token-authority checklist): a HOST-level
// client OR a client bound to THIS session may summarize it — i.e. exactly the
// clients that could already read the session's history. A client bound to a
// DIFFERENT session is rejected.
export const SummarizeSessionSchema = z.object({
    type: z.literal('summarize_session'),
    sessionId: z.string().min(1).max(256),
    requestId: z.string().max(128).optional(),
});
// -- Orchestration / delegation harness ("committee", epic #6691, S-1) --
// v1 is dashboard-only + host-authority (unbound clients); run_start and
// spend-unblocking gate approvals additionally require the PRIMARY token
// (enforced server-side in the handler, not the schema).
export const OrchestrationRunsRequestSchema = z.object({
    type: z.literal('orchestration_runs_request'),
    requestId: z.string().max(128).optional(),
});
export const OrchestrationRunDetailRequestSchema = z.object({
    type: z.literal('orchestration_run_detail_request'),
    runId: z.string().min(1).max(128),
    requestId: z.string().max(128).optional(),
});
export const OrchestrationRunStartSchema = z.object({
    type: z.literal('orchestration_run_start'),
    preset: z.string().min(1).max(64).optional(), // e.g. 'repo-audit' (built-in)
    epicPrompt: z.string().min(1).max(20_000).optional(),
    cwd: z.string().min(1).max(1024), // validated server-side against the cwd allowlist
    title: z.string().max(200).optional(),
    budgetUsd: z.number().positive().finite().optional(),
    autoApprovePlan: z.boolean().optional(),
    roles: z.record(z.string(), z.object({
        provider: z.string().min(1).max(64),
        model: z.string().min(1).max(128),
    })).optional(),
    requestId: z.string().max(128).optional(),
}).refine((m) => Boolean(m.preset) || Boolean(m.epicPrompt), {
    message: 'preset or epicPrompt required',
});
export const OrchestrationGateResponseSchema = z.object({
    type: z.literal('orchestration_gate_response'),
    runId: z.string().min(1).max(128),
    gateId: z.string().min(1).max(128),
    decision: z.enum(['approve', 'reject', 'revise', 'skip']),
    note: z.string().max(4000).optional(),
    budgetUsd: z.number().positive().finite().optional(), // approve-with-raise on budget_overrun
    requestId: z.string().max(128).optional(),
});
export const OrchestrationRunActionSchema = z.object({
    type: z.literal('orchestration_run_action'),
    runId: z.string().min(1).max(128),
    action: z.enum(['cancel', 'pause', 'resume']),
    requestId: z.string().max(128).optional(),
});
// Attach a monolithic-session baseline and/or a human verdict-quality note to
// a run — the dogfood measurement path (#6691).
export const OrchestrationRunAnnotateSchema = z.object({
    type: z.literal('orchestration_run_annotate'),
    runId: z.string().min(1).max(128),
    baselineSessionId: z.string().min(1).max(256).optional(),
    verdictQuality: z.string().max(20_000).optional(),
    requestId: z.string().max(128).optional(),
}).refine((m) => Boolean(m.baselineSessionId) || m.verdictQuality !== undefined, {
    message: 'baselineSessionId or verdictQuality required',
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
    CancelActivitySchema,
    CancelQueuedSchema,
    SetModelSchema,
    SetPermissionModeSchema,
    SetThinkingLevelSchema,
    SetPermissionRulesSchema,
    SetMcpServerEnabledSchema,
    SubmitMcpAuthCodeSchema,
    SetPromptEvaluatorSchema,
    SetPromptEvaluatorSkipPatternSchema,
    SetChroxyContextHintSchema,
    SetSessionPreambleSchema,
    SkillActivateSchema,
    SkillDeactivateSchema,
    SkillTrustAcceptSchema,
    SkillTrustGrantSchema,
    PermissionResponseSchema,
    GetPermissionInputSchema,
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
    ListSymbolsSchema,
    ResolveSymbolSchema,
    SearchContentSchema,
    FindReferencesSchema,
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
    TerminalSubscribeSchema,
    TerminalUnsubscribeSchema,
    TerminalResizeSchema,
    TerminalInputSchema,
    TerminalResyncSchema,
    ClientVisibleSchema,
    ClaimPrimarySchema,
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
    SessionPresetGetSchema,
    SessionPresetSetSchema,
    SessionPresetApproveSchema,
    SessionPresetRevokeSchema,
    RevokeTokenSchema,
    QueryPermissionAuditSchema,
    ExtensionMessageSchema,
    CreateEnvironmentSchema,
    ListEnvironmentsSchema,
    DestroyEnvironmentSchema,
    GetEnvironmentSchema,
    EvaluateDraftSchema,
    HostStatusRequestSchema,
    RunnerStatusRequestSchema,
    ContainersStatusRequestSchema,
    RepoRuntimeConfigRequestSchema,
    ByokPoolStatusRequestSchema,
    HostPruneStatusRequestSchema,
    SimulatorStatusRequestSchema,
    EmulatorStatusRequestSchema,
    WslStatusRequestSchema,
    IntegrationStatusRequestSchema,
    SkillsInventoryRequestSchema,
    MailboxStatusRequestSchema,
    ExternalSessionsRequestSchema,
    RepoEventsRequestSchema,
    IntegrationActionSchema,
    ContainersActionSchema,
    ByokPoolActionSchema,
    HostPruneActionSchema,
    SimulatorActionSchema,
    EmulatorActionSchema,
    WslActionSchema,
    SummarizeSessionSchema,
    OrchestrationRunsRequestSchema,
    OrchestrationRunDetailRequestSchema,
    OrchestrationRunStartSchema,
    OrchestrationGateResponseSchema,
    OrchestrationRunActionSchema,
    OrchestrationRunAnnotateSchema,
    PairApproveSchema,
    PairDenySchema,
]);
