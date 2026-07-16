import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function grab(fn) { try { fn(); return null } catch (e) { return e } }
import {
  assertRunTransition,
  assertNodeTransition,
  TransitionError,
  makeGate,
  resolveGate,
  expireGate,
  nextGateId,
  isTerminalRunStatus,
  isTerminalNodeStatus,
} from '../src/orchestration/run-model.js'

// #6691 E-1 — state-machine guards + gate registry.

describe('run transitions', () => {
  it('allows the canonical happy path', () => {
    assert.equal(assertRunTransition('created', 'planning'), true)
    assert.equal(assertRunTransition('planning', 'plan_review'), true)
    assert.equal(assertRunTransition('plan_review', 'executing'), true)
    assert.equal(assertRunTransition('executing', 'synthesizing'), true)
    assert.equal(assertRunTransition('synthesizing', 'completed'), true)
  })
  it('allows cancelling/suspended from any non-terminal state', () => {
    assert.equal(assertRunTransition('executing', 'cancelling'), true)
    assert.equal(assertRunTransition('planning', 'suspended'), true)
  })
  it('rejects illegal + terminal-source transitions', () => {
    assert.throws(() => assertRunTransition('created', 'completed'), TransitionError)
    assert.throws(() => assertRunTransition('completed', 'executing'), TransitionError)
    assert.throws(() => assertRunTransition('executing', 'nonsense'), TransitionError)
    assert.throws(() => assertRunTransition('completed', 'cancelling'), TransitionError) // terminal source
  })
  it('isTerminalRunStatus', () => {
    assert.equal(isTerminalRunStatus('completed'), true)
    assert.equal(isTerminalRunStatus('executing'), false)
  })
})

describe('node (subtask) transitions', () => {
  it('allows the committee loop', () => {
    assert.equal(assertNodeTransition('pending', 'spawning'), true)
    assert.equal(assertNodeTransition('spawning', 'briefing'), true)
    assert.equal(assertNodeTransition('briefing', 'poa_review'), true)
    assert.equal(assertNodeTransition('poa_review', 'executing'), true) // approve
    assert.equal(assertNodeTransition('poa_review', 'briefing'), true) // revise
    assert.equal(assertNodeTransition('result_review', 'merging'), true)
    assert.equal(assertNodeTransition('merging', 'conflict_fixup'), true)
    assert.equal(assertNodeTransition('conflict_fixup', 'merging'), true)
    assert.equal(assertNodeTransition('result_review', 'escalated'), true)
  })
  it('allows cancelled/interrupted from any non-terminal state', () => {
    assert.equal(assertNodeTransition('executing', 'interrupted'), true)
    assert.equal(assertNodeTransition('briefing', 'cancelled'), true)
  })
  it('rejects illegal transitions', () => {
    assert.throws(() => assertNodeTransition('pending', 'merging'), TransitionError)
    assert.throws(() => assertNodeTransition('done', 'executing'), TransitionError)
    assert.throws(() => assertNodeTransition('done', 'interrupted'), TransitionError) // terminal source
  })
  it('isTerminalNodeStatus', () => {
    assert.equal(isTerminalNodeStatus('done'), true)
    assert.equal(isTerminalNodeStatus('escalated'), false)
  })
})

describe('gate registry', () => {
  it('nextGateId is unique per call', () => {
    const a = nextGateId('r1'), b = nextGateId('r1')
    assert.notEqual(a, b)
  })
  it('makeGate rejects an unknown kind', () => {
    assert.throws(() => makeGate({ gateId: 'g', runId: 'r', kind: 'bogus', summary: 's' }))
  })
  it('resolveGate maps decisions to statuses and is a pure copy', () => {
    const g = makeGate({ gateId: 'g1', runId: 'r1', kind: 'epic_plan', summary: 'approve plan', openedAt: 1 })
    const approved = resolveGate(g, { decision: 'approve', resolvedAt: 2 })
    assert.equal(approved.status, 'approved')
    assert.equal(approved.resolvedBy, 'user')
    assert.equal(g.status, 'pending', 'original not mutated')
    assert.equal(resolveGate(g, { decision: 'reject', resolvedAt: 2 }).status, 'rejected')
    assert.equal(resolveGate(g, { decision: 'revise', resolvedAt: 2 }).status, 'revise_requested')
    assert.equal(resolveGate(g, { decision: 'skip', resolvedAt: 2 }).status, 'skipped')
  })
  it('resolveGate carries budgetUsd on an approve-with-raise', () => {
    const g = makeGate({ gateId: 'g1', runId: 'r1', kind: 'budget_overrun', summary: 'over', openedAt: 1 })
    const r = resolveGate(g, { decision: 'approve', budgetUsd: 50, resolvedAt: 2 })
    assert.equal(r.budgetUsd, 50)
  })
  it('resolveGate throws on a double-resolve and on an unknown decision', () => {
    const g = makeGate({ gateId: 'g1', runId: 'r1', kind: 'epic_plan', summary: 's', openedAt: 1 })
    const done = resolveGate(g, { decision: 'approve', resolvedAt: 2 })
    const e = grab(() => resolveGate(done, { decision: 'approve', resolvedAt: 3 }))
    assert.equal(e.code, 'GATE_ALREADY_RESOLVED')
    assert.throws(() => resolveGate(g, { decision: 'bogus' }))
  })
  it('expireGate marks a pending gate expired by policy; resolved gates unchanged', () => {
    const g = makeGate({ gateId: 'g1', runId: 'r1', kind: 'escalation', summary: 's', openedAt: 1 })
    const ex = expireGate(g, { resolvedAt: 9 })
    assert.equal(ex.status, 'expired')
    assert.equal(ex.resolvedBy, 'policy')
    const done = resolveGate(g, { decision: 'approve', resolvedAt: 2 })
    assert.equal(expireGate(done), done, 'already-resolved gate returned unchanged')
  })
})
