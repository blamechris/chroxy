// #5617 — isolated unit tests for the FormDriver collaborator.
//
// Before #5617 the interactive-form driver was mixed onto ClaudeTuiSession.prototype,
// so respondToQuestion could only be exercised through a full session (PTY, term,
// timers, real provider). FormDriver is now an injected collaborator that reaches
// everything through its `host`, so these tests drive the empirically-pinned
// keystroke logic against a MOCK host — no live PTY — and assert exactly which
// bytes get written. This is the testability the audit (#5617) asked for.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FormDriver } from '../src/claude-tui/form-driver.js'

/**
 * Build a mock FormDriverHost that records the PTY writes + watchdog arms and
 * stands in for the session state FormDriver reads. Only the surface the driver
 * actually touches is implemented (the @typedef FormDriverHost in form-driver.js).
 */
function makeMockHost(overrides = {}) {
  const writes = []          // _writePtyTextThrottled payloads
  const multiSeqs = []       // _writePtyMultiQuestionSequence payloads
  const arrowNavs = []       // _writePtyArrowNavSequence indices
  const arms = []            // _armAskUserQuestionWatchdog (toolUseId, ms?)
  const cleared = []         // _clearPendingAnswerByToolUseId ids
  const host = {
    _pendingUserAnswers: new Map(),
    _term: {},               // truthy = a live PTY
    _destroying: false,
    _activeTurn: { hexDumpEmitted: false, aborted: false, messageId: 'm1' },
    _log: { info() {}, warn() {} },
    _outputTailHexDump: () => '',
    _writePtyTextThrottled: (t) => { writes.push(t); return Promise.resolve(true) },
    _writePtyMultiQuestionSequence: (seq) => { multiSeqs.push(seq); return Promise.resolve(true) },
    _writePtyArrowNavSequence: (idx) => { arrowNavs.push(idx); return Promise.resolve(true) },
    _armAskUserQuestionWatchdog: (id, ms) => { arms.push({ id, ms }) },
    _clearPendingAnswerByToolUseId: (id) => { cleared.push(id) },
    // Back-compat getter: most-recently-set entry (the no-toolUseId path).
    get _pendingUserAnswer() {
      const vals = [...host._pendingUserAnswers.values()]
      return vals.length ? vals[vals.length - 1] : null
    },
    ...overrides,
  }
  host._writes = writes
  host._multiSeqs = multiSeqs
  host._arrowNavs = arrowNavs
  host._arms = arms
  host._cleared = cleared
  return host
}

function seedSingle(host, toolUseId, optionLabels) {
  host._pendingUserAnswers.set(toolUseId, {
    toolUseId,
    questions: [{ question: 'Pick one' }],
    options: optionLabels.map((label) => ({ label })),
  })
}

// A single multiSelect question — denied at the permission hook (#5771), so the
// driver should never see it in production. Used to assert the defense-in-depth
// refusal guard in respondToQuestion.
function seedSingleMultiSelect(host, toolUseId, optionLabels) {
  const options = optionLabels.map((label) => ({ label, value: label }))
  host._pendingUserAnswers.set(toolUseId, {
    toolUseId,
    questions: [{ question: 'Pick toppings', options, multiSelect: true }],
    options,
  })
}

describe('FormDriver — injected collaborator (#5617)', () => {
  it('single-question: writes the 1-indexed digit for a matched option', () => {
    const host = makeMockHost()
    seedSingle(host, 't1', ['Alpha', 'Bravo', 'Charlie'])
    const fd = new FormDriver(host)

    fd.respondToQuestion('Charlie', undefined, 't1')

    // #4290 — matched label → its 1-indexed TUI hotkey digit, not the label text.
    assert.deepEqual(host._writes, ['3'])
    assert.deepEqual(host._cleared, ['t1'], 'only the answered entry is cleared')
  })

  it('single-question: arms the stall watchdog for the pending entry', () => {
    const host = makeMockHost()
    seedSingle(host, 't1', ['Yes', 'No'])
    const fd = new FormDriver(host)

    fd.respondToQuestion('No', undefined, 't1')

    assert.deepEqual(host._writes, ['2'])
    assert.ok(host._arms.some((a) => a.id === 't1'), 'watchdog armed for t1')
  })

  it('single multi-select: refuses to drive keystrokes and tears the turn down (#5771)', () => {
    // multiSelect is denied at the permission hook (claude TUI is keyboard-only
    // with no reliable multi-toggle+submit sequence — 0/7 production, swarm
    // audit 2026-06-13). The driver is the defense-in-depth backstop: if a
    // multiSelect entry reaches it anyway, it must NOT write a wrong single
    // digit — it tears the turn down so the dashboard recovers immediately.
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Mushroom', 'Onion', 'Pepper'])
    const fd = new FormDriver(host)
    // Spy on teardown (its internals are covered by the session tests); here we
    // assert only the routing decision: refuse + tear down with the right code.
    const tornDown = []
    fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

    // The dashboard would send an empty text + an answers map for a checkbox
    // form; either way the guard fires on the entry's multiSelect flag.
    fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')

    assert.deepEqual(host._writes, [], 'no single-digit throttled write')
    assert.deepEqual(host._multiSeqs, [], 'no multi-question keystroke sequence')
    assert.equal(tornDown.length, 1, 'tore the turn down exactly once')
    assert.equal(tornDown[0].id, 't1')
    assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED')
  })

  it('single-question: an unmatched label falls through to the literal text', () => {
    const host = makeMockHost()
    seedSingle(host, 't1', ['Yes', 'No'])
    const fd = new FormDriver(host)

    // The dashboard "Other"/freeform back-compat path types the answer literally.
    fd.respondToQuestion('Maybe later', undefined, 't1')

    assert.deepEqual(host._writes, ['Maybe later'])
  })

  it('drops a stale toolUseId with no matching pending entry — no PTY write', () => {
    const host = makeMockHost()
    seedSingle(host, 't1', ['A', 'B'])
    const fd = new FormDriver(host)

    fd.respondToQuestion('A', undefined, 'gone-tool-id')

    assert.deepEqual(host._writes, [], 'no keystrokes written into a foreign form')
    assert.deepEqual(host._cleared, [], 'nothing cleared')
  })

  it('no pending entries at all → no-op (no write, no watchdog)', () => {
    const host = makeMockHost()
    const fd = new FormDriver(host)

    fd.respondToQuestion('A', undefined, undefined)

    assert.deepEqual(host._writes, [])
    assert.deepEqual(host._arms, [])
  })

  it('does not write when the host has no live PTY (_term null)', () => {
    const host = makeMockHost({ _term: null })
    seedSingle(host, 't1', ['A', 'B'])
    const fd = new FormDriver(host)

    fd.respondToQuestion('A', undefined, 't1')

    // Arms the watchdog (so the turn recovers) but writes nothing.
    assert.deepEqual(host._writes, [])
    assert.ok(host._arms.some((a) => a.id === 't1'))
  })
})
