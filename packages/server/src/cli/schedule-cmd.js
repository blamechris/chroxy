/**
 * `chroxy schedule` — CRUD against the persisted scheduled-task registry
 * (#6868, consumer slice of epic #6784).
 *
 * This CLI operates purely on the on-disk registry (#6862,
 * `scheduled-task-store.js`) via the store's own API — it never hand-writes
 * the JSON file, and it never re-implements cadence parsing: every cadence
 * (`--at` / `--cron`) is validated by the store, which itself calls
 * `schedule-parser.js`'s `parseCron`/`computeNextRun`. Nothing here requires
 * the headless engine (#6865, `scheduler.js`) to be running — create/list/
 * edit/pause/resume/delete/last-run all just read and write the registry
 * file.
 *
 * What IS reused from the engine, deliberately (rather than re-derived), is
 * its judgment about whether a task can actually fire:
 *   - `scheduledProviderRefusalReason` — the exact "will this provider be
 *     refused?" check `scheduler.js` runs before every fire. A task whose
 *     target provider has no in-process permission answering (including the
 *     daemon DEFAULT `claude-tui`) gets a clear warning at create/edit time
 *     instead of silently sitting dead until an operator notices `refused`
 *     outcomes days later.
 *   - `resolveScheduledPermissionMode` — the exact clamp the engine applies
 *     per fire. A task that asks for a permission mode above `approve`/`plan`
 *     is warned that it will be silently de-escalated, not rejected (the
 *     store itself allows any `ALLOWED_PERMISSION_MODE_IDS` value — only the
 *     engine's floor is stricter).
 *   - `isSchedulerEnabled` — the same default-off gate the daemon checks.
 *     `create`/`edit` still succeed with the gate closed (the task is a
 *     legitimate standing definition even before the operator opts in), but
 *     say plainly that nothing will fire yet.
 *
 * `list` and `last-run` render a task's `lastRun` status verbatim (never
 * papered over): `refused` and a best-effort-persisted quarantine message
 * both show up as an unhealthy `[REFUSED]`/`[ERROR]` tag, a deliberately
 * stopped run shows `[INTERRUPTED]` rather than borrowing the crash tag
 * (#7038), and a task that has never fired is always labelled `[NEVER RUN]`
 * rather than left blank — nothing here is allowed to *look* healthy when it
 * isn't, and nothing is allowed to look BROKEN when it merely stopped.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR, CONFIG_FILE } from './shared.js'
import {
  ScheduledTaskStore,
  ScheduledTaskValidationError,
  defaultScheduledTasksPath,
} from '../scheduled-task-store.js'
import { isSchedulerEnabled } from '../config.js'
import { scheduledProviderRefusalReason, resolveScheduledPermissionMode } from '../scheduler.js'
import { DEFAULT_PROVIDER } from '../providers.js'

// -- default wiring (production) ---------------------------------------------

/** Read config.json best-effort — never throws, never exits (mirrors worktree-gc-cmd.js). */
function readConfigSoft(configPath) {
  try {
    if (!existsSync(configPath)) return {}
    return JSON.parse(readFileSync(configPath, 'utf-8')) || {}
  } catch {
    return {}
  }
}

/**
 * The registry file THIS DAEMON would load — a sibling of session-state.json.
 *
 * Deliberately rooted at `homedir()/.chroxy` (shared.js's `CONFIG_DIR`) and
 * deliberately NOT at `$CHROXY_CONFIG_DIR`, because the daemon's own registry
 * path is home-rooted at every hop:
 *
 *   1. `server-cli.js` constructs its `SessionManager` withOUT a
 *      `stateFilePath` (the string does not appear in that file at all), so the
 *      manager falls back to `session-manager.js`'s `DEFAULT_STATE_FILE` =
 *      `join(homedir(), '.chroxy', 'session-state.json')`.
 *   2. `session-manager.js` then derives `this.scheduledTaskStore` from that
 *      path via `defaultScheduledTasksPath()` — i.e. the live scheduler
 *      (#6865) reads `~/.chroxy/scheduled-tasks.json`.
 *
 * Neither hop consults `CHROXY_CONFIG_DIR`. Plenty of OTHER subsystems do
 * (models.js, connection-info.js, doctor.js, device-preferences.js, …), so the
 * convention genuinely is inconsistent — that split is tracked in #7052, and
 * fixing it means moving the WRITERS, not just this reader. Honouring the env var *here*
 * would point this CLI at a file the running scheduler never opens, and
 * `schedule create` would print "Created scheduled task …" for a task that can
 * never fire while `schedule list` showed an empty registry. That is precisely
 * the report-success-while-silently-wrong failure this module's doc block
 * exists to prevent, so matching the daemon beats matching the convention.
 *
 * The same reasoning applies to `CONFIG_FILE` below: `server-cli-child.js`
 * reads `join(homedir(), '.chroxy', 'config.json')`, so reading config from the
 * home-rooted path is what makes `config.provider` / `features.scheduler` here
 * agree with what the daemon resolved.
 *
 * Pinned from both sides by tests: a spawn test asserts the registry does NOT
 * follow `CHROXY_CONFIG_DIR` (tests/cli/schedule-cmd.test.js), and a drift
 * guard asserts the daemon-side path this mirrors is still home-rooted
 * (tests/schedule-cli.test.js). If the session-state family is ever migrated
 * onto `CHROXY_CONFIG_DIR` (#7052), the drift guard goes red and this resolver
 * must move with it.
 */
export function defaultScheduleRegistryPath() {
  return defaultScheduledTasksPath(join(CONFIG_DIR, 'session-state.json'))
}

function getDefaultStore() {
  const store = new ScheduledTaskStore({ filePath: defaultScheduleRegistryPath() })
  store.load()
  return store
}

/**
 * Build the dependency bag every exported command function runs against.
 * Every dependency is overridable so tests never touch the real
 * `~/.chroxy/` tree and never need a live provider registry or config file —
 * see tests/schedule-cli.test.js.
 */
function buildDeps(overrides = {}) {
  const config = readConfigSoft(CONFIG_FILE)
  return {
    store: overrides.store || getDefaultStore(),
    write: overrides.write || console.log,
    // The provider a task would ACTUALLY run against when none is set
    // explicitly — mirrors the daemon's own resolution, `config.provider ||
    // DEFAULT_PROVIDER` (server-cli.js's `providerType` wiring; scheduler.js's
    // live `_resolveProviderName` falls back to the wired SessionManager's
    // `providerType`, which IS this same expression). Reading config.provider
    // here (not just hardcoding DEFAULT_PROVIDER) matters: if the operator's
    // configured default ever diverges from DEFAULT_PROVIDER, this warning
    // must track what will actually run, not the out-of-the-box default.
    defaultProviderName: overrides.defaultProviderName || config.provider || DEFAULT_PROVIDER,
    checkProviderRefusal: overrides.checkProviderRefusal || ((name) => scheduledProviderRefusalReason(name)),
    resolvePermissionMode: overrides.resolvePermissionMode || resolveScheduledPermissionMode,
    checkSchedulerEnabled: overrides.checkSchedulerEnabled || (() => isSchedulerEnabled(config)),
  }
}

// -- formatting helpers --------------------------------------------------

/** Deterministic UTC rendering (no locale/timezone dependence) — easy to test, unambiguous to read. */
function formatEpoch(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

function describeCadence(cadence) {
  if (!cadence || typeof cadence !== 'object') return '(invalid cadence)'
  switch (cadence.kind) {
    case 'once':
      return `once @ ${formatEpoch(cadence.at)}`
    case 'interval':
      return `every ${formatDurationMs(cadence.everyMs)}`
    case 'cron':
      return `cron "${cadence.expression}"`
    default:
      return `(unknown cadence: ${cadence.kind})`
  }
}

/**
 * A task's honest at-a-glance health. `PAUSED` takes priority (an operator
 * turned it off on purpose); otherwise a task that has never fired is always
 * `NEVER RUN` — never blank, never mistaken for healthy — and every recorded
 * `lastRun.status` maps to its own tag so `refused` (and a best-effort
 * quarantine write, which persists as `refused`) is never confused with
 * `success`, and `interrupted` (#7038 — a deliberate Stop) is never confused
 * with `error`.
 *
 * Kept byte-for-byte in step with `deriveScheduledTaskHealthTag` in
 * @chroxy/protocol; `tests/scheduled-task-health-parity.test.js` fails if a
 * status the shared helper tags by name falls through to `default:` here.
 */
function healthTag(task) {
  if (!task.enabled) return 'PAUSED'
  if (!task.lastRun) return 'NEVER RUN'
  switch (task.lastRun.status) {
    case 'success':
      return 'OK'
    case 'refused':
      return 'REFUSED'
    case 'skipped':
      return 'SKIPPED'
    case 'timeout':
      return 'TIMEOUT'
    case 'interrupted':
      return 'INTERRUPTED'
    default:
      return 'ERROR'
  }
}

function describeLastRun(lastRun) {
  if (!lastRun) return 'never run'
  let line = `${lastRun.status} @ ${formatEpoch(lastRun.at)}`
  if (lastRun.sessionId) line += ` (session ${lastRun.sessionId})`
  if (lastRun.error) line += ` — ${lastRun.error}`
  return line
}

// -- input parsing ---------------------------------------------------------

/**
 * Parse `--at` into epoch-ms: bare digits are epoch-ms, else Date.parse (ISO-8601).
 *
 * Timezone handling is `Date.parse`'s, unchanged and on purpose: a date-time
 * string with no offset (`2026-08-01T09:00:00`) is interpreted in the HOST's
 * local timezone, while everything this CLI prints is UTC (`formatEpoch`).
 * Re-interpreting an offset-less string as UTC would silently move every
 * already-scripted `--at` invocation by the operator's UTC offset, so the fix
 * for the mismatch is to make the hint and the `--at` help text say which is
 * which — not to change what a given string means. See #7015.
 */
function parseAtValue(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: '--at requires a value' }
  }
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed)
    return Number.isFinite(ms)
      ? { at: ms }
      : { error: `--at '${raw}' is not a valid epoch-ms timestamp` }
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    return {
      error: `--at '${raw}' could not be parsed — use an ISO-8601 timestamp `
        + '(e.g. 2026-08-01T09:00:00Z) or epoch milliseconds. Times are displayed in UTC; '
        + 'a timestamp with no timezone is read as LOCAL time, so add a trailing Z '
        + '(or a ±hh:mm offset) to say exactly which instant you mean',
    }
  }
  return { at: parsed }
}

/** Build a brand-new cadence for `create` — exactly one of --at/--cron is required. */
function buildCadenceForCreate(options) {
  const hasAt = options.at !== undefined
  const hasCron = options.cron !== undefined
  if (hasAt && hasCron) return { error: '--at and --cron are mutually exclusive — pick one cadence' }
  if (!hasAt && !hasCron) {
    return { error: 'specify a cadence: --at <when> for a one-time run, or --cron <expr> for a recurring one' }
  }
  if (hasCron) {
    if (typeof options.cron !== 'string' || options.cron.trim().length === 0) {
      return { error: '--cron requires a 5-field crontab expression' }
    }
    return { cadence: { kind: 'cron', expression: options.cron } }
  }
  const parsed = parseAtValue(options.at)
  if (parsed.error) return { error: parsed.error }
  return { cadence: { kind: 'once', at: parsed.at } }
}

/** Build a cadence PATCH for `edit` — absent when neither flag is given (no change). */
function buildCadencePatch(options) {
  const hasAt = options.at !== undefined
  const hasCron = options.cron !== undefined
  if (!hasAt && !hasCron) return {}
  if (hasAt && hasCron) return { error: '--at and --cron are mutually exclusive — pick one cadence' }
  return buildCadenceForCreate(options)
}

/** Collect only the target fields the caller actually passed. */
function buildTargetFields(options) {
  const target = {}
  if (options.provider !== undefined) target.provider = options.provider
  if (options.model !== undefined) target.model = options.model
  if (options.cwd !== undefined) target.cwd = options.cwd
  if (options.permissionMode !== undefined) target.permissionMode = options.permissionMode
  return target
}

/** Resolve a caller-supplied id or unique id-prefix to a stored task. */
function resolveTaskId(store, idOrPrefix) {
  if (typeof idOrPrefix !== 'string' || idOrPrefix.trim().length === 0) {
    return { error: 'A task id (or unique id-prefix) is required.', errorCode: 'no-target' }
  }
  const target = idOrPrefix.trim()
  const all = store.list()
  const exact = all.find((t) => t.id === target)
  if (exact) return { task: exact }
  const matches = all.filter((t) => t.id.startsWith(target))
  if (matches.length === 0) {
    return { error: `No scheduled task matches "${target}". Run: chroxy schedule list`, errorCode: 'no-match' }
  }
  if (matches.length > 1) {
    return {
      error: `"${target}" matches ${matches.length} tasks — use a longer id prefix to disambiguate.`,
      errorCode: 'ambiguous',
      matches: matches.length,
    }
  }
  return { task: matches[0] }
}

/**
 * The honesty layer: warnings surfaced at create/edit time so a task's
 * problems are visible up front rather than discovered later in `list`.
 * Every check here reuses an engine-owned function — nothing is
 * re-implemented — per the module doc above.
 */
function computeWarnings(task, deps) {
  const warnings = []
  const providerName = task.target?.provider || deps.defaultProviderName
  const refusal = deps.checkProviderRefusal(providerName)
  if (refusal) {
    warnings.push(`provider '${providerName}' will be REFUSED when this task is due — nothing will run: ${refusal}`)
  }
  const requestedMode = task.target?.permissionMode
  if (requestedMode) {
    const resolvedMode = deps.resolvePermissionMode(requestedMode)
    if (resolvedMode !== requestedMode) {
      warnings.push(
        `permission mode '${requestedMode}' will be clamped to '${resolvedMode}' when this task fires `
          + '— unattended runs can never use a more permissive mode',
      )
    }
  }
  if (!deps.checkSchedulerEnabled()) {
    warnings.push(
      'scheduled execution is currently DISABLED on this daemon — this task is saved but will NOT fire '
        + 'until enabled (set features.scheduler: true in config.json or CHROXY_ENABLE_SCHEDULER=1, then restart the daemon)',
    )
  }
  return warnings
}

// -- command implementations (pure aside from injected deps) ---------------

/**
 * `chroxy schedule create` — validates + persists via `store.add()` (which
 * itself validates the cadence through schedule-parser.js), then surfaces
 * the computed next-run and any create-time warnings.
 * @returns {{created:boolean, task?:object, warnings?:string[], error?:string, message?:string, field?:string}}
 */
export function runScheduleCreate(options = {}, depsOverride = {}) {
  const deps = buildDeps(depsOverride)
  const out = deps.write

  if (typeof options.prompt !== 'string' || options.prompt.trim().length === 0) {
    out('A --prompt is required (the instructions the scheduled run executes).')
    return { created: false, error: 'missing-prompt' }
  }

  const cadenceResult = buildCadenceForCreate(options)
  if (cadenceResult.error) {
    out(cadenceResult.error)
    return { created: false, error: 'invalid-cadence', message: cadenceResult.error }
  }

  const target = buildTargetFields(options)

  let task
  try {
    task = deps.store.add({
      name: options.name,
      prompt: options.prompt,
      cadence: cadenceResult.cadence,
      target,
      enabled: !options.paused,
    })
  } catch (err) {
    if (err instanceof ScheduledTaskValidationError) {
      out(`Invalid schedule: ${err.field ? `${err.field} — ` : ''}${err.message}`)
      return { created: false, error: 'validation', field: err.field, message: err.message }
    }
    out(`Failed to create scheduled task: ${err?.message || err}`)
    return { created: false, error: 'store-error', message: err?.message || String(err) }
  }

  const warnings = computeWarnings(task, deps)

  if (options.json) {
    out(JSON.stringify({ task, warnings }, null, 2))
  } else {
    out(`Created scheduled task ${task.id}${task.name ? ` (${task.name})` : ''}`)
    out(`  cadence:  ${describeCadence(task.cadence)}`)
    out(`  next run: ${task.enabled ? formatEpoch(task.nextRun) : `— (paused; resume with: chroxy schedule resume ${task.id})`}`)
    for (const w of warnings) out(`  WARNING: ${w}`)
  }
  return { created: true, task, warnings }
}

/**
 * `chroxy schedule list` — every task with its honest health tag, next-run,
 * and last-run, plus the daemon's global enable-gate state up top.
 * @returns {{schedulerEnabled:boolean, tasks:Array<{task:object,health:string,providerRefusal:string|null}>}}
 */
export function runScheduleList(options = {}, depsOverride = {}) {
  const deps = buildDeps(depsOverride)
  const out = deps.write
  const tasks = deps.store.list()
  const schedulerEnabled = deps.checkSchedulerEnabled()

  const rows = tasks.map((task) => {
    const providerName = task.target?.provider || deps.defaultProviderName
    return { task, health: healthTag(task), providerRefusal: deps.checkProviderRefusal(providerName) }
  })

  if (options.json) {
    out(JSON.stringify({
      schedulerEnabled,
      tasks: rows.map((r) => ({ ...r.task, health: r.health, providerRefusal: r.providerRefusal })),
    }, null, 2))
    return { schedulerEnabled, tasks: rows }
  }

  out(schedulerEnabled
    ? 'Scheduled execution: ENABLED'
    : 'Scheduled execution: DISABLED — tasks below are saved but will NOT fire. '
      + 'Enable via features.scheduler: true in config.json or CHROXY_ENABLE_SCHEDULER=1, then restart the daemon.')
  out('')

  if (rows.length === 0) {
    out('No scheduled tasks. Create one: chroxy schedule create --prompt "..." --cron "0 9 * * *"')
    return { schedulerEnabled, tasks: [] }
  }

  out(`${rows.length} scheduled task(s):`)
  out('')
  let enabledCount = 0
  let pausedCount = 0
  let refusedCount = 0
  let neverRunCount = 0
  for (const { task, health, providerRefusal } of rows) {
    if (task.enabled) enabledCount++
    else pausedCount++
    if (!task.lastRun) neverRunCount++
    else if (task.lastRun.status === 'refused') refusedCount++

    const label = task.name || '(unnamed)'
    out(`[${health}] ${label}  (${task.id})`)
    out(`  cadence:  ${describeCadence(task.cadence)}`)
    out(`  next run: ${task.enabled ? formatEpoch(task.nextRun) : '— (paused)'}`)
    out(`  last run: ${describeLastRun(task.lastRun)}`)
    if (providerRefusal) {
      const providerName = task.target?.provider || deps.defaultProviderName
      out(`  provider check: '${providerName}' will be REFUSED when due — ${providerRefusal}`)
    }
    out('')
  }

  const bits = [`${enabledCount} enabled`, `${pausedCount} paused`]
  if (refusedCount > 0) bits.push(`${refusedCount} refused`)
  if (neverRunCount > 0) bits.push(`${neverRunCount} never run`)
  out(`Summary: ${bits.join(', ')}.`)

  return { schedulerEnabled, tasks: rows }
}

/**
 * `chroxy schedule edit <id>` — patches only the fields the caller passed.
 * `target` fields are merged onto the EXISTING target (store.update replaces
 * the whole object, so a partial `--model` edit must not drop `--provider`).
 * @returns {{updated:boolean, task?:object, warnings?:string[], error?:string, message?:string, field?:string}}
 */
export function runScheduleEdit(idOrPrefix, options = {}, depsOverride = {}) {
  const deps = buildDeps(depsOverride)
  const out = deps.write
  const resolved = resolveTaskId(deps.store, idOrPrefix)
  if (resolved.error) {
    out(resolved.error)
    return { updated: false, error: resolved.errorCode || 'not-found', message: resolved.error }
  }
  const existing = resolved.task

  const patch = {}
  if (options.prompt !== undefined) patch.prompt = options.prompt
  if (options.name !== undefined) patch.name = options.name

  const cadenceResult = buildCadencePatch(options)
  if (cadenceResult.error) {
    out(cadenceResult.error)
    return { updated: false, error: 'invalid-cadence', message: cadenceResult.error }
  }
  if (cadenceResult.cadence) patch.cadence = cadenceResult.cadence

  const targetFields = buildTargetFields(options)
  if (Object.keys(targetFields).length > 0) {
    patch.target = { ...existing.target, ...targetFields }
  }

  if (Object.keys(patch).length === 0) {
    out('Nothing to edit — pass at least one of --prompt, --name, --at/--cron, --provider, --model, --cwd, --permission-mode.')
    return { updated: false, error: 'no-changes' }
  }

  let task
  try {
    task = deps.store.update(existing.id, patch)
  } catch (err) {
    if (err instanceof ScheduledTaskValidationError) {
      out(`Invalid schedule: ${err.field ? `${err.field} — ` : ''}${err.message}`)
      return { updated: false, error: 'validation', field: err.field, message: err.message }
    }
    out(`Failed to update scheduled task: ${err?.message || err}`)
    return { updated: false, error: 'store-error', message: err?.message || String(err) }
  }
  if (!task) {
    out(`No scheduled task with id ${existing.id} (it may have just been deleted).`)
    return { updated: false, error: 'not-found' }
  }

  const warnings = computeWarnings(task, deps)
  if (options.json) {
    out(JSON.stringify({ task, warnings }, null, 2))
  } else {
    out(`Updated scheduled task ${task.id}${task.name ? ` (${task.name})` : ''}`)
    out(`  cadence:  ${describeCadence(task.cadence)}`)
    out(`  next run: ${task.enabled ? formatEpoch(task.nextRun) : '— (paused)'}`)
    for (const w of warnings) out(`  WARNING: ${w}`)
  }
  return { updated: true, task, warnings }
}

/**
 * @private — shared body for pause/resume: both are a plain `enabled` flip.
 * Neither requires `--yes` (unlike `delete`): pausing is fully reversible via
 * its counterpart, so the confirmation gate the repo reserves for genuinely
 * destructive/irreversible actions (delete, `tokens revoke --all`, `identity
 * rotate`) does not apply here.
 */
function setEnabled(idOrPrefix, enabled, options, depsOverride, verb) {
  const deps = buildDeps(depsOverride)
  const out = deps.write
  const resolved = resolveTaskId(deps.store, idOrPrefix)
  if (resolved.error) {
    out(resolved.error)
    return { changed: false, error: resolved.errorCode || 'not-found', message: resolved.error }
  }

  let task
  try {
    task = deps.store.update(resolved.task.id, { enabled })
  } catch (err) {
    out(`Failed to ${verb} scheduled task: ${err?.message || err}`)
    return { changed: false, error: 'store-error', message: err?.message || String(err) }
  }
  if (!task) {
    out(`No scheduled task with id ${resolved.task.id}.`)
    return { changed: false, error: 'not-found' }
  }

  if (options.json) {
    out(JSON.stringify({ task }, null, 2))
  } else {
    out(`Task ${task.id}${task.name ? ` (${task.name})` : ''} ${verb === 'pause' ? 'paused' : 'resumed'}.`)
    if (enabled) {
      out(`  next run: ${formatEpoch(task.nextRun)}`)
      for (const w of computeWarnings(task, deps)) out(`  WARNING: ${w}`)
    } else {
      out(`  will not fire again until resumed: chroxy schedule resume ${task.id}`)
    }
  }
  return { changed: true, task }
}

/** `chroxy schedule pause <id>` */
export function runSchedulePause(idOrPrefix, options = {}, depsOverride = {}) {
  return setEnabled(idOrPrefix, false, options, depsOverride, 'pause')
}

/** `chroxy schedule resume <id>` */
export function runScheduleResume(idOrPrefix, options = {}, depsOverride = {}) {
  return setEnabled(idOrPrefix, true, options, depsOverride, 'resume')
}

/**
 * `chroxy schedule delete <id>` — destructive and irreversible (removes the
 * task definition AND its run history), so it follows the repo's `--yes`
 * confirmation convention (`tokens revoke --all`, `identity rotate`):
 * without `--yes` it only explains what would be removed and changes
 * nothing.
 * @returns {{deleted:boolean, confirmed?:boolean, task?:object, error?:string, message?:string}}
 */
export function runScheduleDelete(idOrPrefix, options = {}, depsOverride = {}) {
  const deps = buildDeps(depsOverride)
  const out = deps.write
  const resolved = resolveTaskId(deps.store, idOrPrefix)
  if (resolved.error) {
    out(resolved.error)
    return { deleted: false, error: resolved.errorCode || 'not-found', message: resolved.error }
  }
  const task = resolved.task

  if (!options.yes) {
    out([
      `chroxy schedule delete ${task.id}${task.name ? ` (${task.name})` : ''} — this permanently removes `
        + 'the task definition and its run history.',
      `  cadence: ${describeCadence(task.cadence)}`,
      `  prompt:  ${task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt}`,
      '',
      'This cannot be undone — re-run with --yes to confirm:',
      `  chroxy schedule delete ${task.id} --yes`,
    ].join('\n'))
    return { deleted: false, confirmed: false, task }
  }

  const removed = deps.store.remove(task.id)
  if (!removed) {
    out(`No scheduled task with id ${task.id} (it may have already been deleted).`)
    return { deleted: false, error: 'not-found' }
  }
  out(`Deleted scheduled task ${task.id}${task.name ? ` (${task.name})` : ''}.`)
  return { deleted: true, confirmed: true, task }
}

/**
 * `chroxy schedule last-run <id>` — the per-task detail view. A task that has
 * never fired says so explicitly (`never run`, tag `[NEVER RUN]`) rather than
 * showing a blank/empty field that could be mistaken for "nothing to report".
 * @returns {{found:boolean, task?:object, health?:string, error?:string, message?:string}}
 */
export function runScheduleLastRun(idOrPrefix, options = {}, depsOverride = {}) {
  const deps = buildDeps(depsOverride)
  const out = deps.write
  const resolved = resolveTaskId(deps.store, idOrPrefix)
  if (resolved.error) {
    out(resolved.error)
    return { found: false, error: resolved.errorCode || 'not-found', message: resolved.error }
  }
  const task = resolved.task
  const health = healthTag(task)

  if (options.json) {
    out(JSON.stringify({ task, health }, null, 2))
    return { found: true, task, health }
  }

  out(`${task.name ? `${task.name} ` : ''}(${task.id})`)
  out(`  state:    ${task.enabled ? 'enabled' : 'paused'}`)
  out(`  cadence:  ${describeCadence(task.cadence)}`)
  out(`  next run: ${task.enabled ? formatEpoch(task.nextRun) : '— (paused)'}`)
  out(`  last run: [${health}] ${describeLastRun(task.lastRun)}`)
  if (!task.lastRun) {
    out(`  This task has never fired.${task.enabled ? '' : ' It is also currently paused.'}`)
  }
  if (!deps.checkSchedulerEnabled()) {
    out('  NOTE: scheduled execution is DISABLED on this daemon — nothing will fire (including this task) until it is enabled.')
  }
  return { found: true, task, health }
}

// -- commander wiring --------------------------------------------------------

export function registerScheduleCommands(program) {
  const schedule = program
    .command('schedule')
    .description('Manage scheduled tasks (create/list/edit/pause/resume/delete/last-run) — #6868')

  schedule
    .command('create')
    .description('Create a scheduled task')
    .requiredOption('-p, --prompt <text>', 'Instructions the scheduled run executes')
    .option('-n, --name <name>', 'Optional human-readable label')
    .option('--at <when>', 'One-time cadence: ISO-8601 timestamp (e.g. 2026-08-01T09:00:00Z — no timezone means LOCAL time; times are displayed in UTC) or epoch-ms (mutually exclusive with --cron)')
    .option('--cron <expression>', '5-field crontab expression, e.g. "0 9 * * *" (mutually exclusive with --at)')
    .option('--provider <name>', 'Target provider (default: the daemon default provider)')
    .option('--model <name>', 'Target model')
    .option('--cwd <path>', 'Target working directory')
    .option('--permission-mode <mode>', 'Target permission mode: approve, acceptEdits, auto, plan (unattended runs are always clamped to approve/plan)')
    .option('--paused', 'Create the task paused (enabled: false) — will not fire until resumed')
    .option('--json', 'Output machine-readable JSON')
    .action((options) => {
      try {
        const res = runScheduleCreate(options)
        if (!res.created) process.exitCode = 1
      } catch (err) {
        console.error(`schedule create failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  schedule
    .command('list')
    .description('List scheduled tasks — enabled/paused state, next run, and last-run outcome')
    .option('--json', 'Output machine-readable JSON')
    .action((options) => {
      try {
        runScheduleList(options)
      } catch (err) {
        console.error(`schedule list failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  schedule
    .command('edit <id>')
    .description('Edit a scheduled task (id or unique id-prefix); pass an empty string to clear an optional field')
    .option('-p, --prompt <text>', 'Replace the prompt')
    .option('-n, --name <name>', 'Replace the label')
    .option('--at <when>', 'Replace the cadence with a one-time run: ISO-8601 timestamp (add a trailing Z for UTC — no timezone means LOCAL time) or epoch-ms (mutually exclusive with --cron)')
    .option('--cron <expression>', 'Replace the cadence with a recurring cron expression (mutually exclusive with --at)')
    .option('--provider <name>', 'Replace the target provider')
    .option('--model <name>', 'Replace the target model')
    .option('--cwd <path>', 'Replace the target working directory')
    .option('--permission-mode <mode>', 'Replace the target permission mode')
    .option('--json', 'Output machine-readable JSON')
    .action((id, options) => {
      try {
        const res = runScheduleEdit(id, options)
        if (!res.updated) process.exitCode = 1
      } catch (err) {
        console.error(`schedule edit failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  schedule
    .command('pause <id>')
    .description('Pause a scheduled task (enabled: false) — reversible via `resume`')
    .option('--json', 'Output machine-readable JSON')
    .action((id, options) => {
      try {
        const res = runSchedulePause(id, options)
        if (!res.changed) process.exitCode = 1
      } catch (err) {
        console.error(`schedule pause failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  schedule
    .command('resume <id>')
    .description('Resume a paused scheduled task (enabled: true)')
    .option('--json', 'Output machine-readable JSON')
    .action((id, options) => {
      try {
        const res = runScheduleResume(id, options)
        if (!res.changed) process.exitCode = 1
      } catch (err) {
        console.error(`schedule resume failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  schedule
    .command('delete <id>')
    .description('Permanently delete a scheduled task (id or unique id-prefix)')
    .option('--yes', 'Confirm the delete (without it, the command only explains what it would remove)')
    .action((id, options) => {
      try {
        const res = runScheduleDelete(id, options)
        if (res.error) process.exitCode = 1
      } catch (err) {
        console.error(`schedule delete failed: ${err.message}`)
        process.exitCode = 1
      }
    })

  schedule
    .command('last-run <id>')
    .description('View the last recorded run outcome for a scheduled task (or "never run")')
    .option('--json', 'Output machine-readable JSON')
    .action((id, options) => {
      try {
        const res = runScheduleLastRun(id, options)
        if (!res.found) process.exitCode = 1
      } catch (err) {
        console.error(`schedule last-run failed: ${err.message}`)
        process.exitCode = 1
      }
    })
}
