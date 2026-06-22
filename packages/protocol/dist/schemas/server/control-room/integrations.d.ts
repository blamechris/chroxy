/**
 * Integrations survey (#5499): per-repo repo-memory + repo-relay (#5501) observability, plus the Control Room action acks (integration/containers/byok-pool). Imports ByokPoolLimitsSchema from ./byok.ts for the pool-resize ack.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
/**
 * repo-memory cache file stats for one repo (`.repo-memory/cache.db` plus its
 * `-wal` sidecar). `present` is false when the cache file doesn't exist yet
 * (config without traffic); `sizeBytes` then reports 0. `lastModified` is the
 * newest mtime across the db + wal files (ISO-8601), or null when absent —
 * it doubles as a "last activity" proxy because the telemetry report carries
 * no timestamp of its own.
 */
export declare const RepoMemoryCacheSchema: z.ZodObject<{
    present: z.ZodBoolean;
    sizeBytes: z.ZodNumber;
    lastModified: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
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
export declare const RepoMemoryReportSchema: z.ZodObject<{
    totalEvents: z.ZodNumber;
    cacheHits: z.ZodNumber;
    cacheMisses: z.ZodNumber;
    cacheHitRatio: z.ZodNumber;
    estimatedTokensSaved: z.ZodNumber;
    cacheEntryCount: z.ZodNullable<z.ZodNumber>;
    staleEntryCount: z.ZodNullable<z.ZodNumber>;
    lastActivity: z.ZodNullable<z.ZodString>;
    topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
        query: z.ZodString;
        count: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>;
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
export declare const RepoMemoryStatusSchema: z.ZodObject<{
    configured: z.ZodBoolean;
    summarizer: z.ZodNullable<z.ZodString>;
    toolGroups: z.ZodArray<z.ZodString>;
    cache: z.ZodNullable<z.ZodObject<{
        present: z.ZodBoolean;
        sizeBytes: z.ZodNumber;
        lastModified: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    report: z.ZodNullable<z.ZodObject<{
        totalEvents: z.ZodNumber;
        cacheHits: z.ZodNumber;
        cacheMisses: z.ZodNumber;
        cacheHitRatio: z.ZodNumber;
        estimatedTokensSaved: z.ZodNumber;
        cacheEntryCount: z.ZodNullable<z.ZodNumber>;
        staleEntryCount: z.ZodNullable<z.ZodNumber>;
        lastActivity: z.ZodNullable<z.ZodString>;
        topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
            query: z.ZodString;
            count: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5501 — one recent repo-relay workflow run, distilled from
 * `gh run list --workflow=repo-relay.yml --json status,conclusion,event,createdAt,databaseId`.
 * `databaseId` is GitHub's run id — #5502's rerun action consumes it, so it is
 * carried verbatim. `conclusion` is null while the run is still in progress.
 */
export declare const RepoRelayRunSchema: z.ZodObject<{
    databaseId: z.ZodNumber;
    status: z.ZodNullable<z.ZodString>;
    conclusion: z.ZodNullable<z.ZodString>;
    event: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
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
export declare const RepoRelayVerdictSchema: z.ZodEnum<{
    unknown: "unknown";
    ok: "ok";
    failing: "failing";
    drifted: "drifted";
    not_installed: "not_installed";
}>;
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
export declare const RepoRelayStatusSchema: z.ZodObject<{
    installed: z.ZodBoolean;
    pinnedVersion: z.ZodNullable<z.ZodString>;
    pinnedSha: z.ZodNullable<z.ZodString>;
    latestVersion: z.ZodNullable<z.ZodString>;
    runs: z.ZodArray<z.ZodObject<{
        databaseId: z.ZodNumber;
        status: z.ZodNullable<z.ZodString>;
        conclusion: z.ZodNullable<z.ZodString>;
        event: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    failureStreak: z.ZodNumber;
    verdict: z.ZodEnum<{
        unknown: "unknown";
        ok: "ok";
        failing: "failing";
        drifted: "drifted";
        not_installed: "not_installed";
    }>;
    driftUnknown: z.ZodBoolean;
    workflowUrl: z.ZodNullable<z.ZodString>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * One surveyed repo in the Integrations snapshot. `repoMemory` is nullable so
 * a future integration can appear without forcing a repo-memory block.
 * `repoRelay` (#5501) is additive — optional so #5503-era producers/fixtures
 * stay valid; the current survey always emits it (a repo without the workflow
 * file gets a quiet `installed: false` block, same posture as unconfigured
 * repo-memory).
 */
export declare const IntegrationRepoSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    repoMemory: z.ZodNullable<z.ZodObject<{
        configured: z.ZodBoolean;
        summarizer: z.ZodNullable<z.ZodString>;
        toolGroups: z.ZodArray<z.ZodString>;
        cache: z.ZodNullable<z.ZodObject<{
            present: z.ZodBoolean;
            sizeBytes: z.ZodNumber;
            lastModified: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        report: z.ZodNullable<z.ZodObject<{
            totalEvents: z.ZodNumber;
            cacheHits: z.ZodNumber;
            cacheMisses: z.ZodNumber;
            cacheHitRatio: z.ZodNumber;
            estimatedTokensSaved: z.ZodNumber;
            cacheEntryCount: z.ZodNullable<z.ZodNumber>;
            staleEntryCount: z.ZodNullable<z.ZodNumber>;
            lastActivity: z.ZodNullable<z.ZodString>;
            topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
                query: z.ZodString;
                count: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    repoRelay: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        installed: z.ZodBoolean;
        pinnedVersion: z.ZodNullable<z.ZodString>;
        pinnedSha: z.ZodNullable<z.ZodString>;
        latestVersion: z.ZodNullable<z.ZodString>;
        runs: z.ZodArray<z.ZodObject<{
            databaseId: z.ZodNumber;
            status: z.ZodNullable<z.ZodString>;
            conclusion: z.ZodNullable<z.ZodString>;
            event: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        failureStreak: z.ZodNumber;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            ok: "ok";
            failing: "failing";
            drifted: "drifted";
            not_installed: "not_installed";
        }>;
        driftUnknown: z.ZodBoolean;
        workflowUrl: z.ZodNullable<z.ZodString>;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/**
 * Aggregate repo-memory counts across the surveyed repos, carried alongside
 * `repos` so the Integrations tab's summary chips don't re-tally. `degraded`
 * counts configured repos whose report cell carries a `reason`.
 */
export declare const IntegrationStatusSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    configured: z.ZodNumber;
    notConfigured: z.ZodNumber;
    degraded: z.ZodNumber;
    relayInstalled: z.ZodOptional<z.ZodNumber>;
    relayFailing: z.ZodOptional<z.ZodNumber>;
    relayDrifted: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/**
 * Snapshot-level note about the `repo-memory` CLI binary, probed ONCE per
 * survey. When `found` is false every configured repo's CLI-derived cells are
 * degraded and `note` explains why (the per-repo `reason` repeats it).
 */
export declare const IntegrationCliStatusSchema: z.ZodObject<{
    found: z.ZodBoolean;
    path: z.ZodNullable<z.ZodString>;
    note: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5499 — full Integrations survey snapshot. Emitted in reply to an
 * `integration_status_request` (see client.ts). `root` is the Control Room
 * discovery root the repo set was resolved under (same as the host survey).
 * An empty `repos` array is the valid "no repos under the root" state.
 * `repoMemoryCli` is optional so the degraded error-snapshot (FORBIDDEN /
 * SURVEY_IN_PROGRESS / SURVEY_FAILED) can reuse the shared error envelope; a
 * successful survey always carries it.
 */
export declare const ServerIntegrationStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        configured: z.ZodNumber;
        notConfigured: z.ZodNumber;
        degraded: z.ZodNumber;
        relayInstalled: z.ZodOptional<z.ZodNumber>;
        relayFailing: z.ZodOptional<z.ZodNumber>;
        relayDrifted: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        repoMemory: z.ZodNullable<z.ZodObject<{
            configured: z.ZodBoolean;
            summarizer: z.ZodNullable<z.ZodString>;
            toolGroups: z.ZodArray<z.ZodString>;
            cache: z.ZodNullable<z.ZodObject<{
                present: z.ZodBoolean;
                sizeBytes: z.ZodNumber;
                lastModified: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            report: z.ZodNullable<z.ZodObject<{
                totalEvents: z.ZodNumber;
                cacheHits: z.ZodNumber;
                cacheMisses: z.ZodNumber;
                cacheHitRatio: z.ZodNumber;
                estimatedTokensSaved: z.ZodNumber;
                cacheEntryCount: z.ZodNullable<z.ZodNumber>;
                staleEntryCount: z.ZodNullable<z.ZodNumber>;
                lastActivity: z.ZodNullable<z.ZodString>;
                topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
                    query: z.ZodString;
                    count: z.ZodNumber;
                }, z.core.$strip>>>;
            }, z.core.$strip>>;
            reason: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        repoRelay: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            installed: z.ZodBoolean;
            pinnedVersion: z.ZodNullable<z.ZodString>;
            pinnedSha: z.ZodNullable<z.ZodString>;
            latestVersion: z.ZodNullable<z.ZodString>;
            runs: z.ZodArray<z.ZodObject<{
                databaseId: z.ZodNumber;
                status: z.ZodNullable<z.ZodString>;
                conclusion: z.ZodNullable<z.ZodString>;
                event: z.ZodNullable<z.ZodString>;
                createdAt: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            failureStreak: z.ZodNumber;
            verdict: z.ZodEnum<{
                unknown: "unknown";
                ok: "ok";
                failing: "failing";
                drifted: "drifted";
                not_installed: "not_installed";
            }>;
            driftUnknown: z.ZodBoolean;
            workflowUrl: z.ZodNullable<z.ZodString>;
            reason: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    repoMemoryCli: z.ZodOptional<z.ZodObject<{
        found: z.ZodBoolean;
        path: z.ZodNullable<z.ZodString>;
        note: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    ghCli: z.ZodOptional<z.ZodObject<{
        found: z.ZodBoolean;
        path: z.ZodNullable<z.ZodString>;
        note: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #5500 (epic #5498) — counts distilled from a `repo-memory index` run, as
 * printed by the CLI's human-readable report (field names verified against
 * the IndexReport shape in @blamechris/repo-memory: scanned / summarized /
 * "already fresh" / skipped). All four are required — a partially parsed
 * report is treated as unparseable and the ack carries `counts: null`
 * instead, so the dashboard never renders a half-true breakdown.
 */
export declare const IntegrationActionCountsSchema: z.ZodObject<{
    scanned: z.ZodNumber;
    summarized: z.ZodNumber;
    fresh: z.ZodNumber;
    skipped: z.ZodNumber;
}, z.core.$strip>;
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
export declare const ServerIntegrationActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_action_ack">;
    action: z.ZodString;
    repoPath: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    runId: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    counts: z.ZodNullable<z.ZodObject<{
        scanned: z.ZodNumber;
        summarized: z.ZodNumber;
        fresh: z.ZodNumber;
        skipped: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6134 (epic #5530) — ack for a successful `containers_action` (stop / restart
 * / destroy). Echoes `action` + the client-supplied `environmentId` (+ optional
 * `requestId`) so the dashboard can clear the exact row's pending state, and
 * carries the resulting `status` (`stopped` / `running` / `destroyed`). A
 * failure instead replies with a `CONTAINER_ACTION_FAILED` session_error
 * carrying the same correlation fields (mirrors integration_action's contract).
 */
export declare const ServerContainersActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"containers_action_ack">;
    action: z.ZodString;
    environmentId: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
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
export declare const ServerByokPoolActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_action_ack">;
    action: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    key: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    drained: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    evicted: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    limits: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        idleTimeoutMs: z.ZodNumber;
        maxPerKey: z.ZodNumber;
        maxTotal: z.ZodNumber;
        maxAgeMs: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>>;
    configured: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        maxPerKey: z.ZodNumber;
        maxTotal: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$loose>;
