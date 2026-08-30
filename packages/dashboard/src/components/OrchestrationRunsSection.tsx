/**
 * OrchestrationRunsSection (#6691 S-3b, epic #6702) — the "Runs" Control Room tab.
 *
 * Read-only observer surface for the orchestration/committee engine: a runs
 * list (left) and, on selection, the run's full detail — status/budget header,
 * the node (subtask) tree with per-node role/status/spend + "Open session"
 * jump, pending gates (display-only in S-3b; approve/deny lands in S-3c), the
 * bounded activity timeline, and the persisted report markdown at terminal
 * state (JSON behind a collapsed <details>).
 *
 * Data flow: the tab is `survey: true` in the CONTROL_ROOM_TABS registry, so
 * activation auto-fetches `orchestration_runs_request` (staleness-guarded);
 * selecting a run pulls its detail via `requestOrchestrationRunDetail`. Live
 * `orchestration_run_delta` messages upsert list rows and apply to the held
 * detail under the store-core seq contract (a gap shows "resyncing…" until the
 * resync snapshot lands). No client-side pricing math — costs render the
 * server's effectiveUsd via the shared formatters (issue AC-3).
 *
 * The tab is capability-gated (`serverCapabilities.orchestration`) at the
 * ControlRoomView strip/deep-link layer — this component assumes it only
 * renders when the engine is enabled.
 */
import { useCallback, useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import { isSessionListed } from '../store/utils'
import type { RunSummary, RunDetail, RunGate, RunNode, RunTimelineEntry, RunUsage } from '@chroxy/protocol'
import { formatGeneratedAgo } from './ControlRoomSection'
import { renderMarkdown } from '../lib/markdown'
import { handleMarkdownBodyClick } from '../lib/codeCopy'
import { Modal } from './Modal'

/** Server-authored spend figure — never computed client-side (AC-3). */
function usd(usage: RunUsage | undefined | null): string {
  if (!usage || !Number.isFinite(usage.effectiveUsd)) return '—'
  return `$${usage.effectiveUsd.toFixed(4)}`
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** Status chip accent: terminal-good, terminal-bad, gated, or in-flight. */
function statusAccent(status: string): string {
  if (status === 'completed') return 'ok'
  if (status === 'failed' || status === 'cancelled') return 'bad'
  if (
    status === 'plan_review' || status === 'budget_paused' || status === 'resource_paused'
    || status === 'paused' || status === 'suspended'
  ) return 'warn'
  return 'neutral'
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className="cr-tag" data-accent={statusAccent(status)} data-testid="orch-run-status">
      {status.replace(/_/g, ' ')}
    </span>
  )
}

/** Budget meter: spent vs cap (or uncapped), warned/capped accent. */
function BudgetMeter({ run }: { run: RunSummary }) {
  const { capUsd, spentUsd, state } = run.budget
  const label = capUsd == null
    ? `$${spentUsd.toFixed(4)} spent (no cap)`
    : `$${spentUsd.toFixed(4)} / $${capUsd.toFixed(2)}`
  return (
    <span
      className="cr-tag"
      data-accent={state === 'capped' ? 'bad' : state === 'warned' ? 'warn' : 'neutral'}
      data-testid="orch-budget-meter"
      title={`budget state: ${state}`}
    >
      {label}
    </span>
  )
}

function RunRow({ run, selected, onSelect }: { run: RunSummary; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className={`cr-orch-run-row${selected ? ' is-selected' : ''}`}
        data-testid="orch-run-row"
        aria-pressed={selected}
        onClick={() => onSelect(run.runId)}
      >
        <span className="cr-orch-run-title" data-testid="orch-run-title">{run.title || run.runId}</span>
        <StatusChip status={run.status} />
        {run.pendingUserGates > 0 && (
          <span className="cr-tag" data-accent="warn" data-testid="orch-run-gate-chip">
            {run.pendingUserGates} gate{run.pendingUserGates === 1 ? '' : 's'} awaiting you
          </span>
        )}
        <span className="cr-dim" data-testid="orch-run-spend"> · {usd(run.usage)}</span>
        <span className="cr-dim"> · {run.nodeCounts.done}/{run.nodeCounts.total} done</span>
      </button>
    </li>
  )
}

/**
 * #7536 — the node's "Open session" jump, gated on ROSTER MEMBERSHIP rather
 * than on `node.sessionId` being truthy.
 *
 * `node.sessionId` is PROVENANCE, not a live handle: a node's session is closed
 * the moment the node finishes and the run record keeps the id long after, which
 * is the point of a run record. Gating on truthiness therefore left a
 * link-styled, clickable button on every completed node — most of the rows in a
 * finished run — that `switchSession` has refused in SILENCE since #7511. The
 * dead click #7474/#7516 were filed about, on a third surface.
 *
 * `isSessionListed` is the choke point's OWN predicate (`store/utils.ts`, the
 * function `switchSession` calls) read at render time over the same `sessions`
 * array, so "looks clickable" and "will work" cannot disagree. Never a second
 * `sessions.some(...)` written here — that is the copy #7475 collapsed four of.
 *
 * ## The inert shape
 *
 * The BUTTON goes, following the banner rather than the widget row (PR #7528).
 * #7466's criterion is recoverability: a closed node session does not come back
 * under the same id, so the control is removed rather than disabled. Unlike the
 * widget row this button carries no second duty — it is not a mark-read
 * affordance and not a `role="menuitem"` anchor — so nothing is lost by
 * removing it. Everything else in the row stays: this is a gate, not a
 * dismissal, and the row is the provenance the panel exists to show.
 *
 * A marker says WHY, in the banner's vocabulary ("No longer open"), because a
 * silently affordance-less row reads as a rendering bug. It carries
 * `role="status"`, which is the banner's marker verbatim — same role, same
 * text — and the reason is the scenario the banner itself cites: the roster
 * snapshot that removes a session re-renders this row WHILE THE PANEL IS OPEN,
 * replacing a control the operator was about to aim at. A sighted user sees
 * that; without the role a screen-reader user gets a silent disappearance. It
 * is also the case with a test — `flips LIVE when the roster drops the node
 * session under the cursor` — whereas the alternative is speculative.
 *
 * An earlier draft made this the one deliberate DIVERGENCE from the banner, on
 * two premises that do not survive checking (PR #7539 review F2), and they are
 * recorded because the shape recurs:
 *   - "a run detail renders one marker per subtask and the gone state is the
 *     terminal state of every one" describes the panel's INITIAL RENDER, and a
 *     live region inserted already-populated is the case mainstream screen
 *     readers do NOT announce. Twenty completed nodes are silent either way, so
 *     the noise the divergence was avoiding largely does not exist.
 *   - "the row's own status chip is the change worth hearing" was simply false:
 *     `StatusChip` above is a bare `<span className="cr-tag">` with no role, no
 *     `aria-live` and no live-region ancestor. The alternative channel it
 *     pointed at is not audible at all.
 *
 * The real cost, stated rather than denied: a `session_list` that retires
 * SEVERAL node sessions at once — a run completing — inserts N markers in one
 * commit. That is a genuine batch, it is accepted here, and it is bounded by
 * the same insertion behaviour above (a populated region on insert is at worst
 * announced once per AT that does announce it). Consistency of one marker with
 * one meaning across every surface is worth more than a per-surface divergence
 * argued from contested AT behaviour.
 *
 * The CSS class stays `cr-dim` rather than the banner's own: styling is
 * surface-local (`cr-orch` has no stylesheet rule at all), and it is the ROLE
 * and the TEXT that have to match, not the paint.
 *
 * A node that never had a session at all gets neither the button nor the
 * marker: "no longer open" would be a false claim about it, and the two
 * absences are different facts.
 */
function NodeRow({ node, onOpenSession, isSessionListed: sessionIsListed }: {
  node: RunNode
  onOpenSession: (sessionId: string) => void
  isSessionListed: (sessionId: string) => boolean
}) {
  const openable = !!node.sessionId && sessionIsListed(node.sessionId)
  return (
    <li className="cr-orch-node" data-testid="orch-node-row">
      <span className="cr-orch-node-title">{node.title || node.nodeId}</span>
      <span className="cr-tag" data-accent="neutral" data-testid="orch-node-role">{node.role}</span>
      <StatusChip status={node.status} />
      <span className="cr-dim"> · {usd(node.usage ?? null)}</span>
      {node.committeeIterations > 0 && <span className="cr-dim"> · {node.committeeIterations} committee round{node.committeeIterations === 1 ? '' : 's'}</span>}
      {node.branch && <code className="cr-dim" data-testid="orch-node-branch">{node.branch}</code>}
      {openable && (
        <button type="button" className="cr-link-btn" data-testid="orch-node-open-session" onClick={() => onOpenSession(node.sessionId!)}>
          Open session
        </button>
      )}
      {!!node.sessionId && !openable && (
        <span className="cr-dim" data-testid="orch-node-session-gone" role="status">No longer open</span>
      )}
    </li>
  )
}

/** A resolved gate (or the summary line of a pending one) — display only. */
function GateRow({ gate }: { gate: RunGate }) {
  return (
    <li className="cr-orch-gate" data-testid="orch-gate-row" data-gate-status={gate.status}>
      <span className="cr-tag" data-accent={gate.status === 'pending' ? 'warn' : 'neutral'}>{gate.kind.replace(/_/g, ' ')}</span>
      <span data-testid="orch-gate-summary">{gate.summary}</span>
      {gate.status !== 'pending' && <span className="cr-dim"> · {gate.status}{gate.resolvedBy ? ` by ${gate.resolvedBy}` : ''}</span>}
    </li>
  )
}

/**
 * GateBanner (#6691 S-3c) — an actionable pending gate. Approve / Request
 * changes (→ revise, requires a note) / Reject / Skip; a budget_overrun gate
 * additionally takes a new-cap input on approve. The request is correlated by
 * requestId; the row shows a pending → ack/error state inline.
 */
function GateBanner({ runId, gate }: { runId: string; gate: RunGate }) {
  const send = useConnectionStore((s) => s.sendOrchestrationGateResponse)
  const pending = useConnectionStore((s) => s.orchestrationPendingActions)
  const results = useConnectionStore((s) => s.orchestrationActionResults)
  const [note, setNote] = useState('')
  const [budget, setBudget] = useState('')
  const [reqId, setReqId] = useState<string | null>(null)

  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined
  const isBudget = gate.kind === 'budget_overrun'
  // Lock once we've sent — inFlight OR a recorded success. Prevents a duplicate
  // gate response in the ack→delta window (the ack clears `pending` and flips
  // inFlight false BEFORE the run-detail delta flips gate.status and unmounts
  // this banner, briefly re-enabling the buttons otherwise).
  const locked = inFlight || result?.ok === true

  const respond = (decision: 'approve' | 'reject' | 'revise' | 'skip') => {
    if (locked) return
    if (decision === 'revise' && !note.trim()) return // require a note to request changes
    // budget_overrun raise: only a positive, finite figure is a real cap
    const parsed = isBudget && decision === 'approve' && budget.trim() ? Number(budget) : undefined
    const budgetUsd = Number.isFinite(parsed) && (parsed as number) > 0 ? parsed : undefined
    const id = send(runId, gate.gateId, decision, note.trim() || undefined, budgetUsd)
    if (id) setReqId(id)
  }

  return (
    <li className="cr-orch-gate-banner" data-testid="orch-gate-banner" data-gate-kind={gate.kind}>
      <div className="cr-orch-gate-head">
        <span className="cr-tag" data-accent="warn">{gate.kind.replace(/_/g, ' ')}</span>
        <span data-testid="orch-gate-summary">{gate.summary}</span>
      </div>
      {gate.detail && <p className="cr-dim cr-orch-gate-detail">{gate.detail}</p>}
      <textarea
        className="cr-orch-gate-note"
        data-testid="orch-gate-note"
        placeholder="Note (required to request changes)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        disabled={inFlight}
      />
      {isBudget && (
        <input
          className="cr-orch-gate-budget"
          data-testid="orch-gate-budget-input"
          type="number"
          min="0.01"
          step="0.01"
          placeholder="New budget cap (USD) — optional"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          disabled={inFlight}
        />
      )}
      <div className="cr-orch-gate-actions">
        <button type="button" data-testid="orch-gate-approve" disabled={locked} onClick={() => respond('approve')}>Approve</button>
        <button type="button" data-testid="orch-gate-revise" disabled={locked || !note.trim()} onClick={() => respond('revise')}>Request changes</button>
        <button type="button" data-testid="orch-gate-reject" disabled={locked} onClick={() => respond('reject')}>Reject</button>
        <button type="button" data-testid="orch-gate-skip" disabled={locked} onClick={() => respond('skip')}>Skip</button>
      </div>
      {inFlight && <span className="cr-dim" data-testid="orch-gate-pending">Sending…</span>}
      {result?.ok && <span className="cr-ok" data-testid="orch-gate-sent">Response sent</span>}
      {result && !result.ok && <span className="cr-error" data-testid="orch-gate-error">{result.error}</span>}
    </li>
  )
}

function TimelineRow({ entry }: { entry: RunTimelineEntry }) {
  return (
    <li className="cr-orch-timeline-entry" data-testid="orch-timeline-entry">
      <span className="cr-dim">#{entry.seq}</span> {entry.summary}
      {entry.verdict && <span className="cr-tag" data-accent="neutral">{entry.verdict}</span>}
    </li>
  )
}

function DetailPanel({ runId, onOpenSession, isSessionListed: sessionIsListed }: {
  runId: string
  onOpenSession: (sessionId: string) => void
  /**
   * #7536 — threaded down rather than recomputed here, and REQUIRED with no
   * default: defaulting to "listed" is exactly the hole being closed, and a
   * default would let a future call site reopen it silently (the
   * `NotificationsWidget` prop's reasoning, same shape).
   */
  isSessionListed: (sessionId: string) => boolean
}) {
  const held = useConnectionStore((s) => s.orchestrationRunDetails[runId] ?? null)
  const loading = useConnectionStore((s) => s.orchestrationRunDetailLoading.has(runId))
  const stale = useConnectionStore((s) => s.orchestrationRunDetailStale[runId] === true)
  const error = useConnectionStore((s) => s.orchestrationRunDetailErrors[runId] ?? null)

  if (error) {
    return <p className="cr-error" data-testid="orch-detail-error">{error.code}: {error.message}</p>
  }
  if (!held) {
    return <p className="cr-dim" data-testid="orch-detail-loading">{loading ? 'Loading run detail…' : 'Select a run to inspect it.'}</p>
  }
  const run: RunDetail = held.detail
  const pendingGates = run.gates.filter((g) => g.status === 'pending')
  const resolvedGates = run.gates.filter((g) => g.status !== 'pending')
  return (
    <div className="cr-orch-detail" data-testid="orch-detail-panel">
      <div className="cr-orch-detail-header">
        <h4 data-testid="orch-detail-title">{run.title || run.runId}</h4>
        <StatusChip status={run.status} />
        <BudgetMeter run={run} />
        <span className="cr-dim" data-testid="orch-detail-spend">{usd(run.usage)} · {run.nodeCounts.done}/{run.nodeCounts.total} subtasks done</span>
        {stale && <span className="cr-tag" data-accent="warn" data-testid="orch-detail-stale">resyncing…</span>}
      </div>
      {run.epicPrompt && <p className="cr-dim cr-orch-epic" data-testid="orch-detail-epic">{run.epicPrompt}</p>}

      <RunControls run={run} />

      {pendingGates.length > 0 && (
        <>
          <h5>Gates awaiting you</h5>
          <ul className="cr-orch-gates" data-testid="orch-pending-gates">{pendingGates.map((g) => <GateBanner key={g.gateId} runId={run.runId} gate={g} />)}</ul>
        </>
      )}

      <h5>Subtasks</h5>
      {run.nodes.length === 0
        ? <p className="cr-dim" data-testid="orch-nodes-empty">No subtasks yet (planning).</p>
        : <ul className="cr-orch-nodes">{run.nodes.map((n) => <NodeRow key={n.nodeId} node={n} onOpenSession={onOpenSession} isSessionListed={sessionIsListed} />)}</ul>}

      {run.timeline.length > 0 && (
        <>
          <h5>Activity</h5>
          <ul className="cr-orch-timeline" data-testid="orch-timeline">
            {run.timeline.slice(-20).map((e) => <TimelineRow key={e.seq} entry={e} />)}
          </ul>
        </>
      )}

      {resolvedGates.length > 0 && (
        <details>
          <summary className="cr-dim">Resolved gates ({resolvedGates.length})</summary>
          <ul className="cr-orch-gates">{resolvedGates.map((g) => <GateRow key={g.gateId} gate={g} />)}</ul>
        </details>
      )}

      {TERMINAL_STATUSES.has(run.status) && run.report && (
        <>
          <h5>Report</h5>
          {/* the shared sanitized markdown pipeline (same as ChatMessage) — the
              report is model-authored, so it must never render unsanitized */}
          <div
            className="cr-orch-report markdown-content"
            data-testid="orch-report-markdown"
            onClick={handleMarkdownBodyClick}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(run.report.markdown) }}
          />
          <details>
            <summary className="cr-dim">Raw report JSON</summary>
            <pre className="cr-orch-report-json" data-testid="orch-report-json">{run.report.json}</pre>
          </details>
        </>
      )}

      {TERMINAL_STATUSES.has(run.status) && <AnnotateForm runId={run.runId} />}
    </div>
  )
}

/** Cancel/pause/resume controls, gated by the run's current status. */
function RunControls({ run }: { run: RunDetail }) {
  const send = useConnectionStore((s) => s.sendOrchestrationRunAction)
  const pending = useConnectionStore((s) => s.orchestrationPendingActions)
  const [reqId, setReqId] = useState<string | null>(null)
  const inFlight = reqId != null && reqId in pending

  // hidden at terminal state AND while already cancelling (the cancel is
  // in-flight server-side — re-clicking is pointless)
  if (TERMINAL_STATUSES.has(run.status) || run.status === 'cancelling') return null
  const act = (action: 'cancel' | 'pause' | 'resume') => {
    if (action === 'cancel' && !window.confirm('Cancel this run? In-flight workers are stopped and their work auto-committed to their branches.')) return
    const id = send(run.runId, action)
    if (id) setReqId(id)
  }
  const canPause = run.status === 'executing'
  // `resource_paused` (#6733) is deliberately absent: the engine clears that
  // stall itself the moment a session slot frees, so a Resume button would
  // either no-op or race the engine. The warn-accented chip is the whole
  // affordance — the operator's lever is closing a session, not this control.
  const canResume = run.status === 'paused' || run.status === 'budget_paused' || run.status === 'suspended'
  return (
    <div className="cr-orch-run-controls" data-testid="orch-run-controls">
      {canPause && <button type="button" data-testid="orch-action-pause" disabled={inFlight} onClick={() => act('pause')}>Pause</button>}
      {canResume && <button type="button" data-testid="orch-action-resume" disabled={inFlight} onClick={() => act('resume')}>Resume</button>}
      <button type="button" className="cr-danger-btn" data-testid="orch-action-cancel" disabled={inFlight} onClick={() => act('cancel')}>Cancel run</button>
      {inFlight && <span className="cr-dim" data-testid="orch-action-pending">Sending…</span>}
    </div>
  )
}

/**
 * AnnotateForm (#6691 S-3c) — the dogfood measurement affordance: attach a
 * monolithic-baseline session id and/or a verdict-quality note to a terminal
 * run. The report's delegated-vs-baseline comparison reads these.
 */
function AnnotateForm({ runId }: { runId: string }) {
  const send = useConnectionStore((s) => s.sendOrchestrationRunAnnotate)
  const pending = useConnectionStore((s) => s.orchestrationPendingActions)
  const results = useConnectionStore((s) => s.orchestrationActionResults)
  const [baseline, setBaseline] = useState('')
  const [quality, setQuality] = useState('')
  const [reqId, setReqId] = useState<string | null>(null)
  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined

  const submit = () => {
    if (!baseline.trim() && !quality.trim()) return
    const id = send(runId, { baselineSessionId: baseline.trim() || undefined, verdictQuality: quality.trim() || undefined })
    if (id) setReqId(id)
  }
  return (
    <details className="cr-orch-annotate" data-testid="orch-annotate">
      <summary className="cr-dim">Annotate for the cost comparison</summary>
      <input
        className="cr-orch-annotate-baseline"
        data-testid="orch-annotate-baseline"
        placeholder="Monolithic baseline session id"
        value={baseline}
        onChange={(e) => setBaseline(e.target.value)}
        disabled={inFlight}
      />
      <textarea
        className="cr-orch-annotate-quality"
        data-testid="orch-annotate-quality"
        placeholder="Verdict quality note (optional)"
        value={quality}
        onChange={(e) => setQuality(e.target.value)}
        rows={2}
        disabled={inFlight}
      />
      <button type="button" data-testid="orch-annotate-submit" disabled={inFlight || (!baseline.trim() && !quality.trim())} onClick={submit}>Save annotation</button>
      {inFlight && <span className="cr-dim" data-testid="orch-annotate-pending">Saving…</span>}
      {result && (result.ok
        ? <span className="cr-ok" data-testid="orch-annotate-ok">Saved</span>
        : <span className="cr-error" data-testid="orch-annotate-error">{result.error}</span>)}
    </details>
  )
}

/**
 * NewRunModal (#6691 S-3c) — start an orchestration run. v1 exposes the
 * repo-audit preset (or a free-form epic prompt), the working directory (cwd,
 * re-validated server-side against the allowlist), an optional budget cap, and
 * an auto-approve-plan toggle (off by default, so the user reviews the epic
 * plan gate unless they opt in). Role/model overrides use the daemon's
 * configured defaults unless supplied. Uses the shared Modal for focus-trap +
 * Escape + accessible naming; closeOnBackdrop is false since it holds form input.
 */
function NewRunModal({ onClose }: { onClose: () => void }) {
  const start = useConnectionStore((s) => s.startOrchestrationRun)
  const pending = useConnectionStore((s) => s.orchestrationPendingActions)
  const results = useConnectionStore((s) => s.orchestrationActionResults)
  const [preset, setPreset] = useState('repo-audit')
  const [epicPrompt, setEpicPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [title, setTitle] = useState('')
  const [budget, setBudget] = useState('')
  const [autoApprove, setAutoApprove] = useState(false)
  const [reqId, setReqId] = useState<string | null>(null)

  const inFlight = reqId != null && reqId in pending
  const result = reqId != null ? results[reqId] : undefined
  const usePreset = preset !== ''
  const canSubmit = Boolean(cwd.trim()) && (usePreset || Boolean(epicPrompt.trim())) && !inFlight

  // Close the modal once the start action succeeds (its ack cleared the pending
  // entry and recorded ok:true); the list delta brings the new run in.
  useEffect(() => {
    if (result?.ok) onClose()
  }, [result, onClose])

  const submit = () => {
    if (!canSubmit) return
    // only a positive, finite figure is a real cap (schema is z.number().positive())
    const parsed = budget.trim() ? Number(budget) : undefined
    const budgetUsd = Number.isFinite(parsed) && (parsed as number) > 0 ? parsed : undefined
    const id = start({
      cwd: cwd.trim(),
      preset: usePreset ? preset : undefined,
      epicPrompt: !usePreset ? epicPrompt.trim() : undefined,
      title: title.trim() || undefined,
      budgetUsd,
      autoApprovePlan: autoApprove,
    })
    if (id) setReqId(id)
  }

  return (
    <Modal open onClose={onClose} title="Start an orchestration run" closeOnBackdrop={false}>
      <div className="cr-orch-modal" data-testid="orch-new-run-modal">
        <label className="cr-orch-field">
          <span>Preset</span>
          <select data-testid="orch-new-preset" value={preset} onChange={(e) => setPreset(e.target.value)} disabled={inFlight}>
            <option value="repo-audit">repo-audit</option>
            <option value="">Custom epic prompt…</option>
          </select>
        </label>
        {!usePreset && (
          <label className="cr-orch-field">
            <span>Epic prompt</span>
            <textarea data-testid="orch-new-epic" rows={3} value={epicPrompt} onChange={(e) => setEpicPrompt(e.target.value)} placeholder="Describe the epic to decompose…" disabled={inFlight} />
          </label>
        )}
        <label className="cr-orch-field">
          <span>Working directory</span>
          <input data-testid="orch-new-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" disabled={inFlight} />
        </label>
        <label className="cr-orch-field">
          <span>Title (optional)</span>
          <input data-testid="orch-new-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={inFlight} />
        </label>
        <label className="cr-orch-field">
          <span>Budget cap USD (optional)</span>
          <input data-testid="orch-new-budget" type="number" min="0.01" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={inFlight} />
        </label>
        <label className="cr-orch-check">
          <input type="checkbox" data-testid="orch-new-autoapprove" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} disabled={inFlight} />
          <span>Auto-approve plan (skips the epic-plan gate)</span>
        </label>
        {result && !result.ok && <p className="cr-error" data-testid="orch-new-error">{result.error}</p>}
        <div className="cr-orch-modal-actions">
          <button type="button" data-testid="orch-new-cancel" onClick={onClose} disabled={inFlight}>Cancel</button>
          <button type="button" data-testid="orch-new-submit" onClick={submit} disabled={!canSubmit}>{inFlight ? 'Starting…' : 'Start run'}</button>
        </div>
      </div>
    </Modal>
  )
}

export interface OrchestrationRunsSectionProps {
  /** Injectable clock for the "generated Nm ago" line. */
  now?: () => number
}

export function OrchestrationRunsSection({ now = Date.now }: OrchestrationRunsSectionProps = {}) {
  const snapshot = useConnectionStore((s) => s.orchestrationRuns)
  const loading = useConnectionStore((s) => s.orchestrationRunsLoading)
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestRuns = useConnectionStore((s) => s.requestOrchestrationRuns)
  const requestDetail = useConnectionStore((s) => s.requestOrchestrationRunDetail)
  const selectedRunId = useConnectionStore((s) => s.selectedRunId)
  const selectRun = useConnectionStore((s) => s.selectRun)
  const switchSession = useConnectionStore((s) => s.switchSession)
  // #7536 — the roster `switchSession` membership-checks against, read here so
  // the node rows can ask the SAME question at render time. Mirrors App's
  // `sessionIsListed` wrapper (#7516): the shared helper, over the store's own
  // `sessions`, memoised on it.
  const sessions = useConnectionStore((s) => s.sessions)
  const sessionIsListed = useCallback(
    (sessionId: string) => isSessionListed(sessions, sessionId),
    [sessions],
  )
  const [showNewRun, setShowNewRun] = useState(false)

  // Pull the selected run's detail when it isn't held yet (selection persists
  // across tab flips; the delta stream keeps a held detail current).
  const heldSelected = useConnectionStore((s) => (selectedRunId ? s.orchestrationRunDetails[selectedRunId] ?? null : null))
  const selectedLoading = useConnectionStore((s) => (selectedRunId ? s.orchestrationRunDetailLoading.has(selectedRunId) : false))
  useEffect(() => {
    if (selectedRunId && !heldSelected && !selectedLoading && connected) {
      requestDetail(selectedRunId)
    }
  }, [selectedRunId, heldSelected, selectedLoading, connected, requestDetail])

  const runs = snapshot?.runs ?? []
  return (
    <section className="cr-section" data-testid="orch-runs-section">
      <header className="cr-section-header">
        <div>
          <div className="cr-eyebrow">Orchestration</div>
          <h3>Runs</h3>
          {snapshot && <span className="cr-dim" data-testid="orch-generated-ago">{formatGeneratedAgo(Date.parse(snapshot.generatedAt), now())}</span>}
        </div>
        <div className="cr-orch-header-actions">
          <button
            type="button"
            className="cr-primary-btn"
            data-testid="orch-new-run"
            disabled={!connected}
            onClick={() => setShowNewRun(true)}
          >
            New run
          </button>
          <button
            type="button"
            className="cr-refresh-btn"
            data-testid="orch-refresh"
            disabled={!connected || loading}
            onClick={() => requestRuns()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {showNewRun && <NewRunModal onClose={() => setShowNewRun(false)} />}

      {snapshot?.error && (
        <p className="cr-error" data-testid="orch-runs-error">{snapshot.error.code}: {snapshot.error.message}</p>
      )}

      {runs.length === 0 && !snapshot?.error ? (
        <p className="cr-dim" data-testid="orch-runs-empty">
          {snapshot ? 'No orchestration runs yet. Start one to see the committee at work (S-3c adds the button; the WS API works today).' : loading ? 'Loading…' : 'Not loaded yet.'}
        </p>
      ) : (
        <div className="cr-orch-layout">
          <ul className="cr-orch-run-list" data-testid="orch-run-list">
            {runs.map((r) => (
              <RunRow key={r.runId} run={r} selected={r.runId === selectedRunId} onSelect={(id) => selectRun(id)} />
            ))}
          </ul>
          {selectedRunId && <DetailPanel runId={selectedRunId} onOpenSession={(sessionId) => switchSession(sessionId)} isSessionListed={sessionIsListed} />}
        </div>
      )}
    </section>
  )
}
