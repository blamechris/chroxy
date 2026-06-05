import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  SERVER_NAME,
  DEFAULT_PORT,
  CHANNEL_NOTIFICATION_METHOD,
  INSTRUCTIONS,
  REPLY_TOOL,
  sanitizeMeta,
  buildChannelNotification,
  createChannelServer,
  startHttpControlSurface
} from '../src/channels/chroxy-channel-server.js'

// Unit tests for the standalone chroxy-channel MCP prototype (#3952). These
// exercise the protocol surface against injectable seams without spawning a
// live `claude` session — they assert the capability advertisement, reply-tool
// shape, notification envelope, meta sanitization, and the HTTP control surface
// forwarding behaviour. The live `claude --channels` round-trip is documented
// in the README and is not exercisable headlessly here.

describe('chroxy-channel: protocol constants', () => {
  it('uses the verified channel notification method verbatim', () => {
    assert.equal(CHANNEL_NOTIFICATION_METHOD, 'notifications/claude/channel')
  })

  it('exposes the prototype server name and default port', () => {
    assert.equal(SERVER_NAME, 'chroxy-channel')
    assert.equal(DEFAULT_PORT, 8788)
  })

  it('instructions tell Claude the envelope shape and to use the reply tool', () => {
    assert.match(INSTRUCTIONS, /<channel source="chroxy-channel"/)
    assert.match(INSTRUCTIONS, /reply/i)
    assert.match(INSTRUCTIONS, /chat_id/)
  })

  it('reply tool declares chat_id + text as required string args', () => {
    assert.equal(REPLY_TOOL.name, 'reply')
    assert.equal(REPLY_TOOL.inputSchema.type, 'object')
    assert.deepEqual(REPLY_TOOL.inputSchema.required, ['chat_id', 'text'])
    assert.equal(REPLY_TOOL.inputSchema.properties.chat_id.type, 'string')
    assert.equal(REPLY_TOOL.inputSchema.properties.text.type, 'string')
  })
})

describe('chroxy-channel: sanitizeMeta', () => {
  it('keeps identifier-safe keys and stringifies values', () => {
    assert.deepEqual(
      sanitizeMeta({ chat_id: 1, severity: 'high', count: 0 }),
      { chat_id: '1', severity: 'high', count: '0' }
    )
  })

  it('drops keys with hyphens or other non-identifier characters', () => {
    // Per the protocol reference, Claude silently drops these; we drop up front.
    assert.deepEqual(
      sanitizeMeta({ 'chat-id': '1', 'x.y': '2', ok_key: '3' }),
      { ok_key: '3' }
    )
  })

  it('drops null and undefined values', () => {
    assert.deepEqual(
      sanitizeMeta({ a: null, b: undefined, c: 'keep' }),
      { c: 'keep' }
    )
  })

  it('returns an empty object for non-object input', () => {
    assert.deepEqual(sanitizeMeta(null), {})
    assert.deepEqual(sanitizeMeta(undefined), {})
    assert.deepEqual(sanitizeMeta('nope'), {})
  })
})

describe('chroxy-channel: buildChannelNotification', () => {
  it('produces the verified channel notification envelope', () => {
    const n = buildChannelNotification({ content: 'hello', chatId: '7', path: '/hook', method: 'POST' })
    assert.equal(n.method, 'notifications/claude/channel')
    assert.equal(n.params.content, 'hello')
    assert.deepEqual(n.params.meta, { chat_id: '7', path: '/hook', method: 'POST' })
  })

  it('defaults path and method, and coerces missing content to empty string', () => {
    const n = buildChannelNotification({ content: undefined, chatId: '1' })
    assert.equal(n.params.content, '')
    assert.deepEqual(n.params.meta, { chat_id: '1', path: '/', method: 'POST' })
  })
})

describe('chroxy-channel: createChannelServer capabilities', () => {
  it('declares the claude/channel capability and tools', () => {
    const { mcp } = createChannelServer({ log: () => {} })
    // getCapabilities reflects what was passed to the Server constructor.
    const caps = mcp.getCapabilities ? mcp.getCapabilities() : mcp._capabilities
    assert.ok(caps.experimental, 'experimental capabilities present')
    assert.ok(
      Object.prototype.hasOwnProperty.call(caps.experimental, 'claude/channel'),
      'claude/channel key present — registers the channel listener'
    )
    assert.deepEqual(caps.experimental['claude/channel'], {})
    assert.ok(caps.tools, 'tools capability present for the reply tool')
  })

  it('does NOT declare the permission relay capability (out of scope, sub 4)', () => {
    const { mcp } = createChannelServer({ log: () => {} })
    const caps = mcp.getCapabilities ? mcp.getCapabilities() : mcp._capabilities
    assert.ok(
      !Object.prototype.hasOwnProperty.call(caps.experimental, 'claude/channel/permission'),
      'permission relay must not be declared in the prototype'
    )
  })
})

describe('chroxy-channel: reply tool handlers', () => {
  // The MCP Server registers request handlers keyed by the request schema's
  // method. We exercise those handlers directly via the (private) registry to
  // avoid spinning up a transport pair.
  function getHandler(mcp, schema) {
    const method = schema.shape.method.value
    return mcp._requestHandlers.get(method)
  }

  it('ListTools returns exactly the reply tool', async () => {
    const { mcp } = createChannelServer({ log: () => {} })
    const handler = getHandler(mcp, ListToolsRequestSchema)
    assert.ok(handler, 'ListTools handler registered')
    const result = await handler({ method: 'tools/list', params: {} }, {})
    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0].name, 'reply')
  })

  it('CallTool reply invokes onReply with chat_id + text and returns sent', async () => {
    const replies = []
    const { mcp } = createChannelServer({ log: () => {}, onReply: r => replies.push(r) })
    const handler = getHandler(mcp, CallToolRequestSchema)
    const result = await handler(
      { method: 'tools/call', params: { name: 'reply', arguments: { chat_id: '3', text: 'hi there' } } },
      {}
    )
    assert.deepEqual(replies, [{ chat_id: '3', text: 'hi there' }])
    assert.deepEqual(result.content, [{ type: 'text', text: 'sent' }])
  })

  it('CallTool coerces missing reply arguments to empty strings', async () => {
    const replies = []
    const { mcp } = createChannelServer({ log: () => {}, onReply: r => replies.push(r) })
    const handler = getHandler(mcp, CallToolRequestSchema)
    await handler({ method: 'tools/call', params: { name: 'reply' } }, {})
    assert.deepEqual(replies, [{ chat_id: '', text: '' }])
  })

  it('CallTool throws for an unknown tool', async () => {
    const { mcp } = createChannelServer({ log: () => {} })
    const handler = getHandler(mcp, CallToolRequestSchema)
    await assert.rejects(
      () => handler({ method: 'tools/call', params: { name: 'nope', arguments: {} } }, {}),
      /unknown tool: nope/
    )
  })

  it('the default onReply logs the reply to the injected logger (stderr seam)', async () => {
    const logged = []
    const { mcp } = createChannelServer({ log: (...a) => logged.push(a.join(' ')) })
    const handler = getHandler(mcp, CallToolRequestSchema)
    await handler({ method: 'tools/call', params: { name: 'reply', arguments: { chat_id: '9', text: 'pong' } } }, {})
    assert.ok(logged.some(l => l.includes('reply chat_id=9') && l.includes('pong')))
  })
})

describe('chroxy-channel: HTTP control surface', () => {
  async function withServer(fn) {
    const sent = []
    // Fake mcp with just the notification method the surface uses.
    const mcp = { notification: async n => { sent.push(n) } }
    // port 0 → OS picks a free localhost port, avoids 8788 collisions in CI.
    const httpServer = startHttpControlSurface({ mcp, port: 0, log: () => {} })
    await once(httpServer, 'listening')
    const { port } = httpServer.address()
    try {
      await fn({ port, sent })
    } finally {
      httpServer.close()
      await once(httpServer, 'close')
    }
  }

  it('binds to localhost only', async () => {
    const mcp = { notification: async () => {} }
    const httpServer = startHttpControlSurface({ mcp, port: 0, log: () => {} })
    await once(httpServer, 'listening')
    assert.equal(httpServer.address().address, '127.0.0.1')
    httpServer.close()
    await once(httpServer, 'close')
  })

  it('forwards a POST body as a channel notification with incrementing chat_id', async () => {
    await withServer(async ({ port, sent }) => {
      const r1 = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: 'first' })
      const r2 = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'second' })
      assert.equal(r1.status, 200)
      assert.equal(await r1.text(), 'ok')
      assert.equal(r2.status, 200)

      assert.equal(sent.length, 2)
      assert.equal(sent[0].method, 'notifications/claude/channel')
      assert.equal(sent[0].params.content, 'first')
      assert.deepEqual(sent[0].params.meta, { chat_id: '1', path: '/hook', method: 'POST' })
      assert.equal(sent[1].params.content, 'second')
      assert.equal(sent[1].params.meta.chat_id, '2')
    })
  })

  it('strips the query string from the forwarded path', async () => {
    await withServer(async ({ port, sent }) => {
      await fetch(`http://127.0.0.1:${port}/p?x=1`, { method: 'POST', body: 'q' })
      assert.equal(sent[0].params.meta.path, '/p')
    })
  })

  it('rejects non-POST methods with 405 and does not notify', async () => {
    await withServer(async ({ port, sent }) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('allow'), 'POST')
      assert.equal(sent.length, 0, 'no channel notification for a non-POST request')
    })
  })

  it('returns 502 when the notification fails', async () => {
    const mcp = { notification: async () => { throw new Error('no transport') } }
    const httpServer = startHttpControlSurface({ mcp, port: 0, log: () => {} })
    await once(httpServer, 'listening')
    const { port } = httpServer.address()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x' })
      assert.equal(res.status, 502)
    } finally {
      httpServer.close()
      await once(httpServer, 'close')
    }
  })
})
