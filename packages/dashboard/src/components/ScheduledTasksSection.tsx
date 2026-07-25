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
import type { ScheduledTask, ScheduledTaskCadence, ScheduledTaskInput } from '@chroxy/protocol'
import { deriveScheduledTaskHealth } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'
import { Modal } from './Modal'

/** Render an epoch-ms instant, or an em dash. Never throws on a bad value. */
function formatEpoch(ms: number | null | undefined): string {
  if (!Number.isFinite(ms as number)) return '—'
  try {
    return new Date(ms as number).toLocaleString()
  } catch {
    return '—'
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
 * The health chip. `data-accent` is driven by the shared helper's `tone`, so
 * "looks healthy" and "is healthy" are the same decision — a renderer can't
 * accidentally style a REFUSED/PAUSED/NEVER RUN task green.
 */
function HealthChip({ task, place = 'row' }: { task: ScheduledTask; place?: 'row' | 'detail' }) {
  const health = deriveScheduledTaskHealth(task, { quarantined: task.quarantined })
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
  enabled,
  engineArmed,
  restartRequired,
  source,
  onToggle,
  busy,
  connected,
  error,
}: {
  enabled: boolean
  engineArmed: boolean
  restartRequired: boolean
  source: string
  onToggle: (next: boolean) => void
  busy: boolean
  connected: boolean
  error: string | null
}) {
  const envForced = source === 'env'
  return (
    <div
      className="cr-sched-gate"
      data-accent={enabled ? (restartRequired ? 'warn' : 'ok') : 'bad'}
      data-testid="sched-gate-banner"
    >
      <div className="cr-sched-gate-text">
        <strong data-testid="sched-gate-headline">
          {enabled ? 'Scheduled execution: ENABLED' : 'Scheduled execution: DISABLED'}
        </strong>
        <p className="cr-dim" data-testid="sched-gate-detail">
          {enabled
            ? 'Due tasks fire automatically in a headless session with no client connected. Runs are pinned to the safest permission mode and cannot auto-approve; a prompt with nobody to answer it is denied and the run recorded as a failure.'
            : 'Tasks below are saved but will NOT fire. Enable via features.scheduler in config.json (or CHROXY_ENABLE_SCHEDULER=1), then restart the daemon.'}
        </p>
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
            : 'Writes features.scheduler to config.json. A daemon restart is required for it to take effect.'
        }
        onClick={() => onToggle(!enabled)}
      >
        {busy ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  )
}

/** One row in the task list. */
function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: ScheduledTask
  selected: boolean
  onSelect: (id: string) => void
}) {
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
        <HealthChip task={task} />
        <span className="cr-dim cr-sched-row-cadence">{describeCadence(task.cadence)}</span>
        <span className="cr-dim cr-sched-row-next" data-testid={`sched-row-next-${task.id}`}>
          next: {task.enabled ? formatEpoch(task.nextRun) : '— (paused)'}
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
function TaskDetail({ task }: { task: ScheduledTask }) {
  const sendAction = useConnectionStore((s) => s.sendScheduledTaskAction)
  const pending = useConnectionStore((s) => s.scheduledTaskPendingActions)
  const results = useConnectionStore((s) => s.scheduledTaskActionResults)
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const [reqId, setReqId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined
  const health = deriveScheduledTaskHealth(task, { quarantined: task.quarantined })

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
        <HealthChip task={task} place="detail" />
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
        <dd data-testid="sched-detail-next">{task.enabled ? formatEpoch(task.nextRun) : '— (paused)'}</dd>
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

/**
 * Create/edit form. Warns BEFORE saving when the chosen provider is one the
 * engine refuses — including the blank case, which resolves to the daemon
 * default. The refusal text comes from the server (`defaultProviderRefusal`) and
 * the supported set is the server's `schedulableProviders`; neither is computed
 * here.
 */
function TaskFormModal({ task, onClose }: { task?: ScheduledTask; onClose: () => void }) {
  const sendAction = useConnectionStore((s) => s.sendScheduledTaskAction)
  const pending = useConnectionStore((s) => s.scheduledTaskPendingActions)
  const results = useConnectionStore((s) => s.scheduledTaskActionResults)
  const snapshot = useConnectionStore((s) => s.scheduledTasks)
  const [reqId, setReqId] = useState<string | null>(null)
  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined

  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [cadenceKind, setCadenceKind] = useState<'once' | 'interval' | 'cron'>(task?.cadence?.kind ?? 'cron')
  const [cron, setCron] = useState(task?.cadence?.kind === 'cron' ? task.cadence.expression : '0 9 * * *')
  const [everyMinutes, setEveryMinutes] = useState(
    task?.cadence?.kind === 'interval' ? String(Math.round(task.cadence.everyMs / 60000)) : '60',
  )
  const [onceAt, setOnceAt] = useState(
    task?.cadence?.kind === 'once' ? new Date(task.cadence.at).toISOString().slice(0, 16) : '',
  )
  const [provider, setProvider] = useState(task?.target?.provider ?? '')
  const [model, setModel] = useState(task?.target?.model ?? '')
  const [cwd, setCwd] = useState(task?.target?.cwd ?? '')

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
      return { kind: 'interval', everyMs: Math.round(mins * 60000) }
    }
    const at = Date.parse(onceAt)
    if (!Number.isFinite(at)) return null
    return { kind: 'once', at }
  }

  const cadence = buildCadence()
  const canSubmit = !inFlight && prompt.trim().length > 0 && cadence !== null

  const submit = () => {
    if (!cadence) return
    const payload: ScheduledTaskInput = {
      name: name.trim() || null,
      prompt: prompt.trim(),
      cadence,
      target: {
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      },
    }
    const id = task
      ? sendAction('update', { taskId: task.id, task: payload })
      : sendAction('create', { task: payload })
    if (id) setReqId(id)
  }

  return (
    <Modal open onClose={onClose} title={task ? 'Edit scheduled task' : 'New scheduled task'} closeOnBackdrop={false}>
      <div className="cr-sched-modal" data-testid="sched-form-modal">
        <label className="cr-sched-field">
          <span>Name (optional)</span>
          <input data-testid="sched-form-name" value={name} onChange={(e) => setName(e.target.value)} disabled={inFlight} />
        </label>
        <label className="cr-sched-field">
          <span>Prompt</span>
          <textarea
            data-testid="sched-form-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the scheduled run do?"
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
            <input data-testid="sched-form-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" disabled={inFlight} />
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
          <input data-testid="sched-form-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={inFlight} />
        </label>
        <label className="cr-sched-field">
          <span>Working directory (optional)</span>
          <input data-testid="sched-form-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" disabled={inFlight} />
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
          <button type="button" data-testid="sched-form-cancel" onClick={onClose} disabled={inFlight}>Cancel</button>
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

  // A defensive default: a snapshot that somehow lacks the gate block must not
  // render as "enabled". Absence reads as OFF, the safe direction.
  const gate = snapshot?.scheduler ?? {
    enabled: false,
    engineArmed: false,
    restartRequired: false,
    source: 'default' as const,
  }

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
        enabled={gate.enabled}
        engineArmed={gate.engineArmed}
        restartRequired={gate.restartRequired}
        source={gate.source}
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
              <TaskRow key={t.id} task={t} selected={t.id === selectedId} onSelect={(id) => selectTask(id)} />
            ))}
          </ul>
          {selected ? (
            <TaskDetail key={selected.id} task={selected} />
          ) : (
            <p className="cr-dim" data-testid="sched-detail-empty">Select a task to inspect it.</p>
          )}
        </div>
      )}
    </section>
  )
}
