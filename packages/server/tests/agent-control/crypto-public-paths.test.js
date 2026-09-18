import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { AgentControlClient, redactToken } from '../../src/agent-control/client.js'
import { createKeyPair, createSigningKeyPair, deriveSharedKey, deriveConnectionKey, signExchangeKey, decrypt, encrypt, DIRECTION_CLIENT, DIRECTION_SERVER } from '@chroxy/store-core/crypto'

const TOKEN = 'fixture-bearer-token'
const KEY = 'sk-ant-api03-' + 'a'.repeat(48)
test('exact bearer redaction also covers short configured tokens', () => {
  assert.equal(redactToken('short-abc-value', 'abc'), 'short-[REDACTED_TOKEN]-value')
})
async function fixture(t, options = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const identity = createSigningKeyPair()
  let exchanges = 0
  server.on('connection', socket => {
    let key
    let received = 0
    let sent = 0
    const exchange = createKeyPair()
    const respond = message => socket.send(JSON.stringify(key ? encrypt(JSON.stringify(message), key, sent++, DIRECTION_SERVER) : message))
    const signature = () => options.unsigned ? {} : { serverKeySig: signExchangeKey(exchange.publicKey, identity.secretKey, { domainSeparated: true }) }
    socket.on('message', raw => {
      let message = JSON.parse(raw)
      if (message.type === 'encrypted') message = decrypt(message, key, received++, DIRECTION_CLIENT)
      if (message.type === 'auth') {
        if (options.authFailure) {
          socket.send(JSON.stringify({ type: 'auth_fail', reason: `Rejected ${TOKEN} ${KEY}` }))
          return
        }
        const metadata = { type: 'auth_ok', encryption: options.plaintext ? 'disabled' : 'required', capabilities: { inputContextV1: true }, serverVersion: options.secretMetadata ? `${TOKEN} ${KEY}` : 'fixture' }
        if (!options.discrete && !options.plaintext) {
          key = deriveConnectionKey(deriveSharedKey(message.eagerPublicKey, exchange.secretKey), message.eagerSalt)
          metadata.serverPublicKey = exchange.publicKey
          Object.assign(metadata, signature())
        }
        socket.send(JSON.stringify(metadata))
      } else if (message.type === 'key_exchange') {
        exchanges++
        key = deriveConnectionKey(deriveSharedKey(message.publicKey, exchange.secretKey), message.salt)
        socket.send(JSON.stringify({ type: 'key_exchange_ok', publicKey: exchange.publicKey, ...signature() }))
      } else if (message.type === 'ping') { respond({ type: 'pong' }) }
    })
  })
  const client = new AgentControlClient({ url: `ws://127.0.0.1:${server.address().port}`, token: TOKEN, silent: true, connectTimeoutMs: 400, ...options.clientOptions, identityPublicKey: options.pin === false ? undefined : options.wrongPin ? createSigningKeyPair().publicKey : identity.publicKey })
  t.after(async () => {
    await client.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  return { client, exchanges: () => exchanges }
}
test('a signed matching identity pin connects', async t => {
  const { client } = await fixture(t)
  await client.connect()
  assert.equal(client.state, 'ready')
})
test('a wrong identity pin refuses the connection', async t => {
  const { client } = await fixture(t, { wrongPin: true })
  await assert.rejects(client.connect(), { code: 'IDENTITY_MISMATCH' })
})
test('an unsigned pinned exchange refuses the connection', async t => {
  const { client } = await fixture(t, { unsigned: true })
  await assert.rejects(client.connect(), { code: 'IDENTITY_UNSIGNED' })
})
test('a pinned plaintext downgrade refuses the connection', async t => {
  const { client } = await fixture(t, { plaintext: true })
  await assert.rejects(client.connect(), { code: 'IDENTITY_PIN_REQUIRES_ENCRYPTION' })
})
test('the discrete fallback derives the key and completes an encrypted ping', async t => {
  const f = await fixture(t, { discrete: true })
  await f.client.connect()
  assert.equal(f.client.state, 'ready')
  assert.equal(f.exchanges(), 1)
})
test('daemon metadata redacts bearer and other provider keys', async t => {
  const { client } = await fixture(t, { secretMetadata: true })
  await client.connect()
  const value = JSON.stringify(client.daemonInfo)
  assert.ok(!value.includes(TOKEN))
  assert.ok(!value.includes(KEY))
  const bounded = client._buildDaemonMeta({ serverVersion: 'x'.repeat(10000), latestVersion: { token: TOKEN } })
  assert.equal(bounded.serverVersion.length, 512)
  assert.equal(bounded.latestVersion, null)
})
test('auth failure redacts bearer and provider keys on the actual connect path', async t => {
  const { client } = await fixture(t, { authFailure: true })
  await assert.rejects(client.connect(), error => {
    assert.equal(error.code, 'AUTH_FAILED')
    assert.ok(!error.message.includes(TOKEN))
    assert.ok(!error.message.includes(KEY))
    return true
  })
})
test('logger and public socket error redact provider keys', async t => {
  const logged = []
  const { client } = await fixture(t, { clientOptions: { log: (...args) => logged.push(args.join(' ')) } })
  await client.connect()
  client._log(`Other key ${KEY}`)
  let error
  client.on('error', value => { error = value })
  client._onSocketError(new Error(`Socket ${TOKEN} ${KEY}`))
  assert.ok(!logged.join(' ').includes(KEY))
  assert.ok(!error.message.includes(TOKEN))
  assert.ok(!error.message.includes(KEY))
  assert.ok(!error.stack.includes(KEY))
})

test('public close reasons redact bearer and other provider keys', async t => {
  const { client } = await fixture(t)
  await client.connect()
  let closed
  client.on('close', value => { closed = value })
  client._onSocketClosed(1000, Buffer.from(`${TOKEN} ${KEY}`))
  assert.equal(closed.code, 1000)
  assert.ok(!closed.reason.includes(TOKEN))
  assert.ok(!closed.reason.includes(KEY))
})
