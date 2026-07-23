import { z } from 'zod';
/**
 * Server -> client schemas for the orchestration / delegation harness
 * ("committee") — epic #6691, delivery step S-1.
 *
 * Runs are host-level, durable, cross-session objects (an architect model
 * decomposes an epic; worker models execute it as their own Chroxy sessions;
 * the architect reviews and re-delegates). This file is the SINGLE SOURCE OF
 * TRUTH for the run/subtask/gate enums — the server engine imports these
 * `*_VALUES` arrays so the wire contract and the engine state machines can
 * never drift. See docs/design/orchestration/.
 *
 * v1 is dashboard-only (locked product decision). In this step (S-1) the
 * contract + shared store-core reducers land, and these types are parked in the
 * coverage guard's UNHANDLED_BY_DESIGN allowlist; S-3 (#6702) wires the
 * dashboard message-handler and moves them to DASHBOARD_ONLY. Mobile parity is
 * a later fast-follow.
 */
export declare const RUN_STATUS_VALUES: readonly ["created", "planning", "plan_review", "executing", "paused", "budget_paused", "synthesizing", "cancelling", "suspended", "completed", "failed", "cancelled"];
export declare const RUN_NODE_STATUS_VALUES: readonly ["pending", "spawning", "briefing", "poa_review", "executing", "result_review", "respawning", "merging", "conflict_fixup", "escalated", "done", "skipped", "failed", "cancelled", "interrupted"];
export declare const RUN_GATE_KIND_VALUES: readonly ["epic_plan", "escalation", "bash_permission", "budget_overrun"];
export declare const RUN_GATE_STATUS_VALUES: readonly ["pending", "approved", "rejected", "revise_requested", "skipped", "expired"];
export declare const COMMITTEE_VERDICT_VALUES: readonly ["approve", "revise", "redelegate", "escalate"];
export declare const RunUsageSchema: z.ZodObject<{
    inputTokens: z.ZodNumber;
    outputTokens: z.ZodNumber;
    cacheReadTokens: z.ZodNumber;
    cacheCreationTokens: z.ZodNumber;
    costUsd: z.ZodNumber;
    pricedCostUsd: z.ZodNumber;
    effectiveUsd: z.ZodNumber;
    unknownCostTurns: z.ZodNumber;
}, z.core.$strip>;
export declare const RunUsageRollupSchema: z.ZodObject<{
    total: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        pricedCostUsd: z.ZodNumber;
        effectiveUsd: z.ZodNumber;
        unknownCostTurns: z.ZodNumber;
    }, z.core.$strip>;
    byRole: z.ZodRecord<z.ZodString, z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        pricedCostUsd: z.ZodNumber;
        effectiveUsd: z.ZodNumber;
        unknownCostTurns: z.ZodNumber;
    }, z.core.$strip>>;
    byModel: z.ZodRecord<z.ZodString, z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        pricedCostUsd: z.ZodNumber;
        effectiveUsd: z.ZodNumber;
        unknownCostTurns: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const RunBudgetSchema: z.ZodObject<{
    capUsd: z.ZodNullable<z.ZodNumber>;
    spentUsd: z.ZodNumber;
    state: z.ZodEnum<{
        ok: "ok";
        capped: "capped";
        warned: "warned";
    }>;
}, z.core.$strip>;
export declare const RunGateSchema: z.ZodObject<{
    gateId: z.ZodString;
    runId: z.ZodString;
    nodeId: z.ZodNullable<z.ZodString>;
    kind: z.ZodEnum<{
        epic_plan: "epic_plan";
        escalation: "escalation";
        bash_permission: "bash_permission";
        budget_overrun: "budget_overrun";
    }>;
    status: z.ZodEnum<{
        pending: "pending";
        approved: "approved";
        rejected: "rejected";
        skipped: "skipped";
        revise_requested: "revise_requested";
        expired: "expired";
    }>;
    summary: z.ZodString;
    detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    budgetUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    openedAt: z.ZodNumber;
    resolvedAt: z.ZodNullable<z.ZodNumber>;
    resolvedBy: z.ZodNullable<z.ZodEnum<{
        user: "user";
        policy: "policy";
    }>>;
    note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const RunNodeSchema: z.ZodObject<{
    nodeId: z.ZodString;
    runId: z.ZodString;
    title: z.ZodString;
    role: z.ZodString;
    provider: z.ZodNullable<z.ZodString>;
    model: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        done: "done";
        failed: "failed";
        interrupted: "interrupted";
        cancelled: "cancelled";
        pending: "pending";
        skipped: "skipped";
        escalated: "escalated";
        executing: "executing";
        spawning: "spawning";
        briefing: "briefing";
        poa_review: "poa_review";
        result_review: "result_review";
        respawning: "respawning";
        merging: "merging";
        conflict_fixup: "conflict_fixup";
    }>;
    attempt: z.ZodNumber;
    committeeIterations: z.ZodNumber;
    sessionId: z.ZodNullable<z.ZodString>;
    worktreePath: z.ZodNullable<z.ZodString>;
    branch: z.ZodNullable<z.ZodString>;
    planSummary: z.ZodNullable<z.ZodString>;
    resultSummary: z.ZodNullable<z.ZodString>;
    usage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        pricedCostUsd: z.ZodNumber;
        effectiveUsd: z.ZodNumber;
        unknownCostTurns: z.ZodNumber;
    }, z.core.$strip>>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$loose>;
export declare const RunTimelineEntrySchema: z.ZodObject<{
    seq: z.ZodNumber;
    at: z.ZodNumber;
    kind: z.ZodString;
    nodeId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    gateId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        approve: "approve";
        revise: "revise";
        redelegate: "redelegate";
        escalate: "escalate";
    }>>>;
    summary: z.ZodString;
    detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const RunReportSchema: z.ZodObject<{
    json: z.ZodString;
    markdown: z.ZodString;
}, z.core.$strip>;
export declare const RunSummarySchema: z.ZodObject<{
    runId: z.ZodString;
    title: z.ZodString;
    preset: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        failed: "failed";
        cancelled: "cancelled";
        completed: "completed";
        created: "created";
        planning: "planning";
        plan_review: "plan_review";
        executing: "executing";
        paused: "paused";
        budget_paused: "budget_paused";
        synthesizing: "synthesizing";
        cancelling: "cancelling";
        suspended: "suspended";
    }>;
    cwd: z.ZodString;
    epicPromptPreview: z.ZodString;
    architect: z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strip>;
    budget: z.ZodObject<{
        capUsd: z.ZodNullable<z.ZodNumber>;
        spentUsd: z.ZodNumber;
        state: z.ZodEnum<{
            ok: "ok";
            capped: "capped";
            warned: "warned";
        }>;
    }, z.core.$strip>;
    usage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        pricedCostUsd: z.ZodNumber;
        effectiveUsd: z.ZodNumber;
        unknownCostTurns: z.ZodNumber;
    }, z.core.$strip>;
    nodeCounts: z.ZodObject<{
        total: z.ZodNumber;
        running: z.ZodNumber;
        done: z.ZodNumber;
        failed: z.ZodNumber;
    }, z.core.$strip>;
    pendingUserGates: z.ZodNumber;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$loose>;
export declare const RunDetailSchema: z.ZodObject<{
    runId: z.ZodString;
    title: z.ZodString;
    preset: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        failed: "failed";
        cancelled: "cancelled";
        completed: "completed";
        created: "created";
        planning: "planning";
        plan_review: "plan_review";
        executing: "executing";
        paused: "paused";
        budget_paused: "budget_paused";
        synthesizing: "synthesizing";
        cancelling: "cancelling";
        suspended: "suspended";
    }>;
    cwd: z.ZodString;
    epicPromptPreview: z.ZodString;
    architect: z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strip>;
    budget: z.ZodObject<{
        capUsd: z.ZodNullable<z.ZodNumber>;
        spentUsd: z.ZodNumber;
        state: z.ZodEnum<{
            ok: "ok";
            capped: "capped";
            warned: "warned";
        }>;
    }, z.core.$strip>;
    usage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        pricedCostUsd: z.ZodNumber;
        effectiveUsd: z.ZodNumber;
        unknownCostTurns: z.ZodNumber;
    }, z.core.$strip>;
    nodeCounts: z.ZodObject<{
        total: z.ZodNumber;
        running: z.ZodNumber;
        done: z.ZodNumber;
        failed: z.ZodNumber;
    }, z.core.$strip>;
    pendingUserGates: z.ZodNumber;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    epicPrompt: z.ZodString;
    nodes: z.ZodArray<z.ZodObject<{
        nodeId: z.ZodString;
        runId: z.ZodString;
        title: z.ZodString;
        role: z.ZodString;
        provider: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            done: "done";
            failed: "failed";
            interrupted: "interrupted";
            cancelled: "cancelled";
            pending: "pending";
            skipped: "skipped";
            escalated: "escalated";
            executing: "executing";
            spawning: "spawning";
            briefing: "briefing";
            poa_review: "poa_review";
            result_review: "result_review";
            respawning: "respawning";
            merging: "merging";
            conflict_fixup: "conflict_fixup";
        }>;
        attempt: z.ZodNumber;
        committeeIterations: z.ZodNumber;
        sessionId: z.ZodNullable<z.ZodString>;
        worktreePath: z.ZodNullable<z.ZodString>;
        branch: z.ZodNullable<z.ZodString>;
        planSummary: z.ZodNullable<z.ZodString>;
        resultSummary: z.ZodNullable<z.ZodString>;
        usage: z.ZodOptional<z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$loose>>;
    gates: z.ZodArray<z.ZodObject<{
        gateId: z.ZodString;
        runId: z.ZodString;
        nodeId: z.ZodNullable<z.ZodString>;
        kind: z.ZodEnum<{
            epic_plan: "epic_plan";
            escalation: "escalation";
            bash_permission: "bash_permission";
            budget_overrun: "budget_overrun";
        }>;
        status: z.ZodEnum<{
            pending: "pending";
            approved: "approved";
            rejected: "rejected";
            skipped: "skipped";
            revise_requested: "revise_requested";
            expired: "expired";
        }>;
        summary: z.ZodString;
        detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        budgetUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        openedAt: z.ZodNumber;
        resolvedAt: z.ZodNullable<z.ZodNumber>;
        resolvedBy: z.ZodNullable<z.ZodEnum<{
            user: "user";
            policy: "policy";
        }>>;
        note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$loose>>;
    timeline: z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        at: z.ZodNumber;
        kind: z.ZodString;
        nodeId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        gateId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            approve: "approve";
            revise: "revise";
            redelegate: "redelegate";
            escalate: "escalate";
        }>>>;
        summary: z.ZodString;
        detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$loose>>;
    usageRollup: z.ZodObject<{
        total: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>;
        byRole: z.ZodRecord<z.ZodString, z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>>;
        byModel: z.ZodRecord<z.ZodString, z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    meteringGaps: z.ZodArray<z.ZodString>;
    baselineEffectiveUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    verdictQuality: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    report: z.ZodOptional<z.ZodObject<{
        json: z.ZodString;
        markdown: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ServerOrchestrationRunsSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_runs_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    runs: z.ZodArray<z.ZodObject<{
        runId: z.ZodString;
        title: z.ZodString;
        preset: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            failed: "failed";
            cancelled: "cancelled";
            completed: "completed";
            created: "created";
            planning: "planning";
            plan_review: "plan_review";
            executing: "executing";
            paused: "paused";
            budget_paused: "budget_paused";
            synthesizing: "synthesizing";
            cancelling: "cancelling";
            suspended: "suspended";
        }>;
        cwd: z.ZodString;
        epicPromptPreview: z.ZodString;
        architect: z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
        }, z.core.$strip>;
        budget: z.ZodObject<{
            capUsd: z.ZodNullable<z.ZodNumber>;
            spentUsd: z.ZodNumber;
            state: z.ZodEnum<{
                ok: "ok";
                capped: "capped";
                warned: "warned";
            }>;
        }, z.core.$strip>;
        usage: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>;
        nodeCounts: z.ZodObject<{
            total: z.ZodNumber;
            running: z.ZodNumber;
            done: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
        pendingUserGates: z.ZodNumber;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$loose>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ServerOrchestrationRunSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    seq: z.ZodNumber;
    run: z.ZodNullable<z.ZodObject<{
        runId: z.ZodString;
        title: z.ZodString;
        preset: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            failed: "failed";
            cancelled: "cancelled";
            completed: "completed";
            created: "created";
            planning: "planning";
            plan_review: "plan_review";
            executing: "executing";
            paused: "paused";
            budget_paused: "budget_paused";
            synthesizing: "synthesizing";
            cancelling: "cancelling";
            suspended: "suspended";
        }>;
        cwd: z.ZodString;
        epicPromptPreview: z.ZodString;
        architect: z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
        }, z.core.$strip>;
        budget: z.ZodObject<{
            capUsd: z.ZodNullable<z.ZodNumber>;
            spentUsd: z.ZodNumber;
            state: z.ZodEnum<{
                ok: "ok";
                capped: "capped";
                warned: "warned";
            }>;
        }, z.core.$strip>;
        usage: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>;
        nodeCounts: z.ZodObject<{
            total: z.ZodNumber;
            running: z.ZodNumber;
            done: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
        pendingUserGates: z.ZodNumber;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        epicPrompt: z.ZodString;
        nodes: z.ZodArray<z.ZodObject<{
            nodeId: z.ZodString;
            runId: z.ZodString;
            title: z.ZodString;
            role: z.ZodString;
            provider: z.ZodNullable<z.ZodString>;
            model: z.ZodNullable<z.ZodString>;
            status: z.ZodEnum<{
                done: "done";
                failed: "failed";
                interrupted: "interrupted";
                cancelled: "cancelled";
                pending: "pending";
                skipped: "skipped";
                escalated: "escalated";
                executing: "executing";
                spawning: "spawning";
                briefing: "briefing";
                poa_review: "poa_review";
                result_review: "result_review";
                respawning: "respawning";
                merging: "merging";
                conflict_fixup: "conflict_fixup";
            }>;
            attempt: z.ZodNumber;
            committeeIterations: z.ZodNumber;
            sessionId: z.ZodNullable<z.ZodString>;
            worktreePath: z.ZodNullable<z.ZodString>;
            branch: z.ZodNullable<z.ZodString>;
            planSummary: z.ZodNullable<z.ZodString>;
            resultSummary: z.ZodNullable<z.ZodString>;
            usage: z.ZodOptional<z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadTokens: z.ZodNumber;
                cacheCreationTokens: z.ZodNumber;
                costUsd: z.ZodNumber;
                pricedCostUsd: z.ZodNumber;
                effectiveUsd: z.ZodNumber;
                unknownCostTurns: z.ZodNumber;
            }, z.core.$strip>>;
            createdAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
        }, z.core.$loose>>;
        gates: z.ZodArray<z.ZodObject<{
            gateId: z.ZodString;
            runId: z.ZodString;
            nodeId: z.ZodNullable<z.ZodString>;
            kind: z.ZodEnum<{
                epic_plan: "epic_plan";
                escalation: "escalation";
                bash_permission: "bash_permission";
                budget_overrun: "budget_overrun";
            }>;
            status: z.ZodEnum<{
                pending: "pending";
                approved: "approved";
                rejected: "rejected";
                skipped: "skipped";
                revise_requested: "revise_requested";
                expired: "expired";
            }>;
            summary: z.ZodString;
            detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            budgetUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            openedAt: z.ZodNumber;
            resolvedAt: z.ZodNullable<z.ZodNumber>;
            resolvedBy: z.ZodNullable<z.ZodEnum<{
                user: "user";
                policy: "policy";
            }>>;
            note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$loose>>;
        timeline: z.ZodArray<z.ZodObject<{
            seq: z.ZodNumber;
            at: z.ZodNumber;
            kind: z.ZodString;
            nodeId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            gateId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
                approve: "approve";
                revise: "revise";
                redelegate: "redelegate";
                escalate: "escalate";
            }>>>;
            summary: z.ZodString;
            detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$loose>>;
        usageRollup: z.ZodObject<{
            total: z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadTokens: z.ZodNumber;
                cacheCreationTokens: z.ZodNumber;
                costUsd: z.ZodNumber;
                pricedCostUsd: z.ZodNumber;
                effectiveUsd: z.ZodNumber;
                unknownCostTurns: z.ZodNumber;
            }, z.core.$strip>;
            byRole: z.ZodRecord<z.ZodString, z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadTokens: z.ZodNumber;
                cacheCreationTokens: z.ZodNumber;
                costUsd: z.ZodNumber;
                pricedCostUsd: z.ZodNumber;
                effectiveUsd: z.ZodNumber;
                unknownCostTurns: z.ZodNumber;
            }, z.core.$strip>>;
            byModel: z.ZodRecord<z.ZodString, z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadTokens: z.ZodNumber;
                cacheCreationTokens: z.ZodNumber;
                costUsd: z.ZodNumber;
                pricedCostUsd: z.ZodNumber;
                effectiveUsd: z.ZodNumber;
                unknownCostTurns: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        meteringGaps: z.ZodArray<z.ZodString>;
        baselineEffectiveUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        verdictQuality: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        report: z.ZodOptional<z.ZodObject<{
            json: z.ZodString;
            markdown: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$loose>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ServerOrchestrationRunDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_run_delta">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    generatedAt: z.ZodString;
    run: z.ZodOptional<z.ZodObject<{
        runId: z.ZodString;
        title: z.ZodString;
        preset: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            failed: "failed";
            cancelled: "cancelled";
            completed: "completed";
            created: "created";
            planning: "planning";
            plan_review: "plan_review";
            executing: "executing";
            paused: "paused";
            budget_paused: "budget_paused";
            synthesizing: "synthesizing";
            cancelling: "cancelling";
            suspended: "suspended";
        }>;
        cwd: z.ZodString;
        epicPromptPreview: z.ZodString;
        architect: z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
        }, z.core.$strip>;
        budget: z.ZodObject<{
            capUsd: z.ZodNullable<z.ZodNumber>;
            spentUsd: z.ZodNumber;
            state: z.ZodEnum<{
                ok: "ok";
                capped: "capped";
                warned: "warned";
            }>;
        }, z.core.$strip>;
        usage: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>;
        nodeCounts: z.ZodObject<{
            total: z.ZodNumber;
            running: z.ZodNumber;
            done: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
        pendingUserGates: z.ZodNumber;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$loose>>;
    node: z.ZodOptional<z.ZodObject<{
        nodeId: z.ZodString;
        runId: z.ZodString;
        title: z.ZodString;
        role: z.ZodString;
        provider: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            done: "done";
            failed: "failed";
            interrupted: "interrupted";
            cancelled: "cancelled";
            pending: "pending";
            skipped: "skipped";
            escalated: "escalated";
            executing: "executing";
            spawning: "spawning";
            briefing: "briefing";
            poa_review: "poa_review";
            result_review: "result_review";
            respawning: "respawning";
            merging: "merging";
            conflict_fixup: "conflict_fixup";
        }>;
        attempt: z.ZodNumber;
        committeeIterations: z.ZodNumber;
        sessionId: z.ZodNullable<z.ZodString>;
        worktreePath: z.ZodNullable<z.ZodString>;
        branch: z.ZodNullable<z.ZodString>;
        planSummary: z.ZodNullable<z.ZodString>;
        resultSummary: z.ZodNullable<z.ZodString>;
        usage: z.ZodOptional<z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            pricedCostUsd: z.ZodNumber;
            effectiveUsd: z.ZodNumber;
            unknownCostTurns: z.ZodNumber;
        }, z.core.$strip>>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$loose>>;
    gate: z.ZodOptional<z.ZodObject<{
        gateId: z.ZodString;
        runId: z.ZodString;
        nodeId: z.ZodNullable<z.ZodString>;
        kind: z.ZodEnum<{
            epic_plan: "epic_plan";
            escalation: "escalation";
            bash_permission: "bash_permission";
            budget_overrun: "budget_overrun";
        }>;
        status: z.ZodEnum<{
            pending: "pending";
            approved: "approved";
            rejected: "rejected";
            skipped: "skipped";
            revise_requested: "revise_requested";
            expired: "expired";
        }>;
        summary: z.ZodString;
        detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        budgetUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        openedAt: z.ZodNumber;
        resolvedAt: z.ZodNullable<z.ZodNumber>;
        resolvedBy: z.ZodNullable<z.ZodEnum<{
            user: "user";
            policy: "policy";
        }>>;
        note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$loose>>;
    timeline: z.ZodOptional<z.ZodObject<{
        seq: z.ZodNumber;
        at: z.ZodNumber;
        kind: z.ZodString;
        nodeId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        gateId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        verdict: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            approve: "approve";
            revise: "revise";
            redelegate: "redelegate";
            escalate: "escalate";
        }>>>;
        summary: z.ZodString;
        detail: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const ServerOrchestrationActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"orchestration_action_ack">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    action: z.ZodEnum<{
        start: "start";
        cancel: "cancel";
        pause: "pause";
        resume: "resume";
        gate_response: "gate_response";
        annotate: "annotate";
    }>;
    runId: z.ZodString;
    gateId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type RunUsage = z.infer<typeof RunUsageSchema>;
export type RunUsageRollup = z.infer<typeof RunUsageRollupSchema>;
export type RunBudget = z.infer<typeof RunBudgetSchema>;
export type RunGate = z.infer<typeof RunGateSchema>;
export type RunNode = z.infer<typeof RunNodeSchema>;
export type RunTimelineEntry = z.infer<typeof RunTimelineEntrySchema>;
export type RunReport = z.infer<typeof RunReportSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type ServerOrchestrationRunsSnapshot = z.infer<typeof ServerOrchestrationRunsSnapshotSchema>;
export type ServerOrchestrationRunSnapshot = z.infer<typeof ServerOrchestrationRunSnapshotSchema>;
export type ServerOrchestrationRunDelta = z.infer<typeof ServerOrchestrationRunDeltaSchema>;
export type ServerOrchestrationActionAck = z.infer<typeof ServerOrchestrationActionAckSchema>;
