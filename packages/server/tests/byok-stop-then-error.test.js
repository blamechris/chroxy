import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeByokSession } from '../src/byok-session.js'
import { APIUserAbortError, APIConnectionError, APIConnectionTimeoutError, AnthropicError, APIError, InternalServerError } from '@anthropic-ai/sdk'

/**
 * #9266 -- only a genuine abort is the requested Stop. An upstream error that
 * races the Stop must still be shown; every shape the SDK/undici throw BECAUSE of
 * the abort must still end quietly.
 */

const MARK = 'stopped_before_output'

const abortDom = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
const http500 = () => new InternalServerError(500, { error: { message: 'upstream exploded' } }, undefined, new Headers())
const http429 = () => Object.assign(new Error('429 slow down'), { status: 429 })

// Round 0 streams `before` events, Stops, then the stream rejects with failWith().
function byok(failWith, { text = false } = {}) {
  const session = new ClaudeByokSession({ cwd: '/tmp' })
  session.setPermissionMode('auto')
  session._client = {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          if (text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }
          session.markStopRequested()
          session.interrupt()
          throw failWith()
        },
        async finalMessage() { throw failWith() },
      }),
    },
  }
  return session
}

async function run(session) {
  const seen = { errors: [], results: [], stopped: 0 }
  session.on('error', (e) => seen.errors.push(e))
  session.on('result', (r) => seen.results.push(r))
  session.on('stopped', () => { seen.stopped++ })
  await session.start()
  await session.sendMessage('go')
  await session.destroy()
  return seen
}

describe('claude-byok: an upstream error racing a Stop is surfaced (#9266)', () => {
  it('Stop then HTTP 500: the HTTP_500 error is emitted, no quiet stop, no marker', async () => {
    const seen = await run(byok(http500))
    assert.deepEqual(seen.errors.map((e) => e.code), ['HTTP_500'])
    assert.equal(seen.stopped, 0)
    assert.equal(seen.results.filter((r) => r.turnOutcome === MARK).length, 0)
    assert.equal(seen.results.filter((r) => r.interrupted).length, 0)
  })

  it('after Stop then 500 the session is idle and a follow-up turn succeeds', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    let n = 0
    session._client = { messages: { stream: () => {
      const first = n++ === 0
      return {
        async *[Symbol.asyncIterator]() {
          if (first) { session.markStopRequested(); session.interrupt(); throw http500() }
        },
        async finalMessage() {
          if (first) throw http500()
          return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] }
        },
      }
    } } }
    const results = []
    const errors = []
    session.on('result', (r) => results.push(r))
    session.on('error', (e) => errors.push(e))
    await session.start()
    await session.sendMessage('go')
    assert.deepEqual(errors.map((e) => e.code), ['HTTP_500'])
    assert.equal(session.isRunning, false)
    assert.equal(results.length, 0)
    await session.sendMessage('again')
    assert.deepEqual(errors.map((e) => e.code), ['HTTP_500'])
    assert.equal(results.length, 1)
    assert.equal(session.isRunning, false)
    await session.destroy()
  })

  it('Stop then an SSE error event with a JSON body (no status): surfaced', async () => {
    const sse = () => new APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, undefined, new Headers())
    const seen = await run(byok(sse))
    assert.equal(seen.errors.length, 1)
    assert.equal(seen.stopped, 0)
  })

  it('Stop then an SSE error event with a non-JSON string body (no status): surfaced', async () => {
    const sse = () => new APIError(undefined, 'upstream melted', undefined, new Headers())
    const seen = await run(byok(sse))
    assert.equal(seen.errors.length, 1)
    assert.equal(seen.stopped, 0)
  })

  it('Stop then HTTP 429 (plain error with status): surfaced', async () => {
    const seen = await run(byok(http429))
    assert.deepEqual(seen.errors.map((e) => e.code), ['HTTP_429'])
    assert.equal(seen.stopped, 0)
  })

  it('Stop after streamed text then HTTP 500: surfaced', async () => {
    const seen = await run(byok(http500, { text: true }))
    assert.deepEqual(seen.errors.map((e) => e.code), ['HTTP_500'])
    assert.equal(seen.stopped, 0)
  })

  it('the Stop-less 500 is unchanged: same error event', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    session._client = { messages: { stream: () => ({
      async *[Symbol.asyncIterator]() { throw http500() },
      async finalMessage() { throw http500() },
    }) } }
    const seen = await run(session)
    assert.deepEqual(seen.errors.map((e) => e.code), ['HTTP_500'])
    assert.equal(seen.stopped, 0)
  })

  it('a 500 in a later round (after a tool round) racing the Stop is surfaced', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    let round = 0
    session._client = { messages: { stream: () => {
      const r = round++
      return {
        async *[Symbol.asyncIterator]() {
          if (r === 0) return
          session.markStopRequested()
          session.interrupt()
          throw http500()
        },
        async finalMessage() {
          if (r === 0) {
            return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.nope' } }] }
          }
          throw http500()
        },
      }
    } } }
    const seen = await run(session)
    assert.deepEqual(seen.errors.map((e) => e.code), ['HTTP_500'])
  })
})

describe('claude-byok: every abort-caused shape still ends as the quiet Stop (#9266)', () => {
  const shapes = {
    'APIUserAbortError': () => new APIUserAbortError({ message: 'Request was aborted.' }),
    'DOMException-style AbortError': abortDom,
    'undici `terminated` whose cause is the abort': () => Object.assign(new TypeError('terminated'), { cause: abortDom() }),
    'SDK AnthropicError wrapping the abort as cause': () => Object.assign(new AnthropicError('wrapped'), { cause: abortDom() }),
    'APIConnectionError whose cause is the abort': () => new APIConnectionError({ cause: abortDom() }),
    'ambiguous: no status, no abort cause, signal aborted': () => new Error('socket hang up'),
    'APIConnectionTimeoutError (deliberately quiet after a Stop)': () => new APIConnectionTimeoutError(),
  }
  for (const [name, make] of Object.entries(shapes)) {
    it(`${name}: no error, one stopped`, async () => {
      const seen = await run(byok(make))
      assert.deepEqual(seen.errors, [])
      assert.equal(seen.stopped, 1)
    })
  }

  it('a genuine abort before output still mints the marker (cause-chained abort too)', async () => {
    for (const make of [shapes.APIUserAbortError, shapes['undici `terminated` whose cause is the abort']]) {
      const seen = await run(byok(make))
      assert.equal(seen.results.filter((r) => r.turnOutcome === MARK).length, 1)
    }
  })

  it('a genuine abort that also carries a status still ends quietly, marker minted (abort beats upstream evidence)', async () => {
    const seen = await run(byok(() => Object.assign(new APIUserAbortError(), { status: 500 })))
    assert.deepEqual(seen.errors, [])
    assert.equal(seen.stopped, 1)
    assert.equal(seen.results.filter((r) => r.turnOutcome === MARK).length, 1)
  })

  it('the ambiguous shape is a quiet stop but mints no marker', async () => {
    const seen = await run(byok(shapes['ambiguous: no status, no abort cause, signal aborted']))
    assert.equal(seen.results.filter((r) => r.turnOutcome === MARK).length, 0)
  })
})

describe('claude-byok: no Stop keeps the pre-#9266 classification', () => {
  it('APIConnectionError with an abort cause and no Stop is a STREAM_ERROR, not ABORT', async () => {
    const make = () => new APIConnectionError({ cause: abortDom() })
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    session._client = { messages: { stream: () => ({
      async *[Symbol.asyncIterator]() { throw make() },
      async finalMessage() { throw make() },
    }) } }
    const seen = await run(session)
    assert.deepEqual(seen.errors.map((e) => e.code), ['STREAM_ERROR'])
    assert.equal(seen.stopped, 0)
  })
})
