import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm, stat, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createSmokeFixture, armSmoke } from '../../desktop/scripts/native-notification-smoke.mjs'
import { computeHealthProof } from '../src/health-proof.js'

async function setup(t, opts) {
  const fixture = await createSmokeFixture(opts)
  t.after(async () => { await fixture.dispose(); await rm(fixture.root, { recursive: true, force: true }) })
  const { apiToken } = JSON.parse(await readFile(`${fixture.root}/config.json`))
  const { controlToken } = JSON.parse(await readFile(`${fixture.root}/control.json`))
  const request = (path, body, headers = {}, auth = apiToken) => fetch(`${fixture.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  return { ...fixture, apiToken, controlToken, request }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

async function finish(page) {
  let timeout
  try {
    await Promise.race([page.done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('native IPC did not fail or finish promptly')), 500) })])
  } finally { clearTimeout(timeout) }
}

async function client(fixture, invoke, { timeoutMs = 5000 } = {}) {
  const source = await (await fixture.request('/smoke-client.js')).text()
  const status = { textContent: '' }
  const done = vm.runInNewContext(source, {
    window: invoke ? { __TAURI_INTERNALS__: { invoke } } : {},
    document: { getElementById: () => status },
    location: { href: `${fixture.origin}/dashboard?token=${fixture.apiToken}` },
    history: { replaceState() {} }, URL, AbortSignal,
    fetch: (path, opts) => fetch(`${fixture.origin}${path}`, opts),
    setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? timeoutMs : 5), clearTimeout,
  })
  return { done, status }
}

test('fixture owns private synthetic config and serves the production health challenge proof', async t => {
  const f = await setup(t)
  assert.equal(new URL(f.origin).hostname, '127.0.0.1')
  assert.ok(![8765, 8785, 3131, 8080, 3000].includes(f.port))
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.root)).mode & 0o777, 0o700)
    for (const name of ['config.json', 'desktop-settings.json', 'control.json', 'receipt.json']) {
      assert.equal((await stat(`${f.root}/${name}`)).mode & 0o777, 0o600)
    }
  }
  const settings = JSON.parse(await readFile(`${f.root}/desktop-settings.json`))
  assert.equal(settings.autoStartServer, false)
  assert.equal(settings.showNotifications, true)
  assert.equal(JSON.parse(await readFile(`${f.root}/config.json`)).encryptLocalhost, true)
  const nonce = randomBytes(32).toString('hex')
  const proof = await (await f.request(`/health?challenge=${nonce}`)).json()
  assert.equal(proof.status, 'ok')
  assert.equal(typeof proof.version, 'string')
  assert.equal(proof.version, JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version)
  assert.equal(proof.mode, 'native-notification-smoke')
  assert.equal(proof.proof, computeHealthProof(f.apiToken, f.port, nonce))
  assert.notEqual(proof.proof, computeHealthProof(f.apiToken, f.port + 1, nonce))
  for (const query of ['challenge=invalid', `challenge=${nonce}&challenge=${nonce}`]) {
    assert.equal('proof' in await (await f.request(`/health?${query}`)).json(), false)
  }
  const page = await (await f.request(`/dashboard?token=${f.apiToken}`)).text()
  assert.ok(page.includes('<script src="/smoke-client.js" defer>'))
  assert.equal((await f.request('/dashboard?token=wrong')).status, 401)
  for (const lifetimeMs of [0, 1800001, 1.5]) await assert.rejects(createSmokeFixture({ lifetimeMs }), /invalid lifetime/)
  for (const receiptTimeoutMs of [0, 10001, 1.5]) await assert.rejects(createSmokeFixture({ receiptTimeoutMs }), /invalid receipt timeout/)
  for (const port of [-1, 65536, 1.5]) await assert.rejects(createSmokeFixture({ port }), /forbidden port/)
  for (const port of [8765, 8785, 3131, 8080, 3000]) await assert.rejects(createSmokeFixture({ port }), /forbidden port/)
})

test('authentication, browser origins, request schemas and readiness reject unsafe admission', async t => {
  const f = await setup(t)
  assert.equal((await f.request('/smoke/ready', {}, {}, 'wrong')).status, 401)
  assert.equal((await f.request('/smoke/ready', {}, { Origin: 'https://example.invalid' })).status, 403)
  assert.equal((await f.request('/smoke/ready', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.origin}/health`, { headers: { Host: 'example.invalid' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(badHostStatus, 403)
  await assert.rejects(armSmoke(f.root), /409/)
  assert.equal((await f.request('/smoke/ready', { arbitrary: 'input' })).status, 409)
  assert.equal((await f.request('/smoke/ready', { padding: 'x'.repeat(1025) })).status, 400)
  assert.equal((await f.request('/smoke/ready', '[]')).status, 400)
  assert.equal((await f.request('/smoke/ready')).status, 405)
  assert.equal((await f.request('/unknown')).status, 404)
  assert.equal((await f.request('/smoke/receipt', { nativeRoute: true })).status, 409)
  assert.equal(f.snapshot().state, 'WAITING')
  await f.request('/smoke/ready', {})
  for (const headers of [{ Origin: f.origin }, { 'Sec-Fetch-Site': 'same-origin' }, { Origin: 'https://example.invalid' }]) {
    assert.equal((await f.request('/smoke/arm', {}, headers, f.controlToken)).status, 403)
  }
  assert.equal((await f.request('/smoke/arm', {})).status, 401)
  assert.equal(f.snapshot().state, 'READY')
})

test('ordinary browser fails explicitly and cannot become ready', async t => {
  const f = await setup(t)
  const page = await client(f)
  await finish(page)
  assert.equal(f.snapshot().state, 'FAILED')
  assert.equal(f.snapshot().reason, 'missing native bridge')
  assert.ok(page.status.textContent.includes('FAILED'))
  await assert.rejects(armSmoke(f.root), /409/)
})

test('native probe rejection and timeout fail before readiness or notification', async t => {
  for (const probe of [() => Promise.reject(new Error('IPC denied')), () => new Promise(() => {})]) {
    const f = await setup(t)
    const calls = []
    const page = await client(f, command => { calls.push(command); return probe() }, { timeoutMs: 25 })
    await finish(page)
    assert.deepEqual(calls, ['get_server_info'])
    assert.equal(f.snapshot().state, 'FAILED')
    await assert.rejects(armSmoke(f.root), /409/)
  }
})

test('exactly one existing native command is admitted; receipt is SUBMITTED, never OS PASS', async t => {
  const f = await setup(t)
  const calls = []
  const page = await client(f, async (command, args) => { calls.push([command, args]); return command === 'send_session_notification' ? true : {} })
  await waitFor(() => f.snapshot().state === 'READY', 'native bridge should reach READY')
  assert.deepEqual(calls.map(([name]) => name), ['get_server_info'])
  await armSmoke(f.root)
  await finish(page)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['get_server_info', null],
    ['send_session_notification', { title: 'Chroxy isolated smoke', body: 'Native notification delivery check' }],
  ])
  assert.deepEqual(f.snapshot(), { state: 'SUBMITTED', reason: null, osDelivery: 'UNVERIFIED' })
  assert.deepEqual(JSON.parse(await readFile(`${f.root}/receipt.json`)), f.snapshot())
  assert.equal((await (await f.request('/smoke/claim', {})).json()).claim, false)
  await assert.rejects(armSmoke(f.root), /409/)
  const reload = await client(f, async command => { calls.push([command]); return {} })
  await finish(reload)
  assert.equal(calls.filter(([command]) => command === 'send_session_notification').length, 1)
  assert.equal(f.snapshot().state, 'SUBMITTED')
})

test('concurrent claims, reconnect, and failed native acknowledgement cannot replay notification', async t => {
  const f = await setup(t, { receiptTimeoutMs: 40 })
  await f.request('/smoke/ready', {})
  await armSmoke(f.root)
  const claims = await Promise.all([f.request('/smoke/claim', {}), f.request('/smoke/claim', {})])
  const bodies = await Promise.all(claims.map(response => response.json()))
  assert.equal(bodies.filter(body => body.claim).length, 1)
  assert.equal(JSON.parse(await readFile(`${f.root}/receipt.json`)).state, 'INVOKING')
  assert.equal((await f.request('/smoke/receipt', { nativeRoute: 'true' })).status, 409)
  assert.equal((await f.request('/smoke/receipt', { nativeRoute: true, extra: true })).status, 409)
  await waitFor(() => f.snapshot().state === 'FAILED', 'missing native receipt should fail')
  assert.equal(f.snapshot().reason, 'native receipt missing')
  assert.equal((await f.request('/smoke/receipt', { nativeRoute: true })).status, 409)
  assert.equal((await (await f.request('/smoke/claim', {})).json()).claim, false)
})

test('false, rejection, and missing native resolution produce explicit failure, never submission', async t => {
  for (const notification of [() => false, () => Promise.reject(new Error('denied')), () => new Promise(() => {})]) {
    const f = await setup(t)
    let notifications = 0
    const page = await client(f, command => {
      if (command === 'get_server_info') return Promise.resolve({})
      notifications++
      return notification()
    }, { timeoutMs: 25 })
    await waitFor(() => f.snapshot().state === 'READY', 'native readiness should succeed')
    await armSmoke(f.root)
    await finish(page)
    assert.equal(notifications, 1)
    assert.equal(f.snapshot().state, 'FAILED')
    assert.equal(f.snapshot().osDelivery, 'UNVERIFIED')
    assert.ok(page.status.textContent.includes('FAILED'))
  }
})

test('lifetime and disposal close the listener and keep the verdict explicit', async t => {
  const f = await setup(t, { lifetimeMs: 100 })
  await waitFor(() => f.snapshot().reason === 'fixture lifetime expired', 'lifetime expires')
  await f.dispose()
  await assert.rejects(fetch(`${f.origin}/health`))
  assert.equal(f.snapshot().state, 'FAILED')
  await assert.rejects(armSmoke('relative'), /absolute/)
})


test('CLI entry point runs through a symlink and rejects invalid arguments without echoing them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-smoke-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const alias = join(root, 'scripts-alias')
  await symlink(fileURLToPath(new URL('../../desktop/scripts/', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const result = spawnSync(process.execPath, [join(alias, 'native-notification-smoke.mjs'), 'invalid-command'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Native smoke fixture failed; usage: native-notification-smoke.mjs serve | arm /absolute/fixture-root\n')
})
