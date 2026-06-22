/**
 * Control Room survey + action snapshots (#5170 epic): host/repo status, runners, containers, runtime config, BYOK pool, repo-memory/relay, integrations, host-prune, simulators/emulators/WSL, skills inventory, summarize-session.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */

import { z } from 'zod'

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
])

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
})

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
})

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
})

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
})

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
})

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
})

export const ServerMailboxStatusSnapshotSchema = z.object({
  type: z.literal('mailbox_status_snapshot'),
  /** Echoes the request's `requestId` when provided (null otherwise). */
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  registrations: z.array(MailboxRegistrationSchema),
  recentEvents: z.array(MailboxDeliveryEventSchema),
  /** Present only on a refusal (e.g. a session-bound token surveying the host). */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

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
}).passthrough()

export const ServerExternalSessionsSnapshotSchema = z.object({
  type: z.literal('external_sessions_snapshot'),
  /** Echoes the request's `requestId` when provided (null otherwise). */
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  sessions: z.array(ExternalSessionEntrySchema),
  /** Present only on a refusal (e.g. a session-bound token surveying the host). */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

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
})

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
})

// Reply to session_preset_get / _set / _approve / _revoke (see client.ts).
// `preset` is null when the repo has no preset at all. `requestId` is echoed
// when the request carried one.
export const ServerSessionPresetSnapshotSchema = z.object({
  type: z.literal('session_preset_snapshot'),
  cwd: z.string().nullable(),
  preset: ServerSessionPresetFullSchema.nullable(),
  requestId: z.string().max(128).optional(),
})

// ---------------------------------------------------------------------------
// #5253: Self-hosted runner status Control Room surface.
//
// A second host-level pull survey, sibling to the Host/Repo Status one above.
// The client sends `runner_status_request` (see client.ts — the Refresh button
// on the "Self-hosted runners" Control Room tab) and the server replies with
// exactly one `runner_status_snapshot`: the state of every GitHub Actions
// self-hosted runner installed on the host, grouped by the repo (or org) it
// serves. Same pull-on-Refresh model as host_status — no delta stream.
//
// Same forward/back-compat posture as the host survey: schemas strip unknown
// fields, so an older client ignores newer fields and a client predating these
// types ignores the unknown `type` at dispatch.
// ---------------------------------------------------------------------------

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
export const RunnerVerdictSchema = z.enum([
  'busy',
  'idle',
  'offline',
  'stopped',
  'unregistered',
])

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
export const RunnerServiceStateSchema = z.object({
  manager: z.enum(['launchd', 'systemd', 'none']),
  label: z.string().nullable(),
  running: z.boolean(),
  pid: z.number().int().nonnegative().finite().nullable(),
  lastExitCode: z.number().int().finite().nullable(),
})

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
export const RunnerInfoSchema = z.object({
  name: z.string(),
  dir: z.string(),
  verdict: RunnerVerdictSchema,
  service: RunnerServiceStateSchema,
  githubStatus: z.enum(['online', 'offline']).nullable(),
  busy: z.boolean().nullable(),
  os: z.string().nullable(),
  labels: z.array(z.string()),
})

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
export const RepoRunnersSchema = z.object({
  name: z.string(),
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  githubUrl: z.string(),
  runnersUrl: z
    .string()
    .regex(
      /^https:\/\/github\.com\/(?:[^/]+\/[^/]+\/settings\/actions\/runners|organizations\/[^/]+\/settings\/actions\/runners)$/,
      'must be a GitHub runner-settings URL',
    )
    .nullable(),
  runners: z.array(RunnerInfoSchema),
})

/**
 * Aggregate runner counts across the host, one per verdict bucket plus a
 * `total`. Carried alongside `repos` so the runner tab's summary chips don't
 * re-tally. All non-negative integers.
 */
export const RunnerStatusSummarySchema = z.object({
  total: z.number().int().nonnegative().finite(),
  busy: z.number().int().nonnegative().finite(),
  idle: z.number().int().nonnegative().finite(),
  offline: z.number().int().nonnegative().finite(),
  stopped: z.number().int().nonnegative().finite(),
  unregistered: z.number().int().nonnegative().finite(),
})

/**
 * #5253 — full self-hosted runner snapshot. Emitted in reply to a
 * `runner_status_request` (see client.ts). `root` is the scanned runner-install
 * root (default `~/github-runners`). `generatedAt` is the ISO-8601 survey time
 * for the "generated Nm ago" line. An empty `repos` array is the valid "no
 * runners installed under the root" state — never omitted.
 */
export const ServerRunnerStatusSnapshotSchema = z.object({
  type: z.literal('runner_status_snapshot'),
  // Echoes the client's `runner_status_request` requestId so the dashboard can
  // correlate a snapshot to the Refresh click that triggered it. Present (null
  // when the client omitted one); the handler always sets it.
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  root: z.string(),
  summary: RunnerStatusSummarySchema,
  repos: z.array(RepoRunnersSchema),
  // Additive degraded-snapshot annotation: on a forbidden/in-progress/failed
  // survey the handler returns an otherwise-valid (empty repos, zeroed summary)
  // snapshot plus this `error`, so consumers can surface the failure typed
  // rather than special-casing a malformed reply.
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
})

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
})

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
})

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
})

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
})

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
})

/** Compose detection for one repo: present + the compose file path(s)
 *  (a devcontainer `dockerComposeFile`, else repo-root compose files). */
export const RepoRuntimeComposeSchema = z.object({
  present: z.boolean(),
  files: z.array(z.string()),
})

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
})

/** Headline counts across the repo set. */
export const RepoRuntimeConfigSummarySchema = z.object({
  total: z.number().int().nonnegative().finite(),
  withDevcontainer: z.number().int().nonnegative().finite(),
  withCompose: z.number().int().nonnegative().finite(),
  imagesDenied: z.number().int().nonnegative().finite(),
  errored: z.number().int().nonnegative().finite(),
})

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
})

// ---------------------------------------------------------------------------
// #6135 (epic #5530) — Control Room "BYOK pool" tab: docker-byok warm-container
// pool observability. Emitted in reply to a `byok_pool_status_request` (see
// client.ts). Read-only. The pool is OFF by default — `enabled: false` with a
// `note` is a first-class state, not an error. Same pull-on-Refresh,
// degraded-snapshot-with-`error` posture as the sibling surveys.
// ---------------------------------------------------------------------------

/** Configured pool bounds. `maxAgeMs` is null when unbounded (Infinity). */
export const ByokPoolLimitsSchema = z.object({
  idleTimeoutMs: z.number().nonnegative().finite(),
  maxPerKey: z.number().int().nonnegative().finite(),
  maxTotal: z.number().int().nonnegative().finite(),
  maxAgeMs: z.number().nonnegative().finite().nullable(),
})

/** One per-resource-shape warm bucket: count + idle age of the oldest entry. */
export const ByokPoolBucketSchema = z.object({
  key: z.string(),
  size: z.number().int().nonnegative().finite(),
  oldestIdleMs: z.number().nonnegative().finite(),
})

/** One recent eviction (bounded tail): which key/container and why. */
export const ByokPoolEvictionSchema = z.object({
  key: z.string(),
  containerId: z.string().nullable(),
  reason: z.string(),
  timestamp: z.number().finite(),
})

/** Live rolling pool stats from the aggregator. Null when the pool is off. */
export const ByokPoolStatsSchema = z.object({
  hits: z.number().int().nonnegative().finite(),
  misses: z.number().int().nonnegative().finite(),
  releases: z.number().int().nonnegative().finite(),
  shutdowns: z.number().int().nonnegative().finite(),
  hitRate: z.number().finite(),
  totalSize: z.number().int().nonnegative().finite(),
  buckets: z.array(ByokPoolBucketSchema),
  // Per-reason eviction counts — non-negative integers, matching the other count
  // fields' rigor (the aggregator only ever produces integer counts).
  evictionsByReason: z.record(z.string(), z.number().int().nonnegative().finite()),
  recentEvictions: z.array(ByokPoolEvictionSchema),
})

export const ServerByokPoolStatusSnapshotSchema = z.object({
  type: z.literal('byok_pool_status_snapshot'),
  // Echoes the client's request requestId (null when omitted) for correlation.
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // Whether the docker-byok pool is enabled on this host. When false, `limits`
  // and `stats` are null and `note` explains why — a first-class state.
  enabled: z.boolean(),
  note: z.string().nullable(),
  limits: ByokPoolLimitsSchema.nullable(),
  stats: ByokPoolStatsSchema.nullable(),
  // Additive degraded-snapshot annotation (mirrors the sibling surveys): a
  // forbidden/in-progress/failed survey returns an otherwise-valid (disabled,
  // null limits/stats) snapshot plus this `error`.
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
})

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
})

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
})

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
})

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
})

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
export const RepoRelayVerdictSchema = z.enum(['ok', 'failing', 'drifted', 'not_installed', 'unknown'])

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
})

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
})

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
})

/**
 * Snapshot-level note about the `repo-memory` CLI binary, probed ONCE per
 * survey. When `found` is false every configured repo's CLI-derived cells are
 * degraded and `note` explains why (the per-repo `reason` repeats it).
 */
export const IntegrationCliStatusSchema = z.object({
  found: z.boolean(),
  path: z.string().nullable(),
  note: z.string().nullable(),
})

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
})

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
})

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
}).passthrough()

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
}).passthrough()

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
}).passthrough()

// ---------------------------------------------------------------------------
// #6140 (epic #5530) — Control Room host prune guardrails. Read-only survey of
// reclaimable, chroxy-scoped, ORPHAN-ONLY host docker pressure, plus a prune
// action that removes ONLY those surveyed ids (never a blanket docker prune,
// never a running/tracked/non-chroxy resource). Same degraded-snapshot posture
// as the sibling surveys: docker absent → dockerAvailable:false + a note, never
// an error.
// ---------------------------------------------------------------------------

/** One prunable chroxy container (stopped/created/dead, not tracked by a live env). */
export const HostPruneContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  sizeBytes: z.number().nonnegative().finite().nullable(),
})

/** One prunable chroxy snapshot image (not referenced by a live env). */
export const HostPruneImageSchema = z.object({
  id: z.string(),
  ref: z.string(),
  repository: z.string(),
  sizeBytes: z.number().nonnegative().finite().nullable(),
})

export const ServerHostPruneStatusSnapshotSchema = z.object({
  type: z.literal('host_prune_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // Whether docker could be probed. false → containers/images empty, note set.
  dockerAvailable: z.boolean(),
  // Additive note (e.g. docker unavailable, or one image repo couldn't be listed).
  note: z.string().nullable(),
  containers: z.array(HostPruneContainerSchema),
  images: z.array(HostPruneImageSchema),
  summary: z.object({
    containerCount: z.number().int().nonnegative().finite(),
    imageCount: z.number().int().nonnegative().finite(),
    // Upper-bound estimate (image layers are shared) — labelled as such in the UI.
    reclaimableBytes: z.number().nonnegative().finite(),
  }),
  // Degraded-snapshot annotation (forbidden/in-progress/failed), like siblings.
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
}).passthrough()

/**
 * #6140 — ack for a successful `host_prune_action`. Echoes `kind` (+ optional
 * `requestId`) and carries what was actually removed: per-resource removed counts,
 * an estimated `reclaimedBytes`, and a `failures` list (resources that survived
 * the re-survey but whose `docker rm`/`rmi` failed — e.g. an image still
 * referenced). A failure to even start replies with a `HOST_PRUNE_ACTION_FAILED`
 * session_error carrying the same correlation fields.
 */
export const ServerHostPruneActionAckSchema = z.object({
  type: z.literal('host_prune_action_ack'),
  kind: z.string(),
  requestId: z.string().max(128).nullable().optional(),
  dockerAvailable: z.boolean(),
  removedContainers: z.number().int().nonnegative().finite(),
  removedImages: z.number().int().nonnegative().finite(),
  reclaimedBytes: z.number().nonnegative().finite(),
  failures: z.array(z.object({ ref: z.string(), error: z.string() })),
}).passthrough()

// ───────────────────────────────────────────────────────────────────────────
// #6136 (epic #5530) — Control Room iOS simulator survey + "Ready for Maestro"
// verdict. Read-only. Off macOS / no xcrun → available:false (a first-class
// state, not an error), same degraded-snapshot posture as the sibling surveys.
// ───────────────────────────────────────────────────────────────────────────

/** One iOS simulator from `xcrun simctl list devices`. */
export const SimulatorDeviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(),       // "Booted" | "Shutdown" | "Unknown" | …
  runtime: z.string(),     // friendly, e.g. "iOS 26.1"
  deviceType: z.string().nullable(),
  isAvailable: z.boolean(),
})

/** The composite "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export const ReadyForMaestroSchema = z.object({
  ready: z.boolean(),
  bootedSimulator: z.string().nullable(),
  metroReachable: z.boolean(),
  mockServerReachable: z.boolean(),
  reasons: z.array(z.string()),
})

export const ServerSimulatorStatusSnapshotSchema = z.object({
  type: z.literal('simulator_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // false off macOS / no xcrun → devices empty, note set, verdict not-ready.
  available: z.boolean(),
  note: z.string().nullable(),
  devices: z.array(SimulatorDeviceSchema),
  readyForMaestro: ReadyForMaestroSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

/**
 * #6136 slice 2 — ack for a successful `simulator_action` (boot/shutdown).
 * Echoes `action`/`udid` (+ optional `requestId`) and carries the resulting
 * `status` (the device's new state, "Booted"/"Shutdown"). A failure replies with
 * a `SIMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export const ServerSimulatorActionAckSchema = z.object({
  type: z.literal('simulator_action_ack'),
  action: z.string(),
  udid: z.string(),
  requestId: z.string().max(128).nullable().optional(),
  status: z.string().nullable(),
}).passthrough()

// ───────────────────────────────────────────────────────────────────────────
// #6137 (epic #5530) — Control Room Android emulator survey + "Ready for Maestro"
// verdict (shares the Device runtimes tab with iOS). Read-only. No Android SDK →
// available:false (a first-class state), same degraded-snapshot posture.
// ───────────────────────────────────────────────────────────────────────────

/**
 * One Android emulator/AVD. A running emulator has a `serial` (e.g.
 * "emulator-5554") and `state:"running"`; an installed-but-stopped AVD has
 * `serial:null` and `state:"stopped"`. `avd` may be null for a running emulator
 * whose AVD name couldn't be resolved.
 */
export const EmulatorDeviceSchema = z.object({
  avd: z.string().nullable(),
  serial: z.string().nullable(),
  state: z.string(),       // "running" | "stopped"
})

/** The composite Android "Ready for Maestro" verdict (CLAUDE.md pre-flight). */
export const EmulatorReadyForMaestroSchema = z.object({
  ready: z.boolean(),
  runningDevice: z.string().nullable(),
  metroReachable: z.boolean(),
  mockServerReachable: z.boolean(),
  reasons: z.array(z.string()),
})

export const ServerEmulatorStatusSnapshotSchema = z.object({
  type: z.literal('emulator_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // false with no Android SDK → devices empty, note set, verdict not-ready.
  available: z.boolean(),
  note: z.string().nullable(),
  devices: z.array(EmulatorDeviceSchema),
  readyForMaestro: EmulatorReadyForMaestroSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

/**
 * #6137 — ack for a successful `emulator_action` (boot/kill). Echoes `action`
 * (+ optional `avd`/`serial`/`requestId`) and carries the resulting `status`
 * ("starting" after a boot, "killed" after a kill). A failure replies with an
 * `EMULATOR_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export const ServerEmulatorActionAckSchema = z.object({
  type: z.literal('emulator_action_ack'),
  action: z.string(),
  avd: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  requestId: z.string().max(128).nullable().optional(),
  status: z.string().nullable(),
}).passthrough()

// ───────────────────────────────────────────────────────────────────────────
// #6138 (epic #5530) — Control Room WSL2 distro survey (shares the Device
// runtimes tab). Read-only. Off Windows / no wsl.exe → available:false (a
// first-class state), same degraded-snapshot posture.
// ───────────────────────────────────────────────────────────────────────────

/** One WSL distro from `wsl.exe -l -v`. */
export const WslDistroSchema = z.object({
  name: z.string(),
  state: z.string(),                 // "Running" | "Stopped" | "Unknown" | …
  version: z.number().nullable(),    // WSL version (1 | 2), null if unparseable
  isDefault: z.boolean(),
})

export const ServerWslStatusSnapshotSchema = z.object({
  type: z.literal('wsl_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // false off Windows / no wsl.exe → distros empty, note set.
  available: z.boolean(),
  note: z.string().nullable(),
  defaultDistro: z.string().nullable(),
  distros: z.array(WslDistroSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough()

/**
 * #6138 — ack for a successful `wsl_action` (start/terminate). Echoes `action`/
 * `distro` (+ optional `requestId`) and carries the resulting `status`
 * ("running" after a start, "stopped" after a terminate). A failure replies with
 * a `WSL_ACTION_FAILED` session_error carrying the same correlation fields.
 */
export const ServerWslActionAckSchema = z.object({
  type: z.literal('wsl_action_ack'),
  action: z.string(),
  distro: z.string(),
  requestId: z.string().max(128).nullable().optional(),
  status: z.string().nullable(),
}).passthrough()

// ───────────────────────────────────────────────────────────────────────────
// #5554 (epic #5159) — Control Room "Skills" tab: inventory + usage history.
// ───────────────────────────────────────────────────────────────────────────

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
export const SkillInventoryEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(['global', 'repo']),
  activation: z.enum(['auto', 'manual']),
  active: z.boolean(),
  providers: z.array(z.string()),
  version: z.string().nullable(),
  trustState: z.enum(['trusted', 'pending']).nullable(),
  communityAuthor: z.string().nullable(),
  hash: z.string().nullable(),
  installed: z.string().nullable(),
  overridesGlobal: z.boolean().optional(),
  lastUsed: z.string().datetime().nullable(),
  useCount: z.number().int().nonnegative().finite(),
  usedRepos: z.array(z.string()),
})

/**
 * #5554 — one surveyed repo's skill overlay. `skills` is the repo-local
 * `.chroxy/skills/` overlay (empty when the repo has no overlay — absence is
 * signal, not an error). `error` carries a per-repo scan-failure reason so a
 * single broken overlay degrades to a chip on that card rather than a dead
 * snapshot.
 */
export const SkillInventoryRepoSchema = z.object({
  name: z.string(),
  path: z.string(),
  skills: z.array(SkillInventoryEntrySchema),
  error: z.string().nullable(),
})

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
export const ServerSkillsInventorySnapshotSchema = z.object({
  type: z.literal('skills_inventory_snapshot'),
  requestId: z.string().max(128).nullable().optional(),
  generatedAt: z.string().datetime(),
  root: z.string(),
  global: z.array(SkillInventoryEntrySchema),
  globalError: z.string().nullable().optional(),
  repos: z.array(SkillInventoryRepoSchema),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
})

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
export const ServerSummarizeSessionResultSchema = z.object({
  type: z.literal('summarize_session_result'),
  sessionId: z.string(),
  summary: z.string(),
  truncated: z.boolean().optional(),
  requestId: z.string().max(128).nullable().optional(),
}).passthrough()
