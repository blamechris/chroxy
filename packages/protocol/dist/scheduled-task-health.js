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
export const SCHEDULED_TASK_HEALTH_TAGS = [
    'OK',
    'NEVER RUN',
    'PAUSED',
    'SKIPPED',
    'TIMEOUT',
    'REFUSED',
    'ERROR',
];
/** The `lastRun.status` values the engine can persist (scheduled-task-store.js). */
export const SCHEDULED_TASK_LAST_RUN_STATUSES = [
    'success',
    'error',
    'skipped',
    'timeout',
    'refused',
];
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
export function deriveScheduledTaskHealthTag(task) {
    if (!task || typeof task !== 'object')
        return 'ERROR';
    if (task.enabled === false)
        return 'PAUSED';
    const lastRun = task.lastRun;
    if (!lastRun || typeof lastRun !== 'object')
        return 'NEVER RUN';
    switch (lastRun.status) {
        case 'success':
            return 'OK';
        case 'refused':
            return 'REFUSED';
        case 'skipped':
            return 'SKIPPED';
        case 'timeout':
            return 'TIMEOUT';
        default:
            // `error` AND anything unrecognized. Falling through to the worst
            // plausible tag (never to `OK`) is what keeps a future engine status from
            // silently rendering as healthy on an un-updated surface.
            return 'ERROR';
    }
}
/** Severity for a tag. Only `OK` is `ok`; nothing else can style as healthy. */
export function scheduledTaskHealthTone(tag) {
    switch (tag) {
        case 'OK':
            return 'ok';
        case 'NEVER RUN':
        case 'PAUSED':
        case 'SKIPPED':
            return 'warn';
        default:
            return 'bad';
    }
}
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
export function deriveScheduledTaskHealth(task, options = {}) {
    const tag = deriveScheduledTaskHealthTag(task);
    const quarantined = options.quarantined === true;
    const willNotFire = options.willNotFire === true;
    const tone = quarantined ? 'bad' : scheduledTaskHealthTone(tag);
    return {
        tag,
        tone: willNotFire && tone === 'ok' ? 'warn' : tone,
        quarantined,
        isHealthy: tag === 'OK' && !quarantined && !willNotFire,
    };
}
