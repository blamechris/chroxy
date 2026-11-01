/**
 * Per-session signals: focus/inactivity, multi-question, MCP servers, plan mode, cumulative usage, session list/restore/persist/stopped, provider list, auth bootstrap, tunnel url, skills list + skill-trust handshake.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
export declare const ServerClientFocusChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"client_focus_changed">;
    clientId: z.ZodString;
    sessionId: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerInactivityWarningSchema: z.ZodObject<{
    type: z.ZodLiteral<"inactivity_warning">;
    messageId: z.ZodString;
    idleMs: z.ZodNumber;
    prefab: z.ZodString;
}, z.core.$strip>;
export declare const ServerMultiQuestionInterventionSchema: z.ZodObject<{
    type: z.ZodLiteral<"multi_question_intervention">;
    toolUseId: z.ZodString;
    questionCount: z.ZodNumber;
    reason: z.ZodLiteral<"multi_question">;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerMcpServersSchema: z.ZodObject<{
    type: z.ZodLiteral<"mcp_servers">;
    sessionId: z.ZodOptional<z.ZodString>;
    servers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        status: z.ZodString;
        enabled: z.ZodOptional<z.ZodBoolean>;
        canToggle: z.ZodOptional<z.ZodBoolean>;
        authUrl: z.ZodOptional<z.ZodString>;
        scope: z.ZodOptional<z.ZodEnum<{
            project: "project";
            user: "user";
        }>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerPlanStartedSchema: z.ZodObject<{
    type: z.ZodLiteral<"plan_started">;
}, z.core.$strip>;
export declare const ServerPlanReadySchema: z.ZodObject<{
    type: z.ZodLiteral<"plan_ready">;
    allowedPrompts: z.ZodOptional<z.ZodArray<z.ZodAny>>;
}, z.core.$strip>;
export declare const CumulativeUsageSchema: z.ZodObject<{
    inputTokens: z.ZodNumber;
    outputTokens: z.ZodNumber;
    cacheReadTokens: z.ZodNumber;
    cacheCreationTokens: z.ZodNumber;
    costUsd: z.ZodNumber;
    turnsBilled: z.ZodNumber;
}, z.core.$strip>;
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
export declare const ServerSessionListEntrySchema: z.ZodObject<{
    sessionId: z.ZodString;
    name: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    permissionMode: z.ZodOptional<z.ZodString>;
    starting: z.ZodOptional<z.ZodBoolean>;
    isBusy: z.ZodOptional<z.ZodBoolean>;
    busyReason: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        turn: "turn";
        "background-shells": "background-shells";
    }>>>;
    backgroundShellCount: z.ZodOptional<z.ZodNumber>;
    createdAt: z.ZodOptional<z.ZodNumber>;
    lastActivityAt: z.ZodOptional<z.ZodNumber>;
    conversationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    provider: z.ZodOptional<z.ZodString>;
    billingClass: z.ZodOptional<z.ZodEnum<{
        "api-key": "api-key";
        subscription: "subscription";
        "programmatic-credit": "programmatic-credit";
    }>>;
    capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    worktree: z.ZodOptional<z.ZodBoolean>;
    repoCwd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isolation: z.ZodOptional<z.ZodString>;
    promptEvaluator: z.ZodOptional<z.ZodBoolean>;
    promptEvaluatorSkipPattern: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull]>>;
    chroxyContextHint: z.ZodOptional<z.ZodBoolean>;
    sessionPreamble: z.ZodOptional<z.ZodString>;
    stdinForwardingDisabled: z.ZodOptional<z.ZodBoolean>;
    stdinDroppedBytes: z.ZodOptional<z.ZodNumber>;
    stdinDroppedCount: z.ZodOptional<z.ZodNumber>;
    cumulativeUsage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        turnsBilled: z.ZodNumber;
    }, z.core.$strip>>;
    pendingBackgroundShells: z.ZodOptional<z.ZodArray<z.ZodObject<{
        shellId: z.ZodString;
        command: z.ZodString;
        startedAt: z.ZodNumber;
    }, z.core.$strip>>>;
    orchestrationRunId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    orchestrationRole: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    codexSandbox: z.ZodOptional<z.ZodEnum<{
        "read-only": "read-only";
        "workspace-write": "workspace-write";
        "danger-full-access": "danger-full-access";
    }>>;
    agentConnection: z.ZodOptional<z.ZodObject<{
        version: z.ZodLiteral<1>;
        id: z.ZodString;
        label: z.ZodString;
        provider: z.ZodString;
        runtime: z.ZodObject<{
            id: z.ZodString;
            version: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        accountRef: z.ZodNullable<z.ZodString>;
        authentication: z.ZodObject<{
            requested: z.ZodEnum<{
                native: "native";
                api: "api";
                local: "local";
                imported: "imported";
                unknown: "unknown";
            }>;
            observed: z.ZodEnum<{
                native: "native";
                local: "local";
                unknown: "unknown";
                "api-key": "api-key";
                none: "none";
            }>;
        }, z.core.$strip>;
        entitlement: z.ZodObject<{
            route: z.ZodEnum<{
                api: "api";
                local: "local";
                unknown: "unknown";
                subscription: "subscription";
            }>;
            status: z.ZodEnum<{
                unknown: "unknown";
                available: "available";
                unavailable: "unavailable";
            }>;
        }, z.core.$strip>;
        model: z.ZodObject<{
            requested: z.ZodNullable<z.ZodString>;
            resolved: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        execution: z.ZodObject<{
            host: z.ZodEnum<{
                unknown: "unknown";
                daemon: "daemon";
                container: "container";
                remote: "remote";
            }>;
            inference: z.ZodEnum<{
                local: "local";
                unknown: "unknown";
                remote: "remote";
            }>;
        }, z.core.$strip>;
        readiness: z.ZodObject<{
            state: z.ZodEnum<{
                unknown: "unknown";
                ready: "ready";
                blocked: "blocked";
                unsupported: "unsupported";
            }>;
            reasonCode: z.ZodNullable<z.ZodString>;
            message: z.ZodNullable<z.ZodString>;
            recoveryAction: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        provenance: z.ZodObject<{
            source: z.ZodEnum<{
                configured: "configured";
                legacy: "legacy";
            }>;
            observedAt: z.ZodString;
            expiresAt: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>>;
}, z.core.$loose>;
export declare const ServerSessionListSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_list">;
    sessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        name: z.ZodString;
        cwd: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        permissionMode: z.ZodOptional<z.ZodString>;
        starting: z.ZodOptional<z.ZodBoolean>;
        isBusy: z.ZodOptional<z.ZodBoolean>;
        busyReason: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            turn: "turn";
            "background-shells": "background-shells";
        }>>>;
        backgroundShellCount: z.ZodOptional<z.ZodNumber>;
        createdAt: z.ZodOptional<z.ZodNumber>;
        lastActivityAt: z.ZodOptional<z.ZodNumber>;
        conversationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        provider: z.ZodOptional<z.ZodString>;
        billingClass: z.ZodOptional<z.ZodEnum<{
            "api-key": "api-key";
            subscription: "subscription";
            "programmatic-credit": "programmatic-credit";
        }>>;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        worktree: z.ZodOptional<z.ZodBoolean>;
        repoCwd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isolation: z.ZodOptional<z.ZodString>;
        promptEvaluator: z.ZodOptional<z.ZodBoolean>;
        promptEvaluatorSkipPattern: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull]>>;
        chroxyContextHint: z.ZodOptional<z.ZodBoolean>;
        sessionPreamble: z.ZodOptional<z.ZodString>;
        stdinForwardingDisabled: z.ZodOptional<z.ZodBoolean>;
        stdinDroppedBytes: z.ZodOptional<z.ZodNumber>;
        stdinDroppedCount: z.ZodOptional<z.ZodNumber>;
        cumulativeUsage: z.ZodOptional<z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            turnsBilled: z.ZodNumber;
        }, z.core.$strip>>;
        pendingBackgroundShells: z.ZodOptional<z.ZodArray<z.ZodObject<{
            shellId: z.ZodString;
            command: z.ZodString;
            startedAt: z.ZodNumber;
        }, z.core.$strip>>>;
        orchestrationRunId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        orchestrationRole: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        codexSandbox: z.ZodOptional<z.ZodEnum<{
            "read-only": "read-only";
            "workspace-write": "workspace-write";
            "danger-full-access": "danger-full-access";
        }>>;
        agentConnection: z.ZodOptional<z.ZodObject<{
            version: z.ZodLiteral<1>;
            id: z.ZodString;
            label: z.ZodString;
            provider: z.ZodString;
            runtime: z.ZodObject<{
                id: z.ZodString;
                version: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            accountRef: z.ZodNullable<z.ZodString>;
            authentication: z.ZodObject<{
                requested: z.ZodEnum<{
                    native: "native";
                    api: "api";
                    local: "local";
                    imported: "imported";
                    unknown: "unknown";
                }>;
                observed: z.ZodEnum<{
                    native: "native";
                    local: "local";
                    unknown: "unknown";
                    "api-key": "api-key";
                    none: "none";
                }>;
            }, z.core.$strip>;
            entitlement: z.ZodObject<{
                route: z.ZodEnum<{
                    api: "api";
                    local: "local";
                    unknown: "unknown";
                    subscription: "subscription";
                }>;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    available: "available";
                    unavailable: "unavailable";
                }>;
            }, z.core.$strip>;
            model: z.ZodObject<{
                requested: z.ZodNullable<z.ZodString>;
                resolved: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            execution: z.ZodObject<{
                host: z.ZodEnum<{
                    unknown: "unknown";
                    daemon: "daemon";
                    container: "container";
                    remote: "remote";
                }>;
                inference: z.ZodEnum<{
                    local: "local";
                    unknown: "unknown";
                    remote: "remote";
                }>;
            }, z.core.$strip>;
            readiness: z.ZodObject<{
                state: z.ZodEnum<{
                    unknown: "unknown";
                    ready: "ready";
                    blocked: "blocked";
                    unsupported: "unsupported";
                }>;
                reasonCode: z.ZodNullable<z.ZodString>;
                message: z.ZodNullable<z.ZodString>;
                recoveryAction: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            provenance: z.ZodObject<{
                source: z.ZodEnum<{
                    configured: "configured";
                    legacy: "legacy";
                }>;
                observedAt: z.ZodString;
                expiresAt: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>>;
    }, z.core.$loose>>;
}, z.core.$strip>;
/**
 * #7745 / #7835: provider runtime identity and instruction-customization seam.
 *
 * This is deliberately separate from `session_list`: the latter is durable
 * session metadata, while this frame describes the live provider adapter and
 * (when the runtime reports them) the binary serving this process. A reconnect,
 * tab switch, or late subscription gets a fresh frame from `sendSessionInfo`.
 *
 * Every vocabulary is finite and every collection/string is bounded. The
 * descriptor is display/compilation evidence, not an authorization claim:
 * `unknown` means the adapter cannot prove the behavior, and instruction
 * channels remain instructional unless `toolConstraints` says a runtime gate
 * exists.
 */
export declare const ProviderRuntimeCapabilityStateSchema: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
export declare const ProviderCustomizationDescriptorSchema: z.ZodObject<{
    nativeDiscovery: z.ZodObject<{
        state: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
        files: z.ZodArray<z.ZodEnum<{
            "AGENTS.md": "AGENTS.md";
            "AGENTS.override.md": "AGENTS.override.md";
            "CLAUDE.md": "CLAUDE.md";
            "CLAUDE.local.md": "CLAUDE.local.md";
            "GEMINI.md": "GEMINI.md";
            "provider-defined": "provider-defined";
        }>>;
        delivery: z.ZodEnum<{
            unknown: "unknown";
            none: "none";
            "user-message": "user-message";
            "provider-context": "provider-context";
        }>;
        precedence: z.ZodEnum<{
            unknown: "unknown";
            none: "none";
            "provider-defined": "provider-defined";
            "global-root-cwd": "global-root-cwd";
            "global-project-subtree": "global-project-subtree";
            "global-workspace-jit": "global-workspace-jit";
        }>;
    }, z.core.$strict>;
    chroxyChannels: z.ZodArray<z.ZodObject<{
        channel: z.ZodEnum<{
            "system-append": "system-append";
            "system-api": "system-api";
            "first-user-turn": "first-user-turn";
        }>;
        lifetime: z.ZodEnum<{
            "each-turn": "each-turn";
            "process-start": "process-start";
            "first-turn": "first-turn";
        }>;
        content: z.ZodArray<z.ZodEnum<{
            skills: "skills";
            "project-instructions": "project-instructions";
            "session-preamble": "session-preamble";
            "context-hint": "context-hint";
        }>>;
    }, z.core.$strict>>;
    nativeSkills: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
    runtimeToggles: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
    toolConstraints: z.ZodEnum<{
        unknown: "unknown";
        none: "none";
        "chroxy-runtime": "chroxy-runtime";
        "provider-runtime": "provider-runtime";
        instructional: "instructional";
    }>;
    policyDecisions: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
    memoryProjection: z.ZodEnum<{
        unknown: "unknown";
        none: "none";
        "provider-native": "provider-native";
        "chroxy-history": "chroxy-history";
    }>;
    mcp: z.ZodObject<{
        discovery: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
        toolCalls: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
    }, z.core.$strict>;
    byteBudgets: z.ZodObject<{
        nativeDocuments: z.ZodUnion<readonly [z.ZodNumber, z.ZodEnum<{
            unknown: "unknown";
            unsupported: "unsupported";
        }>]>;
        chroxySkills: z.ZodUnion<readonly [z.ZodNumber, z.ZodEnum<{
            unknown: "unknown";
            unsupported: "unsupported";
        }>]>;
        projectInstructions: z.ZodUnion<readonly [z.ZodNumber, z.ZodEnum<{
            unknown: "unknown";
            unsupported: "unsupported";
        }>]>;
    }, z.core.$strict>;
    egress: z.ZodEnum<{
        local: "local";
        unknown: "unknown";
        cloud: "cloud";
    }>;
}, z.core.$strict>;
export declare const ProviderInstructionProjectionSchema: z.ZodObject<{
    status: z.ZodEnum<{
        unknown: "unknown";
        unsupported: "unsupported";
        delivered: "delivered";
    }>;
    enforcement: z.ZodLiteral<"instructional">;
    compilerVersion: z.ZodString;
    budgetBytes: z.ZodNumber;
    totalBytes: z.ZodNumber;
    sources: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
        endByte: z.ZodNumber;
    }, z.core.$strict>>;
    rules: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        sourceId: z.ZodString;
        endByte: z.ZodNumber;
    }, z.core.$strict>>;
    includedRequiredRuleIds: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const PROVIDER_BINARY_VERSION_MAX_LENGTH = 128;
export declare const ServerProviderRuntimeInfoSchema: z.ZodObject<{
    type: z.ZodLiteral<"provider_runtime_info">;
    sessionId: z.ZodString;
    provider: z.ZodString;
    binaryVersion: z.ZodUnion<readonly [z.ZodString, z.ZodLiteral<"unknown">]>;
    inputRequiresReady: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    capabilities: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        state: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
    }, z.core.$strict>>;
    customization: z.ZodObject<{
        nativeDiscovery: z.ZodObject<{
            state: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
            files: z.ZodArray<z.ZodEnum<{
                "AGENTS.md": "AGENTS.md";
                "AGENTS.override.md": "AGENTS.override.md";
                "CLAUDE.md": "CLAUDE.md";
                "CLAUDE.local.md": "CLAUDE.local.md";
                "GEMINI.md": "GEMINI.md";
                "provider-defined": "provider-defined";
            }>>;
            delivery: z.ZodEnum<{
                unknown: "unknown";
                none: "none";
                "user-message": "user-message";
                "provider-context": "provider-context";
            }>;
            precedence: z.ZodEnum<{
                unknown: "unknown";
                none: "none";
                "provider-defined": "provider-defined";
                "global-root-cwd": "global-root-cwd";
                "global-project-subtree": "global-project-subtree";
                "global-workspace-jit": "global-workspace-jit";
            }>;
        }, z.core.$strict>;
        chroxyChannels: z.ZodArray<z.ZodObject<{
            channel: z.ZodEnum<{
                "system-append": "system-append";
                "system-api": "system-api";
                "first-user-turn": "first-user-turn";
            }>;
            lifetime: z.ZodEnum<{
                "each-turn": "each-turn";
                "process-start": "process-start";
                "first-turn": "first-turn";
            }>;
            content: z.ZodArray<z.ZodEnum<{
                skills: "skills";
                "project-instructions": "project-instructions";
                "session-preamble": "session-preamble";
                "context-hint": "context-hint";
            }>>;
        }, z.core.$strict>>;
        nativeSkills: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
        runtimeToggles: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
        toolConstraints: z.ZodEnum<{
            unknown: "unknown";
            none: "none";
            "chroxy-runtime": "chroxy-runtime";
            "provider-runtime": "provider-runtime";
            instructional: "instructional";
        }>;
        policyDecisions: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
        memoryProjection: z.ZodEnum<{
            unknown: "unknown";
            none: "none";
            "provider-native": "provider-native";
            "chroxy-history": "chroxy-history";
        }>;
        mcp: z.ZodObject<{
            discovery: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
            toolCalls: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"unknown">]>;
        }, z.core.$strict>;
        byteBudgets: z.ZodObject<{
            nativeDocuments: z.ZodUnion<readonly [z.ZodNumber, z.ZodEnum<{
                unknown: "unknown";
                unsupported: "unsupported";
            }>]>;
            chroxySkills: z.ZodUnion<readonly [z.ZodNumber, z.ZodEnum<{
                unknown: "unknown";
                unsupported: "unsupported";
            }>]>;
            projectInstructions: z.ZodUnion<readonly [z.ZodNumber, z.ZodEnum<{
                unknown: "unknown";
                unsupported: "unsupported";
            }>]>;
        }, z.core.$strict>;
        egress: z.ZodEnum<{
            local: "local";
            unknown: "unknown";
            cloud: "cloud";
        }>;
    }, z.core.$strict>;
    projectInstructions: z.ZodObject<{
        status: z.ZodEnum<{
            unknown: "unknown";
            unsupported: "unsupported";
            delivered: "delivered";
        }>;
        enforcement: z.ZodLiteral<"instructional">;
        compilerVersion: z.ZodString;
        budgetBytes: z.ZodNumber;
        totalBytes: z.ZodNumber;
        sources: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            sha256: z.ZodString;
            bytes: z.ZodNumber;
            endByte: z.ZodNumber;
        }, z.core.$strict>>;
        rules: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            sourceId: z.ZodString;
            endByte: z.ZodNumber;
        }, z.core.$strict>>;
        includedRequiredRuleIds: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ProviderRuntimeCapabilityState = z.infer<typeof ProviderRuntimeCapabilityStateSchema>;
export type ProviderCustomizationDescriptor = z.infer<typeof ProviderCustomizationDescriptorSchema>;
export type ProviderInstructionProjection = z.infer<typeof ProviderInstructionProjectionSchema>;
export type ProviderRuntimeInfo = Omit<z.infer<typeof ServerProviderRuntimeInfoSchema>, 'type' | 'sessionId'>;
/**
 * Emitted when a session in the persisted state file could not be restored
 * at server startup (e.g. missing env var for a Codex/Gemini provider).
 *
 * History on disk is preserved (`originalHistoryPreserved: true`) so the user
 * can retry after fixing the underlying issue. Dashboards / mobile UIs should
 * surface the failed session in a "needs attention" state with the reported
 * error and a retry affordance. See issue #2954 (Guardian FM-01).
 */
export declare const ServerSessionRestoreFailedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_restore_failed">;
    sessionId: z.ZodString;
    name: z.ZodString;
    provider: z.ZodString;
    agentConnection: z.ZodOptional<z.ZodObject<{
        version: z.ZodLiteral<1>;
        id: z.ZodString;
        label: z.ZodString;
        provider: z.ZodString;
        runtime: z.ZodObject<{
            id: z.ZodString;
            version: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        accountRef: z.ZodNullable<z.ZodString>;
        authentication: z.ZodObject<{
            requested: z.ZodEnum<{
                native: "native";
                api: "api";
                local: "local";
                imported: "imported";
                unknown: "unknown";
            }>;
            observed: z.ZodEnum<{
                native: "native";
                local: "local";
                unknown: "unknown";
                "api-key": "api-key";
                none: "none";
            }>;
        }, z.core.$strip>;
        entitlement: z.ZodObject<{
            route: z.ZodEnum<{
                api: "api";
                local: "local";
                unknown: "unknown";
                subscription: "subscription";
            }>;
            status: z.ZodEnum<{
                unknown: "unknown";
                available: "available";
                unavailable: "unavailable";
            }>;
        }, z.core.$strip>;
        model: z.ZodObject<{
            requested: z.ZodNullable<z.ZodString>;
            resolved: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        execution: z.ZodObject<{
            host: z.ZodEnum<{
                unknown: "unknown";
                daemon: "daemon";
                container: "container";
                remote: "remote";
            }>;
            inference: z.ZodEnum<{
                local: "local";
                unknown: "unknown";
                remote: "remote";
            }>;
        }, z.core.$strip>;
        readiness: z.ZodObject<{
            state: z.ZodEnum<{
                unknown: "unknown";
                ready: "ready";
                blocked: "blocked";
                unsupported: "unsupported";
            }>;
            reasonCode: z.ZodNullable<z.ZodString>;
            message: z.ZodNullable<z.ZodString>;
            recoveryAction: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        provenance: z.ZodObject<{
            source: z.ZodEnum<{
                configured: "configured";
                legacy: "legacy";
            }>;
            observedAt: z.ZodString;
            expiresAt: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strict>>;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    permissionMode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    errorCode: z.ZodString;
    errorMessage: z.ZodString;
    originalHistoryPreserved: z.ZodBoolean;
    historyLength: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/**
 * #7625: the parked failed-restore roster, in reply to `list_failed_restores`.
 *
 * Same per-entry shape as {@link ServerSessionRestoreFailedSchema} (both are
 * built from `SessionManager.getFailedRestores()`), because the push and the
 * pull describe the same thing and a second, drifting shape for it is exactly
 * what this repo keeps paying for. Note `historyLength` rather than the history
 * itself: the roster says how much is preserved, never its content, so a
 * discard affordance built on this can say what it would destroy without the
 * server having shipped it.
 *
 * Dashboard-only, like the environment_* family (PLATFORM_SPECIFIC in
 * packages/protocol/tests/handler-coverage.test.js). The mobile app keeps the
 * existing `session_restore_failed` toast: it has no list surface, and an
 * unknown type falls through both clients' graceful default case.
 */
export declare const ServerFailedRestoresListSchema: z.ZodObject<{
    type: z.ZodLiteral<"failed_restores_list">;
    generatedAt: z.ZodString;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
    restores: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        name: z.ZodString;
        provider: z.ZodString;
        agentConnection: z.ZodOptional<z.ZodObject<{
            version: z.ZodLiteral<1>;
            id: z.ZodString;
            label: z.ZodString;
            provider: z.ZodString;
            runtime: z.ZodObject<{
                id: z.ZodString;
                version: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            accountRef: z.ZodNullable<z.ZodString>;
            authentication: z.ZodObject<{
                requested: z.ZodEnum<{
                    native: "native";
                    api: "api";
                    local: "local";
                    imported: "imported";
                    unknown: "unknown";
                }>;
                observed: z.ZodEnum<{
                    native: "native";
                    local: "local";
                    unknown: "unknown";
                    "api-key": "api-key";
                    none: "none";
                }>;
            }, z.core.$strip>;
            entitlement: z.ZodObject<{
                route: z.ZodEnum<{
                    api: "api";
                    local: "local";
                    unknown: "unknown";
                    subscription: "subscription";
                }>;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    available: "available";
                    unavailable: "unavailable";
                }>;
            }, z.core.$strip>;
            model: z.ZodObject<{
                requested: z.ZodNullable<z.ZodString>;
                resolved: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            execution: z.ZodObject<{
                host: z.ZodEnum<{
                    unknown: "unknown";
                    daemon: "daemon";
                    container: "container";
                    remote: "remote";
                }>;
                inference: z.ZodEnum<{
                    local: "local";
                    unknown: "unknown";
                    remote: "remote";
                }>;
            }, z.core.$strip>;
            readiness: z.ZodObject<{
                state: z.ZodEnum<{
                    unknown: "unknown";
                    ready: "ready";
                    blocked: "blocked";
                    unsupported: "unsupported";
                }>;
                reasonCode: z.ZodNullable<z.ZodString>;
                message: z.ZodNullable<z.ZodString>;
                recoveryAction: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            provenance: z.ZodObject<{
                source: z.ZodEnum<{
                    configured: "configured";
                    legacy: "legacy";
                }>;
                observedAt: z.ZodString;
                expiresAt: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>>;
        cwd: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        permissionMode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        errorCode: z.ZodString;
        errorMessage: z.ZodString;
        needsAttention: z.ZodOptional<z.ZodBoolean>;
        historyLength: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #7625: the reply to `retry_failed_restore`.
 *
 * `ok: false` with `code: 'FAILED_RESTORE_NOT_FOUND'` is deliberately
 * distinguishable from a re-failure: it means the entry is already gone (a
 * concurrent retry won, or the 30-day TTL pruned it), i.e. the operator's
 * button was stale — not that the retry ran and failed. A renewed failure
 * ALSO arrives as a fresh `session_restore_failed` broadcast, so a client that
 * only listens for that still converges.
 */
export declare const ServerRetryFailedRestoreResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"retry_failed_restore_result">;
    sessionId: z.ZodString;
    ok: z.ZodBoolean;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * #8860: one page of a parked failed restore's preserved history, in reply to
 * `get_failed_restore_history`.
 *
 * READ-ONLY. It exists because a session parked with
 * `CODEX_NATIVE_LOCATOR_MISSING` can never be resumed (the fail-closed native
 * resume, docs/providers.md "Native restart continuity"), and the roster
 * publishes only `historyLength`; this is how the operator reads what is
 * preserved. It does not and cannot resume the session.
 *
 * `entries` are the saved history entries OLDEST FIRST, each already run
 * through the persistence truncation and stripped of server bookkeeping
 * (`_seq`). They are modelled loosely on purpose: a history entry is a union
 * of shapes (`message`, `tool_start`, `tool_result`, `result`, ...) that the
 * server writes and this schema does not own, so only `type` is required and
 * every other field passes through. A client must render defensively.
 *
 * `ok: false` replies carry `code`: `FAILED_RESTORE_NOT_FOUND` (the entry is
 * gone: a retry won or the 30-day TTL pruned it) or, with `refused: true`,
 * `FAILED_RESTORE_HISTORY_FORBIDDEN_BOUND_CLIENT` (a pairing-bound token). The
 * refusal is a degraded, schema-valid reply of this type rather than an error
 * so the caller never waits on a reply that never comes.
 *
 * `offset` echoes the page start the server actually served (after clamping),
 * so a client can drop a reply that no longer matches its request.
 */
export declare const ServerFailedRestoreHistoryEntrySchema: z.ZodObject<{
    type: z.ZodString;
    timestamp: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export declare const ServerFailedRestoreHistorySchema: z.ZodObject<{
    type: z.ZodLiteral<"failed_restore_history">;
    sessionId: z.ZodString;
    ok: z.ZodBoolean;
    total: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    entries: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        timestamp: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>>;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Provider-neutral session archive: the roster row for one archived session.
 * Built by the server from a fixed list of typed fields (never the saved entry
 * itself), so it carries no transcript content — only enough to pick a record.
 * `archiveId` is the server-generated token every other archive message keys on.
 * `reason` says why the session left the live set: `closed`, `idle_timeout`,
 * `respawn_exhausted`, `stale`, `failed_restore_expired`,
 * `failed_restore_dismissed`. Timestamps are epoch milliseconds, `null` when
 * the saved entry did not carry one.
 */
export declare const ServerArchivedSessionMetaSchema: z.ZodObject<{
    archiveId: z.ZodString;
    sessionId: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    provider: z.ZodNullable<z.ZodString>;
    cwd: z.ZodNullable<z.ZodString>;
    model: z.ZodNullable<z.ZodString>;
    reason: z.ZodString;
    archivedAt: z.ZodNullable<z.ZodNumber>;
    lastActivityAt: z.ZodNullable<z.ZodNumber>;
    createdAt: z.ZodNullable<z.ZodNumber>;
    historyLength: z.ZodNumber;
    omittedOldest: z.ZodOptional<z.ZodNumber>;
    bytes: z.ZodNumber;
    restore: z.ZodOptional<z.ZodObject<{
        native: z.ZodBoolean;
        nativeReason: z.ZodOptional<z.ZodString>;
        newThread: z.ZodBoolean;
        newThreadReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Reply to `list_archived_sessions`. `policy` is the retention policy in force
 * (`enabled: false` means no NEW sessions are archived; existing records still
 * age out). `sessions` is newest first. `refused: true` + `code` is the
 * pairing-bound client's degraded reply (`sessions` empty) — distinguishable
 * from a genuinely empty archive by the flag, not the array.
 */
export declare const ServerArchivedSessionsListSchema: z.ZodObject<{
    type: z.ZodLiteral<"archived_sessions_list">;
    generatedAt: z.ZodString;
    policy: z.ZodObject<{
        enabled: z.ZodBoolean;
        maxEntries: z.ZodNumber;
        maxAgeDays: z.ZodNumber;
        maxMegabytes: z.ZodNumber;
    }, z.core.$strip>;
    sessions: z.ZodArray<z.ZodObject<{
        archiveId: z.ZodString;
        sessionId: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        cwd: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        reason: z.ZodString;
        archivedAt: z.ZodNullable<z.ZodNumber>;
        lastActivityAt: z.ZodNullable<z.ZodNumber>;
        createdAt: z.ZodNullable<z.ZodNumber>;
        historyLength: z.ZodNumber;
        omittedOldest: z.ZodOptional<z.ZodNumber>;
        bytes: z.ZodNumber;
        restore: z.ZodOptional<z.ZodObject<{
            native: z.ZodBoolean;
            nativeReason: z.ZodOptional<z.ZodString>;
            newThread: z.ZodBoolean;
            newThreadReason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    truncated: z.ZodOptional<z.ZodBoolean>;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Reply to `get_archived_session_history`: one page of an archived session's
 * preserved history, oldest first. `entries` use the SAME loosely modelled
 * entry shape as `failed_restore_history` (the server owns the union of history
 * entry shapes; a client must render defensively), and the page obeys the same
 * bounds (<= 100 entries, ~256 KiB). `ok: false` carries `code`:
 * `ARCHIVED_SESSION_NOT_FOUND` (unknown id, or the record was deleted / aged
 * out) or, with `refused: true`, `ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT`;
 * `ARCHIVED_SESSION_INVALID` for a missing archiveId. `offset` echoes the page
 * start actually served (after clamping).
 */
export declare const ServerArchivedSessionHistorySchema: z.ZodObject<{
    type: z.ZodLiteral<"archived_session_history">;
    archiveId: z.ZodString;
    ok: z.ZodBoolean;
    total: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    entries: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        timestamp: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>>;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Reply to `delete_archived_session`. `deleted` is how many records were
 * removed (0 or 1 for an `archiveId`; any count for `all: true`). `archiveId`
 * echoes the request's id (absent for `all: true`). `ok: false` carries `code`:
 * `ARCHIVED_SESSION_NOT_FOUND` (no such record), `ARCHIVED_SESSION_DELETE_FAILED`
 * (the record exists but could not be removed — it is still on disk),
 * `ARCHIVED_SESSIONS_DELETE_PARTIAL` (`all: true`: `deleted` records went, others
 * could not be removed), `ARCHIVED_SESSION_INVALID`, or, with `refused: true`,
 * `ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT`.
 */
export declare const ServerDeleteArchivedSessionResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"delete_archived_session_result">;
    ok: z.ZodBoolean;
    deleted: z.ZodNumber;
    archiveId: z.ZodOptional<z.ZodString>;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Reply to `restore_archived_session`. `sessionId` is the live session on
 * success (for `native`, the id the manager actually restored under, which can
 * differ from the archived one) and, for a native restore whose provider start
 * then failed, the id it was re-parked under in the failed restores. `seed`
 * (new_thread only) says how much of the archived transcript will ride with the
 * first message: `messagesIncluded` of `messagesTotal` conversation messages,
 * `bytes` of text. `ok: false` carries `code`: `ARCHIVED_SESSION_NOT_FOUND`,
 * `ARCHIVED_SESSION_INVALID`, `ARCHIVE_RESTORE_PROVIDER_UNAVAILABLE`,
 * `ARCHIVE_RESTORE_FORBIDDEN_USER_SHELL`, `ARCHIVE_RESTORE_CWD_MISSING`,
 * `ARCHIVE_RESTORE_NATIVE_UNSUPPORTED`, `ARCHIVE_RESTORE_LOCATOR_MISSING`,
 * `ARCHIVE_RESTORE_ALREADY_LIVE` (`sessionId` is the live or parked owner),
 * `ENVIRONMENT_UNAVAILABLE`, a provider start code, or, with `refused: true`,
 * `ARCHIVED_SESSION_FORBIDDEN_BOUND_CLIENT`. `mode` echoes the request's mode
 * (absent when it was not a valid one).
 */
export declare const ServerRestoreArchivedSessionResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"restore_archived_session_result">;
    archiveId: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{
        native: "native";
        new_thread: "new_thread";
    }>>;
    ok: z.ZodBoolean;
    sessionId: z.ZodOptional<z.ZodString>;
    seed: z.ZodOptional<z.ZodObject<{
        messagesIncluded: z.ZodNumber;
        messagesTotal: z.ZodNumber;
        bytes: z.ZodNumber;
    }, z.core.$strip>>;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Reply to `set_session_archive_policy`. `policy` is the policy now in force on
 * the daemon (read back from the archive, not echoed from the request).
 * `deleted` is how many records `purge: true` removed. `ok: false` carries
 * `code`: `SESSION_ARCHIVE_POLICY_INVALID`, `SESSION_ARCHIVE_POLICY_PERSIST_FAILED`
 * (nothing was applied), `SESSION_ARCHIVE_PURGE_PARTIAL` (the policy change DID
 * apply and `policy` is present; some records could not be removed), or, with
 * `refused: true`, `SESSION_ARCHIVE_POLICY_FORBIDDEN_BOUND_CLIENT`.
 */
export declare const ServerSessionArchivePolicyResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_archive_policy_result">;
    ok: z.ZodBoolean;
    policy: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        maxEntries: z.ZodNumber;
        maxAgeDays: z.ZodNumber;
        maxMegabytes: z.ZodNumber;
    }, z.core.$strip>>;
    deleted: z.ZodOptional<z.ZodNumber>;
    requestId: z.ZodOptional<z.ZodString>;
    refused: z.ZodOptional<z.ZodBoolean>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * #5714 / #5701: emitted when a session-list mutation (create / rename / destroy)
 * could not be flushed to disk — disk full, locked file, read-only home. The
 * write is atomic so on-disk state isn't corrupted, but the in-memory change
 * will be lost on the next restart. Clients surface this as an error banner so
 * the operator knows their change wasn't saved (instead of silently believing it
 * was). `name` is null when the entry was already removed before the flush
 * (destroy path) and no label could be resolved.
 */
export declare const ServerSessionPersistFailedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_persist_failed">;
    sessionId: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
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
export declare const ServerSessionStoppedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_stopped">;
    sessionId: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerConversationIdSchema: z.ZodObject<{
    type: z.ZodLiteral<"conversation_id">;
    sessionId: z.ZodOptional<z.ZodString>;
    conversationId: z.ZodString;
}, z.core.$strip>;
export declare const ServerProviderListSchema: z.ZodObject<{
    type: z.ZodLiteral<"provider_list">;
    providers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        auth: z.ZodOptional<z.ZodObject<{
            ready: z.ZodBoolean;
            source: z.ZodEnum<{
                none: "none";
                env: "env";
                oauth: "oauth";
            }>;
            envVar: z.ZodNullable<z.ZodString>;
            envVars: z.ZodArray<z.ZodString>;
            hint: z.ZodString;
            detail: z.ZodString;
            billingClass: z.ZodOptional<z.ZodEnum<{
                "api-key": "api-key";
                subscription: "subscription";
                "programmatic-credit": "programmatic-credit";
            }>>;
        }, z.core.$strip>>;
        connections: z.ZodOptional<z.ZodArray<z.ZodObject<{
            version: z.ZodLiteral<1>;
            id: z.ZodString;
            label: z.ZodString;
            provider: z.ZodString;
            runtime: z.ZodObject<{
                id: z.ZodString;
                version: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            accountRef: z.ZodNullable<z.ZodString>;
            authentication: z.ZodObject<{
                requested: z.ZodEnum<{
                    native: "native";
                    api: "api";
                    local: "local";
                    imported: "imported";
                    unknown: "unknown";
                }>;
                observed: z.ZodEnum<{
                    native: "native";
                    local: "local";
                    unknown: "unknown";
                    "api-key": "api-key";
                    none: "none";
                }>;
            }, z.core.$strip>;
            entitlement: z.ZodObject<{
                route: z.ZodEnum<{
                    api: "api";
                    local: "local";
                    unknown: "unknown";
                    subscription: "subscription";
                }>;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    available: "available";
                    unavailable: "unavailable";
                }>;
            }, z.core.$strip>;
            model: z.ZodObject<{
                requested: z.ZodNullable<z.ZodString>;
                resolved: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            execution: z.ZodObject<{
                host: z.ZodEnum<{
                    unknown: "unknown";
                    daemon: "daemon";
                    container: "container";
                    remote: "remote";
                }>;
                inference: z.ZodEnum<{
                    local: "local";
                    unknown: "unknown";
                    remote: "remote";
                }>;
            }, z.core.$strip>;
            readiness: z.ZodObject<{
                state: z.ZodEnum<{
                    unknown: "unknown";
                    ready: "ready";
                    blocked: "blocked";
                    unsupported: "unsupported";
                }>;
                reasonCode: z.ZodNullable<z.ZodString>;
                message: z.ZodNullable<z.ZodString>;
                recoveryAction: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            provenance: z.ZodObject<{
                source: z.ZodEnum<{
                    configured: "configured";
                    legacy: "legacy";
                }>;
                observedAt: z.ZodString;
                expiresAt: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>>>;
    }, z.core.$strip>>;
    defaultProvider: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const ServerAuthBootstrapSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth_bootstrap">;
    sessionToken: z.ZodOptional<z.ZodString>;
    credentialConfirmation: z.ZodOptional<z.ZodBoolean>;
    providers: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        auth: z.ZodOptional<z.ZodObject<{
            ready: z.ZodBoolean;
            source: z.ZodEnum<{
                none: "none";
                env: "env";
                oauth: "oauth";
            }>;
            envVar: z.ZodNullable<z.ZodString>;
            envVars: z.ZodArray<z.ZodString>;
            hint: z.ZodString;
            detail: z.ZodString;
            billingClass: z.ZodOptional<z.ZodEnum<{
                "api-key": "api-key";
                subscription: "subscription";
                "programmatic-credit": "programmatic-credit";
            }>>;
        }, z.core.$strip>>;
        connections: z.ZodOptional<z.ZodArray<z.ZodObject<{
            version: z.ZodLiteral<1>;
            id: z.ZodString;
            label: z.ZodString;
            provider: z.ZodString;
            runtime: z.ZodObject<{
                id: z.ZodString;
                version: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            accountRef: z.ZodNullable<z.ZodString>;
            authentication: z.ZodObject<{
                requested: z.ZodEnum<{
                    native: "native";
                    api: "api";
                    local: "local";
                    imported: "imported";
                    unknown: "unknown";
                }>;
                observed: z.ZodEnum<{
                    native: "native";
                    local: "local";
                    unknown: "unknown";
                    "api-key": "api-key";
                    none: "none";
                }>;
            }, z.core.$strip>;
            entitlement: z.ZodObject<{
                route: z.ZodEnum<{
                    api: "api";
                    local: "local";
                    unknown: "unknown";
                    subscription: "subscription";
                }>;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    available: "available";
                    unavailable: "unavailable";
                }>;
            }, z.core.$strip>;
            model: z.ZodObject<{
                requested: z.ZodNullable<z.ZodString>;
                resolved: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            execution: z.ZodObject<{
                host: z.ZodEnum<{
                    unknown: "unknown";
                    daemon: "daemon";
                    container: "container";
                    remote: "remote";
                }>;
                inference: z.ZodEnum<{
                    local: "local";
                    unknown: "unknown";
                    remote: "remote";
                }>;
            }, z.core.$strip>;
            readiness: z.ZodObject<{
                state: z.ZodEnum<{
                    unknown: "unknown";
                    ready: "ready";
                    blocked: "blocked";
                    unsupported: "unsupported";
                }>;
                reasonCode: z.ZodNullable<z.ZodString>;
                message: z.ZodNullable<z.ZodString>;
                recoveryAction: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
            provenance: z.ZodObject<{
                source: z.ZodEnum<{
                    configured: "configured";
                    legacy: "legacy";
                }>;
                observedAt: z.ZodString;
                expiresAt: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strict>>>;
    }, z.core.$strip>>>;
    slashCommands: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    agents: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    sessionId: z.ZodOptional<z.ZodString>;
    tunnelUrl: z.ZodOptional<z.ZodString>;
    defaultProvider: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const ServerTunnelUrlChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"tunnel_url_changed">;
    url: z.ZodString;
    previousUrl: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ServerSkillsListSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_list">;
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>>;
        activation: z.ZodOptional<z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>>;
        active: z.ZodOptional<z.ZodBoolean>;
        version: z.ZodOptional<z.ZodString>;
        hashPrefix: z.ZodOptional<z.ZodString>;
        firstSeen: z.ZodOptional<z.ZodString>;
        lastVerified: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
export declare const ServerSkillChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_changed">;
    skillName: z.ZodString;
    sessionId: z.ZodNullable<z.ZodString>;
    oldHashPrefix: z.ZodString;
    newHashPrefix: z.ZodString;
    mode: z.ZodEnum<{
        warn: "warn";
        block: "block";
    }>;
}, z.core.$strip>;
export declare const ServerSkillActivatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_activated">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillDeactivatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_deactivated">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustAcceptedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_accepted">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_request">;
    skillName: z.ZodString;
    author: z.ZodString;
    source: z.ZodString;
    description: z.ZodString;
    path: z.ZodString;
    sessionId: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSkillTrustGrantedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_granted">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
    author: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustGrantOkSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_grant_ok">;
    requestId: z.ZodNullable<z.ZodString>;
    sessionId: z.ZodString;
    skillName: z.ZodString;
    author: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustGrantInvalidAuthorSchema: z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodNullable<z.ZodString>;
    code: z.ZodLiteral<"INVALID_AUTHOR">;
    message: z.ZodString;
    actualAuthor: z.ZodString;
}, z.core.$strip>;
export declare const ServerSessionActivitySchema: z.ZodObject<{
    type: z.ZodLiteral<"session_activity">;
    sessionId: z.ZodString;
    isBusy: z.ZodBoolean;
    lastCost: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerSessionErrorSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_error">;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    recoverable: z.ZodOptional<z.ZodBoolean>;
    reason: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    boundSessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    boundSessionName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    primaryClientId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const ServerInputAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"input_ack">;
    sessionId: z.ZodString;
    clientMessageId: z.ZodString;
    status: z.ZodEnum<{
        queued: "queued";
        rejected: "rejected";
        accepted: "accepted";
        duplicate: "duplicate";
        expired: "expired";
        uncertain: "uncertain";
    }>;
    delivery: z.ZodEnum<{
        unknown: "unknown";
        queued: "queued";
        dispatch_started: "dispatch_started";
        evaluation_held: "evaluation_held";
        not_dispatched: "not_dispatched";
    }>;
    retrySafe: z.ZodBoolean;
    acceptedAt: z.ZodOptional<z.ZodNumber>;
    retentionExpiresAt: z.ZodOptional<z.ZodNumber>;
    dedupScope: z.ZodLiteral<"process">;
    reason: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
    context: z.ZodOptional<z.ZodObject<{
        version: z.ZodLiteral<1>;
        acceptedItemIds: z.ZodArray<z.ZodString>;
        supportedKinds: z.ZodArray<z.ZodEnum<{
            image: "image";
            text: "text";
        }>>;
        supportedLifetimes: z.ZodArray<z.ZodLiteral<"one_turn">>;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ServerSessionUpdatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_updated">;
    sessionId: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
export declare const ServerCheckpointCreatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkpoint_created">;
    sessionId: z.ZodString;
    checkpoint: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        messageCount: z.ZodNumber;
        createdAt: z.ZodNumber;
        hasGitSnapshot: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ServerCheckpointListSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkpoint_list">;
    sessionId: z.ZodNullable<z.ZodString>;
    checkpoints: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        messageCount: z.ZodNumber;
        createdAt: z.ZodNumber;
        hasGitSnapshot: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerCheckpointRestoredSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkpoint_restored">;
    checkpointId: z.ZodString;
    newSessionId: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    filesOnly: z.ZodOptional<z.ZodBoolean>;
    mode: z.ZodOptional<z.ZodEnum<{
        files: "files";
        conversation: "conversation";
        both: "both";
    }>>;
}, z.core.$strip>;
export declare const ServerSessionWarningSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_warning">;
    sessionId: z.ZodString;
    name: z.ZodString;
    reason: z.ZodLiteral<"idle_timeout">;
    message: z.ZodString;
    remainingMs: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerSessionTimeoutSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_timeout">;
    sessionId: z.ZodString;
    name: z.ZodString;
    idleMs: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerStatuslineOutputSchema: z.ZodObject<{
    type: z.ZodLiteral<"statusline_output">;
    sessionId: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    active: z.ZodOptional<z.ZodBoolean>;
    truncated: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const SessionPrCheckCountsSchema: z.ZodObject<{
    total: z.ZodNumber;
    passed: z.ZodNumber;
    failed: z.ZodNumber;
    pending: z.ZodNumber;
    skipped: z.ZodNumber;
    unknown: z.ZodNumber;
}, z.core.$strip>;
export declare const SessionPrChecksSchema: z.ZodObject<{
    state: z.ZodEnum<{
        unknown: "unknown";
        none: "none";
        success: "success";
        pending: "pending";
        failure: "failure";
    }>;
    counts: z.ZodObject<{
        total: z.ZodNumber;
        passed: z.ZodNumber;
        failed: z.ZodNumber;
        pending: z.ZodNumber;
        skipped: z.ZodNumber;
        unknown: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const SessionPrMergeSchema: z.ZodObject<{
    mergeable: z.ZodNullable<z.ZodString>;
    mergeStateStatus: z.ZodNullable<z.ZodString>;
    reviewDecision: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const SessionPrRefSchema: z.ZodObject<{
    number: z.ZodNumber;
    title: z.ZodNullable<z.ZodString>;
    url: z.ZodNullable<z.ZodString>;
    headRefOid: z.ZodNullable<z.ZodString>;
    isDraft: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerSessionPrStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_pr_status">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sessionId: z.ZodNullable<z.ZodString>;
    generatedAt: z.ZodString;
    branch: z.ZodNullable<z.ZodString>;
    repo: z.ZodNullable<z.ZodObject<{
        owner: z.ZodString;
        name: z.ZodString;
    }, z.core.$strip>>;
    pr: z.ZodNullable<z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodNullable<z.ZodString>;
        url: z.ZodNullable<z.ZodString>;
        headRefOid: z.ZodNullable<z.ZodString>;
        isDraft: z.ZodBoolean;
    }, z.core.$strip>>;
    checks: z.ZodNullable<z.ZodObject<{
        state: z.ZodEnum<{
            unknown: "unknown";
            none: "none";
            success: "success";
            pending: "pending";
            failure: "failure";
        }>;
        counts: z.ZodObject<{
            total: z.ZodNumber;
            passed: z.ZodNumber;
            failed: z.ZodNumber;
            pending: z.ZodNumber;
            skipped: z.ZodNumber;
            unknown: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    merge: z.ZodNullable<z.ZodObject<{
        mergeable: z.ZodNullable<z.ZodString>;
        mergeStateStatus: z.ZodNullable<z.ZodString>;
        reviewDecision: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSessionPrThreadsSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_pr_threads">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sessionId: z.ZodNullable<z.ZodString>;
    countedAt: z.ZodString;
    prNumber: z.ZodNullable<z.ZodNumber>;
    unresolvedCount: z.ZodNullable<z.ZodNumber>;
    totalCount: z.ZodNullable<z.ZodNumber>;
    truncated: z.ZodBoolean;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
