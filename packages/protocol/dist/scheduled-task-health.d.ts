/**
 * Scheduled-task HEALTH derivation — the single source of truth for "how is this
 * standing schedule doing?", shared by every surface that reports it (#6871).
 *
 * Why this lives in @chroxy/protocol rather than in each surface: a scheduled
 * task fires an agent session with NOBODY WATCHING, so its status readout is a
 * safety-relevant control surface, not decoration. Two independent copies of the
 * mapping (the `chroxy schedule` CLI's `healthTag()` and the dashboard panel's)
 * would be free to drift, and the drift that matters is one-directional and
 * silent: a surface that forgets a status falls through to a friendlier tag and
 * tells the operator a task is fine when it has never fired, was refused, or has
 * been quarantined. So the mapping is derived ONCE, here, in a Zod-free pure
 * module both a plain-JS server surface and a TypeScript client can import.
 *
 * The tag vocabulary is deliberately IDENTICAL to the CLI's (#6868
 * `cli/schedule-cmd.js healthTag()`) — same seven tags, same precedence,
 * same fallback — so the two surfaces cannot disagree about the same task.
 * `packages/server/tests/scheduled-task-health-parity.test.js` pins them.
 *
 * ── The honest-status invariant ───────────────────────────────────────────────
 * Exactly one tag means "this task ran and it worked": `OK`. Everything else is
 * a state an operator may need to act on. Consequently `isHealthy` is asserted
 * POSITIVELY (tag === 'OK' && !quarantined) rather than by excluding known-bad
 * statuses — a future `lastRun.status` this module has never heard of lands on
 * `ERROR`, never on `OK`. Renderers must key their "good" styling off
 * `isHealthy` / `tone === 'ok'` and never off "not obviously bad".
 */
/**
 * Every tag a surface may render, in rough severity order. Mirrors the CLI's
 * `healthTag()` return set exactly — adding one here without teaching the CLI
 * (or vice versa) fails the parity test.
 */
export declare const SCHEDULED_TASK_HEALTH_TAGS: readonly ["OK", "NEVER RUN", "PAUSED", "SKIPPED", "INTERRUPTED", "TIMEOUT", "REFUSED", "ERROR"];
export type ScheduledTaskHealthTag = (typeof SCHEDULED_TASK_HEALTH_TAGS)[number];
/**
 * Rendering severity. `ok` is reserved for the single healthy tag; `warn` covers
 * "nothing is broken, but the work did not complete" (paused / never fired /
 * slot passed / deliberately stopped); `bad` covers an actual failure or a
 * refusal to run.
 */
export type ScheduledTaskHealthTone = 'ok' | 'warn' | 'bad';
/** The `lastRun.status` values the engine can persist (scheduled-task-store.js). */
export declare const SCHEDULED_TASK_LAST_RUN_STATUSES: readonly ["success", "error", "skipped", "timeout", "refused", "interrupted"];
export type ScheduledTaskLastRunStatus = (typeof SCHEDULED_TASK_LAST_RUN_STATUSES)[number];
/** The minimum shape this module needs; the full task carries much more. */
export interface ScheduledTaskHealthInput {
    readonly enabled?: boolean;
    readonly lastRun?: {
        readonly status?: string | null;
    } | null;
}
export interface ScheduledTaskHealth {
    /** The tag to render. Identical vocabulary + precedence to the CLI's. */
    readonly tag: ScheduledTaskHealthTag;
    /** Severity for styling. Only ever `ok` when {@link isHealthy}. */
    readonly tone: ScheduledTaskHealthTone;
    /** Whether the engine has stopped firing this task until a daemon restart. */
    readonly quarantined: boolean;
    /**
     * The ONLY flag a surface may treat as "this schedule is fine". True only for
     * a successful last run on a task that is neither paused nor quarantined, and
     * that the caller has not reported as unable to fire (see `willNotFire`).
     */
    readonly isHealthy: boolean;
}
/**
 * Derive the health TAG for a task. Pure, total, and never throws — a malformed
 * task (missing/garbage `lastRun`, unknown status) resolves to a pessimistic tag
 * rather than blowing up a list render or reporting `OK` by omission.
 *
 * Precedence is load-bearing and matches the CLI: `enabled === false` wins over
 * any recorded run, because a paused task will not fire again regardless of how
 * its last run went — showing `OK` for a paused schedule is exactly the lie this
 * ordering prevents.
 */
export declare function deriveScheduledTaskHealthTag(task: ScheduledTaskHealthInput | null | undefined): ScheduledTaskHealthTag;
/**
 * Severity for a tag. Only `OK` is `ok`; nothing else can style as healthy.
 *
 * `INTERRUPTED` is `warn`, not `bad`, and that is the point of #7038 rather than
 * an aesthetic call: the defect was that a deliberate Stop was presented as a
 * failure. Giving it its own tag but keeping the failure styling would re-merge
 * it with a crash at the layer an operator actually reads — the colour of the
 * chip. Nothing is broken and nothing needs fixing; the run simply did not
 * finish, which is the same class as `SKIPPED`. It is still never healthy:
 * `isHealthy` is `tag === 'OK'`, so an interrupted run can't read as fine.
 */
export declare function scheduledTaskHealthTone(tag: ScheduledTaskHealthTag): ScheduledTaskHealthTone;
/**
 * Full health readout for a task, including the engine's process-scoped
 * quarantine (which the task record itself cannot express — see
 * `SchedulerEngine.quarantinedTaskIds`).
 *
 * Quarantine deliberately does NOT get its own tag: the tag vocabulary is pinned
 * to the CLI's, and quarantine is engine state rather than task state. It is
 * surfaced as its own flag, and it degrades `tone`/`isHealthy` so a quarantined
 * task can never present as healthy even if its stored `lastRun` still says
 * `success` (the engine's best-effort quarantine write may not have landed —
 * the usual reason to quarantine is that the store is failing).
 *
 * `willNotFire` (#7026) is the second caller-supplied degrade, and takes the
 * same shape for the same reason. The tag answers "how did the last run GO?",
 * never "will this task FIRE?" — the blockers for the latter (a closed global
 * gate / an unarmed engine, a provider the engine refuses) are ambient state
 * this module cannot see from a task record. Left to itself the mapping
 * therefore styles a task green while nothing on the host is firing at all, so
 * a caller that KNOWS the task cannot fire says so and the tone degrades out of
 * `ok`. It only ever degrades: a `bad` tag stays `bad`.
 */
export declare function deriveScheduledTaskHealth(task: ScheduledTaskHealthInput | null | undefined, options?: {
    readonly quarantined?: boolean;
    readonly willNotFire?: boolean;
}): ScheduledTaskHealth;
