import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PermissionManager } from '../src/permission-manager.js'
import { isFlooredTarget, PROTECTED_PATH_INPUT_FIELDS, SECRET_READ_FLOOR_TOOLS } from '../src/permission-floor.js'
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

  // A missing or non-boolean `floored` on the session event is "the emitter did
  // not state a verdict" — it must FAIL CLOSED to `true`, never to `false`.
  // `false` is the one value a downstream consumer (#7854's agent-control)
  // treats as clearance to `allow` unattended, so coercing an absent verdict to
  // `false` would turn "cannot tell" into "not floored" at the server, before
  // the consumer's own absent -> refuse rule ever sees the message. Every
  // in-process emitter today is PermissionManager, which always sets a real
  // boolean; this pins the direction for any emitter that does not (a
  // third-party provider, ACP's pending permission bridge #7320, a relay).
  for (const [label, extra] of [
    ['missing', {}],
    ['null', { floored: null }],
    ['the string "false"', { floored: 'false' }],
    ['0', { floored: 0 }],
    ['the string "yes"', { floored: 'yes' }],
  ]) {
    it(`a ${label} floored fails CLOSED to floored:true, never false`, () => {
      const normalizer = new EventNormalizer()
      const result = normalizer.normalize('permission_request', {
        requestId: 'req-3', tool: 'Read', description: 'x', input: {}, remainingMs: 1000, ...extra,
      }, { sessionId: 'sess-1' })
      assert.equal(result.messages[0].msg.floored, true)
    })
  }
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

async function startTestDaemon({ sessionCwd = CWD, resolveSession = true, rateLimit, resendBeforeResolve = false } = {}) {
  const prompts = []
  const resent = []
  const pendingPermissions = new Map()
  const handler = createPermissionHandler({
    sendFn: (ws, msg) => { if (msg?.type === 'permission_request') resent.push(msg) },
    broadcastFn: (msg) => {
      if (msg?.type !== 'permission_request') return
      prompts.push(msg)
      // handlePermissionRequest registers the pending entry AFTER broadcasting
      // (it holds the HTTP response open) — resolve on a later tick, same
      // ordering a real client sees, so the request can complete cleanly.
      // `resendBeforeResolve` replays the still-pending entry to a
      // "reconnecting" client first, exactly as resendPendingPermissions would.
      setTimeout(() => {
        if (resendBeforeResolve) handler.resendPendingPermissions({}, { id: 'reconnecting-client' })
        handler.resolvePermission(msg.requestId, 'deny')
      }, 0)
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
    ...(rateLimit ? { rateLimit } : {}),
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
    resent,
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

  // The legacy resend reads `pendingPermissions[].data.floored`, which the
  // creation path stashes separately from the value it broadcasts. The resend
  // tests below use hand-built stashes, so only an END-TO-END create -> resend
  // proves the stash holds the SAME verdict the creation broadcast carried.
  for (const [input, expected] of [[{ file_path: '.env' }, true], [{ file_path: 'src/a.js' }, false]]) {
    it(`a hook-created prompt resent on reconnect replays its creation verdict (${input.file_path} -> ${expected})`, async () => {
      const daemon = await startTestDaemon({ resendBeforeResolve: true })
      try {
        await postJson(daemon.port, '/permission', { tool_name: 'Read', tool_input: input, cwd: CWD })
        assert.equal(daemon.prompts.length, 1)
        assert.equal(daemon.resent.length, 1, 'the pending prompt must have been resent')
        assert.equal(daemon.resent[0].requestId, daemon.prompts[0].requestId)
        assert.equal(daemon.prompts[0].floored, expected)
        assert.equal(daemon.resent[0].floored, expected)
      } finally {
        await daemon.close()
      }
    })
  }

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

  // The builder now fails a missing verdict CLOSED (`true`), so a resend that
  // DROPPED the field would still pass the `floored: true` case above. Only a
  // stashed `false` replayed as `false` proves the SDK-mode resend reads the
  // stash at all.
  it('SDK-mode resend replays a stashed floored:false as false', () => {
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
              _pendingPermissions: new Map([['req-5', {}]]),
              _lastPermissionData: new Map([
                ['req-5', {
                  requestId: 'req-5', tool: 'Read', description: 'x', input: {},
                  remainingMs: 300_000, createdAt: Date.now(), floored: false,
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
      assert.equal(sent[0].floored, false)
    } finally {
      handler.destroy()
    }
  })

  // A stash that carries NO verdict (an entry written by something other than
  // the two creation sites, or one that predates them) must replay as floored
  // — the same fail-closed direction as the normalizer above. A resend is the
  // message a reconnecting consumer actually sees, so defaulting it to `false`
  // would hand an unattended `allow` a prompt nobody ever cleared.
  it('SDK-mode resend of a stash with NO floored field replays floored:true (fail closed)', () => {
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
              _pendingPermissions: new Map([['req-3', {}]]),
              _lastPermissionData: new Map([
                ['req-3', {
                  requestId: 'req-3', tool: 'Write', description: 'x', input: {},
                  remainingMs: 300_000, createdAt: Date.now(),
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

  it('legacy HTTP-held resend of a stash with NO floored field replays floored:true (fail closed)', () => {
    const sent = []
    const pendingPermissions = new Map([
      ['req-4', {
        data: {
          requestId: 'req-4', tool: 'Write', description: 'y', input: {},
          remainingMs: 300_000, createdAt: Date.now(),
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
      assert.equal(sent[0].floored, true)
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

// ---------------------------------------------------------------------------
// 6. WIRE PARITY over a matrix built from permission-floor.js's OWN sets.
//
// Section 5 compares the in-process EVENT (before event-normalizer.js) with the
// hook-routed WIRE message, over a dozen relative targets. That leaves out the
// hop that decides what the consumer actually reads (the normalizer's coercion)
// and every resolution shape the floor handles beyond a plain relative path:
// absolute targets, `./` and `..`, case variants (the floor lowercases per
// segment; APFS/NTFS are case-insensitive, so `.GIT/HOOKS` IS `.git/hooks`),
// and real symlinks — a symlinked dir into `.git`, a `..` AFTER a symlink (which
// open(2) climbs from the link's target, so it only floors via the floor's
// second, symlink-following pass), and a file symlink onto a secret.
//
// Tools come from SECRET_READ_FLOOR_TOOLS (the read floor) plus mutating and
// unknown tools (the full floor); fields come from PROTECTED_PATH_INPUT_FIELDS
// plus the `changes[]` array form. Both pipelines are driven end-to-end to the
// WIRE: in-process = PermissionManager -> EventNormalizer -> built message;
// hook-routed = POST /permission -> broadcast message. The expectation is the
// isFlooredTarget oracle, and the two wire values must also equal each other.
// ---------------------------------------------------------------------------

describe('#7968 WIRE PARITY: both pipelines, a matrix from permission-floor.js\'s own sets', () => {
  // Windows runners have no symlink privilege (the runner account lacks
  // SeCreateSymbolicLinkPrivilege), so the symlink rows are POSIX-only. That is
  // stated here and asserted below — never a silent "no symlink rows ran".
  const withSymlinks = process.platform !== 'win32'
  let root
  let daemon

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-7968-parity-')))
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), '')
    writeFileSync(join(root, '.env'), '')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), '')
    if (withSymlinks) {
      symlinkSync(join(root, '.git'), join(root, 'gitlink'))
      symlinkSync(join(root, '.git', 'hooks'), join(root, 'hookslink'))
      symlinkSync(join(root, '.env'), join(root, 'envlink'))
      symlinkSync(join(root, 'src'), join(root, 'srclink'))
    }
    // One daemon for the whole matrix, so the limiter must not be the thing
    // that decides how many rows run.
    daemon = await startTestDaemon({
      sessionCwd: root,
      rateLimit: { windowMs: 60_000, maxMessages: 1_000_000, burst: 1_000_000 },
    })
  })

  after(async () => {
    if (daemon) await daemon.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function buildTargets() {
    const targets = [
      // secret files, incl. case variants and non-plain relative spellings
      '.env', '.env.local', './.env', 'src/../.env', '.ENV', '.Env.Production',
      'id_rsa', 'deploy/ID_ED25519', '.npmrc', '.pgpass', '.netrc',
      'certs/server.PEM', 'app.key', 'keystore.p12', 'x.pfx',
      // credential-dense config files (floored on BOTH floors)
      '.git/config', '.GIT/CONFIG', '.git/credentials', '.config/git/config',
      '.claude/settings.json', '.claude/settings.local.json', '.Claude/Settings.JSON',
      // config dirs (write floor only)
      '.git/hooks/pre-commit', '.Git/Hooks/pre-commit', '.git/HEAD',
      '.vscode/tasks.json', '.claude/skills/x.md', '.config/git/ignore',
      // `..` traversal out of the session cwd
      '../.env', '../../sibling/.git/config', '../other/src/a.js',
      'src/../../x/.claude/settings.json',
      // absolute
      join(root, '.git', 'hooks', 'post-checkout'), join(root, '.env'), join(root, 'src', 'a.js'),
      // ordinary work, including near-miss names the floor must NOT match
      'src/a.js', 'README.md', 'packages/server/src/x.js', 'env.js', '.envrc', 'my.env', 'git/config',
    ]
    if (withSymlinks) {
      targets.push('gitlink/config', 'gitlink/hooks/pre-commit', 'hookslink/../config', 'envlink', 'srclink/a.js')
    }
    return targets
  }

  function buildInputs() {
    const tools = [...SECRET_READ_FLOOR_TOOLS, 'Write', 'Edit', 'NotebookEdit', 'MultiEdit']
    const rows = []
    for (const target of buildTargets()) {
      for (const tool of tools) {
        for (const field of PROTECTED_PATH_INPUT_FIELDS) rows.push([tool, { [field]: target }])
      }
      // codex apply_patch shape: a benign top-level file_path, the target in changes[]
      rows.push(['apply_patch', { file_path: root, changes: [{ path: 'src/a.js', kind: 'update' }, { path: target, kind: 'update' }] }])
    }
    // path-less tools: nothing the floor can match, on either pipeline
    rows.push(['Bash', { command: 'cat .env' }], ['WebFetch', { url: 'https://example.com/.env' }])
    return rows
  }

  it('in-process wire === hook-routed wire === isFlooredTarget, for every row', async () => {
    const rows = buildInputs().map(([tool, input]) => [tool, input, isFlooredTarget(tool, input, root)])

    // Non-vacuity: the matrix must actually span both verdicts, and the symlink
    // rows must include one that ONLY the symlink-following pass floors.
    const flooredCount = rows.filter(([, , e]) => e === true).length
    const clearCount = rows.filter(([, , e]) => e === false).length
    assert.ok(flooredCount >= 100, `matrix must carry many floored rows (got ${flooredCount})`)
    assert.ok(clearCount >= 100, `matrix must carry many clear rows (got ${clearCount})`)
    if (withSymlinks) {
      assert.equal(isFlooredTarget('Write', { file_path: 'hookslink/../config' }, root), true,
        'fixture sanity: a `..` after a symlink into .git/hooks must floor')
      assert.equal(isFlooredTarget('Write', { file_path: 'hookslink/../config' }, '/nonexistent-7968'), false,
        'fixture sanity: the same spelling does NOT floor lexically — only the symlink pass catches it')
    } else {
      assert.equal(process.platform, 'win32', 'symlink rows may only be absent on win32')
    }

    const pm = new PermissionManager({ log: silentLog, cwd: root })
    const normalizer = new EventNormalizer()
    const mismatches = []
    try {
      for (const [tool, input, expected] of rows) {
        // in-process, through the normalizer to the built wire message
        const events = []
        const onReq = (d) => events.push(d)
        pm.on('permission_request', onReq)
        const pending = pm.handlePermission(tool, input, null, 'approve')
        pm.off('permission_request', onReq)
        assert.equal(events.length, 1, `in-process must prompt for ${tool}`)
        const wireInProcess = normalizer.normalize('permission_request', events[0], { sessionId: 'sess-1' }).messages[0].msg.floored
        pm.respondToPermission(events[0].requestId, 'deny')
        await pending

        // hook-routed, through POST /permission to the broadcast. The payload
        // cwd is deliberately unrelated: only the SESSION cwd may anchor it.
        const seen = daemon.prompts.length
        await postJson(daemon.port, '/permission', { tool_name: tool, tool_input: input, cwd: '/' })
        assert.equal(daemon.prompts.length, seen + 1, `hook path must broadcast for ${tool}`)
        const wireHook = daemon.prompts[seen].floored

        if (typeof wireInProcess !== 'boolean' || typeof wireHook !== 'boolean'
          || wireInProcess !== expected || wireHook !== expected) {
          mismatches.push(`${tool} ${JSON.stringify(input)}: oracle=${expected} in-process=${wireInProcess} hook=${wireHook}`)
        }
      }
    } finally {
      pm.destroy()
    }
    assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} row(s) disagree`)
  })
})

// Sanity: evaluateHookFloorRequest is still exported and usable directly
// (permission-hook-floor.test.js exercises it exhaustively; this just proves
// the import used above resolves to the same function).
describe('#7968 sanity: evaluateHookFloorRequest import', () => {
  it('is a function', () => {
    assert.equal(typeof evaluateHookFloorRequest, 'function')
  })
})
