/**
 * Integrations survey (#5499): per-repo repo-memory + repo-relay (#5501) observability, plus the Control Room action acks (integration/containers/byok-pool). Imports ByokPoolLimitsSchema from ./byok.ts for the pool-resize ack.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
import { ByokPoolLimitsSchema } from "./byok.js";
// ---------------------------------------------------------------------------
// #5499 (epic #5498) — Control Room "Integrations" tab: per-repo repo-memory
// observability. Emitted in reply to an `integration_status_request` (see
// client.ts). Same pull-on-Refresh, degraded-snapshot-with-`error` contract as
// the host and runner surveys above.
// ---------------------------------------------------------------------------
/**
 * repo-memory cache file stats for one repo (`.repo-memory/cache.db` plus its
 * `-wal` sidecar). `present` is false when the cache file doesn't exist yet
 * (config without traffic); `sizeBytes` then reports 0. `lastModified` is the
 * newest mtime across the db + wal files (ISO-8601), or null when absent —
 * it doubles as a "last activity" proxy because the telemetry report carries
 * no timestamp of its own.
 */
export const RepoMemoryCacheSchema = z.object({
    present: z.boolean(),
    sizeBytes: z.number().int().nonnegative().finite(),
    lastModified: z.string().datetime().nullable(),
});
/**
 * The repo-memory telemetry report for one repo, distilled from
 * `repo-memory report <repoRoot> --json --diagnostics`. Field names follow the
 * CLI's TokenReport shape (verified against `@blamechris/repo-memory` 0.15.0).
 * The diagnostics-derived fields (`cacheEntryCount` / `staleEntryCount`) are
 * nullable because older CLI versions may omit the `diagnostics` block.
 * `lastActivity` is the newest telemetry timestamp when the CLI reports one
 * (current versions don't — then it stays null and consumers fall back to
 * `cache.lastModified`).
 */
export const RepoMemoryReportSchema = z.object({
    totalEvents: z.number().int().nonnegative().finite(),
    cacheHits: z.number().int().nonnegative().finite(),
    cacheMisses: z.number().int().nonnegative().finite(),
    cacheHitRatio: z.number().min(0).max(1),
    estimatedTokensSaved: z.number().nonnegative().finite(),
    cacheEntryCount: z.number().int().nonnegative().finite().nullable(),
    staleEntryCount: z.number().int().nonnegative().finite().nullable(),
    lastActivity: z.string().datetime().nullable(),
    // #5681 — `search_by_purpose` queries that matched nothing against a
    // non-empty corpus, aggregated by query and ranked by frequency. Added in
    // repo-memory 0.17.0; `.default([])` keeps pre-0.17.0 snapshots (and the
    // #5503-era fixtures) valid when the field is absent.
    topMissedQueries: z.array(z.object({
        query: z.string(),
        count: z.number().int().nonnegative().finite(),
    })).default([]),
});
/**
 * One repo's repo-memory status.
 *
 *   - `configured: false` — no `.repo-memory.json` in the repo root. A quiet
 *     "not configured" row, not an error; every other field is null/empty.
 *   - `configured: true` — `summarizer` + `toolGroups` parsed from the config
 *     (null/empty when the file is unparseable), `cache` always present,
 *     `report` populated from the CLI when it succeeded.
 *   - `reason` — per-repo degradation note: why `report` is null for a
 *     configured repo (CLI missing, CLI failed, unparseable output). Null when
 *     nothing degraded.
 */
export const RepoMemoryStatusSchema = z.object({
    configured: z.boolean(),
    summarizer: z.string().nullable(),
    toolGroups: z.array(z.string()),
    cache: RepoMemoryCacheSchema.nullable(),
    report: RepoMemoryReportSchema.nullable(),
    reason: z.string().nullable(),
});
/**
 * #5501 — one recent repo-relay workflow run, distilled from
 * `gh run list --workflow=repo-relay.yml --json status,conclusion,event,createdAt,databaseId`.
 * `databaseId` is GitHub's run id — #5502's rerun action consumes it, so it is
 * carried verbatim. `conclusion` is null while the run is still in progress.
 */
export const RepoRelayRunSchema = z.object({
    databaseId: z.number().int().nonnegative().finite(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    event: z.string().nullable(),
    createdAt: z.string().datetime().nullable(),
});
/**
 * #5501 — per-repo repo-relay verdict, mirroring the runner tab's bucket
 * style:
 *
 *   - 'failing'       — the latest CONCLUDED run failed (wins over drift:
 *     a broken relay is more urgent than a stale pin).
 *   - 'drifted'       — pinned version < latest release (sha pins resolve via
 *     their `# vX.Y.Z` comment first).
 *   - 'ok'            — latest concluded run succeeded and no drift.
 *   - 'not_installed' — no `.github/workflows/repo-relay.yml` in the checkout.
 *   - 'unknown'       — installed but unassessable (gh missing / rate-limited /
 *     no GitHub remote / no concluded runs and no drift signal); the row's
 *     `reason` explains why.
 */
export const RepoRelayVerdictSchema = z.enum(['ok', 'failing', 'drifted', 'not_installed', 'unknown']);
/**
 * #5501 — one repo's repo-relay status.
 *
 *   - `installed` — answered from the filesystem alone (the workflow file),
 *     so it survives every gh/network degradation.
 *   - `pinnedVersion` / `pinnedSha` — parsed from the workflow's
 *     `uses: blamechris/repo-relay@<ref>` line. A tag pin fills
 *     `pinnedVersion` only; a sha pin fills `pinnedSha` plus `pinnedVersion`
 *     when a `# vX.Y.Z` comment resolves it.
 *   - `driftUnknown` — installed but the pin couldn't be resolved to a
 *     version (bare sha with no comment, branch pin, unparseable uses line)
 *     so drift can't be assessed.
 *   - `latestVersion` — `releases/latest` tag of blamechris/repo-relay,
 *     fetched ONCE per snapshot (and cached briefly across snapshots).
 *   - `runs` — most-recent-first; empty when unavailable (see `reason`).
 *   - `failureStreak` — consecutive failed conclusions from the most recent
 *     run backwards (in-progress runs are skipped, not streak-breaking).
 *   - `workflowUrl` — Actions UI deep link, null without a GitHub remote.
 *   - `reason` — per-repo degradation note (gh missing, rate limit, no
 *     GitHub remote, …). Null when nothing degraded.
 */
export const RepoRelayStatusSchema = z.object({
    installed: z.boolean(),
    pinnedVersion: z.string().nullable(),
    pinnedSha: z.string().nullable(),
    latestVersion: z.string().nullable(),
    runs: z.array(RepoRelayRunSchema),
    failureStreak: z.number().int().nonnegative().finite(),
    verdict: RepoRelayVerdictSchema,
    driftUnknown: z.boolean(),
    workflowUrl: z.string().nullable(),
    reason: z.string().nullable(),
});
/**
 * One surveyed repo in the Integrations snapshot. `repoMemory` is nullable so
 * a future integration can appear without forcing a repo-memory block.
 * `repoRelay` (#5501) is additive — optional so #5503-era producers/fixtures
 * stay valid; the current survey always emits it (a repo without the workflow
 * file gets a quiet `installed: false` block, same posture as unconfigured
 * repo-memory).
 */
export const IntegrationRepoSchema = z.object({
    name: z.string(),
    path: z.string(),
    repoMemory: RepoMemoryStatusSchema.nullable(),
    repoRelay: RepoRelayStatusSchema.nullable().optional(),
});
/**
 * Aggregate repo-memory counts across the surveyed repos, carried alongside
 * `repos` so the Integrations tab's summary chips don't re-tally. `degraded`
 * counts configured repos whose report cell carries a `reason`.
 */
export const IntegrationStatusSummarySchema = z.object({
    total: z.number().int().nonnegative().finite(),
    configured: z.number().int().nonnegative().finite(),
    notConfigured: z.number().int().nonnegative().finite(),
    degraded: z.number().int().nonnegative().finite(),
    // #5501 (additive — optional so pre-relay snapshots stay valid): repo-relay
    // tallies for the summary chips. `relayFailing` / `relayDrifted` count the
    // verdict buckets; `relayInstalled` counts repos with the workflow file.
    relayInstalled: z.number().int().nonnegative().finite().optional(),
    relayFailing: z.number().int().nonnegative().finite().optional(),
    relayDrifted: z.number().int().nonnegative().finite().optional(),
});
/**
 * Snapshot-level note about the `repo-memory` CLI binary, probed ONCE per
 * survey. When `found` is false every configured repo's CLI-derived cells are
 * degraded and `note` explains why (the per-repo `reason` repeats it).
 */
export const IntegrationCliStatusSchema = z.object({
    found: z.boolean(),
    path: z.string().nullable(),
    note: z.string().nullable(),
});
/**
 * #5499 — full Integrations survey snapshot. Emitted in reply to an
 * `integration_status_request` (see client.ts). `root` is the Control Room
 * discovery root the repo set was resolved under (same as the host survey).
 * An empty `repos` array is the valid "no repos under the root" state.
 * `repoMemoryCli` is optional so the degraded error-snapshot (FORBIDDEN /
 * SURVEY_IN_PROGRESS / SURVEY_FAILED) can reuse the shared error envelope; a
 * successful survey always carries it.
 */
export const ServerIntegrationStatusSnapshotSchema = z.object({
    type: z.literal('integration_status_snapshot'),
    // Echoes the client's `integration_status_request` requestId so the
    // dashboard can correlate a snapshot to the Refresh click that triggered it.
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    root: z.string(),
    summary: IntegrationStatusSummarySchema,
    repos: z.array(IntegrationRepoSchema),
    repoMemoryCli: IntegrationCliStatusSchema.optional(),
    // #5501: snapshot-level note about the `gh` CLI, probed ONCE per survey —
    // when `found` is false every repo-relay run/release cell degrades and
    // `note` explains why (each installed repo's `reason` repeats it).
    ghCli: IntegrationCliStatusSchema.optional(),
    // Additive degraded-snapshot annotation — same posture as the host/runner
    // snapshots: on a forbidden/in-progress/failed survey the handler returns an
    // otherwise-valid empty snapshot plus this `error`.
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
/**
 * #5500 (epic #5498) — counts distilled from a `repo-memory index` run, as
 * printed by the CLI's human-readable report (field names verified against
 * the IndexReport shape in @blamechris/repo-memory: scanned / summarized /
 * "already fresh" / skipped). All four are required — a partially parsed
 * report is treated as unparseable and the ack carries `counts: null`
 * instead, so the dashboard never renders a half-true breakdown.
 */
export const IntegrationActionCountsSchema = z.object({
    scanned: z.number().int().nonnegative().finite(),
    summarized: z.number().int().nonnegative().finite(),
    fresh: z.number().int().nonnegative().finite(),
    skipped: z.number().int().nonnegative().finite(),
});
/**
 * #5500 — positive ack that an `integration_action` request completed.
 * Clones the `cancel_activity_ack` correlation contract (#5277): echoes the
 * request's `action` + `repoPath` (and `requestId` when supplied) so the
 * dashboard can clear the exact row's pending state. Failures surface as an
 * `INTEGRATION_ACTION_FAILED` session_error, which also echoes
 * `requestId` / `action` / `repoPath`.
 *
 * `action` is a plain string (not the client enum) so a future action's ack
 * reaches older dashboards without a schema bump — consumers key off
 * `repoPath` and treat unknown actions as opaque. `counts` is the parsed
 * index result for `repo_memory_reindex`, or null when the CLI output
 * couldn't be parsed (the UI then just refreshes the survey for the truth).
 *
 * #5502: `runId` echoes the re-run request's GitHub Actions run id on a
 * `repo_relay_rerun` ack (null/absent on reindex acks). A rerun ack carries
 * `counts: null` — there is nothing to count; the new attempt shows up as
 * in_progress on the next survey refresh.
 */
export const ServerIntegrationActionAckSchema = z.object({
    type: z.literal('integration_action_ack'),
    action: z.string(),
    repoPath: z.string(),
    requestId: z.string().max(128).nullable().optional(),
    runId: z.number().int().nonnegative().finite().nullable().optional(),
    counts: IntegrationActionCountsSchema.nullable(),
}).passthrough();
/**
 * #6134 (epic #5530) — ack for a successful `containers_action` (stop / restart
 * / destroy). Echoes `action` + the client-supplied `environmentId` (+ optional
 * `requestId`) so the dashboard can clear the exact row's pending state, and
 * carries the resulting `status` (`stopped` / `running` / `destroyed`). A
 * failure instead replies with a `CONTAINER_ACTION_FAILED` session_error
 * carrying the same correlation fields (mirrors integration_action's contract).
 */
export const ServerContainersActionAckSchema = z.object({
    type: z.literal('containers_action_ack'),
    action: z.string(),
    environmentId: z.string(),
    requestId: z.string().max(128).nullable().optional(),
    status: z.string().nullable().optional(),
}).passthrough();
/**
 * #6135 slice 2 (epic #5530) — ack for a successful `byok_pool_action` (drain /
 * recycle / resize) of the BYOK warm-container pool. Echoes `action` (+ optional
 * `requestId`, + `key` for recycle) so the dashboard can clear the row's pending
 * state, and carries the action result:
 *   - `drained` — containers evicted by a drain/recycle (null for resize).
 *   - `evicted` — containers evicted to honor a tightened resize (null otherwise).
 *   - `limits` — the new effective caps after a resize (null otherwise).
 *   - `configured` — the operator-configured cap ceiling resize is clamped to.
 * A failure instead replies with a `BYOK_POOL_ACTION_FAILED` session_error
 * carrying the same correlation fields (mirrors containers_action's contract).
 */
export const ServerByokPoolActionAckSchema = z.object({
    type: z.literal('byok_pool_action_ack'),
    action: z.string(),
    requestId: z.string().max(128).nullable().optional(),
    key: z.string().nullable().optional(),
    drained: z.number().int().nonnegative().finite().nullable().optional(),
    evicted: z.number().int().nonnegative().finite().nullable().optional(),
    limits: ByokPoolLimitsSchema.nullable().optional(),
    configured: z
        .object({
        maxPerKey: z.number().int().nonnegative().finite(),
        maxTotal: z.number().int().nonnegative().finite(),
    })
        .nullable()
        .optional(),
}).passthrough();
