import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'

import { WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { createMockSession } from './test-helpers.js'

/**
 * #7019 — POST /permission-floor through the REAL stack.
 *
 * `permission-hook-floor.test.js` drives the handler behind its own
 * `createServer`, with `validateBearerAuth` / `validateHookAuth` stubbed to
 * `() => true` and the route re-implemented as an `if` in the test. That leaves
 * the endpoint's own safety net unobserved: the hook-secret gate, the route
 * registration, the dedicated rate limiter and the body cap could each be
 * removed and every test there would stay green.
 *
 * Here the request goes through a real `WsServer`: its real `httpServer`, the
 * real route table in `http-routes.js`, the real `_validateHookAuth`, and the
 * real `PairingManager` for the pairing-bound tokens. Nothing on the request
 * path is stubbed.
 *
 * The 403 cases are always paired with a positive control (the same request with
 * the right secret answers 200). A gate that denied EVERYTHING would pass every
 * negative test below and be unusable; the control is what shows the 403 is a
 * decision and not a dead route.
 */

const PRIMARY_TOKEN = 'primary-token-0123456789abcdef'
const HOOK_SECRET = 'hook-secret-0123456789abcdef'
const SESSION_CWD = '/work/project'
const MAX_FLOOR_BODY = 1_048_576

const readEnv = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '.env' } })
const readSrc = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'src/index.js' } })

describe('POST /permission-floor through the real WsServer (#7019)', () => {
  let server
  let pm
  let port

  afterEach(() => {
    try { server?.httpServer?.closeAllConnections?.() } catch { /* already gone */ }
    try { server?.close() } catch { /* already closed */ }
    pm?.destroy()
    server = null
    pm = null
  })

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.authRequired]
   * @param {boolean} [opts.withHookSecret]  register a per-session hook secret (the
   *   normal multi-session shape). `false` models the legacy / test shape where
   *   `_validateHookAuth` falls back to the primary token.
   */
  async function boot({ authRequired = true, withHookSecret = true } = {}) {
    pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    const cliSession = createMockSession(withHookSecret ? { _hookSecret: HOOK_SECRET, cwd: SESSION_CWD } : { cwd: SESSION_CWD })
    server = new WsServer({ port: 0, apiToken: PRIMARY_TOKEN, cliSession, pairingManager: pm, authRequired, noEncrypt: true })
    server.start('127.0.0.1')
    await once(server.httpServer, 'listening')
    port = server.httpServer.address().port
  }

  function postFloor(body, headers = {}) {
    return globalThis.fetch(`http://127.0.0.1:${port}/permission-floor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      // A regression that lets a request through can leave it parked (POST
      // /permission holds an unanswered request for minutes): fail fast instead.
      signal: AbortSignal.timeout(10_000),
    })
  }
  const bearer = (token) => ({ Authorization: `Bearer ${token}` })

  /** A real pairing-issued session token: unbound (linking mode) or bound to a session. */
  function pairingToken({ bound }) {
    const id = bound ? pm.generateBoundPairing('sess-1').pairingId : pm.currentPairingId
    const out = pm.validatePairing(id)
    assert.equal(out.valid, true, 'fixture: the pairing must mint a token')
    assert.equal(pm.isSessionTokenValid(out.sessionToken), true, 'fixture: the minted token is a real session token')
    return out.sessionToken
  }

  async function assertRejected(res) {
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.deepEqual(body, { error: 'unauthorized' }, 'a 403 carries no `floor` key — the hook treats it as "prompt"')
  }

  // -------------------------------------------------------------------------
  // 1 + 2. Route registration and auth, hook secrets registered (normal operation)
  // -------------------------------------------------------------------------

  describe('with a hook secret registered (normal multi-session operation)', () => {
    it('the registered hook secret reaches the handler: 200 with the session-anchored verdict', async () => {
      await boot()
      const ok = await postFloor(readSrc, bearer(HOOK_SECRET))
      assert.equal(ok.status, 200)
      assert.deepEqual(await ok.json(), { floor: false })
      const floored = await postFloor(readEnv, bearer(HOOK_SECRET))
      assert.equal(floored.status, 200)
      assert.deepEqual(await floored.json(), { floor: true })
    })

    it('no Authorization header → 403', async () => {
      await boot()
      await assertRejected(await postFloor(readSrc))
    })

    it('a wrong hook secret → 403', async () => {
      await boot()
      await assertRejected(await postFloor(readSrc, bearer('not-the-secret')))
      // Same length as the real secret, differing in the last byte.
      await assertRejected(await postFloor(readSrc, bearer(HOOK_SECRET.slice(0, -1) + 'X')))
    })

    it('an empty bearer, or a non-Bearer scheme → 403', async () => {
      await boot()
      await assertRejected(await postFloor(readSrc, { Authorization: 'Bearer ' }))
      await assertRejected(await postFloor(readSrc, { Authorization: `Basic ${HOOK_SECRET}` }))
      await assertRejected(await postFloor(readSrc, { Authorization: HOOK_SECRET }))
    })

    it('the PRIMARY api token is rejected once a hook secret is registered', async () => {
      await boot()
      await assertRejected(await postFloor(readSrc, bearer(PRIMARY_TOKEN)))
      // control: the same request with the hook secret is served
      assert.equal((await postFloor(readSrc, bearer(HOOK_SECRET))).status, 200)
    })

    it('an UNBOUND pairing token (an ordinary paired phone) is rejected', async () => {
      await boot()
      await assertRejected(await postFloor(readSrc, bearer(pairingToken({ bound: false }))))
      assert.equal((await postFloor(readSrc, bearer(HOOK_SECRET))).status, 200)
    })

    it('a session-BOUND pairing token is rejected', async () => {
      await boot()
      await assertRejected(await postFloor(readSrc, bearer(pairingToken({ bound: true }))))
      assert.equal((await postFloor(readSrc, bearer(HOOK_SECRET))).status, 200)
    })

    it('a rejected request never carries a verdict, even for a body that would be floored', async () => {
      await boot()
      // A body that WOULD be floored: the rejection must not leak the verdict.
      const res = await postFloor(readEnv, bearer('not-the-secret'))
      assert.equal(res.status, 403)
      assert.equal('floor' in (await res.json()), false)
    })

    it('the route is POST-only: a GET with the right secret is not served by the handler', async () => {
      await boot()
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/permission-floor`, { headers: bearer(HOOK_SECRET) })
      const text = await res.text()
      assert.equal(res.status, 404)
      assert.equal(text.includes('"floor"'), false)
    })
  })

  // -------------------------------------------------------------------------
  // 1b. The two pre-existing branches of _validateHookAuth, pinned AS THEY ARE.
  //     These pin current behaviour; they are not a statement that it is ideal.
  // -------------------------------------------------------------------------

  describe('with NO hook secret registered (the primary-token fallback of _validateHookAuth)', () => {
    it('the primary token is accepted, but the owning session is unresolvable so the verdict is floor:true', async () => {
      await boot({ withHookSecret: false })
      // A benign path is still floored: no hook secret → no owning session → no
      // cwd to resolve against → fail closed (one prompt, never a silent allow).
      const res = await postFloor(readSrc, bearer(PRIMARY_TOKEN))
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { floor: true })
    })

    it('a pairing-issued token is ALSO accepted on this branch (it is a valid token to _isTokenValid)', async () => {
      await boot({ withHookSecret: false })
      const res = await postFloor(readSrc, bearer(pairingToken({ bound: true })))
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { floor: true })
    })

    it('an unknown token and a missing header are still rejected', async () => {
      await boot({ withHookSecret: false })
      await assertRejected(await postFloor(readSrc, bearer('nope')))
      await assertRejected(await postFloor(readSrc))
      assert.equal((await postFloor(readSrc, bearer(PRIMARY_TOKEN))).status, 200, 'control')
    })
  })

  describe('with authRequired === false (the no-auth branch of _validateHookAuth)', () => {
    it('an anonymous request is served, with no owning session so it still fails closed', async () => {
      await boot({ authRequired: false })
      const res = await postFloor(readSrc)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { floor: true })
    })

    it('the hook secret still resolves the owning session, so the verdict is the real one', async () => {
      await boot({ authRequired: false })
      assert.deepEqual(await (await postFloor(readSrc, bearer(HOOK_SECRET))).json(), { floor: false })
      assert.deepEqual(await (await postFloor(readEnv, bearer(HOOK_SECRET))).json(), { floor: true })
    })
  })

  // -------------------------------------------------------------------------
  // 3. The rate limiter
  // -------------------------------------------------------------------------

  describe('the dedicated rate limiter (600/min + 200 burst)', () => {
    /** Fire requests until the first 429; resolves { allowed, limited }. */
    async function exhaust(headers, cap = 1200) {
      let allowed = 0
      for (let i = 0; i < cap; i += 50) {
        const batch = await Promise.all(Array.from({ length: 50 }, () => postFloor(readSrc, headers)))
        for (const res of batch) {
          if (res.status === 429) return { allowed, limited: res }
          await res.arrayBuffer()
          allowed++
        }
      }
      return { allowed, limited: null }
    }

    it('exceeding it answers 429 and the 429 still says floor:true (fail closed)', async () => {
      await boot()
      const { allowed, limited } = await exhaust(bearer(HOOK_SECRET))
      assert.ok(limited, 'the limiter must engage within 1200 requests')
      // Far above /permission's 30/min: a busy auto-mode session fires one probe
      // per tool call and must not be limited by anything near that budget.
      assert.ok(allowed >= 600, `the floor budget must exceed 600/min, was limited after ${allowed}`)
      assert.equal(limited.status, 429)
      const body = await limited.json()
      assert.equal(body.floor, true, 'a limited caller must fail CLOSED')
      assert.equal(body.error, 'rate limited')
      assert.equal(typeof body.retryAfterMs, 'number')
      assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'Retry-After header')
    })

    it('runs BEFORE auth: an unauthenticated caller spends the budget, and the next real request is told floor:true', async () => {
      await boot()
      // No credentials at all — every one of these is a 403 until the budget is gone.
      const { limited } = await exhaust({})
      assert.ok(limited, 'unauthenticated traffic exhausts the shared budget')
      // Now the legitimate hook is limited as well, and still fails closed.
      const legit = await postFloor(readSrc, bearer(HOOK_SECRET))
      assert.equal(legit.status, 429)
      assert.equal((await legit.json()).floor, true)
      // Another unauthenticated request gets the 429, not a 403: the limiter
      // answers first.
      assert.equal((await postFloor(readSrc)).status, 429)
    })

    it('is its own budget: exhausting it does not rate-limit POST /permission', async () => {
      await boot()
      const { limited } = await exhaust({})
      assert.ok(limited)
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      })
      assert.equal(res.status, 403, 'reaches the auth gate, so the /permission limiter was not consumed')
    })
  })

  // -------------------------------------------------------------------------
  // 4. The body cap
  // -------------------------------------------------------------------------

  describe('MAX_FLOOR_BODY (1 MiB)', () => {
    const padded = (bytes) => {
      const head = '{"tool_name":"Read","tool_input":{"file_path":"src/a.js","pad":"'
      const tail = '"}}'
      return head + 'x'.repeat(bytes - head.length - tail.length) + tail
    }

    it('a body one KiB over the cap answers 413 {floor:true}, delivered (not a socket reset)', async () => {
      await boot()
      const body = padded(MAX_FLOOR_BODY + 1024)
      assert.ok(Buffer.byteLength(body) > MAX_FLOOR_BODY)
      // A bare await: a reset connection would make fetch() REJECT.
      const res = await postFloor(body, bearer(HOOK_SECRET))
      assert.equal(res.status, 413)
      assert.deepEqual(await res.json(), { floor: true })
    })

    it('a body just under the cap is served normally (the cap is not tighter than documented)', async () => {
      await boot()
      const body = padded(MAX_FLOOR_BODY - 1024)
      assert.ok(Buffer.byteLength(body) < MAX_FLOOR_BODY)
      const res = await postFloor(body, bearer(HOOK_SECRET))
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { floor: false })
    })

    it('the cap counts BYTES, not UTF-16 code units', async () => {
      await boot()
      // 400k euro signs: 400k code units (under the cap) but 1.2M bytes (over it).
      const body = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'src/a.js', pad: '€'.repeat(400_000) } })
      assert.ok(body.length < MAX_FLOOR_BODY)
      assert.ok(Buffer.byteLength(body, 'utf8') > MAX_FLOOR_BODY)
      const res = await postFloor(body, bearer(HOOK_SECRET))
      assert.equal(res.status, 413)
      assert.deepEqual(await res.json(), { floor: true })
    })

    it('is its own cap: a body over /permission\'s 64 KiB but under 1 MiB is served', async () => {
      await boot()
      const res = await postFloor(padded(200 * 1024), bearer(HOOK_SECRET))
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { floor: false })
    })
  })
})
