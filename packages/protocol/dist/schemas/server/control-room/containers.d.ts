/**
 * Containers & environments survey (#6133) + per-repo Runtime Config survey (#6139): the chroxy-managed container inventory and what governs container runtimes (devcontainer/compose/image allowlist).
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
/**
 * Best-effort `docker stats` resource snapshot for one running container. Every
 * field is nullable: `docker stats` may be unavailable (docker absent, daemon
 * down, a stuck probe), in which case the whole `stats` object is null on the
 * entry — `null` means "unknown", never "zero".
 */
export declare const ContainerStatsSchema: z.ZodObject<{
    cpuPercent: z.ZodNullable<z.ZodNumber>;
    memBytes: z.ZodNullable<z.ZodNumber>;
    memPercent: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
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
export declare const ContainerEntrySchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    cwd: z.ZodString;
    image: z.ZodNullable<z.ZodString>;
    status: z.ZodString;
    backend: z.ZodString;
    containerId: z.ZodNullable<z.ZodString>;
    composeProject: z.ZodNullable<z.ZodString>;
    sessionCount: z.ZodNumber;
    createdAt: z.ZodNullable<z.ZodString>;
    uptimeMs: z.ZodNullable<z.ZodNumber>;
    stats: z.ZodNullable<z.ZodObject<{
        cpuPercent: z.ZodNullable<z.ZodNumber>;
        memBytes: z.ZodNullable<z.ZodNumber>;
        memPercent: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Aggregate container counts so the summary chips don't re-tally. `other`
 * absorbs any status that's neither running nor a known stopped/exited/error
 * state. All non-negative integers.
 */
export declare const ContainersStatusSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    running: z.ZodNumber;
    stopped: z.ZodNumber;
    other: z.ZodNumber;
}, z.core.$strip>;
/**
 * #6133 — full containers & environments snapshot. Emitted in reply to a
 * `containers_status_request` (see client.ts). An empty `containers` array is
 * the valid "no chroxy-managed environments" state — never omitted.
 * `dockerStatsNote` is a snapshot-level degradation annotation set when the
 * `docker stats` enrichment was skipped/failed (the inventory is still present;
 * every entry's `stats` is null).
 */
export declare const ServerContainersStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"containers_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        running: z.ZodNumber;
        stopped: z.ZodNumber;
        other: z.ZodNumber;
    }, z.core.$strip>;
    containers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        cwd: z.ZodString;
        image: z.ZodNullable<z.ZodString>;
        status: z.ZodString;
        backend: z.ZodString;
        containerId: z.ZodNullable<z.ZodString>;
        composeProject: z.ZodNullable<z.ZodString>;
        sessionCount: z.ZodNumber;
        createdAt: z.ZodNullable<z.ZodString>;
        uptimeMs: z.ZodNullable<z.ZodNumber>;
        stats: z.ZodNullable<z.ZodObject<{
            cpuPercent: z.ZodNullable<z.ZodNumber>;
            memBytes: z.ZodNullable<z.ZodNumber>;
            memPercent: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    dockerStatsNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Devcontainer detection for one repo: present + the detected file path. */
export declare const RepoRuntimeDevcontainerSchema: z.ZodObject<{
    present: z.ZodBoolean;
    path: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** Compose detection for one repo: present + the compose file path(s)
 *  (a devcontainer `dockerComposeFile`, else repo-root compose files). */
export declare const RepoRuntimeComposeSchema: z.ZodObject<{
    present: z.ZodBoolean;
    files: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/** One repo's runtime config. `error` (non-null) marks a repo that couldn't be
 *  inspected — its other fields are nulled. */
export declare const RepoRuntimeConfigEntrySchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    devcontainer: z.ZodObject<{
        present: z.ZodBoolean;
        path: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    compose: z.ZodObject<{
        present: z.ZodBoolean;
        files: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    image: z.ZodNullable<z.ZodString>;
    imageSource: z.ZodNullable<z.ZodEnum<{
        default: "default";
        devcontainer: "devcontainer";
    }>>;
    imageAllowed: z.ZodNullable<z.ZodBoolean>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** Headline counts across the repo set. */
export declare const RepoRuntimeConfigSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    withDevcontainer: z.ZodNumber;
    withCompose: z.ZodNumber;
    imagesDenied: z.ZodNumber;
    errored: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerRepoRuntimeConfigSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"repo_runtime_config_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    backend: z.ZodString;
    backendSource: z.ZodEnum<{
        default: "default";
        config: "config";
    }>;
    isolation: z.ZodString;
    allowlist: z.ZodObject<{
        source: z.ZodEnum<{
            default: "default";
            config: "config";
        }>;
        patterns: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        devcontainer: z.ZodObject<{
            present: z.ZodBoolean;
            path: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        compose: z.ZodObject<{
            present: z.ZodBoolean;
            files: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        image: z.ZodNullable<z.ZodString>;
        imageSource: z.ZodNullable<z.ZodEnum<{
            default: "default";
            devcontainer: "devcontainer";
        }>>;
        imageAllowed: z.ZodNullable<z.ZodBoolean>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        withDevcontainer: z.ZodNumber;
        withCompose: z.ZodNumber;
        imagesDenied: z.ZodNumber;
        errored: z.ZodNumber;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
