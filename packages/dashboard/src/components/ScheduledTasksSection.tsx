/**
 * ScheduledTasksSection (#6871, epic #6784) — the "Scheduled tasks" Control Room
 * tab. GUI counterpart to the `chroxy schedule` CLI (#6868), over the registry
 * (#6862) and the headless engine (#6865).
 *
 * A list (left) + detail (right) CRUD surface: create, edit, pause/resume and
 * delete standing schedules, with each task's next-run time and last-run result,
 * plus the global scheduled-execution enable gate.
 *
 * ── This panel is a SAFETY surface, not a dashboard widget ─────────────────────
 * Every task listed here is a standing arrangement for this machine to run an
 * agent session with NOBODY WATCHING. The whole design follows from that:
 *
 * 1. HONEST STATUS. Health tags come from the shared `deriveScheduledTaskHealth`
 *    helper in @chroxy/protocol — the SAME module the CLI's `healthTag()` uses —
 *    so the two surfaces cannot drift into disagreeing about a task. Exactly one
 *    tag (`OK`) styles as healthy, and it is asserted positively: a task that has
 *    never fired, is paused, was refused, timed out, was skipped, or is
 *    quarantined can never render as healthy, and an unrecognized future status
 *    lands on `ERROR` rather than falling through to something friendlier.
 *    A tag describes the last RUN, though, not whether the task will FIRE — so
 *    a task this panel knows cannot fire (paused, refused, quarantined, or no
 *    armed engine) also loses the green tone and its next-run timestamp (#7026,
 *    `whyTaskWillNotFire`). The tag itself stays CLI-identical.
 * 2. THE GATE IS SHOWN FIRST. Scheduled execution is OFF by default. A list of
 *    tasks presented without that fact is misleading — they are saved, and none
 *    of them will fire — so the banner is the first thing in the section, and it
 *    also surfaces `restartRequired` (the persisted gate and the live engine can
 *    disagree, because the engine is built once at daemon boot).
 * 3. REFUSALS ARE SURFACED AT CREATE TIME. The engine refuses to fire a task
 *    whose provider routes permission prompts through the permission hook — which
 *    INCLUDES the daemon default. The create form warns before saving, using the
 *    server-computed `schedulableProviders` / `defaultProviderRefusal` from the
 *    snapshot; the server's verbatim `providerRefusal` is shown per task
 *    afterwards. Nothing about a refusal is re-derived client-side.
 * 4. NO OPTIMISTIC MUTATIONS. A mutation is shown as applied only once the
 *    server re-emits the registry snapshot echoing the requestId. Failures land
 *    in `scheduledTaskActionResults` and are rendered inline.
 *
 * Mutations are STRICT-PRIMARY gated server-side (handlers/scheduler-handlers.js):
 * a pairing-issued token cannot schedule unattended execution and gets
 * `SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT`, which surfaces here as the inline
 * error on the attempted action.
 */
import { useEffect, useMemo, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type {
  ScheduledTask,
  ScheduledTaskCadence,
  ScheduledTaskInput,
  SchedulerGateState,
} from '@chroxy/protocol'
import { deriveScheduledTaskHealth } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'
import { Modal } from './Modal'

/**
 * The wire schema's per-field caps (`ScheduledTaskInputSchema`,
 * protocol/src/schemas/client.ts), mirrored onto the form inputs as `maxLength`.
 *
 * Without these the form could compose a message the wire rejects: ws-server
 * answers an over-cap message with `{type:'error', code:'INVALID_MESSAGE'}`,
 * which carries NO `requestId`, so the pending entry was never released and the
 * submit button sat on "Saving…" indefinitely. Capping at the input is the fix
 * at source — pasting a >32 kB prompt into a task form is entirely plausible.
 * (The bounded request timeout in the store is the backstop for the rejection
 * frames that carry no requestId for other reasons.)
 */
const WIRE_MAX = {
  name: 256,
  prompt: 32768,
  cron: 256,
  provider: 128,
  model: 256,
  cwd: 4096,
} as const

/**
 * The SINGLE epoch→Date guard for this panel. Returns null unless `ms` is both
 * finite AND inside the ±8.64e15 ms range `Date` can represent.
 *
 * Finiteness alone is not enough, and that gap was a real crash (#6871 review
 * C3): `new Date(1e16)` is an Invalid Date, `.toLocaleString()` on it returns
 * "Invalid Date" but `.toISOString()` THROWS `RangeError`. An out-of-range epoch
 * is reachable without hand-editing the registry — the store's `once` arm
 * checked only `Number.isFinite`, and a µs/ns epoch typo (`1.795e18`) from the
 * CLI is finite. Every date render in this file goes through here so there is
 * one guard rather than a per-call-site variant that can miss the range half.
 */
function epochToDate(ms: number | null | undefined): Date | null {
  if (!Number.isFinite(ms as number)) return null
  const d = new Date(ms as number)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Render an epoch-ms instant, or an em dash. Never throws on a bad value. */
function formatEpoch(ms: number | null | undefined): string {
  const d = epochToDate(ms)
  if (!d) return '—'
  try {
    return d.toLocaleString()
  } catch {
    return '—'
  }
}

/**
 * Seed value for the `datetime-local` input, or '' when the stored epoch is not
 * a renderable instant.
 *
 * This is called from a `useState` initializer, i.e. DURING RENDER, so an
 * unguarded `toISOString()` here does not degrade — it throws past this
 * component to the ROOT error boundary and replaces the entire dashboard (chat,
 * terminal, everything) with the error fallback until a full page reload.
 */
function toDatetimeLocalValue(ms: number | null | undefined): string {
  const d = epochToDate(ms)
  if (!d) return ''
  try {
    return d.toISOString().slice(0, 16)
  } catch {
    return ''
  }
}

/** Human cadence summary. Tolerates a malformed cadence rather than crashing. */
function describeCadence(cadence: ScheduledTaskCadence | null | undefined): string {
  if (!cadence || typeof cadence !== 'object') return 'unknown cadence'
  switch (cadence.kind) {
    case 'once':
      return `once at ${formatEpoch(cadence.at)}`
    case 'interval': {
      const mins = cadence.everyMs / 60000
      return `every ${mins >= 1 ? `${Number.isInteger(mins) ? mins : mins.toFixed(1)}m` : `${cadence.everyMs}ms`}`
    }
    case 'cron':
      return `cron ${cadence.expression}`
    default:
      return 'unknown cadence'
  }
}

/** The last-run one-liner, matching the CLI's `describeLastRun`. */
function describeLastRun(task: ScheduledTask): string {
  const lastRun = task.lastRun
  if (!lastRun) return 'never run'
  let line = `${lastRun.status} @ ${formatEpoch(lastRun.at)}`
  if (lastRun.sessionId) line += ` (session ${lastRun.sessionId})`
  if (lastRun.error) line += ` — ${lastRun.error}`
  return line
}

/**
 * #7026 — WHY this task cannot fire, or null when nothing is stopping it.
 *
 * The shared health derivation answers "how did the last run go?"; this answers
 * "will it fire?", which is a different question with a different input set (the
 * snapshot's gate, not the task record). Keeping them separate is the point: the
 * tag stays CLI-identical while the panel stops presenting a task as live.
 *
 * The gate half keys on `engineArmed`, the RUNTIME truth — NOT the persisted
 * `enabled` flag. That distinction is the same one the banner makes (#6871 C2)
 * and it matters in both directions:
 *
 *   - gate saved OFF but the engine STILL ARMED → the tasks below really are
 *     about to run unattended. Blanking their next-run time would understate
 *     the one state that endangers the operator, so `null` is returned.
 *   - gate saved ON but NO engine armed → nothing fires until a daemon restart,
 *     so a live timestamp would be just as false as with the flag off.
 *
 * A `null` gate is UNKNOWN (not read from the daemon), and this claims nothing
 * there — the same posture as `GateBanner`'s UNKNOWN branch.
 *
 * `quarantined` is the FOURTH blocker and belongs here for the same reason as the
 * other three, even though the chip already handled it. The engine's `_tick()`
 * skips a quarantined task until the daemon restarts, but `_quarantine()`
 * (scheduler.js) writes only `lastRun` — the store then RECOMPUTES `nextRun` from
 * the cadence, so the record still carries a real future instant. Reading the
 * record alone, the task looks scheduled; only the process-scoped quarantine flag
 * on the snapshot says otherwise.
 *
 * Precedence runs most-specific first, and within that, most DURABLE first: a
 * paused/refused task stays paused/refused even once the gate is fixed, and a
 * refusal survives the daemon restart that clears a quarantine. Naming the
 * durable reason is more useful than naming the global one — which the banner
 * states at the top of the section anyway.
 */
type NoFireReason = 'paused' | 'refused' | 'quarantined' | 'engine-not-armed'

function whyTaskWillNotFire(
  task: ScheduledTask,
  gate: SchedulerGateState | null,
): NoFireReason | null {
  if (!task.enabled) return 'paused'
  if (task.providerRefusal) return 'refused'
  if (task.quarantined) return 'quarantined'
  if (gate && !gate.engineArmed) return 'engine-not-armed'
  return null
}

/**
 * The next-run cell. A task that cannot fire gets an em dash plus the reason —
 * the same treatment `paused` already had, extended to the other three ways a
 * listed task silently never runs (#7026).
 */
function describeNextRun(task: ScheduledTask, reason: NoFireReason | null): string {
  switch (reason) {
    case 'paused':
      return '— (paused)'
    case 'refused':
      return '— (will not fire)'
    // The detail pane already explains quarantine at length; the row has no room,
    // and the word alone is the searchable term that leads to that explanation.
    case 'quarantined':
      return '— (quarantined)'
    // Deliberately NOT "scheduler disabled": this also covers the gate being
    // saved ENABLED with no armed engine, where the flag is on and nothing is
    // running. "Not running" is true of both.
    case 'engine-not-armed':
      return '— (scheduler not running)'
    default:
      return formatEpoch(task.nextRun)
  }
}

/**
 * The health chip. `data-accent` is driven by the shared helper's `tone`, so
 * "looks healthy" and "is healthy" are the same decision — a renderer can't
 * accidentally style a REFUSED/PAUSED/NEVER RUN task green.
 *
 * `willNotFire` degrades the tone (never the tag) so a task the panel already
 * knows cannot fire is not simultaneously advertised as green (#7026).
 */
function HealthChip({
  task,
  willNotFire = false,
  place = 'row',
}: {
  task: ScheduledTask
  willNotFire?: boolean
  place?: 'row' | 'detail'
}) {
  const health = deriveScheduledTaskHealth(task, { quarantined: task.quarantined, willNotFire })
  return (
    <span
      className="cr-tag"
      data-accent={health.tone}
      data-testid={place === 'detail' ? 'sched-detail-health' : `sched-health-${task.id}`}
      title={health.quarantined ? 'Quarantined by the engine — it will not fire again until the daemon restarts.' : undefined}
    >
      {health.tag}
      {health.quarantined ? ' · QUARANTINED' : ''}
    </span>
  )
}

/**
 * The enable-gate banner. Always rendered — a closed gate is the single most
 * important fact about this panel, and `restartRequired` is called out because a
 * flipped flag does NOT change what a running daemon is doing.
 */
function GateBanner({
  gate,
  onToggle,
  busy,
  connected,
  error,
}: {
  /** `null` = not read from the daemon yet. See the UNKNOWN branch below. */
  gate: { enabled: boolean; engineArmed: boolean; restartRequired: boolean; source: string } | null
  onToggle: (next: boolean) => void
  busy: boolean
  connected: boolean
  error: string | null
}) {
  // #6871 review round 2 (finding 3) — the FIFTH state: no snapshot, so the gate
  // is genuinely unknown. `enabled × engineArmed` is four states only GIVEN a
  // snapshot; synthesising `{false,false}` here made the banner state a positive
  // fact about the daemon on zero data. Say "unknown" instead and claim nothing
  // about whether tasks are firing — the whole point of this banner is that it is
  // the one thing on the panel an operator is entitled to trust.
  if (!gate) {
    return (
      <div className="cr-sched-gate" data-accent="neutral" data-testid="sched-gate-banner">
        <div className="cr-sched-gate-text">
          <strong data-testid="sched-gate-headline">Scheduled execution: UNKNOWN</strong>
          <p className="cr-dim" data-testid="sched-gate-detail">
            Scheduler state unknown — could not read it from the daemon. Any tasks listed below may
            or may not be firing; this panel will not guess. Refresh to try again.
          </p>
          {error && <p className="cr-error" data-testid="sched-gate-error">{error}</p>}
        </div>
        {/* No toggle: "Enable"/"Disable" both describe a flip FROM a state we have
            not read, so either label would be a guess about the daemon. */}
        <button
          type="button"
          className="cr-primary-btn"
          data-testid="sched-gate-toggle"
          disabled
          title="The scheduler gate has not been read from the daemon yet, so there is nothing to toggle from. Refresh first."
        >
          Unavailable
        </button>
      </div>
    )
  }
  const { enabled, engineArmed, restartRequired, source } = gate
  const envForced = source === 'env'
  // #6871 review (C2): the copy is keyed on BOTH the persisted gate AND the
  // RUNTIME engine state — never on `enabled` alone.
  //
  // Keying on the flag alone made the banner contradict itself in the one
  // direction that actually endangers the operator. With the gate closed on a
  // still-armed engine it read "Tasks below are saved but will NOT fire" in the
  // bold, skimmable first paragraph, directly above the line correctly saying
  // the engine WILL keep firing them — and it offered "enable features.scheduler"
  // as the remediation for a scheduler that is *already running*. Four signals
  // said off, one said on, and the false half was the one an operator skims.
  //
  // So each of the four (enabled × engineArmed) states is stated exactly once,
  // and the remediation always names the action that changes the RUNTIME:
  // restarting the daemon, not flipping the flag that is already flipped.
  const stillFiring = !enabled && engineArmed // the dangerous one
  const notYetFiring = enabled && !engineArmed
  const headline = stillFiring
    ? 'Scheduled execution: DISABLED (saved) — ENGINE STILL FIRING'
    : notYetFiring
      ? 'Scheduled execution: ENABLED (saved) — ENGINE NOT ARMED'
      : enabled
        ? 'Scheduled execution: ENABLED'
        : 'Scheduled execution: DISABLED'
  // NOTE: the `stillFiring` copy must never contain the phrase "will NOT fire" —
  // there is a regression test asserting exactly that, because that phrase is
  // what made the old banner lie.
  const detail = stillFiring
    ? 'The saved setting is DISABLED, but it does not take effect until the daemon restarts — the tasks below are STILL FIRING right now, in headless sessions with nobody watching. Restart the daemon to actually stop them.'
    : notYetFiring
      ? 'Saved as ENABLED, but the running daemon has no armed engine, so nothing is firing yet. Restart the daemon to start firing. Once armed, due tasks run in a headless session pinned to the safest permission mode and cannot auto-approve.'
      : enabled
        ? 'Due tasks fire automatically in a headless session with no client connected. Runs are pinned to the safest permission mode and cannot auto-approve; a prompt with nobody to answer it is denied and the run recorded as a failure.'
        : 'Tasks below are saved but will NOT fire. Enable via features.scheduler in config.json (or CHROXY_ENABLE_SCHEDULER=1), then restart the daemon.'
  return (
    <div
      className="cr-sched-gate"
      data-accent={enabled ? (restartRequired ? 'warn' : 'ok') : 'bad'}
      data-testid="sched-gate-banner"
    >
      <div className="cr-sched-gate-text">
        <strong data-testid="sched-gate-headline">{headline}</strong>
        <p className="cr-dim" data-testid="sched-gate-detail">{detail}</p>
        {restartRequired && (
          <p className="cr-error" data-testid="sched-gate-restart">
            Restart required — the saved setting and the running daemon disagree
            {engineArmed
              ? ': the engine is still armed and WILL keep firing tasks until the daemon restarts.'
              : ': no engine is armed, so nothing will fire until the daemon restarts.'}
          </p>
        )}
        {envForced && (
          <p className="cr-dim" data-testid="sched-gate-env">
            Forced by the CHROXY_ENABLE_SCHEDULER environment variable, which overrides config.json.
          </p>
        )}
        {error && <p className="cr-error" data-testid="sched-gate-error">{error}</p>}
      </div>
      <button
        type="button"
        className={enabled ? 'cr-danger-btn' : 'cr-primary-btn'}
        data-testid="sched-gate-toggle"
        disabled={busy || !connected || (envForced && enabled)}
        title={
          envForced && enabled
            ? 'Unset CHROXY_ENABLE_SCHEDULER in the daemon environment to disable.'
            : stillFiring
              ? 'Writes features.scheduler to config.json. The running engine is already armed, so this does not stop it — only a daemon restart does.'
              : 'Writes features.scheduler to config.json. A daemon restart is required for it to take effect.'
        }
        onClick={() => onToggle(!enabled)}
      >
        {/* #6871 review (C2): "Enable" in the `stillFiring` state implied the
            scheduler was currently stopped — the fourth contradicting signal.
            The gate is already saved as disabled there, so the action this
            button actually performs is undoing that save. */}
        {busy ? 'Saving…' : enabled ? 'Disable' : stillFiring ? 'Re-enable' : 'Enable'}
      </button>
    </div>
  )
}

/** One row in the task list. */
function TaskRow({
  task,
  gate,
  selected,
  onSelect,
}: {
  task: ScheduledTask
  /** `null` = the gate is UNKNOWN; see `whyTaskWillNotFire`. */
  gate: SchedulerGateState | null
  selected: boolean
  onSelect: (id: string) => void
}) {
  const noFire = whyTaskWillNotFire(task, gate)
  return (
    <li>
      <button
        type="button"
        className="cr-sched-row"
        data-selected={selected ? 'true' : undefined}
        data-testid={`sched-row-${task.id}`}
        onClick={() => onSelect(task.id)}
      >
        <span className="cr-sched-row-name" data-testid={`sched-row-name-${task.id}`}>
          {task.name || task.id.slice(0, 8)}
        </span>
        <HealthChip task={task} willNotFire={noFire !== null} />
        <span className="cr-dim cr-sched-row-cadence">{describeCadence(task.cadence)}</span>
        <span className="cr-dim cr-sched-row-next" data-testid={`sched-row-next-${task.id}`}>
          next: {describeNextRun(task, noFire)}
        </span>
        {task.providerRefusal && (
          <span className="cr-tag" data-accent="bad" data-testid={`sched-row-refusal-${task.id}`}>
            will not fire
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * Detail + controls for the selected task. Renders the engine's own verdicts
 * verbatim (`providerRefusal`, the clamped permission mode, quarantine) rather
 * than any locally-derived judgement.
 */
function TaskDetail({ task, gate }: { task: ScheduledTask; gate: SchedulerGateState | null }) {
  const sendAction = useConnectionStore((s) => s.sendScheduledTaskAction)
  const pending = useConnectionStore((s) => s.scheduledTaskPendingActions)
  const results = useConnectionStore((s) => s.scheduledTaskActionResults)
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const [reqId, setReqId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined
  const noFire = whyTaskWillNotFire(task, gate)
  const health = deriveScheduledTaskHealth(task, {
    quarantined: task.quarantined,
    willNotFire: noFire !== null,
  })

  const act = (action: 'pause' | 'resume' | 'delete') => {
    const id = sendAction(action, { taskId: task.id })
    if (id) setReqId(id)
  }

  return (
    <div className="cr-sched-detail" data-testid="sched-detail">
      <header className="cr-sched-detail-header">
        <div>
          <h4 data-testid="sched-detail-name">{task.name || task.id}</h4>
          <span className="cr-mono cr-dim">{task.id}</span>
        </div>
        <HealthChip task={task} willNotFire={noFire !== null} place="detail" />
      </header>

      {task.quarantined && (
        <p className="cr-error" data-testid="sched-detail-quarantined">
          The engine has QUARANTINED this task — it will not fire again until the daemon
          restarts (its run outcome could not be recorded).
          {task.lastRun?.error ? ` Reason: ${task.lastRun.error}` : ''}
        </p>
      )}

      {task.providerRefusal && (
        <p className="cr-error" data-testid="sched-detail-refusal">
          This task will never fire: {task.providerRefusal}
        </p>
      )}

      <dl className="cr-sched-facts">
        <dt>State</dt>
        <dd data-testid="sched-detail-state">{task.enabled ? 'enabled' : 'paused'}</dd>
        <dt>Cadence</dt>
        <dd data-testid="sched-detail-cadence">{describeCadence(task.cadence)}</dd>
        <dt>Next run</dt>
        <dd data-testid="sched-detail-next">{describeNextRun(task, noFire)}</dd>
        <dt>Last run</dt>
        <dd data-testid="sched-detail-last">
          [{health.tag}] {describeLastRun(task)}
        </dd>
        <dt>Provider</dt>
        <dd data-testid="sched-detail-provider">
          {task.effectiveProvider || '—'}
          {!task.target?.provider && task.effectiveProvider ? ' (daemon default)' : ''}
        </dd>
        <dt>Permission mode</dt>
        <dd data-testid="sched-detail-permission">
          {task.effectivePermissionMode}
          {task.permissionModeClamped
            ? ` — clamped down from "${task.target?.permissionMode}"; an unattended run may never use an auto-approving mode`
            : ''}
        </dd>
        {task.target?.cwd && (
          <>
            <dt>Working dir</dt>
            <dd className="cr-mono" data-testid="sched-detail-cwd">{task.target.cwd}</dd>
          </>
        )}
        {task.target?.model && (
          <>
            <dt>Model</dt>
            <dd data-testid="sched-detail-model">{task.target.model}</dd>
          </>
        )}
      </dl>

      <div className="cr-sched-prompt">
        <div className="cr-eyebrow">Prompt</div>
        <pre data-testid="sched-detail-prompt">{task.prompt}</pre>
      </div>

      {result && !result.ok && (
        <p className="cr-error" data-testid="sched-detail-action-error">{result.error}</p>
      )}

      <div className="cr-sched-detail-actions">
        <button
          type="button"
          data-testid="sched-edit"
          disabled={inFlight || !connected}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          data-testid="sched-toggle-enabled"
          disabled={inFlight || !connected}
          onClick={() => act(task.enabled ? 'pause' : 'resume')}
        >
          {inFlight ? 'Working…' : task.enabled ? 'Pause' : 'Resume'}
        </button>
        <button
          type="button"
          className="cr-danger-btn"
          data-testid="sched-delete"
          disabled={inFlight || !connected}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>

      {editing && <TaskFormModal task={task} onClose={() => setEditing(false)} />}

      {confirmDelete && (
        <Modal open onClose={() => setConfirmDelete(false)} title="Delete scheduled task" closeOnBackdrop={false}>
          <div className="cr-sched-modal" data-testid="sched-delete-modal">
            <p>
              Permanently delete <strong>{task.name || task.id}</strong>? This removes the standing
              schedule; sessions it already created are unaffected.
            </p>
            <div className="cr-sched-modal-actions">
              <button type="button" data-testid="sched-delete-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button
                type="button"
                className="cr-danger-btn"
                data-testid="sched-delete-confirm"
                onClick={() => {
                  act('delete')
                  setConfirmDelete(false)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** The `target` sub-fields this form has an input for. Everything else in a
 *  stored target is carried through untouched — see `unownedTarget` below. */
const OWNED_TARGET_KEYS = ['provider', 'model', 'cwd'] as const

type FormTarget = NonNullable<ScheduledTaskInput['target']>

/**
 * Create/edit form. Warns BEFORE saving when the chosen provider is one the
 * engine refuses — including the blank case, which resolves to the daemon
 * default. The refusal text comes from the server (`defaultProviderRefusal`) and
 * the supported set is the server's `schedulableProviders`; neither is computed
 * here.
 *
 * ── An EDIT sends a PATCH, never a round-trip of the snapshot (#7049) ─────────
 * `create` composes the whole task; `update` sends ONLY the fields the operator
 * actually changed. Echoing back everything the form was seeded with destroyed
 * data twice over, and both losses were silent:
 *
 *  1. The store REPLACES `target` wholesale (`scheduled-task-store.js`:
 *     `if ('target' in patch) next.target = normalizeTarget(patch.target)`), and
 *     this form has no `permissionMode` input — so a full `target` bag deleted a
 *     stored `permissionMode` on ANY unrelated save. (The fix is to preserve it,
 *     NOT to add an input: whether that mode gets a control is #6761's call.)
 *  2. Every text field is seeded from the CLAMPED wire projection
 *     (`clampWire`, handlers/scheduler-handlers.js), so re-sending an untouched
 *     `name` / `provider` / `model` / `cwd` persisted the shortened value. The
 *     wire caps are the SAME numbers as the inputs' `maxLength`, so no surface
 *     can send an over-cap value back — the only way to keep one is not to send
 *     the field at all.
 *
 * "Changed" is measured against the SEED values below, not by re-deriving a
 * payload and diffing it against the task. The difference is load-bearing for
 * `once`: its instant round-trips through a `datetime-local` string, so a
 * re-derived `at` can differ from the stored one with the operator having
 * touched nothing.
 */
function TaskFormModal({ task, onClose }: { task?: ScheduledTask; onClose: () => void }) {
  const sendAction = useConnectionStore((s) => s.sendScheduledTaskAction)
  const pending = useConnectionStore((s) => s.scheduledTaskPendingActions)
  const results = useConnectionStore((s) => s.scheduledTaskActionResults)
  const snapshot = useConnectionStore((s) => s.scheduledTasks)
  const [reqId, setReqId] = useState<string | null>(null)
  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined

  // #6871 review (C3): guarded via the shared epoch guard. An out-of-Date-range
  // `at` used to throw RangeError out of this initializer and take the whole
  // dashboard down through the root error boundary.
  const storedOnceAt = task?.cadence?.kind === 'once' ? task.cadence.at : null
  // The SEED values: what each input started as, captured ONCE for the life of
  // the modal (#7049 — see the block comment above), so "did the operator change
  // this?" is a comparison against the value the field was actually populated
  // with.
  //
  // The lazy `useState` is load-bearing, not a micro-optimisation. `task` is
  // `tasks.find(...)` off the store snapshot, and the daemon re-emits the WHOLE
  // snapshot after every accepted mutation from ANY client — so this component
  // re-renders mid-edit with a fresh `task` object. A plain `const` would then
  // re-derive the seed from the NEW server values, every field the operator never
  // touched would differ from its seed, and the patch would grow back into the
  // whole-bag write-back (carrying the operator's now-stale values) that this
  // block exists to prevent.
  const [seed] = useState(() => ({
    name: task?.name ?? '',
    prompt: task?.prompt ?? '',
    cadenceKind: (task?.cadence?.kind ?? 'cron') as 'once' | 'interval' | 'cron',
    cron: task?.cadence?.kind === 'cron' ? task.cadence.expression : '0 9 * * *',
    everyMinutes: task?.cadence?.kind === 'interval' ? String(Math.round(task.cadence.everyMs / 60000)) : '60',
    onceAt: toDatetimeLocalValue(storedOnceAt),
    provider: task?.target?.provider ?? '',
    model: task?.target?.model ?? '',
    cwd: task?.target?.cwd ?? '',
  }))
  const [name, setName] = useState(seed.name)
  const [prompt, setPrompt] = useState(seed.prompt)
  const [cadenceKind, setCadenceKind] = useState<'once' | 'interval' | 'cron'>(seed.cadenceKind)
  const [cron, setCron] = useState(seed.cron)
  const [everyMinutes, setEveryMinutes] = useState(seed.everyMinutes)
  const [onceAt, setOnceAt] = useState(seed.onceAt)
  // The stored instant exists but cannot be represented — show the operator that
  // the value was dropped and must be re-entered, rather than silently
  // presenting an empty field as if the task had no scheduled time.
  const onceAtUnreadable =
    task?.cadence?.kind === 'once' && storedOnceAt != null && epochToDate(storedOnceAt) === null
  const [provider, setProvider] = useState(seed.provider)
  const [model, setModel] = useState(seed.model)
  const [cwd, setCwd] = useState(seed.cwd)

  // Close only once the SERVER confirmed the mutation (the re-emitted snapshot).
  useEffect(() => {
    if (result?.ok) onClose()
  }, [result, onClose])

  const schedulable = snapshot?.schedulableProviders ?? []
  // The create-time refusal warning. A blank provider means the daemon default,
  // whose refusal reason the server already computed for us.
  const providerWarning = useMemo(() => {
    if (!snapshot) return null
    if (!provider.trim()) return snapshot.defaultProviderRefusal
    if (schedulable.length > 0 && !schedulable.includes(provider.trim())) {
      return `The scheduler refuses provider '${provider.trim()}': it is not one of the providers that answer permission prompts in-process, so an unattended run would stall and then report a turn whose tool calls were all silently refused. Supported: ${schedulable.join(', ')}.`
    }
    return null
  }, [snapshot, provider, schedulable])

  const buildCadence = (): ScheduledTaskCadence | null => {
    if (cadenceKind === 'cron') {
      return cron.trim() ? { kind: 'cron', expression: cron.trim() } : null
    }
    if (cadenceKind === 'interval') {
      const mins = Number(everyMinutes)
      if (!Number.isFinite(mins) || mins <= 0) return null
      // #7049: `anchor` is a stored phase offset this form has no input for.
      // Rebuilding the cadence without it would delete it — the same "clobber
      // what the form does not own" shape as the target bag below.
      const anchor = task?.cadence?.kind === 'interval' ? task.cadence.anchor : undefined
      return {
        kind: 'interval',
        everyMs: Math.round(mins * 60000),
        ...(anchor != null ? { anchor } : {}),
      }
    }
    const at = Date.parse(onceAt)
    if (!Number.isFinite(at)) return null
    return { kind: 'once', at }
  }

  const cadence = buildCadence()
  const canSubmit = !inFlight && prompt.trim().length > 0 && cadence !== null

  /**
   * Everything in the stored `target` this form has no input for — today just
   * `permissionMode`. Computed by EXCLUSION rather than by naming the fields to
   * keep, so a target field added later is preserved by default instead of
   * being silently dropped the next time someone saves the form. (It must also
   * be added to `ScheduledTaskInputSchema.target`, or Zod strips it off the wire
   * on the way back — the read and write shapes are separate objects.)
   *
   * Deliberately read LIVE off `task`, the opposite choice from `seed` above, and
   * for the same underlying reason. `seed` answers "what did the operator start
   * from?", which must not move. This answers "what does the server hold for the
   * fields nobody here owns?", and the freshest answer is the correct one: if
   * another client set a `permissionMode` while this modal was open, carrying
   * that through is right and re-writing a stale one is not. Same for the
   * interval `anchor` in `buildCadence`.
   */
  const unownedTarget = Object.fromEntries(
    Object.entries(task?.target ?? {}).filter(
      ([k]) => !(OWNED_TARGET_KEYS as readonly string[]).includes(k),
    ),
  ) as FormTarget

  const submit = () => {
    if (!cadence) return
    const nextName = name.trim() || null
    const nextPrompt = prompt.trim()
    const nextTarget: FormTarget = {
      ...unownedTarget,
      ...(provider.trim() ? { provider: provider.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
    }

    if (!task) {
      const id = sendAction('create', {
        task: { name: nextName, prompt: nextPrompt, cadence, target: nextTarget },
      })
      if (id) setReqId(id)
      return
    }

    // PATCH: only the fields whose input differs from what it was seeded with.
    // An untouched field is left out entirely, which is the ONLY way to keep a
    // value the wire cap cannot carry — and, for `target`, the only way to keep
    // the sub-fields this form does not own.
    const patch: ScheduledTaskInput = {}
    if (name !== seed.name) patch.name = nextName
    if (prompt !== seed.prompt) patch.prompt = nextPrompt
    if (
      cadenceKind !== seed.cadenceKind
      || (cadenceKind === 'cron' && cron !== seed.cron)
      || (cadenceKind === 'interval' && everyMinutes !== seed.everyMinutes)
      || (cadenceKind === 'once' && onceAt !== seed.onceAt)
    ) patch.cadence = cadence
    if (provider !== seed.provider || model !== seed.model || cwd !== seed.cwd) {
      patch.target = nextTarget
    }
    // An empty patch is still SENT: the mutation is not optimistic, so the
    // server's echoed snapshot is what closes this modal. Not sending would
    // leave a no-op "Save changes" click with no way out but Cancel.
    const id = sendAction('update', { taskId: task.id, task: patch })
    if (id) setReqId(id)
  }

  return (
    <Modal open onClose={onClose} title={task ? 'Edit scheduled task' : 'New scheduled task'} closeOnBackdrop={false}>
      <div className="cr-sched-modal" data-testid="sched-form-modal">
        <label className="cr-sched-field">
          <span>Name (optional)</span>
          <input data-testid="sched-form-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={WIRE_MAX.name} disabled={inFlight} />
        </label>
        <label className="cr-sched-field">
          <span>Prompt</span>
          <textarea
            data-testid="sched-form-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the scheduled run do?"
            maxLength={WIRE_MAX.prompt}
            disabled={inFlight}
          />
        </label>
        <label className="cr-sched-field">
          <span>Cadence</span>
          <select
            data-testid="sched-form-cadence-kind"
            value={cadenceKind}
            onChange={(e) => setCadenceKind(e.target.value as 'once' | 'interval' | 'cron')}
            disabled={inFlight}
          >
            <option value="cron">cron</option>
            <option value="interval">every N minutes</option>
            <option value="once">once</option>
          </select>
        </label>
        {cadenceKind === 'cron' && (
          <label className="cr-sched-field">
            <span>Cron expression</span>
            <input data-testid="sched-form-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" maxLength={WIRE_MAX.cron} disabled={inFlight} />
          </label>
        )}
        {cadenceKind === 'interval' && (
          <label className="cr-sched-field">
            <span>Every (minutes)</span>
            <input data-testid="sched-form-interval" type="number" min="1" value={everyMinutes} onChange={(e) => setEveryMinutes(e.target.value)} disabled={inFlight} />
          </label>
        )}
        {cadenceKind === 'once' && (
          <label className="cr-sched-field">
            <span>Run at</span>
            <input data-testid="sched-form-once" type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} disabled={inFlight} />
            {onceAtUnreadable && (
              <span className="cr-error" data-testid="sched-form-once-invalid">
                The stored run-at value is not a valid date and could not be loaded — pick a new
                time before saving.
              </span>
            )}
          </label>
        )}
        <label className="cr-sched-field">
          <span>Provider (blank = daemon default)</span>
          <input
            data-testid="sched-form-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder={schedulable.length > 0 ? schedulable[0] : ''}
            list="sched-provider-options"
            maxLength={WIRE_MAX.provider}
            disabled={inFlight}
          />
          <datalist id="sched-provider-options">
            {schedulable.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className="cr-sched-field">
          <span>Model (optional)</span>
          <input data-testid="sched-form-model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={WIRE_MAX.model} disabled={inFlight} />
        </label>
        <label className="cr-sched-field">
          <span>Working directory (optional)</span>
          <input data-testid="sched-form-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" maxLength={WIRE_MAX.cwd} disabled={inFlight} />
        </label>

        {providerWarning && (
          <p className="cr-error" data-testid="sched-form-provider-warning">
            {providerWarning}
          </p>
        )}
        <p className="cr-dim" data-testid="sched-form-permission-note">
          An unattended run is pinned to the safest permission mode and can never auto-approve. A
          prompt no rule settles is denied and the run recorded as a failure, so a task that needs
          to act requires an explicit permission rule.
        </p>

        {result && !result.ok && <p className="cr-error" data-testid="sched-form-error">{result.error}</p>}
        <div className="cr-sched-modal-actions">
          {/* Cancel is NEVER disabled. It used to carry `disabled={inFlight}`,
              so any rejection frame that arrives without a `requestId` (an
              INVALID_MESSAGE over-cap reject, a rate_limit, a drain-drop) left
              the pending entry unreleased AND the only way out of the modal
              disabled — Esc was the sole escape. Abandoning a form is always a
              safe local action: it sends nothing and the mutation is not
              optimistic, so a still-in-flight request simply resolves into a
              closed modal. */}
          <button type="button" data-testid="sched-form-cancel" onClick={onClose}>Cancel</button>
          <button type="button" data-testid="sched-form-submit" onClick={submit} disabled={!canSubmit}>
            {inFlight ? 'Saving…' : task ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export interface ScheduledTasksSectionProps {
  /** Injectable clock for the "generated Nm ago" line. */
  now?: () => number
}

export function ScheduledTasksSection({ now = Date.now }: ScheduledTasksSectionProps = {}) {
  const snapshot = useConnectionStore((s) => s.scheduledTasks)
  const loading = useConnectionStore((s) => s.scheduledTasksLoading)
  const readError = useConnectionStore((s) => s.scheduledTasksError)
  const requestTasks = useConnectionStore((s) => s.requestScheduledTasks)
  const selectedId = useConnectionStore((s) => s.selectedScheduledTaskId)
  const selectTask = useConnectionStore((s) => s.selectScheduledTask)
  const setGate = useConnectionStore((s) => s.setSchedulerEnabled)
  const pending = useConnectionStore((s) => s.scheduledTaskPendingActions)
  const results = useConnectionStore((s) => s.scheduledTaskActionResults)
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const [showNew, setShowNew] = useState(false)
  const [gateReqId, setGateReqId] = useState<string | null>(null)

  const gateBusy = gateReqId != null && gateReqId in pending
  const gateResult = gateReqId != null ? results[gateReqId] : undefined

  // Defensive: a malformed snapshot must not make `.map` throw and blank the panel.
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  const selected = tasks.find((t) => t.id === selectedId) ?? null

  // Drop a selection whose task no longer exists (deleted elsewhere), so the
  // detail pane can't keep showing a task that is gone.
  useEffect(() => {
    if (selectedId && !tasks.some((t) => t.id === selectedId)) selectTask(null)
  }, [selectedId, tasks, selectTask])

  // #6871 review round 2 (finding 3): the gate is `null` — a distinct UNKNOWN
  // state — whenever we have not actually read it from the daemon.
  //
  // This used to synthesise `{enabled: false, engineArmed: false}`, which made the
  // banner assert "Scheduled execution: DISABLED — Tasks below are saved but will
  // NOT fire. Enable via features.scheduler…" on ZERO data. That is the exact copy
  // the C2 fix removed for being false in the dangerous direction, reintroduced
  // through the fallback: the scheduler may be armed and firing headless sessions
  // right now, and the panel would flatly deny it.
  //
  // "Absence reads as OFF, the safe direction" is only true of `enabled`. It is
  // NOT true of "nothing is firing", which is the half that endangers the
  // operator, and `engineArmed` is exactly what we cannot infer without a
  // snapshot. `snapshot === null` is reachable throughout the first-load round
  // trip, after a watchdog timeout or disconnect, when the first snapshot fails
  // safeParse, and PERMANENTLY for a pairing-bound client refused with
  // SCHEDULER_FORBIDDEN_BOUND_CLIENT.
  const gate = snapshot?.scheduler ?? null

  return (
    <section className="cr-section" data-testid="sched-section">
      <header className="cr-section-header">
        <div>
          <div className="cr-eyebrow">Scheduler</div>
          <h3>Scheduled tasks</h3>
          {snapshot && (
            <span className="cr-dim" data-testid="sched-generated-ago">
              {formatGeneratedAgo(Date.parse(snapshot.generatedAt), now())}
            </span>
          )}
        </div>
        <div className="cr-sched-header-actions">
          <button
            type="button"
            className="cr-primary-btn"
            data-testid="sched-new"
            disabled={!connected}
            onClick={() => setShowNew(true)}
          >
            New task
          </button>
          <button
            type="button"
            className="cr-refresh-btn"
            data-testid="sched-refresh"
            disabled={!connected || loading}
            onClick={() => requestTasks()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <GateBanner
        gate={gate}
        busy={gateBusy}
        connected={connected}
        error={gateResult && !gateResult.ok ? gateResult.error : null}
        onToggle={(next) => {
          const id = setGate(next)
          if (id) setGateReqId(id)
        }}
      />

      {showNew && <TaskFormModal onClose={() => setShowNew(false)} />}

      {snapshot?.error && (
        <p className="cr-error" data-testid="sched-error">
          {snapshot.error.code}: {snapshot.error.message}
        </p>
      )}

      {/* #6871 review (S1): a read that failed WITHOUT producing a snapshot — a
          refusal, an unparseable snapshot, a timeout, a disconnect. Without this
          the spinner either hung forever or (once cleared) stopped silently,
          leaving the operator with no idea the list was stale. */}
      {readError && (
        <p className="cr-error" data-testid="sched-read-error">{readError}</p>
      )}

      {tasks.length === 0 && !snapshot?.error ? (
        <p className="cr-dim" data-testid="sched-empty">
          {snapshot
            ? 'No scheduled tasks yet.'
            : loading
              ? 'Loading…'
              : 'Not loaded yet.'}
        </p>
      ) : (
        <div className="cr-sched-layout">
          <ul className="cr-sched-list" data-testid="sched-list">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} gate={gate} selected={t.id === selectedId} onSelect={(id) => selectTask(id)} />
            ))}
          </ul>
          {selected ? (
            <TaskDetail key={selected.id} task={selected} gate={gate} />
          ) : (
            <p className="cr-dim" data-testid="sched-detail-empty">Select a task to inspect it.</p>
          )}
        </div>
      )}
    </section>
  )
}
