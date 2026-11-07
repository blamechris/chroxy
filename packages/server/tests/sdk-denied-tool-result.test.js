import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SdkSession } from '../src/sdk-session.js'

/**
 * #8936 -- a tool the user refused on claude-sdk must read as a short
 * user-facing sentence, not as the SDK's model-facing refusal boilerplate.
 * Drives the real turn loop with a fake query (same shape as
 * sdk-stop-during-pending-permission.test.js). No SDK session is started.
 */

const SDK_DENY_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const writeStart = {
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_w', name: 'Write', input: {} } },
}
const okResult = { type: 'result', session_id: 'sess-x', total_cost_usd: 0, duration_ms: 5, usage: {} }
const toolResult = (text, isError = true) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w', is_error: isError, content: text }] },
})

function harness(body) {
  const session = new SdkSession({ cwd: '/tmp' })
  session._processReady = true
  const results = []
  const requests = []
  session.on('tool_result', (d) => results.push(d))
  session.on('permission_request', (d) => requests.push(d))
  const controller = new AbortController()
  session._callQuery = () => {
    const gen = body({ session, signal: controller.signal, requests })
    gen.interrupt = async () => controller.abort()
    return gen
  }
  return { session, results }
}

async function run(body) {
  const h = harness(body)
  await h.session.sendMessage('go')
  h.session.destroy()
  return h.results
}

describe('SdkSession -- denied tool result (#8936)', () => {
  it('replaces the SDK refusal boilerplate with the denial\'s own short sentence', async () => {
    const results = await run((ctx) => (async function* () {
      yield writeStart
      const d = ctx.session._handlePermission('Write', { file_path: '/tmp/x', content: 'y' }, ctx.signal, undefined, 'toolu_w')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny')
      await d
      yield toolResult(SDK_DENY_TEXT)
      yield okResult
    })())
    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'User denied')
    assert.equal(results[0].isError, true)
    assert.equal(results[0].truncated, false)
    assert.equal('terminatedReason' in results[0], false)
  })

  it('shows the operator\'s own deny reason', async () => {
    const results = await run((ctx) => (async function* () {
      yield writeStart
      const d = ctx.session._handlePermission('Write', { file_path: '/tmp/x', content: 'y' }, ctx.signal, undefined, 'toolu_w')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, 'use a temp file instead')
      await d
      yield toolResult(SDK_DENY_TEXT)
      yield okResult
    })())
    assert.equal(results[0].result, 'use a temp file instead')
  })

  it('falls back to a generic sentence when no decision of this session explains the refusal', async () => {
    const results = await run(() => (async function* () {
      yield writeStart
      yield toolResult(SDK_DENY_TEXT)
      yield okResult
    })())
    assert.equal(results[0].result, 'Tool use was denied.')
    assert.ok(!/STOP what you are doing/.test(results[0].result), 'boilerplate leaked')
  })

  it('CONTROL: a real tool error still reads as the error', async () => {
    const results = await run(() => (async function* () {
      yield writeStart
      yield toolResult('EACCES: permission denied, open /etc/x')
      yield okResult
    })())
    assert.equal(results[0].result, 'EACCES: permission denied, open /etc/x')
    assert.equal(results[0].isError, true)
  })

  it('CONTROL: a successful result that starts with the sentence is left alone', async () => {
    const results = await run((ctx) => (async function* () {
      yield writeStart
      const d = ctx.session._handlePermission('Write', { file_path: '/tmp/x', content: 'y' }, ctx.signal, undefined, 'toolu_w')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'allow')
      await d
      yield toolResult(SDK_DENY_TEXT, false)
      yield okResult
    })())
    assert.equal(results[0].result, SDK_DENY_TEXT)
    assert.equal('isError' in results[0], false)
  })

  it('CONTROL: a Stop-cancelled prompt keeps its stopped wording, not the denial sentence', async () => {
    const results = await run((ctx) => (async function* () {
      yield writeStart
      const d = ctx.session._handlePermission('Write', { file_path: '/tmp/x', content: 'y' }, ctx.signal, undefined, 'toolu_w')
      ctx.session.markUserStopInFlight()
      await ctx.session.interrupt()
      await d
      yield toolResult(SDK_DENY_TEXT)
      yield okResult
    })())
    assert.equal(results[0].terminatedReason, 'user_stop_before_run')
    assert.ok(/^Stopped before this tool ran/.test(results[0].result), results[0].result)
  })
})
