/**
 * RunLedger — durable per-run store for the orchestration harness (epic #6691,
 * step M-2). Owns disk layout, the seq'd append journal (crash ground truth),
 * debounced run.json snapshots, crash recovery, and LRU GC. All mutation logic
 * lives in the pure reducer (run-record.js); this file is I/O + orchestration.
 *
 * Layout under `baseDir` (the engine passes CHROXY_CONFIG_DIR/.chroxy/orchestration;
 * tests ALWAYS pass a temp dir — the same sandbox discipline as stateFilePath):
 *   runs-index.json                 bounded index (LRU, maxRuns)
 *   runs/<runId>/run.json           debounced atomic snapshot (authoritative)
 *   runs/<runId>/events.jsonl       append-only journal (replayed on recovery)
 *   runs/<runId>/report.{json,md}   written at terminal state (M-4)
 *
 * Durability boundary (mirrors #5309): the journal is appended synchronously
 * per event and is the crash record; run.json is debounced for high-frequency
 * turn_usage folds and flushed (fsync) immediately on lifecycle mutations and
 * at terminal state. On boot, recoverRuns() replays journal lines with
 * seq > snapshot.lastSeq through the reducer, so a crash between an append and
 * the debounced save loses nothing.
 */

import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { loadJsonState, saveJsonState } from '../json-state-file.js'
import { applyEvent, makeRunRecord, isTerminalStatus } from './run-record.js'
import { evaluateBudget } from './run-budget.js'
import { createLogger } from '../logger.js'

const log = createLogger('run-ledger')

export const DEFAULT_SAVE_DEBOUNCE_MS = 2000
export const DEFAULT_MAX_RUNS = 200
export const DEFAULT_MAX_JOURNAL_MB = 50
const COMMITTEE_BODY_MAX = 32 * 1024 // per-line committee_review body cap
const INDEX_VERSION = 1

export class RunLedger extends EventEmitter {
  /**
   * @param {{
   *   baseDir: string,
   *   saveDebounceMs?: number,
   *   maxRuns?: number,
   *   maxJournalMb?: number,
   *   now?: () => number,
   *   priceTurn?: (arg: { provider: string|null, model: string|null, usage: object }) => number|null,
   * }} opts
   */
  constructor(opts = {}) {
    super()
    if (!opts.baseDir || typeof opts.baseDir !== 'string') {
      throw new Error('RunLedger requires an explicit baseDir')
    }
    this._baseDir = opts.baseDir
    this._runsDir = join(this._baseDir, 'runs')
    this._indexPath = join(this._baseDir, 'runs-index.json')
    this._saveDebounceMs = Number.isFinite(opts.saveDebounceMs) && opts.saveDebounceMs >= 0
      ? opts.saveDebounceMs
      : DEFAULT_SAVE_DEBOUNCE_MS
    this._maxRuns = Number.isFinite(opts.maxRuns) && opts.maxRuns > 0 ? Math.floor(opts.maxRuns) : DEFAULT_MAX_RUNS
    this._maxJournalBytes = (Number.isFinite(opts.maxJournalMb) && opts.maxJournalMb > 0
      ? opts.maxJournalMb : DEFAULT_MAX_JOURNAL_MB) * 1024 * 1024
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this._priceTurn = typeof opts.priceTurn === 'function' ? opts.priceTurn : defaultPriceTurn
    this._records = new Map()
    this._journalBytes = new Map() // runId -> approx journal size
    this._dirty = new Set()
    this._saveTimer = null
    this._disposed = false
  }

  // -- paths ----------------------------------------------------------------

  _runDir(runId) { return join(this._runsDir, runId) }
  _snapshotPath(runId) { return join(this._runDir(runId), 'run.json') }
  _journalPath(runId) { return join(this._runDir(runId), 'events.jsonl') }

  // -- the single write path ------------------------------------------------

  /**
   * Journal one event, apply it to the in-memory record, and persist. Lifecycle
   * events flush (fsync) immediately; high-frequency folds are debounced.
   * The journal append happens BEFORE the snapshot save so it is always the
   * furthest-ahead record.
   */
  _emitEvent(runId, payload, { lifecycle = false } = {}) {
    const record = this._records.get(runId)
    if (!record) return null
    const seq = record.lastSeq + 1
    const event = { seq, ts: this._now(), ...payload }
    const line = JSON.stringify(event) + '\n'
    try {
      appendFileSync(this._journalPath(runId), line)
      this._journalBytes.set(runId, (this._journalBytes.get(runId) || 0) + Buffer.byteLength(line))
    } catch (err) {
      // A journal write failure is serious but must not crash the daemon; the
      // in-memory record still advances so the run continues, and the next
      // snapshot save captures state (at the cost of a recovery gap).
      log.warn(`journal append failed for ${runId} (${err?.code || err?.message})`)
    }
    applyEvent(record, event)
    if (lifecycle) {
      this._flushNow(runId)
      this._updateIndex()
    } else {
      this._scheduleSave(runId)
    }
    return event
  }

  _scheduleSave(runId) {
    this._dirty.add(runId)
    if (this._saveTimer || this._disposed) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this.flush()
    }, this._saveDebounceMs)
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref()
  }

  _saveSnapshot(runId, { fsync = false } = {}) {
    const record = this._records.get(runId)
    if (!record) return
    try {
      saveJsonState(this._snapshotPath(runId), record, { fsync })
      this._dirty.delete(runId)
    } catch (err) {
      log.warn(`snapshot save failed for ${runId} (${err?.code || err?.message})`)
    }
  }

  _flushNow(runId) {
    this._saveSnapshot(runId, { fsync: true })
  }

  /** Persist every dirty run's snapshot (best-effort, non-fsync). Called by the
   *  debounce timer and by dispose/shutdown. */
  flush() {
    for (const runId of [...this._dirty]) this._saveSnapshot(runId, { fsync: false })
  }

  _updateIndex() {
    const runs = [...this._records.values()]
      .map((r) => ({
        runId: r.runId,
        title: r.title,
        preset: r.preset,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        effectiveUsd: r.usageTotals.overall.effectiveUsd,
        terminal: isTerminalStatus(r.status),
      }))
      .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
    this._gc(runs)
    try {
      saveJsonState(this._indexPath, { version: INDEX_VERSION, runs }, { fsync: true })
    } catch (err) {
      log.warn(`index save failed (${err?.code || err?.message})`)
    }
  }

  /** LRU-evict terminal runs beyond maxRuns: drop from the index list AND rm
   *  their directory + in-memory record. Non-terminal runs are never evicted. */
  _gc(runs) {
    if (runs.length <= this._maxRuns) return
    const evictable = runs.filter((r) => r.terminal)
    const keep = runs.length - this._maxRuns
    const toEvict = evictable.slice(evictable.length - Math.min(keep, evictable.length))
    for (const r of toEvict) {
      const i = runs.indexOf(r)
      if (i >= 0) runs.splice(i, 1)
      this._records.delete(r.runId)
      this._journalBytes.delete(r.runId)
      this._dirty.delete(r.runId)
      try { rmSync(this._runDir(r.runId), { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }

  // -- public API -----------------------------------------------------------

  createRun({ title = '', preset = null, configSnapshot = null } = {}) {
    const runId = `run_${this._now()}_${randomBytes(4).toString('hex')}`
    const record = makeRunRecord({ runId })
    this._records.set(runId, record)
    this._journalBytes.set(runId, 0)
    mkdirSync(this._runDir(runId), { recursive: true, mode: 0o700 })
    this._emitEvent(runId, { type: 'run_created', title, preset, configSnapshot }, { lifecycle: true })
    return this.getRun(runId)
  }

  setStatus(runId, status, reason = null) {
    this._emitEvent(runId, { type: 'run_status_changed', status, reason }, { lifecycle: true })
    return this.getRun(runId)
  }

  createSubtask(runId, { subtaskId, parentId = null, role, title = '' }) {
    this._emitEvent(runId, { type: 'subtask_created', subtaskId, parentId, role, title }, { lifecycle: true })
  }

  updateSubtask(runId, subtaskId, { status }) {
    this._emitEvent(runId, { type: 'subtask_updated', subtaskId, status }, { lifecycle: true })
  }

  attachSession(runId, subtaskId, { sessionId, provider, model, meterable = true }) {
    this._emitEvent(runId, { type: 'session_attached', subtaskId, sessionId, provider, model, meterable }, { lifecycle: true })
  }

  /**
   * Fold one turn's usage. `data` is the provider terminal (result/error)
   * payload (cost, usage snake_case, modelUsage, numTurns, duration,
   * apiDurationMs). The ledger prices cost:null turns via priceTurn — the
   * "ledger owns money math" rule. Debounced (high-frequency).
   */
  recordTurnUsage(runId, { subtaskId = null, sessionId = null, role = null, turnLabel = null, terminalEvent = 'result', data = {} }) {
    const record = this._records.get(runId)
    if (!record) return null
    const st = subtaskId ? record.subtasks.find((s) => s.subtaskId === subtaskId) : null
    const provider = st?.provider ?? null
    const modelRaw = data.model ?? (data.modelUsage ? Object.keys(data.modelUsage)[0] : null) ?? st?.model ?? null
    const meterable = st ? st.meterable !== false : true
    const cost = Number.isFinite(data.cost) ? data.cost : null
    let pricedCostUsd = null
    if (cost == null && data.usage) {
      const p = this._priceTurn({ provider, model: modelRaw, usage: data.usage })
      if (Number.isFinite(p)) pricedCostUsd = p
    }
    const event = this._emitEvent(runId, {
      type: 'turn_usage',
      subtaskId,
      sessionId,
      role,
      model: modelRaw,
      modelRaw,
      terminalEvent,
      turnLabel,
      cost,
      pricedCostUsd,
      usage: data.usage ?? null,
      modelUsage: data.modelUsage ?? null,
      numTurns: Number.isFinite(data.numTurns) ? data.numTurns : null,
      durationMs: Number.isFinite(data.duration) ? data.duration : null,
      apiDurationMs: Number.isFinite(data.apiDurationMs) ? data.apiDurationMs : null,
      meterable,
    })
    this.emit('run_usage_updated', { runId, usageTotals: record.usageTotals })
    const budget = this.evaluateBudget(runId, { role })
    return { cell: st ? st.usage : record.usageTotals.overall, event, budget }
  }

  /**
   * Evaluate the run's soft budget against current totals. Pure read PLUS the
   * one-shot latch side effects: the first warn/cap crossing journals a
   * budget_warning / budget_cap_reached (which stamps the latch via applyEvent,
   * so it survives recovery) and emits a run_budget_warning / run_budget_cap_reached
   * event for the engine to relay. Returns the BudgetEval. Uncapped runs
   * (maxUsd null) are always ok and fire nothing.
   */
  evaluateBudget(runId, { role = null } = {}) {
    const record = this._records.get(runId)
    if (!record) return null
    const budget = record.configSnapshot?.budget ?? null
    const evalResult = evaluateBudget({
      budget,
      budgetState: record.budgetState,
      totals: record.usageTotals.overall,
      meteringGaps: record.meteringGaps,
      role,
    })
    if (evalResult.justWarned) {
      this._emitEvent(runId, { type: 'budget_warning', role }, { lifecycle: true })
      this.emit('run_budget_warning', { runId, ...evalResult })
    }
    if (evalResult.justExceeded) {
      this._emitEvent(runId, { type: 'budget_cap_reached', role }, { lifecycle: true })
      this.emit('run_budget_cap_reached', { runId, ...evalResult })
    }
    return evalResult
  }

  /**
   * Raise/lower the run's budget mid-flight. Journals budget_updated (frozen
   * configSnapshot's budget is the one mutable field); if the change lifts a
   * previously-capped run back under the cap, journals budget_lifted (keeping
   * capReachedAt for history). Returns the fresh BudgetEval.
   */
  setBudget(runId, patch = {}) {
    const record = this._records.get(runId)
    if (!record) return null
    // No-op on an empty patch — don't burn a lifecycle fsync for nothing.
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return this.evaluateBudget(runId)
    }
    const wasCapped = evaluateBudget({
      budget: record.configSnapshot?.budget ?? null,
      budgetState: record.budgetState,
      totals: record.usageTotals.overall,
    }).level === 'capped'
    const nextBudget = { ...(record.configSnapshot?.budget ?? {}), ...patch }
    this._emitEvent(runId, { type: 'budget_updated', budget: nextBudget }, { lifecycle: true })
    const evalResult = this.evaluateBudget(runId)
    // Re-arm on a RAISE that un-caps (budget_lifted clears the latches). A
    // lower-into-cap keeps wasCapped false here, so it re-fires cap normally.
    if (wasCapped && evalResult.level !== 'capped') {
      this._emitEvent(runId, { type: 'budget_lifted' }, { lifecycle: true })
    }
    return evalResult
  }

  /** Audit line: the engine refused a delegation because the run is capped. */
  recordDelegationBlocked(runId, { role = null } = {}) {
    this._emitEvent(runId, { type: 'delegation_blocked_budget', role }, { lifecycle: false })
  }

  recordCommitteeReview(runId, subtaskId, { phase, verdict, reviewerSessionId = null, notes = '' }) {
    // Cap the body; shed bodies entirely once the journal exceeds its size cap
    // (usage lines are always kept — they are the accounting record).
    const overCap = (this._journalBytes.get(runId) || 0) > this._maxJournalBytes
    let body = typeof notes === 'string' ? notes : ''
    let truncated = false
    if (overCap) {
      body = ''
      truncated = true
      this._emitEvent(runId, { type: 'events_dropped', count: 1, reason: 'journal_cap' }, { lifecycle: false })
    } else if (Buffer.byteLength(body, 'utf8') > COMMITTEE_BODY_MAX) {
      // Cap by BYTES (the constant is a byte budget), not UTF-16 code units — a
      // multibyte body could otherwise be ~3-4x over. TextDecoder with
      // stream:true decodes only the COMPLETE codepoints within the budget and
      // holds back a trailing partial sequence (rather than emitting a 3-byte
      // U+FFFD that could push the re-encoded result back over budget), so the
      // result is guaranteed <= COMMITTEE_BODY_MAX bytes and valid JSON.
      const buf = Buffer.from(body, 'utf8').subarray(0, COMMITTEE_BODY_MAX)
      body = new TextDecoder('utf8').decode(buf, { stream: true })
      truncated = true
    }
    this._emitEvent(runId, {
      type: 'committee_review', subtaskId, phase, verdict, reviewerSessionId, notes: body, truncated,
    }, { lifecycle: true })
  }

  note(runId, patch) {
    this._emitEvent(runId, { type: 'run_note', patch }, { lifecycle: true })
  }

  getRun(runId) {
    const r = this._records.get(runId)
    return r ? structuredClone(r) : null
  }

  listRuns() {
    return [...this._records.values()]
      .map((r) => ({
        runId: r.runId, title: r.title, preset: r.preset, status: r.status,
        startedAt: r.startedAt, endedAt: r.endedAt,
        effectiveUsd: r.usageTotals.overall.effectiveUsd,
      }))
      .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
  }

  /**
   * Rebuild in-memory records from disk at boot. For each run dir: load the
   * snapshot, then replay journal lines with seq > snapshot.lastSeq through the
   * reducer (idempotent — lastSeq gates double-folds). Returns the records so
   * the engine can decide which non-terminal runs to fail vs resume.
   */
  recoverRuns() {
    const recovered = []
    if (!existsSync(this._runsDir)) return recovered
    let dirs = []
    try { dirs = readdirSync(this._runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return recovered }
    for (const runId of dirs) {
      const snapshotPath = this._snapshotPath(runId)
      const record = loadJsonState(snapshotPath, () => null, { requireObject: true })
      if (!record || record.runId !== runId) {
        log.warn(`recover: skipping ${runId} (missing/mismatched snapshot)`)
        continue
      }
      const replayFrom = Number.isFinite(record.lastSeq) ? record.lastSeq : 0
      let journalBytes = 0
      const journalPath = this._journalPath(runId)
      if (existsSync(journalPath)) {
        try { journalBytes = statSync(journalPath).size } catch { /* ignore */ }
        let raw = ''
        try { raw = readFileSync(journalPath, 'utf8') } catch { raw = '' }
        for (const lineStr of raw.split('\n')) {
          if (!lineStr) continue
          let ev
          try { ev = JSON.parse(lineStr) } catch { continue }
          if (Number.isFinite(ev?.seq) && ev.seq > replayFrom) applyEvent(record, ev)
        }
      }
      this._records.set(runId, record)
      this._journalBytes.set(runId, journalBytes)
      recovered.push(structuredClone(record))
    }
    return recovered
  }

  dispose() {
    this._disposed = true
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null }
    this.flush()
    this.removeAllListeners()
  }
}

// Default pricing is a no-op (returns null → the turn counts as unknown-cost).
// The engine injects a real `priceTurn` at construction — a thin wrapper over
// models.js `computePromptCostUsd(usage, getModelPricing(resolveModelId(model)))`
// (the Claude static table + ~/.chroxy/models.json overlay, which also covers
// operator-priced codex/gemini). Keeping models.js OUT of the ledger's default
// keeps this module dependency-light and its unit tests free of any config-dir
// / registry I/O; a run with no injected pricer simply reports unpriced tokens
// honestly (unknownCostTurns), never a wrong number.
function defaultPriceTurn() {
  return null
}
