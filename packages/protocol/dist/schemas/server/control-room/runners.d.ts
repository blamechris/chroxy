/**
 * Self-hosted GitHub Actions runner status survey (#5253): per-host runner installs grouped by the repo/org they register against, each with a health verdict.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
/**
 * Per-runner verdict — the survey's roll-up of "is this runner healthy" from
 * the LOCAL service state and (when available) GitHub's view. Drives the
 * colour-coded tag in the runner table:
 *   - `'busy'`         — running locally AND GitHub reports a job in progress.
 *   - `'idle'`         — running locally AND GitHub online with no job (healthy,
 *                        ready). Also used when GitHub data is unavailable but
 *                        the local service is running cleanly.
 *   - `'offline'`      — mismatch worth a look: the local service is running but
 *                        GitHub says offline (registration/network problem), or
 *                        GitHub says online but the local service isn't running.
 *   - `'stopped'`      — the service is registered but not running (dead PID or a
 *                        non-zero last exit).
 *   - `'unregistered'` — an install directory with no registered service (the
 *                        runner was configured but never `svc.sh install`-ed, or
 *                        the service was removed).
 */
export declare const RunnerVerdictSchema: z.ZodEnum<{
    busy: "busy";
    idle: "idle";
    offline: "offline";
    stopped: "stopped";
    unregistered: "unregistered";
}>;
/**
 * Local service-manager state for one runner install:
 *   - `manager`       — which service manager was probed (`launchd` on macOS,
 *                       `systemd` on Linux, or `none` when no `.service` file
 *                       was present / the platform is unsupported).
 *   - `label`         — the service label/unit probed (e.g.
 *                       `actions.runner.owner-repo.name`), or `null` when none.
 *   - `running`       — whether the service is currently running (a live PID
 *                       under launchd, `active` under systemd).
 *   - `pid`           — the running process id, or `null` when not running /
 *                       unknown.
 *   - `lastExitCode`  — the service's last exit status, or `null` when unknown.
 *                       A non-zero value on a not-running service is the "it
 *                       crashed" signal.
 */
export declare const RunnerServiceStateSchema: z.ZodObject<{
    manager: z.ZodEnum<{
        none: "none";
        launchd: "launchd";
        systemd: "systemd";
    }>;
    label: z.ZodNullable<z.ZodString>;
    running: z.ZodBoolean;
    pid: z.ZodNullable<z.ZodNumber>;
    lastExitCode: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/**
 * One self-hosted runner installation on the host.
 *
 * Fields:
 *   - `name`        — the runner's agent name (from `.runner` `agentName`), the
 *                     stable identifier GitHub shows for the runner.
 *   - `dir`         — absolute path of the install directory on the host.
 *   - `verdict`     — see `RunnerVerdictSchema`.
 *   - `service`     — local service-manager state (see `RunnerServiceStateSchema`).
 *   - `githubStatus`— GitHub's view of the runner (`'online' | 'offline'`), or
 *                     `null` when the `gh` enrichment was skipped/failed/this
 *                     runner wasn't matched. `null` ≠ offline.
 *   - `busy`        — whether GitHub reports the runner mid-job, or `null` when
 *                     the GitHub view is unavailable. `null` ≠ false.
 *   - `os`          — GitHub-reported OS string (e.g. `macOS`), or `null`.
 *   - `labels`      — GitHub-reported runner labels (self-hosted, OS, arch,
 *                     custom). Empty array when unknown — never null.
 */
export declare const RunnerInfoSchema: z.ZodObject<{
    name: z.ZodString;
    dir: z.ZodString;
    verdict: z.ZodEnum<{
        busy: "busy";
        idle: "idle";
        offline: "offline";
        stopped: "stopped";
        unregistered: "unregistered";
    }>;
    service: z.ZodObject<{
        manager: z.ZodEnum<{
            none: "none";
            launchd: "launchd";
            systemd: "systemd";
        }>;
        label: z.ZodNullable<z.ZodString>;
        running: z.ZodBoolean;
        pid: z.ZodNullable<z.ZodNumber>;
        lastExitCode: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    githubStatus: z.ZodNullable<z.ZodEnum<{
        offline: "offline";
        online: "online";
    }>>;
    busy: z.ZodNullable<z.ZodBoolean>;
    os: z.ZodNullable<z.ZodString>;
    labels: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * The runners serving one repo (or org), grouped under the GitHub target they
 * register against.
 *
 * Fields:
 *   - `name`      — display name (the repo name, or `org:<org>` for an org-level
 *                   target).
 *   - `owner`     — GitHub owner/org login, or `null` when the URL couldn't be
 *                   parsed.
 *   - `repo`      — GitHub repo name, or `null` for an org-level target / an
 *                   unparseable URL.
 *   - `githubUrl` — the raw `gitHubUrl` the runners registered against.
 *   - `runnersUrl`— deep link to the repo/org runner-settings page, or `null`
 *                   when the URL couldn't be derived. Constrained to the GitHub
 *                   settings shape so it's safe to render as an `<a href>`.
 *   - `runners`   — the runner installs serving this target (>= 1).
 */
export declare const RepoRunnersSchema: z.ZodObject<{
    name: z.ZodString;
    owner: z.ZodNullable<z.ZodString>;
    repo: z.ZodNullable<z.ZodString>;
    githubUrl: z.ZodString;
    runnersUrl: z.ZodNullable<z.ZodString>;
    runners: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        dir: z.ZodString;
        verdict: z.ZodEnum<{
            busy: "busy";
            idle: "idle";
            offline: "offline";
            stopped: "stopped";
            unregistered: "unregistered";
        }>;
        service: z.ZodObject<{
            manager: z.ZodEnum<{
                none: "none";
                launchd: "launchd";
                systemd: "systemd";
            }>;
            label: z.ZodNullable<z.ZodString>;
            running: z.ZodBoolean;
            pid: z.ZodNullable<z.ZodNumber>;
            lastExitCode: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        githubStatus: z.ZodNullable<z.ZodEnum<{
            offline: "offline";
            online: "online";
        }>>;
        busy: z.ZodNullable<z.ZodBoolean>;
        os: z.ZodNullable<z.ZodString>;
        labels: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Aggregate runner counts across the host, one per verdict bucket plus a
 * `total`. Carried alongside `repos` so the runner tab's summary chips don't
 * re-tally. All non-negative integers.
 */
export declare const RunnerStatusSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    busy: z.ZodNumber;
    idle: z.ZodNumber;
    offline: z.ZodNumber;
    stopped: z.ZodNumber;
    unregistered: z.ZodNumber;
}, z.core.$strip>;
/**
 * #5253 — full self-hosted runner snapshot. Emitted in reply to a
 * `runner_status_request` (see client.ts). `root` is the scanned runner-install
 * root (default `~/github-runners`). `generatedAt` is the ISO-8601 survey time
 * for the "generated Nm ago" line. An empty `repos` array is the valid "no
 * runners installed under the root" state — never omitted.
 */
export declare const ServerRunnerStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"runner_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        busy: z.ZodNumber;
        idle: z.ZodNumber;
        offline: z.ZodNumber;
        stopped: z.ZodNumber;
        unregistered: z.ZodNumber;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        owner: z.ZodNullable<z.ZodString>;
        repo: z.ZodNullable<z.ZodString>;
        githubUrl: z.ZodString;
        runnersUrl: z.ZodNullable<z.ZodString>;
        runners: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            dir: z.ZodString;
            verdict: z.ZodEnum<{
                busy: "busy";
                idle: "idle";
                offline: "offline";
                stopped: "stopped";
                unregistered: "unregistered";
            }>;
            service: z.ZodObject<{
                manager: z.ZodEnum<{
                    none: "none";
                    launchd: "launchd";
                    systemd: "systemd";
                }>;
                label: z.ZodNullable<z.ZodString>;
                running: z.ZodBoolean;
                pid: z.ZodNullable<z.ZodNumber>;
                lastExitCode: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>;
            githubStatus: z.ZodNullable<z.ZodEnum<{
                offline: "offline";
                online: "online";
            }>>;
            busy: z.ZodNullable<z.ZodBoolean>;
            os: z.ZodNullable<z.ZodString>;
            labels: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
