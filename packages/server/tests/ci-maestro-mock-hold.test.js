import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { on, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import WebSocket from 'ws'
import { isMaestroControlPeer } from '../../app/.maestro/scripts/maestro-control-loopback.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mockServer = resolve(root, 'packages/app/.maestro/mock-server.mjs')
const releaseScript = readFileSync(resolve(root, 'packages/app/.maestro/scripts/release-reconnect-hold.js'), 'utf8')

async function unusedPort() {
  const probe = createServer()
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

async function waitForStatus(url, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.status === expected) return response
    } catch { /* The child may still be starting. */ }
    await delay(75)
  }
  throw new Error(`mock health never returned ${expected}`)
}

async function startMock(t, failsafeMs = 45000) {
  const port = await unusedPort()
  const child = spawn(process.execPath, [mockServer, '--port', String(port)], {
    cwd: root,
    env: { ...process.env, MAESTRO_MOCK_HOLD_FAILSAFE_MS: String(failsafeMs) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    if (child.exitCode === null) {
      try { await once(child, 'exit', { signal: AbortSignal.timeout(2000) }) }
      catch { child.kill('SIGKILL') }
    }
  })
  const base = `http://127.0.0.1:${port}`
  try { await waitForStatus(`${base}/health`, 200) }
  catch (error) { throw new Error(`${error.message}\n${logs}`) }
  return { base, port }
}

async function triggerHold(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await once(ws, 'open', { signal: AbortSignal.timeout(5000) })
  ws.send(JSON.stringify({ type: 'auth', token: 'test-token-maestro' }))
  const [reply] = await once(ws, 'message', { signal: AbortSignal.timeout(5000) })
  assert.equal(JSON.parse(reply).type, 'auth_ok')
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) })
  ws.send(JSON.stringify({ type: 'input', data: 'simulate-disconnect-hold' }))
  return closed
}

function postRelease(base) {
  return fetch(`${base}/maestro/reconnect-hold/release`, {
    method: 'POST', signal: AbortSignal.timeout(3000)
  })
}

describe('Maestro mock disconnected-action window (#5699)', () => {
  it('accepts only the exact localhost peer forms for the control endpoint', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isMaestroControlPeer(address), true)
    }
    for (const address of ['127.0.0.2', '::ffff:127.0.0.2', '192.0.2.1', 'localhost', undefined]) {
      assert.equal(isMaestroControlPeer(address), false)
    }
  })

  it('keeps health down past the old timer until an exact local release, then reconnects', async t => {
    const { base, port } = await startMock(t)
    assert.equal((await postRelease(base)).status, 409, 'no hold must not be reported as released')
    assert.equal((await fetch(`${base}/maestro/reconnect-hold/release`)).status, 405)

    const closed = await triggerHold(port)
    await waitForStatus(`${base}/health`, 503)
    await closed
    await delay(10500)
    assert.equal((await fetch(`${base}/health`)).status, 503, 'hold must survive Maestro tap settling')

    const release = await postRelease(base)
    assert.equal(release.status, 200)
    assert.deepEqual(await release.json(), { released: true })
    await waitForStatus(`${base}/health`, 200)
    assert.equal((await postRelease(base)).status, 409, 'release must be one-shot')

    const recovered = new WebSocket(`ws://127.0.0.1:${port}`)
    t.after(() => recovered.close())
    await once(recovered, 'open', { signal: AbortSignal.timeout(5000) })
    recovered.send(JSON.stringify({ type: 'auth', token: 'test-token-maestro' }))
    const [reply] = await once(recovered, 'message', { signal: AbortSignal.timeout(5000) })
    assert.equal(JSON.parse(reply).type, 'auth_ok')
  })

  it('expires an abandoned hold and rejects its late release', async t => {
    const { base, port } = await startMock(t, 1200)
    triggerHold(port).catch(() => {})
    await waitForStatus(`${base}/health`, 503)
    await waitForStatus(`${base}/health`, 200, 4000)
    assert.equal((await postRelease(base)).status, 409)
  })

  it('rejects unsuccessful or malformed release responses in the actual Maestro script', () => {
    const execute = response => runInNewContext(releaseScript, {
      http: { post: () => response }, JSON, Error
    })
    assert.doesNotThrow(() => execute({ status: 200, body: '{"released":true}' }))
    assert.throws(() => execute({ status: 409, body: '{"released":false}' }), /release failed \(HTTP 409\)/)
    assert.throws(() => execute({ status: 200, body: 'not JSON' }), /invalid JSON/)
    assert.throws(() => execute({ status: 200, body: '{"released":false}' }), /release failed/)
  })
})


describe('Maestro mock plan completion (#8844)', () => {
  it('finishes each plan turn in production order and preserves the canonical approval roundtrip', { timeout: 15000 }, async t => {
    const { port } = await startMock(t)
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    t.after(() => ws.terminate())
    await once(ws, 'open', { signal: AbortSignal.timeout(5000) })

    // The mock handles each input synchronously. A following ping is a wire
    // barrier: collect every preceding reply without sleeps or assuming the
    // completion events exist (a deleted event must fail an assertion promptly).
    const exchange = async message => {
      const replies = on(ws, 'message', { signal: AbortSignal.timeout(2000), close: ['close'] })
      const frames = []
      try {
        ws.send(JSON.stringify(message))
        ws.send(JSON.stringify({ type: 'ping' }))
        for await (const [raw] of replies) {
          const { seq: _seq, ...frame } = JSON.parse(raw.toString())
          if (frame.type === 'pong') return frames
          frames.push(frame)
        }
        assert.fail('mock socket closed before the reply barrier')
      } finally { await replies.return() }
    }

    const authenticated = await exchange({ type: 'auth', token: 'test-token-maestro' })
    assert.equal(authenticated[0].type, 'auth_ok')
    const sessionId = 'mock-sess-1'
    const result = { type: 'result', cost: 0.001, duration: 100, usage: {}, sessionId }
    for (let turn = 0; turn < 2; turn++) {
      const plan = await exchange({ type: 'input', data: 'show-plan-approval', sessionId })
      assert.deepEqual(plan, [
        { type: 'plan_ready', sessionId, allowedPrompts: [
          { tool: 'Bash', prompt: 'npm test' },
          { tool: 'Edit', prompt: 'src/index.js' },
        ] },
        result,
        { type: 'agent_idle', sessionId },
      ], 'each plan turn must complete after plan_ready, in the same session')

      const approval = await exchange({ type: 'input', data: 'Go ahead with the plan', sessionId })
      assert.deepEqual(approval.map(frame => frame.type), [
        'stream_start', 'agent_busy', 'stream_delta', 'stream_end', 'result', 'agent_idle',
      ])
      assert.ok(approval.every(frame => frame.sessionId === sessionId))
      const messageId = approval[0].messageId
      assert.equal(typeof messageId, 'string')
      assert.ok(messageId.length > 0)
      assert.deepEqual(approval[2], {
        type: 'stream_delta', messageId, sessionId,
        delta: 'I received your message: "Go ahead with the plan". This is a mock response for E2E testing.',
      })
      assert.equal(approval[3].messageId, messageId)
      assert.deepEqual(approval[4], result)
    }
  })
})
