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
/**
 * #6540 — recent GitHub-webhook delivery readout. `total` is the cumulative
 * count since the daemon started; `verified` / `rejected` are over the retained
 * in-memory window (a bounded ring, so they can be smaller than `total` on a
 * busy daemon). `lastAt` / `lastResult` describe the most recent delivery, or
 * null when nothing has arrived yet. `lastKind` is the `X-GitHub-Event` of the
 * last delivery when known (null for a signature-rejected delivery).
 */
export declare const RepoWebhookDeliveriesSchema: z.ZodObject<{
    total: z.ZodNumber;
    verified: z.ZodNumber;
    rejected: z.ZodNumber;
    lastAt: z.ZodNullable<z.ZodString>;
    lastResult: z.ZodNullable<z.ZodEnum<{
        verified: "verified";
        rejected: "rejected";
    }>>;
    lastKind: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
/**
 * #6540 (item 3 of #6536) — the GitHub webhook-secret config surface reply. Sent
 * in response to `github_webhook_config_request` and after a
 * `github_webhook_set_secret` / `github_webhook_clear_secret` write. The secret
 * value is NEVER included — only whether one is configured and from which source.
 *
 *   - `configured` / `source` — is a secret set, and does it come from the
 *     encrypted store (`store`), a `GITHUB_WEBHOOK_SECRET` env var (`env`), or
 *     nowhere (`none`). A STORED secret always takes precedence over the env
 *     var (the OPPOSITE of the provider-credential env-wins behaviour) —
 *     `resolveWebhookSecret` (github-webhook.js) checks the store first and
 *     only falls back to `env` when nothing is stored. `source: 'env'` in this
 *     reply therefore means the env var is acting as a back-compat fallback,
 *     not that it overrides a stored value. The dashboard currently manages
 *     the secret only while that fallback isn't active; unset the env var and
 *     reconnect to set/rotate a secret from there.
 *   - `payloadUrl` — the fully-qualified `…/api/github/webhook` URL to paste into
 *     GitHub → repo → Settings → Webhooks, derived from the live tunnel URL when
 *     present, else the LAN address. Null only when no origin can be resolved.
 *   - `lanOnly` — true when `payloadUrl` is a LAN/loopback address GitHub cannot
 *     reach (no tunnel active, e.g. `--tunnel none`); `note` explains it.
 *   - `recommendedEvents` — the GitHub event types to subscribe the webhook to.
 *   - `deliveries` — the recent-delivery readout (count / last / verify result).
 *   - `error` — additive degraded-reply annotation (unused for now; reserved for
 *     a future host-authority refusal, mirroring the snapshot shapes).
 */
export declare const ServerGithubWebhookConfigSchema: z.ZodObject<{
    type: z.ZodLiteral<"github_webhook_config">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    configured: z.ZodBoolean;
    source: z.ZodEnum<{
        none: "none";
        store: "store";
        env: "env";
    }>;
    payloadUrl: z.ZodNullable<z.ZodString>;
    lanOnly: z.ZodBoolean;
    note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    recommendedEvents: z.ZodArray<z.ZodString>;
    deliveries: z.ZodObject<{
        total: z.ZodNumber;
        verified: z.ZodNumber;
        rejected: z.ZodNumber;
        lastAt: z.ZodNullable<z.ZodString>;
        lastResult: z.ZodNullable<z.ZodEnum<{
            verified: "verified";
            rejected: "rejected";
        }>>;
        lastKind: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
