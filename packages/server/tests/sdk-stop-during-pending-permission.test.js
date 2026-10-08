import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SdkSession } from '../src/sdk-session.js'

/**
 * #8363 -- pressing Stop while a claude-sdk tool's permission prompt is pending.
 *
 * The SDK resolves that prompt as a denial and writes its OWN tool_result, whose
 * text says the user did not want to proceed. Nobody refused anything: the user
 * pressed Stop and never answered. The result must be tagged as a Stop (the
 * `terminatedReason` machinery from #7376) so the tool row reads "stopped", while
 * a real Deny keeps reading as a deny.
 *
 * Drives the REAL turn loop (`sendMessage` -> `_callQuery` -> the for-await) with
 * a fake query, the same way terminated-tool-result-other-providers.test.js does.
 */

const SDK_DENY_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const bashStart = {
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: {} } },
}
const okResult = { type: 'result', session_id: 'sess-x', total_cost_usd: 0, duration_ms: 5, usage: {} }
const denialResult = (text = SDK_DENY_TEXT) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p', is_error: true, content: text }] },
})

function harness(body, { abortOnInterrupt = true } = {}) {
  const session = new SdkSession({ cwd: '/tmp' })
  session._processReady = true
  const results = []
  const requests = []
  const errors = []
  session.on('tool_result', (d) => results.push(d))
  session.on('permission_request', (d) => requests.push(d))
  session.on('error', (d) => errors.push(d))
  const controller = new AbortController()
  const bodies = Array.isArray(body) ? [...body] : null
  session._callQuery = () => {
    const gen = (bodies ? bodies.shift() : body)({ session, signal: controller.signal, requests, abort: () => controller.abort() })
    // The real Query has interrupt(); the SDK aborts the canUseTool signal when
    // it is called. `abortOnInterrupt: false` models the other ordering, where
    // the provider's tool_result is read before the abort reaches this session.
    gen.interrupt = async () => { if (abortOnInterrupt) controller.abort() }
    return gen
  }
  return { session, results, requests, errors }
}

describe('SdkSession -- Stop during a pending permission (#8363)', () => {
  it('tags the SDK\'s denial result as a Stop, not as the user refusing', async () => {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      const decision = ctx.session._handlePermission('Bash', { command: 'rm -rf x' }, ctx.signal, undefined, 'toolu_p')
      await ctx.session.interrupt() // the user pressed Stop; the prompt is still pending
      assert.equal((await decision).behavior, 'deny')
      yield denialResult()
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal(results[0].toolUseId, 'toolu_p')
    assert.equal(results[0].terminatedReason, 'user_stop_before_run')
    assert.equal(results[0].isError, true)
    assert.equal(/doesn't want to proceed/.test(results[0].result), false, results[0].result)
    assert.ok(/^Stopped before this tool ran/.test(results[0].result), results[0].result)
  })

  it('still tags it when the provider\'s result is read BEFORE the abort reaches the session', async () => {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      await ctx.session.interrupt() // no abort: the signal has not fired yet
      yield denialResult()
      yield okResult
    })(), { abortOnInterrupt: false })
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results[0].terminatedReason, 'user_stop_before_run')
  })

  it('does not report the Stop-cancelled call as a provider-side cancellation fault', async () => {
    const { session, errors } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      await ctx.session.interrupt()
      yield denialResult("The user doesn't want to take this action right now. STOP what you are doing.")
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(errors.some((e) => e.code === 'tool_cancelled_by_provider'), false)
  })

  it('CONTROL: a real Deny keeps reading as a deny (no termination reason, SDK text intact)', async () => {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      const decision = ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny')
      assert.equal((await decision).behavior, 'deny')
      yield denialResult()
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].isError, true)
    assert.equal(results[0].result, SDK_DENY_TEXT)
  })

  it('CONTROL: an error on a call whose prompt was approved before Stop is the tool\'s own failure', async () => {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      const decision = ctx.session._handlePermission('Bash', { command: 'false' }, ctx.signal, undefined, 'toolu_p')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'allow')
      assert.equal((await decision).behavior, 'allow')
      await ctx.session.interrupt() // Stop comes after the user approved it
      yield denialResult('Exit code 1')
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].result, 'Exit code 1')
  })

  it('CONTROL: an approval that races the Stop and lands first keeps the real result', async () => {
    // Stop snapshots the call as pending; the user's Allow then settles it before
    // the abort. The tool may run, so its result must not be relabelled.
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      const decision = ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      const stop = ctx.session.interrupt()
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'allow')
      await stop
      assert.equal((await decision).behavior, 'allow')
      yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p', is_error: true, content: 'boom' }] } }
      yield okResult
    })(), { abortOnInterrupt: false })
    await session.sendMessage('go')
    session.destroy()
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].result, 'boom')
  })

  it('CONTROL: a Deny followed by Stop in the same synchronous tick stays a deny (the scheduler does this)', async () => {
    // respondToPermission settles the prompt at once; the id leaves the tracking
    // set a microtask later. A Stop in that window must not claim the call.
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      const decision = ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny')
      const stop = ctx.session.interrupt() // same tick: no await in between
      await stop
      assert.equal((await decision).behavior, 'deny')
      yield denialResult()
      yield okResult
    })(), { abortOnInterrupt: false })
    await session.sendMessage('go')
    session.destroy()
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].result, SDK_DENY_TEXT)
  })

  it('a Stop-cancelled id left over from an earlier turn does not tag a later turn\'s error', async () => {
    // Turn 1: Stop cancels the prompt but the provider never writes a result for
    // it, so the id is never consumed. Turn 2 reuses the id with a genuine error.
    const { session, results } = harness([
      (ctx) => (async function* () {
        yield bashStart
        ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
        await ctx.session.interrupt()
        yield okResult
      })(),
      () => (async function* () {
        yield bashStart
        yield denialResult('Exit code 3')
        yield okResult
      })(),
    ])
    await session.sendMessage('first')
    results.length = 0
    await session.sendMessage('second')
    session.destroy()
    assert.equal(results.length, 1)
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].result, 'Exit code 3')
  })

  it('tags the Stop-cancelled call once: a second error result for the same id is left alone', async () => {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      await ctx.session.interrupt()
      yield denialResult()
      yield denialResult('Exit code 4')
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal(results.length, 2)
    assert.equal(results[0].terminatedReason, 'user_stop_before_run')
    assert.equal('terminatedReason' in results[1], false)
    assert.equal(results[1].result, 'Exit code 4')
  })

  it('only an ERROR result for a Stop-cancelled call is relabelled; a normal result is left alone', async () => {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'ls' }, ctx.signal, undefined, 'toolu_p')
      await ctx.session.interrupt()
      yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p', content: 'file1\nfile2' }] } }
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].result, 'file1\nfile2')
    assert.notEqual(results[0].isError, true)
  })

  it('CONTROL: an error result with no Stop at all is untouched', async () => {
    const { session, results } = harness(() => (async function* () {
      yield bashStart
      yield denialResult('Exit code 2')
      yield okResult
    })())
    await session.sendMessage('go')
    session.destroy()
    assert.equal('terminatedReason' in results[0], false)
    assert.equal(results[0].result, 'Exit code 2')
  })
})

/**
 * #8430 -- a prompt raised BETWEEN the user's Stop and the SDK's abort.
 *
 * `interrupt()` awaits `query.interrupt()`, and a parallel tool's canUseTool can land in
 * that window. The prompt that was open at the Stop was marked; this one was not, so the
 * same Stop's abort resolved it as `aborted` (read: expired). The user's Stop is a
 * session-level fact that lasts to the end of the turn.
 */
describe('SdkSession -- a prompt raised after the user\'s Stop, before the abort (#8430)', () => {
  // The model of the window: the SDK aborts the canUseTool signal only when the test says so.
  function lateHarness(afterStop, { userStop = true } = {}) {
    const { session, results, requests } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'first' }, ctx.signal, undefined, 'toolu_p')
      const stop = userStop ? (ctx.session.markUserStopInFlight(), ctx.session.interrupt()) : ctx.session.interrupt()
      // the SDK has not aborted yet: a parallel tool asks now
      ctx.session._handlePermission('Bash', { command: 'second' }, ctx.signal, undefined, 'toolu_q')
      await afterStop(ctx)
      await stop
      yield denialResult()
      yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', is_error: true, content: SDK_DENY_TEXT }] } }
      yield okResult
    })(), { abortOnInterrupt: false })
    const resolved = []
    session._permissions.on('permission_resolved', (d) => resolved.push(d))
    return { session, results, requests, resolved }
  }
  const abortNow = (ctx) => { ctx.abort() }

  it('both prompts read stopped, and both tool rows read stopped', async () => {
    const { session, results, resolved } = lateHarness(abortNow)
    await session.sendMessage('go')
    session.destroy()
    assert.deepEqual(resolved.map((r) => r.reason), ['stopped', 'stopped'])
    assert.deepEqual(results.map((r) => r.terminatedReason), ['user_stop_before_run', 'user_stop_before_run'])
  })

  it('CONTROL: with no user Stop (the scheduler\'s interrupt, a failed turn) the late prompt reads aborted', async () => {
    const { session, results, resolved } = lateHarness(abortNow, { userStop: false })
    await session.sendMessage('go')
    session.destroy()
    assert.deepEqual(resolved.map((r) => r.reason), ['aborted', 'aborted'])
    // the snapshot in interrupt() still covers the prompt open at the interrupt; the
    // late one was not resolved by a Stop, so its row is not relabelled
    const lateRow = results.find((r) => r.toolUseId === 'toolu_q')
    assert.equal('terminatedReason' in lateRow, false)
  })
})

describe('SdkSession -- a user Stop does not outlive its turn (#8430)', () => {
  // Turn 1 is stopped by the user and ends by `endTurn1`; turn 2 then fails a prompt
  // for a reason that is NOT a Stop (its signal is aborted by something else).
  async function runTwoTurns(endTurn1) {
    const { session } = harness([
      (ctx) => (async function* () {
        yield bashStart
        ctx.session._handlePermission('Bash', { command: 'one' }, ctx.signal, undefined, 'toolu_p')
        ctx.session.markUserStopInFlight()
        await ctx.session.interrupt()
        yield* endTurn1()
      })(),
      (ctx) => (async function* () {
        yield bashStart
        // fresh controller: turn 1's signal was already aborted by its Stop
        const failed = new AbortController()
        ctx.session._handlePermission('Bash', { command: 'two' }, failed.signal, undefined, 'toolu_q')
        failed.abort() // a turn failure, not the user
        yield okResult
      })(),
    ])
    const resolved = []
    session._permissions.on('permission_resolved', (d) => { if (d.reason !== 'cleared') resolved.push(d.reason) })
    session.on('error', () => {})
    await session.sendMessage('first')
    const afterFirst = session.isUserStopInFlight()
    resolved.length = 0
    await session.sendMessage('second')
    session.destroy()
    return { afterFirst, second: [...resolved] }
  }

  it('cleared when the stopped turn ends normally', async () => {
    const r = await runTwoTurns(async function* () { yield okResult })
    assert.equal(r.afterFirst, false)
    assert.deepEqual(r.second, ['aborted'])
  })

  it('cleared when the stopped turn ends on the abort the Stop caused', async () => {
    const r = await runTwoTurns(async function* () {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    })
    assert.equal(r.afterFirst, false)
    assert.deepEqual(r.second, ['aborted'])
  })

  it('cleared when the stopped turn ends on an error', async () => {
    const r = await runTwoTurns(async function* () { throw new Error('boom') })
    assert.equal(r.afterFirst, false)
    assert.deepEqual(r.second, ['aborted'])
  })

  it('a new turn starts clear even if the last one never reached its teardown (a superseded turn)', async () => {
    const { session } = harness((ctx) => (async function* () {
      yield bashStart
      const failed = new AbortController()
      ctx.session._handlePermission('Bash', { command: 'two' }, failed.signal, undefined, 'toolu_q')
      failed.abort()
      yield okResult
    })())
    const reasons = []
    session._permissions.on('permission_resolved', (d) => { if (d.reason !== 'cleared') reasons.push(d.reason) })
    session._permissions.markUserStopInFlight() // left behind by a turn that was superseded
    await session.sendMessage('go')
    session.destroy()
    assert.deepEqual(reasons, ['aborted'])
  })

  it('a Stop pressed with no turn running records nothing', () => {
    const session = new SdkSession({ cwd: '/tmp' })
    session.markUserStopInFlight()
    assert.equal(session.isUserStopInFlight(), false)
    session.destroy()
  })

  it('CONTROL: an interrupt that is not the user\'s Stop, with a prompt raised in its window, reads aborted', async () => {
    // acceptance 2 of #8430: no user Stop -> expired, however late the prompt is
    const { session } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'a' }, ctx.signal, undefined, 'toolu_p')
      const stop = ctx.session.interrupt() // the scheduler's interrupt: not a user Stop
      ctx.session._handlePermission('Bash', { command: 'b' }, ctx.signal, undefined, 'toolu_q')
      ctx.abort()
      await stop
      yield okResult
    })(), { abortOnInterrupt: false })
    const reasons = []
    session._permissions.on('permission_resolved', (d) => reasons.push(d.reason))
    await session.sendMessage('go')
    session.destroy()
    assert.deepEqual(reasons, ['aborted', 'aborted'])
  })
})

/**
 * #8430 -- the order a LIVE claude-sdk Stop actually takes.
 *
 * The permission manager's abort listener does not run first. The SDK's generator
 * throws AbortError, the turn ends through `_clearMessageState`, and the prompts
 * still open are resolved by `PermissionManager.clearAll()` with `reason: 'cleared'`
 * -- after the base teardown has already cleared the user-Stop flag. The journal
 * maps `cleared` to `expired` and the live card to a plain deny. No abort event
 * reaches the listener in this test, exactly as on the real daemon.
 */
describe('SdkSession -- a user Stop whose turn ends on the generator\'s AbortError (live order, #8430)', () => {
  function liveOrder({ userStop }) {
    const { session } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'one' }, ctx.signal, undefined, 'toolu_p')
      if (userStop) ctx.session.markUserStopInFlight()
      await ctx.session.interrupt() // abortOnInterrupt: false -> the signal never fires
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    })(), { abortOnInterrupt: false })
    const resolved = []
    session.on('permission_resolved', (d) => resolved.push(d))
    session.on('error', () => {})
    return { session, resolved }
  }

  it('the open prompt is resolved as stopped, on the live event too', async () => {
    const { session, resolved } = liveOrder({ userStop: true })
    await session.sendMessage('go')
    session.destroy()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].reason, 'stopped')
    assert.equal(resolved[0].decision, 'deny')
  })

  it('a prompt raised after the Stop still marks its tool row, when the teardown is what resolves it', async () => {
    const { session } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session.markUserStopInFlight()
      await ctx.session.interrupt()
      // raised in the window, after the snapshot in interrupt() was taken
      ctx.session._handlePermission('Bash', { command: 'late' }, ctx.signal, undefined, 'toolu_q')
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    })(), { abortOnInterrupt: false })
    const seen = []
    session._permissions.on('permission_resolved', (d) => seen.push(d))
    session.on('error', () => {})
    let marked
    const orig = session._clearMessageState.bind(session)
    session._clearMessageState = (...a) => { orig(...a); marked = session._stopCancelledToolUseIds.has('toolu_q') }
    await session.sendMessage('go')
    session.destroy()
    assert.equal(seen[0].reason, 'stopped')
    assert.equal(marked, true)
  })

  it('CONTROL: the same teardown with no user Stop (a turn failure) still reads cleared', async () => {
    const { session, resolved } = liveOrder({ userStop: false })
    await session.sendMessage('go')
    session.destroy()
    assert.deepEqual(resolved.map((r) => r.reason), ['cleared'])
  })

  it('the flag is gone afterwards, so the next turn\'s teardown reads cleared again', async () => {
    const { session, resolved } = liveOrder({ userStop: true })
    await session.sendMessage('go')
    assert.equal(session.isUserStopInFlight(), false)
    resolved.length = 0
    session._isBusy = true
    session._handlePermission('Bash', { command: 'two' }, new AbortController().signal, undefined, 'toolu_q')
    session._clearMessageState()
    session.destroy()
    assert.deepEqual(resolved.map((r) => r.reason), ['cleared'])
  })
})

describe('SdkSession -- only the Stop\'s own resolution marks a tool row stopped (#8430)', () => {
  // Prompt p is open at the user's Stop; prompt q is raised in the window, then
  // `decideQ` settles it by some means other than the Stop.
  async function windowRun(decideQ, { timeoutMs } = {}) {
    const { session, results } = harness((ctx) => (async function* () {
      yield bashStart
      ctx.session._handlePermission('Bash', { command: 'first' }, ctx.signal, undefined, 'toolu_p')
      const stop = (ctx.session.markUserStopInFlight(), ctx.session.interrupt())
      if (timeoutMs) ctx.session._permissions._timeoutMs = timeoutMs
      const late = ctx.session._handlePermission('Bash', { command: 'second' }, ctx.signal, undefined, 'toolu_q')
      await decideQ(ctx)
      await late
      ctx.abort()
      await stop
      yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', is_error: true, content: SDK_DENY_TEXT }] } }
      yield okResult
    })(), { abortOnInterrupt: false })
    await session.sendMessage('go')
    session.destroy()
    return results.find((r) => r.toolUseId === 'toolu_q')
  }

  it('an explicit Deny raised in the window keeps its denied row', async () => {
    const row = await windowRun((ctx) => ctx.session.respondToPermission(ctx.requests[1].requestId, 'deny'))
    assert.equal('terminatedReason' in row, false)
    assert.equal(row.result, SDK_DENY_TEXT)
  })

  it('a timeout raised in the window keeps its row', async () => {
    const row = await windowRun(async () => { await new Promise((r) => setTimeout(r, 40)) }, { timeoutMs: 10 })
    assert.equal('terminatedReason' in row, false)
  })

  it('a prompt the Stop itself resolves in the window is marked stopped', async () => {
    const row = await windowRun(async (ctx) => { ctx.abort() })
    assert.equal(row.terminatedReason, 'user_stop_before_run')
  })
})

describe('SdkSession -- a Stop with a prompt open after the turn already read as idle (#8430)', () => {
  it('is recorded: a stalled turn clears busy while its query can still raise a prompt', async () => {
    const session = new SdkSession({ cwd: '/tmp' })
    const reasons = []
    session._permissions.on('permission_resolved', (d) => reasons.push(d.reason))
    const ac = new AbortController()
    session._isBusy = false // _handleStreamStall has cleared it
    try {
      const decided = session._handlePermission('Bash', { command: 'ls' }, ac.signal, undefined, 'toolu_p')
      session.markUserStopInFlight()
      assert.equal(session.isUserStopInFlight(), true)
      ac.abort()
      await decided
      assert.deepEqual(reasons, ['stopped'])
    } finally {
      session.destroy() // a failing assertion must not leave the prompt's timer holding the runner open
    }
  })

  it('CONTROL: an idle session with nothing open records nothing', () => {
    const session = new SdkSession({ cwd: '/tmp' })
    session.markUserStopInFlight()
    assert.equal(session.isUserStopInFlight(), false)
    session.destroy()
  })
})
