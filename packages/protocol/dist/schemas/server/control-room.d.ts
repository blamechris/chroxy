/**
 * Control Room survey + action snapshots (#5170 epic): host/repo status, runners, containers, runtime config, BYOK pool, repo-memory/relay, integrations, host-prune, simulators/emulators/WSL, skills inventory, summarize-session.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
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
/** Configured pool bounds. `maxAgeMs` is null when unbounded (Infinity). */
export declare const ByokPoolLimitsSchema: z.ZodObject<{
    idleTimeoutMs: z.ZodNumber;
    maxPerKey: z.ZodNumber;
    maxTotal: z.ZodNumber;
    maxAgeMs: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/** One per-resource-shape warm bucket: count + idle age of the oldest entry. */
export declare const ByokPoolBucketSchema: z.ZodObject<{
    key: z.ZodString;
    size: z.ZodNumber;
    oldestIdleMs: z.ZodNumber;
}, z.core.$strip>;
/** One recent eviction (bounded tail): which key/container and why. */
export declare const ByokPoolEvictionSchema: z.ZodObject<{
    key: z.ZodString;
    containerId: z.ZodNullable<z.ZodString>;
    reason: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
/** Live rolling pool stats from the aggregator. Null when the pool is off. */
export declare const ByokPoolStatsSchema: z.ZodObject<{
    hits: z.ZodNumber;
    misses: z.ZodNumber;
    releases: z.ZodNumber;
    shutdowns: z.ZodNumber;
    hitRate: z.ZodNumber;
    totalSize: z.ZodNumber;
    buckets: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        size: z.ZodNumber;
        oldestIdleMs: z.ZodNumber;
    }, z.core.$strip>>;
    evictionsByReason: z.ZodRecord<z.ZodString, z.ZodNumber>;
    recentEvictions: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        containerId: z.ZodNullable<z.ZodString>;
        reason: z.ZodString;
        timestamp: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerByokPoolStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    enabled: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    limits: z.ZodNullable<z.ZodObject<{
        idleTimeoutMs: z.ZodNumber;
        maxPerKey: z.ZodNumber;
        maxTotal: z.ZodNumber;
        maxAgeMs: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    stats: z.ZodNullable<z.ZodObject<{
        hits: z.ZodNumber;
        misses: z.ZodNumber;
        releases: z.ZodNumber;
        shutdowns: z.ZodNumber;
        hitRate: z.ZodNumber;
        totalSize: z.ZodNumber;
        buckets: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            size: z.ZodNumber;
            oldestIdleMs: z.ZodNumber;
        }, z.core.$strip>>;
        evictionsByReason: z.ZodRecord<z.ZodString, z.ZodNumber>;
        recentEvictions: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            containerId: z.ZodNullable<z.ZodString>;
            reason: z.ZodString;
            timestamp: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
/** One prunable chroxy container (stopped/created/dead, not tracked by a live env). */
export declare const HostPruneContainerSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    state: z.ZodString;
    sizeBytes: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/** One prunable chroxy snapshot image (not referenced by a live env). */
export declare const HostPruneImageSchema: z.ZodObject<{
    id: z.ZodString;
    ref: z.ZodString;
    repository: z.ZodString;
    sizeBytes: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerHostPruneStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_prune_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    dockerAvailable: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    containers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        state: z.ZodString;
        sizeBytes: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    images: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        ref: z.ZodString;
        repository: z.ZodString;
        sizeBytes: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    summary: z.ZodObject<{
        containerCount: z.ZodNumber;
        imageCount: z.ZodNumber;
        reclaimableBytes: z.ZodNumber;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6140 — ack for a successful `host_prune_action`. Echoes `kind` (+ optional
 * `requestId`) and carries what was actually removed: per-resource removed counts,
 * an estimated `reclaimedBytes`, and a `failures` list (resources that survived
 * the re-survey but whose `docker rm`/`rmi` failed — e.g. an image still
 * referenced). A failure to even start replies with a `HOST_PRUNE_ACTION_FAILED`
 * session_error carrying the same correlation fields.
 */
export declare const ServerHostPruneActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_prune_action_ack">;
    kind: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dockerAvailable: z.ZodBoolean;
    removedContainers: z.ZodNumber;
    removedImages: z.ZodNumber;
    reclaimedBytes: z.ZodNumber;
    failures: z.ZodArray<z.ZodObject<{
        ref: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/** One iOS simulator from `xcrun simctl list devices`. */
export declare const SimulatorDeviceSchema: z.ZodObject<{
    udid: z.ZodString;
    name: z.ZodString;
    state: z.ZodString;
    runtime: z.ZodString;
    deviceType: z.ZodNullable<z.ZodString>;
    isAvailable: z.ZodBoolean;
}, z.core.$strip>;
/** The composite "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export declare const ReadyForMaestroSchema: z.ZodObject<{
    ready: z.ZodBoolean;
    bootedSimulator: z.ZodNullable<z.ZodString>;
    metroReachable: z.ZodBoolean;
    mockServerReachable: z.ZodBoolean;
    reasons: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSimulatorStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"simulator_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    available: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    devices: z.ZodArray<z.ZodObject<{
        udid: z.ZodString;
        name: z.ZodString;
        state: z.ZodString;
        runtime: z.ZodString;
        deviceType: z.ZodNullable<z.ZodString>;
        isAvailable: z.ZodBoolean;
    }, z.core.$strip>>;
    readyForMaestro: z.ZodObject<{
        ready: z.ZodBoolean;
        bootedSimulator: z.ZodNullable<z.ZodString>;
        metroReachable: z.ZodBoolean;
        mockServerReachable: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6136 slice 2 — ack for a successful `simulator_action` (boot/shutdown).
 * Echoes `action`/`udid` (+ optional `requestId`) and carries the resulting
 * `status` (the device's new state, "Booted"/"Shutdown"). A failure replies with
 * a `SIMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export declare const ServerSimulatorActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"simulator_action_ack">;
    action: z.ZodString;
    udid: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodNullable<z.ZodString>;
}, z.core.$loose>;
/**
 * One Android emulator/AVD. A running emulator has a `serial` (e.g.
 * "emulator-5554") and `state:"running"`; an installed-but-stopped AVD has
 * `serial:null` and `state:"stopped"`. `avd` may be null for a running emulator
 * whose AVD name couldn't be resolved.
 */
export declare const EmulatorDeviceSchema: z.ZodObject<{
    avd: z.ZodNullable<z.ZodString>;
    serial: z.ZodNullable<z.ZodString>;
    state: z.ZodString;
}, z.core.$strip>;
/** The composite Android "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export declare const EmulatorReadyForMaestroSchema: z.ZodObject<{
    ready: z.ZodBoolean;
    runningDevice: z.ZodNullable<z.ZodString>;
    metroReachable: z.ZodBoolean;
    mockServerReachable: z.ZodBoolean;
    reasons: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const ServerEmulatorStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"emulator_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    available: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    devices: z.ZodArray<z.ZodObject<{
        avd: z.ZodNullable<z.ZodString>;
        serial: z.ZodNullable<z.ZodString>;
        state: z.ZodString;
    }, z.core.$strip>>;
    readyForMaestro: z.ZodObject<{
        ready: z.ZodBoolean;
        runningDevice: z.ZodNullable<z.ZodString>;
        metroReachable: z.ZodBoolean;
        mockServerReachable: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6137 — ack for a successful `emulator_action` (boot/kill). Echoes `action`
 * (+ optional `avd`/`serial`/`requestId`) and carries the resulting `status`
 * ("starting" after a boot, "killed" after a kill). A failure replies with an
 * `EMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export declare const ServerEmulatorActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"emulator_action_ack">;
    action: z.ZodString;
    avd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    serial: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodNullable<z.ZodString>;
}, z.core.$loose>;
/** One WSL distro from `wsl.exe -l -v`. */
export declare const WslDistroSchema: z.ZodObject<{
    name: z.ZodString;
    state: z.ZodString;
    version: z.ZodNullable<z.ZodNumber>;
    isDefault: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerWslStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"wsl_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    available: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    defaultDistro: z.ZodNullable<z.ZodString>;
    distros: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        state: z.ZodString;
        version: z.ZodNullable<z.ZodNumber>;
        isDefault: z.ZodBoolean;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6138 — ack for a successful `wsl_action` (start/terminate). Echoes `action`/
 * `distro` (+ optional `requestId`) and carries the resulting `status`
 * ("running" after a start, "stopped" after a terminate). A failure replies with
 * a `WSL_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export declare const ServerWslActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"wsl_action_ack">;
    action: z.ZodString;
    distro: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodNullable<z.ZodString>;
}, z.core.$loose>;
/**
 * #5554 — one skill in the inventory snapshot. Carries only names /
 * descriptions / metadata — never the skill BODY (the security boundary: skill
 * bodies never leave the server). Fields:
 *
 *   - `name` / `description` — from the file + frontmatter (description is the
 *     frontmatter `description:` or the first non-empty body line).
 *   - `source` — which tier this entry came from: `global` (~/.chroxy/skills/)
 *     or `repo` (a repo-local `.chroxy/skills/` overlay).
 *   - `activation` — `auto` (always active) or `manual` (opt-in per session).
 *   - `active` — whether the skill is in the default-active set (a manual skill
 *     not yet activated reports `active: false`).
 *   - `providers` — frontmatter provider scoping (empty = applies to all).
 *   - `version` — frontmatter `version:` if present.
 *   - `trustState` — `trusted` / `pending` for community-namespaced skills;
 *     null for plain skills (implicitly trusted).
 *   - `communityAuthor` — the `community/<author>/` namespace, when applicable.
 *   - `hash` / `installed` — joined from the paired `skills.lock` (null when
 *     the lock has no entry for this skill).
 *   - `overridesGlobal` — set on a repo-tier entry that shadows a global skill
 *     of the same name (the per-session loader's repo-wins precedence).
 *   - `lastUsed` / `useCount` / `usedRepos` — the #5554 Phase 2 usage rollup
 *     (lastUsed null + count 0 when never recorded).
 */
export declare const SkillInventoryEntrySchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    source: z.ZodEnum<{
        repo: "repo";
        global: "global";
    }>;
    activation: z.ZodEnum<{
        auto: "auto";
        manual: "manual";
    }>;
    active: z.ZodBoolean;
    providers: z.ZodArray<z.ZodString>;
    version: z.ZodNullable<z.ZodString>;
    trustState: z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>>;
    communityAuthor: z.ZodNullable<z.ZodString>;
    hash: z.ZodNullable<z.ZodString>;
    installed: z.ZodNullable<z.ZodString>;
    overridesGlobal: z.ZodOptional<z.ZodBoolean>;
    lastUsed: z.ZodNullable<z.ZodString>;
    useCount: z.ZodNumber;
    usedRepos: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * #5554 — one surveyed repo's skill overlay. `skills` is the repo-local
 * `.chroxy/skills/` overlay (empty when the repo has no overlay — absence is
 * signal, not an error). `error` carries a per-repo scan-failure reason so a
 * single broken overlay degrades to a chip on that card rather than a dead
 * snapshot.
 */
export declare const SkillInventoryRepoSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        source: z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>;
        activation: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        active: z.ZodBoolean;
        providers: z.ZodArray<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        trustState: z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>>;
        communityAuthor: z.ZodNullable<z.ZodString>;
        hash: z.ZodNullable<z.ZodString>;
        installed: z.ZodNullable<z.ZodString>;
        overridesGlobal: z.ZodOptional<z.ZodBoolean>;
        lastUsed: z.ZodNullable<z.ZodString>;
        useCount: z.ZodNumber;
        usedRepos: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5554 — full Skills inventory snapshot, emitted in reply to a
 * `skills_inventory_request` (see client.ts). `global` is the
 * `~/.chroxy/skills/` tier; `repos` are the per-repo overlays for the surveyed
 * repo set (same set the host / integration surveys resolve). `globalError`
 * degrades the global tier the same way a repo `error` degrades a repo card.
 * `root` is the Control Room discovery root the repo set was resolved under.
 * Same degraded-snapshot-with-`error` posture as the sibling surveys: on a
 * forbidden / in-progress / failed request the handler returns an otherwise
 * valid empty snapshot plus the top-level `error`.
 */
export declare const ServerSkillsInventorySnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_inventory_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    global: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        source: z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>;
        activation: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        active: z.ZodBoolean;
        providers: z.ZodArray<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        trustState: z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>>;
        communityAuthor: z.ZodNullable<z.ZodString>;
        hash: z.ZodNullable<z.ZodString>;
        installed: z.ZodNullable<z.ZodString>;
        overridesGlobal: z.ZodOptional<z.ZodBoolean>;
        lastUsed: z.ZodNullable<z.ZodString>;
        useCount: z.ZodNumber;
        usedRepos: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    globalError: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        skills: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
            source: z.ZodEnum<{
                repo: "repo";
                global: "global";
            }>;
            activation: z.ZodEnum<{
                auto: "auto";
                manual: "manual";
            }>;
            active: z.ZodBoolean;
            providers: z.ZodArray<z.ZodString>;
            version: z.ZodNullable<z.ZodString>;
            trustState: z.ZodNullable<z.ZodEnum<{
                pending: "pending";
                trusted: "trusted";
            }>>;
            communityAuthor: z.ZodNullable<z.ZodString>;
            hash: z.ZodNullable<z.ZodString>;
            installed: z.ZodNullable<z.ZodString>;
            overridesGlobal: z.ZodOptional<z.ZodBoolean>;
            lastUsed: z.ZodNullable<z.ZodString>;
            useCount: z.ZodNumber;
            usedRepos: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #5547: reply to a `summarize_session` request — the model-written
 * continuation brief built from the session's persisted history. Sent only to
 * the requesting client. `summary` is the editable brief the dashboard seeds
 * into the create-session composer; `truncated` flags that the history was
 * windowed before summarization (the brief's header also notes this).
 * `sessionId` echoes the source session, `requestId` correlates the click.
 * Failures surface separately as a `SUMMARIZE_FAILED` session_error echoing
 * `sessionId` / `requestId`.
 */
export declare const ServerSummarizeSessionResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"summarize_session_result">;
    sessionId: z.ZodString;
    summary: z.ZodString;
    truncated: z.ZodOptional<z.ZodBoolean>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
