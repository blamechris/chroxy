/**
 * Host/Repo Status (#5171), Mailbox (#5914), External Sessions (#5969), and per-repo Session Presets (#5553) Control Room surveys — the host-level mission-control pull surveys plus the session-preset disclosure/snapshot shapes.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
// ───────────────────────────────────────────────────────────────────────────
// Host/Repo Status Control Room (#5170 epic, #5171 protocol contract)
// ───────────────────────────────────────────────────────────────────────────
//
// Wire contract for the Host/Repo Status survey: a one-shot, pull-driven picture
// of every repo the host knows about — `config.repos` unioned with repos
// auto-discovered under a configurable root (default `~/Projects`). Each repo is
// classified into a `verdict` (live / investigate / abandoned / recent /
// onboarded) so the Control Room can colour-code the table and surface "needs
// attention" repos without the client re-deriving the heuristic.
//
// This file defines ONLY the schemas/types (issue #5171). The server emitter,
// store-core reducer, and dashboard panel consume these in sibling issues of the
// #5170 epic.
//
// Flow: the client sends `host_status_request` (see client.ts) — typically the
// Refresh button — and the server replies with exactly one
// `host_status_snapshot`. There is no delta stream (unlike the activity tree):
// the survey is cheap-enough-to-resend and the table is small, so a full
// snapshot per refresh keeps both sides trivial.
//
// Forward/back compat: all schemas strip unknown fields (Zod default) so an
// older client parsing a newer server's payload silently ignores fields it
// doesn't recognise, and a client predating these message types ignores the
// unknown `type` at the dispatch layer.
/**
 * Verdict for a repo — the survey's classification of "what is this repo's
 * current state". Drives the colour-coded tag in the Control Room table:
 *   - `'live'`        — actively worked (a chroxy session is/was recently running).
 *   - `'investigate'` — ambiguous state worth a human look (e.g. dirty tree on a
 *                       repo with no recent activity).
 *   - `'abandoned'`   — likely abandoned (no recent activity, nothing in flight).
 *   - `'recent'`      — touched recently but not classified as live.
 *   - `'onboarded'`   — set up / onboarded (has the expected chroxy scaffolding)
 *                       but not currently active.
 *
 * Declared as a named enum so downstream consumers can switch exhaustively.
 */
export const RepoVerdictSchema = z.enum([
    'live',
    'investigate',
    'abandoned',
    'recent',
    'onboarded',
]);
/**
 * Working-tree cleanliness summary for a repo:
 *   - `state`     — `'clean'` (nothing to commit) or `'dirty'` (anything staged,
 *                   modified, or untracked).
 *   - `untracked` — count of untracked files.
 *   - `modified`  — count of tracked-but-modified (unstaged) files.
 *   - `staged`    — count of staged (index) changes.
 *
 * Counts are non-negative integers. `state` is carried explicitly (rather than
 * derived from the counts) so the server's notion of clean/dirty is the
 * authority — e.g. a repo may be "dirty" for a reason the three counts don't
 * capture, and the consumer should not re-derive it.
 */
export const RepoTreeSchema = z.object({
    state: z.enum(['clean', 'dirty']),
    untracked: z.number().int().nonnegative().finite(),
    modified: z.number().int().nonnegative().finite(),
    staged: z.number().int().nonnegative().finite(),
});
/**
 * One row in the Host/Repo Status table.
 *
 * Fields:
 *   - `name`        — display name for the repo (typically the directory name).
 *   - `path`        — absolute path on the host.
 *   - `branch`      — current branch (or detached-HEAD description).
 *   - `verdict`     — see `RepoVerdictSchema`.
 *   - `live`        — true while a chroxy session is actively running in this
 *                     repo. Distinct from `verdict === 'live'`: `verdict` is the
 *                     survey's classification (may persist after the session
 *                     ends), `live` is the instantaneous "session running now"
 *                     state that drives the green dot.
 *   - `tree`        — see `RepoTreeSchema`.
 *   - `worktrees`   — count of git worktrees attached to this repo.
 *   - `ahead`       — commits the current branch is AHEAD of its upstream, or
 *                     `null` when there is no upstream / it can't be determined
 *                     (detached HEAD, no tracking branch). `null` ≠ 0.
 *   - `behind`      — commits the current branch is BEHIND its upstream, same
 *                     `null` semantics as `ahead`. `null` ≠ 0.
 *   - `openPRs`     — number of open PRs, or `null` when unknown (e.g. no GitHub
 *                     remote, or the lookup was skipped/failed). `null` ≠ 0.
 *   - `prChecks`    — rollup of CI + review state across this repo's open PRs
 *                     (counts of open PRs that are CI-failing / CI-pending /
 *                     review-approved / changes-requested), or `null` when the
 *                     PR lookup was skipped/failed (same condition as a `null`
 *                     `openPRs`). All-zero counts mean none of the tracked
 *                     signals are present — this covers both "no open PRs" and
 *                     PRs that only carry untracked states (e.g. passing CI with
 *                     a `REVIEW_REQUIRED` decision). `null` ≠ all-zero.
 *   - `prsUrl`      — the repo's GitHub pull-requests URL
 *                     (`https://github.com/<owner>/<repo>/pulls`), derived from
 *                     the `origin` remote, or `null` when there's no GitHub
 *                     `origin` remote / it couldn't be determined. Powers the
 *                     "View PRs" row action.
 *   - `attribution` — whether commits carry the expected author attribution, or
 *                     `null` when not evaluated. `null` ≠ false.
 *   - `onboarding`  — human-readable onboarding state (free-form so the survey
 *                     can describe partial/odd setups without a wire change).
 *   - `lastTouched` — ISO-8601 timestamp of the most recent activity used to
 *                     classify the verdict.
 *   - `note?`       — optional annotation rendered as the `↳` sub-row under the
 *                     repo (e.g. "dirty tree, last touched 3 weeks ago").
 */
export const RepoStatusSchema = z.object({
    name: z.string(),
    path: z.string(),
    branch: z.string(),
    verdict: RepoVerdictSchema,
    live: z.boolean(),
    tree: RepoTreeSchema,
    worktrees: z.number().int().nonnegative().finite(),
    ahead: z.number().int().nonnegative().finite().nullable(),
    behind: z.number().int().nonnegative().finite().nullable(),
    openPRs: z.number().int().nonnegative().finite().nullable(),
    prChecks: z
        .object({
        failing: z.number().int().nonnegative().finite(),
        pending: z.number().int().nonnegative().finite(),
        approved: z.number().int().nonnegative().finite(),
        changesRequested: z.number().int().nonnegative().finite(),
    })
        .nullable(),
    // Constrained to the GitHub pulls-page shape (not a generic URL): this value
    // is rendered into an <a href>, and `z.string().url()` would accept dangerous
    // schemes like `javascript:`. Owner/repo are single path segments.
    prsUrl: z
        .string()
        .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pulls$/, 'must be a GitHub pull-requests URL')
        .nullable(),
    attribution: z.boolean().nullable(),
    onboarding: z.string(),
    lastTouched: z.string().datetime(),
    note: z.string().optional(),
});
/**
 * Aggregate counts across the surveyed repos, one per verdict bucket. Carried
 * alongside `repos` so the Control Room's summary chips don't have to re-tally
 * the array (and stay consistent with the server's own count even if a future
 * server truncates the `repos` list). All non-negative integers.
 */
export const HostStatusSummarySchema = z.object({
    live: z.number().int().nonnegative().finite(),
    onboarded: z.number().int().nonnegative().finite(),
    abandoned: z.number().int().nonnegative().finite(),
    investigate: z.number().int().nonnegative().finite(),
    recent: z.number().int().nonnegative().finite(),
});
/**
 * #5171 — full Host/Repo Status snapshot. Emitted in reply to a
 * `host_status_request` (see client.ts). Carries the survey root, the aggregate
 * `summary`, and the per-repo `repos` rows. `generatedAt` is the ISO-8601 time
 * the survey ran so the Control Room can render "generated Nm ago" and detect a
 * stale snapshot. An empty `repos` array is the valid "no repos found under the
 * root" state — never omitted.
 */
export const ServerHostStatusSnapshotSchema = z.object({
    type: z.literal('host_status_snapshot'),
    generatedAt: z.string().datetime(),
    root: z.string(),
    summary: HostStatusSummarySchema,
    repos: z.array(RepoStatusSchema),
    // #6144: additive degraded-snapshot annotation — on a forbidden/in-progress/
    // failed survey the handler returns an otherwise-valid (empty repos, zeroed
    // summary) snapshot plus this `error`, so the Control Room section can surface
    // the failure typed rather than mistaking it for an empty survey. Mirrors the
    // runner/containers/integrations snapshots.
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
// ---------------------------------------------------------------------------
// Mailbox (#5914 follow-up) — Control Room "Mailbox" tab snapshot.
//
// Reply to a `mailbox_status_request` (see client.ts). Two projections of the
// daemon's in-memory mailbox state: the live `registrations` (which sessions
// are addressable by which agentCommId, and whether each is idle/claude-tui —
// the conditions the live-interrupt route injects under) and a bounded
// `recentEvents` ring buffer of the last deliveries the route attempted (newest
// first). `generatedAt` is the ISO-8601 snapshot time so the tab can render
// "generated Nm ago". Empty arrays are valid (no registrations / no traffic yet).
/** One live agentCommId → session registration row. */
export const MailboxRegistrationSchema = z.object({
    /** The mailbox identity an external sender targets (the route's `to`). */
    agentCommId: z.string(),
    /** The chroxy session it currently resolves to. */
    sessionId: z.string(),
    /** Display name for that session, or null when unnamed. */
    sessionName: z.string().nullable(),
    /** True while the session is mid-turn — the route notifies but does NOT inject. */
    isBusy: z.boolean(),
    /** True when the session can receive a PTY wakeup (claude-tui). */
    isTui: z.boolean(),
});
/** One recorded live-interrupt delivery attempt. */
export const MailboxDeliveryEventSchema = z.object({
    /** Epoch-ms timestamp the ping was handled. */
    at: z.number(),
    /** Recipient mailbox id (the ping's `to`). */
    to: z.string(),
    /** Sender label (the ping's `from`, or 'unknown'). */
    from: z.string(),
    /** Unread count the sender reported, or null when it was absent/invalid. */
    unreadCount: z.number().int().nonnegative().nullable(),
    /** What the route did — mirrors handleMailboxPing's `reason`. */
    outcome: z.enum(['injected', 'busy', 'not-tui', 'no-session', 'pty-dead']),
});
export const ServerMailboxStatusSnapshotSchema = z.object({
    type: z.literal('mailbox_status_snapshot'),
    /** Echoes the request's `requestId` when provided (null otherwise). */
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    registrations: z.array(MailboxRegistrationSchema),
    recentEvents: z.array(MailboxDeliveryEventSchema),
    /** Present only on a refusal (e.g. a session-bound token surveying the host). */
    error: z.object({ code: z.string(), message: z.string() }).optional(),
});
// ───────────────────────────────────────────────────────────────────────────
// #5969 (epic #5422 phase 4) — Control Room mission control: LIVE external
// Claude Code sessions ingested via `POST /api/events` (#5413), surfaced as
// READ-ONLY entries. Fidelity is whatever the hook stream provides — no
// PTY/control handle exists for a session chroxy didn't launch, so `status` is
// only 'running' (a turn is in flight) or 'idle' (external sessions can't
// surface 'blocked'/'failed').
// ───────────────────────────────────────────────────────────────────────────
/** One live external session (derived from the /api/events hook stream). */
export const ExternalSessionEntrySchema = z.object({
    /** Emitter source from the event envelope (e.g. 'cli', 'vscode'). */
    source: z.string(),
    sessionId: z.string(),
    /** Display name: project → cwd basename → short session id. */
    name: z.string(),
    project: z.string().nullable(),
    cwd: z.string().nullable(),
    status: z.enum(['running', 'idle']),
    /** Active subagent count folded from subagent_start/subagent_stop. */
    subagents: z.number().int().nonnegative(),
    /** Newest event time (epoch ms). */
    lastActivityTs: z.number(),
}).passthrough();
export const ServerExternalSessionsSnapshotSchema = z.object({
    type: z.literal('external_sessions_snapshot'),
    /** Echoes the request's `requestId` when provided (null otherwise). */
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    sessions: z.array(ExternalSessionEntrySchema),
    /** Present only on a refusal (e.g. a session-bound token surveying the host). */
    error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough();
// ---------------------------------------------------------------------------
// #5553: per-repo session preset surfaces.
//
// Two distinct projections of the resolved preset cross the wire:
//   - on `session_switched` (create confirm): the DISCLOSURE shape — length-only
//     preamble (the text is already folded into the prompt server-side) plus the
//     seed text (staged editable into the composer) + trust metadata. See
//     `ServerSessionPresetDisclosureSchema`.
//   - on `session_preset_snapshot` (the per-repo drawer's read/write reply): the
//     FULL shape including preamble + seed text so the operator can preview/edit
//     the daemon override. This only reaches HOST-level clients (server gate).
//
// `source` is 'daemon' (a pre-trusted override in ~/.chroxy/config.json) or
// 'repo' (a trust-gated `.chroxy/session.json`). `trustState` is 'trusted'
// (active) or 'pending' (inert until approved). `active` = trusted && enabled —
// only an active preset folds its preamble + stages its seed.
export const ServerSessionPresetDisclosureSchema = z.object({
    source: z.enum(['daemon', 'repo']),
    active: z.boolean(),
    trustState: z.enum(['trusted', 'pending']),
    enabled: z.boolean(),
    seed: z.string(),
    preambleLength: z.number().int().nonnegative(),
    seedLength: z.number().int().nonnegative(),
    capped: z.boolean(),
    repoPath: z.string().nullable(),
});
export const ServerSessionPresetFullSchema = z.object({
    source: z.enum(['daemon', 'repo']),
    active: z.boolean(),
    trustState: z.enum(['trusted', 'pending']),
    enabled: z.boolean(),
    preamble: z.string(),
    seed: z.string(),
    preambleLength: z.number().int().nonnegative(),
    seedLength: z.number().int().nonnegative(),
    capped: z.boolean(),
    repoPath: z.string().nullable(),
});
// Reply to session_preset_get / _set / _approve / _revoke (see client.ts).
// `preset` is null when the repo has no preset at all. `requestId` is echoed
// when the request carried one.
export const ServerSessionPresetSnapshotSchema = z.object({
    type: z.literal('session_preset_snapshot'),
    cwd: z.string().nullable(),
    preset: ServerSessionPresetFullSchema.nullable(),
    requestId: z.string().max(128).optional(),
});
