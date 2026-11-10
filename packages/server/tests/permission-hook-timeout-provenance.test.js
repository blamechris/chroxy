import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { PermissionManager } from '../src/permission-manager.js'

/**
 * #8529: when nobody answers a hook-routed permission request, the daemon's own
 * 300 s timer answers `POST /permission` with a 200 deny. That response used to
 * be byte-identical to a real user deny, so `permission-hook.sh` told the model
 * (and the transcript the user later reads) "Denied by user via Chroxy mobile
 * app" about a prompt nobody answered.
 *
 * The daemon now says WHY it denied (`"reason":"timeout"`) and the hook maps
 * exactly that to honest wording. Three things must hold, and each has a test
 * here that goes red when it stops holding:
 *
 *   1. the timeout response carries the field; a user deny does not;
 *   2. the hook reads the field — and only ever to pick the WORDING of a deny;
 *   3. an older daemon (no field) keeps today's wording.
 *
 * The decision is DENY on every one of these paths. Nothing here can turn a
 * non-allow into an allow.
 *
 * WHAT THIS FILE DOES NOT PROVE. It covers the path where the daemon's answer
 * REACHES the hook. The hook's `curl --max-time 300` and the daemon's timer are
 * both 300 s, and curl's clock starts first, so at real clock curl gives up a
 * few milliseconds before the daemon answers and the hook reports its
 * curl-failure wording instead (measured: see the #8529 evidence). The clock is
 * mocked below precisely so the daemon's answer does arrive. Nothing here says
 * which of the two wins in production.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

// Written out here, not read from the hook: the test must not derive its
// expectation from its own subject.
const USER_DENY = 'Denied by user via Chroxy mobile app'
const TIMEOUT_DENY = 'No one answered the Chroxy permission request before it timed out. Failing closed (denied).'
const DAEMON_TIMEOUT_MS = 300_000

// Captured before any test mocks the clock, so the hook's safety kill and the
// polling below keep running on real time while the DAEMON's timer is ticked.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSleep = (ms) => new Promise((r) => realSetTimeout(r, ms))

// Sections 2 and 3 spawn hooks/permission-hook.sh through /bin/bash, so they are
// POSIX-only. Guarded per describe (the preferred fix in
// scripts/lib/windows-test-set.mjs) rather than by exempting the file: sections 1
// and 4 are plain Node and still run on Windows.
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'spawns hooks/permission-hook.sh via /bin/bash' : false }

const HOOK_SECRET = 'test-hook-secret'
const REQUEST = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

/** Spawn the REAL hook script. Rejects unless it exits 0 on its own. */
function runHook({ port, extraEnv = {}, timeout = 15000 }) {
  let exited = false
  const done = new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [hookPath], {
      env: {
        PATH: process.env.PATH,
        CHROXY_PORT: String(port),
        CHROXY_HOOK_SECRET: HOOK_SECRET,
        CHROXY_PERMISSION_MODE: 'approve',
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    const timer = realSetTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => { realClearTimeout(timer); exited = true; reject(err) })
    child.on('close', (status, signal) => {
      realClearTimeout(timer)
      exited = true
      if (signal || status !== 0) {
        reject(new Error(`hook exited uncleanly (status=${status}, signal=${signal})\nstderr: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()).hookSpecificOutput)
    })
    child.stdin.write(REQUEST)
    child.stdin.end()
  })
  // Observed, not awaited, until the test is ready for it.
  done.catch(() => {})
  return { done, hasExited: () => exited }
}

// ---------------------------------------------------------------------------
// 1. The daemon: POST /permission says why it denied
// ---------------------------------------------------------------------------

function makeReq(body) {
  const emitter = new EventEmitter()
  emitter.method = 'POST'
  emitter.headers = { authorization: `Bearer ${HOOK_SECRET}` }
  emitter.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(body))
    emitter.emit('end')
  })
  emitter.destroy = () => {}
  emitter.setEncoding = () => {}
  emitter.pause = () => {}
  return emitter
}

function makeRes() {
  const listeners = {}
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    // Counted, not just remembered: two identical writes leave `body` unchanged,
    // so "the body is still X" cannot prove a response was written once.
    writeHeadCalls: 0,
    endCalls: 0,
    writeHead(code) { this.writeHeadCalls++; this.statusCode = code; this.headersSent = true },
    end(b) { this.endCalls++; this.body = b },
    on(event, cb) { listeners[event] = cb; return this },
    emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
  }
}

function makeHandler(pendingPermissions = new Map()) {
  return createPermissionHandler({
    sendFn: () => {},
    broadcastFn: () => {},
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
    pairingManager: null,
    findSessionByHookSecret: (secret) => (
      secret === HOOK_SECRET ? { session: { cwd: '/work/project' }, sessionId: 'sess-1' } : null
    ),
  })
}

describe('POST /permission: the no-answer auto-deny carries its provenance (#8529)', () => {
  let handler
  afterEach(() => {
    mock.timers.reset()
    handler?.destroy()
    handler = null
  })

  async function raise(pending) {
    const res = makeRes()
    handler.handlePermissionRequest(makeReq(REQUEST), res)
    await new Promise((r) => setImmediate(r))
    const [requestId] = [...pending.keys()]
    assert.ok(requestId, 'the hook request is held pending')
    return { res, requestId }
  }

  it('the timer answers 200 {decision:"deny", reason:"timeout"} — and not one millisecond early', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const pending = new Map()
    handler = makeHandler(pending)
    const { res } = await raise(pending)

    mock.timers.tick(DAEMON_TIMEOUT_MS - 1)
    assert.equal(res.endCalls, 0, 'nothing is answered before the timeout')
    assert.equal(pending.size, 1)

    mock.timers.tick(1)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { decision: 'deny', reason: 'timeout' })
    assert.equal(pending.size, 0, 'the timed-out request is no longer pending')
    assert.equal(res.writeHeadCalls, 1)
    assert.equal(res.endCalls, 1, 'exactly one response')
  })

  it('an answer arriving after the timeout writes nothing: the timeout deny stands', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const pending = new Map()
    handler = makeHandler(pending)
    const { res, requestId } = await raise(pending)
    // Hold the resolver the way a client mid-tap does: the entry is deleted when
    // the timer fires, so only a reference taken beforehand can still reach it.
    const lateAnswer = pending.get(requestId).resolve

    mock.timers.tick(DAEMON_TIMEOUT_MS)
    assert.equal(res.endCalls, 1)
    lateAnswer('allow')
    mock.timers.tick(DAEMON_TIMEOUT_MS)
    assert.equal(res.writeHeadCalls, 1)
    assert.equal(res.endCalls, 1, 'a late allow must not write a second response')
    assert.deepEqual(JSON.parse(res.body), { decision: 'deny', reason: 'timeout' })
  })

  it('a real user deny answers exactly {decision:"deny"} — no timeout provenance', async () => {
    const pending = new Map()
    handler = makeHandler(pending)
    const { res, requestId } = await raise(pending)
    handler.resolvePermission(requestId, 'deny')
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { decision: 'deny' })
    assert.equal(res.endCalls, 1, 'exactly one response')
  })

  it('a user deny one millisecond before the timeout is still a user deny, and the timer cannot answer twice', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const pending = new Map()
    handler = makeHandler(pending)
    const { res, requestId } = await raise(pending)
    mock.timers.tick(DAEMON_TIMEOUT_MS - 1)
    handler.resolvePermission(requestId, 'deny')
    assert.equal(res.endCalls, 1)
    // Well past the original deadline: a timer that survived the answer fires here.
    mock.timers.tick(DAEMON_TIMEOUT_MS)
    assert.deepEqual(JSON.parse(res.body), { decision: 'deny' })
    assert.equal(res.writeHeadCalls, 1)
    assert.equal(res.endCalls, 1, 'exactly one response: the timer must not answer after the user did')
  })

  it('an allow is unchanged: exactly {decision:"allow"}', async () => {
    const pending = new Map()
    handler = makeHandler(pending)
    const { res, requestId } = await raise(pending)
    handler.resolvePermission(requestId, 'allow')
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { decision: 'allow' })
    assert.equal(res.endCalls, 1, 'exactly one response')
  })
})

// ---------------------------------------------------------------------------
// 2. The hook: maps the field to wording, and to nothing else
// ---------------------------------------------------------------------------

/** A mock /permission that answers a fixed status + body. */
async function startFixedServer(status, body) {
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

async function hookAgainst(status, body, extraEnv = {}) {
  const srv = await startFixedServer(status, body)
  try {
    return await runHook({ port: srv.port, extraEnv }).done
  } finally {
    await srv.close()
  }
}

describe('permission-hook.sh: a daemon timeout is not a user deny (#8529)', POSIX_ONLY, () => {
  it('200 deny + reason:timeout DENIES with the timeout wording', async () => {
    const out = await hookAgainst(200, '{"decision":"deny","reason":"timeout"}')
    assert.equal(out.permissionDecision, 'deny', 'a timeout must fail closed')
    assert.equal(out.permissionDecisionReason, TIMEOUT_DENY)
    assert.ok(!/Denied by user/i.test(out.permissionDecisionReason), 'nobody denied this')
  })

  it('field order does not matter', async () => {
    const out = await hookAgainst(200, '{"reason":"timeout","decision":"deny"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TIMEOUT_DENY)
  })

  it('an OLDER daemon (200 deny, no reason field) keeps the user-deny wording', async () => {
    const out = await hookAgainst(200, '{"decision":"deny"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, USER_DENY)
  })

  // Only the exact token is a timeout. A substring match would relabel a deny
  // whose reason merely CONTAINS the word.
  for (const reason of ['timeout2', 'nottimeout', 'no timeout', 'Timeout', 'TIMEOUT', '', 'user']) {
    it(`a reason that is not exactly "timeout" (${JSON.stringify(reason)}) keeps the user-deny wording`, async () => {
      const out = await hookAgainst(200, JSON.stringify({ decision: 'deny', reason }))
      assert.equal(out.permissionDecision, 'deny')
      assert.equal(out.permissionDecisionReason, USER_DENY)
    })
  }

  it('a timeout DENIES even under CHROXY_HOOK_UNREACHABLE_DECISION=ask (that opt-out is for an unreachable daemon)', async () => {
    const out = await hookAgainst(200, '{"decision":"deny","reason":"timeout"}', { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' })
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TIMEOUT_DENY)
  })

  it('the field alone is not a decision: no "decision" at all still DENIES as unrecognized', async () => {
    const out = await hookAgainst(200, '{"reason":"timeout"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(/unrecognized permission response/.test(out.permissionDecisionReason), out.permissionDecisionReason)
  })

  it('an unknown decision beside the field still DENIES as unrecognized', async () => {
    const out = await hookAgainst(200, '{"decision":"maybe","reason":"timeout"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(/unrecognized permission response/.test(out.permissionDecisionReason), out.permissionDecisionReason)
  })

  // SCOPE OF THE NEXT TWO BLOCKS — read before citing them. The hook does not
  // parse JSON. It greps the 200 body for a `"decision":"..."` token (and now,
  // inside the deny branch, a `"reason":"..."` token). So what is proven below is
  // narrower than "malformed responses are rejected":
  //
  //   * a body with NO decision token denies as unrecognized (first block);
  //   * a body that is not valid JSON but still CONTAINS the tokens is read by
  //     those tokens (second block). That is how the hook behaved before #8529,
  //     for `decision` — including an allow token — and this change neither
  //     widens nor fixes it: the new field can only re-word a deny.
  //
  // Replacing the grep with a real parse is a separate change (the floor probe
  // got one in #7017); it is deliberately not attempted here.
  for (const body of ['', 'not json', '{"decision":', '[]', 'null', '{"decision": "deny", "reason": "timeout"}']) {
    it(`a 200 body with no decision token the hook can extract (${JSON.stringify(body)}) still DENIES, as unrecognized`, async () => {
      const out = await hookAgainst(200, body)
      assert.equal(out.permissionDecision, 'deny')
      assert.ok(/unrecognized permission response/.test(out.permissionDecisionReason), out.permissionDecisionReason)
    })
  }

  for (const body of ['{"decision":"deny" !!not-json!! "reason":"timeout"', 'garbage "reason":"timeout" garbage "decision":"deny"']) {
    it(`KNOWN LIMIT, unchanged: an invalid envelope that still carries the tokens (${JSON.stringify(body)}) is read by them — and still DENIES`, async () => {
      const out = await hookAgainst(200, body)
      assert.equal(out.permissionDecision, 'deny', 'whatever the wording, the verdict is deny')
      // Characterization, not endorsement: the wording follows the grepped token.
      assert.equal(out.permissionDecisionReason, TIMEOUT_DENY)
    })
  }

  for (const status of [400, 401, 413, 429, 500, 503]) {
    it(`a non-200 (${status}) is never read for the field: it DENIES with the HTTP-status wording`, async () => {
      const out = await hookAgainst(status, '{"decision":"deny","reason":"timeout"}')
      assert.equal(out.permissionDecision, 'deny')
      assert.ok(out.permissionDecisionReason.includes(`(HTTP ${status})`), out.permissionDecisionReason)
      assert.notEqual(out.permissionDecisionReason, TIMEOUT_DENY)
    })
  }

  it('a non-200 claiming allow beside the field still DENIES', async () => {
    const out = await hookAgainst(500, '{"decision":"allow","reason":"timeout"}')
    assert.equal(out.permissionDecision, 'deny')
  })

  it('allow and allowAlways are unchanged', async () => {
    for (const decision of ['allow', 'allowAlways']) {
      const out = await hookAgainst(200, JSON.stringify({ decision }))
      assert.equal(out.permissionDecision, 'allow')
      assert.equal('permissionDecisionReason' in out, false)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Handler to hook: the production handler answers the real script
// ---------------------------------------------------------------------------

/**
 * The PRODUCTION createPermissionHandler behind a real http server, and the REAL
 * permission-hook.sh (bash + curl) on the other end of a real socket. The one
 * thing not real is the 300 s wait: the daemon's own timer is advanced with the
 * mocked clock, so the callback that runs is the production one.
 */
async function startRealDaemon() {
  const pending = new Map()
  const prompts = []
  const handler = createPermissionHandler({
    sendFn: () => {},
    broadcastFn: (msg) => { if (msg?.type === 'permission_request') prompts.push(msg) },
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions: pending,
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
    pairingManager: null,
    findSessionByHookSecret: (secret) => (
      secret === HOOK_SECRET ? { session: { cwd: '/work/project' }, sessionId: 'sess-1' } : null
    ),
  })
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/permission') { handler.handlePermissionRequest(req, res); return }
    if (req.method === 'POST' && req.url === '/permission-floor') { handler.handlePermissionFloorCheck(req, res); return }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    handler,
    pending,
    prompts,
    /** Wait (real time, bounded) until the hook's request is held by the daemon. */
    async waitForPending() {
      for (let i = 0; i < 400 && pending.size === 0; i++) await realSleep(25)
      assert.equal(pending.size, 1, 'the hook request reached the daemon and is held pending')
      return [...pending.keys()][0]
    },
    close: async () => {
      handler.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

describe('handler to hook: an unanswered request reads as a timeout end to end (#8529)', POSIX_ONLY, () => {
  let daemon
  afterEach(async () => {
    mock.timers.reset()
    await daemon?.close()
    daemon = null
  })

  it('nobody answers: the daemon timer fires and the hook DENIES with the timeout wording', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    daemon = await startRealDaemon()
    const hook = runHook({ port: daemon.port })
    await daemon.waitForPending()
    assert.equal(daemon.prompts.length, 1, 'the prompt was shown to clients')

    mock.timers.tick(DAEMON_TIMEOUT_MS)
    const out = await hook.done
    assert.equal(out.permissionDecision, 'deny', 'a timed-out request must still deny')
    assert.equal(out.permissionDecisionReason, TIMEOUT_DENY)
    assert.equal(daemon.pending.size, 0)
  })

  it('the hook is still waiting one millisecond before the timeout; a user deny then reads as a user deny', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    daemon = await startRealDaemon()
    const hook = runHook({ port: daemon.port })
    const requestId = await daemon.waitForPending()

    mock.timers.tick(DAEMON_TIMEOUT_MS - 1)
    await realSleep(150)
    assert.equal(hook.hasExited(), false, 'no answer has been sent yet')

    daemon.handler.resolvePermission(requestId, 'deny')
    const out = await hook.done
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, USER_DENY)
  })

  it('the user allows: the hook allows', async () => {
    daemon = await startRealDaemon()
    const hook = runHook({ port: daemon.port })
    const requestId = await daemon.waitForPending()
    daemon.handler.resolvePermission(requestId, 'allow')
    const out = await hook.done
    assert.equal(out.permissionDecision, 'allow')
  })
})

// ---------------------------------------------------------------------------
// 4. In-process (SDK / BYOK): already honest — pinned, not changed
// ---------------------------------------------------------------------------

describe('in-process permission timeout already reads as a timeout (#8529)', () => {
  const silentLog = { info() {}, warn() {} }

  it('an unanswered prompt denies with "Permission timed out", never the user-deny message', async () => {
    const pm = new PermissionManager({ log: silentLog, timeoutMs: 5 })
    const resolved = []
    pm.on('permission_resolved', (e) => resolved.push(e))
    try {
      const result = await pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      assert.equal(result.behavior, 'deny', 'a timed-out request must still deny')
      assert.equal(result.message, 'Permission timed out')
      assert.equal(resolved.length, 1)
      assert.equal(resolved[0].decision, 'deny')
      assert.equal(resolved[0].reason, 'timeout')
    } finally {
      pm.destroy()
    }
  })

  it('a user deny keeps "User denied"', async () => {
    const pm = new PermissionManager({ log: silentLog })
    const requests = []
    pm.on('permission_request', (e) => requests.push(e))
    try {
      const promise = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.respondToPermission(requests[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(result.message, 'User denied')
    } finally {
      pm.destroy()
    }
  })
})
