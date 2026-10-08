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
  session._callQuery = () => {
    const gen = body({ session, signal: controller.signal, requests })
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
