/**
 * Control Room repo-events pane (#5966, epic #5422 phase 5) — the pull-driven
 * survey shape for GitHub-webhook repo activity (PR / issue / push / ping) the
 * daemon buffers in its bounded `RepoEventStore` (github-webhook.js, #6468).
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). The wire shapes match `normalizeGithubEvent`
 * (github-webhook.js:64) one-for-one so the server can drop a stored event
 * straight onto the wire without a re-shape.
 *
 * Flow: the client sends `repo_events_request` (see client.ts) — the Refresh
 * button / tab activation — and the server replies with exactly one
 * `repo_events_snapshot`. Like the host/mailbox/external-session surveys this is
 * a pull, not a delta stream: the store is small and cheap-to-resend, so a full
 * snapshot per refresh keeps both sides trivial. Live delta broadcast is a
 * deferred PR-2 follow-up.
 */
import { z } from 'zod';
/**
 * One normalized repo-event, matching `normalizeGithubEvent` (github-webhook.js).
 *
 * Fields:
 *   - `kind`    — the surfaced GitHub event type. Only push / pull_request /
 *                 issues / ping are normalized; other event types are accepted-
 *                 and-skipped at ingest, so they never reach this shape.
 *   - `repo`    — the `owner/repo` full name (`payload.repository.full_name`), or
 *                 null when the payload carried no repository (e.g. a bare ping).
 *   - `actor`   — the `sender.login`, or null when absent.
 *   - `at`      — ISO-8601 time the event was normalized (ingest time).
 *   - `branch`  — push only: the short branch name (`refs/heads/…` stripped), or
 *                 null. Absent on non-push events.
 *   - `action`  — pull_request / issues only: the GitHub `action`
 *                 (opened/closed/…), or null.
 *   - `number`  — pull_request / issues only: the PR / issue number, or null.
 *   - `title`   — push (head-commit subject) / PR / issue title, or null.
 *   - `url`     — the html_url for the PR / issue / commit, or null.
 *   - `summary` — a compact human-readable one-liner the server pre-renders
 *                 (e.g. "opened PR #42", "pushed 3 commits to main"). Always
 *                 present so the pane never has to re-derive it.
 *
 * `.passthrough()` so a newer server that adds a field to a normalized event
 * doesn't get it stripped before an older pane can (harmlessly) ignore it.
 */
export declare const RepoEventSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        ping: "ping";
        issues: "issues";
        push: "push";
        pull_request: "pull_request";
    }>;
    repo: z.ZodNullable<z.ZodString>;
    actor: z.ZodNullable<z.ZodString>;
    at: z.ZodString;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    action: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    number: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    summary: z.ZodString;
}, z.core.$loose>;
/**
 * #5966 — full repo-events snapshot. Emitted in reply to a `repo_events_request`
 * (see client.ts). Carries the tail of the daemon's bounded RepoEventStore
 * (most-recent-last) plus `generatedAt` so the pane can render "generated Nm
 * ago" and detect a stale snapshot. An empty `events` array is the valid
 * "nothing buffered yet" state (the store is empty until the first webhook), and
 * `error` is the additive degraded-snapshot annotation — a session-bound token
 * surveying the host gets an otherwise-valid (empty events) snapshot plus this
 * `error`, mirroring the host/mailbox/external-session snapshots.
 */
export declare const ServerRepoEventsSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"repo_events_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    events: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            ping: "ping";
            issues: "issues";
            push: "push";
            pull_request: "pull_request";
        }>;
        repo: z.ZodNullable<z.ZodString>;
        actor: z.ZodNullable<z.ZodString>;
        at: z.ZodString;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        action: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        number: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        summary: z.ZodString;
    }, z.core.$loose>>;
    activeRepos: z.ZodOptional<z.ZodArray<z.ZodString>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #6536 (PR-2 of #5966) — live repo-events delta. Pushed to HOST-level clients
 * (unbound tokens only, mirroring the survey's host-authority gate) when a
 * GitHub webhook delivery lands, so the Control Room pane updates without a
 * Refresh. Unlike the snapshot this is server-INITIATED (no request), carries a
 * single newly-buffered `event`, and has no `error`/`requestId` — a degraded
 * survey still flows through the pull `repo_events_snapshot`. A client that has
 * not yet run the survey ignores the delta (the survey on tab-open fetches the
 * full tail); a client with a snapshot appends the event (bounded).
 */
export declare const ServerRepoEventsDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"repo_events_delta">;
    generatedAt: z.ZodString;
    event: z.ZodObject<{
        kind: z.ZodEnum<{
            ping: "ping";
            issues: "issues";
            push: "push";
            pull_request: "pull_request";
        }>;
        repo: z.ZodNullable<z.ZodString>;
        actor: z.ZodNullable<z.ZodString>;
        at: z.ZodString;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        action: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        number: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        summary: z.ZodString;
    }, z.core.$loose>;
}, z.core.$strip>;
