/**
 * OrchestrationManager (engine, epic #6691, steps E-2 + E-3) — the committee
 * engine. Owns run lifecycle: an architect session plans the epic, worker
 * sessions execute subtasks, the architect reviews each plan-of-attack and
 * result, and a synthesis turn produces the report.
 *
 * Two worker kinds:
 *  - audit (read-only): read/search the repo, report findings. sdk/byok/codex.
 *  - implement (write-capable, E-3): edit files in an ISOLATED worktree, then
 *    the orchestrator commits + merges the branch into a run-owned integration
 *    worktree. codex-ONLY in v1 (codexSandbox:'workspace-write' is the only
 *    verified path jail; sdk/byok write pending #6735). The engine NEVER touches
 *    the user's branch/working tree and NEVER pushes — output is branches.
 *
 * The wire projection is E-4; restart-reconcile / orphan-sweep / gate-timeouts /
 * pause-resume + the automated conflict-fixup worker are E-3 part 3.
 *
 * Wires the merged foundations: RunLedger (M-2) for durable state + usage,
 * run-budget (M-3) for soft caps, TurnDriver (E-1) to drive sessions,
 * decision-contract (E-1) for the structured committee decisions, run-model
 * (E-1) for the gate registry, role-prompts (this step), and the permission
 * gate. Sessions are real SessionManager sessions (one model per session).
 *
 * The manager is event-driven and async; each subtask advances through the
 * committee loop as its turns resolve. All external collaborators are injected,
 * so the whole loop is testable against a scripted fake provider.
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { extractDecision, DecisionParseError, buildRepairPrompt } from './decision-contract.js'
import { makeGate, resolveGate as resolveGateModel, nextGateId } from './run-model.js'
import {
  architectPreamble, auditWorkerPreamble, implementWorkerPreamble, presetFor,
  buildPlanPrompt, buildPoaPrompt, buildPoaReviewPrompt,
  buildExecutePrompt, buildResultReviewPrompt, buildSynthesisPrompt,
} from './role-prompts.js'
import { createGitOps } from './git-ops.js'
import { recordToRunSummary, recordToRunDetail, gateToWire } from './to-wire.js'
import { buildRunReport, renderReportMarkdown } from './run-report.js'

const DEFAULTS = {
  maxParallelWorkers: 2,
  reserveSessions: 1,
  maxCommitteeIterations: 4,
  maxParseRetries: 2,
  turnTimeoutMs: 30 * 60 * 1000,
  diff: { maxBytes: 65536, maxFileBytes: 8192 },
  bash: { implementAllowlist: [] },
}

// Providers whose sessions can be metered AND permission-gated read-only (S-2
// design matrix). audit workers must be one of these.
const AUDIT_ELIGIBLE_PROVIDERS = new Set(['claude-sdk', 'claude-byok', 'codex'])

// v1: write/implement workers are codex-ONLY. codexSandbox:'workspace-write' is a
// verified OS jail confining edits to the worktree; acceptEdits/allow rules are
// path-AGNOSTIC and do NOT confine paths, so sdk/byok can't be safely write-
// capable until their sandbox is verified (tracked in #6735). A run whose worker
// provider isn't implement-eligible has its implement subtasks coerced to audit.
const IMPLEMENT_ELIGIBLE_PROVIDERS = new Set(['codex'])

// Engine-side subtask states that end scheduling. 'escalated' is deliberately
// excluded — it awaits a user gate, so it must block synthesis.
const TERMINAL_SUBTASK_STATES = new Set(['done', 'failed', 'skipped'])
function isTerminalSubtaskState(state) { return TERMINAL_SUBTASK_STATES.has(state) }

export class OrchestrationManager extends EventEmitter {
  /**
   * @param {{
   *   sessionManager: any, ledger: any, turnDriver: any, permissionGateFactory?: Function,
   *   config?: object, roles?: object, validateCwd?: (cwd: string) => (string|null),
   *   now?: () => number, log?: object,
   * }} opts
   */
  constructor({ sessionManager, ledger, turnDriver, gitOps = null, permissionGateFactory = null, config = {}, roles = null, validateCwd = null, now = () => Date.now(), log = null }) {
    super()
    if (!sessionManager) throw new Error('OrchestrationManager requires a sessionManager')
    if (!ledger) throw new Error('OrchestrationManager requires a ledger')
    if (!turnDriver) throw new Error('OrchestrationManager requires a turnDriver')
    this._sm = sessionManager
    this._ledger = ledger
    this._driver = turnDriver
    const cfg = config.orchestration || config || {}
    this._cfg = {
      ...DEFAULTS,
      ...cfg,
      diff: { ...DEFAULTS.diff, ...(cfg.diff || {}) },
      bash: { ...DEFAULTS.bash, ...(cfg.bash || {}) },
    }
    this._gitOps = gitOps || createGitOps()
    this._roles = roles || cfg.roles || null
    this._validateCwd = validateCwd
    this._now = now
    this._log = log
    this._runs = new Map() // runId -> engine state
    this._reports = new Map() // runId -> the architect's synthesis narrative markdown
    this._reportDocs = new Map() // runId -> { json, markdown } — the persisted M-4 report artifacts
    this._maxReports = 32
    // Final wire-projected snapshots for terminal runs (their engine state is
    // deleted from _runs, so gates/timeline would otherwise be gone). Bounded.
    this._completedSnapshots = new Map() // runId -> { seq, run: RunDetail }
    this._maxCompletedSnapshots = 32
    this._maxSessions = Number.isFinite(config.maxSessions) ? config.maxSessions : 5

    // Owned-session registry drives the permission gate (answers ONLY our sessions).
    if (permissionGateFactory) {
      this._gate = permissionGateFactory({
        sessionManager,
        isOwnedSession: (sid) => this._isOwnedSession(sid),
        policyForSession: (sid) => this._roleClassForSession(sid),
        emitEscalation: (info) => this._onPermissionEscalation(info),
        bashAllowlist: this._cfg.bash.implementAllowlist || [],
        log,
      })
    }
  }

  dispose() {
    this._gate?.dispose?.()
  }

  // --- run creation --------------------------------------------------------

  createRun({ title = '', goal = null, cwd, preset = null, budgetUsd = null, autoApprovePlan = false, roleOverrides = null } = {}) {
    if (!cwd || typeof cwd !== 'string') throw new Error('createRun requires a cwd')
    if (this._validateCwd) {
      const cwdError = this._validateCwd(cwd)
      if (cwdError) throw new Error(`invalid cwd: ${cwdError}`)
    }
    if (this._runs.size > 0) throw new Error('a run is already active (one run at a time in v1)')

    const presetDef = preset ? presetFor(preset) : null
    const effectiveGoal = goal || presetDef?.goalTemplate || null
    if (!effectiveGoal) throw new Error('createRun requires a goal or a preset that provides one')

    const roleModels = this._resolveRoles(roleOverrides)
    const implementEligible = IMPLEMENT_ELIGIBLE_PROVIDERS.has(roleModels.worker.provider)
    const configSnapshot = {
      cwd,
      roleModels,
      budget: { maxUsd: Number.isFinite(budgetUsd) ? budgetUsd : null, warnPercent: 80 },
    }
    const record = this._ledger.createRun({ title: title || (presetDef?.name ?? 'orchestration run'), preset, configSnapshot })
    const runId = record.runId

    this._runs.set(runId, {
      runId,
      cwd,
      goal: effectiveGoal,
      preset: presetDef,
      autoApprovePlan: autoApprovePlan === true,
      roleModels,
      implementEligible, // codex-only in v1 (#6735) — else implement subtasks coerce to audit
      architectSessionId: null,
      ownedSessions: new Map(), // sessionId -> { role: 'architect'|'audit'|'implement'|'fixup', subtaskId }
      gates: new Map(), // gateId -> gate
      subtasks: new Map(), // subtaskId -> { iterations, poa, result, state, role, branch, baseSha, worktreePath }
      results: [], // accepted { title, summary }
      integration: null, // { worktreePath, branch, merged: [] } — lazily created on first accepted implement subtask
      mergeChain: Promise.resolve(), // per-run mutex serializing integration-worktree ops (create/merge/abort)
      timeline: [], // [RunTimelineEntry] activity feed (gate opens/resolves + committee reviews)
      timelineSeq: 0, // monotonic per-run seq for timeline entries
      wireSeq: 0, // per-run wire delta seq (bumped on successful broadcast in E-4 part 3)
      phase: 'created',
      cancelled: false,
    })
    return record
  }

  _resolveRoles(overrides) {
    const base = this._roles || {}
    const merged = { ...base, ...(overrides || {}) }
    const architect = merged.architect
    const worker = merged.auditWorker || merged.worker
    if (!architect?.provider || !architect?.model) throw new Error('orchestration roles.architect must set { provider, model }')
    if (!worker?.provider || !worker?.model) throw new Error('orchestration roles.worker/auditWorker must set { provider, model }')
    if (!AUDIT_ELIGIBLE_PROVIDERS.has(worker.provider)) {
      throw new Error(`audit worker provider '${worker.provider}' cannot be permission-gated read-only (use ${[...AUDIT_ELIGIBLE_PROVIDERS].join('/')})`)
    }
    return { architect, worker }
  }

  // --- lifecycle -----------------------------------------------------------

  async startRun(runId) {
    const run = this._get(runId)
    if (run.phase !== 'created') throw new Error(`run ${runId} already started (phase ${run.phase})`)
    run.phase = 'planning'
    this._ledger.setStatus(runId, 'planning')
    let plan
    try {
      plan = await this._plan(run)
    } catch (err) {
      return this._failRun(run, `PLAN_${err instanceof DecisionParseError ? 'PARSE' : 'FAILED'}`, err)
    }
    // Materialize subtasks. A subtask runs 'implement' (write-capable) ONLY when
    // the architect asked for it AND the run's worker provider is
    // implement-eligible (codex, #6735) AND no preset forces audit. Otherwise it
    // is coerced to read-only 'audit' — labeling it worker.implement while it
    // actually runs read-only would make the run record lie.
    for (const spec of plan.subtasks) {
      const subtaskId = `st_${randomBytes(4).toString('hex')}`
      const wantsImplement = spec.role === 'implement'
      const role = run.preset?.forceRole ?? (wantsImplement && run.implementEligible ? 'implement' : 'audit')
      if (wantsImplement && role !== 'implement') {
        this._log?.warn?.(`orchestration: subtask "${spec.title}" requested implement; coerced to audit (${run.preset?.forceRole ? 'preset forces audit' : 'worker provider not implement-eligible'})`)
      }
      this._ledger.createSubtask(runId, { subtaskId, role: `worker.${role}`, title: spec.title })
      run.subtasks.set(subtaskId, { iterations: 0, spec: { ...spec, role }, state: 'pending', poa: null, result: null, branch: null, baseSha: null, worktreePath: null })
    }

    if (run.autoApprovePlan) {
      return this._beginExecuting(run)
    }
    // open the epic_plan user gate — the spend gate
    const gate = this._openGate(run, { kind: 'epic_plan', summary: `Approve the ${run.subtasks.size}-subtask audit plan`, detail: plan.summary ?? null })
    run.phase = 'plan_review'
    this._ledger.setStatus(runId, 'plan_review')
    this.emit('gate_opened', { runId, gate })
    this._emitRunDelta(run, { gate })
    return { runId, phase: 'plan_review', gateId: gate.gateId }
  }

  async _plan(run) {
    const sessionId = this._spawnSession(run, { role: 'architect' })
    run.architectSessionId = sessionId
    run.ownedSessions.set(sessionId, { role: 'architect', subtaskId: null })
    // The architect reads/greps the repo to plan and review; it never edits.
    // Give it the same read-only rules as workers so its Read/Glob/Grep are
    // settled without prompting (else — with no rules and the gate deliberately
    // deny-only for it — a read request would wedge until the turn watchdog
    // fires and fails the run). Anything else it emits (Bash) hits the gate.
    this._applyReadOnlyRules(sessionId)
    const repoMap = ''
    const prompt = buildPlanPrompt({ goal: run.goal, repoMap, maxSubtasks: 8 })
    const { decision } = await this._driveDecision(run, sessionId, prompt, 'epic_plan', 'plan', null)
    return decision
  }

  async resolveGate(runId, gateId, { decision, note = null, budgetUsd = null } = {}) {
    const run = this._get(runId)
    const gate = run.gates.get(gateId)
    if (!gate) {
      const err = new Error(`gate ${gateId} not found`)
      err.code = 'GATE_NOT_FOUND'
      throw err
    }
    const resolved = resolveGateModel(gate, { decision, note, budgetUsd, resolvedAt: this._now() })
    run.gates.set(gateId, resolved)
    this._appendTimeline(run, { kind: 'gate_resolved', gateId, nodeId: gate.nodeId ?? null, summary: `${gate.kind} gate ${decision}`, detail: note })
    this.emit('gate_resolved', { runId, gate: resolved })
    this._emitRunDelta(run, { gate: resolved })

    if (gate.kind === 'epic_plan') {
      if (decision === 'approve') return this._beginExecuting(run)
      return this._failRun(run, 'PLAN_REJECTED', new Error(note || 'epic plan rejected'))
    }
    if (gate.kind === 'escalation') {
      return this._resolveEscalation(run, gate, decision, note)
    }
    return { runId, gateId, decision }
  }

  _beginExecuting(run) {
    run.phase = 'executing'
    this._ledger.setStatus(run.runId, 'executing')
    this._schedule(run)
    return { runId: run.runId, phase: 'executing' }
  }

  // --- scheduler -----------------------------------------------------------

  _schedule(run) {
    if (run.cancelled || run.phase !== 'executing') return
    const all = [...run.subtasks.values()]
    // Ready to synthesize only when EVERY subtask is terminal. 'escalated' is
    // NOT terminal — it blocks synthesis until the user resolves its gate, so a
    // sibling escalation can't let the run synthesize with a hole in it.
    if (all.every((s) => isTerminalSubtaskState(s.state))) {
      this._synthesize(run).catch((err) => this._failRun(run, 'SYNTHESIS_FAILED', err))
      return
    }
    const pending = [...run.subtasks.entries()].filter(([, s]) => s.state === 'pending')
    for (const [subtaskId] of pending) {
      if (this._activeWorkerCount(run) >= this._cfg.maxParallelWorkers) break
      if (!this._sessionHeadroom()) break
      const budget = this._ledger.evaluateBudget(run.runId, { role: 'worker.audit' })
      if (budget && budget.ok === false) { this._pauseForBudget(run); break }
      const st = run.subtasks.get(subtaskId)
      st.state = 'active'
      this._runSubtask(run, subtaskId).catch((err) => {
        this._log?.warn?.(`subtask ${subtaskId} crashed: ${err?.message || err}`)
        this._finishSubtask(run, subtaskId, 'failed').catch(() => {})
      })
    }
  }

  async _runSubtask(run, subtaskId) {
    const st = run.subtasks.get(subtaskId)
    let sessionId = await this._spawnWorker(run, subtaskId)

    let feedback = null
    // committee loop for this subtask
    while (true) {
      // Bail if the run was cancelled/torn down while an await was in flight —
      // don't drive more turns or write status on a dead run.
      if (run.cancelled || !this._runs.has(run.runId)) return null
      // `iterations` counts committee round-trips already spent; at the cap we
      // stop and escalate rather than looping forever on a stubborn subtask.
      if (st.iterations >= this._cfg.maxCommitteeIterations) {
        return this._escalateSubtask(run, subtaskId, 'committee iteration cap exceeded')
      }
      // 1) plan-of-attack
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'briefing' })
      const poa = await this._driveDecision(run, sessionId, buildPoaPrompt({ subtask: st.spec }), 'plan_of_attack', 'poa', subtaskId).then((r) => r.decision)
      st.poa = poa
      // 2) architect reviews the PoA (usage attributed to architect.review, NOT
      // the subtask cell — see _architectReview)
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'poa_review' })
      const poaReview = await this._architectReview(run, buildPoaReviewPrompt({ subtask: st.spec, poa }), 'poa_review')
      this._ledger.recordCommitteeReview(run.runId, subtaskId, { phase: 'plan', verdict: poaReview.verdict, reviewerSessionId: run.architectSessionId, notes: poaReview.feedback ?? '' })
      this._appendTimeline(run, { kind: 'committee_review', nodeId: subtaskId, verdict: poaReview.verdict, summary: `plan-of-attack ${poaReview.verdict}`, detail: poaReview.feedback ?? null })
      if (poaReview.verdict === 'escalate') return this._escalateSubtask(run, subtaskId, poaReview.feedback || 'architect escalated the plan')
      if (poaReview.verdict === 'revise' || poaReview.verdict === 'redelegate') {
        st.iterations += 1
        feedback = poaReview.feedback ?? null
        if (poaReview.verdict === 'redelegate') sessionId = await this._respawnWorker(run, subtaskId, sessionId)
        continue
      }
      // 3) execute
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'executing' })
      const result = await this._driveDecision(run, sessionId, buildExecutePrompt({ subtask: st.spec, feedback }), 'work_result', 'execute', subtaskId).then((r) => r.decision)
      st.result = result
      // 3b) implement subtasks: commit the worktree and compute a review diff so
      // the architect reviews the ACTUAL change, not just the worker's summary.
      const diff = st.spec.role === 'implement' ? await this._commitAndDiff(run, subtaskId, sessionId) : null
      // 4) architect reviews the result (+ diff for implement)
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'result_review' })
      const resultReview = await this._architectReview(run, buildResultReviewPrompt({ subtask: st.spec, result, diff }), 'result_review')
      this._ledger.recordCommitteeReview(run.runId, subtaskId, { phase: 'result', verdict: resultReview.verdict, reviewerSessionId: run.architectSessionId, notes: resultReview.feedback ?? '' })
      this._appendTimeline(run, { kind: 'committee_review', nodeId: subtaskId, verdict: resultReview.verdict, summary: `result ${resultReview.verdict}`, detail: resultReview.feedback ?? null })
      if (resultReview.verdict === 'approve') {
        if (st.spec.role === 'implement') return await this._acceptImplement(run, subtaskId, sessionId, result)
        run.results.push({ title: st.spec.title, summary: result.summary })
        await this._destroySession(run, sessionId)
        return this._finishSubtask(run, subtaskId, 'done')
      }
      if (resultReview.verdict === 'escalate') return this._escalateSubtask(run, subtaskId, resultReview.feedback || 'architect escalated the result')
      // revise / redelegate → loop with feedback (redelegate gets a fresh worker)
      st.iterations += 1
      feedback = resultReview.feedback ?? null
      if (resultReview.verdict === 'redelegate') sessionId = await this._respawnWorker(run, subtaskId, sessionId)
    }
  }

  // Spawn + register + rule-gate + attach a worker session for a subtask.
  async _spawnWorker(run, subtaskId) {
    const st = run.subtasks.get(subtaskId)
    const role = st.spec.role === 'implement' ? 'implement' : 'audit'
    const sessionId = this._spawnSession(run, { role, subtaskId })
    run.ownedSessions.set(sessionId, { role, subtaskId })
    this._ledger.updateSubtask(run.runId, subtaskId, { status: 'briefing' })
    if (role === 'implement') {
      // The write worker got an isolated worktree (worktree:true) — put it on a
      // named branch and record the branch-point so the review diff + merge are
      // reproducible. Its writes are confined by the OS sandbox (codex
      // workspace-write), NOT by permission rules, so we do NOT apply read-only
      // rules (they would deny the edits acceptEdits is meant to allow).
      const worktreePath = this._workerWorktreePath(sessionId)
      st.worktreePath = worktreePath
      if (worktreePath) {
        const branchName = `chroxy/orch/${run.runId}/${subtaskId}`
        try {
          const branchExists = await this._gitOps.branchExists(worktreePath, branchName)
          if (branchExists.exists) await this._gitOps.deleteBranch(worktreePath, branchName)
          const { branch, baseSha } = await this._gitOps.createBranch(worktreePath, branchName)
          st.branch = branch
          st.baseSha = baseSha
        } catch (err) {
          this._log?.warn?.(`orchestration: createBranch failed for ${subtaskId}: ${err?.message || err}`)
        }
      }
    } else {
      this._applyReadOnlyRules(sessionId)
    }
    this._ledger.attachSession(run.runId, subtaskId, { sessionId, provider: run.roleModels.worker.provider, model: run.roleModels.worker.model, meterable: true })
    return sessionId
  }

  // redelegate: tear down the current worker and hand the subtask to a fresh one.
  async _respawnWorker(run, subtaskId, oldSessionId) {
    await this._destroySession(run, oldSessionId)
    this._ledger.updateSubtask(run.runId, subtaskId, { status: 'respawning' })
    return this._spawnWorker(run, subtaskId)
  }

  // Release every session a subtask still owns (worker + any fixup). Awaits the
  // auto-commit-before-destroy of an implement worktree so no work is lost.
  async _releaseSubtaskSessions(run, subtaskId) {
    for (const [sid, meta] of [...run.ownedSessions]) {
      if (meta.subtaskId === subtaskId && meta.role !== 'architect') await this._destroySession(run, sid)
    }
  }

  async _finishSubtask(run, subtaskId, status) {
    if (run.cancelled || !this._runs.has(run.runId)) return
    const st = run.subtasks.get(subtaskId)
    if (st) st.state = status
    this._ledger.updateSubtask(run.runId, subtaskId, { status })
    await this._releaseSubtaskSessions(run, subtaskId)
    this._schedule(run)
  }

  async _escalateSubtask(run, subtaskId, reason) {
    const st = run.subtasks.get(subtaskId)
    if (st) st.state = 'escalated'
    this._ledger.updateSubtask(run.runId, subtaskId, { status: 'escalated' })
    // Free this subtask's worker so a pending sibling can take the slot while
    // the user resolves the escalation gate (auto-commits implement work first).
    await this._releaseSubtaskSessions(run, subtaskId)
    const gate = this._openGate(run, { kind: 'escalation', nodeId: subtaskId, summary: `Subtask "${st?.spec?.title ?? subtaskId}" escalated`, detail: reason })
    this.emit('gate_opened', { runId: run.runId, gate })
    this._emitRunDelta(run, { gate })
    this._schedule(run)
    return { runId: run.runId, subtaskId, escalated: true, gateId: gate.gateId }
  }

  async _resolveEscalation(run, gate, decision, note) {
    const subtaskId = gate.nodeId
    const st = subtaskId ? run.subtasks.get(subtaskId) : null
    if (!st) return { runId: run.runId, resolved: true }
    if (decision === 'skip') { await this._finishSubtask(run, subtaskId, 'skipped'); return { runId: run.runId, subtaskId, skipped: true } }
    if (decision === 'reject') return this._failRun(run, 'ESCALATION_REJECTED', new Error(note || 'user failed the run'))
    // approve / revise → re-drive the subtask (iteration reset via a fresh worker)
    st.state = 'pending'
    st.iterations = 0
    this._schedule(run)
    return { runId: run.runId, subtaskId, retrying: true }
  }

  async _synthesize(run) {
    run.phase = 'synthesizing'
    this._ledger.setStatus(run.runId, 'synthesizing')
    const { decision } = await this._driveDecision(run, run.architectSessionId, buildSynthesisPrompt({ goal: run.goal, results: run.results }), 'synthesis', 'synthesis', null)
    // Keep the architect's narrative in memory (it feeds the persisted report).
    this._rememberReport(run.runId, decision.reportMarkdown)
    await this._destroySession(run, run.architectSessionId)
    // Remove the integration worktree; its branch (the run's output) is kept.
    const integrationBranch = run.integration?.branch ?? null
    await this._cleanupIntegration(run)
    run.phase = 'completed'
    this._ledger.setStatus(run.runId, 'completed')
    // M-4: derive + persist report.{json,md} (metrics report with the synthesis
    // narrative prepended) so the artifact survives restarts.
    this._buildAndPersistReport(run.runId)
    this.emit('run_completed', { runId: run.runId, reportMarkdown: decision.reportMarkdown, integrationBranch })
    this._emitRunDelta(run)
    this._cacheCompletedSnapshot(run)
    this._runs.delete(run.runId)
    return { runId: run.runId, phase: 'completed', reportMarkdown: decision.reportMarkdown, integrationBranch }
  }

  // --- turn driving + decisions -------------------------------------------

  async _architectReview(run, prompt, kind) {
    // subtaskId is intentionally null: the review turn's tokens belong to the
    // architect.review role, NOT the subtask's own usage cell (which tracks the
    // worker's cost). Folding it in would price the architect's turn with the
    // worker's provider and spuriously flip the subtask's modelDrift flag. The
    // review's LINK to the subtask is recorded separately via recordCommitteeReview.
    const { decision } = await this._driveDecision(run, run.architectSessionId, prompt, kind, kind, null)
    return decision
  }

  // --- implement (write) path ---------------------------------------------

  // Auto-commit an implement worker's worktree and compute a capped review diff
  // so the architect reviews the actual change.
  async _commitAndDiff(run, subtaskId, sessionId) {
    const st = run.subtasks.get(subtaskId)
    const worktreePath = st.worktreePath || this._workerWorktreePath(sessionId)
    if (!worktreePath || !st.baseSha) return null
    try {
      await this._gitOps.autoCommit({ worktreePath, subtaskId })
      return await this._gitOps.computeCappedDiff({
        repoDir: worktreePath, baseSha: st.baseSha, headRef: 'HEAD',
        maxBytes: this._cfg.diff.maxBytes, maxFileBytes: this._cfg.diff.maxFileBytes,
      })
    } catch (err) {
      this._log?.warn?.(`orchestration: commit/diff failed for ${subtaskId}: ${err?.message || err}`)
      return null
    }
  }

  // Accept an approved implement subtask: destroy the worker (auto-commits its
  // OWN worktree — safe to run concurrently), then merge its branch into the
  // run's integration worktree UNDER A PER-RUN LOCK so parallel accepts never
  // overlap (create/merge/abort share one integration checkout — concurrent git
  // merges would collide on index.lock and spuriously "fail"). Clean → done;
  // conflict → abort + escalate (the automated fixup worker is E-3 part 3).
  async _acceptImplement(run, subtaskId, sessionId, result) {
    const st = run.subtasks.get(subtaskId)
    this._ledger.updateSubtask(run.runId, subtaskId, { status: 'merging' })
    await this._destroySession(run, sessionId)
    if (!st.branch || !st.baseSha) return this._escalateSubtask(run, subtaskId, 'no branch/worktree to merge')
    return this._withMergeLock(run, () => this._mergeAccepted(run, subtaskId, result))
  }

  // Serialize the integration-worktree critical section per run: chain each
  // caller behind the previous one so at most one create/merge/abort runs at a
  // time. This is what makes "sequential merge" real.
  async _withMergeLock(run, fn) {
    const prev = run.mergeChain
    let release
    run.mergeChain = new Promise((r) => { release = r })
    await prev.catch(() => {})
    try { return await fn() } finally { release() }
  }

  async _mergeAccepted(run, subtaskId, result) {
    if (run.cancelled || !this._runs.has(run.runId)) return null
    const st = run.subtasks.get(subtaskId)
    const integration = await this._ensureIntegration(run, st.baseSha)
    if (!integration) return this._escalateSubtask(run, subtaskId, 'could not create the integration worktree')
    let merge
    try {
      merge = await this._gitOps.mergeNoFf({ integrationWorktree: integration.worktreePath, branch: st.branch, subtaskId })
    } catch (err) {
      return this._escalateSubtask(run, subtaskId, `merge failed: ${err?.message || err}`)
    }
    if (merge.ok) {
      integration.merged.push(subtaskId)
      run.results.push({ title: st.spec.title, summary: result.summary, branch: st.branch })
      return this._finishSubtask(run, subtaskId, 'done')
    }
    try { await this._gitOps.abortMerge(integration.worktreePath) } catch { /* best-effort */ }
    return this._escalateSubtask(run, subtaskId, `merge conflict in: ${(merge.conflictFiles || []).join(', ') || '(see git status)'}`)
  }

  // Lazily create the run's integration worktree on the first accepted implement
  // subtask (audit-only / repo-audit runs never create one). Only ever called
  // from within _withMergeLock, so the check-then-act is not a TOCTOU race.
  async _ensureIntegration(run, baseSha) {
    if (run.integration) return run.integration
    const branchName = `chroxy/orch/${run.runId}/integration`
    try {
      const { worktreePath, branch } = await this._gitOps.createIntegrationWorktree({ repoDir: run.cwd, runId: run.runId, branchName, baseSha })
      run.integration = { worktreePath, branch, merged: [] }
      return run.integration
    } catch (err) {
      this._log?.warn?.(`orchestration: createIntegrationWorktree failed: ${err?.message || err}`)
      return null
    }
  }

  // Drive one turn and extract its decision, with a repair-reprompt ladder.
  async _driveDecision(run, sessionId, prompt, kind, turnLabel, subtaskId) {
    let attempt = 0
    let currentPrompt = prompt
    let lastError = null
    while (attempt <= this._cfg.maxParseRetries) {
      const { text, result } = await this._driver.driveTurn(sessionId, currentPrompt, { label: turnLabel, timeoutMs: this._cfg.turnTimeoutMs })
      const roleClass = run.ownedSessions.get(sessionId)?.role ?? null
      // dotted ledger role: architect plan/synthesis vs architect.review, worker.audit
      const ledgerRole = roleClass === 'architect'
        ? (turnLabel === 'poa_review' || turnLabel === 'result_review' ? 'architect.review' : 'architect')
        : `worker.${roleClass}`
      this._ledger.recordTurnUsage(run.runId, {
        subtaskId, sessionId, role: ledgerRole, turnLabel, terminalEvent: 'result', data: result,
      })
      try {
        return { decision: extractDecision(text, kind).decision }
      } catch (err) {
        lastError = err
        attempt += 1
        if (attempt > this._cfg.maxParseRetries) break
        currentPrompt = buildRepairPrompt(kind, err) // cheap: context is cached
      }
    }
    throw lastError || new DecisionParseError('no_block', 'exhausted parse retries')
  }

  // --- session spawn/teardown ---------------------------------------------

  _spawnSession(run, { role, subtaskId = null }) {
    const spec = role === 'architect' ? run.roleModels.architect : run.roleModels.worker
    const preamble = role === 'architect' ? architectPreamble()
      : role === 'implement' ? implementWorkerPreamble()
      : auditWorkerPreamble()
    const opts = {
      name: `orch:${run.runId}:${role}${subtaskId ? `:${subtaskId}` : ''}`,
      cwd: run.cwd,
      provider: spec.provider,
      model: spec.model,
      // implement workers accept their own edits (path confinement comes from the
      // OS sandbox, NOT permission rules); everyone else prompts (gate answers).
      permissionMode: role === 'implement' ? 'acceptEdits' : 'approve',
      sessionPreamble: preamble,
      metadata: { orchestrationRunId: run.runId, orchestrationRole: role === 'architect' ? 'architect' : `worker.${role}` },
    }
    if (role === 'implement') {
      // Fail-closed: the write jail is codex-only in v1 (#6735). createRun already
      // gates this, but hard-assert at the spawn choke point so any future path
      // that produced a non-codex implement role aborts loudly rather than
      // spawning an UNSANDBOXED write worker (acceptEdits does not confine paths).
      if (spec.provider !== 'codex') throw new Error(`implement worker requires a codex provider (write jail is codex-only in v1); got '${spec.provider}'`)
      // Isolated write worktree + the OS write jail.
      opts.worktree = true
      opts.codexSandbox = 'workspace-write'
    } else if (spec.provider === 'codex') {
      opts.codexSandbox = 'read-only' // architect + audit are read-only (#6690)
    }
    const sessionId = this._sm.createSession(opts)
    return sessionId
  }

  // The isolated worktree dir SessionManager created for a worktree:true session.
  _workerWorktreePath(sessionId) {
    const entry = this._sm.getSession?.(sessionId)
    return entry?.worktreePath || entry?.session?.worktreePath || null
  }

  _applyReadOnlyRules(sessionId) {
    const session = this._sm.getSession?.(sessionId)?.session
    if (session && typeof session.setPermissionRules === 'function') {
      session.setPermissionRules([
        { tool: 'Read', decision: 'allow' }, { tool: 'Glob', decision: 'allow' }, { tool: 'Grep', decision: 'allow' },
        { tool: 'Write', decision: 'deny' }, { tool: 'Edit', decision: 'deny' }, { tool: 'NotebookEdit', decision: 'deny' }, { tool: 'apply_patch', decision: 'deny' },
      ])
    }
  }

  // The single teardown choke point. For an implement worker, auto-commit its
  // worktree FIRST — destroySession removes the worktree, which would delete
  // uncommitted work. This covers every release path (accept, finish, escalate,
  // redelegate, fail, cancel) at one site.
  async _destroySession(run, sessionId) {
    if (!sessionId) return
    const meta = run.ownedSessions.get(sessionId)
    if (meta?.role === 'implement' && meta.subtaskId) {
      const st = run.subtasks.get(meta.subtaskId)
      const worktreePath = st?.worktreePath || this._workerWorktreePath(sessionId)
      if (worktreePath) {
        try { await this._gitOps.autoCommit({ worktreePath, subtaskId: meta.subtaskId }) }
        catch (err) { this._log?.warn?.(`orchestration: auto-commit before destroy failed for ${sessionId}: ${err?.message || err}`) }
      }
    }
    run.ownedSessions.delete(sessionId)
    try { this._sm.destroySession?.(sessionId) } catch { /* best-effort */ }
  }

  // --- helpers -------------------------------------------------------------

  _openGate(run, { kind, nodeId = null, summary, detail = null, budgetUsd = null }) {
    const gate = makeGate({ gateId: nextGateId(run.runId), runId: run.runId, kind, nodeId, summary, detail, budgetUsd, openedAt: this._now() })
    run.gates.set(gate.gateId, gate)
    this._appendTimeline(run, { kind: 'gate_opened', gateId: gate.gateId, nodeId, summary })
    return gate
  }

  // Append a bounded activity-feed entry (projected to RunTimelineEntry by to-wire).
  _appendTimeline(run, { kind, summary, nodeId = null, gateId = null, verdict = null, detail = null }) {
    run.timelineSeq += 1
    run.timeline.push({ seq: run.timelineSeq, at: this._now(), kind, summary, nodeId, gateId, verdict, detail })
    if (run.timeline.length > 500) run.timeline.splice(0, run.timeline.length - 500)
  }

  // Build + emit a wire `orchestration_run_delta` for host-level clients (the
  // daemon forwards it to WsServer._broadcastOrchestrationDelta). Carries the
  // updated run header (RunSummary) + the changed gate. `wireSeq` is bumped per
  // emit; a gap self-heals via the client re-requesting the full snapshot (the
  // reducer applies a delta only when seq === held + 1). No-op for a gone run.
  _emitRunDelta(run, { gate = null } = {}) {
    const record = this._ledger.getRun(run.runId)
    if (!record) return
    run.wireSeq += 1
    const delta = {
      type: 'orchestration_run_delta',
      runId: run.runId,
      seq: run.wireSeq,
      generatedAt: new Date(this._now()).toISOString(),
      run: recordToRunSummary(record, this._snapshotExtras(run)),
    }
    if (gate) delta.gate = gateToWire(gate)
    this.emit('run_delta', delta)
  }

  _pauseForBudget(run) {
    run.phase = 'budget_paused'
    this._ledger.setStatus(run.runId, 'budget_paused')
    this.emit('run_budget_paused', { runId: run.runId })
    this._emitRunDelta(run)
  }

  _onPermissionEscalation(info) {
    const run = this._runForSession(info.sessionId)
    if (!run) return
    this.emit('permission_escalation', { runId: run.runId, ...info })
  }

  async _failRun(run, code, err) {
    // A cancel that already tore the run down wins: don't overwrite the
    // terminal 'cancelled' status with 'failed' (or double-emit lifecycle
    // events) when an in-flight turn rejects SESSION_GONE on the next tick.
    if (run.cancelled || !this._runs.has(run.runId)) return { runId: run.runId, phase: run.phase }
    run.phase = 'failed'
    this._ledger.setStatus(run.runId, 'failed', code)
    // tear down any owned sessions (auto-commits implement worktrees first)
    for (const sid of [...run.ownedSessions.keys()]) await this._destroySession(run, sid)
    await this._cleanupIntegration(run)
    this.emit('run_failed', { runId: run.runId, code, message: err?.message || String(err) })
    this._emitRunDelta(run)
    this._cacheCompletedSnapshot(run)
    this._runs.delete(run.runId)
    return { runId: run.runId, phase: 'failed', code }
  }

  async cancelRun(runId, { reason = 'user' } = {}) {
    const run = this._runs.get(runId)
    if (!run) return null
    run.cancelled = true
    // interrupt every in-flight owned session, then release (auto-commit → destroy)
    // so no implement worker's uncommitted work is lost.
    for (const sid of [...run.ownedSessions.keys()]) {
      try { this._sm.getSession?.(sid)?.session?.interrupt?.() } catch { /* ignore */ }
    }
    for (const sid of [...run.ownedSessions.keys()]) await this._destroySession(run, sid)
    await this._cleanupIntegration(run)
    this._ledger.setStatus(runId, 'cancelled', reason)
    this.emit('run_cancelled', { runId, reason })
    this._emitRunDelta(run)
    this._cacheCompletedSnapshot(run)
    this._runs.delete(runId)
    return { runId, phase: 'cancelled' }
  }

  // Remove the run's integration WORKTREE (orchestrator-owned, under the
  // worktrees root). The integration BRANCH is KEPT — it is the run's output.
  async _cleanupIntegration(run) {
    if (!run.integration?.worktreePath) return
    try {
      await this._gitOps.removeWorktree({ repoDir: run.cwd, worktreePath: run.integration.worktreePath })
      await this._gitOps.pruneWorktrees(run.cwd)
    } catch (err) { this._log?.warn?.(`orchestration: integration cleanup failed: ${err?.message || err}`) }
    run.integration = null
  }

  _get(runId) {
    const run = this._runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    return run
  }
  _isOwnedSession(sessionId) {
    for (const run of this._runs.values()) if (run.ownedSessions.has(sessionId)) return true
    return false
  }
  _roleClassForSession(sessionId) {
    // The gate policy per owned session:
    //  - implement/fixup → 'implement' (Bash matched against the allowlist; else escalate)
    //  - architect/audit → 'audit' (read-only; reads are rule-allowed and never
    //    reach the gate, anything else is denied). The architect maps to 'audit'
    //    rather than null so the gate answers (denies) it instead of IGNORING it
    //    and wedging a stray tool until the turn watchdog fires.
    for (const run of this._runs.values()) {
      const meta = run.ownedSessions.get(sessionId)
      if (meta) return (meta.role === 'implement' || meta.role === 'fixup') ? 'implement' : 'audit'
    }
    return null
  }
  _runForSession(sessionId) {
    for (const run of this._runs.values()) if (run.ownedSessions.has(sessionId)) return run
    return null
  }
  _activeWorkerCount(run) {
    let n = 0
    for (const s of run.subtasks.values()) if (s.state === 'active') n += 1
    return n
  }
  _sessionHeadroom() {
    const size = typeof this._sm.listSessions === 'function' ? this._sm.listSessions().length : this._sm._sessions?.size ?? 0
    // Room to spawn ONE more session while still leaving reserveSessions slots
    // free — strict, so the reserve is preserved AFTER the new session exists.
    return size + 1 <= this._maxSessions - this._cfg.reserveSessions
  }

  // --- read API (consumed by the S-2 handlers) — wire-projected via to-wire ---

  // RunSummary[] for the runs list. Active runs use their live engine extras (so
  // pendingUserGates is accurate); a terminal run whose engine state is gone
  // uses its cached final snapshot, else projects from the record alone.
  listRuns() {
    // The ledger index gives ordering (newest first) + the run ids; project each
    // from its full record so the summary is complete.
    return this._ledger.listRuns().map((row) => {
      const record = this._ledger.getRun(row.runId)
      if (!record) return null
      const run = this._runs.get(row.runId)
      if (run) return recordToRunSummary(record, this._snapshotExtras(run))
      const cached = this._completedSnapshots.get(row.runId)
      // cached.summary (a lean RunSummary) — NOT cached.run (a fat RunDetail):
      // the runs list must stay lightweight (RunSummarySchema is .passthrough(),
      // so a RunDetail would silently balloon every terminal row with its
      // nodes/timeline/rollup).
      return cached ? cached.summary : recordToRunSummary(record, { report: this._reportExtra(row.runId) })
    }).filter(Boolean)
  }

  // { seq, run: RunDetail } for one run.
  getRunSnapshot(runId) {
    const run = this._runs.get(runId)
    if (run) {
      const record = this._ledger.getRun(runId)
      if (!record) return null
      return { seq: run.wireSeq, run: recordToRunDetail(record, this._snapshotExtras(run)) }
    }
    const cached = this._completedSnapshots.get(runId)
    if (cached) return cached
    const record = this._ledger.getRun(runId)
    if (!record) return null
    return { seq: 0, run: recordToRunDetail(record, { report: this._reportExtra(runId) }) }
  }

  // Assemble the projection `extras` bag from a run's live engine state.
  _snapshotExtras(run) {
    const nodeExtras = {}
    for (const [subtaskId, st] of run.subtasks) {
      nodeExtras[subtaskId] = {
        branch: st.branch ?? null,
        worktreePath: st.worktreePath ?? null,
        planSummary: st.poa?.plan ?? null,
        resultSummary: st.result?.summary ?? null,
        attempt: st.iterations ?? 0,
        committeeIterations: st.iterations ?? 0,
      }
    }
    return {
      epicPrompt: run.goal ?? '',
      gates: [...run.gates.values()],
      timeline: run.timeline,
      nodeExtras,
      report: this._reportExtra(run.runId),
    }
  }

  // The report artifacts for a run, in preference order: the in-memory docs
  // (built at completion / re-annotation), then the persisted report.{json,md}
  // (a restarted daemon), then the bare synthesis narrative (legacy fallback).
  _reportExtra(runId) {
    const docs = this._reportDocs.get(runId)
    if (docs) return docs
    const persisted = this._ledger.readReport?.(runId)
    if (persisted) return persisted
    const md = this._reports.get(runId)
    return md ? { json: '', markdown: md } : null
  }

  // M-4: derive the metrics report from the ledger record, prepend the
  // architect's synthesis narrative, persist report.{json,md}, and keep the
  // docs in memory for snapshots. Never throws (derived state; the journal is
  // ground truth and the report can be regenerated).
  _buildAndPersistReport(runId) {
    try {
      const record = this._ledger.getRun(runId)
      if (!record) return null
      const narrative = this._reports.get(runId) ?? null
      const report = buildRunReport(record)
      report.synthesis = narrative
      const markdown = (narrative ? `${narrative}\n\n---\n\n` : '') + renderReportMarkdown(report)
      const json = JSON.stringify(report, null, 2)
      this._ledger.writeReport(runId, { json, markdown })
      this._reportDocs.set(runId, { json, markdown })
      while (this._reportDocs.size > this._maxReports) {
        this._reportDocs.delete(this._reportDocs.keys().next().value)
      }
      return { json, markdown }
    } catch (err) {
      this._log?.warn?.(`orchestration: report generation failed for ${runId}: ${err?.message || err}`)
      return null
    }
  }

  // M-4 (#6701): annotate a run for the dogfood measurement — attach the
  // monolithic-baseline session's usage and/or a verdict-quality note. Works on
  // live AND terminal runs (operates via the ledger, not engine state); on a
  // terminal run the persisted report + frozen snapshot are refreshed.
  async annotate(runId, { baselineSessionId = null, verdictQuality = undefined } = {}) {
    const record = this._ledger.getRun(runId)
    if (!record) {
      const err = new Error(`run ${runId} not found`)
      err.code = 'RUN_NOT_FOUND'
      throw err
    }
    if (verdictQuality !== undefined) this._ledger.note(runId, { verdictQuality })
    if (baselineSessionId) {
      const entry = this._sm.getSession?.(baselineSessionId)
      if (!entry) {
        const err = new Error(`baseline session ${baselineSessionId} not found`)
        err.code = 'BASELINE_SESSION_NOT_FOUND'
        throw err
      }
      const u = entry.cumulativeUsage || {}
      this._ledger.setBaseline(runId, {
        sessionId: baselineSessionId,
        // a plain session's spend signal is its provider-reported cumulative cost
        effectiveUsd: Number.isFinite(u.costUsd) ? u.costUsd : 0,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens, cacheCreationTokens: u.cacheCreationTokens,
      })
    }
    // refresh derived artifacts for a terminal run (a live run rebuilds at completion)
    if (!this._runs.has(runId)) {
      const docs = this._buildAndPersistReport(runId)
      const cached = this._completedSnapshots.get(runId)
      if (cached) {
        const fresh = this._ledger.getRun(runId)
        if (Number.isFinite(fresh?.baseline?.effectiveUsd)) cached.run.baselineEffectiveUsd = fresh.baseline.effectiveUsd
        if (fresh?.notes?.verdictQuality != null) cached.run.verdictQuality = fresh.notes.verdictQuality
        if (docs) cached.run.report = docs
      }
    }
    return { runId, annotated: true }
  }

  // On terminal, freeze BOTH the detail (for getRunSnapshot) and the summary
  // (for the lightweight runs list) so the snapshot survives the run's engine
  // state being deleted from _runs. Never throws: a projection failure must not
  // skip the caller's _runs.delete (a leaked run wedges createRun's one-run-at-
  // a-time guard for the process lifetime).
  _cacheCompletedSnapshot(run) {
    try {
      const record = this._ledger.getRun(run.runId)
      if (!record) return
      const extras = this._snapshotExtras(run)
      this._completedSnapshots.set(run.runId, {
        seq: run.wireSeq,
        run: recordToRunDetail(record, extras),
        summary: recordToRunSummary(record, extras),
      })
      while (this._completedSnapshots.size > this._maxCompletedSnapshots) {
        this._completedSnapshots.delete(this._completedSnapshots.keys().next().value)
      }
    } catch (err) {
      this._log?.warn?.(`orchestration: caching terminal snapshot failed for ${run.runId}: ${err?.message || err}`)
    }
  }

  _rememberReport(runId, markdown) {
    this._reports.set(runId, markdown)
    while (this._reports.size > this._maxReports) {
      const oldest = this._reports.keys().next().value
      this._reports.delete(oldest)
    }
  }
}
