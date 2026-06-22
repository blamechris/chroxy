/**
 * Host/Repo Status (#5171), Mailbox (#5914), External Sessions (#5969), and per-repo Session Presets (#5553) Control Room surveys — the host-level mission-control pull surveys plus the session-preset disclosure/snapshot shapes.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
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
export declare const RepoVerdictSchema: z.ZodEnum<{
    live: "live";
    investigate: "investigate";
    abandoned: "abandoned";
    recent: "recent";
    onboarded: "onboarded";
}>;
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
export declare const RepoTreeSchema: z.ZodObject<{
    state: z.ZodEnum<{
        clean: "clean";
        dirty: "dirty";
    }>;
    untracked: z.ZodNumber;
    modified: z.ZodNumber;
    staged: z.ZodNumber;
}, z.core.$strip>;
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
export declare const RepoStatusSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    branch: z.ZodString;
    verdict: z.ZodEnum<{
        live: "live";
        investigate: "investigate";
        abandoned: "abandoned";
        recent: "recent";
        onboarded: "onboarded";
    }>;
    live: z.ZodBoolean;
    tree: z.ZodObject<{
        state: z.ZodEnum<{
            clean: "clean";
            dirty: "dirty";
        }>;
        untracked: z.ZodNumber;
        modified: z.ZodNumber;
        staged: z.ZodNumber;
    }, z.core.$strip>;
    worktrees: z.ZodNumber;
    ahead: z.ZodNullable<z.ZodNumber>;
    behind: z.ZodNullable<z.ZodNumber>;
    openPRs: z.ZodNullable<z.ZodNumber>;
    prChecks: z.ZodNullable<z.ZodObject<{
        failing: z.ZodNumber;
        pending: z.ZodNumber;
        approved: z.ZodNumber;
        changesRequested: z.ZodNumber;
    }, z.core.$strip>>;
    prsUrl: z.ZodNullable<z.ZodString>;
    attribution: z.ZodNullable<z.ZodBoolean>;
    onboarding: z.ZodString;
    lastTouched: z.ZodString;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Aggregate counts across the surveyed repos, one per verdict bucket. Carried
 * alongside `repos` so the Control Room's summary chips don't have to re-tally
 * the array (and stay consistent with the server's own count even if a future
 * server truncates the `repos` list). All non-negative integers.
 */
export declare const HostStatusSummarySchema: z.ZodObject<{
    live: z.ZodNumber;
    onboarded: z.ZodNumber;
    abandoned: z.ZodNumber;
    investigate: z.ZodNumber;
    recent: z.ZodNumber;
}, z.core.$strip>;
/**
 * #5171 — full Host/Repo Status snapshot. Emitted in reply to a
 * `host_status_request` (see client.ts). Carries the survey root, the aggregate
 * `summary`, and the per-repo `repos` rows. `generatedAt` is the ISO-8601 time
 * the survey ran so the Control Room can render "generated Nm ago" and detect a
 * stale snapshot. An empty `repos` array is the valid "no repos found under the
 * root" state — never omitted.
 */
export declare const ServerHostStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_status_snapshot">;
    generatedAt: z.ZodString;
    root: z.ZodString;
    summary: z.ZodObject<{
        live: z.ZodNumber;
        onboarded: z.ZodNumber;
        abandoned: z.ZodNumber;
        investigate: z.ZodNumber;
        recent: z.ZodNumber;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        branch: z.ZodString;
        verdict: z.ZodEnum<{
            live: "live";
            investigate: "investigate";
            abandoned: "abandoned";
            recent: "recent";
            onboarded: "onboarded";
        }>;
        live: z.ZodBoolean;
        tree: z.ZodObject<{
            state: z.ZodEnum<{
                clean: "clean";
                dirty: "dirty";
            }>;
            untracked: z.ZodNumber;
            modified: z.ZodNumber;
            staged: z.ZodNumber;
        }, z.core.$strip>;
        worktrees: z.ZodNumber;
        ahead: z.ZodNullable<z.ZodNumber>;
        behind: z.ZodNullable<z.ZodNumber>;
        openPRs: z.ZodNullable<z.ZodNumber>;
        prChecks: z.ZodNullable<z.ZodObject<{
            failing: z.ZodNumber;
            pending: z.ZodNumber;
            approved: z.ZodNumber;
            changesRequested: z.ZodNumber;
        }, z.core.$strip>>;
        prsUrl: z.ZodNullable<z.ZodString>;
        attribution: z.ZodNullable<z.ZodBoolean>;
        onboarding: z.ZodString;
        lastTouched: z.ZodString;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** One live agentCommId → session registration row. */
export declare const MailboxRegistrationSchema: z.ZodObject<{
    agentCommId: z.ZodString;
    sessionId: z.ZodString;
    sessionName: z.ZodNullable<z.ZodString>;
    isBusy: z.ZodBoolean;
    isTui: z.ZodBoolean;
}, z.core.$strip>;
/** One recorded live-interrupt delivery attempt. */
export declare const MailboxDeliveryEventSchema: z.ZodObject<{
    at: z.ZodNumber;
    to: z.ZodString;
    from: z.ZodString;
    unreadCount: z.ZodNullable<z.ZodNumber>;
    outcome: z.ZodEnum<{
        injected: "injected";
        busy: "busy";
        "not-tui": "not-tui";
        "no-session": "no-session";
        "pty-dead": "pty-dead";
    }>;
}, z.core.$strip>;
export declare const ServerMailboxStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"mailbox_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    registrations: z.ZodArray<z.ZodObject<{
        agentCommId: z.ZodString;
        sessionId: z.ZodString;
        sessionName: z.ZodNullable<z.ZodString>;
        isBusy: z.ZodBoolean;
        isTui: z.ZodBoolean;
    }, z.core.$strip>>;
    recentEvents: z.ZodArray<z.ZodObject<{
        at: z.ZodNumber;
        to: z.ZodString;
        from: z.ZodString;
        unreadCount: z.ZodNullable<z.ZodNumber>;
        outcome: z.ZodEnum<{
            injected: "injected";
            busy: "busy";
            "not-tui": "not-tui";
            "no-session": "no-session";
            "pty-dead": "pty-dead";
        }>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** One live external session (derived from the /api/events hook stream). */
export declare const ExternalSessionEntrySchema: z.ZodObject<{
    source: z.ZodString;
    sessionId: z.ZodString;
    name: z.ZodString;
    project: z.ZodNullable<z.ZodString>;
    cwd: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        running: "running";
        idle: "idle";
    }>;
    subagents: z.ZodNumber;
    lastActivityTs: z.ZodNumber;
}, z.core.$loose>;
export declare const ServerExternalSessionsSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"external_sessions_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    sessions: z.ZodArray<z.ZodObject<{
        source: z.ZodString;
        sessionId: z.ZodString;
        name: z.ZodString;
        project: z.ZodNullable<z.ZodString>;
        cwd: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            running: "running";
            idle: "idle";
        }>;
        subagents: z.ZodNumber;
        lastActivityTs: z.ZodNumber;
    }, z.core.$loose>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ServerSessionPresetDisclosureSchema: z.ZodObject<{
    source: z.ZodEnum<{
        daemon: "daemon";
        repo: "repo";
    }>;
    active: z.ZodBoolean;
    trustState: z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>;
    enabled: z.ZodBoolean;
    seed: z.ZodString;
    preambleLength: z.ZodNumber;
    seedLength: z.ZodNumber;
    capped: z.ZodBoolean;
    repoPath: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSessionPresetFullSchema: z.ZodObject<{
    source: z.ZodEnum<{
        daemon: "daemon";
        repo: "repo";
    }>;
    active: z.ZodBoolean;
    trustState: z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>;
    enabled: z.ZodBoolean;
    preamble: z.ZodString;
    seed: z.ZodString;
    preambleLength: z.ZodNumber;
    seedLength: z.ZodNumber;
    capped: z.ZodBoolean;
    repoPath: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSessionPresetSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preset_snapshot">;
    cwd: z.ZodNullable<z.ZodString>;
    preset: z.ZodNullable<z.ZodObject<{
        source: z.ZodEnum<{
            daemon: "daemon";
            repo: "repo";
        }>;
        active: z.ZodBoolean;
        trustState: z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>;
        enabled: z.ZodBoolean;
        preamble: z.ZodString;
        seed: z.ZodString;
        preambleLength: z.ZodNumber;
        seedLength: z.ZodNumber;
        capped: z.ZodBoolean;
        repoPath: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
