/**
 * agent-control `--principal` mode, unit level (#9121, S6 of #9112;
 * docs/security/agent-principals.md sections 2, 3 and 4.1).
 *
 * Each guard here has a positive control beside it, and the mutation that must turn it
 * red is named in the test's comment:
 *   - the client outbound allowlist (mutation: let `_assertOutboundAllowed` pass everything)
 *   - the roster of that allowlist against the daemon's observe tier, both directions
 *   - the principal resolver: token file first, trusted read, no primary token, no
 *     connection.json, loopback only
 *   - the MCP CallTool gate in principal mode (mutation: drop `|| principal` from readOnly)
 *   - PrincipalObserver.waitEvents: bounds, doorbell ordering, teardown, one wait at a time
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AgentControlClient, PRINCIPAL_CLIENT_OUTBOUND_TYPES, PrincipalScopeError } from '../../src/agent-control/client.js'
import { resolvePrincipalConnectionTarget, readPrincipalTokenFile, DEFAULT_LOCAL_PORT } from '../../src/agent-control/local-connection.js'
import { PrincipalObserver, encodeCursor, decodeCursor, MAX_WAIT_EVENTS_MS, WAIT_READ_GRACE_MS } from '../../src/agent-control/principal-observer.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'
import { PRINCIPAL_ALLOWED_MESSAGE_TYPES, PRINCIPAL_TRANSPORT_EXEMPT } from '../../src/principal-policy.js'

const PRINCIPAL_TOKEN = 'pRiNcIpAl_token_fixture_0123456789abcdefABCDEF'
const PRIMARY_TOKEN = 'primary-token-fixture-must-never-be-sent'

const cleanups = []
afterEach(() => { while (cleanups.length) cleanups.pop()() })

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-principal-mode-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tokenFile(content = `${PRINCIPAL_TOKEN}\n`, mode = 0o600) {
  const path = join(tempDir(), 'principal.token')
  writeFileSync(path, content, { mode })
  chmodSync(path, mode)
  return path
}

/** A socket stand-in that records what reached the wire. */
function fakeSocket() {
  const sent = []
  return { sent, socket: { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)), close() {} } }
}

describe('principal client outbound allowlist', () => {
  it('equals the daemon observe-tier roster plus the transport types, in both directions', () => {
    // Mutation: add 'input' (or drop 'principal_events_read') from the client list -> red.
    const daemonObserve = Object.entries(PRINCIPAL_ALLOWED_MESSAGE_TYPES)
      .filter(([, v]) => v.tier === 'observe').map(([k]) => k)
    const expected = new Set([...PRINCIPAL_TRANSPORT_EXEMPT, ...daemonObserve])
    const actual = new Set(PRINCIPAL_CLIENT_OUTBOUND_TYPES)
    const missing = [...expected].filter((t) => !actual.has(t))
    const extra = [...actual].filter((t) => !expected.has(t))
    assert.deepEqual(missing, [], 'every daemon observe-tier type is sendable')
    assert.deepEqual(extra, [], 'the client sends nothing the daemon would refuse a read-only principal')
  })

  it('is frozen, so it cannot be widened at runtime', () => {
    assert.equal(Object.isFrozen(PRINCIPAL_CLIENT_OUTBOUND_TYPES), true)
    assert.throws(() => { 'use strict'; PRINCIPAL_CLIENT_OUTBOUND_TYPES.push('input') }, TypeError)
  })

  it('refuses host and mutation types before the socket, on both send paths', () => {
    // Mutation: make `_assertOutboundAllowed` a no-op -> the refused frames reach `sent`.
    const client = new AgentControlClient({ url: 'ws://127.0.0.1:1', token: PRINCIPAL_TOKEN, principal: true, silent: true })
    const { sent, socket } = fakeSocket()
    client._ws = socket
    for (const type of ['input', 'list_sessions', 'subscribe_sessions', 'permission_response', 'interrupt', 'create_session', 'principal_admin_grant', undefined]) {
      assert.throws(() => client._send({ type }), PrincipalScopeError, `_send ${type}`)
      assert.throws(() => client._sendPlain({ type }), PrincipalScopeError, `_sendPlain ${type}`)
    }
    assert.equal(sent.length, 0, 'nothing refused reached the wire')
    // Positive control: an allowed read goes out.
    client._send({ type: 'principal_events_read', requestId: 'r', sessionId: 's' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'principal_events_read')
  })

  it('a primary-token client is not affected by the principal allowlist', () => {
    const client = new AgentControlClient({ url: 'ws://127.0.0.1:1', token: PRIMARY_TOKEN, silent: true })
    const { sent, socket } = fakeSocket()
    client._ws = socket
    client._send({ type: 'list_sessions' })
    assert.equal(sent.length, 1)
  })

  it('principal mode forces readOnly', () => {
    const client = new AgentControlClient({ url: 'ws://127.0.0.1:1', token: PRINCIPAL_TOKEN, principal: true, readOnly: false, silent: true })
    assert.equal(client.readOnly, true)
  })
})

describe('principal connection resolver', () => {
  it('reads the token only from the trusted token file, never the primary token', () => {
    const path = tokenFile()
    const r = resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_TOKEN_FILE: path, CHROXY_AGENT_CONTROL_TOKEN: PRIMARY_TOKEN } })
    assert.equal(r.ok, true)
    assert.equal(r.token, PRINCIPAL_TOKEN, 'the token file, trailing newline stripped')
    assert.equal(r.url, `ws://127.0.0.1:${DEFAULT_LOCAL_PORT}`)
    assert.equal(r.source, 'default')
  })

  it('never opens connection.json: its port and its primary token are both ignored', () => {
    // Mutation: resolve the local default through resolveLocalConnection -> url gets port 41999.
    const configDir = tempDir()
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'connection.json'), JSON.stringify({ port: 41999, apiToken: PRIMARY_TOKEN, pid: process.pid }), { mode: 0o600 })
    const prior = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = configDir
    cleanups.push(() => { if (prior === undefined) delete process.env.CHROXY_CONFIG_DIR; else process.env.CHROXY_CONFIG_DIR = prior })
    const r = resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_TOKEN_FILE: tokenFile() } })
    assert.equal(r.ok, true)
    assert.equal(r.url.includes('41999'), false, 'connection.json was not consulted')
    assert.notEqual(r.token, PRIMARY_TOKEN)
  })

  it('fails closed, token file FIRST, for every unusable token file', () => {
    // Unset wins even over a URL that would also be refused: the file is checked first.
    assert.equal(resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_CONTROL_URL: 'wss://example.invalid' } }).reason, 'principal_token_file_unset')
    assert.equal(resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_CONTROL_TOKEN: PRIMARY_TOKEN } }).reason, 'principal_token_file_unset', 'no fallback to the primary env token')
    assert.equal(resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_TOKEN_FILE: join(tempDir(), 'missing') } }).reason, 'principal_token_file_absent')
    if (process.platform !== 'win32') {
      assert.equal(resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_TOKEN_FILE: tokenFile(`${PRINCIPAL_TOKEN}\n`, 0o644) } }).reason, 'principal_token_file_untrusted', 'mode 0644 is refused')
      const real = tokenFile()
      const link = join(tempDir(), 'link.token')
      symlinkSync(real, link)
      assert.equal(resolvePrincipalConnectionTarget({ env: { CHROXY_AGENT_TOKEN_FILE: link } }).reason, 'principal_token_file_untrusted', 'a symlink is refused')
    }
    for (const bad of ['', 'two words', '{"token":"x"}', 'short', `${PRINCIPAL_TOKEN}\n\n`]) {
      assert.equal(readPrincipalTokenFile(tokenFile(bad)).reason, 'principal_token_file_malformed', JSON.stringify(bad))
    }
  })

  it('accepts only loopback URLs, whatever the scheme', () => {
    // Mutation: drop the hostStaysOnThisMachine check -> the wss:// remote resolves ok.
    const env = { CHROXY_AGENT_TOKEN_FILE: tokenFile() }
    assert.equal(resolvePrincipalConnectionTarget({ env, explicitUrl: 'wss://example.invalid:443' }).reason, 'principal_requires_loopback')
    assert.equal(resolvePrincipalConnectionTarget({ env, explicitUrl: 'ws://example.invalid:80' }).ok, false, 'a remote ws:// is refused too')
    assert.equal(resolvePrincipalConnectionTarget({ env: { ...env, CHROXY_AGENT_CONTROL_URL: 'wss://example.invalid' } }).reason, 'principal_requires_loopback', 'the env URL is held to the same rule')
    for (const ok of ['ws://127.0.0.1:9', 'ws://localhost:9', 'wss://[::1]:9']) {
      const r = resolvePrincipalConnectionTarget({ env, explicitUrl: ok })
      assert.equal(r.ok, true, ok)
      assert.equal(r.source, 'explicit')
    }
  })
})

describe('cursor codec', () => {
  it('round-trips the daemon cursor and refuses anything else', () => {
    const c = { sessionId: 'sess-1', journalId: '0f1e2d3c-aaaa-bbbb-cccc-000000000000', seq: 42 }
    assert.deepEqual(decodeCursor(encodeCursor(c)), c)
    for (const bad of [undefined, 42, '', 'pjc1_', 'xx_' + encodeCursor(c).slice(5), 'pjc1_!!!', encodeCursor({ ...c, seq: -1 }), encodeCursor({ ...c, seq: 1.5 }), encodeCursor({ ...c, sessionId: '' }), encodeCursor({ ...c, journalId: 'j'.repeat(65) }), 'pjc1_' + 'A'.repeat(2000)]) {
      assert.equal(decodeCursor(bad), null, String(bad).slice(0, 40))
    }
  })
})

describe('MCP dispatch in principal mode (in-memory transport)', () => {
  async function harness(run) {
    let calls = 0
    const manager = {
      get: async () => { calls++; throw Object.assign(new Error('fixture connection attempted'), { code: 'CONNECT_ATTEMPTED' }) },
      getObserver: async () => { calls++; throw Object.assign(new Error('fixture connection attempted'), { code: 'CONNECT_ATTEMPTED' }) },
      lastToken: null,
    }
    const { mcp } = createAgentControlMcpServer({ principal: true, clientManager: manager })
    const sdk = new Client({ name: 'principal-dispatch-fixture', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await mcp.connect(serverTransport)
      await sdk.connect(clientTransport)
      await run(sdk, () => calls)
    } finally {
      await sdk.close()
      await mcp.close()
    }
  }

  it('advertises exactly the five read tools', async () => {
    await harness(async (sdk) => {
      const { tools } = await sdk.listTools()
      assert.deepEqual(tools.map((t) => t.name).sort(), ['chroxy_daemon_info', 'chroxy_get_events', 'chroxy_list_sessions', 'chroxy_pending_permissions', 'chroxy_wait_events'])
    })
  })

  it('refuses every mutation tool READ_ONLY_MODE before any connection', async () => {
    // Mutation: drop `|| principal` from readOnly in createAgentControlMcpServer -> 'unknown tool' instead.
    await harness(async (sdk, count) => {
      for (const [name, args] of [
        ['chroxy_create_session', {}],
        ['chroxy_send_input', { sessionId: 's', data: 'hello' }],
        ['chroxy_interrupt_session', { sessionId: 's' }],
        ['chroxy_respond_permission', { sessionId: 's', requestId: 'r', decision: 'deny' }],
      ]) {
        const result = await sdk.callTool({ name, arguments: args })
        assert.equal(result.isError, true, name)
        assert.equal(result.structuredContent.code, 'READ_ONLY_MODE', name)
      }
      assert.equal(count(), 0, 'refused before any connect')
    })
  })

  it('validates wait bounds and cursor size before any connection', async () => {
    await harness(async (sdk, count) => {
      for (const args of [{ timeoutMs: MAX_WAIT_EVENTS_MS + 1 }, { timeoutMs: -1 }, { limit: 201 }, { sessionIds: [] }, { cursors: ['x'.repeat(2000)] }, { extra: 1 }]) {
        const result = await sdk.callTool({ name: 'chroxy_wait_events', arguments: args })
        assert.equal(result.structuredContent.code, 'INVALID_ARGUMENTS', JSON.stringify(args).slice(0, 60))
      }
      assert.equal(count(), 0)
      // Positive control: a valid call reaches the manager.
      const ok = await sdk.callTool({ name: 'chroxy_wait_events', arguments: { timeoutMs: 0 } })
      assert.equal(ok.structuredContent.code, 'CONNECT_ATTEMPTED')
      assert.equal(count(), 1)
    })
  })
})

/**
 * A scripted stand-in for a principal-mode AgentControlClient. `pages[sessionId]` is a
 * queue of principal_events_read replies (the last one repeats), or a function. The
 * test rings the doorbell with `push`. `subscribe` scripts the subscribe:
 * 'ok' (default) | 'timeout' (the ack is lost) | 'hang' (pending until teardown).
 * Every request records the `timeoutMs` it was given.
 */
function scriptedClient({ pages = {}, subscribe = 'ok', subscribeReply = null } = {}) {
  const listeners = new Set()
  const pending = new Set()
  const log = []
  const client = {
    principal: true,
    state: 'ready',
    daemonInfo: null,
    log,
    subscribeId: null,
    async request(type, fields, opts) {
      log.push({ type, ...fields, timeoutMs: opts.timeoutMs })
      if (type === 'principal_events_read') {
        const source = pages[fields.sessionId]
        if (typeof source === 'function') return source(fields)
        const queue = source || []
        const page = queue.length > 1 ? queue.shift() : queue[0]
        return { type: 'principal_events_page', sessionId: fields.sessionId, journalId: 'j1', events: [], headSeq: 0, cursor: { sessionId: fields.sessionId, journalId: 'j1', seq: fields.cursor?.seq ?? 0 }, more: false, ...page }
      }
      if (type === 'principal_subscribe') {
        client.subscribeId = opts.requestId
        if (subscribe === 'timeout') throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' })
        if (subscribe === 'hang') return new Promise((resolve, reject) => { pending.add(reject) })
        return subscribeReply ?? { type: 'principal_subscribed', requestId: opts.requestId, sessions: fields.sessionIds.map((sessionId) => ({ sessionId, journalId: 'j1', headSeq: 0 })) }
      }
      if (type === 'principal_sessions_snapshot') {
        return { sessions: [{ sessionId: 'a' }, { sessionId: 'b' }], truncated: false }
      }
      throw new Error(`unexpected ${type}`)
    },
    notify(type, fields) { log.push({ type, ...fields }) },
    waitForMessage(predicate, timeoutMs) {
      let cancel
      const promise = new Promise((resolve, reject) => {
        const entry = { predicate, resolve, reject }
        entry.timer = setTimeout(() => { listeners.delete(entry); resolve(null) }, timeoutMs)
        cancel = () => { clearTimeout(entry.timer); listeners.delete(entry); resolve(null) }
        listeners.add(entry)
      })
      return { promise, cancel }
    },
    /** Deliver one frame; stamps the live subscribe id unless the frame names another. */
    push(msg) {
      const frame = { requestId: client.subscribeId, ...msg }
      for (const e of [...listeners]) if (e.predicate(frame)) { clearTimeout(e.timer); listeners.delete(e); e.resolve(frame) }
    },
    teardown(err) {
      client.state = 'closed'
      for (const e of [...listeners]) { clearTimeout(e.timer); listeners.delete(e); e.reject(err) }
      for (const reject of [...pending]) { pending.delete(reject); reject(err) }
    },
    listenerCount: () => listeners.size,
  }
  return client
}

const ev = (seq, extra = {}) => ({ seq, ts: 1, eventType: 'message', data: { content: `m${seq}` }, ...extra })
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }

describe('PrincipalObserver.waitEvents', () => {
  it('refuses a client that is not in principal mode', () => {
    assert.throws(() => new PrincipalObserver({ principal: false }), /principal: true/)
  })

  it('returns already-available events at once, without subscribing', async () => {
    const client = scriptedClient({ pages: { a: [{ events: [ev(1), ev(2)], cursor: { sessionId: 'a', journalId: 'j1', seq: 2 } }] } })
    const r = await new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], timeoutMs: 1000 })
    assert.equal(r.timedOut, false)
    assert.deepEqual(r.events.map((e) => e.seq), [1, 2])
    assert.ok(Array.isArray(r.cursors), 'cursors come back in the shape the argument takes')
    assert.deepEqual(r.cursors.map(decodeCursor), [{ sessionId: 'a', journalId: 'j1', seq: 2 }])
    assert.equal(client.log.some((m) => m.type === 'principal_subscribe'), false)
  })

  it('a returned cursors array is accepted verbatim by the next call', async () => {
    const client = scriptedClient({ pages: { a: [{ events: [ev(1)], cursor: { sessionId: 'a', journalId: 'j1', seq: 1 } }, {}], b: [{ events: [ev(7)], cursor: { sessionId: 'b', journalId: 'j1', seq: 7 } }, {}] } })
    const observer = new PrincipalObserver(client)
    const first = await observer.waitEvents({ sessionIds: ['a', 'b'], timeoutMs: 0 })
    assert.equal(first.cursors.length, 2)
    const second = await observer.waitEvents({ sessionIds: ['a', 'b'], cursors: first.cursors, timeoutMs: 0 })
    assert.equal(second.timedOut, true)
    const reads = client.log.filter((m) => m.type === 'principal_events_read').slice(-2)
    assert.deepEqual(reads.map((m) => m.cursor?.seq), [1, 7], 'each session resumed from its own returned cursor')
  })

  it('arms the doorbell before subscribing, wakes only on its own subscription, re-reads, and unsubscribes', async () => {
    // Mutation: drop the `msg.requestId === subscribeId` check -> the stale frame rings.
    const client = scriptedClient({ pages: { a: [{}, { events: [ev(3)], cursor: { sessionId: 'a', journalId: 'j1', seq: 3 } }] } })
    const cursor = encodeCursor({ sessionId: 'a', journalId: 'j1', seq: 2 })
    const waiting = new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], cursors: [cursor], timeoutMs: 5000 })
    await settle()
    assert.equal(client.listenerCount(), 1, 'the bell is armed while the subscription is open')
    const sub = client.log.find((m) => m.type === 'principal_subscribe')
    assert.deepEqual(sub.cursors, [{ sessionId: 'a', journalId: 'j1', seq: 2 }], 'subscribes from the read position, so nothing in between is missed')
    client.push({ type: 'principal_event', sessionId: 'other', journalSeq: 9 })
    client.push({ type: 'principal_event', sessionId: 'a', journalSeq: 3, requestId: 'an-earlier-subscribe' })
    await settle()
    assert.equal(client.log.filter((m) => m.type === 'principal_events_read').length, 1, 'neither another session nor a stale subscription rang')
    client.push({ type: 'principal_event', sessionId: 'a', journalSeq: 3 })
    const r = await waiting
    assert.equal(r.timedOut, false)
    assert.deepEqual(r.events.map((e) => e.seq), [3])
    assert.equal(client.log.at(-1).type, 'principal_unsubscribe')
    assert.equal(client.listenerCount(), 0, 'no listener outlives the wait')
  })

  it('times out with no events, cursor kept, and unsubscribes', async () => {
    const client = scriptedClient()
    const cursor = encodeCursor({ sessionId: 'a', journalId: 'j1', seq: 5 })
    const r = await new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], cursors: [cursor], timeoutMs: 50 })
    assert.equal(r.timedOut, true)
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.cursors, [cursor])
    assert.equal(client.log.at(-1).type, 'principal_unsubscribe')
    assert.equal(client.listenerCount(), 0)
  })

  it('a subscribe whose ack is lost is still unsubscribed', async () => {
    // Mutation: set the "attempted" flag only after the subscribe resolves -> no unsubscribe.
    const client = scriptedClient({ subscribe: 'timeout' })
    await assert.rejects(new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], timeoutMs: 1000 }), { code: 'TIMEOUT' })
    assert.equal(client.log.at(-1).type, 'principal_unsubscribe')
    assert.equal(client.listenerCount(), 0)
  })

  it('reports a page gap at once', async () => {
    const client = scriptedClient({ pages: { a: [{ gap: { reason: 'evicted', fromSeq: 1, toSeq: 4 } }] } })
    const r = await new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], timeoutMs: 1000 })
    assert.deepEqual(r.gaps, [{ sessionId: 'a', reason: 'evicted', fromSeq: 1, toSeq: 4 }])
    assert.equal(r.timedOut, false)
  })

  it('a terminal gap (session removed) is returned without re-reading the removed session', async () => {
    // Mutation: drop the `ended` skip in readAll -> the refused re-read throws and the gap is lost.
    let reads = 0
    const client = scriptedClient({
      pages: {
        a: () => {
          reads++
          if (reads > 1) throw Object.assign(new Error('scope_denied'), { code: 'scope_denied' })
          return { type: 'principal_events_page', sessionId: 'a', journalId: 'j1', events: [], headSeq: 0, cursor: { sessionId: 'a', journalId: 'j1', seq: 0 }, more: false }
        },
      },
    })
    const waiting = new PrincipalObserver(client).waitEvents({ sessionIds: ['a', 'b'], timeoutMs: 5000 })
    await settle()
    client.push({ type: 'principal_gap', sessionId: 'a', journalId: 'j1', reason: 'removed', ended: true })
    const r = await waiting
    assert.deepEqual(r.gaps, [{ sessionId: 'a', reason: 'removed', ended: true }])
    assert.equal(r.timedOut, false)
    assert.equal(reads, 1, 'the removed session was read once, before the wait, never after its end')
  })

  it('a teardown while the subscribe is in flight rejects promptly with no unhandled rejection', async () => {
    // Mutation: drop `bell.promise.catch(() => {})` in arm() -> an unhandledRejection is recorded.
    const unhandled = []
    const onUnhandled = (err) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    cleanups.push(() => process.removeListener('unhandledRejection', onUnhandled))
    const client = scriptedClient({ subscribe: 'hang' })
    const waiting = new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], timeoutMs: MAX_WAIT_EVENTS_MS })
    await settle()
    client.teardown(Object.assign(new Error('connection closed (code=4401)'), { code: 'NOT_CONNECTED' }))
    await assert.rejects(waiting, { code: 'NOT_CONNECTED' })
    await settle()
    assert.deepEqual(unhandled, [], 'the bell rejection was handled')
    assert.equal(client.log.some((m) => m.type === 'principal_unsubscribe'), false, 'nothing is sent on a closed connection')
  })

  it('a teardown while blocked rejects the wait promptly instead of hanging', async () => {
    const client = scriptedClient()
    const waiting = new PrincipalObserver(client).waitEvents({ sessionIds: ['a'], timeoutMs: MAX_WAIT_EVENTS_MS })
    await settle()
    const started = Date.now()
    client.teardown(Object.assign(new Error('connection closed (code=4401)'), { code: 'NOT_CONNECTED' }))
    await assert.rejects(waiting, { code: 'NOT_CONNECTED' })
    assert.ok(Date.now() - started < 1000, 'rejected at once, not at the 60 s timeout')
  })

  it('every request in a wait gets only what is left of the aggregate ceiling', async () => {
    // Mutation: stop passing budget() to a request -> its timeoutMs is undefined (the 15 s default).
    const clock = { t: 1_000_000 }
    const client = scriptedClient({ pages: { a: [{}, { events: [ev(1)] }] } })
    const observer = new PrincipalObserver(client, { now: () => clock.t })
    const waiting = observer.waitEvents({ sessionIds: ['a'], timeoutMs: 2_000 })
    await settle()
    clock.t += 1_500
    client.push({ type: 'principal_event', sessionId: 'a', journalSeq: 1 })
    await waiting
    const timeouts = client.log.filter((m) => m.type !== 'principal_unsubscribe').map((m) => m.timeoutMs)
    assert.ok(timeouts.every((t) => Number.isInteger(t) && t > 0 && t <= 2_000 + WAIT_READ_GRACE_MS), JSON.stringify(timeouts))
    assert.equal(timeouts.at(-1), 2_000 + WAIT_READ_GRACE_MS - 1_500, 'the read after the ring is bounded by the remaining ceiling')
  })

  it('allows one wait at a time and validates its arguments', async () => {
    const client = scriptedClient()
    const observer = new PrincipalObserver(client)
    const first = observer.waitEvents({ sessionIds: ['a'], timeoutMs: 100 })
    await assert.rejects(observer.waitEvents({ sessionIds: ['a'], timeoutMs: 10 }), { code: 'WAIT_IN_PROGRESS' })
    await first
    await assert.rejects(observer.waitEvents({ timeoutMs: MAX_WAIT_EVENTS_MS + 1 }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(observer.waitEvents({ sessionIds: ['a'], cursors: [encodeCursor({ sessionId: 'b', journalId: 'j', seq: 1 })] }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(observer.waitEvents({ sessionIds: ['a'], cursors: [encodeCursor({ sessionId: 'a', journalId: 'j', seq: 1 }), encodeCursor({ sessionId: 'a', journalId: 'j', seq: 2 })] }), { code: 'INVALID_ARGUMENTS' })
    await assert.rejects(observer.waitEvents({ sessionIds: ['a', 'a'] }), { code: 'INVALID_ARGUMENTS' })
    // Positive control: after the first wait settles, a new one runs.
    const again = await observer.waitEvents({ sessionIds: ['a'], timeoutMs: 0 })
    assert.equal(again.timedOut, true)
  })

  it('omitting sessionIds watches the granted roster', async () => {
    const client = scriptedClient({ pages: { b: [{ events: [ev(1)] }] } })
    const r = await new PrincipalObserver(client).waitEvents({ timeoutMs: 0 })
    assert.deepEqual(r.sessionIds, ['a', 'b'])
    assert.deepEqual(r.events.map((e) => e.sessionId), ['b'])
  })
})
