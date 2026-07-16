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
// --- canonical enums (engine imports these) --------------------------------
// Run lifecycle. `paused` = user-requested pause (orchestration_run_action),
// distinct from `budget_paused` so the UI can render the cause; `suspended` =
// interrupted by a daemon restart and not yet resumed.
export const RUN_STATUS_VALUES = [
    'created', 'planning', 'plan_review', 'executing', 'paused', 'budget_paused',
    'synthesizing', 'cancelling', 'suspended', 'completed', 'failed', 'cancelled',
];
// Subtask ("node") lifecycle incl. the committee gates.
export const RUN_NODE_STATUS_VALUES = [
    'pending', 'spawning', 'briefing', 'poa_review', 'executing', 'result_review',
    'respawning', 'merging', 'conflict_fixup', 'escalated', 'done', 'skipped',
    'failed', 'cancelled', 'interrupted',
];
// User-facing gate kinds. Architect-internal reviews are timeline entries, NOT
// gates — only the user resolves a gate.
export const RUN_GATE_KIND_VALUES = [
    'epic_plan', 'escalation', 'bash_permission', 'budget_overrun',
];
export const RUN_GATE_STATUS_VALUES = [
    'pending', 'approved', 'rejected', 'revise_requested', 'skipped', 'expired',
];
// Committee verdicts an architect returns at a review gate (recorded on the
// timeline; not the same as a user gate decision).
export const COMMITTEE_VERDICT_VALUES = [
    'approve', 'revise', 'redelegate', 'escalate',
];
// --- shared shapes ---------------------------------------------------------
// Per-run usage rollup. A dedicated shape (NOT CumulativeUsage) because runs
// must carry the honesty fields CumulativeUsage can't: provider-reported
// `costUsd` (signed) kept separate from server-derived `pricedCostUsd`, and
// `effectiveUsd` = the display/budget number. `unknownCostTurns` counts turns
// with neither a provider cost nor resolvable pricing.
export const RunUsageSchema = z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    costUsd: z.number().finite(),
    pricedCostUsd: z.number().finite(),
    effectiveUsd: z.number().finite(),
    unknownCostTurns: z.number().int().nonnegative(),
});
export const RunUsageRollupSchema = z.object({
    total: RunUsageSchema,
    byRole: z.record(z.string(), RunUsageSchema),
    byModel: z.record(z.string(), RunUsageSchema),
});
export const RunBudgetSchema = z.object({
    capUsd: z.number().positive().finite().nullable(),
    spentUsd: z.number().finite(), // signed — refund posture matches costUsd (#4099)
    state: z.enum(['ok', 'warned', 'capped']),
});
export const RunGateSchema = z.object({
    gateId: z.string(),
    runId: z.string(),
    nodeId: z.string().nullable(), // null for run-level gates (epic_plan, budget_overrun)
    kind: z.enum(RUN_GATE_KIND_VALUES),
    status: z.enum(RUN_GATE_STATUS_VALUES),
    summary: z.string(), // what is being approved (plan text / overrun figure / command)
    detail: z.string().nullable().optional(),
    budgetUsd: z.number().positive().finite().nullable().optional(), // proposed raise on budget_overrun
    openedAt: z.number(),
    resolvedAt: z.number().nullable(),
    resolvedBy: z.enum(['user', 'policy']).nullable(),
    note: z.string().nullable().optional(),
}).passthrough();
export const RunNodeSchema = z.object({
    nodeId: z.string(),
    runId: z.string(),
    title: z.string(),
    role: z.string(), // config-driven dotted role (architect / worker.audit / worker.implement / ...)
    provider: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(RUN_NODE_STATUS_VALUES),
    attempt: z.number().int().nonnegative(), // re-delegation counter
    committeeIterations: z.number().int().nonnegative(),
    sessionId: z.string().nullable(), // deep-link target; null before spawn / after destroy
    worktreePath: z.string().nullable(),
    branch: z.string().nullable(),
    planSummary: z.string().nullable(), // worker plan-of-attack (pre-execution)
    resultSummary: z.string().nullable(), // worker result summary (post-execution)
    usage: RunUsageSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
}).passthrough();
export const RunTimelineEntrySchema = z.object({
    seq: z.number().int().nonnegative(),
    at: z.number(),
    // display-only, forward-compat by design (z.string(), not enum): 'run_created'
    // 'plan_drafted' 'gate_opened' 'gate_resolved' 'node_status' 'delegation_sent'
    // 'plan_review' 'result_review' 'budget_warning' 'merge' 'error' 'note' ...
    kind: z.string(),
    nodeId: z.string().nullable().optional(),
    gateId: z.string().nullable().optional(),
    verdict: z.enum(COMMITTEE_VERDICT_VALUES).nullable().optional(),
    summary: z.string(),
    detail: z.string().nullable().optional(),
}).passthrough();
export const RunReportSchema = z.object({
    json: z.string(), // serialized report.json
    markdown: z.string(), // rendered report.md
});
export const RunSummarySchema = z.object({
    runId: z.string(),
    title: z.string(),
    preset: z.string().nullable(),
    status: z.enum(RUN_STATUS_VALUES),
    cwd: z.string(),
    epicPromptPreview: z.string(), // first ~280 chars for the list row
    architect: z.object({ provider: z.string(), model: z.string() }),
    budget: RunBudgetSchema,
    usage: RunUsageSchema,
    nodeCounts: z.object({
        total: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
    }),
    pendingUserGates: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
}).passthrough();
export const RunDetailSchema = RunSummarySchema.extend({
    epicPrompt: z.string(),
    nodes: z.array(RunNodeSchema),
    gates: z.array(RunGateSchema),
    timeline: z.array(RunTimelineEntrySchema), // bounded: server sends the last 500
    usageRollup: RunUsageRollupSchema,
    meteringGaps: z.array(z.string()), // sessionIds that ran unmetered (observed spend >= shown)
    baselineEffectiveUsd: z.number().finite().nullable().optional(), // monolithic-session comparison
    verdictQuality: z.string().nullable().optional(),
    report: RunReportSchema.optional(), // present only at terminal state
}).passthrough();
// --- server -> client messages (4) -----------------------------------------
// Reply to orchestration_runs_request. Degraded-snapshot posture: empty runs
// + error when the engine can't produce the list.
export const ServerOrchestrationRunsSnapshotSchema = z.object({
    type: z.literal('orchestration_runs_snapshot'),
    requestId: z.string().max(128).nullable().optional(),
    generatedAt: z.string().datetime(),
    runs: z.array(RunSummarySchema),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough();
// Reply to orchestration_run_detail_request. Carries the wire `seq` high-water
// mark so subsequent deltas can be gap-detected.
export const ServerOrchestrationRunSnapshotSchema = z.object({
    type: z.literal('orchestration_run_snapshot'),
    requestId: z.string().max(128).nullable().optional(),
    generatedAt: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    // nullable: a degraded reply (not_found / a survey failure / a session-bound
    // refusal) carries `run: null` + `error`, mirroring the runs-snapshot's empty
    // `runs` + `error` degraded shape.
    run: RunDetailSchema.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough();
// Server-initiated push (no request). Broadcast to unbound clients only. A
// client holding runId's snapshot applies the upserts iff seq === held.seq + 1,
// else re-requests the snapshot. `run` also updates the runs-list row.
export const ServerOrchestrationRunDeltaSchema = z.object({
    type: z.literal('orchestration_run_delta'),
    runId: z.string(), // routing key — the reducer applies this delta to the held run
    seq: z.number().int().nonnegative(),
    generatedAt: z.string().datetime(),
    run: RunSummarySchema.optional(), // upsert list row + header
    node: RunNodeSchema.optional(), // upsert by nodeId
    gate: RunGateSchema.optional(), // upsert by gateId
    timeline: RunTimelineEntrySchema.optional(), // append
}).passthrough().refine(
// The nested run/node/gate each carry their own runId (they are
// self-describing for rendering). The top-level runId is authoritative for
// routing; reject a delta whose nested runId disagrees so a server bug can't
// file a node/gate under the wrong run.
(m) => (!m.run || m.run.runId === m.runId)
    && (!m.node || m.node.runId === m.runId)
    && (!m.gate || m.gate.runId === m.runId), { message: 'nested run/node/gate runId must match the delta runId' });
// Positive ack for start / gate_response / run_action / annotate.
export const ServerOrchestrationActionAckSchema = z.object({
    type: z.literal('orchestration_action_ack'),
    requestId: z.string().max(128).nullable().optional(),
    action: z.enum(['start', 'gate_response', 'cancel', 'pause', 'resume', 'annotate']),
    runId: z.string(),
    gateId: z.string().optional(),
}).passthrough();
