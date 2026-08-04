// Minimal harness for driving the REAL OrchestrationManager in a test — no
// SessionManager, no ~/.chroxy, no provider subprocess (sandbox-guard safe: the
// ledger writes to a temp baseDir).
//
// It exists so a test can exercise a call path against the real engine instead
// of a hand-written fake. A fake that accepts any argument shape is what let
// #7138 ship: the WS handler called `startRun(optionBag)` for months while the
// engine's `startRun(runId)` had never seen that call.
//
// `orchestration-transition-guards.test.js` and `orchestration-manager-implement.test.js`
// each carry their own fuller copy (they wrap the ledger to trace status writes);
// this is the trimmed version for callers that only need a working engine.

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OrchestrationManager } from '../../src/orchestration/orchestration-manager.js'
import { RunLedger } from '../../src/orchestration/run-ledger.js'
import { TurnDriver } from '../../src/orchestration/turn-driver.js'

const KIND_RE = /kind "([a-z_]+)"/

/** Wrap a decision object in the fenced block the turn driver parses. */
export const fenced = (obj) => 'Here is my decision.\n\n```chroxy-decision\n' + JSON.stringify(obj) + '\n```'

/** Deliver a decision for `sessionId` out of band — lets a test land a turn
 *  result at a chosen moment (e.g. while a cancel is tearing the session down). */
export function deliverDecision(sm, sessionId, decision, model = 'fable-hi') {
  sm.emit('session_event', { sessionId, event: 'stream_delta', data: { messageId: 'm1', delta: fenced(decision) } })
  sm.emit('session_event', {
    sessionId, event: 'result',
    data: { model, cost: 0.01, duration: 5, apiDurationMs: 4, numTurns: 1, usage: { input_tokens: 10, output_tokens: 4 } },
  })
}

class FakeSession extends EventEmitter {
  constructor(sessionId, sm, opts, decide, model) {
    super()
    this.sessionId = sessionId
    this._sm = sm
    this.opts = opts
    this._decide = decide
    this._model = model
    this.role = opts.metadata?.orchestrationRole ?? null
    this.destroyed = false
    this.lastKind = null
    this.kindCalls = Object.create(null)
  }
  setPermissionRules() {}
  interrupt() { this.interrupted = true }
  sendMessage(prompt) {
    const m = String(prompt).match(KIND_RE)
    const kind = m ? m[1] : this.lastKind
    this.lastKind = kind
    this.kindCalls[kind] = (this.kindCalls[kind] || 0) + 1
    queueMicrotask(() => {
      if (this.destroyed) return
      const out = this._decide({ role: this.role, kind, n: this.kindCalls[kind] })
      if (out == null) return // sentinel: hang this turn
      this._sm.emit('session_event', { sessionId: this.sessionId, event: 'stream_delta', data: { messageId: 'm1', delta: fenced(out) } })
      this._sm.emit('session_event', {
        sessionId: this.sessionId,
        event: 'result',
        data: { model: this._model, cost: 0.01, duration: 5, apiDurationMs: 4, numTurns: 1, usage: { input_tokens: 10, output_tokens: 4 } },
      })
    })
    return Promise.resolve()
  }
}

class FakeSM extends EventEmitter {
  constructor(decide) {
    super()
    this.setMaxListeners(0)
    this._decide = decide
    this._sessions = new Map()
    this._n = 0
  }
  createSession(opts) {
    const sessionId = `sess_${++this._n}`
    const model = opts.metadata?.orchestrationRole === 'architect' ? 'fable-hi' : 'haiku'
    this._sessions.set(sessionId, new FakeSession(sessionId, this, opts, this._decide, model))
    return sessionId
  }
  getSession(id) { const s = this._sessions.get(id); return s ? { session: s } : null }
  destroySession(id) {
    const s = this._sessions.get(id)
    if (!s) return
    s.destroyed = true
    this._sessions.delete(id)
    this.emit('session_destroyed', { sessionId: id })
  }
  listSessions() { return [...this._sessions.keys()] }
}

export const HARNESS_ROLES = {
  architect: { provider: 'claude-sdk', model: 'fable-hi' },
  auditWorker: { provider: 'claude-sdk', model: 'haiku' },
}

/** An architect that plans one audit subtask and approves everything. */
export function happyDecider({ role, kind }) {
  if (role === 'architect') {
    if (kind === 'epic_plan') return { kind: 'epic_plan', summary: 'One-area audit', subtasks: [{ title: 'Audit auth', goal: 'Review auth', role: 'audit' }] }
    if (kind === 'poa_review') return { kind: 'poa_review', verdict: 'approve' }
    if (kind === 'result_review') return { kind: 'result_review', verdict: 'approve' }
    if (kind === 'synthesis') return { kind: 'synthesis', reportMarkdown: '# Report' }
  }
  if (kind === 'plan_of_attack') return { kind: 'plan_of_attack', plan: 'Read + grep.', summary: 'PoA' }
  if (kind === 'work_result') return { kind: 'work_result', summary: 'Found 2 issues.' }
  throw new Error(`unexpected turn role=${role} kind=${kind}`)
}

export function makeOrchestrationHarness({ decide = happyDecider, roles = HARNESS_ROLES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-harness-'))
  const sm = new FakeSM(decide)
  const ledger = new RunLedger({ baseDir: dir })
  const driver = new TurnDriver({ sessionManager: sm })
  const mgr = new OrchestrationManager({ sessionManager: sm, ledger, turnDriver: driver, roles })
  const cleanup = () => {
    mgr.dispose()
    driver.dispose()
    ledger.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  }
  return { sm, ledger, driver, mgr, cleanup }
}

/** Resolve on the first of `events`; reject on an unexpected `run_failed`. */
export function waitFor(mgr, events, { timeoutMs = 5000 } = {}) {
  const wanted = new Set(events)
  const all = new Set([...wanted, 'run_failed'])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${[...wanted].join('|')}`)) }, timeoutMs)
    const handlers = []
    const off = () => { clearTimeout(timer); for (const [e, h] of handlers) mgr.off(e, h) }
    for (const e of all) {
      const h = (payload) => {
        if (!wanted.has(e)) { off(); reject(new Error(`unexpected ${e}: ${payload?.code ?? ''} ${payload?.message ?? ''}`)); return }
        off(); resolve({ event: e, payload })
      }
      handlers.push([e, h])
      mgr.on(e, h)
    }
  })
}
