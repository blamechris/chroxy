import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SdkSession } from '../src/sdk-session.js'
import { emitToolResults } from '../src/tool-result.js'

/**
 * #8936 -- a tool the user refused on claude-sdk must read as a short
 * user-facing sentence, not as the SDK's model-facing refusal text.
 * Drives the real turn loop with a fake query (same shape as
 * sdk-stop-during-pending-permission.test.js). No SDK session is started.
 */

const SDK_DENY_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const startOf = (id, name = 'Write') => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
})
const writeStart = startOf('toolu_w')
const okResult = { type: 'result', session_id: 'sess-x', total_cost_usd: 0, duration_ms: 5, usage: {} }
const toolResult = (text, isError = true, id = 'toolu_w') => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] },
})
const ask = (ctx, id = 'toolu_w') =>
  ctx.session._handlePermission('Write', { file_path: '/tmp/x', content: 'y' }, ctx.signal, undefined, id)

function harness(body) {
  const session = new SdkSession({ cwd: '/tmp' })
  session._processReady = true
  const results = []
  const requests = []
  session.on('tool_result', (d) => results.push(d))
  session.on('permission_request', (d) => requests.push(d))
  session.on('error', () => {}) // the #8300 cancellation text raises one
  const controller = new AbortController()
  const bodies = Array.isArray(body) ? [...body] : null
  session._callQuery = () => {
    const gen = (bodies ? bodies.shift() : body)({ session, signal: controller.signal, requests })
    gen.interrupt = async () => controller.abort()
    return gen
  }
  return { session, results }
}

async function run(body) {
  const h = harness(body)
  await h.session.sendMessage('go')
  if (Array.isArray(body) && body.length > 1) await h.session.sendMessage('again')
  h.session.destroy()
  return h.results
}

// One denied Write whose provider result carries `sentence`.
const deniedWith = (sentence, reason) => (ctx) => (async function* () {
  yield writeStart
  const d = ask(ctx)
  ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, reason)
  await d
  yield toolResult(sentence)
  yield okResult
})()

describe('SdkSession -- denied tool result (#8936)', () => {
  it('replaces the SDK refusal boilerplate with the denial\'s own short sentence', async () => {
    const results = await run(deniedWith(SDK_DENY_TEXT))
    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'User denied')
    assert.equal(results[0].isError, true)
    assert.equal(results[0].truncated, false)
    assert.equal('terminatedReason' in results[0], false)
  })

  it('shows the operator\'s own deny reason', async () => {
    const results = await run(deniedWith(SDK_DENY_TEXT, 'use a temp file instead'))
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

  // The CLI has several spellings; the denial's own record decides, not the wording.
  const OTHER_SENTENCES = [
    "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
    'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).',
    'Permission for this tool use was denied. The tool use was rejected (eg. ...). The user said:\nnot that file',
    'Permission for this action has been denied. Reason: blocked by the auto mode classifier',
    'The auto mode classifier blocked this action as unsafe.',
  ]
  for (const sentence of OTHER_SENTENCES) {
    it(`a recorded denial wins over the SDK wording: ${sentence.slice(0, 44)}`, async () => {
      const results = await run(deniedWith(sentence))
      assert.equal(results[0].result, 'User denied')
    })
  }

  it('CONTROL: an unrecorded error that is not a known refusal stays as is', async () => {
    const results = await run(() => (async function* () {
      yield writeStart
      yield toolResult(OTHER_SENTENCES[4])
      yield okResult
    })())
    assert.equal(results[0].result, OTHER_SENTENCES[4])
  })

  it('two tools denied with different texts in one turn each keep their own', async () => {
    const results = await run((ctx) => (async function* () {
      yield startOf('toolu_a')
      yield startOf('toolu_b')
      const a = ask(ctx, 'toolu_a')
      const b = ask(ctx, 'toolu_b')
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, 'reason for a')
      ctx.session.respondToPermission(ctx.requests[1].requestId, 'deny', undefined, 'reason for b')
      await Promise.all([a, b])
      yield toolResult(SDK_DENY_TEXT, true, 'toolu_b')
      yield toolResult(SDK_DENY_TEXT, true, 'toolu_a')
      yield okResult
    })())
    const byId = Object.fromEntries(results.map((r) => [r.toolUseId, r.result]))
    assert.equal(byId.toolu_a, 'reason for a')
    assert.equal(byId.toolu_b, 'reason for b')
  })

  it('a record is used once: a second result for the same id gets the generic sentence', async () => {
    const results = await run((ctx) => (async function* () {
      yield writeStart
      const d = ask(ctx)
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, 'only once')
      await d
      yield toolResult(SDK_DENY_TEXT)
      yield toolResult(SDK_DENY_TEXT)
      yield okResult
    })())
    assert.equal(results[0].result, 'only once')
    assert.equal(results[1].result, 'Tool use was denied.')
  })

  it('a non-error block does not consume the record', async () => {
    const results = await run((ctx) => (async function* () {
      yield writeStart
      const d = ask(ctx)
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, 'kept')
      await d
      yield toolResult('plain output', false)
      yield toolResult(SDK_DENY_TEXT)
      yield okResult
    })())
    assert.equal(results[1].result, 'kept')
  })

  // Turn one leaves a record behind (a Deny whose result never arrives, or a
  // prompt still open when the turn ends, which the turn-end teardown denies
  // AFTER the turn-end clear); turn two reuses the id.
  for (const [name, turnOne] of [
    ['an answered Deny', (ctx) => (async function* () {
      yield writeStart
      const d = ask(ctx)
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, 'turn one reason')
      await d
      yield okResult
    })()],
    ['a prompt still open at turn end', (ctx) => (async function* () {
      yield writeStart
      ask(ctx).catch(() => {})
      yield okResult
    })()],
  ]) {
    it(`a record from an earlier turn does not leak into the next (${name})`, async () => {
      const results = await run([
        turnOne,
        () => (async function* () {
          yield writeStart
          yield toolResult(SDK_DENY_TEXT)
          yield okResult
        })(),
      ])
      assert.equal(results.at(-1).result, 'Tool use was denied.')
    })
  }

  it('drops its records when the turn ends and when the session is destroyed', async () => {
    const h = harness((ctx) => (async function* () {
      yield writeStart
      const d = ask(ctx)
      ctx.session.respondToPermission(ctx.requests[0].requestId, 'deny', undefined, 'x')
      await d
      assert.equal(ctx.session._deniedToolMessages.size, 1) // recorded, its result not yet seen
      yield okResult // ...and never will be
    })())
    await h.session.sendMessage('go')
    assert.equal(h.session._deniedToolMessages.size, 0)
    h.session._deniedToolMessages.set('toolu_z', 'left')
    h.session.destroy()
    assert.equal(h.session._deniedToolMessages.size, 0)
  })

  it('bounds a long operator reason', async () => {
    const results = await run(deniedWith(SDK_DENY_TEXT, 'z'.repeat(5000)))
    assert.ok(results[0].result.length <= 2000, `length ${results[0].result.length}`)
  })

  it('emitToolResults applies the size cap to the swapped text and reports truncation', () => {
    const emitter = new EventEmitter()
    emitter._deniedTextForToolResult = () => 'q'.repeat(50)
    const out = []
    emitter.on('tool_result', (e) => out.push(e))
    emitToolResults([{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'x' }], emitter, 10)
    assert.equal(out[0].result.length, 10)
    assert.equal(out[0].truncated, true)
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
      const d = ask(ctx)
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
      const d = ask(ctx)
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
