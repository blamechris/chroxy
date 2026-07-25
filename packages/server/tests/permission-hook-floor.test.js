import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'

import { createPermissionHandler, evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { PermissionManager } from '../src/permission-manager.js'
import { isFlooredTarget, PROTECTED_PATH_INPUT_FIELDS, SECRET_READ_FLOOR_TOOLS } from '../src/permission-floor.js'

/**
 * #7004 — the protected-path / secret-read FLOOR on the HOOK permission path.
 *
 * THE BUG (live on main): #6794/#6803 gave the floor precedence over every
 * lenient mode — but only in `permission-manager.js`, which the HOOK-routed
 * providers never traverse. `hooks/permission-hook.sh` decides `auto` and
 * `acceptEdits` itself, in shell, so on **claude-tui — the DEFAULT provider** a
 * session in either mode read `.env` / `id_rsa` and wrote into `.git`/`.claude`
 * with NO prompt.
 *
 * THE FIX: the floor predicates moved to `permission-floor.js` (one source of
 * truth), and the hook consults `POST /permission-floor` before short-circuiting.
 * A floored target is routed to a real prompt — never denied by the floor itself.
 *
 * What these tests pin, in order:
 *   1. the server-side probe's decisions, including fail-closed on bad payloads
 *   2. the REAL bash hook against the REAL handler over HTTP: floored → prompt,
 *      ordinary file → still auto-allowed (no new friction)
 *   3. every probe failure mode degrades to a prompt, never to "allowed"
 *   4. PARITY: hook path vs in-process manager agree on floor-vs-not
 *   5. ANTI-DRIFT: exactly ONE implementation of the floor, and the shell holds
 *      none of it
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')
const srcDir = join(__dirname, '../src')

// Synthetic session cwd — the floor is string ops + resolution, so nothing needs
// to exist on disk. Same fixture cwd the #6794/#6803 floor tests use, so the
// parity comparison below is apples-to-apples.
const CWD = '/work/project'
const HOOK_SECRET = 'test-hook-secret'
const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Spawn the REAL hook script with a minimal env and a stdin payload. */
function runHook({ payload, port, mode, extraEnv = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [hookPath], {
      env: {
        PATH: process.env.PATH,
        CHROXY_PORT: String(port),
        CHROXY_HOOK_SECRET: HOOK_SECRET,
        CHROXY_PERMISSION_MODE: mode,
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const settle = (fn, arg) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(arg) }
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => settle(reject, err))
    child.on('close', (status, signal) => {
      // The hook must always exit 0 with a decision — a kill/non-zero exit is a
      // real failure even if some JSON was printed.
      if (signal || status !== 0) {
        settle(reject, new Error(`hook exited uncleanly (status=${status}, signal=${signal})\nstderr: ${stderr}`))
        return
      }
      settle(resolve, { stdout, stderr })
    })
    if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload))
    child.stdin.end()
  })
}

function decisionOf(stdout) {
  return JSON.parse(stdout.trim()).hookSpecificOutput
}

/**
 * A REAL daemon: the production `createPermissionHandler` behind an http server
 * serving both routes the hook talks to. `promptDecision` is what the "user on
 * their phone" answers when a prompt is raised.
 */
async function startRealDaemon({ promptDecision = 'allow', sessionCwd = CWD, resolveSession = true } = {}) {
  const stats = { floorRequests: 0, permissionRequests: 0, prompts: [] }
  const pendingPermissions = new Map()
  let handler
  handler = createPermissionHandler({
    sendFn: () => {},
    broadcastFn: (msg) => {
      if (msg?.type !== 'permission_request') return
      stats.prompts.push(msg)
      // handlePermissionRequest registers the pending entry AFTER broadcasting,
      // so answer on a later tick — the same ordering a real client sees.
      setTimeout(() => handler.resolvePermission(msg.requestId, promptDecision), 0)
    },
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
    pairingManager: null,
    // The cwd basis: the owning session, exactly like the production lookup.
    // `resolveSession: false` models the one production shape where the lookup
    // CANNOT succeed — _validateHookAuth's primary-token fallback (no hook
    // secrets registered) — which is the #7020 under-floor window.
    findSessionByHookSecret: (secret) => (
      (resolveSession && secret === HOOK_SECRET) ? { session: { cwd: sessionCwd }, sessionId: 'sess-1' } : null
    ),
  })
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/permission-floor') {
      stats.floorRequests++
      handler.handlePermissionFloorCheck(req, res)
      return
    }
    if (req.method === 'POST' && req.url === '/permission') {
      stats.permissionRequests++
      handler.handlePermissionRequest(req, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, r))
  return {
    port: server.address().port,
    stats,
    close: async () => {
      handler.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

/**
 * A MISBEHAVING daemon: /permission-floor answers however the test says (a 500,
 * a body with no `floor` key, `floor:true`, …) while /permission answers a normal
 * decision. Used to prove every probe failure mode still reaches a prompt.
 */
async function startBrokenFloorDaemon({ status = 500, body = '{"error":"boom"}', decision = 'allow' } = {}) {
  const stats = { floorRequests: 0, permissionRequests: 0 }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (req.url === '/permission-floor') {
        stats.floorRequests++
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(body)
        return
      }
      if (req.url === '/permission') {
        stats.permissionRequests++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision }))
        return
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => server.listen(0, r))
  return {
    port: server.address().port,
    stats,
    close: () => new Promise((r) => server.close(r)),
  }
}

/** Claim a real free port then release it → curl gets connection-refused fast. */
async function getClosedPort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

const readPayload = (file_path) => ({ tool_name: 'Read', tool_input: { file_path }, cwd: CWD })
const writePayload = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: CWD })

// ---------------------------------------------------------------------------
// 1. The server-side probe
// ---------------------------------------------------------------------------

describe('evaluateHookFloorRequest — the hook path\'s floor verdict (#7004)', () => {
  it('floors a secret READ under the read floor', () => {
    for (const file_path of ['.env', '.env.local', '.ssh/id_rsa', 'certs/server.pem', '.npmrc']) {
      assert.equal(
        evaluateHookFloorRequest({ tool_name: 'Read', tool_input: { file_path } }, CWD).floor,
        true,
        `Read ${file_path} must be floored`,
      )
    }
  })

  it('floors a credential-dense config file for READS (.claude/settings*.json, .git/config)', () => {
    for (const file_path of ['.claude/settings.local.json', '.claude/settings.json', '.git/config', '.git/credentials']) {
      assert.equal(evaluateHookFloorRequest({ tool_name: 'Read', tool_input: { file_path } }, CWD).floor, true, file_path)
    }
  })

  it('does NOT floor an ordinary file, or a non-credential config read', () => {
    for (const file_path of ['src/index.js', 'packages/server/src/ws-permissions.js', 'README.md', '.claude/skills/foo.md']) {
      assert.equal(evaluateHookFloorRequest({ tool_name: 'Read', tool_input: { file_path } }, CWD).floor, false, file_path)
    }
  })

  it('floors a WRITE into a protected config dir (the full write floor)', () => {
    for (const file_path of ['.git/hooks/pre-commit', '.claude/settings.local.json', '.vscode/tasks.json', '.env']) {
      assert.equal(evaluateHookFloorRequest({ tool_name: 'Write', tool_input: { file_path } }, CWD).floor, true, file_path)
    }
  })

  it('does NOT floor an ordinary write', () => {
    assert.equal(evaluateHookFloorRequest({ tool_name: 'Write', tool_input: { file_path: 'src/a.js' } }, CWD).floor, false)
    assert.equal(evaluateHookFloorRequest({ tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } }, CWD).floor, false)
  })

  it('does not floor a path-LESS tool (Bash / WebFetch carry no path field)', () => {
    assert.equal(evaluateHookFloorRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } }, CWD).floor, false)
    assert.equal(evaluateHookFloorRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, CWD).floor, false)
  })

  // -- fail closed on anything ambiguous --

  it('FAILS CLOSED on an ambiguous payload (prompts rather than allows)', () => {
    const ambiguous = [
      [null, 'null payload'],
      ['a string', 'non-object payload'],
      [[], 'array payload'],
      [{}, 'no tool_name'],
      [{ tool_name: '' }, 'blank tool_name'],
      [{ tool_name: 42, tool_input: {} }, 'non-string tool_name'],
      [{ tool_name: 'Read' }, 'missing tool_input'],
      [{ tool_name: 'Read', tool_input: 'x' }, 'non-object tool_input'],
      [{ tool_name: 'Read', tool_input: ['x'] }, 'array tool_input'],
    ]
    for (const [payload, label] of ambiguous) {
      assert.equal(evaluateHookFloorRequest(payload, CWD).floor, true, `${label} must fail closed`)
    }
  })

  it('FAILS CLOSED when no cwd can be resolved (never falls back to the daemon cwd)', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'src/a.js' } }
    assert.equal(evaluateHookFloorRequest(payload, null).floor, true, 'no session cwd → prompt')
  })

  // #7020 — the payload's own `cwd` used to be the documented fallback when the
  // owning session was not resolvable. It is a CALLER-CHOSEN resolution base, so
  // it can UNDER-floor in exactly the way the (deliberately absent)
  // `process.cwd()` fallback would: point it AT the protected directory and the
  // relative scan sees nothing protected.
  it('IGNORES the payload cwd entirely — a caller-chosen base cannot un-floor a target (#7020)', () => {
    // The concrete under-floor from the #7016 security review: the target sits
    // inside `.git`, but the payload names `.git` itself as the resolution base,
    // so the relative scan only ever sees `config`.
    const underFloor = { tool_name: 'Read', tool_input: { file_path: '/repo/.git/config' }, cwd: '/repo/.git' }
    assert.equal(
      evaluateHookFloorRequest(underFloor, null).floor,
      true,
      'a payload-chosen cwd must not clear a target inside .git',
    )
    // The generic form: no resolvable session → prompt, whatever cwd the caller sent.
    const ordinary = { tool_name: 'Read', tool_input: { file_path: 'src/a.js' }, cwd: CWD }
    assert.equal(evaluateHookFloorRequest(ordinary, null).floor, true, 'unresolvable session → prompt')
  })

  it('prefers the SESSION cwd over the payload cwd (same basis as the in-process path)', () => {
    // `../../.env` escapes /work/project (floored) but not /work/a/b/c/deep.
    const payload = { tool_name: 'Read', tool_input: { file_path: '../../.env' }, cwd: '/work/a/b/c/deep' }
    assert.equal(evaluateHookFloorRequest(payload, CWD).floor, true, 'session cwd wins')
  })
})

// ---------------------------------------------------------------------------
// 2. The real hook against the real handler
// ---------------------------------------------------------------------------

describe('permission-hook.sh: the floor forces a PROMPT under auto/acceptEdits (#7004)', () => {
  let daemon

  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
  })

  it('auto + Read .env → PROMPTS (was silently auto-allowed)', async () => {
    daemon = await startRealDaemon({ promptDecision: 'allow' })
    const { stdout } = await runHook({ payload: readPayload('.env'), port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.floorRequests, 1, 'hook consulted the floor')
    assert.equal(daemon.stats.permissionRequests, 1, 'floored target raised a real permission request')
    assert.equal(daemon.stats.prompts[0].tool, 'Read')
    // The user approved, so the tool proceeds — but only because a human said so.
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })

  it('auto + Read ~/.ssh/id_rsa (absolute, outside cwd) → PROMPTS', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({
      payload: readPayload('/home/someone/.ssh/id_rsa'),
      port: daemon.port,
      mode: 'auto',
    })
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })

  it('auto + Read .claude/settings.local.json → PROMPTS (credential-dense config)', async () => {
    daemon = await startRealDaemon()
    await runHook({ payload: readPayload('.claude/settings.local.json'), port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.permissionRequests, 1)
  })

  it('auto + a DENIED floored prompt denies the tool call', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const { stdout } = await runHook({ payload: readPayload('.env'), port: daemon.port, mode: 'auto' })
    const out = decisionOf(stdout)
    assert.equal(out.permissionDecision, 'deny')
    assert.match(out.permissionDecisionReason, /Denied by user/i)
  })

  it('acceptEdits + Write .git/config → PROMPTS', async () => {
    daemon = await startRealDaemon()
    await runHook({ payload: writePayload('.git/config'), port: daemon.port, mode: 'acceptEdits' })
    assert.equal(daemon.stats.permissionRequests, 1)
  })

  it('acceptEdits + Edit .env.production → PROMPTS', async () => {
    daemon = await startRealDaemon()
    await runHook({
      payload: { tool_name: 'Edit', tool_input: { file_path: '.env.production', old_string: 'a', new_string: 'b' }, cwd: CWD },
      port: daemon.port,
      mode: 'acceptEdits',
    })
    assert.equal(daemon.stats.permissionRequests, 1)
  })

  // -- no new friction: the ordinary case must stay exactly as it was --

  it('auto + Read an ORDINARY file → still auto-allowed, no prompt', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({ payload: readPayload('src/index.js'), port: daemon.port, mode: 'auto' })
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.floorRequests, 1, 'the probe ran')
    assert.equal(daemon.stats.permissionRequests, 0, 'and cleared — no prompt, no push, no pending request')
  })

  it('auto + Read a NON-credential config file → still auto-allowed (read floor is secrets-only)', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({ payload: readPayload('.claude/skills/foo.md'), port: daemon.port, mode: 'auto' })
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.permissionRequests, 0)
  })

  it('acceptEdits + Write an ORDINARY file → still auto-allowed, no prompt', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({ payload: writePayload('src/a.js'), port: daemon.port, mode: 'acceptEdits' })
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.permissionRequests, 0)
  })

  it('acceptEdits + a LARGE ordinary Write (>128KB) is still auto-allowed', async () => {
    // Two ways this used to break, both of which would turn a legitimate big
    // write into a prompt and then (its own POST being oversize) a DENY:
    //   - an argv-sized payload: Linux caps one argv string at 128KB, so a
    //     `curl -d "$REQUEST"` probe failed with E2BIG → fail closed
    //   - a 64KB body cap on /permission-floor → 413 → fail closed
    daemon = await startRealDaemon()
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/generated.js', content: 'x'.repeat(200_000) },
      cwd: CWD,
    }
    const { stdout } = await runHook({ payload, port: daemon.port, mode: 'acceptEdits' })
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.floorRequests, 1, 'the probe carried the whole payload')
    assert.equal(daemon.stats.permissionRequests, 0, 'no prompt for an ordinary big write')
  })

  it('acceptEdits + a LARGE Write into a protected path is routed off the fast path (and hits /permission\'s own 64KB cap)', async () => {
    daemon = await startRealDaemon()
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.local.json', content: 'x'.repeat(200_000) },
      cwd: CWD,
    }
    const { stdout } = await runHook({ payload, port: daemon.port, mode: 'acceptEdits' })
    // The floor did its job: the call left the auto-approve path and was handed to
    // /permission. That endpoint's PRE-EXISTING 64KB body cap (it HOLDS the payload
    // for 5 minutes and broadcasts it to clients, unlike the probe) then answers a
    // 413 deny, so a >64KB write into a protected path is DENIED rather than shown
    // as a prompt. Unchanged by #7004 and documented in docs/security/permission-floor.md
    // §5; pinned here so the interaction is a decision, not a surprise.
    assert.equal(daemon.stats.permissionRequests, 1, 'the floor routed it away from the silent allow')
    assert.equal(decisionOf(stdout).permissionDecision, 'deny')
  })

  it('auto + a path-LESS tool (Bash) does not even probe — unchanged behavior', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({
      payload: { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: CWD },
      port: daemon.port,
      mode: 'auto',
    })
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.floorRequests, 0, 'a payload with no path-naming field cannot be floored')
    assert.equal(daemon.stats.permissionRequests, 0)
  })

  // -- the other modes are untouched --

  it('approve mode never probes the floor (it already prompts for everything)', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({ payload: readPayload('.env'), port: daemon.port, mode: 'approve' })
    assert.equal(daemon.stats.floorRequests, 0, 'no extra round trip on the prompt-everything path')
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })

  it('plan mode is untouched (ask, no probe)', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({ payload: readPayload('.env'), port: daemon.port, mode: 'plan' })
    assert.equal(decisionOf(stdout).permissionDecision, 'ask')
    assert.equal(daemon.stats.floorRequests, 0)
  })
})

// ---------------------------------------------------------------------------
// 3. Every probe failure mode fails CLOSED
// ---------------------------------------------------------------------------

describe('permission-hook.sh: the floor probe fails CLOSED (#7004)', () => {
  let daemon

  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
  })

  const failClosedCases = [
    ['a 500 from the probe', { status: 500, body: '{"error":"boom"}' }],
    ['a 403 from the probe', { status: 403, body: '{"error":"unauthorized"}' }],
    ['a 429 (rate limited) probe', { status: 429, body: '{"error":"rate limited","floor":true}' }],
    ['a body with no floor key', { status: 200, body: '{"status":"ok"}' }],
    ['an empty body', { status: 200, body: '' }],
    ['a non-JSON body', { status: 200, body: 'not json at all' }],
    ['an explicit floor:true', { status: 200, body: '{"floor":true}' }],
  ]

  for (const [label, opts] of failClosedCases) {
    it(`auto + ${label} → routes to a PROMPT, never a silent allow`, async () => {
      daemon = await startBrokenFloorDaemon({ ...opts, decision: 'allow' })
      const { stdout } = await runHook({ payload: readPayload('src/index.js'), port: daemon.port, mode: 'auto' })
      assert.equal(daemon.stats.floorRequests, 1)
      assert.equal(daemon.stats.permissionRequests, 1, 'an unusable floor answer must reach the user, not be assumed clear')
      assert.equal(decisionOf(stdout).permissionDecision, 'allow', 'the user then answered')
    })
  }

  it('auto + an unreachable daemon → DENIES (fail closed, never wedges on ask)', async () => {
    const port = await getClosedPort()
    const { stdout } = await runHook({ payload: readPayload('.env'), port, mode: 'auto' })
    const out = decisionOf(stdout)
    assert.equal(out.permissionDecision, 'deny')
    assert.match(out.permissionDecisionReason, /could not reach the daemon/i)
  })

  it('acceptEdits + an unreachable daemon → DENIES for a file op it used to auto-allow', async () => {
    const port = await getClosedPort()
    const { stdout } = await runHook({ payload: writePayload('.env'), port, mode: 'acceptEdits' })
    assert.equal(decisionOf(stdout).permissionDecision, 'deny')
  })

  it('a malformed hook payload that still names a path field prompts (server fails closed)', async () => {
    daemon = await startRealDaemon()
    // tool_input is a STRING — no target can be extracted, so the server answers
    // floor:true and the hook raises a prompt instead of auto-allowing.
    const { stdout } = await runHook({
      payload: '{"tool_name":"Read","tool_input":"file_path"}',
      port: daemon.port,
      mode: 'auto',
    })
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })
})

// ---------------------------------------------------------------------------
// 3b. #7017 — floor clearance requires an unambiguous TOP-LEVEL floor:false
// ---------------------------------------------------------------------------

describe('permission-hook.sh: floor clearance is a real JSON parse, not a substring grep (#7017)', () => {
  let daemon

  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
  })

  // Each of these bodies contains a `"floor":false` substring somewhere, but
  // NOT as an unambiguous top-level answer — a `grep`-first-match (the
  // pre-#7017 shape) reads every one of these as clearance and silently
  // auto-allows. The hook must route all of them to a real prompt instead.
  const hostileBodies = [
    ['a NESTED floor key', '{"nested":{"floor":false},"floor":true}'],
    ['an ARRAY-nested floor key', '{"a":[{"floor":false}],"floor":true}'],
    ['a DUPLICATE floor key, false-then-true', '{"floor":false,"floor":true}'],
    // The adversarial case: plain `JSON.parse` follows last-write-wins and
    // would itself resolve THIS body to `floor: false` — silently clearing
    // it exactly like the grep did. The occurrence-count guard rejects a
    // duplicate key before a parser ever gets to pick a winner.
    ['a DUPLICATE floor key, true-then-false (naive JSON.parse would clear this)', '{"floor":true,"floor":false}'],
    ['non-JSON text that merely contains the floor substring', 'not json at all "floor":false'],
  ]

  for (const [label, body] of hostileBodies) {
    it(`${label} → PROMPTS, never a silent allow`, async () => {
      daemon = await startBrokenFloorDaemon({ status: 200, body, decision: 'allow' })
      const { stdout } = await runHook({ payload: readPayload('src/index.js'), port: daemon.port, mode: 'auto' })
      assert.equal(daemon.stats.floorRequests, 1)
      assert.equal(daemon.stats.permissionRequests, 1, `${label} must not clear the short-circuit`)
      assert.equal(decisionOf(stdout).permissionDecision, 'allow', 'the user then answered')
    })
  }

  it('a legitimate {"floor":false} still ALLOWS with zero prompts (no over-blocking regression)', async () => {
    daemon = await startBrokenFloorDaemon({ status: 200, body: '{"floor":false}', decision: 'allow' })
    const { stdout } = await runHook({ payload: readPayload('src/index.js'), port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 0, 'an unambiguous top-level floor:false must still short-circuit')
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })

  it('a legitimate {"floor":true, ...extra fields} still PROMPTS', async () => {
    // Matches the real daemon's 429/error response shape (`error` + `floor` +
    // `retryAfterMs`), where `floor` is not the first key.
    daemon = await startBrokenFloorDaemon({
      status: 200,
      body: '{"error":"rate limited","floor":true,"retryAfterMs":5000}',
      decision: 'allow',
    })
    const { stdout } = await runHook({ payload: readPayload('.env'), port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })
})

// ---------------------------------------------------------------------------
// 3c. #7020 — the three remaining fail-OPEN edges on the floor probe
// ---------------------------------------------------------------------------

describe('permission-hook.sh: an obviously unusable payload does not skip the probe (#7020)', () => {
  let daemon

  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
  })

  // The pre-filter's soundness argument ("a payload naming no path field
  // provably cannot be floored") holds only for a payload that is actually
  // COMPLETE. An empty or truncated body used to take the same `return 1` and
  // auto-allow under `auto` — the one place the negative filter could fail OPEN.
  // The guard is a last-byte shape check, so what it PROVABLY catches is these
  // two shapes: an empty body, and a truncation that does not land on a `}`. A
  // truncation that does land on one still looks complete to it — tracked in
  // #7043, not pinned here, because these tests state only what holds.
  const incompletePayloads = [
    ['an EMPTY payload', ''],
    ['a payload truncated before the path key', '{"tool_name":"Read","tool_in'],
    ['a payload truncated mid-object', '{"tool_name":"Read","tool_input":{"fi'],
  ]

  for (const [label, payload] of incompletePayloads) {
    it(`auto + ${label} → routes to a PROMPT, never a silent allow`, async () => {
      daemon = await startRealDaemon({ promptDecision: 'allow' })
      const { stdout } = await runHook({ payload, port: daemon.port, mode: 'auto' })
      // No probe is needed: a body whose last non-whitespace byte is not `}` is
      // definitely not a JSON object, so it proves nothing about path fields and
      // the hook leaves the auto-allow path directly. That is strictly stronger
      // than probing — it holds even if the daemon is down.
      assert.equal(daemon.stats.permissionRequests, 1, 'an incomplete payload must leave the auto-allow path')
      // /permission cannot parse it either, so it answers a 400 deny — the tool
      // is BLOCKED. The one thing that must never happen is a silent allow.
      assert.equal(decisionOf(stdout).permissionDecision, 'deny', 'and an unparseable payload is denied, never allowed')
    })
  }

  // A `\uXXXX` escape is the only VALID JSON escape that can spell a path-field key
  // (`"\u0066ile_path"` parses to `file_path`), so the byte-level pre-filter
  // misses what the server's JSON-semantic lookup finds. This payload IS complete
  // and well-formed, so only the daemon can answer it — the hook must probe. An
  // INVALID escape (`\U`, `\x`) is out of scope: nothing parses such a body, and
  // the pre-filter does not consult the daemon about it either (#7043).
  it('auto + a \\u-escaped path key → PROBES and routes to a PROMPT, never a silent allow', async () => {
    daemon = await startRealDaemon({ promptDecision: 'allow' })
    const payload = '{"tool_name":"Read","tool_input":{"\\u0066ile_path":".env"},"cwd":"/work/project"}'
    const { stdout } = await runHook({ payload, port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.floorRequests, 1, 'a byte-level miss must not be read as "cannot be floored"')
    assert.equal(daemon.stats.permissionRequests, 1, 'and the escaped .env read must reach the user')
    assert.equal(decisionOf(stdout).permissionDecision, 'allow', 'the user then answered')
  })

  // The completeness guard is a LAST-BYTE check and `REQUEST=$(cat -)` strips
  // trailing NEWLINES only, so `}\r\n` / `} ` would leave a non-`}` last byte and
  // send EVERY auto/acceptEdits tool call to a phone prompt. Fail-closed, but it
  // would destroy the lenient modes for a CRLF-emitting producer — so the guard
  // trims the trailing whitespace run before looking at the last byte.
  const trailingWhitespacePayloads = [
    ['CRLF', '\r\n'],
    ['a trailing space', ' '],
    ['a tab + CRLF', '\t\r\n'],
  ]

  for (const [label, suffix] of trailingWhitespacePayloads) {
    it(`auto + an ordinary path-less call terminated by ${label} is still auto-allowed with no round trip`, async () => {
      daemon = await startRealDaemon()
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: CWD }) + suffix
      const { stdout } = await runHook({ payload, port: daemon.port, mode: 'auto' })
      assert.equal(decisionOf(stdout).permissionDecision, 'allow')
      assert.equal(daemon.stats.floorRequests, 0, 'trailing whitespace is not incompleteness')
      assert.equal(daemon.stats.permissionRequests, 0, 'an ordinary tool call must not be routed to the phone')
    })
  }

  it('trimming trailing whitespace does not skip the probe for a payload that DOES name a path', async () => {
    daemon = await startRealDaemon()
    const payload = JSON.stringify(readPayload('src/index.js')) + '\r\n'
    const { stdout } = await runHook({ payload, port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.floorRequests, 1, 'the path-field scan still runs on the raw payload')
    assert.equal(daemon.stats.permissionRequests, 0)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })

  it('a WELL-FORMED path-less payload still skips the probe (no new latency on the fast path)', async () => {
    daemon = await startRealDaemon()
    // Carries `\n` and `\"` escapes — the common Bash shapes. Neither can spell a
    // path-field key, so the fast path must be preserved for them: only `\u` probes.
    const { stdout } = await runHook({
      payload: { tool_name: 'Bash', tool_input: { command: 'printf "a\nb"\nls -la' }, cwd: CWD },
      port: daemon.port,
      mode: 'auto',
    })
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.floorRequests, 0, 'a complete path-less payload is still proven un-floorable')
    assert.equal(daemon.stats.permissionRequests, 0)
  })
})

describe('POST /permission-floor: the cwd basis is the OWNING SESSION only (#7020)', () => {
  let daemon

  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
  })

  it('auto + an unresolvable owning session → PROMPTS (the payload cwd is not a resolution base)', async () => {
    // Models _validateHookAuth's primary-token fallback: auth passes, but the
    // hook-secret → session lookup necessarily returns nothing, so the handler
    // used to fall back to the payload's own `cwd` — a caller-chosen base.
    daemon = await startRealDaemon({ resolveSession: false, promptDecision: 'allow' })
    const { stdout } = await runHook({ payload: readPayload('src/index.js'), port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 1, 'no resolvable session cwd must fail CLOSED')
    assert.equal(decisionOf(stdout).permissionDecision, 'allow', 'the user then answered')
  })

  it('a resolvable owning session still clears an ordinary file with zero prompts', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({ payload: readPayload('src/index.js'), port: daemon.port, mode: 'auto' })
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 0)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })
})

describe('POST /permission + /permission-floor: a request-stream error is handled, not thrown (#7020)', () => {
  /** The handler under test with nothing but the plumbing it actually touches. */
  function makeHandler({ pendingPermissions = new Map() } = {}) {
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
      findSessionByHookSecret: () => ({ session: { cwd: CWD }, sessionId: 'sess-1' }),
    })
  }

  function fakeReq() {
    const req = new PassThrough()
    req.headers = { authorization: `Bearer ${HOOK_SECRET}` }
    req.socket = { remoteAddress: '203.0.113.7' }
    return req
  }

  /**
   * `writeHead` THROWS on a second call, exactly as a real `ServerResponse` does
   * (`ERR_HTTP_HEADERS_SENT`). Without that, a fixture silently accepts a double
   * response and cannot observe the defect at all — which is how the post-`end`
   * ordering below stayed invisible. `writeHeadCalls` counts responses so
   * "exactly one" is asserted directly rather than inferred from a status code.
   * `on()` is a no-op registrar: `handlePermissionRequest`'s end handler attaches
   * `res.on('close')`, and these tests exercise the window before it fires.
   */
  function fakeRes() {
    return {
      statusCode: null,
      headersSent: false,
      body: '',
      writeHeadCalls: 0,
      writeHead(status) {
        if (this.headersSent) {
          throw Object.assign(new Error('Cannot write headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' })
        }
        this.writeHeadCalls++
        this.statusCode = status
        this.headersSent = true
        return this
      },
      end(chunk) { if (chunk) this.body += chunk; return this },
      on() { return this },
    }
  }

  // An `error` event on a stream with NO listener is an unhandled 'error' —
  // `emit` rethrows it, which on the real server escapes to uncaughtException.
  // mailbox-route.js and github-webhook.js both attach one; these two capped
  // readers did not.
  for (const [label, route] of [['/permission-floor', 'handlePermissionFloorCheck'], ['/permission', 'handlePermissionRequest']]) {
    it(`${label} attaches an error listener and answers fail-closed on a mid-body abort`, () => {
      const handler = makeHandler()
      try {
        const req = fakeReq()
        const res = fakeRes()
        handler[route](req, res)
        req.write('{"tool_name":"Read","tool_i')
        assert.doesNotThrow(
          () => req.emit('error', Object.assign(new Error('aborted by peer'), { code: 'ECONNRESET' })),
          'an aborted request body must not throw an unhandled stream error',
        )
        assert.equal(res.statusCode, 400, 'the aborted request gets a fail-closed response')
        const parsed = JSON.parse(res.body)
        if (route === 'handlePermissionFloorCheck') {
          assert.equal(parsed.floor, true, 'a stream error answers floor:true (prompt), never floor:false')
        } else {
          assert.equal(parsed.decision, 'deny', 'a stream error denies, never allows')
        }
        // A late 'end' after the error must not produce a second response.
        req.emit('end')
        assert.equal(res.statusCode, 400, 'no double response')
        assert.equal(res.writeHeadCalls, 1, 'exactly one response was written')
      } finally {
        handler.destroy()
      }
    })
  }

  // The OTHER ordering, and the one that matters on /permission: the body ends
  // normally, so the end handler registers a pendingPermissions entry and DEFERS
  // the response for up to five minutes while the prompt sits on the user's phone
  // — and THEN the request stream errors. Answering a 400 deny there would send a
  // second response on a socket the pending entry still owns (the later resolve()
  // throws ERR_HTTP_HEADERS_SENT on the #5313 tick that reaches uncaughtException)
  // AND deny, from a transient stream error, a request the user is still looking
  // at. Post-'end' teardown belongs to req 'aborted' / res 'close' → onClose.
  it('/permission ignores a stream error that arrives AFTER the body ended (the pending prompt owns the response)', async () => {
    const pendingPermissions = new Map()
    const handler = makeHandler({ pendingPermissions })
    try {
      const req = fakeReq()
      const res = fakeRes()
      handler.handlePermissionRequest(req, res)
      // A COMPLETE body this time, delivered and ended through the real stream so
      // the handler's own 'end' listener runs before this test continues.
      const ended = new Promise((resolve) => req.on('end', resolve))
      req.end(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'src/index.js' }, cwd: CWD }))
      await ended

      assert.equal(pendingPermissions.size, 1, 'the body ended cleanly, so a permission is pending')
      assert.equal(res.writeHeadCalls, 0, 'and its response is deferred until the user answers')

      assert.doesNotThrow(
        () => req.emit('error', Object.assign(new Error('aborted by peer'), { code: 'ECONNRESET' })),
        'a post-end stream error must not throw',
      )
      assert.equal(res.writeHeadCalls, 0, 'and must NOT answer — the pending prompt still owns this response')
      assert.equal(pendingPermissions.size, 1, 'nor abandon the pending entry')

      // The user then answers on their phone: still exactly ONE response, and it
      // is their decision — not a deny synthesised from the stream error.
      const [requestId] = [...pendingPermissions.keys()]
      assert.doesNotThrow(() => handler.resolvePermission(requestId, 'allow'), 'resolving must not double-respond')
      assert.equal(res.writeHeadCalls, 1, 'exactly one response')
      assert.equal(res.statusCode, 200)
      assert.deepEqual(JSON.parse(res.body), { decision: 'allow' })
      assert.equal(pendingPermissions.size, 0, 'and the entry is cleaned up')
    } finally {
      handler.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 3d. Reaching the daemon from a container
// ---------------------------------------------------------------------------

describe('permission-hook.sh: the callback host is not hardcoded to localhost (#7004)', () => {
  let daemon

  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
  })

  it('honours CHROXY_HOST (what DockerSession forwards so the container can reach the host)', async () => {
    // Proven by pointing it somewhere unresolvable: if the hook still dialled
    // localhost the live daemon below would have received the probe.
    daemon = await startRealDaemon()
    const { stdout } = await runHook({
      payload: readPayload('src/index.js'),
      port: daemon.port,
      mode: 'auto',
      extraEnv: { CHROXY_HOST: 'no-such-host-7004.invalid' },
    })
    assert.equal(daemon.stats.floorRequests, 0, 'the probe went to CHROXY_HOST, not localhost')
    assert.equal(decisionOf(stdout).permissionDecision, 'deny', 'and an unreachable daemon fails closed')
  })

  it('CHROXY_HOOK_HOST wins over CHROXY_HOST', async () => {
    daemon = await startRealDaemon()
    const { stdout } = await runHook({
      payload: readPayload('src/index.js'),
      port: daemon.port,
      mode: 'auto',
      extraEnv: { CHROXY_HOOK_HOST: '127.0.0.1', CHROXY_HOST: 'no-such-host-7004.invalid' },
    })
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
  })

  it('a host carrying shell/URL metacharacters falls back to localhost (never interpolated)', async () => {
    daemon = await startRealDaemon()
    const { stdout, stderr } = await runHook({
      payload: readPayload('.env'),
      port: daemon.port,
      mode: 'auto',
      extraEnv: { CHROXY_HOST: '127.0.0.1/../../etc; touch /tmp/chroxy-7004-pwned' },
    })
    assert.equal(daemon.stats.floorRequests, 1, 'fell back to localhost')
    assert.equal(daemon.stats.permissionRequests, 1, 'and the floor still applied')
    assert.equal(decisionOf(stdout).permissionDecision, 'allow')
    assert.equal(stderr, '', 'nothing was executed or complained about')
  })
})

// ---------------------------------------------------------------------------
// 4. Parity: the two pipelines must agree
// ---------------------------------------------------------------------------

describe('floor PARITY: hook path vs in-process permission-manager (#7004)', () => {
  let pm

  beforeEach(() => { pm = new PermissionManager({ log: silentLog, cwd: CWD }) })
  afterEach(() => { pm.destroy() })

  /** In-process: did handlePermission FALL THROUGH to a prompt (= floored)? */
  async function inProcessFloored(tool, input, mode) {
    const seen = []
    const onReq = (d) => seen.push(d)
    pm.on('permission_request', onReq)
    const promise = pm.handlePermission(tool, input, null, mode)
    if (seen.length > 0) pm.respondToPermission(seen[0].requestId, 'deny')
    await promise
    pm.off('permission_request', onReq)
    return seen.length > 0
  }

  // (tool, input) matrix spanning both floors, both non-floored shapes, and the
  // path-less tools. `expected` is the floor verdict both pipelines must produce.
  const MATRIX = [
    // secret files — floored for reads AND writes
    ['Read', { file_path: '.env' }, true],
    ['Read', { file_path: '.env.local' }, true],
    ['Read', { file_path: 'deploy/id_ed25519' }, true],
    ['Read', { file_path: 'certs/server.pem' }, true],
    ['Read', { file_path: 'app.key' }, true],
    ['Read', { file_path: '.netrc' }, true],
    ['Glob', { path: '.env' }, true],
    ['Grep', { path: 'secrets/keystore.p12' }, true],
    ['Write', { file_path: '.env' }, true],
    ['Edit', { file_path: '.env.production' }, true],
    // credential-dense config files — floored on BOTH floors
    ['Read', { file_path: '.git/config' }, true],
    ['Read', { file_path: '.claude/settings.local.json' }, true],
    // config DIRS — write floor only; a read of a non-credential file is benign
    ['Write', { file_path: '.git/hooks/pre-commit' }, true],
    ['Write', { file_path: '.vscode/tasks.json' }, true],
    ['NotebookEdit', { notebook_path: '.claude/nb.ipynb' }, true],
    ['Read', { file_path: '.git/HEAD' }, false],
    ['Read', { file_path: '.vscode/settings.json' }, false],
    ['Grep', { path: '.claude/skills' }, false],
    // `..` traversal above cwd is scanned as an absolute path
    ['Read', { file_path: '../../.env.local' }, true],
    ['Write', { file_path: '../sibling/.git/config' }, true],
    ['Read', { file_path: '../other/src/a.js' }, false],
    // ordinary work — never floored
    ['Read', { file_path: 'src/index.js' }, false],
    ['Write', { file_path: 'packages/server/src/x.js' }, false],
    ['Edit', { file_path: 'README.md' }, false],
    ['Glob', { path: 'packages' }, false],
    // an unknown/future tool gets the STRONGER floor on both paths
    ['MultiEdit', { file_path: '.claude/settings.json' }, true],
    ['MultiEdit', { file_path: 'src/a.js' }, false],
    // path-less tools carry nothing the floor can match
    ['Bash', { command: 'cat .env' }, false],
    ['WebFetch', { url: 'https://example.com/.env' }, false],
  ]

  for (const [tool, input, expected] of MATRIX) {
    it(`${tool} ${JSON.stringify(input)} → floor=${expected} on BOTH paths`, async () => {
      // hook path (the server-side probe the shell consults)
      const hookFloor = evaluateHookFloorRequest({ tool_name: tool, tool_input: input }, CWD).floor
      assert.equal(hookFloor, expected, 'hook-path verdict')
      // in-process path, under BOTH lenient modes the floor must beat
      assert.equal(await inProcessFloored(tool, input, 'auto'), expected, 'in-process auto')
      const acceptEditsFloored = await inProcessFloored(tool, input, 'acceptEdits')
      // acceptEdits only short-circuits for its own tool set; a tool outside it
      // prompts regardless of the floor, so only assert the floored direction.
      if (expected) assert.equal(acceptEditsFloored, true, 'in-process acceptEdits')
    })
  }

  it('a broad `allow` RULE cannot override the floor either (in-process invariant)', async () => {
    pm.setRules([{ tool: 'Read', decision: 'allow' }])
    assert.equal(await inProcessFloored('Read', { file_path: '.env' }, 'approve'), true)
    assert.equal(await inProcessFloored('Read', { file_path: 'src/a.js' }, 'approve'), false)
  })
})

// ---------------------------------------------------------------------------
// 5. Anti-drift: ONE implementation of the floor
// ---------------------------------------------------------------------------

describe('anti-drift: the floor has exactly ONE implementation (#7004)', () => {
  const floorSrc = readFileSync(join(srcDir, 'permission-floor.js'), 'utf8')
  const managerSrc = readFileSync(join(srcDir, 'permission-manager.js'), 'utf8')
  const wsPermSrc = readFileSync(join(srcDir, 'ws-permissions.js'), 'utf8')
  const hookSrc = readFileSync(hookPath, 'utf8')
  // Comments explain the floor by name; only the executable lines matter here.
  const hookCode = hookSrc.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

  it('both call sites go through the SAME isFlooredTarget from permission-floor.js', () => {
    assert.match(managerSrc, /from '\.\/permission-floor\.js'/, 'permission-manager imports the shared floor')
    assert.match(managerSrc, /isFlooredTarget\(toolName, input, this\._cwd\)/, 'in-process path calls it')
    assert.match(wsPermSrc, /import \{ isFlooredTarget \} from '\.\/permission-floor\.js'/, 'hook path imports it')
    assert.match(wsPermSrc, /isFlooredTarget\(tool, input, cwd\)/, 'hook path calls it')
  })

  it('the tool-aware read-vs-write choice exists in exactly one file', () => {
    // If a second site re-derives "which floor applies to which tool", the two
    // pipelines can drift again — that IS #7004.
    assert.match(floorSrc, /SECRET_READ_FLOOR_TOOLS\.has\(toolName\)/)
    assert.doesNotMatch(managerSrc, /SECRET_READ_FLOOR_TOOLS\.has/)
    assert.doesNotMatch(wsPermSrc, /SECRET_READ_FLOOR_TOOLS\.has/)
    // And the predicate set is still the documented one.
    assert.deepEqual([...SECRET_READ_FLOOR_TOOLS].sort(), ['Glob', 'Grep', 'Read'])
  })

  it('the shell hook contains NO path/secret matching of its own', () => {
    for (const literal of ['.env', 'id_rsa', 'id_ed25519', '.pem', '.pgpass', '.netrc', '.git/', '.claude/', '.vscode', '.config']) {
      assert.equal(
        hookCode.includes(literal),
        false,
        `permission-hook.sh must not reimplement the floor (found ${literal} in executable code)`,
      )
    }
    assert.match(hookCode, /permission-floor/, 'it asks the daemon instead')
  })

  it('the hook pre-filter covers EVERY field the floor scans (drift → this fails)', () => {
    // The pre-filter is a sound NEGATIVE filter: a payload naming none of these
    // fields provably cannot be floored. If the floor gains a field and the hook
    // does not, the probe would be skipped for it — an under-floor. Fail here.
    for (const field of [...PROTECTED_PATH_INPUT_FIELDS, 'changes']) {
      assert.equal(
        hookCode.includes(`*'"${field}"'*`),
        true,
        `permission-hook.sh's floor pre-filter must match "${field}" (from PROTECTED_PATH_INPUT_FIELDS)`,
      )
    }
    // Nothing else may be treated as path-shaped by the floor itself.
    assert.deepEqual(PROTECTED_PATH_INPUT_FIELDS, ['file_path', 'path', 'notebook_path'])
  })

  it('the pre-filter can only ever OVER-probe: a path-less input is never floored', () => {
    // The soundness premise, asserted directly against the predicate.
    for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Bash', 'FutureTool']) {
      assert.equal(isFlooredTarget(tool, { command: 'x', url: 'y', query: 'z' }, CWD), false, tool)
    }
  })
})
