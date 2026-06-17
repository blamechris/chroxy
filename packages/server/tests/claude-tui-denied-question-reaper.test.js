import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #5792 — denied-shape AskUserQuestion reaper.
 *
 * The permission hook DENIES a multi-question (questions.length > 1) or
 * multi-select (any question multiSelect:true) AskUserQuestion, so claude blocks
 * in the tool then Stops with no PostToolUse. The Stop success path
 * (`_clearTurnEndState`) clears the sibling lock + stall watchdogs but
 * deliberately keeps `_pendingUserAnswers` (a legit sibling answer may still be
 * in flight). For a DENIED shape no answer ever arrives, so that pending entry
 * leaks past turn-end and a later no-toolUseId `respondToQuestion` would
 * misroute to it via the most-recent back-compat fallback.
 *
 * The reaper, armed ONLY for denied shapes at pending-creation, drops the
 * still-leaked entry after a window. A legitimate single single-select is left
 * untouched (it gets a PostToolUse / its own stall watchdog).
 */
describe('ClaudeTuiSession — denied-shape AskUserQuestion reaper (#5792)', () => {
  let emptySkillsDir
  let session

  const multiQuestionPayload = (toolUseId = 'toolu_multi') => ({
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
    tool_input: {
      questions: [
        { question: 'Which provider?', header: 'Provider', options: [{ label: 'A', value: 'a' }] },
        { question: 'Which transport?', header: 'Transport', options: [{ label: 'B', value: 'b' }] },
      ],
    },
  })

  const multiSelectPayload = (toolUseId = 'toolu_ms') => ({
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
    tool_input: {
      questions: [
        { question: 'Pick any', header: 'Pick', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
      ],
    },
  })

  const singleSelectPayload = (toolUseId = 'toolu_single') => ({
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
    tool_input: {
      questions: [
        { question: 'Pick one', header: 'Pick', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
      ],
    },
  })

  beforeEach(() => {
    emptySkillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
    session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: emptySkillsDir, repoSkillsDir: null })
    session.on('error', () => {})
    // _emitToolHookEvent reads _activeTurn for the synth-id fallback path.
    session._activeTurn = { messageId: 'msg-test', startedAt: Date.now(), aborted: false, synthSeq: 0 }
  })

  afterEach(async () => {
    mock.timers.reset()
    if (session) {
      try { await session.destroy() } catch { /* ignore */ }
      session = null
    }
    if (emptySkillsDir) rmSync(emptySkillsDir, { recursive: true, force: true })
    emptySkillsDir = null
  })

  it('arms a reaper for a multi-question AskUserQuestion', () => {
    session._emitToolHookEvent('PreToolUse', multiQuestionPayload('toolu_multi'), 'msg-test')
    assert.ok(session._pendingUserAnswers.has('toolu_multi'), 'pending entry created')
    assert.ok(session._deniedQuestionReapers.has('toolu_multi'), 'reaper armed for the denied multi-question shape')
  })

  it('arms a reaper for a single multi-select AskUserQuestion', () => {
    session._emitToolHookEvent('PreToolUse', multiSelectPayload('toolu_ms'), 'msg-test')
    assert.ok(session._pendingUserAnswers.has('toolu_ms'), 'pending entry created')
    assert.ok(session._deniedQuestionReapers.has('toolu_ms'), 'reaper armed for the denied multi-select shape')
  })

  it('does NOT arm a reaper for a legitimate single single-select', () => {
    session._emitToolHookEvent('PreToolUse', singleSelectPayload('toolu_single'), 'msg-test')
    assert.ok(session._pendingUserAnswers.has('toolu_single'), 'pending entry created')
    assert.equal(session._deniedQuestionReapers.has('toolu_single'), false,
      'no reaper for a legitimate single single-select (it gets a PostToolUse / its own stall watchdog)')
  })

  // Acceptance #1: after deny→Stop→idle with no answer, _pendingUserAnswers AND
  // the sibling lock are empty.
  it('after deny→Stop→reaper-fire, pending entry and sibling lock are both empty', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    // The permission hook leaves an askuserquestion-active lock under the sink.
    session._sinkDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-sink-'))
    const lockPath = join(session._sinkDir, 'askuserquestion-active')
    writeFileSync(lockPath, '1')
    session._isBusy = true
    session._currentMessageId = 'msg-test'

    session._emitToolHookEvent('PreToolUse', multiQuestionPayload('toolu_multi'), 'msg-test')
    assert.ok(session._pendingUserAnswers.has('toolu_multi'))
    assert.ok(session._deniedQuestionReapers.has('toolu_multi'))

    // Stop success path runs the shared per-turn teardown: it clears the lock +
    // watchdogs but deliberately keeps _pendingUserAnswers. The reaper survives.
    session._clearTurnEndState()
    assert.equal(existsSync(lockPath), false, 'sibling lock already cleared at Stop (#4604)')
    assert.ok(session._pendingUserAnswers.has('toolu_multi'), 'pending still leaks past Stop')
    assert.ok(session._deniedQuestionReapers.has('toolu_multi'), 'reaper survives turn-end')

    mock.timers.tick(60_000) // past the reaper window

    assert.equal(session._pendingUserAnswers.size, 0, 'reaper dropped the leaked pending entry')
    assert.equal(session._deniedQuestionReapers.size, 0, 'reaper self-removed after firing')
    assert.equal(existsSync(lockPath), false, 'sibling lock stays empty')

    rmSync(session._sinkDir, { recursive: true, force: true })
  })

  // Acceptance #2: a late answer arriving after the reaper fires is dropped
  // cleanly, not misrouted via the most-recent back-compat fallback.
  it('drops a late no-toolUseId answer after the reaper has fired (no misroute)', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    session._emitToolHookEvent('PreToolUse', multiQuestionPayload('toolu_multi'), 'msg-test')
    session._clearTurnEndState()
    mock.timers.tick(60_000)
    assert.equal(session._pendingUserAnswers.size, 0)
    assert.equal(session._lastPendingAnswerToolUseId, null,
      'most-recent pointer cleared so a no-toolUseId answer finds nothing to misroute to')
    // The back-compat getter (what respondToQuestion falls back to) returns null.
    assert.equal(session._pendingUserAnswer, null, 'no stale entry for the most-recent fallback')
  })

  it('PostToolUse cancels the reaper (answered/resolved entry is not reaped)', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    session._emitToolHookEvent('PreToolUse', multiQuestionPayload('toolu_multi'), 'msg-test')
    assert.ok(session._deniedQuestionReapers.has('toolu_multi'))

    // PostToolUse clears the pending entry via _clearPendingAnswerByToolUseId,
    // which must also cancel the reaper.
    session._emitToolHookEvent('PostToolUse', multiQuestionPayload('toolu_multi'), 'msg-test')
    assert.equal(session._pendingUserAnswers.has('toolu_multi'), false, 'PostToolUse cleared the entry')
    assert.equal(session._deniedQuestionReapers.has('toolu_multi'), false, 'reaper cancelled with the entry')

    mock.timers.tick(60_000) // reaper must not fire — nothing armed
    assert.equal(session._pendingUserAnswers.size, 0)
  })

  it('a turn-level wipe (_pendingUserAnswers_clearAll) clears all reapers', () => {
    session._emitToolHookEvent('PreToolUse', multiQuestionPayload('toolu_multi_a'), 'msg-test')
    session._emitToolHookEvent('PreToolUse', multiSelectPayload('toolu_ms_b'), 'msg-test')
    assert.equal(session._deniedQuestionReapers.size, 2)

    // interrupt()/destroy() issue Ctrl-C then wipe pending wholesale.
    session._pendingUserAnswers_clearAll()
    assert.equal(session._pendingUserAnswers.size, 0)
    assert.equal(session._deniedQuestionReapers.size, 0, 'all reapers cleared with the wholesale pending wipe')
  })

  it('_reapDeniedQuestion is a no-op when the entry is already gone', () => {
    // No pending entry for this id → reaping must not throw or clear siblings.
    session._emitToolHookEvent('PreToolUse', singleSelectPayload('toolu_keep'), 'msg-test')
    assert.doesNotThrow(() => session._reapDeniedQuestion('toolu_absent'))
    assert.ok(session._pendingUserAnswers.has('toolu_keep'), 'unrelated pending entry untouched')
  })

  // S1 (review #5975): reaping the denied entry must not disturb a CO-RESIDENT
  // legit single-select sibling — the actual #4668-class hazard the per-toolUseId
  // keying guards against (the absent-id test above only covers a missing id).
  it('reaping a denied multi leaves a co-resident legit single-select sibling intact', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    // Denied multi (id A) → arms a reaper (30s).
    session._emitToolHookEvent('PreToolUse', multiQuestionPayload('toolu_A'), 'msg-test')
    // Legit single single-select (id B) → no reaper; seed its own stall watchdog
    // as respondToQuestion would, with a longer window so A's 30s reaper fires
    // first without B's watchdog also firing.
    session._emitToolHookEvent('PreToolUse', singleSelectPayload('toolu_B'), 'msg-test')
    session._armAskUserQuestionWatchdog('toolu_B', 120_000)
    assert.ok(session._deniedQuestionReapers.has('toolu_A'), 'reaper armed for the denied multi')
    assert.equal(session._deniedQuestionReapers.has('toolu_B'), false, 'no reaper for the legit single-select')
    assert.ok(session._askUserQuestionWatchdogs.has('toolu_B'), 'sibling stall watchdog armed')

    mock.timers.tick(60_000) // past A's 30s reaper, before B's 120s watchdog

    assert.equal(session._pendingUserAnswers.has('toolu_A'), false, 'denied sibling reaped')
    assert.ok(session._pendingUserAnswers.has('toolu_B'), 'legit single-select entry survives')
    assert.ok(session._askUserQuestionWatchdogs.has('toolu_B'), 'legit single-select watchdog survives')
    assert.equal(session._lastPendingAnswerToolUseId, 'toolu_B', 'most-recent pointer points at the survivor')
  })

  // S2 (review #5975): the multiSelect reinject path clears the pending entry
  // synchronously (before its async send) on every outcome, so it cancels the
  // reaper — pinning the no-race property documented on DENIED_QUESTION_REAPER_MS.
  it('the multiSelect reinject path cancels the reaper (flag-on, no race)', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const prev = process.env.CHROXY_TUI_MULTISELECT_REINJECT
    process.env.CHROXY_TUI_MULTISELECT_REINJECT = '1'
    try {
      session._emitToolHookEvent('PreToolUse', multiSelectPayload('toolu_ms'), 'msg-test')
      assert.ok(session._deniedQuestionReapers.has('toolu_ms'), 'reaper armed for the denied multi-select')

      // The session has no PTY in this unit test, so the flag-on reinject path
      // tears down via the 'unavailable' refusal — which clears the pending entry
      // synchronously, cancelling the reaper before any async send could race it.
      session.respondToQuestion('', { 'Pick any': ['A'] }, 'toolu_ms', {})

      assert.equal(session._pendingUserAnswers.has('toolu_ms'), false, 'reinject teardown cleared the entry')
      assert.equal(session._deniedQuestionReapers.has('toolu_ms'), false, 'reaper cancelled with the entry')

      mock.timers.tick(60_000) // nothing armed — must be a no-op
      assert.equal(session._pendingUserAnswers.size, 0)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_TUI_MULTISELECT_REINJECT
      else process.env.CHROXY_TUI_MULTISELECT_REINJECT = prev
    }
  })
})
