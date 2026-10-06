import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SdkSession, isSdkToolCancellationText, SDK_TOOL_CANCELLED_PREFIXES } from '../src/sdk-session.js'

/**
 * #8300 — a claude-sdk turn keeps its permission/hook channel for the whole
 * turn, whatever the CLI runs before the prompt.
 *
 * The Agent SDK closes the CLI's stdin at the FIRST `result` of a query whose
 * prompt is a string. On `--resume` Claude Code can run an orphaned background
 * task's notice as its own zero-cost turn BEFORE the prompt (`init` → `result`
 * with `num_turns: 0` → a second `init`), so stdin was closed under the real
 * prompt: every tool call came back cancelled with the generic "user doesn't
 * want to take this action" text, `canUseTool`/PreToolUse were never invoked,
 * no permission_request reached a client, and chroxy forwarded the zero-turn
 * result as a finished turn.
 *
 * The fix hands query() a STREAMING input (an async iterable of one user
 * message) and ends it only after the result that answers the prompt. These
 * tests drive `sendMessage` against a fake query that consumes that iterable
 * the way the SDK does, so "the input was still open when X happened" is
 * asserted directly, not inferred.
 */

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'sdk-turn-input-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

function createSession(opts = {}) {
  const session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile(), ...opts })
  // Non-blocking model refresh would otherwise fire real network work.
  session._fetchSupportedModels = () => {}
  return session
}

/**
 * The SDK's side of the streaming input: read the iterable to its end,
 * recording every item and the moment it ended. `inputEnded` is the fact
 * every test here turns on.
 */
function consumeInput(iterable, state) {
  state.items = []
  state.inputEnded = false
  state.inputDone = (async () => {
    for await (const item of iterable) state.items.push(item)
    state.inputEnded = true
  })()
}

/**
 * A fake query: an async iterable over `script` that also carries the Query
 * methods the session touches. Script entries:
 *   - a message object → yielded to the session
 *   - a function → run (side effects / mid-stream assertions), nothing yielded
 *   - { __waitInputEnd } → the generator waits for the input to be ended,
 *     the way the real CLI only exits once stdin closes
 *   - { __parkUntilClosed } → the generator waits until close() is called
 *     and then throws an AbortError, the way the SDK's generator does
 *   - { __throw: err } → the generator throws
 */
function fakeQuery(script, state) {
  let closed = false
  let rejectParked = null
  const abortError = () => {
    const err = new Error('Query was aborted')
    err.name = 'AbortError'
    return err
  }
  const gen = (async function* () {
    for (const step of script) {
      if (typeof step === 'function') { await step(); continue }
      if (step && typeof step.__delayMs === 'number') { await new Promise((r) => setTimeout(r, step.__delayMs)); continue }
      if (step && step.__waitInputEnd) { await state.inputDone; continue }
      if (step && step.__parkUntilClosed) {
        if (closed) throw abortError()
        // Bounded: a session that never closes the query would otherwise park
        // this generator forever and the test would hang instead of failing.
        try {
          await new Promise((_, reject) => {
            rejectParked = reject
            setTimeout(() => {
              state.parkTimedOut = true
              reject(new Error('fake query: the session never closed the query, the process would have lingered'))
            }, 300)
          })
        } catch (e) {
          if (e && e.__eof) return // the real SDK's close can also just end the generator
          throw e
        }
        continue
      }
      if (step && step.__throw) throw step.__throw
      yield step
    }
  })()
  const query = {
    [Symbol.asyncIterator]() { return gen },
    interrupt: async () => { state.interrupts = (state.interrupts || 0) + 1 },
    stopTask: (taskId) => new Promise((resolve, reject) => {
      state.stopCalls = [...(state.stopCalls || []), { taskId, closedBefore: closed }]
      if (state.stopTaskFails) return reject(new Error('control channel gone'))
      if (state.stopTaskHangs) return
      // Like the real SDK: a close while the control request is pending
      // rejects it ("Query closed before response received").
      state.pendingStops = [...(state.pendingStops || []), reject]
      setTimeout(() => {
        state.pendingStops = (state.pendingStops || []).filter((r) => r !== reject)
        resolve()
      }, typeof state.stopDelayMs === 'number' ? state.stopDelayMs : 0)
    }),
    close: () => {
      state.closeCalls = (state.closeCalls || 0) + 1
      if (state.closeIneffective) return
      closed = true
      for (const reject of state.pendingStops || []) reject(new Error('Query closed before response received'))
      state.pendingStops = []
      if (rejectParked) rejectParked(state.closeEndsQuietly ? { __eof: true } : abortError())
    },
  }
  return query
}

function wire(session, script, state) {
  session._callQuery = (args) => {
    state.args = args
    consumeInput(args.prompt, state)
    return fakeQuery(script, state)
  }
}

/**
 * Give the fake consumer its turn to observe the iterable closing — bounded,
 * so an input that was never ended still fails the assertion that follows
 * instead of hanging the test.
 */
function settled(state) {
  return Promise.race([state.inputDone, new Promise((r) => setTimeout(r, 200))])
}

function capture(session) {
  const events = []
  for (const name of ['ready', 'stream_start', 'stream_end', 'message', 'tool_start', 'tool_result', 'result', 'error', 'stopped', 'permission_request', 'agent_spawned', 'agent_completed']) {
    session.on(name, (d) => events.push({ name, ...d }))
  }
  return events
}

const init = (sid = 'sdk-1') => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-x', tools: [] })
const orphanNotice = { type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false, duration_ms: 15, num_turns: 0, total_cost_usd: 0, usage: {} }
const promptResult = (numTurns = 2) => ({ type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false, duration_ms: 5000, num_turns: numTurns, total_cost_usd: 0.01, usage: {} })
const toolUseStart = (id, name) => ({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } })
const assistantToolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolResult = (id, content, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } })

const CANCELLED_TEXT = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const STREAM_CLOSED_TEXT = 'Tool permission request failed: AbortError: Stream closed'

describe('SdkSession turn input (#8300)', () => {
  let session
  let state
  const defaultConfirmMs = SdkSession.ORPHAN_NOTICE_CONFIRM_MS
  beforeEach(() => {
    session = createSession()
    state = {}
  })
  afterEach(() => {
    SdkSession.ORPHAN_NOTICE_CONFIRM_MS = defaultConfirmMs
    session.destroy()
  })

  it('hands query() a streaming input of one user message and keeps it open until the prompt\'s own result', async () => {
    const openAtResult = []
    wire(session, [
      init(),
      () => openAtResult.push(['after init', state.inputEnded]),
      assistantText('hello back'),
      () => openAtResult.push(['before result', state.inputEnded]),
      promptResult(1),
    ], state)
    const events = capture(session)

    await session.sendMessage('hello')

    assert.notEqual(typeof state.args.prompt, 'string', 'the prompt is a streaming input, never a string (a string makes the SDK close stdin at the first result)')
    assert.equal(state.items.length, 1, 'exactly one user message is streamed')
    assert.equal(state.items[0].type, 'user')
    assert.equal(state.items[0].parent_tool_use_id, null)
    assert.deepEqual(state.items[0].message, { role: 'user', content: [{ type: 'text', text: 'hello' }] })
    assert.deepEqual(openAtResult, [['after init', false], ['before result', false]], 'the input stays open for the whole turn')
    assert.equal(state.inputEnded, true, 'the input is ended once the prompt\'s result is processed')
    assert.equal(events.filter((e) => e.name === 'result').length, 1)
    assert.equal(session._isBusy, false)
    assert.equal(session._turnInput, null, 'no turn input lingers between turns')
  })

  it('carries attachments as content blocks on the streamed user message', async () => {
    wire(session, [init(), promptResult(1)], state)
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    await session.sendMessage('look', [{ type: 'image', mediaType: 'image/png', data: png }])
    const content = state.items[0].message.content
    assert.ok(Array.isArray(content) && content.length >= 2, 'text block plus image block')
    assert.equal(content[0].type, 'text')
    assert.equal(content[0].text, 'look')
    assert.ok(content.some((b) => b.type === 'image'), 'the image rides on the same user message')
  })

  describe('an orphan-task notice before the prompt', () => {
    it('does not end the turn or the input, and the prompt\'s tools still reach the hook (Auto)', async () => {
      session.setPermissionMode('auto')
      let pipelineCalls = 0
      const realHandle = session._permissions.handlePermission.bind(session._permissions)
      session._permissions.handlePermission = (...a) => { pipelineCalls++; return realHandle(...a) }
      const events = capture(session)
      const seen = []
      let hookDecision = null
      wire(session, [
        init(),
        orphanNotice,
        () => seen.push(['after orphan result', state.inputEnded, events.filter((e) => e.name === 'result').length]),
        init(),
        () => seen.push(['after second init', state.inputEnded, events.filter((e) => e.name === 'result').length]),
        async () => {
          // The CLI asks the PreToolUse hook — possible only while the channel is open.
          const hook = state.args.options.hooks.PreToolUse[0].hooks[0]
          const out = await hook({ tool_name: 'Read', tool_input: { file_path: '/tmp/README.md' } }, 'tu-1', { signal: new AbortController().signal })
          hookDecision = out?.hookSpecificOutput?.permissionDecision
        },
        toolUseStart('tu-1', 'Read'),
        assistantToolUse('tu-1', 'Read', { file_path: '/tmp/README.md' }),
        toolResult('tu-1', '1\thello from the readme'),
        assistantText('hello from the readme'),
        promptResult(2),
      ], state)

      await session.sendMessage('read the readme')

      assert.deepEqual(seen, [
        ['after orphan result', false, 0],
        ['after second init', false, 0],
      ], 'neither the zero-turn result nor the second init ends the input or emits a result')
      assert.equal(hookDecision, 'allow', 'the PreToolUse hook answered (the channel was live)')
      assert.equal(pipelineCalls, 1, 'the permission pipeline was consulted for the prompt\'s tool call')
      const results = events.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'exactly one result: the prompt\'s own')
      assert.equal(results[0].numTurns, 2)
      const order = events.map((e) => e.name)
      assert.ok(order.indexOf('tool_result') < order.indexOf('result'), 'the result follows the prompt\'s tool work')
      const notice = events.find((e) => e.name === 'message' && e.subtype === 'orphan_task_notice')
      assert.ok(notice, 'the notice is surfaced as a system message, not as a turn end')
      assert.equal(notice.type, 'system')
      assert.equal(events.filter((e) => e.name === 'ready').length, 2, 'both inits still announce ready')
      assert.equal(state.inputEnded, true)
      assert.equal(session._isBusy, false)
    })

    it('still emits the permission_request for the prompt\'s tool call (Approve)', async () => {
      const events = capture(session)
      let decision = null
      wire(session, [
        init(),
        orphanNotice,
        init(),
        async () => {
          const pending = state.args.options.canUseTool('Bash', { command: 'rm -rf /tmp/scratch' }, { signal: new AbortController().signal, suggestions: [] })
          await new Promise((r) => setImmediate(r))
          const req = events.find((e) => e.name === 'permission_request')
          assert.ok(req?.requestId, 'a permission_request with an id reached the client after the notice')
          assert.equal(req.tool, 'Bash')
          session.respondToPermission(req.requestId, 'deny')
          decision = await pending
        },
        toolUseStart('tu-2', 'Bash'),
        toolResult('tu-2', 'Permission denied by user', true),
        promptResult(2),
      ], state)

      await session.sendMessage('clean up')

      assert.equal(decision?.behavior, 'deny', 'the client\'s answer, not a CLI cancellation, decided the call')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
      assert.equal(state.inputEnded, true)
    })

    it('takes a zero-turn result as the prompt\'s own when no init follows it', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      const events = capture(session)
      let inputEndedBeforeExit = null
      wire(session, [
        init(),
        orphanNotice,
        // The CLI exits only once stdin is closed — the held result must
        // release the input on its own, or this turn would never end.
        { __waitInputEnd: true },
        () => { inputEndedBeforeExit = state.inputEnded },
      ], state)

      await session.sendMessage('/nothing')

      assert.equal(inputEndedBeforeExit, true, 'the confirm window released the input')
      const results = events.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'the held result is emitted once the loop ends')
      assert.equal(results[0].numTurns, 0)
      assert.ok(!events.some((e) => e.name === 'message' && e.subtype === 'orphan_task_notice'), 'no notice was invented')
      assert.equal(session._isBusy, false)
    })

    it('releases the hold when prompt activity follows the notice with no second init', async () => {
      // A short window the running prompt must OUTLAST: with the hold still
      // armed, the timer would end the input under the prompt.
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      const events = capture(session)
      const seen = []
      wire(session, [
        init(),
        orphanNotice,
        () => seen.push(['after orphan result', state.inputEnded, events.filter((e) => e.name === 'result').length]),
        toolUseStart('tu-1', 'Read'),
        { __delayMs: 80 },
        () => seen.push(['after activity', state.inputEnded, session._liveBackgroundTasks.size]),
        toolResult('tu-1', 'contents'),
        assistantText('done'),
        promptResult(2),
      ], state)
      await session.sendMessage('read')
      assert.deepEqual(seen.map((x) => x.slice(0, 2)), [['after orphan result', false], ['after activity', false]])
      const results = events.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'the held notice is not emitted a second time after the loop')
      assert.equal(results[0].numTurns, 2)
      assert.ok(events.some((e) => e.name === 'message' && e.subtype === 'orphan_task_notice'))
      assert.equal(state.inputEnded, true)
    })

    it('finalizes a held zero-turn result on expiry even when background work keeps the process alive', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      const events = capture(session)
      wire(session, [
        init(),
        // A task the CLI reports without any assistant activity in this turn.
        { type: 'system', subtype: 'task_started', task_id: 't-amb', tool_use_id: 'tu-amb', task_type: 'local_agent', is_backgrounded: true, description: 'still running' },
        orphanNotice,
        // The real generator would stay open: the live task keeps the process alive.
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('/nothing')
      const results = events.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'the held result is finished by the window, not by an EOF the task withholds')
      assert.equal(results[0].numTurns, 0)
      const loss = events.filter((e) => e.name === 'error')
      assert.deepEqual(loss.map((e) => e.code), ['background_task_ended_with_turn'])
      assert.deepEqual(state.stopCalls.map((c) => c.taskId), ['t-amb'])
      assert.equal(state.closeCalls, 1)
      assert.notEqual(state.parkTimedOut, true)
      assert.equal(state.inputEnded, true)
      assert.equal(session._isBusy, false)
    })

    it('finishes a turn once when the prompt\'s own result lands while the expiry finish is still stopping work', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      state.stopDelayMs = 120
      const events = capture(session)
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_started', task_id: 't-slow', tool_use_id: 'tu-slow', task_type: 'local_agent', is_backgrounded: true, description: 'slow to stop' },
        orphanNotice,
        // Past the window: the timer's finish is now awaiting stopTask.
        { __delayMs: 70 },
        assistantText('late output'),
        promptResult(2),
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('/late')
      const results = events.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'one turn end, whichever caller got there first')
      assert.equal(events.filter((e) => e.name === 'error' && e.code === 'background_task_ended_with_turn').length, 1)
      assert.equal(state.closeCalls, 1)
      assert.equal(session._isBusy, false)
    })

    it('does not close the query on a message that lands while the stops are still pending', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      state.stopDelayMs = 100
      const events = capture(session)
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_started', task_id: 't-s', tool_use_id: 'tu-s', task_type: 'local_bash', is_backgrounded: true, description: 'sleep' },
        orphanNotice,
        // The CLI answers the stop with bookkeeping BEFORE the control response.
        { __delayMs: 60 },
        { type: 'system', subtype: 'task_updated', task_id: 't-s', patch: { status: 'killed' } },
        { type: 'system', subtype: 'task_notification', task_id: 't-s', status: 'stopped', output_file: '/tmp/o', summary: 'stopped' },
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('/x')
      const loss = events.find((e) => e.name === 'error' && e.code === 'background_task_ended_with_turn')
      assert.ok(loss)
      assert.equal(loss.stopped, true, 'the stop was acknowledged before the close, so it is reported as stopped')
      assert.equal(state.closeCalls, 1)
    })

    it('judges a further zero-turn result afresh instead of emitting the held one twice', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      const events = capture(session)
      wire(session, [
        init(),
        orphanNotice,
        { ...orphanNotice, duration_ms: 20 },
        { __waitInputEnd: true },
      ], state)
      await session.sendMessage('/nothing')
      const results = events.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'one result for the prompt, never one per held notice')
      assert.equal(events.filter((e) => e.name === 'message' && e.subtype === 'orphan_task_notice').length, 1)
      assert.equal(state.inputEnded, true)
    })

    it('a held notice never outlives the turn: destroy() during the window releases the input', async () => {
      wire(session, [
        init(),
        orphanNotice,
        () => { session.destroy() },
        { __waitInputEnd: true },
        init(),
      ], state)
      await session.sendMessage('hi')
      await settled(state)
      assert.equal(state.inputEnded, true)
      assert.equal(session._turnInput, null)
    })

    it('treats a zero-turn result after prompt activity as the prompt\'s own result', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        assistantText('done'),
        { ...orphanNotice, num_turns: 0 },
      ], state)
      await session.sendMessage('hi')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
      assert.equal(state.inputEnded, true)
      assert.equal(session._isBusy, false)
    })
  })

  describe('background work still live at the prompt\'s result', () => {
    const launchScript = (extraBeforeResult = []) => [
      init(),
      toolUseStart('tu-agent', 'Agent'),
      assistantToolUse('tu-agent', 'Agent', { description: 'count lines', prompt: 'count', run_in_background: true, subagent_type: 'Explore' }),
      { type: 'system', subtype: 'task_started', task_id: 't-1', tool_use_id: 'tu-agent', task_type: 'local_agent', is_backgrounded: true, description: 'count lines' },
      toolResult('tu-agent', 'Async agent launched successfully.'),
      assistantText('started'),
      ...extraBeforeResult,
      promptResult(2),
      // After the result the real SDK generator only ends when the process
      // does; with a live task the process would not go idle on its own.
      { __parkUntilClosed: true },
    ]

    it('is stopped with the turn and said out loud, never silently cancelled', async () => {
      const events = capture(session)
      wire(session, launchScript(), state)

      await session.sendMessage('start a background count')

      const loss = events.filter((e) => e.name === 'error')
      assert.equal(loss.length, 1, 'exactly one error: the background task\'s, no "Query error" for the deliberate close')
      assert.equal(loss[0].code, 'background_task_ended_with_turn')
      assert.equal(loss[0].toolUseId, 'tu-agent')
      assert.equal(loss[0].taskId, 't-1')
      assert.match(loss[0].message, /subagent "count lines"/)
      assert.equal(state.closeCalls, 1, 'the query is closed so no unserviced notification turn runs')
      assert.deepEqual(state.stopCalls, [{ taskId: 't-1', closedBefore: false }], 'the CLI was asked to stop the task while the channel was still open, before the close')
      assert.equal(loss[0].stopped, true)
      assert.ok(events.some((e) => e.name === 'agent_completed' && e.toolUseId === 'tu-agent'), 'the agent node is closed')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
      assert.ok(!events.some((e) => e.name === 'stopped'), 'the close is not reported as a user stop')
      const order = events.map((e) => e.name)
      assert.ok(order.indexOf('error') < order.indexOf('result'), 'the loss is reported inside the turn, before its result')
      assert.equal(state.inputEnded, true)
      assert.equal(session._isBusy, false)
      assert.equal(session._liveBackgroundTasks.size, 0)
      assert.notEqual(state.parkTimedOut, true, 'the close actually ended the generator; nothing timed out')
    })

    it('ends the turn cleanly when the close simply ends the generator (no abort thrown)', async () => {
      const events = capture(session)
      state.closeEndsQuietly = true
      wire(session, launchScript(), state)
      await session.sendMessage('start a background count')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
      assert.deepEqual(events.filter((e) => e.name === 'error').map((e) => e.code), ['background_task_ended_with_turn'])
      assert.equal(session._isBusy, false)
    })

    it('surfaces a nonzero process exit buffered behind the result, even after the deliberate close', async () => {
      const events = capture(session)
      wire(session, [
        ...launchScript().filter((s) => !s?.__parkUntilClosed),
        { __throw: new Error('Claude Code process exited with code 1') },
      ], state)
      await session.sendMessage('start a background count')
      const codes = events.filter((e) => e.name === 'error').map((e) => e.code)
      assert.deepEqual(codes, ['background_task_ended_with_turn', undefined], 'the crash is not mistaken for the close')
      assert.match(events.filter((e) => e.name === 'error')[1].message, /exited with code 1/)
    })

    it('ends the lingering process when a finished turn keeps receiving messages', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        assistantText('started'),
        promptResult(2),
        // Work this turn could not see kept the process alive: a notification turn starts.
        init(),
        toolUseStart('tu-late', 'Read'),
        toolResult('tu-late', CANCELLED_TEXT, true),
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('hi')
      assert.equal(state.closeCalls, 1, 'the lingering process is closed on the first late message')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
      assert.equal(events.filter((e) => e.name === 'ready').length, 1, 'the late init is not relayed into a finished turn')
      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      assert.notEqual(state.parkTimedOut, true)
    })

    it('drops routine post-result bookkeeping quietly and closes only on another turn\'s traffic', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        assistantText('done'),
        promptResult(1),
        { type: 'system', subtype: 'status', status: null },
        { type: 'system', subtype: 'hook_response' },
        () => { assert.equal(state.closeCalls, undefined, 'bookkeeping after the result is not a lingering process') },
        init(),
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('hi')
      assert.equal(state.closeCalls, 1, 'a second init after the result is')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
    })

    it('destroy() during the stops still ends the process, without emitting on the dead session', async () => {
      // Through the timer path, where the finish runs while the loop is
      // parked: the window expires, the stop is slow, destroy() lands mid-stop.
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      state.stopDelayMs = 80
      const events = capture(session)
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_started', task_id: 't-d', tool_use_id: 'tu-d', task_type: 'local_agent', is_backgrounded: true, description: 'slow' },
        orphanNotice,
        { __delayMs: 60 },
        () => { session.destroy() },
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('/x')
      await new Promise((r) => setTimeout(r, 120))
      assert.deepEqual(state.stopCalls.map((c) => c.taskId), ['t-d'], 'the stop was in flight when destroy() landed')
      assert.ok(state.closeCalls >= 1, 'the query was closed')
      assert.notEqual(state.parkTimedOut, true, 'the parked generator was released by a close, not by the fake\'s deadline')
      assert.equal(events.filter((e) => e.name === 'error' || e.name === 'result').length, 0, 'nothing was emitted on the destroyed session')
      assert.equal(session._turnInput, null)
    })

    it('still surfaces an error after the close when it is not the close\'s own abort', async () => {
      const events = capture(session)
      state.closeIneffective = true
      wire(session, launchScript(), state)
      await session.sendMessage('start a background count')
      assert.equal(state.closeCalls, 1)
      assert.equal(state.parkTimedOut, true)
      const errs = events.filter((e) => e.name === 'error')
      assert.deepEqual(errs.map((e) => e.code), ['background_task_ended_with_turn', undefined], 'the background loss, then the real failure — not swallowed as a close abort')
      assert.match(errs[1].message, /never closed the query/)
    })

    it('says so when the CLI could not stop the task', async () => {
      const events = capture(session)
      state.stopTaskFails = true
      wire(session, launchScript(), state)
      await session.sendMessage('start a background count')
      const loss = events.filter((e) => e.name === 'error')
      assert.equal(loss.length, 1)
      assert.equal(loss[0].stopped, false)
      assert.match(loss[0].message, /could not be stopped; it may still be running/)
      assert.equal(state.closeCalls, 1, 'the query is still closed')
    })

    // A node:test timeout, so an UNBOUNDED stop fails this test instead of
    // hanging the runner (the hung fake stopTask never resolves).
    it('reports a task the CLI never answered the stop for, within the bounded wait', { timeout: 3000 }, async () => {
      const defaultStop = SdkSession.STOP_TASK_TIMEOUT_MS
      SdkSession.STOP_TASK_TIMEOUT_MS = 40
      try {
        const events = capture(session)
        state.stopTaskHangs = true
        wire(session, launchScript(), state)
        const t0 = Date.now()
        await session.sendMessage('start a background count')
        assert.ok(Date.now() - t0 < 2000, 'the hung stop did not hold the turn past the bound')
        const loss = events.filter((e) => e.name === 'error')
        assert.equal(loss.length, 1)
        assert.equal(loss[0].stopped, false)
        assert.equal(state.closeCalls, 1)
      } finally {
        SdkSession.STOP_TASK_TIMEOUT_MS = defaultStop
      }
    })

    it('counts a local_bash task as live when the tool_result announced its shell, even without the backgrounded flag', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-sh', 'Bash'),
        assistantToolUse('tu-sh', 'Bash', { command: 'sleep 30', run_in_background: true }),
        { type: 'system', subtype: 'task_started', task_id: 'sh-2', tool_use_id: 'tu-sh', task_type: 'local_bash', description: 'sleep 30' },
        toolResult('tu-sh', 'Command running in background with ID: sh-2'),
        promptResult(2),
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('bg without the flag')
      assert.deepEqual(events.filter((e) => e.name === 'error').map((e) => e.taskId), ['sh-2'])
      assert.equal(state.closeCalls, 1)
      assert.equal(session._pendingBackgroundShells.has('sh-2'), false)
    })

    it('is not reported when the task finished before the result', async () => {
      const events = capture(session)
      wire(session, launchScript([
        { type: 'system', subtype: 'task_notification', task_id: 't-1', tool_use_id: 'tu-agent', status: 'completed', output_file: '/tmp/out', summary: 'done' },
      ]).filter((s) => !s?.__parkUntilClosed), state)

      await session.sendMessage('start a background count')

      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      assert.equal(state.closeCalls, undefined, 'no close: the process goes idle on its own')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
    })

    it('does not count a foreground task the CLI never backgrounded', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-fg', 'Agent'),
        { type: 'system', subtype: 'task_started', task_id: 't-fg', tool_use_id: 'tu-fg', task_type: 'local_agent', description: 'inline' },
        toolResult('tu-fg', 'result text'),
        promptResult(2),
      ], state)
      await session.sendMessage('inline agent')
      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      assert.equal(state.closeCalls, undefined)
    })

    it('does not count a foreground Bash, which the CLI also reports as a local_bash task', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-fg', 'Bash'),
        { type: 'system', subtype: 'task_started', task_id: 'sh-fg', tool_use_id: 'tu-fg', task_type: 'local_bash', is_backgrounded: false, description: 'sleep 5' },
        toolResult('tu-fg', 'done-fg'),
        promptResult(2),
      ], state)
      await session.sendMessage('foreground sleep')
      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      assert.equal(state.closeCalls, undefined)
      assert.equal(state.stopCalls, undefined)
    })

    it('counts a task backgrounded later by a task_updated patch, and drops one the patch closes', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-a', 'Agent'),
        { type: 'system', subtype: 'task_started', task_id: 't-a', tool_use_id: 'tu-a', task_type: 'local_agent', description: 'later backgrounded' },
        { type: 'system', subtype: 'task_updated', task_id: 't-a', patch: { is_backgrounded: true } },
        toolUseStart('tu-b', 'Agent'),
        { type: 'system', subtype: 'task_started', task_id: 't-b', tool_use_id: 'tu-b', task_type: 'local_agent', is_backgrounded: true, description: 'closed by patch' },
        { type: 'system', subtype: 'task_updated', task_id: 't-b', patch: { status: 'completed' } },
        promptResult(2),
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('agents')
      const loss = events.filter((e) => e.name === 'error')
      assert.deepEqual(loss.map((e) => e.taskId), ['t-a'])
      assert.deepEqual(state.stopCalls.map((c) => c.taskId), ['t-a'])
    })

    it('never reports ambient skip_transcript work the user did not start', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_started', task_id: 't-ambient', task_type: 'local_agent', is_backgrounded: true, skip_transcript: true, description: 'housekeeping' },
        assistantText('ok'),
        promptResult(1),
      ], state)
      await session.sendMessage('hi')
      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      assert.equal(state.closeCalls, undefined)
    })

    it('counts a background shell (local_bash) as live work and names it a shell', async () => {
      const events = capture(session)
      let trackedMidTurn = null
      wire(session, [
        init(),
        toolUseStart('tu-sh', 'Bash'),
        assistantToolUse('tu-sh', 'Bash', { command: 'sleep 30; echo done', run_in_background: true }),
        { type: 'system', subtype: 'task_started', task_id: 'sh-1', tool_use_id: 'tu-sh', task_type: 'local_bash', is_backgrounded: true, description: 'sleep 30; echo done' },
        toolResult('tu-sh', 'Command running in background with ID: sh-1'),
        () => { trackedMidTurn = session._pendingBackgroundShells.has('sh-1') },
        assistantText('started'),
        promptResult(2),
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('run a background sleep')
      const loss = events.filter((e) => e.name === 'error')
      assert.equal(loss.length, 1)
      assert.equal(loss[0].code, 'background_task_ended_with_turn')
      assert.match(loss[0].message, /^Background shell "sleep 30; echo done"/)
      assert.equal(state.closeCalls, 1)
      assert.equal(trackedMidTurn, true, 'the shell was tracked as pending work while the turn ran')
      assert.equal(session._pendingBackgroundShells.has('sh-1'), false, 'the stopped shell no longer keeps the session busy')
    })

    it('never reports a roster entry this turn did not see start', async () => {
      session._liveBackgroundTasks.set('stale', { taskId: 'stale', toolUseId: 'x', taskType: 'local_agent', description: 'old', background: true })
      const events = capture(session)
      wire(session, [init(), promptResult(1)], state)
      await session.sendMessage('hi')
      assert.equal(events.filter((e) => e.name === 'error').length, 0, 'a task from a previous process is not reported against this turn')
      assert.equal(state.closeCalls, undefined)
      assert.equal(state.stopCalls, undefined)
    })
  })

  describe('a tool_result carrying the CLI\'s own cancellation text', () => {
    for (const [label, text] of [['bypass/Auto spelling', CANCELLED_TEXT], ['Approve spelling', STREAM_CLOSED_TEXT]]) {
      it(`is surfaced as a session error naming the tool and its id (${label})`, async () => {
        const events = capture(session)
        wire(session, [
          init(),
          toolUseStart('tu-1', 'Read'),
          toolResult('tu-1', text, true),
          assistantText('I have stopped.'),
          promptResult(2),
        ], state)

        await session.sendMessage('read it')

        const errs = events.filter((e) => e.name === 'error')
        assert.equal(errs.length, 1)
        assert.equal(errs[0].code, 'tool_cancelled_by_provider')
        assert.equal(errs[0].tool, 'Read')
        assert.equal(errs[0].toolUseId, 'tu-1')
        assert.ok(errs[0].message.includes('Read') && errs[0].message.includes('tu-1'))
        const tr = events.find((e) => e.name === 'tool_result' && e.toolUseId === 'tu-1')
        assert.ok(tr, 'the tool_result still closes the tool_start')
        assert.equal(tr.isError, true, 'and is flagged, never a plain result')
        const order = events.map((e) => e.name)
        assert.ok(order.indexOf('error') < order.indexOf('tool_result'), 'the error precedes the flagged result')
      })
    }

    it('leaves an ordinary failed tool_result alone (flagged, no session error)', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-1', 'Read'),
        toolResult('tu-1', 'File does not exist: /tmp/nope', true),
        promptResult(2),
      ], state)
      await session.sendMessage('read it')
      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      const tr = events.find((e) => e.name === 'tool_result')
      assert.equal(tr.isError, true)
    })

    it('ignores a tool\'s own output that merely starts with the sentence (no is_error)', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-1', 'Bash'),
        toolResult('tu-1', `${CANCELLED_TEXT}\n(echoed by the command)`),
        promptResult(2),
      ], state)
      await session.sendMessage('echo it')
      assert.equal(events.filter((e) => e.name === 'error').length, 0)
      const tr = events.find((e) => e.name === 'tool_result')
      assert.equal(tr.isError, undefined)
    })

    it('matches on the content-block spelling too', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-1', 'Bash'),
        toolResult('tu-1', [{ type: 'text', text: CANCELLED_TEXT }], true),
        promptResult(2),
      ], state)
      await session.sendMessage('run it')
      assert.equal(events.filter((e) => e.name === 'error' && e.code === 'tool_cancelled_by_provider').length, 1)
    })
  })

  describe('the input is released on every exit', () => {
    it('when the query throws mid-turn', async () => {
      const events = capture(session)
      wire(session, [init(), { __throw: new Error('boom') }], state)
      await session.sendMessage('hi')
      await settled(state)
      assert.equal(state.inputEnded, true)
      assert.ok(events.some((e) => e.name === 'error' && /boom/.test(e.message)))
      assert.equal(session._isBusy, false)
    })

    it('when the session is destroyed mid-turn, without waiting for the loop', async () => {
      wire(session, [
        init(),
        () => { session.destroy() },
        // The real generator stays parked until stdin closes.
        { __waitInputEnd: true },
        assistantText('late'),
      ], state)
      await session.sendMessage('hi')
      await settled(state)
      assert.equal(state.inputEnded, true, 'destroy() released the input directly')
      assert.equal(session._turnInput, null)
    })
  })

  describe('a turn superseded during its stops', () => {
    it('reports its own loss and result but leaves the newer turn\'s busy state alone', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      state.stopDelayMs = 80
      const events = capture(session)
      const bState = {}
      let bQuery = null
      let bBusyAfterA = null
      let bPromise = null
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_started', task_id: 't-x', tool_use_id: 'tu-x', task_type: 'local_agent', is_backgrounded: true, description: 'x' },
        orphanNotice,
        // Past the window: the timer's finish is awaiting the slow stop. A
        // hard timeout clears busy and a follow-up turn starts meanwhile.
        { __delayMs: 50 },
        () => {
          session._handleHardTimeout(session._currentMessageId, false)
          session._callQuery = (bArgs) => {
            consumeInput(bArgs.prompt, bState)
            bQuery = fakeQuery([init('sdk-2'), { __delayMs: 120 }, () => { bBusyAfterA = session._isBusy }, promptResult(1)], bState)
            return bQuery
          }
          bPromise = session.sendMessage('B')
        },
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('A')
      await bPromise
      assert.equal(bBusyAfterA, true, 'A\'s finish did not clear B\'s busy state')
      assert.equal(state.closeCalls, 1, 'A closed its own query')
      assert.equal(bState.closeCalls, undefined, 'and never B\'s')
      assert.ok(events.some((e) => e.name === 'error' && e.code === 'background_task_ended_with_turn'))
    })

    it('leaves the successor\'s task roster and in-flight tools alone, and stays superseded after the successor ends', async () => {
      SdkSession.ORPHAN_NOTICE_CONFIRM_MS = 30
      state.stopDelayMs = 80
      const events = capture(session)
      const bState = {}
      let rosterDuringB = null
      let bPromise = null
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_started', task_id: 't-x', tool_use_id: 'tu-x', task_type: 'local_agent', is_backgrounded: true, description: 'x' },
        orphanNotice,
        // The successor starts INSIDE the hold window (a hard timeout cleared
        // busy), so its roster entry exists when A's finish runs at expiry.
        { __delayMs: 10 },
        () => {
          session._handleHardTimeout(session._currentMessageId, false)
          session._callQuery = (bArgs) => {
            consumeInput(bArgs.prompt, bState)
            return fakeQuery([
              init('sdk-2'),
              toolUseStart('tu-B', 'Read'),
              { type: 'system', subtype: 'task_started', task_id: 't-B', tool_use_id: 'tu-B2', task_type: 'local_agent', is_backgrounded: true, description: 'B work' },
              { __delayMs: 160 },
              () => { rosterDuringB = [...session._liveBackgroundTasks.keys()] },
              toolResult('tu-B', 'ok'),
              { type: 'system', subtype: 'task_notification', task_id: 't-B', status: 'completed', output_file: '/tmp/o', summary: 'done' },
              promptResult(2),
            ], bState)
          }
          bPromise = session.sendMessage('B')
        },
        { __parkUntilClosed: true },
      ], state)
      await session.sendMessage('A')
      await bPromise
      assert.deepEqual(rosterDuringB, ['t-B'], 'A\'s finish removed only its own task')
      const synthetic = events.filter((e) => e.name === 'tool_result' && e.toolUseId === 'tu-B' && e.isError === true)
      assert.equal(synthetic.length, 0, 'A\'s result did not sweep B\'s running tool as failed')
      assert.equal(events.filter((e) => e.name === 'result').length, 2, 'both turns reported, once each')
      assert.equal(session._isBusy, false)
    })
  })

  describe('a follow-up turn while the previous query drains', () => {
    it('keeps its own query handle when the previous turn\'s finally runs', async () => {
      const aState = state
      const bState = {}
      let bQuery = null
      let handleDuringB = 'unset'
      let bPromise = null
      // Turn A: result, then the generator lingers (draining) for a moment.
      session._callQuery = (args) => {
        aState.args = args
        consumeInput(args.prompt, aState)
        return fakeQuery([
          init(),
          promptResult(1),
          () => {
            // A's result cleared busy; a follow-up starts while A still drains.
            session._callQuery = (bArgs) => {
              consumeInput(bArgs.prompt, bState)
              bQuery = fakeQuery([
                init(),
                { __delayMs: 60 },
                () => { handleDuringB = session._query === bQuery ? 'own' : (session._query === null ? 'null' : 'other') },
                promptResult(1),
              ], bState)
              return bQuery
            }
            bPromise = session.sendMessage('B')
          },
          { __delayMs: 20 },
        ], aState)
      }
      await session.sendMessage('A')
      await bPromise
      assert.equal(handleDuringB, 'own', 'A\'s finally must not erase B\'s query handle')
      assert.equal(session._query, null, 'B\'s own finally clears it at the end')
      assert.equal(bState.inputEnded, true)
    })
  })

  // #8302 — a tracked background shell must not outlive the process that could
  // report on it. `isRunning` is `_isBusy || shells.size > 0`, and current Claude
  // Code has no `BashOutput` tool, so the acknowledgement clear can never fire:
  // before this, a shell that completed or died any way but the turn's own stop
  // pass read the session busy ("Working") forever while idle.
  describe('background shells are released when their owner is gone (#8302)', () => {
    const shellScript = (id, ...afterAnnounce) => [
      init(),
      toolUseStart(`tu-${id}`, 'Bash'),
      assistantToolUse(`tu-${id}`, 'Bash', { command: 'sleep 30', run_in_background: true }),
      { type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `tu-${id}`, task_type: 'local_bash', is_backgrounded: true, description: 'sleep 30' },
      toolResult(`tu-${id}`, `Command running in background with ID: ${id}`),
      ...afterAnnounce,
    ]
    const changes = (s) => {
      const seen = []
      s.on('background_work_changed', (d) => seen.push(d.pending.map((p) => p.shellId)))
      return seen
    }

    it('task_notification closes the shell, so the session is idle once the turn is', async () => {
      const midTurn = []
      const seen = changes(session)
      const events = capture(session)
      wire(session, shellScript('sh-n',
        () => midTurn.push(['tracked', session._pendingBackgroundShells.has('sh-n'), session.isRunning]),
        { type: 'system', subtype: 'task_notification', task_id: 'sh-n', tool_use_id: 'tu-sh-n', status: 'completed', output_file: '/tmp/o', summary: 'done' },
        () => midTurn.push(['after notification', session._pendingBackgroundShells.has('sh-n')]),
        assistantText('the shell finished'),
        promptResult(2),
      ), state)
      await session.sendMessage('run it')
      assert.deepEqual(midTurn, [['tracked', true, true], ['after notification', false]], 'tracked while it ran, released by its own notification')
      assert.equal(session.isRunning, false)
      assert.deepEqual(seen, [['sh-n'], []], 'clients were told it started and that it ended')
      assert.equal(events.filter((e) => e.name === 'error').length, 0, 'it had finished, so nothing is reported as lost')
      assert.equal(state.closeCalls, undefined)
    })

    for (const status of ['completed', 'failed', 'killed']) {
      it(`a task_updated patch with status "${status}" closes the shell`, async () => {
        const midTurn = []
        wire(session, shellScript('sh-u',
          { type: 'system', subtype: 'task_updated', task_id: 'sh-u', patch: { status } },
          () => midTurn.push(session._pendingBackgroundShells.has('sh-u')),
          promptResult(2),
        ), state)
        await session.sendMessage('run it')
        assert.deepEqual(midTurn, [false])
        assert.equal(session.isRunning, false)
      })
    }

    it('a non-terminal task_updated patch leaves the shell tracked while the turn runs', async () => {
      const midTurn = []
      capture(session) // the turn ends with the shell still running: its loss is reported as an error event
      wire(session, shellScript('sh-r',
        { type: 'system', subtype: 'task_updated', task_id: 'sh-r', patch: { status: 'running', description: 'still going' } },
        () => midTurn.push([session._pendingBackgroundShells.has('sh-r'), session.isRunning]),
        promptResult(2),
        { __parkUntilClosed: true },
      ), state)
      await session.sendMessage('run it')
      assert.deepEqual(midTurn, [[true, true]], 'a shell still running mid-turn is never reaped')
    })

    it('a terminal task_updated closes a shell whose task was never on the live roster (skip_transcript)', async () => {
      wire(session, [
        init(),
        toolUseStart('tu-q', 'Bash'),
        assistantToolUse('tu-q', 'Bash', { command: 'tail -f x', run_in_background: true }),
        { type: 'system', subtype: 'task_started', task_id: 'sh-q', tool_use_id: 'tu-q', task_type: 'local_bash', is_backgrounded: true, skip_transcript: true, description: 'tail' },
        toolResult('tu-q', 'Command running in background with ID: sh-q'),
        () => { assert.equal(session._liveBackgroundTasks.has('sh-q'), false, 'precondition: not on the roster') },
        { type: 'system', subtype: 'task_updated', task_id: 'sh-q', patch: { status: 'completed' } },
        () => { assert.equal(session._pendingBackgroundShells.has('sh-q'), false) },
        promptResult(2),
      ], state)
      await session.sendMessage('run it')
      assert.equal(session.isRunning, false)
    })

    it('a notification for a task that is not a tracked shell is a no-op', async () => {
      session.trackBackgroundShell({ shellId: 'other' })
      wire(session, [
        init(),
        { type: 'system', subtype: 'task_notification', task_id: 'unrelated-agent', tool_use_id: 'tu-a', status: 'completed', output_file: '/tmp/o', summary: 'done' },
        promptResult(1),
      ], state)
      await session.sendMessage('hi')
      assert.equal(session._pendingBackgroundShells.has('other'), true, 'only the notified id is released')
    })

    it('releases a shell nothing ever reported on (no task_started, no notification) when the turn ends', async () => {
      const seen = changes(session)
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-z', 'Bash'),
        assistantToolUse('tu-z', 'Bash', { command: 'sleep 30', run_in_background: true }),
        toolResult('tu-z', 'Command running in background with ID: sh-z'),
        () => { assert.equal(session.isRunning, true, 'busy while its turn is running') },
        assistantText('started'),
        promptResult(2),
      ], state)
      await session.sendMessage('run it')
      assert.equal(session._pendingBackgroundShells.size, 0, 'its process ended with the turn; nothing can report on it')
      assert.equal(session.isRunning, false)
      assert.deepEqual(seen, [['sh-z'], []])
      const order = events.map((e) => e.name)
      assert.ok(order.includes('result'))
    })

    it('releases it before the turn\'s result is emitted, so the result snapshot carries no shell', async () => {
      let atResult = null
      session.on('result', () => { atResult = session._pendingBackgroundShells.size })
      // No task_started names the shell, so no live task reaches the stop pass:
      // only the turn-end release can have cleared it by the time `result` fires.
      wire(session, [
        init(),
        toolUseStart('tu-w', 'Bash'),
        assistantToolUse('tu-w', 'Bash', { command: 'sleep 30', run_in_background: true }),
        toolResult('tu-w', 'Command running in background with ID: sh-w'),
        assistantText('x'),
        promptResult(2),
      ], state)
      await session.sendMessage('run it')
      assert.equal(atResult, 0)
    })

    it('releases it when the turn ends by throwing', async () => {
      const events = capture(session)
      wire(session, [
        ...shellScript('sh-t'),
        { __throw: new Error('process exited with code 1') },
      ], state)
      await session.sendMessage('run it')
      assert.ok(events.some((e) => e.name === 'error'), 'the failure is still surfaced')
      assert.equal(session._pendingBackgroundShells.has('sh-t'), false)
      assert.equal(session.isRunning, false)
    })

    it('does not release a shell this turn did not start', async () => {
      // e.g. a shell the successor of a superseded turn tracked: the id is not in
      // THIS turn's set, so its end must leave it alone.
      session.trackBackgroundShell({ shellId: 'foreign' })
      capture(session)
      wire(session, shellScript('sh-own', promptResult(2), { __parkUntilClosed: true }), state)
      await session.sendMessage('run it')
      assert.equal(session._pendingBackgroundShells.has('sh-own'), false)
      assert.equal(session._pendingBackgroundShells.has('foreign'), true)
      assert.equal(session.isRunning, true, 'the foreign shell still holds the session busy')
    })

    it('does not reap a shell belonging to the turn that is still running', async () => {
      // Turn A ends while turn B (started in A's drain) has a shell tracked.
      const bState = {}
      let bPromise = null
      const bSawShell = []
      capture(session)
      wire(session, [
        init(),
        promptResult(1),
        () => {
          session._callQuery = (bArgs) => {
            consumeInput(bArgs.prompt, bState)
            return fakeQuery(shellScript('sh-b',
              { __delayMs: 60 },
              () => bSawShell.push(session._pendingBackgroundShells.has('sh-b')),
              promptResult(2),
              { __parkUntilClosed: true }), bState)
          }
          bPromise = session.sendMessage('B')
        },
        { __delayMs: 100 },
      ], state)
      await session.sendMessage('A')
      await bPromise
      assert.deepEqual(bSawShell, [true], 'A\'s end did not release B\'s shell while B was running')
    })
  })

  describe('isSdkToolCancellationText', () => {
    it('matches both CLI spellings, with leading whitespace, and nothing else', () => {
      assert.equal(SDK_TOOL_CANCELLED_PREFIXES.length, 2)
      assert.equal(isSdkToolCancellationText(CANCELLED_TEXT), true)
      assert.equal(isSdkToolCancellationText(`\n  ${STREAM_CLOSED_TEXT}`), true)
      assert.equal(isSdkToolCancellationText('Permission denied by user'), false)
      assert.equal(isSdkToolCancellationText('The user asked for a different file'), false)
      assert.equal(isSdkToolCancellationText(''), false)
      assert.equal(isSdkToolCancellationText(null), false)
      assert.equal(isSdkToolCancellationText({ text: CANCELLED_TEXT }), false)
    })
  })
})
