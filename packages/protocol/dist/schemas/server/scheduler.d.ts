/**
 * Server -> client schema for the scheduled-tasks panel (#6871, epic #6784).
 *
 * One snapshot type carries the whole surface: the standing registry (#6862), the
 * engine's gate + runtime state (#6865), and the per-task DERIVED safety facts a
 * client must never compute for itself. It doubles as the mutation ack — every
 * accepted `scheduled_task_action` / `set_scheduler_enabled` re-emits the
 * snapshot with the triggering `requestId` echoed, mirroring the way #6998's MCP
 * mutations ack by re-broadcasting `mcp_servers`. Failures come back as a
 * `SCHEDULED_TASK_ACTION_FAILED` / `SCHEDULER_GATE_FAILED` session_error echoing
 * the same `requestId`.
 *
 * ── Why the derived fields are on the wire ────────────────────────────────────
 * A scheduled task fires an agent session with nobody watching, and the engine
 * REFUSES to fire several classes of task (a provider whose permission prompts it
 * cannot answer, a cwd outside the allowlist) while CLAMPING others (a requested
 * permission mode above the unattended floor). Those decisions live in
 * `scheduler.js` — `scheduledProviderRefusalReason()` and
 * `resolveScheduledPermissionMode()` — and a client that re-derived them would be
 * guessing at a safety verdict it does not own. So the server computes them from
 * the real engine helpers and ships the ANSWERS (`providerRefusal`,
 * `effectivePermissionMode`, `permissionModeClamped`, `quarantined`); the client
 * only renders them. `quarantined` in particular CANNOT be derived client-side at
 * all: it is process-scoped engine state that the task record may not reflect.
 *
 * Health TAGS are the one derived value the client computes, using the shared
 * pure helper in `../../scheduled-task-health.ts` — the same module the CLI
 * (#6868) uses, so the two surfaces cannot drift.
 */
import { z } from 'zod';
/**
 * `lastRun.status` values the engine can persist (scheduled-task-store.js's
 * `LAST_RUN_STATUSES`). `refused` = the engine declined to start the run at all;
 * distinct from `error` (it ran and failed) and `skipped` (the slot passed), so a
 * reader can tell an operator that NOTHING ran and the definition needs fixing.
 */
export declare const SCHEDULED_TASK_LAST_RUN_STATUS_VALUES: readonly ["success", "error", "skipped", "timeout", "refused"];
/** Cadence kinds the registry accepts (scheduled-task-store.js's `CADENCE_KINDS`). */
export declare const SCHEDULED_TASK_CADENCE_KIND_VALUES: readonly ["once", "interval", "cron"];
/** Mutations the panel can request. `pause`/`resume` are `enabled` flips. */
export declare const SCHEDULED_TASK_ACTION_VALUES: readonly ["create", "update", "pause", "resume", "delete"];
/** Where the enable gate's current value came from — surfaced so the panel can
 * explain why a config toggle may not take effect (an env var wins). */
export declare const SCHEDULER_GATE_SOURCE_VALUES: readonly ["env", "config", "default"];
/** One-shot at an epoch-ms instant. */
export declare const ScheduledTaskCadenceOnceSchema: z.ZodObject<{
    kind: z.ZodLiteral<"once">;
    at: z.ZodNumber;
}, z.core.$strip>;
/** Fixed interval, optionally phase-anchored. */
export declare const ScheduledTaskCadenceIntervalSchema: z.ZodObject<{
    kind: z.ZodLiteral<"interval">;
    everyMs: z.ZodNumber;
    anchor: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** Five-field cron expression (parsed server-side by schedule-parser.js). */
export declare const ScheduledTaskCadenceCronSchema: z.ZodObject<{
    kind: z.ZodLiteral<"cron">;
    expression: z.ZodString;
}, z.core.$strip>;
export declare const ScheduledTaskCadenceSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"once">;
    at: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"interval">;
    everyMs: z.ZodNumber;
    anchor: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"cron">;
    expression: z.ZodString;
}, z.core.$strip>], "kind">;
/**
 * The session config a run is created with. Every field optional — an absent
 * `provider` means the run lands on the daemon DEFAULT, which is itself usually
 * a provider the engine refuses, hence `defaultProviderRefusal` on the snapshot.
 */
export declare const ScheduledTaskTargetSchema: z.ZodObject<{
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * The outcome of the most recent fire attempt. `status` is deliberately a plain
 * bounded string rather than an enum: an engine that grows a new status must not
 * make the whole snapshot unparseable on an older client, and the shared health
 * helper maps anything unrecognized to `ERROR` (never to `OK`). A quarantined
 * task is persisted here as `{ status: 'refused', error: 'quarantined until
 * daemon restart: …' }`, so the message is the operator's explanation.
 */
export declare const ScheduledTaskLastRunSchema: z.ZodObject<{
    at: z.ZodNumber;
    status: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * One task as the panel sees it: the persisted record plus the server-computed
 * safety verdicts described in the file header.
 *
 *   - `providerRefusal` — verbatim `scheduledProviderRefusalReason()` output for
 *     the provider this task would ACTUALLY resolve to, or null when the engine
 *     would accept it. Non-null means this task will never fire successfully.
 *   - `effectiveProvider` — the provider the engine resolved (the task's own, or
 *     the daemon default), so the panel names the real target.
 *   - `effectivePermissionMode` — `resolveScheduledPermissionMode()` output: what
 *     the run will ACTUALLY use.
 *   - `permissionModeClamped` — true when the stored mode was clamped DOWN to it,
 *     so the panel can say the task does not get the mode it asked for.
 *   - `quarantined` — the engine has stopped firing this task until a daemon
 *     restart (process-scoped; not visible in the record).
 */
export declare const ScheduledTaskSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    enabled: z.ZodBoolean;
    prompt: z.ZodString;
    target: z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
        permissionMode: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    cadence: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"once">;
        at: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"interval">;
        everyMs: z.ZodNumber;
        anchor: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"cron">;
        expression: z.ZodString;
    }, z.core.$strip>], "kind">;
    nextRun: z.ZodNullable<z.ZodNumber>;
    lastRun: z.ZodNullable<z.ZodObject<{
        at: z.ZodNumber;
        status: z.ZodString;
        sessionId: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    providerRefusal: z.ZodNullable<z.ZodString>;
    effectiveProvider: z.ZodNullable<z.ZodString>;
    effectivePermissionMode: z.ZodString;
    permissionModeClamped: z.ZodBoolean;
    quarantined: z.ZodBoolean;
}, z.core.$strip>;
/**
 * The global enable-gate + engine runtime state.
 *
 *   - `enabled` — `isSchedulerEnabled(config)`: whether the gate is OPEN.
 *   - `engineArmed` — whether a live engine is actually armed right now. The two
 *     can disagree, because the engine is built once at daemon boot: flipping the
 *     persisted flag does NOT arm or disarm a running daemon.
 *   - `restartRequired` — that disagreement, named. The panel must show this
 *     rather than letting `enabled` imply anything is firing.
 *   - `source` — `env` when CHROXY_ENABLE_SCHEDULER forced the value (in which
 *     case a config toggle cannot override it), else `config` / `default`.
 */
export declare const SchedulerGateStateSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    engineArmed: z.ZodBoolean;
    restartRequired: z.ZodBoolean;
    source: z.ZodEnum<{
        default: "default";
        config: "config";
        env: "env";
    }>;
}, z.core.$strip>;
/**
 * Full scheduled-tasks snapshot — reply to `scheduled_tasks_request` and the ack
 * for every accepted mutation.
 *
 * `schedulableProviders` is `listSchedulableProviders()` (providers that answer
 * permissions in-process, read off the live registry) and `defaultProvider` /
 * `defaultProviderRefusal` describe where a task with no `target.provider` lands
 * — together they let the create form warn BEFORE a task is saved that the engine
 * will refuse it, instead of the operator discovering it as a silent no-fire.
 *
 * Same degraded-snapshot posture as the Control Room surveys: on a failure the
 * handler still returns a structurally valid (empty) snapshot plus `error`.
 */
export declare const ServerScheduledTasksSchema: z.ZodObject<{
    type: z.ZodLiteral<"scheduled_tasks">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    scheduler: z.ZodObject<{
        enabled: z.ZodBoolean;
        engineArmed: z.ZodBoolean;
        restartRequired: z.ZodBoolean;
        source: z.ZodEnum<{
            default: "default";
            config: "config";
            env: "env";
        }>;
    }, z.core.$strip>;
    schedulableProviders: z.ZodArray<z.ZodString>;
    defaultProvider: z.ZodString;
    defaultProviderRefusal: z.ZodNullable<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        enabled: z.ZodBoolean;
        prompt: z.ZodString;
        target: z.ZodObject<{
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            cwd: z.ZodOptional<z.ZodString>;
            permissionMode: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        cadence: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            at: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"interval">;
            everyMs: z.ZodNumber;
            anchor: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"cron">;
            expression: z.ZodString;
        }, z.core.$strip>], "kind">;
        nextRun: z.ZodNullable<z.ZodNumber>;
        lastRun: z.ZodNullable<z.ZodObject<{
            at: z.ZodNumber;
            status: z.ZodString;
            sessionId: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        providerRefusal: z.ZodNullable<z.ZodString>;
        effectiveProvider: z.ZodNullable<z.ZodString>;
        effectivePermissionMode: z.ZodString;
        permissionModeClamped: z.ZodBoolean;
        quarantined: z.ZodBoolean;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;
export type ScheduledTaskCadence = z.infer<typeof ScheduledTaskCadenceSchema>;
export type ScheduledTaskTarget = z.infer<typeof ScheduledTaskTargetSchema>;
export type ScheduledTaskLastRun = z.infer<typeof ScheduledTaskLastRunSchema>;
export type SchedulerGateState = z.infer<typeof SchedulerGateStateSchema>;
export type ServerScheduledTasksMessage = z.infer<typeof ServerScheduledTasksSchema>;
export type ScheduledTaskAction = (typeof SCHEDULED_TASK_ACTION_VALUES)[number];
