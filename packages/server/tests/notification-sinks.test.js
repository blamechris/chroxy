import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { NotificationSink } from '../src/notifications/sink.js'
import { SinkRegistry } from '../src/notifications/sink-registry.js'
import { ExpoPushSink } from '../src/notifications/expo-push-sink.js'

/**
 * NotificationSink / SinkRegistry / ExpoPushSink unit tests (#5413 Phase 1).
 *
 * Pins the sink contract and the registry fan-out semantics so Phase 2's
 * DiscordWebhookSink lands on tested rails:
 * - unconfigured sinks are skipped, never asked to send
 * - one failing/throwing sink doesn't stop the others or crash the pipeline
 * - fanOut aggregates: true iff no configured sink hard-failed
 * - ExpoPushSink applies the per-device context evaluators per token
 */

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'
const VALID_TOKEN_2 = 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]'

/** Minimal contract-conforming fake sink for registry tests */
function fakeSink({ name = 'fake', configured = true, result = true, throws = null } = {}) {
  const calls = []
  return {
    name,
    calls,
    isConfigured: () => configured,
    async send(notification, context) {
      calls.push({ notification, context })
      if (throws) throw throws
      return result
    },
  }
}

describe('NotificationSink (base contract)', () => {
  it('takes its name from the constructor opts', () => {
    const sink = new NotificationSink({ name: 'my-sink' })
    assert.equal(sink.name, 'my-sink')
  })

  it('defaults the name to the class name', () => {
    class TestSink extends NotificationSink {}
    assert.equal(new TestSink().name, 'TestSink')
  })

  it('is unconfigured by default', () => {
    assert.equal(new NotificationSink().isConfigured(), false)
  })

  it('rejects send() until a subclass implements it', async () => {
    const sink = new NotificationSink({ name: 'stub' })
    await assert.rejects(
      () => sink.send({ category: 'result', title: 't', body: 'b' }),
      /does not implement send/
    )
  })
})

describe('SinkRegistry', () => {
  describe('register', () => {
    it('rejects a sink without send()', () => {
      const registry = new SinkRegistry()
      assert.throws(() => registry.register({ name: 'x', isConfigured: () => true }), TypeError)
    })

    it('rejects a sink without isConfigured()', () => {
      const registry = new SinkRegistry()
      assert.throws(() => registry.register({ name: 'x', send: async () => true }), TypeError)
    })

    it('rejects a sink without a name', () => {
      const registry = new SinkRegistry()
      assert.throws(
        () => registry.register({ isConfigured: () => true, send: async () => true }),
        TypeError
      )
    })

    it('returns the registered sink and exposes it via sinks', () => {
      const registry = new SinkRegistry()
      const sink = fakeSink({ name: 'a' })
      assert.equal(registry.register(sink), sink)
      assert.deepEqual(registry.sinks, [sink])
    })
  })

  describe('hasConfigured', () => {
    it('is false with no sinks registered', () => {
      assert.equal(new SinkRegistry().hasConfigured(), false)
    })

    it('is false when every sink is unconfigured', () => {
      const registry = new SinkRegistry()
      registry.register(fakeSink({ configured: false }))
      assert.equal(registry.hasConfigured(), false)
    })

    it('is true when at least one sink is configured', () => {
      const registry = new SinkRegistry()
      registry.register(fakeSink({ name: 'off', configured: false }))
      registry.register(fakeSink({ name: 'on', configured: true }))
      assert.equal(registry.hasConfigured(), true)
    })
  })

  describe('fanOut', () => {
    const notification = { category: 'result', title: 'Title', body: 'Body', data: { a: 1 } }

    it('resolves true with no configured sinks (nothing to send is not a failure)', async () => {
      const registry = new SinkRegistry()
      registry.register(fakeSink({ configured: false }))
      assert.equal(await registry.fanOut(notification), true)
    })

    it('skips unconfigured sinks entirely', async () => {
      const registry = new SinkRegistry()
      const off = fakeSink({ name: 'off', configured: false })
      const on = fakeSink({ name: 'on', configured: true })
      registry.register(off)
      registry.register(on)
      assert.equal(await registry.fanOut(notification), true)
      assert.equal(off.calls.length, 0)
      assert.equal(on.calls.length, 1)
    })

    it('passes notification and context through to each configured sink', async () => {
      const registry = new SinkRegistry()
      const sink = fakeSink({ name: 'a' })
      registry.register(sink)
      const context = { now: 123, isCategoryEnabled: () => true }
      await registry.fanOut(notification, context)
      assert.equal(sink.calls[0].notification, notification)
      assert.equal(sink.calls[0].context, context)
    })

    it('resolves false when a configured sink hard-fails, but still delivers to the rest', async () => {
      const registry = new SinkRegistry()
      const failing = fakeSink({ name: 'failing', result: false })
      const healthy = fakeSink({ name: 'healthy', result: true })
      registry.register(failing)
      registry.register(healthy)
      assert.equal(await registry.fanOut(notification), false)
      assert.equal(healthy.calls.length, 1, 'healthy sink still receives the notification')
    })

    it('contains a throwing sink (contract violation): logs, resolves false, others deliver', async () => {
      const errors = []
      const registry = new SinkRegistry({ logger: { error: (msg) => errors.push(msg) } })
      const thrower = fakeSink({ name: 'thrower', throws: new Error('boom') })
      const healthy = fakeSink({ name: 'healthy' })
      registry.register(thrower)
      registry.register(healthy)
      assert.equal(await registry.fanOut(notification), false)
      assert.equal(healthy.calls.length, 1)
      assert.equal(errors.length, 1)
      assert.match(errors[0], /thrower/)
      assert.match(errors[0], /boom/)
    })

    it('resolves true when every configured sink succeeds', async () => {
      const registry = new SinkRegistry()
      registry.register(fakeSink({ name: 'a' }))
      registry.register(fakeSink({ name: 'b' }))
      assert.equal(await registry.fanOut(notification), true)
    })

    // #5425 review S1 — a throwing isConfigured() is the same contract-
    // violation class as a throwing send(). It must be contained, not
    // escape as a rejection: PushManager.send() is called un-awaited at
    // several sites (e.g. ws-permissions), so an escaped rejection is an
    // unhandledRejection → daemon-level fallout.
    it('contains a throwing isConfigured() in fanOut: logs, counts as failure, others deliver', async () => {
      const errors = []
      const registry = new SinkRegistry({ logger: { error: (msg) => errors.push(msg) } })
      const broken = fakeSink({ name: 'broken-probe' })
      broken.isConfigured = () => { throw new Error('probe-boom') }
      const healthy = fakeSink({ name: 'healthy' })
      registry.register(broken)
      registry.register(healthy)
      assert.equal(await registry.fanOut(notification), false)
      assert.equal(healthy.calls.length, 1, 'healthy sink still receives the notification')
      assert.equal(errors.length, 1)
      assert.match(errors[0], /broken-probe/)
      assert.match(errors[0], /probe-boom/)
    })

    it('hasConfigured treats a throwing isConfigured() as not configured (and logs)', () => {
      const errors = []
      const registry = new SinkRegistry({ logger: { error: (msg) => errors.push(msg) } })
      const broken = fakeSink({ name: 'broken-probe' })
      broken.isConfigured = () => { throw new Error('probe-boom') }
      registry.register(broken)
      assert.equal(registry.hasConfigured(), false)
      assert.equal(errors.length, 1)

      registry.register(fakeSink({ name: 'on', configured: true }))
      assert.equal(registry.hasConfigured(), true, 'a healthy sink is still discoverable past the broken one')
    })
  })
})

describe('ExpoPushSink (sink contract surface)', () => {
  let sink
  let originalFetch

  beforeEach(() => {
    sink = new ExpoPushSink() // no storagePath — in-memory only
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restoreAll()
  })

  function mockFetchOk(data = []) {
    const fn = mock.fn(async () => ({ ok: true, json: async () => ({ data }) }))
    globalThis.fetch = fn
    return fn
  }

  it('has the stable sink name', () => {
    assert.equal(sink.name, 'expo-push')
  })

  it('is unconfigured with no tokens, configured once a token registers', () => {
    assert.equal(sink.isConfigured(), false)
    sink.registerToken(VALID_TOKEN)
    assert.equal(sink.isConfigured(), true)
  })

  it('delivers to every registered token with the category stamped into data', async () => {
    const fetchMock = mockFetchOk()
    sink.registerToken(VALID_TOKEN)
    sink.registerToken(VALID_TOKEN_2)
    const ok = await sink.send({ category: 'result', title: 'T', body: 'B', data: { x: 1 } })
    assert.equal(ok, true)
    assert.equal(fetchMock.mock.calls.length, 1)
    const messages = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
    assert.equal(messages.length, 2)
    assert.deepEqual(messages.map((m) => m.to).sort(), [VALID_TOKEN, VALID_TOKEN_2].sort())
    assert.deepEqual(messages[0].data, { x: 1, category: 'result' })
  })

  it('applies per-device context evaluators per token', async () => {
    const fetchMock = mockFetchOk()
    sink.registerToken(VALID_TOKEN)
    sink.registerToken(VALID_TOKEN_2)
    const ok = await sink.send(
      { category: 'result', title: 'T', body: 'B' },
      { isCategoryEnabled: (_category, deviceId) => deviceId !== VALID_TOKEN }
    )
    assert.equal(ok, true)
    const messages = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].to, VALID_TOKEN_2)
  })

  it('honours quiet hours with bypass, per token', async () => {
    const fetchMock = mockFetchOk()
    sink.registerToken(VALID_TOKEN)
    sink.registerToken(VALID_TOKEN_2)
    const ok = await sink.send(
      { category: 'permission', title: 'T', body: 'B' },
      {
        isInQuietHours: () => true,
        // Only the second device bypasses quiet hours for this category
        shouldBypassQuietHours: (_category, deviceId) => deviceId === VALID_TOKEN_2,
      }
    )
    assert.equal(ok, true)
    const messages = JSON.parse(fetchMock.mock.calls[0].arguments[1].body)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].to, VALID_TOKEN_2)
  })

  it('resolves true without a POST when every token is filtered out', async () => {
    const fetchMock = mockFetchOk()
    sink.registerToken(VALID_TOKEN)
    const ok = await sink.send(
      { category: 'result', title: 'T', body: 'B' },
      { isCategoryEnabled: () => false }
    )
    assert.equal(ok, true)
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  it('fails open when context evaluators are missing (sends to all tokens)', async () => {
    const fetchMock = mockFetchOk()
    sink.registerToken(VALID_TOKEN)
    const ok = await sink.send({ category: 'result', title: 'T', body: 'B' }, {})
    assert.equal(ok, true)
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  it('resolves false (never throws) on Expo hard failure', async () => {
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }))
    sink.registerToken(VALID_TOKEN)
    const ok = await sink.send({ category: 'result', title: 'T', body: 'B' })
    assert.equal(ok, false)
  })
})
