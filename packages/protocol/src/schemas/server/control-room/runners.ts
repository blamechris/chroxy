/**
 * Self-hosted GitHub Actions runner status survey (#5253): per-host runner installs grouped by the repo/org they register against, each with a health verdict.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */

import { z } from 'zod'

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
