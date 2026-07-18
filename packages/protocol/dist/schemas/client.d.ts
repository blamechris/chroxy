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
declare const BinaryAttachmentSchema: z.ZodObject<{
    type: z.ZodEnum<{
        image: "image";
        document: "document";
    }>;
    mediaType: z.ZodString;
    data: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
declare const FileRefAttachmentSchema: z.ZodObject<{
    type: z.ZodLiteral<"file_ref">;
    path: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const AttachmentSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodEnum<{
        image: "image";
        document: "document";
    }>;
    mediaType: z.ZodString;
    data: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"file_ref">;
    path: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>]>;
export type BinaryAttachment = z.infer<typeof BinaryAttachmentSchema>;
export type FileRefAttachment = z.infer<typeof FileRefAttachmentSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export declare const AuthSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth">;
    token: z.ZodString;
    protocolVersion: z.ZodOptional<z.ZodNumber>;
    deviceInfo: z.ZodOptional<z.ZodObject<{
        deviceId: z.ZodOptional<z.ZodString>;
        deviceName: z.ZodOptional<z.ZodString>;
        deviceType: z.ZodOptional<z.ZodEnum<{
            unknown: "unknown";
            phone: "phone";
            tablet: "tablet";
            desktop: "desktop";
        }>>;
        platform: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    capabilities: z.ZodDefault<z.ZodCatch<z.ZodOptional<z.ZodArray<z.ZodString>>>>;
    eagerPublicKey: z.ZodOptional<z.ZodString>;
    eagerSalt: z.ZodOptional<z.ZodString>;
    historyCursors: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$loose>;
export declare const PairSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair">;
    pairingId: z.ZodString;
    protocolVersion: z.ZodOptional<z.ZodNumber>;
    deviceInfo: z.ZodOptional<z.ZodObject<{
        deviceId: z.ZodOptional<z.ZodString>;
        deviceName: z.ZodOptional<z.ZodString>;
        deviceType: z.ZodOptional<z.ZodEnum<{
            unknown: "unknown";
            phone: "phone";
            tablet: "tablet";
            desktop: "desktop";
        }>>;
        platform: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    capabilities: z.ZodDefault<z.ZodCatch<z.ZodOptional<z.ZodArray<z.ZodString>>>>;
}, z.core.$loose>;
export declare const PairRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_request">;
    deviceName: z.ZodOptional<z.ZodString>;
    requestId: z.ZodString;
    protocolVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export declare const PairApproveSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_approve">;
    requestId: z.ZodString;
}, z.core.$loose>;
export declare const PairDenySchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_deny">;
    requestId: z.ZodString;
}, z.core.$loose>;
export declare const InputSchema: z.ZodObject<{
    type: z.ZodLiteral<"input">;
    data: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodEnum<{
            image: "image";
            document: "document";
        }>;
        mediaType: z.ZodString;
        data: z.ZodString;
        name: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"file_ref">;
        path: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>]>>>;
    isVoice: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export declare const InterruptSchema: z.ZodObject<{
    type: z.ZodLiteral<"interrupt">;
}, z.core.$loose>;
export declare const CancelActivitySchema: z.ZodObject<{
    type: z.ZodLiteral<"cancel_activity">;
    activityId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const CancelQueuedSchema: z.ZodObject<{
    type: z.ZodLiteral<"cancel_queued">;
    clientMessageId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const SetModelSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_model">;
    model: z.ZodString;
}, z.core.$loose>;
export declare const SetPermissionModeSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_permission_mode">;
    mode: z.ZodEnum<{
        approve: "approve";
        auto: "auto";
        plan: "plan";
        acceptEdits: "acceptEdits";
    }>;
    confirmed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export declare const SetThinkingLevelSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_thinking_level">;
    level: z.ZodEnum<{
        default: "default";
        high: "high";
        max: "max";
    }>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const PermissionRuleSchema: z.ZodObject<{
    tool: z.ZodString;
    decision: z.ZodEnum<{
        allow: "allow";
        deny: "deny";
    }>;
}, z.core.$strip>;
/**
 * Request the current BYOK credentials status. Server replies with a
 * byok_credentials_status server message containing the masked preview.
 */
export declare const ByokGetCredentialsStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_get_credentials_status">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * Persist a new Anthropic API key to ~/.chroxy/credentials.json (mode 0600).
 * The server validates that the key starts with `sk-ant-`.
 */
export declare const ByokSetCredentialsSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_set_credentials">;
    requestId: z.ZodOptional<z.ZodString>;
    anthropicApiKey: z.ZodString;
}, z.core.$loose>;
/**
 * Remove the credentials file. No-op if no file is present.
 */
export declare const ByokClearCredentialsSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_clear_credentials">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * Request the masked status for every known provider credential. Server replies
 * with a `credentials_status` server message.
 */
export declare const GetCredentialsStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"get_credentials_status">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * Persist a credential value. `key` must be one of the server's known
 * credential keys (validated server-side against credential-store.js); `value`
 * is the raw secret. No upper length bound — provider key formats evolve.
 */
export declare const SetCredentialSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_credential">;
    requestId: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
    value: z.ZodString;
}, z.core.$loose>;
/**
 * Remove a single stored credential. No-op if not present.
 */
export declare const DeleteCredentialSchema: z.ZodObject<{
    type: z.ZodLiteral<"delete_credential">;
    requestId: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
}, z.core.$loose>;
/**
 * Lightweight credential ping. Server resolves the value (env > store), makes a
 * minimal provider API call, and replies with `credential_test_result`.
 */
export declare const TestCredentialSchema: z.ZodObject<{
    type: z.ZodLiteral<"test_credential">;
    requestId: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
}, z.core.$loose>;
export declare const SetPermissionRulesSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_permission_rules">;
    rules: z.ZodArray<z.ZodObject<{
        tool: z.ZodString;
        decision: z.ZodEnum<{
            allow: "allow";
            deny: "deny";
        }>;
    }, z.core.$strip>>;
    projectRules: z.ZodOptional<z.ZodArray<z.ZodObject<{
        tool: z.ZodString;
        decision: z.ZodEnum<{
            allow: "allow";
            deny: "deny";
        }>;
    }, z.core.$strip>>>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SetMcpServerEnabledSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_mcp_server_enabled">;
    server: z.ZodString;
    enabled: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SubmitMcpAuthCodeSchema: z.ZodObject<{
    type: z.ZodLiteral<"submit_mcp_auth_code">;
    server: z.ZodString;
    code: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SetPromptEvaluatorSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_prompt_evaluator">;
    value: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SetPromptEvaluatorSkipPatternSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_prompt_evaluator_skip_pattern">;
    value: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SetChroxyContextHintSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_chroxy_context_hint">;
    value: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SetSessionPreambleSchema: z.ZodObject<{
    type: z.ZodLiteral<"set_session_preamble">;
    value: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SkillActivateSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_activate">;
    skillName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SkillDeactivateSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_deactivate">;
    skillName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SkillTrustAcceptSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_accept">;
    skillName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SkillTrustGrantSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_grant">;
    skillName: z.ZodString;
    author: z.ZodString;
    scope: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const PermissionResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"permission_response">;
    requestId: z.ZodString;
    decision: z.ZodEnum<{
        allow: "allow";
        deny: "deny";
        allowAlways: "allowAlways";
    }>;
    editedInput: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const GetPermissionInputSchema: z.ZodObject<{
    type: z.ZodLiteral<"get_permission_input">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const QueryPermissionAuditSchema: z.ZodObject<{
    type: z.ZodLiteral<"query_permission_audit">;
    sessionId: z.ZodOptional<z.ZodString>;
    auditType: z.ZodOptional<z.ZodEnum<{
        decision: "decision";
        mode_change: "mode_change";
    }>>;
    since: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ListSessionsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_sessions">;
}, z.core.$strip>;
export declare const SwitchSessionSchema: z.ZodObject<{
    type: z.ZodLiteral<"switch_session">;
    sessionId: z.ZodString;
}, z.core.$strip>;
export declare const SandboxSchema: z.ZodObject<{
    network: z.ZodOptional<z.ZodObject<{
        allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>>;
    filesystem: z.ZodOptional<z.ZodObject<{
        allowedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deniedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>>;
    bash: z.ZodOptional<z.ZodObject<{
        allowedCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>>;
    autoAllowBashIfSandboxed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export declare const CreateSessionSchema: z.ZodObject<{
    type: z.ZodLiteral<"create_session">;
    name: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodEnum<{
        approve: "approve";
        auto: "auto";
        plan: "plan";
        acceptEdits: "acceptEdits";
    }>>;
    worktree: z.ZodOptional<z.ZodBoolean>;
    sandbox: z.ZodOptional<z.ZodObject<{
        network: z.ZodOptional<z.ZodObject<{
            allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        filesystem: z.ZodOptional<z.ZodObject<{
            allowedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deniedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        bash: z.ZodOptional<z.ZodObject<{
            allowedCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        autoAllowBashIfSandboxed: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    codexSandbox: z.ZodOptional<z.ZodEnum<{
        "read-only": "read-only";
        "workspace-write": "workspace-write";
        "danger-full-access": "danger-full-access";
    }>>;
    isolation: z.ZodOptional<z.ZodEnum<{
        worktree: "worktree";
        sandbox: "sandbox";
        none: "none";
        container: "container";
    }>>;
    environmentId: z.ZodOptional<z.ZodString>;
    skipPermissions: z.ZodOptional<z.ZodBoolean>;
    agentCommId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const DestroySessionSchema: z.ZodObject<{
    type: z.ZodLiteral<"destroy_session">;
    sessionId: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const RenameSessionSchema: z.ZodObject<{
    type: z.ZodLiteral<"rename_session">;
    sessionId: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
export declare const RegisterPushTokenSchema: z.ZodObject<{
    type: z.ZodLiteral<"register_push_token">;
    token: z.ZodString;
}, z.core.$strip>;
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
export declare const NotificationPrefsPatchSchema: z.ZodObject<{
    categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    devices: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodObject<{
        categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
            start: z.ZodString;
            end: z.ZodString;
            timezone: z.ZodString;
        }, z.core.$strip>]>>;
        bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
        lastSeenAt: z.ZodOptional<z.ZodNumber>;
        platform: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>, z.ZodNull]>>>;
    quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
        start: z.ZodString;
        end: z.ZodString;
        timezone: z.ZodString;
    }, z.core.$strip>]>>;
    bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/**
 * Request the current notification preferences. Server replies with a
 * `notification_prefs` snapshot. `requestId` is optional for correlation.
 */
export declare const NotificationPrefsGetSchema: z.ZodObject<{
    type: z.ZodLiteral<"notification_prefs_get">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * Patch the notification preferences and re-emit the resulting snapshot.
 * The server shallow-merges over the existing prefs and persists the
 * merged result atomically (temp+rename) to ~/.chroxy/notification-prefs.json.
 */
export declare const NotificationPrefsSetSchema: z.ZodObject<{
    type: z.ZodLiteral<"notification_prefs_set">;
    requestId: z.ZodOptional<z.ZodString>;
    prefs: z.ZodObject<{
        categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        devices: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodObject<{
            categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
            quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
                start: z.ZodString;
                end: z.ZodString;
                timezone: z.ZodString;
            }, z.core.$strip>]>>;
            bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
            lastSeenAt: z.ZodOptional<z.ZodNumber>;
            platform: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>, z.ZodNull]>>>;
        quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
            start: z.ZodString;
            end: z.ZodString;
            timezone: z.ZodString;
        }, z.core.$strip>]>>;
        bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$loose>;
export declare const UserQuestionResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"user_question_response">;
    answer: z.ZodString;
    answers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
    toolUseId: z.ZodOptional<z.ZodString>;
    freeformText: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ListDirectorySchema: z.ZodObject<{
    type: z.ZodLiteral<"list_directory">;
    path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const BrowseFilesSchema: z.ZodObject<{
    type: z.ZodLiteral<"browse_files">;
    path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const ReadFileSchema: z.ZodObject<{
    type: z.ZodLiteral<"read_file">;
    path: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const WriteFileSchema: z.ZodObject<{
    type: z.ZodLiteral<"write_file">;
    path: z.ZodString;
    content: z.ZodString;
}, z.core.$loose>;
export declare const ListFilesSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_files">;
    query: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ListSymbolsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_symbols">;
    path: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ResolveSymbolSchema: z.ZodObject<{
    type: z.ZodLiteral<"resolve_symbol">;
    symbol: z.ZodString;
    file: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const SearchContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"search_content">;
    query: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const FindReferencesSchema: z.ZodObject<{
    type: z.ZodLiteral<"find_references">;
    symbol: z.ZodString;
    file: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ListSlashCommandsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_slash_commands">;
}, z.core.$loose>;
export declare const ListAgentsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_agents">;
}, z.core.$loose>;
export declare const RequestFullHistorySchema: z.ZodObject<{
    type: z.ZodLiteral<"request_full_history">;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const KeyExchangeSchema: z.ZodObject<{
    type: z.ZodLiteral<"key_exchange">;
    publicKey: z.ZodString;
    salt: z.ZodString;
}, z.core.$strip>;
export declare const PingSchema: z.ZodObject<{
    type: z.ZodLiteral<"ping">;
}, z.core.$strip>;
export declare const RequestSessionContextSchema: z.ZodObject<{
    type: z.ZodLiteral<"request_session_context">;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const GetDiffSchema: z.ZodObject<{
    type: z.ZodLiteral<"get_diff">;
}, z.core.$loose>;
export declare const GitStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_status">;
}, z.core.$loose>;
export declare const GitBranchesSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_branches">;
}, z.core.$loose>;
export declare const GitStageSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_stage">;
    files: z.ZodArray<z.ZodString>;
}, z.core.$loose>;
export declare const GitUnstageSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_unstage">;
    files: z.ZodArray<z.ZodString>;
}, z.core.$loose>;
export declare const GitCommitSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_commit">;
    message: z.ZodString;
}, z.core.$loose>;
export declare const ResumeBudgetSchema: z.ZodObject<{
    type: z.ZodLiteral<"resume_budget">;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ListCheckpointsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_checkpoints">;
}, z.core.$strip>;
export declare const RestoreCheckpointSchema: z.ZodObject<{
    type: z.ZodLiteral<"restore_checkpoint">;
    checkpointId: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{
        files: "files";
        conversation: "conversation";
        both: "both";
    }>>;
}, z.core.$strip>;
export declare const CreateCheckpointSchema: z.ZodObject<{
    type: z.ZodLiteral<"create_checkpoint">;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const DeleteCheckpointSchema: z.ZodObject<{
    type: z.ZodLiteral<"delete_checkpoint">;
    checkpointId: z.ZodString;
}, z.core.$strip>;
export declare const CloseDevPreviewSchema: z.ZodObject<{
    type: z.ZodLiteral<"close_dev_preview">;
    port: z.ZodNumber;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const LaunchWebTaskSchema: z.ZodObject<{
    type: z.ZodLiteral<"launch_web_task">;
    prompt: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ListWebTasksSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_web_tasks">;
}, z.core.$strip>;
export declare const TeleportWebTaskSchema: z.ZodObject<{
    type: z.ZodLiteral<"teleport_web_task">;
    taskId: z.ZodString;
}, z.core.$strip>;
export declare const ListConversationsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_conversations">;
}, z.core.$strip>;
export declare const ResumeConversationSchema: z.ZodObject<{
    type: z.ZodLiteral<"resume_conversation">;
    conversationId: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SearchConversationsSchema: z.ZodObject<{
    type: z.ZodLiteral<"search_conversations">;
    query: z.ZodString;
    maxResults: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const RequestCostSummarySchema: z.ZodObject<{
    type: z.ZodLiteral<"request_cost_summary">;
}, z.core.$strip>;
export declare const SubscribeSessionsSchema: z.ZodObject<{
    type: z.ZodLiteral<"subscribe_sessions">;
    sessionIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const UnsubscribeSessionsSchema: z.ZodObject<{
    type: z.ZodLiteral<"unsubscribe_sessions">;
    sessionIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const TerminalSubscribeSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_subscribe">;
    sessionId: z.ZodString;
}, z.core.$strip>;
export declare const TerminalUnsubscribeSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_unsubscribe">;
    sessionId: z.ZodString;
}, z.core.$strip>;
export declare const TerminalResizeSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_resize">;
    sessionId: z.ZodString;
    cols: z.ZodNumber;
    rows: z.ZodNumber;
}, z.core.$strip>;
export declare const TerminalInputSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_input">;
    sessionId: z.ZodString;
    data: z.ZodString;
}, z.core.$strip>;
export declare const TerminalResyncSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_resync">;
    sessionId: z.ZodString;
}, z.core.$strip>;
export declare const ClientVisibleSchema: z.ZodObject<{
    type: z.ZodLiteral<"client_visible">;
    visible: z.ZodBoolean;
}, z.core.$strip>;
export declare const ClaimPrimarySchema: z.ZodObject<{
    type: z.ZodLiteral<"claim_primary">;
    sessionId: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ListProvidersSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_providers">;
}, z.core.$strip>;
export declare const ListSkillsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_skills">;
}, z.core.$strip>;
export declare const ListReposSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_repos">;
}, z.core.$strip>;
export declare const AddRepoSchema: z.ZodObject<{
    type: z.ZodLiteral<"add_repo">;
    path: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RemoveRepoSchema: z.ZodObject<{
    type: z.ZodLiteral<"remove_repo">;
    path: z.ZodString;
}, z.core.$strip>;
export declare const SessionPresetGetSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preset_get">;
    cwd: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SessionPresetSetSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preset_set">;
    cwd: z.ZodString;
    preset: z.ZodNullable<z.ZodObject<{
        preamble: z.ZodOptional<z.ZodString>;
        seed: z.ZodOptional<z.ZodString>;
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SessionPresetApproveSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preset_approve">;
    cwd: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SessionPresetRevokeSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preset_revoke">;
    cwd: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RevokeTokenSchema: z.ZodObject<{
    type: z.ZodLiteral<"revoke_token">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ExtensionMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"extension_message">;
    provider: z.ZodString;
    subtype: z.ZodString;
    data: z.ZodUnknown;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CreateEnvironmentSchema: z.ZodObject<{
    type: z.ZodLiteral<"create_environment">;
    name: z.ZodString;
    cwd: z.ZodString;
    image: z.ZodOptional<z.ZodString>;
    memoryLimit: z.ZodOptional<z.ZodString>;
    cpuLimit: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ListEnvironmentsSchema: z.ZodObject<{
    type: z.ZodLiteral<"list_environments">;
}, z.core.$strip>;
export declare const DestroyEnvironmentSchema: z.ZodObject<{
    type: z.ZodLiteral<"destroy_environment">;
    environmentId: z.ZodString;
}, z.core.$strip>;
export declare const GetEnvironmentSchema: z.ZodObject<{
    type: z.ZodLiteral<"get_environment">;
    environmentId: z.ZodString;
}, z.core.$strip>;
export declare const EvaluateDraftSchema: z.ZodObject<{
    type: z.ZodLiteral<"evaluate_draft">;
    draft: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const HostStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const MailboxStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"mailbox_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ExternalSessionsRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"external_sessions_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RepoEventsRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"repo_events_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RunnerStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"runner_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ContainersStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"containers_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RepoRuntimeConfigRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"repo_runtime_config_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ByokPoolStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const HostPruneStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_prune_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SimulatorStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"simulator_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const EmulatorStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"emulator_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const WslStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"wsl_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const IntegrationStatusRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SkillsInventoryRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_inventory_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const IntegrationActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_action">;
    action: z.ZodEnum<{
        repo_memory_reindex: "repo_memory_reindex";
        repo_relay_rerun: "repo_relay_rerun";
    }>;
    repoPath: z.ZodString;
    runId: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ContainersActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"containers_action">;
    action: z.ZodEnum<{
        stop: "stop";
        restart: "restart";
        destroy: "destroy";
    }>;
    environmentId: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ByokPoolActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_action">;
    action: z.ZodEnum<{
        drain: "drain";
        recycle: "recycle";
        resize: "resize";
    }>;
    key: z.ZodOptional<z.ZodString>;
    maxPerKey: z.ZodOptional<z.ZodNumber>;
    maxTotal: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const HostPruneActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_prune_action">;
    kind: z.ZodEnum<{
        containers: "containers";
        images: "images";
        all: "all";
    }>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const SimulatorActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"simulator_action">;
    action: z.ZodEnum<{
        boot: "boot";
        shutdown: "shutdown";
    }>;
    udid: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const EmulatorActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"emulator_action">;
    action: z.ZodEnum<{
        boot: "boot";
        kill: "kill";
    }>;
    avd: z.ZodOptional<z.ZodString>;
    serial: z.ZodOptional<z.ZodString>;
    headless: z.ZodOptional<z.ZodBoolean>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const WslActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"wsl_action">;
    action: z.ZodEnum<{
        start: "start";
        terminate: "terminate";
    }>;
    distro: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const SummarizeSessionSchema: z.ZodObject<{
    type: z.ZodLiteral<"summarize_session">;
    sessionId: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OrchestrationRunsRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_runs_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OrchestrationRunDetailRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_detail_request">;
    runId: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OrchestrationRunStartSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_start">;
    preset: z.ZodOptional<z.ZodString>;
    epicPrompt: z.ZodOptional<z.ZodString>;
    cwd: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    budgetUsd: z.ZodOptional<z.ZodNumber>;
    autoApprovePlan: z.ZodOptional<z.ZodBoolean>;
    roles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strip>>>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OrchestrationGateResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_gate_response">;
    runId: z.ZodString;
    gateId: z.ZodString;
    decision: z.ZodEnum<{
        approve: "approve";
        reject: "reject";
        revise: "revise";
        skip: "skip";
    }>;
    note: z.ZodOptional<z.ZodString>;
    budgetUsd: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OrchestrationRunActionSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_action">;
    runId: z.ZodString;
    action: z.ZodEnum<{
        cancel: "cancel";
        pause: "pause";
        resume: "resume";
    }>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const OrchestrationRunAnnotateSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_annotate">;
    runId: z.ZodString;
    baselineSessionId: z.ZodOptional<z.ZodString>;
    verdictQuality: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const EncryptedEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"encrypted">;
    d: z.ZodString;
    n: z.ZodNumber;
}, z.core.$strip>;
export declare const ClientMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"input">;
    data: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodEnum<{
            image: "image";
            document: "document";
        }>;
        mediaType: z.ZodString;
        data: z.ZodString;
        name: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"file_ref">;
        path: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>]>>>;
    isVoice: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"interrupt">;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"cancel_activity">;
    activityId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"cancel_queued">;
    clientMessageId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"set_model">;
    model: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"set_permission_mode">;
    mode: z.ZodEnum<{
        approve: "approve";
        auto: "auto";
        plan: "plan";
        acceptEdits: "acceptEdits";
    }>;
    confirmed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"set_thinking_level">;
    level: z.ZodEnum<{
        default: "default";
        high: "high";
        max: "max";
    }>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"set_permission_rules">;
    rules: z.ZodArray<z.ZodObject<{
        tool: z.ZodString;
        decision: z.ZodEnum<{
            allow: "allow";
            deny: "deny";
        }>;
    }, z.core.$strip>>;
    projectRules: z.ZodOptional<z.ZodArray<z.ZodObject<{
        tool: z.ZodString;
        decision: z.ZodEnum<{
            allow: "allow";
            deny: "deny";
        }>;
    }, z.core.$strip>>>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"set_mcp_server_enabled">;
    server: z.ZodString;
    enabled: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"submit_mcp_auth_code">;
    server: z.ZodString;
    code: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"set_prompt_evaluator">;
    value: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"set_prompt_evaluator_skip_pattern">;
    value: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"set_chroxy_context_hint">;
    value: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"set_session_preamble">;
    value: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"skill_activate">;
    skillName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"skill_deactivate">;
    skillName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_accept">;
    skillName: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_grant">;
    skillName: z.ZodString;
    author: z.ZodString;
    scope: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"permission_response">;
    requestId: z.ZodString;
    decision: z.ZodEnum<{
        allow: "allow";
        deny: "deny";
        allowAlways: "allowAlways";
    }>;
    editedInput: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"get_permission_input">;
    requestId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_sessions">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"switch_session">;
    sessionId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"create_session">;
    name: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodEnum<{
        approve: "approve";
        auto: "auto";
        plan: "plan";
        acceptEdits: "acceptEdits";
    }>>;
    worktree: z.ZodOptional<z.ZodBoolean>;
    sandbox: z.ZodOptional<z.ZodObject<{
        network: z.ZodOptional<z.ZodObject<{
            allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        filesystem: z.ZodOptional<z.ZodObject<{
            allowedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deniedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        bash: z.ZodOptional<z.ZodObject<{
            allowedCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        autoAllowBashIfSandboxed: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    codexSandbox: z.ZodOptional<z.ZodEnum<{
        "read-only": "read-only";
        "workspace-write": "workspace-write";
        "danger-full-access": "danger-full-access";
    }>>;
    isolation: z.ZodOptional<z.ZodEnum<{
        worktree: "worktree";
        sandbox: "sandbox";
        none: "none";
        container: "container";
    }>>;
    environmentId: z.ZodOptional<z.ZodString>;
    skipPermissions: z.ZodOptional<z.ZodBoolean>;
    agentCommId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"destroy_session">;
    sessionId: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"rename_session">;
    sessionId: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"register_push_token">;
    token: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"notification_prefs_get">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"notification_prefs_set">;
    requestId: z.ZodOptional<z.ZodString>;
    prefs: z.ZodObject<{
        categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        devices: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodObject<{
            categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
            quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
                start: z.ZodString;
                end: z.ZodString;
                timezone: z.ZodString;
            }, z.core.$strip>]>>;
            bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
            lastSeenAt: z.ZodOptional<z.ZodNumber>;
            platform: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>, z.ZodNull]>>>;
        quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
            start: z.ZodString;
            end: z.ZodString;
            timezone: z.ZodString;
        }, z.core.$strip>]>>;
        bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"user_question_response">;
    answer: z.ZodString;
    answers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
    toolUseId: z.ZodOptional<z.ZodString>;
    freeformText: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_directory">;
    path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"browse_files">;
    path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"read_file">;
    path: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"write_file">;
    path: z.ZodString;
    content: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"list_files">;
    query: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"list_symbols">;
    path: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"resolve_symbol">;
    symbol: z.ZodString;
    file: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"search_content">;
    query: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"find_references">;
    symbol: z.ZodString;
    file: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"list_slash_commands">;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"list_agents">;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"request_full_history">;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"request_session_context">;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"get_diff">;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"git_status">;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"git_branches">;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"git_stage">;
    files: z.ZodArray<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"git_unstage">;
    files: z.ZodArray<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"git_commit">;
    message: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"resume_budget">;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"list_checkpoints">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"restore_checkpoint">;
    checkpointId: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{
        files: "files";
        conversation: "conversation";
        both: "both";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"create_checkpoint">;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"delete_checkpoint">;
    checkpointId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"close_dev_preview">;
    port: z.ZodNumber;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"launch_web_task">;
    prompt: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_web_tasks">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"teleport_web_task">;
    taskId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_conversations">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"resume_conversation">;
    conversationId: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"search_conversations">;
    query: z.ZodString;
    maxResults: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"request_cost_summary">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"subscribe_sessions">;
    sessionIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"unsubscribe_sessions">;
    sessionIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"terminal_subscribe">;
    sessionId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"terminal_unsubscribe">;
    sessionId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"terminal_resize">;
    sessionId: z.ZodString;
    cols: z.ZodNumber;
    rows: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"terminal_input">;
    sessionId: z.ZodString;
    data: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"terminal_resync">;
    sessionId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"client_visible">;
    visible: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"claim_primary">;
    sessionId: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_providers">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"byok_get_credentials_status">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"byok_set_credentials">;
    requestId: z.ZodOptional<z.ZodString>;
    anthropicApiKey: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"byok_clear_credentials">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"get_credentials_status">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"set_credential">;
    requestId: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
    value: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"delete_credential">;
    requestId: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"test_credential">;
    requestId: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"list_skills">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_repos">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"add_repo">;
    path: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"remove_repo">;
    path: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"session_preset_get">;
    cwd: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"session_preset_set">;
    cwd: z.ZodString;
    preset: z.ZodNullable<z.ZodObject<{
        preamble: z.ZodOptional<z.ZodString>;
        seed: z.ZodOptional<z.ZodString>;
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"session_preset_approve">;
    cwd: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"session_preset_revoke">;
    cwd: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"revoke_token">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"query_permission_audit">;
    sessionId: z.ZodOptional<z.ZodString>;
    auditType: z.ZodOptional<z.ZodEnum<{
        decision: "decision";
        mode_change: "mode_change";
    }>>;
    since: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"extension_message">;
    provider: z.ZodString;
    subtype: z.ZodString;
    data: z.ZodUnknown;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"create_environment">;
    name: z.ZodString;
    cwd: z.ZodString;
    image: z.ZodOptional<z.ZodString>;
    memoryLimit: z.ZodOptional<z.ZodString>;
    cpuLimit: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"list_environments">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"destroy_environment">;
    environmentId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"get_environment">;
    environmentId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"evaluate_draft">;
    draft: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"host_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"runner_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"containers_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"repo_runtime_config_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"host_prune_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"simulator_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"emulator_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"wsl_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"integration_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"skills_inventory_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mailbox_status_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"external_sessions_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"repo_events_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"integration_action">;
    action: z.ZodEnum<{
        repo_memory_reindex: "repo_memory_reindex";
        repo_relay_rerun: "repo_relay_rerun";
    }>;
    repoPath: z.ZodString;
    runId: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"containers_action">;
    action: z.ZodEnum<{
        stop: "stop";
        restart: "restart";
        destroy: "destroy";
    }>;
    environmentId: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_action">;
    action: z.ZodEnum<{
        drain: "drain";
        recycle: "recycle";
        resize: "resize";
    }>;
    key: z.ZodOptional<z.ZodString>;
    maxPerKey: z.ZodOptional<z.ZodNumber>;
    maxTotal: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"host_prune_action">;
    kind: z.ZodEnum<{
        containers: "containers";
        images: "images";
        all: "all";
    }>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"simulator_action">;
    action: z.ZodEnum<{
        boot: "boot";
        shutdown: "shutdown";
    }>;
    udid: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"emulator_action">;
    action: z.ZodEnum<{
        boot: "boot";
        kill: "kill";
    }>;
    avd: z.ZodOptional<z.ZodString>;
    serial: z.ZodOptional<z.ZodString>;
    headless: z.ZodOptional<z.ZodBoolean>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"wsl_action">;
    action: z.ZodEnum<{
        start: "start";
        terminate: "terminate";
    }>;
    distro: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"summarize_session">;
    sessionId: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"orchestration_runs_request">;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_detail_request">;
    runId: z.ZodString;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_start">;
    preset: z.ZodOptional<z.ZodString>;
    epicPrompt: z.ZodOptional<z.ZodString>;
    cwd: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    budgetUsd: z.ZodOptional<z.ZodNumber>;
    autoApprovePlan: z.ZodOptional<z.ZodBoolean>;
    roles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strip>>>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"orchestration_gate_response">;
    runId: z.ZodString;
    gateId: z.ZodString;
    decision: z.ZodEnum<{
        approve: "approve";
        reject: "reject";
        revise: "revise";
        skip: "skip";
    }>;
    note: z.ZodOptional<z.ZodString>;
    budgetUsd: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_action">;
    runId: z.ZodString;
    action: z.ZodEnum<{
        cancel: "cancel";
        pause: "pause";
        resume: "resume";
    }>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_annotate">;
    runId: z.ZodString;
    baselineSessionId: z.ZodOptional<z.ZodString>;
    verdictQuality: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"pair_approve">;
    requestId: z.ZodString;
}, z.core.$loose>, z.ZodObject<{
    type: z.ZodLiteral<"pair_deny">;
    requestId: z.ZodString;
}, z.core.$loose>], "type">;
export type AuthMessage = z.infer<typeof AuthSchema>;
export type PairMessage = z.infer<typeof PairSchema>;
export type PairRequestMessage = z.infer<typeof PairRequestSchema>;
export type PairApproveMessage = z.infer<typeof PairApproveSchema>;
export type PairDenyMessage = z.infer<typeof PairDenySchema>;
export type InputMessage = z.infer<typeof InputSchema>;
export type InterruptMessage = z.infer<typeof InterruptSchema>;
export type CancelActivityMessage = z.infer<typeof CancelActivitySchema>;
export type CancelQueuedMessage = z.infer<typeof CancelQueuedSchema>;
export type SetModelMessage = z.infer<typeof SetModelSchema>;
export type SetPermissionModeMessage = z.infer<typeof SetPermissionModeSchema>;
export type SetPermissionRulesMessage = z.infer<typeof SetPermissionRulesSchema>;
export type SetMcpServerEnabledMessage = z.infer<typeof SetMcpServerEnabledSchema>;
export type SubmitMcpAuthCodeMessage = z.infer<typeof SubmitMcpAuthCodeSchema>;
export type PermissionResponseMessage = z.infer<typeof PermissionResponseSchema>;
export type GetPermissionInputMessage = z.infer<typeof GetPermissionInputSchema>;
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
export type HostStatusRequestMessage = z.infer<typeof HostStatusRequestSchema>;
export type RunnerStatusRequestMessage = z.infer<typeof RunnerStatusRequestSchema>;
export type ContainersStatusRequestMessage = z.infer<typeof ContainersStatusRequestSchema>;
export type RepoRuntimeConfigRequestMessage = z.infer<typeof RepoRuntimeConfigRequestSchema>;
export type ByokPoolStatusRequestMessage = z.infer<typeof ByokPoolStatusRequestSchema>;
export type HostPruneStatusRequestMessage = z.infer<typeof HostPruneStatusRequestSchema>;
export type SimulatorStatusRequestMessage = z.infer<typeof SimulatorStatusRequestSchema>;
export type EmulatorStatusRequestMessage = z.infer<typeof EmulatorStatusRequestSchema>;
export type WslStatusRequestMessage = z.infer<typeof WslStatusRequestSchema>;
export type IntegrationStatusRequestMessage = z.infer<typeof IntegrationStatusRequestSchema>;
export type SkillsInventoryRequestMessage = z.infer<typeof SkillsInventoryRequestSchema>;
export type MailboxStatusRequestMessage = z.infer<typeof MailboxStatusRequestSchema>;
export type ExternalSessionsRequestMessage = z.infer<typeof ExternalSessionsRequestSchema>;
export type RepoEventsRequestMessage = z.infer<typeof RepoEventsRequestSchema>;
export type IntegrationActionMessage = z.infer<typeof IntegrationActionSchema>;
export type ContainersActionMessage = z.infer<typeof ContainersActionSchema>;
export type ByokPoolActionMessage = z.infer<typeof ByokPoolActionSchema>;
export type HostPruneActionMessage = z.infer<typeof HostPruneActionSchema>;
export type SimulatorActionMessage = z.infer<typeof SimulatorActionSchema>;
export type EmulatorActionMessage = z.infer<typeof EmulatorActionSchema>;
export type WslActionMessage = z.infer<typeof WslActionSchema>;
export type SummarizeSessionMessage = z.infer<typeof SummarizeSessionSchema>;
export type OrchestrationRunsRequestMessage = z.infer<typeof OrchestrationRunsRequestSchema>;
export type OrchestrationRunDetailRequestMessage = z.infer<typeof OrchestrationRunDetailRequestSchema>;
export type OrchestrationRunStartMessage = z.infer<typeof OrchestrationRunStartSchema>;
export type OrchestrationGateResponseMessage = z.infer<typeof OrchestrationGateResponseSchema>;
export type OrchestrationRunActionMessage = z.infer<typeof OrchestrationRunActionSchema>;
export type OrchestrationRunAnnotateMessage = z.infer<typeof OrchestrationRunAnnotateSchema>;
export type SessionPresetGetMessage = z.infer<typeof SessionPresetGetSchema>;
export type SessionPresetSetMessage = z.infer<typeof SessionPresetSetSchema>;
export type SessionPresetApproveMessage = z.infer<typeof SessionPresetApproveSchema>;
export type SessionPresetRevokeMessage = z.infer<typeof SessionPresetRevokeSchema>;
export type ClaimPrimaryMessage = z.infer<typeof ClaimPrimarySchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export {};
