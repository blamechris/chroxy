/**
 * Containers & environments survey (#6133) + per-repo Runtime Config survey (#6139): the chroxy-managed container inventory and what governs container runtimes (devcontainer/compose/image allowlist).
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
// ---------------------------------------------------------------------------
// #6133 (epic #5530) — Control Room "Containers" survey: the chroxy-managed
// containers & environments the daemon depends on. Emitted in reply to a
// `containers_status_request` (see client.ts). Same pull-on-Refresh,
// degraded-snapshot-with-`error` contract as the host/runner/integration
// surveys. A flat `containers` array (each entry carries its `cwd`) rather than
// a nested `repos` shape: an environment is a discrete unit keyed by its mount,
// not a 1:many-per-repo grouping like runners — the dashboard groups by `cwd`
// at render time.
// ---------------------------------------------------------------------------
/**
 * Best-effort `docker stats` resource snapshot for one running container. Every
 * field is nullable: `docker stats` may be unavailable (docker absent, daemon
 * down, a stuck probe), in which case the whole `stats` object is null on the
 * entry — `null` means "unknown", never "zero".
 */
export const ContainerStatsSchema = z.object({
    cpuPercent: z.number().nonnegative().finite().nullable(),
    memBytes: z.number().nonnegative().finite().nullable(),
    memPercent: z.number().nonnegative().finite().nullable(),
});
/**
 * One chroxy-managed container / environment.
 *
 * Fields:
 *   - `id`             — EnvironmentManager environment id.
 *   - `name`           — operator-facing environment name.
 *   - `cwd`            — host working directory mounted as the workspace (the
 *                        repo the environment backs); the dashboard groups by it.
 *   - `image`          — container image, or null when unknown.
 *   - `status`         — lifecycle status string (`running`, `stopped`, `error`,
 *                        `unknown`, …) as the EnvironmentManager reports it.
 *   - `backend`        — `docker` | `compose` | `k8s` | `rancher` | `unknown`.
 *   - `containerId`    — backing container id, or null (compose/k8s/unknown).
 *   - `composeProject` — compose project name, or null.
 *   - `sessionCount`   — number of live chroxy sessions attached.
 *   - `createdAt`      — ISO-8601 creation time, or null.
 *   - `uptimeMs`       — derived ms since `createdAt` at survey time, or null.
 *   - `stats`          — live resource snapshot, or null when unavailable / the
 *                        container isn't running.
 */
export const ContainerEntrySchema = z.object({
    id: z.string(),
    name: z.string(),
    cwd: z.string(),
    image: z.string().nullable(),
    status: z.string(),
    backend: z.string(),
    containerId: z.string().nullable(),
    composeProject: z.string().nullable(),
    sessionCount: z.number().int().nonnegative().finite(),
    createdAt: z.string().nullable(),
    uptimeMs: z.number().int().nonnegative().finite().nullable(),
    stats: ContainerStatsSchema.nullable(),
});
/**
 * Aggregate container counts so the summary chips don't re-tally. `other`
 * absorbs any status that's neither running nor a known stopped/exited/error
 * state. All non-negative integers.
 */
export const ContainersStatusSummarySchema = z.object({
    total: z.number().int().nonnegative().finite(),
    running: z.number().int().nonnegative().finite(),
    stopped: z.number().int().nonnegative().finite(),
    other: z.number().int().nonnegative().finite(),
});
/**
 * #6133 — full containers & environments snapshot. Emitted in reply to a
 * `containers_status_request` (see client.ts). An empty `containers` array is
 * the valid "no chroxy-managed environments" state — never omitted.
 * `dockerStatsNote` is a snapshot-level degradation annotation set when the
 * `docker stats` enrichment was skipped/failed (the inventory is still present;
 * every entry's `stats` is null).
 */
export const ServerContainersStatusSnapshotSchema = z.object({
    type: z.literal('containers_status_snapshot'),
    // Echoes the client's request requestId so the dashboard can correlate a
    // snapshot to the Refresh click. Present (null when the client omitted one).
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    summary: ContainersStatusSummarySchema,
    containers: z.array(ContainerEntrySchema),
    dockerStatsNote: z.string().nullable().optional(),
    // Additive degraded-snapshot annotation (mirrors the sibling surveys): on a
    // forbidden/in-progress/failed survey the handler returns an otherwise-valid
    // (empty containers, zeroed summary) snapshot plus this `error`.
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
// ---------------------------------------------------------------------------
// #6139 (epic #5530) — Control Room "Repo Runtime Config" tab: per-repo,
// read-only survey of what governs container runtimes. Emitted in reply to a
// `repo_runtime_config_request` (see client.ts). Same pull-on-Refresh,
// degraded-snapshot-with-`error` contract as the host/runner/containers surveys.
// ---------------------------------------------------------------------------
/** Devcontainer detection for one repo: present + the detected file path. */
export const RepoRuntimeDevcontainerSchema = z.object({
    present: z.boolean(),
    path: z.string().nullable(),
});
/** Compose detection for one repo: present + the compose file path(s)
 *  (a devcontainer `dockerComposeFile`, else repo-root compose files). */
export const RepoRuntimeComposeSchema = z.object({
    present: z.boolean(),
    files: z.array(z.string()),
});
/** One repo's runtime config. `error` (non-null) marks a repo that couldn't be
 *  inspected — its other fields are nulled. */
export const RepoRuntimeConfigEntrySchema = z.object({
    name: z.string(),
    path: z.string(),
    devcontainer: RepoRuntimeDevcontainerSchema,
    compose: RepoRuntimeComposeSchema,
    // The image this repo WOULD run (devcontainer `image`, else the env default),
    // its source, and the docker-image-allowlist verdict. All null on an errored
    // repo entry.
    image: z.string().nullable(),
    imageSource: z.enum(['devcontainer', 'default']).nullable(),
    imageAllowed: z.boolean().nullable(),
    error: z.string().nullable(),
});
/** Headline counts across the repo set. */
export const RepoRuntimeConfigSummarySchema = z.object({
    total: z.number().int().nonnegative().finite(),
    withDevcontainer: z.number().int().nonnegative().finite(),
    withCompose: z.number().int().nonnegative().finite(),
    imagesDenied: z.number().int().nonnegative().finite(),
    errored: z.number().int().nonnegative().finite(),
});
export const ServerRepoRuntimeConfigSnapshotSchema = z.object({
    type: z.literal('repo_runtime_config_snapshot'),
    // Echoes the client's request requestId (null when omitted) for correlation.
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    // Host-level defaults that apply across all repos.
    backend: z.string(),
    backendSource: z.enum(['config', 'default']),
    isolation: z.string(),
    allowlist: z.object({
        source: z.enum(['config', 'default']),
        patterns: z.array(z.string()),
    }),
    repos: z.array(RepoRuntimeConfigEntrySchema),
    summary: RepoRuntimeConfigSummarySchema,
    // Additive degraded-snapshot annotation (mirrors the sibling surveys): a
    // forbidden/in-progress/failed survey returns an otherwise-valid (empty
    // repos, zeroed summary) snapshot plus this `error`.
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
