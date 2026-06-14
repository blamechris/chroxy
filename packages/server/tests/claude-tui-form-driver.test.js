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
import { FormDriver, formatMultiSelectReinject } from '../src/claude-tui/form-driver.js'

// #5773 — run `fn` with CHROXY_TUI_MULTISELECT_REINJECT forced to `value`,
// restoring the prior value afterward so tests don't leak the flag into each
// other (the driver reads it at call time via multiSelectReinjectEnabled()).
function withReinjectFlag(value, fn) {
  const prev = process.env.CHROXY_TUI_MULTISELECT_REINJECT
  if (value === undefined) delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
  else process.env.CHROXY_TUI_MULTISELECT_REINJECT = value
  try { return fn() } finally {
    if (prev === undefined) delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
    else process.env.CHROXY_TUI_MULTISELECT_REINJECT = prev
  }
}

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
  const wdCleared = []       // #5773 _clearAskUserQuestionWatchdog ids
  const locksCleared = []    // #5773 _clearAskUserQuestionLock calls
  const sent = []            // #5773 sendMessage payloads (reinject)
  const warns = []           // #5773 _log.warn messages
  const errors = []          // #5773 emit('error', ...) payloads from sendMessage guard
  const host = {
    _pendingUserAnswers: new Map(),
    _term: {},               // truthy = a live PTY
    _destroying: false,
    // #5773 — model the real sendMessage busy contract. Defaults idle (false),
    // which is the designed reinject state (model stopped on the deny → Stop hook
    // drained → idle by the time the human answers). Tests flip it to exercise the
    // busy-race guard.
    _isBusy: false,
    _activeTurn: { hexDumpEmitted: false, aborted: false, messageId: 'm1' },
    _log: { info() {}, warn: (m) => warns.push(m) },
    _outputTailHexDump: () => '',
    _writePtyTextThrottled: (t) => { writes.push(t); return Promise.resolve(true) },
    _writePtyMultiQuestionSequence: (seq) => { multiSeqs.push(seq); return Promise.resolve(true) },
    _writePtyArrowNavSequence: (idx) => { arrowNavs.push(idx); return Promise.resolve(true) },
    _armAskUserQuestionWatchdog: (id, ms) => { arms.push({ id, ms }) },
    _clearPendingAnswerByToolUseId: (id) => { cleared.push(id) },
    // #5773 — surface the multi-select reinject path touches on success.
    _clearAskUserQuestionWatchdog: (id) => { wdCleared.push(id) },
    _clearAskUserQuestionLock: () => { locksCleared.push(true) },
    // #5773 — mirror claude-tui-session.js sendMessage's busy guard: when busy it
    // emit('error') + returns WITHOUT sending (and resolves, not rejects), so a
    // .catch can't observe the drop. The form-driver guards on _isBusy before
    // calling, so this stub primarily proves the call is not made when busy.
    sendMessage: (text) => {
      if (host._isBusy) { errors.push('Already processing a message'); return Promise.resolve() }
      sent.push(text); return Promise.resolve()
    },
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
  host._wdCleared = wdCleared
  host._locksCleared = locksCleared
  host._sent = sent
  host._warns = warns
  host._errors = errors
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
    // Pin the flag OFF so an ambient CHROXY_TUI_MULTISELECT_REINJECT can't route
    // this default-behavior assertion down the reinject path.
    withReinjectFlag(undefined, () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.deepEqual(host._writes, [], 'no single-digit throttled write')
    assert.deepEqual(host._multiSeqs, [], 'no multi-question keystroke sequence')
    assert.equal(tornDown.length, 1, 'tore the turn down exactly once')
    assert.equal(tornDown[0].id, 't1')
    assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED')
  })

  it('single multi-select REINJECT (flag on): formats the selection to text and sends a new turn (#5773)', () => {
    // With CHROXY_TUI_MULTISELECT_REINJECT=1 the driver does NOT tear down or
    // drive keystrokes — it formats the picked labels into a plain-text answer
    // and feeds it to claude via sendMessage() as a fresh turn (the denied form
    // never rendered, so there's no live form and no PostToolUse).
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Mushroom', 'Onion', 'Pepper'])
    const fd = new FormDriver(host)
    const tornDown = []
    fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.deepEqual(host._writes, [], 'no single-digit throttled write')
    assert.deepEqual(host._multiSeqs, [], 'no multi-question keystroke sequence')
    assert.equal(tornDown.length, 0, 'reinject does NOT tear the turn down')
    assert.deepEqual(host._sent, ['For "Pick toppings": Cheese, Onion'],
      'sends the label-based answer text as a new turn')
    assert.deepEqual(host._cleared, ['t1'], 'clears the denied pending entry')
    assert.deepEqual(host._wdCleared, ['t1'], 'clears the armed stall watchdog')
    assert.equal(host._locksCleared.length, 1, 'clears the sibling AskUserQuestion lock')
  })

  it('single multi-select REINJECT (flag on): empty selection falls back to teardown (#5773)', () => {
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Mushroom'])
    const fd = new FormDriver(host)
    const tornDown = []
    fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

    withReinjectFlag('1', () => {
      // No matching answersMap key → nothing resolvable → empty formatted text.
      fd.respondToQuestion('', { 'Some other question': ['X'] }, 't1')
    })

    assert.deepEqual(host._sent, [], 'no empty turn is sent')
    assert.equal(tornDown.length, 1, 'recovers via teardown')
    assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTISELECT_EMPTY')
  })

  it('single multi-select: flag OFF still refuses + tears down (default behavior preserved) (#5773)', () => {
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    const tornDown = []
    fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

    withReinjectFlag(undefined, () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.deepEqual(host._sent, [], 'no reinject when the flag is off')
    assert.equal(tornDown.length, 1)
    assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED')
  })

  it('formatMultiSelectReinject: parses array / JSON-string / comma-string into label text (#5773)', () => {
    const questions = [{ question: 'Pick toppings', multiSelect: true }]
    assert.equal(
      formatMultiSelectReinject(questions, { 'Pick toppings': ['Cheese', 'Onion'] }),
      'For "Pick toppings": Cheese, Onion', 'native array')
    assert.equal(
      formatMultiSelectReinject(questions, { 'Pick toppings': '["Cheese","Onion"]' }),
      'For "Pick toppings": Cheese, Onion', 'JSON-encoded array (legacy client)')
    assert.equal(
      formatMultiSelectReinject(questions, { 'Pick toppings': 'Cheese, Onion' }),
      'For "Pick toppings": Cheese, Onion', 'comma-joined fallback')
    assert.equal(
      formatMultiSelectReinject(questions, {}), '', 'no selection → empty string')
  })

  it('single multi-select REINJECT (flag on): busy session → no send, retryable teardown (#5773 busy-race)', () => {
    // If the answer races ahead of the denied turn's Stop-hook teardown, the
    // session is still _isBusy. The real sendMessage would silently drop the
    // selection (emit error + return, no throw), wedging until the 2h hard cap.
    // The driver must instead NOT send and surface a retryable error.
    const host = makeMockHost()
    host._isBusy = true
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    const tornDown = []
    fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.deepEqual(host._sent, [], 'does NOT call sendMessage while busy')
    assert.deepEqual(host._errors, [], 'never reached the sendMessage busy guard')
    assert.equal(tornDown.length, 1, 'tears down with a retryable error instead of silently dropping')
    assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTISELECT_BUSY')
  })

  it('single multi-select REINJECT (flag on): drops freeformText but still sends the labels (#5773 option B deferral)', () => {
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => { throw new Error('should not tear down') }

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese'] }, 't1', { freeformText: 'extra anchovies' })
    })

    assert.deepEqual(host._sent, ['For "Pick toppings": Cheese'],
      'freeformText is NOT appended to the reinjected answer (Phase 1)')
    assert.ok(host._warns.some((w) => /dropping freeformText/.test(w)),
      'logs that the custom answer was dropped rather than silently discarding it')
  })

  it('single multi-select REINJECT (flag on): a rejecting sendMessage is caught, not thrown (#5773)', async () => {
    const host = makeMockHost({ sendMessage: () => Promise.reject(new Error('boom')) })
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => { throw new Error('should not tear down on the send path') }

    withReinjectFlag('1', () => {
      // Must not throw synchronously — the send is fire-and-forget.
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })
    await Promise.resolve()  // let the .catch microtask run
    await Promise.resolve()
    assert.ok(host._warns.some((w) => /reinject sendMessage failed/.test(w)),
      'the rejection is logged via the .catch, not surfaced as an unhandled throw')
  })

  it('multi-QUESTION (length>1) multiSelect never takes the reinject path — single-question only (#5773)', () => {
    // The reinject guard is `pendingQuestions.length <= 1 && some(multiSelect)`.
    // A >1-question form (denied separately at the hook since #4648) must NOT
    // reinject even with the flag on — pins the single-question-only boundary.
    const host = makeMockHost()
    const options = [{ label: 'A' }, { label: 'B' }]
    host._pendingUserAnswers.set('t1', {
      toolUseId: 't1',
      questions: [
        { question: 'Q1', options, multiSelect: true },
        { question: 'Q2', options, multiSelect: false },
      ],
      options,
    })
    const fd = new FormDriver(host)

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { Q1: ['A'], Q2: 'B' }, 't1')
    })

    assert.deepEqual(host._sent, [], 'reinject path is single-question only')
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
