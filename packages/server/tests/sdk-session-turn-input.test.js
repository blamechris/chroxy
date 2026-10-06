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
      if (step && step.__waitInputEnd) { await state.inputDone; continue }
      if (step && step.__parkUntilClosed) {
        if (closed) throw abortError()
        // Bounded: a session that never closes the query would otherwise park
        // this generator forever and the test would hang instead of failing.
        await new Promise((_, reject) => {
          rejectParked = reject
          setTimeout(() => reject(new Error('fake query: the session never closed the query, the process would have lingered')), 300)
        })
        continue
      }
      if (step && step.__throw) throw step.__throw
      yield step
    }
  })()
  const query = {
    [Symbol.asyncIterator]() { return gen },
    interrupt: async () => { state.interrupts = (state.interrupts || 0) + 1 },
    close: () => {
      state.closeCalls = (state.closeCalls || 0) + 1
      closed = true
      if (rejectParked) rejectParked(abortError())
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
      assert.ok(events.some((e) => e.name === 'agent_completed' && e.toolUseId === 'tu-agent'), 'the agent node is closed')
      assert.equal(events.filter((e) => e.name === 'result').length, 1)
      assert.ok(!events.some((e) => e.name === 'stopped'), 'the close is not reported as a user stop')
      const order = events.map((e) => e.name)
      assert.ok(order.indexOf('error') < order.indexOf('result'), 'the loss is reported inside the turn, before its result')
      assert.equal(state.inputEnded, true)
      assert.equal(session._isBusy, false)
      assert.equal(session._liveBackgroundTasks.size, 0)
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

    it('counts a background shell (local_bash) as live work and names it a shell', async () => {
      const events = capture(session)
      wire(session, [
        init(),
        toolUseStart('tu-sh', 'Bash'),
        assistantToolUse('tu-sh', 'Bash', { command: 'sleep 30; echo done', run_in_background: true }),
        { type: 'system', subtype: 'task_started', task_id: 'sh-1', tool_use_id: 'tu-sh', task_type: 'local_bash', description: 'sleep 30; echo done' },
        toolResult('tu-sh', 'Command running in background with ID: sh-1'),
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
    })

    it('starts every turn with an empty live-task roster', async () => {
      session._liveBackgroundTasks.set('stale', { taskId: 'stale', toolUseId: 'x', taskType: 'local_agent', description: 'old', background: true })
      const events = capture(session)
      wire(session, [init(), promptResult(1)], state)
      await session.sendMessage('hi')
      assert.equal(events.filter((e) => e.name === 'error').length, 0, 'a task from a previous process is not reported against this turn')
      assert.equal(state.closeCalls, undefined)
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
