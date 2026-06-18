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

// #5776 — run `fn` with CHROXY_TUI_MULTISELECT_REINJECT forced to `value`,
// restoring the prior value afterward so tests don't leak the flag into each
// other (the driver reads it at call time via multiSelectReinjectEnabled()).
function withReinjectFlag(value, fn) {
  const prev = process.env.CHROXY_TUI_MULTISELECT_REINJECT
  if (value === undefined) delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
  else process.env.CHROXY_TUI_MULTISELECT_REINJECT = value
  const restore = () => {
    if (prev === undefined) delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
    else process.env.CHROXY_TUI_MULTISELECT_REINJECT = prev
  }
  // #5781 review: restore synchronously for sync callbacks, but if fn() returns
  // a thenable, defer the restore to .finally() so an async callback doesn't get
  // the flag reverted out from under it before its promise settles.
  let result
  try {
    result = fn()
  } catch (err) {
    restore()
    throw err
  }
  if (result && typeof result.then === 'function') {
    return result.finally(restore)
  }
  restore()
  return result
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
  const wdCleared = []       // #5776 _clearAskUserQuestionWatchdog ids
  const locksCleared = []    // #5776 _clearAskUserQuestionLock calls
  const sent = []            // #5776 sendMessage payloads (reinject)
  const warns = []           // #5776 _log.warn messages
  const errors = []          // #5776 emit('error', ...) payloads from sendMessage guard
  const host = {
    _pendingUserAnswers: new Map(),
    _term: {},               // truthy = a live PTY
    // #5781 review: model sendMessage's SECOND guard (runnable session). Defaults
    // to a started, alive session; tests flip these to exercise the not-runnable
    // reinject guard.
    _processReady: true,
    _ptyExited: false,
    _destroying: false,
    // #5776 — model the real sendMessage busy contract. Defaults idle (false),
    // which is the designed reinject state (model stopped on the deny → Stop hook
    // drained → idle by the time the human answers). Tests flip it to exercise the
    // busy-race guard.
    _isBusy: false,
    _activeTurn: { hexDumpEmitted: false, aborted: false, messageId: 'm1' },
    _log: { info() {}, warn: (m) => warns.push(m) },
    // #5798 — the flag-on reinject path stamps a stop-and-wait watch marker with
    // _nowMonotonic(); the real session has it (claude-tui-session.js:648). A
    // fixed clock is enough for the form-driver tests (they only assert the marker
    // shape, not deltas).
    _nowMonotonic: () => 1000,
    // #5798 — observability-only marker; starts unset, set by the flag-on reinject.
    _reinjectStopWaitWatch: null,
    _outputTailHexDump: () => '',
    _outputTailLogDump: () => '',
    _writePtyTextThrottled: (t) => { writes.push(t); return Promise.resolve(true) },
    _writePtyMultiQuestionSequence: (seq) => { multiSeqs.push(seq); return Promise.resolve(true) },
    _writePtyArrowNavSequence: (idx) => { arrowNavs.push(idx); return Promise.resolve(true) },
    _armAskUserQuestionWatchdog: (id, ms) => { arms.push({ id, ms }) },
    _clearPendingAnswerByToolUseId: (id) => { cleared.push(id) },
    // #5776 — surface the multi-select reinject path touches on success.
    _clearAskUserQuestionWatchdog: (id) => { wdCleared.push(id) },
    _clearAskUserQuestionLock: () => { locksCleared.push(true) },
    // #5776 — mirror claude-tui-session.js sendMessage's busy guard: when busy it
    // emit('error') + returns WITHOUT sending (and resolves, not rejects), so a
    // .catch can't observe the drop. The form-driver guards on _isBusy before
    // calling, so this stub primarily proves the call is not made when busy.
    // #5800 — sendMessage now also returns a typed result on its guard paths
    // ({ ok:false, reason } on busy/not-runnable; undefined on the happy path).
    // The stub mirrors that contract; the form-driver still preflights before
    // calling, so the typed shape is consumed only by callers that branch on it.
    sendMessage: (text) => {
      if (host._isBusy) { errors.push('Already processing a message'); return Promise.resolve({ ok: false, reason: 'busy' }) }
      if (!host._processReady || !host._term || host._ptyExited) { errors.push('Session not running'); return Promise.resolve({ ok: false, reason: 'not_runnable' }) }
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

  it('single-question: sanitizes the literal-answer fallthrough before PTY type (#5803)', () => {
    // When the answer text matches no option label it falls through to typing
    // the literal client text into the PTY (the Other/freeform back-compat
    // path). That text is untrusted: control chars (CR/LF/ESC) must be stripped
    // so a crafted answer can't submit the composer early or inject escapes.
    const host = makeMockHost()
    seedSingle(host, 't1', ['Alpha', 'Bravo'])
    const fd = new FormDriver(host)

    fd.respondToQuestion('custom\r\nanswer\x1b[31m', undefined, 't1')

    // CR/LF/ESC removed; control runs collapse to a single space; no bare
    // CR/LF reaches the PTY.
    assert.deepEqual(host._writes, ['custom answer [31m'])
    assert.ok(!host._writes[0].includes('\r') && !host._writes[0].includes('\n'), 'no bare CR/LF typed')
    assert.ok(!host._writes[0].includes('\x1b'), 'no ESC typed')
  })

  it('single-question: a matched option is unaffected by the #5803 literal sanitizer', () => {
    // The hotkey-digit path is a safe single char and must not be touched.
    const host = makeMockHost()
    seedSingle(host, 't1', ['Alpha', 'Bravo', 'Charlie'])
    const fd = new FormDriver(host)

    fd.respondToQuestion('Charlie', undefined, 't1')

    assert.deepEqual(host._writes, ['3'])
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

  it('single multi-select REINJECT (flag on): formats the selection to text and sends a new turn (#5776)', () => {
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

  it('single multi-select REINJECT (flag on): empty selection falls back to teardown (#5776)', () => {
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

  it('single multi-select: flag OFF still refuses + tears down (default behavior preserved) (#5776)', () => {
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

  it('single multi-select REINJECT (flag on): opens the stop-and-wait watch marker (#5798)', () => {
    // Observability-only: after the flag-on reinject sends the new turn, the
    // driver stamps host._reinjectStopWaitWatch so the session can detect a
    // model that tool-calls instead of honoring the "stop and wait" steer.
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Mushroom', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => {}

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.deepEqual(host._sent, ['For "Pick toppings": Cheese, Onion'], 'reinject sent the turn')
    assert.ok(host._reinjectStopWaitWatch, 'stop-and-wait watch marker is set')
    assert.equal(host._reinjectStopWaitWatch.deniedToolUseId, 't1', 'marker records the denied tool id')
    assert.equal(host._reinjectStopWaitWatch.at, 1000, 'marker stamps _nowMonotonic()')
  })

  it('single multi-select REINJECT (flag on): closes the watch when sendMessage resolves { ok:false } (#5798)', async () => {
    // Race: the busy/not-runnable preflight passed, but sendMessage resolves
    // { ok:false } (state changed) → the reinjected turn never started, so the
    // marker must be cleared and not leak a spurious violation WARN later.
    const host = makeMockHost({ sendMessage: () => Promise.resolve({ ok: false, reason: 'busy' }) })
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => {}

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })
    // Marker is opened synchronously, then closed when the send resolves.
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(host._reinjectStopWaitWatch, null, 'watch closed when the reinject turn never started ({ ok:false })')
  })

  it('single multi-select REINJECT (flag on): closes the watch when sendMessage rejects (#5798)', async () => {
    const host = makeMockHost({ sendMessage: () => Promise.reject(new Error('boom')) })
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => {}

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(host._reinjectStopWaitWatch, null, 'watch closed when the reinject send rejected')
  })

  it('single multi-select: flag OFF does NOT open the stop-and-wait watch marker (#5798)', () => {
    const host = makeMockHost()
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => {}

    withReinjectFlag(undefined, () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.equal(host._reinjectStopWaitWatch, null, 'no watch marker on the flag-off refusal path')
  })

  it('single multi-select REINJECT (flag on): a refused pre-flight (busy) does NOT open the watch marker (#5798)', () => {
    // The marker is set ONLY after the actual reinject sendMessage. A pre-flight
    // refusal (busy / not-runnable / empty) tears down without sending, so it
    // must not open a false stop-and-wait window.
    const host = makeMockHost({ _isBusy: true })
    seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
    const fd = new FormDriver(host)
    fd._teardownAskUserQuestion = () => {}

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
    })

    assert.deepEqual(host._sent, [], 'busy pre-flight does not send')
    assert.equal(host._reinjectStopWaitWatch, null, 'no watch marker when the reinject is refused pre-flight')
  })

  it('formatMultiSelectReinject: parses array / JSON-string / comma-string into label text (#5776)', () => {
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

  it('formatMultiSelectReinject: sanitizes control chars out of labels before PTY type (#5796)', () => {
    const questions = [{ question: 'Pick toppings', multiSelect: true }]

    // CR / LF in a label must not survive — a bare \r would submit the composer
    // early when typed into the PTY. The control run collapses to a single space.
    const crlf = formatMultiSelectReinject(questions, { 'Pick toppings': ['Chee\rse', 'On\nion'] })
    assert.ok(!crlf.includes('\r'), 'no bare CR reaches output')
    // \n only appears as the line separator between questions; with one question
    // there is none, so the label's \n must be gone.
    assert.ok(!crlf.includes('\n'), 'no bare LF reaches output (single question)')
    assert.equal(crlf, 'For "Pick toppings": Chee se, On ion', 'control run → single space')

    // ESC + an ANSI color sequence must be stripped (no terminal escape injection).
    const esc = formatMultiSelectReinject(questions, { 'Pick toppings': ['\x1b[31mRed'] })
    assert.ok(!esc.includes('\x1b'), 'ESC stripped')
    assert.equal(esc, 'For "Pick toppings": [31mRed', 'only the ESC byte goes, rest is printable text')

    // Backspace (\x08) and DEL (\x7f) are C0/DEL controls → removed.
    const bs = formatMultiSelectReinject(questions, { 'Pick toppings': ['A\x08B\x7fC'] })
    assert.equal(bs, 'For "Pick toppings": A B C', 'backspace + DEL → spaces')

    // Normal unicode / printable text is untouched.
    const uni = formatMultiSelectReinject(questions, { 'Pick toppings': ['Café ☕ 日本語'] })
    assert.equal(uni, 'For "Pick toppings": Café ☕ 日本語', 'printable unicode preserved')

    // A label that is ONLY control chars sanitizes to empty and is dropped (no
    // stray separator); with all labels dropped the question yields no line.
    assert.equal(
      formatMultiSelectReinject(questions, { 'Pick toppings': ['\r\n\x1b', 'Cheese'] }),
      'For "Pick toppings": Cheese', 'all-control label dropped, no stray comma')
    assert.equal(
      formatMultiSelectReinject(questions, { 'Pick toppings': ['\r\n'] }),
      '', 'question with only control-char labels → no line')

    // Non-string entries inside the parsed array are already filtered out, but
    // weird answersMap values must not throw.
    assert.doesNotThrow(() => formatMultiSelectReinject(questions, { 'Pick toppings': null }))
    assert.doesNotThrow(() => formatMultiSelectReinject(questions, { 'Pick toppings': undefined }))
    assert.doesNotThrow(() => formatMultiSelectReinject(questions, { 'Pick toppings': 42 }))
  })

  it('single multi-select REINJECT (flag on): busy session → no send, retryable teardown (#5776 busy-race)', () => {
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

  it('single multi-select REINJECT (flag on): not-runnable session → no send, retryable teardown (#5781 review)', () => {
    // sendMessage has a SECOND fail-open guard beyond _isBusy: if the session is
    // not runnable (PTY exited / not started) it emit('error')s + returns without
    // starting a turn. Reaching it after the pending entry was cleared would drop
    // the selection with no retry path. The driver must preflight and tear down
    // with a retryable error instead of clearing state then dropping silently.
    for (const notRunnable of [{ _ptyExited: true }, { _processReady: false }, { _term: null }]) {
      const host = makeMockHost(notRunnable)
      seedSingleMultiSelect(host, 't1', ['Cheese', 'Onion'])
      const fd = new FormDriver(host)
      const tornDown = []
      fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

      withReinjectFlag('1', () => {
        fd.respondToQuestion('', { 'Pick toppings': ['Cheese', 'Onion'] }, 't1')
      })

      assert.deepEqual(host._sent, [], `does NOT call sendMessage when not runnable (${JSON.stringify(notRunnable)})`)
      assert.deepEqual(host._cleared, [], 'does NOT clear the pending entry before bailing — selection stays retryable')
      assert.equal(tornDown.length, 1, 'tears down with a retryable error')
      assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE')
    }
  })

  it('single multi-select REINJECT (flag on): drops freeformText but still sends the labels (#5776 option B deferral)', () => {
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

  it('single multi-select REINJECT (flag on): a rejecting sendMessage is caught, not thrown (#5776)', async () => {
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

  it('multi-QUESTION (length>1) is refused — no reinject, no keystrokes, retryable teardown (#5773)', () => {
    // Multi-question forms are denied at the permission hook (#4648); the
    // keystroke assembler was removed in #5773. If a >1-question entry reaches
    // the driver anyway (fail-open hook), it must refuse + tear down cleanly —
    // never reinject (single-question only, #5776) and never drive keystrokes.
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
    const tornDown = []
    fd._teardownAskUserQuestion = (id, payload) => { tornDown.push({ id, payload }) }

    withReinjectFlag('1', () => {
      fd.respondToQuestion('', { Q1: ['A'], Q2: 'B' }, 't1')
    })

    assert.deepEqual(host._sent, [], 'reinject path is single-question only')
    assert.deepEqual(host._writes, [], 'no digit keystrokes written')
    assert.deepEqual(host._multiSeqs, [], 'no multi-question keystroke sequence driven')
    assert.equal(tornDown.length, 1, 'multi-question is torn down, not driven')
    assert.equal(tornDown[0].payload.errorCode, 'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED')
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
