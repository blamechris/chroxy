import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import http from 'node:http'

import { PermissionManager } from '../src/permission-manager.js'
import { isFlooredTarget } from '../src/permission-floor.js'
import { createPermissionHandler, evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { EventNormalizer } from '../src/event-normalizer.js'

/**
 * #7968 — the permission floor's verdict on the wire, from BOTH pipelines.
 *
 * `docs/security/permission-floor.md` promises that a floored prompt (a
 * protected-path / secret-read target) is decided by a person; no lenient
 * mode, allow rule, or automation may approve it. Until this fix, the daemon
 * computed that verdict but never told a client which prompt it applied to:
 *   - the IN-PROCESS pipeline (permission-manager.js `handlePermission`)
 *     computed `protectedTarget` but omitted it from the broadcast payload.
 *   - the HOOK-ROUTED pipeline (ws-permissions.js `handlePermissionRequest`)
 *     never computed it at all for the broadcast (only the separate
 *     `POST /permission-floor` probe did).
 * An external consumer of `permission_request` (e.g. the agent-control MCP,
 * #7854) therefore could not tell a floored prompt from an ordinary one, and
 * could `allow` exactly what the floor exists to keep with a human.
 *
 * This file pins the new `floored: boolean` field on the `permission_request`
 * wire message, from every emit site on both pipelines, always computed from
 * the OWNING SESSION's cwd (never the daemon's).
 */

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

// ---------------------------------------------------------------------------
// The shared case set. `expected` is derived by calling isFlooredTarget
// itself — the single, already-audited implementation — rather than a
// hand-written true/false list (catalogue #7424: an expectation derived from
// its own subject can't go red). This file is not re-testing the floor
// PREDICATE (permission-hook-floor.test.js already does that exhaustively);
// it is testing that both broadcast pipelines correctly SURFACE that
// predicate's verdict on the wire. Includes clearly non-floored controls so
// a hardcoded `floored: true` on either pipeline is also caught.
// ---------------------------------------------------------------------------

const CWD = '/work/project'
const CASES = [
  ['Read', { file_path: '.env' }],
  ['Read', { file_path: '.env.local' }],
  ['Read', { file_path: 'deploy/id_ed25519' }],
  ['Write', { file_path: '.git/hooks/pre-commit' }],
  ['Edit', { file_path: '.claude/settings.local.json' }],
  ['NotebookEdit', { notebook_path: '.claude/nb.ipynb' }],
  ['Glob', { path: '.env' }],
  ['Grep', { path: 'secrets/keystore.p12' }],
  ['Read', { file_path: 'src/index.js' }], // control: ordinary read
  ['Write', { file_path: 'packages/server/src/x.js' }], // control: ordinary write
  ['Read', { file_path: '.git/HEAD' }], // control: benign non-credential .git read
  ['Bash', { command: 'cat .env' }], // control: path-less tool
].map(([tool, input]) => [tool, input, isFlooredTarget(tool, input, CWD)])

assert.ok(CASES.some(([, , e]) => e === true), 'fixture sanity: must include a floored case')
assert.ok(CASES.some(([, , e]) => e === false), 'fixture sanity: must include a non-floored case')

// A session cwd living under `.claude` (a real chroxy worktree shape) paired
// with a target that ESCAPES it via `..` — per permission-floor.js, an
// escaping target is scanned as its resolved ABSOLUTE path, so cwd's own
// `.claude` prefix segment is included in the scan. Resolved against some
// OTHER (e.g. daemon) cwd with no `.claude` in its ancestry, the very same
// relative target does NOT floor — so this pair proves the resolution base
// actually matters, and that using the wrong one UNDER-floors (#7968/#7020).
const SESSION_CWD = '/work/chroxy-clone/.claude/worktrees/agent-xyz'
const WRONG_CWD = '/srv/daemon-root'
const CWD_SENSITIVE_TARGET = { file_path: '../../settings.local.json' }
assert.equal(isFlooredTarget('Read', CWD_SENSITIVE_TARGET, SESSION_CWD), true, 'fixture sanity: session cwd floors')
assert.equal(isFlooredTarget('Read', CWD_SENSITIVE_TARGET, WRONG_CWD), false, 'fixture sanity: the wrong cwd would NOT floor')

// ---------------------------------------------------------------------------
// 1. In-process pipeline: PermissionManager's emitted permission_request
// ---------------------------------------------------------------------------

describe('#7968 in-process pipeline: permission_request carries floored', () => {
  let pm

  beforeEach(() => { pm = new PermissionManager({ log: silentLog, cwd: CWD }) })
  afterEach(() => { pm.destroy() })

  for (const [tool, input, expected] of CASES) {
    it(`${tool} ${JSON.stringify(input)} -> floored=${expected}`, () => {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.handlePermission(tool, input, null, 'approve')
      assert.equal(events.length, 1)
      assert.equal(events[0].floored, expected)
    })
  }

  it('an MCP trust request (tool: mcp_spawn) is never floored — no path-carrying field', () => {
    const events = []
    pm.on('permission_request', (d) => events.push(d))
    pm.requestMcpTrust({ name: 'x', command: 'node', args: ['server.js'], envKeys: [] })
    assert.equal(events.length, 1)
    assert.equal(events[0].tool, 'mcp_spawn')
    assert.equal(events[0].floored, false)
  })

  it('uses the cwd the manager was constructed with (the SESSION cwd), never another one', () => {
    // try/finally: 'approve' mode always parks a REAL pending-permission timer
    // (this._timeoutMs) regardless of floored-ness. destroy() clears it — if an
    // assertion above throws (as it does pre-fix), destroy() must still run or
    // this orphaned manager's timer keeps the process alive after all tests
    // finish (a real leak this file hit during development, not a hypothetical).
    const sessionPm = new PermissionManager({ log: silentLog, cwd: SESSION_CWD })
    try {
      const events = []
      sessionPm.on('permission_request', (d) => events.push(d))
      sessionPm.handlePermission('Read', CWD_SENSITIVE_TARGET, null, 'approve')
      assert.equal(events.length, 1)
      assert.equal(events[0].floored, true, 'must use the session cwd it was constructed with')
    } finally {
      sessionPm.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. event-normalizer.js: the permission_request mapping forwards `floored`
//    onto the buildPermissionRequestMessage wire call
// ---------------------------------------------------------------------------

describe('#7968 event-normalizer.js forwards floored onto the wire message', () => {
  it('forwards floored:true', () => {
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('permission_request', {
      requestId: 'req-1', tool: 'Read', description: 'x', input: {}, remainingMs: 1000, floored: true,
    }, { sessionId: 'sess-1' })
    assert.equal(result.messages[0].msg.type, 'permission_request')
    assert.equal(result.messages[0].msg.floored, true)
  })

  it('forwards floored:false', () => {
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('permission_request', {
      requestId: 'req-2', tool: 'Read', description: 'x', input: {}, remainingMs: 1000, floored: false,
    }, { sessionId: 'sess-1' })
    assert.equal(result.messages[0].msg.floored, false)
  })

  it('coerces a missing/non-boolean floored to false rather than passing garbage through', () => {
    const normalizer = new EventNormalizer()
    const result = normalizer.normalize('permission_request', {
      requestId: 'req-3', tool: 'Read', description: 'x', input: {}, remainingMs: 1000,
    }, { sessionId: 'sess-1' })
    assert.equal(result.messages[0].msg.floored, false)
  })
})

// ---------------------------------------------------------------------------
// 3. Hook-routed pipeline: POST /permission's broadcast carries floored
// ---------------------------------------------------------------------------

function postJson(port, path, body) {
  return new Promise((resolvePromise, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      port,
      path,
      method: 'POST',
      // #7968 test hygiene: no keep-alive agent. Without this the client
      // socket lingers in the default global agent's pool after the response
      // ends, and `server.close()` (called from each test's `daemon.close()`)
      // waits for every open connection to end before its callback fires —
      // the whole suite hangs rather than failing loudly.
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer test-secret',
      },
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolvePromise({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function startTestDaemon({ sessionCwd = CWD, resolveSession = true } = {}) {
  const prompts = []
  const pendingPermissions = new Map()
  const handler = createPermissionHandler({
    sendFn: () => {},
    broadcastFn: (msg) => {
      if (msg?.type !== 'permission_request') return
      prompts.push(msg)
      // handlePermissionRequest registers the pending entry AFTER broadcasting
      // (it holds the HTTP response open) — resolve on a later tick, same
      // ordering a real client sees, so the request can complete cleanly.
      setTimeout(() => handler.resolvePermission(msg.requestId, 'deny'), 0)
    },
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
    pairingManager: null,
    findSessionByHookSecret: (secret) => (
      (resolveSession && secret === 'test-secret') ? { session: { cwd: sessionCwd }, sessionId: 'sess-1' } : null
    ),
  })
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/permission') {
      handler.handlePermissionRequest(req, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, r))
  return {
    port: server.address().port,
    prompts,
    handler,
    close: async () => {
      handler.destroy()
      // #7968 test hygiene: belt-and-suspenders alongside `agent: false` in
      // postJson above — force-close anything still open so `server.close()`
      // (which otherwise waits for every connection to end) can never hang.
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

describe('#7968 hook-routed pipeline: POST /permission broadcast carries floored', () => {
  for (const [tool, input, expected] of CASES) {
    it(`${tool} ${JSON.stringify(input)} -> floored=${expected}`, async () => {
      const daemon = await startTestDaemon()
      try {
        await postJson(daemon.port, '/permission', { tool_name: tool, tool_input: input, cwd: CWD })
        assert.equal(daemon.prompts.length, 1)
        assert.equal(daemon.prompts[0].floored, expected)
      } finally {
        await daemon.close()
      }
    })
  }

  it('fails CLOSED (floored:true) when the owning session cannot be resolved', async () => {
    const daemon = await startTestDaemon({ resolveSession: false })
    try {
      await postJson(daemon.port, '/permission', { tool_name: 'Read', tool_input: { file_path: 'src/a.js' }, cwd: CWD })
      assert.equal(daemon.prompts.length, 1)
      assert.equal(daemon.prompts[0].floored, true)
    } finally {
      await daemon.close()
    }
  })

  it('uses the OWNING SESSION cwd, never the payload cwd or some other (daemon) cwd (#7968/#7020)', async () => {
    const daemon = await startTestDaemon({ sessionCwd: SESSION_CWD })
    try {
      // Deliberately POST a DIFFERENT cwd in the body — #7020 already forbids
      // trusting a caller-chosen cwd; the resolved SESSION cwd must be the one
      // actually used for the wire verdict too.
      await postJson(daemon.port, '/permission', { tool_name: 'Read', tool_input: CWD_SENSITIVE_TARGET, cwd: WRONG_CWD })
      assert.equal(daemon.prompts.length, 1)
      assert.equal(daemon.prompts[0].floored, true, 'must use the resolved session cwd, not the payload cwd or daemon cwd')
    } finally {
      await daemon.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Resend paths forward floored too (both stash it, both must replay it)
// ---------------------------------------------------------------------------

describe('#7968 resend paths forward floored', () => {
  it('SDK-mode resend (from session._lastPermissionData) forwards floored', () => {
    const sent = []
    const handler = createPermissionHandler({
      sendFn: (ws, msg) => sent.push(msg),
      broadcastFn: () => {},
      validateBearerAuth: () => true,
      validateHookAuth: () => true,
      pushManager: null,
      pendingPermissions: new Map(),
      permissionSessionMap: new Map(),
      getSessionManager: () => ({
        _sessions: new Map([
          ['sess-1', {
            session: {
              _pendingPermissions: new Map([['req-1', {}]]),
              _lastPermissionData: new Map([
                ['req-1', {
                  requestId: 'req-1', tool: 'Read', description: 'x', input: {},
                  remainingMs: 300_000, createdAt: Date.now(), floored: true,
                }],
              ]),
            },
          }],
        ]),
      }),
      pairingManager: null,
      findSessionByHookSecret: () => null,
    })
    try {
      handler.resendPendingPermissions({}, { id: 'client-1' })
      assert.equal(sent.length, 1)
      assert.equal(sent[0].floored, true)
    } finally {
      handler.destroy()
    }
  })

  it('legacy HTTP-held resend (from pendingPermissions[].data) forwards floored', () => {
    const sent = []
    const pendingPermissions = new Map([
      ['req-2', {
        data: {
          requestId: 'req-2', tool: 'Write', description: 'y', input: {},
          remainingMs: 300_000, createdAt: Date.now(), floored: false,
        },
      }],
    ])
    const handler = createPermissionHandler({
      sendFn: (ws, msg) => sent.push(msg),
      broadcastFn: () => {},
      validateBearerAuth: () => true,
      validateHookAuth: () => true,
      pushManager: null,
      pendingPermissions,
      permissionSessionMap: new Map(),
      getSessionManager: () => null,
      pairingManager: null,
      findSessionByHookSecret: () => null,
    })
    try {
      handler.resendPendingPermissions({}, { id: 'client-1' })
      assert.equal(sent.length, 1)
      assert.equal(sent[0].floored, false)
    } finally {
      handler.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. PARITY: both pipelines agree with the isFlooredTarget oracle, and with
//    EACH OTHER, for the same (tool, input, cwd) — the acceptance criterion
//    from #7968: "tests show the in-process and hook-routed pipelines mark
//    the same inputs as floored".
// ---------------------------------------------------------------------------

describe('#7968 PARITY: in-process and hook-routed pipelines agree', () => {
  for (const [tool, input, expected] of CASES) {
    it(`${tool} ${JSON.stringify(input)}`, async () => {
      // in-process
      const pm = new PermissionManager({ log: silentLog, cwd: CWD })
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.handlePermission(tool, input, null, 'approve')
      const inProcessFloored = events[0].floored
      pm.destroy()

      // hook-routed
      const daemon = await startTestDaemon()
      let hookFloored
      try {
        await postJson(daemon.port, '/permission', { tool_name: tool, tool_input: input, cwd: CWD })
        hookFloored = daemon.prompts[0].floored
      } finally {
        await daemon.close()
      }

      assert.equal(inProcessFloored, expected, 'in-process pipeline must match the isFlooredTarget oracle')
      assert.equal(hookFloored, expected, 'hook-routed pipeline must match the isFlooredTarget oracle')
      assert.equal(inProcessFloored, hookFloored, 'both pipelines must agree with each other')
    })
  }
})

// Sanity: evaluateHookFloorRequest is still exported and usable directly
// (permission-hook-floor.test.js exercises it exhaustively; this just proves
// the import used above resolves to the same function).
describe('#7968 sanity: evaluateHookFloorRequest import', () => {
  it('is a function', () => {
    assert.equal(typeof evaluateHookFloorRequest, 'function')
  })
})
