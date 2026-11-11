import { describe, it, before, after, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { accessSync, chmodSync, constants as fsConstants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { createPermissionHookManager } from '../src/permission-hook.js'
// Through claude-tui-session.js, as every other test does: pty-driver.js and the
// session module import each other, and the driver cannot be the entry point.
import { ClaudeTuiSession, writeHookSettings } from '../src/claude-tui-session.js'
import { pinTmpDaemonBase } from './helpers/pin-tmp-daemon-base.js'
import * as deadlines from '../src/permission-deadlines.js'

/**
 * #8529 follow-up: the deadline chain on a hook-routed permission request.
 *
 * Three clocks run on one request: the daemon's no-answer timer, the hook's
 * `curl --max-time`, and the `timeout` Claude Code is given for the hook. They
 * were all 300 s, and the one that starts FIRST expired first, so the daemon's
 * "nobody answered" reply was written just after curl had stopped listening
 * and the hook reported an unreachable daemon instead. On claude-tui a fourth
 * ran beside them: the session's own stream-stall watchdog, also 300 s.
 *
 * What this file holds in place:
 *
 *   1. the order — daemon window < curl deadline < host timeout — with the
 *      numbers each layer ACTUALLY uses, observed from outside it: the daemon's
 *      timer under a mocked clock, the argv the real hook hands to curl, and the
 *      settings both registration sites write;
 *   2. that a claude-tui session suspends its silence watchdogs for as long as
 *      a hook-routed prompt is pending, and resumes them when it resolves;
 *   3. what the hook says when curl itself times out after it began uploading: a
 *      deny that claims neither that the request never reached the phone nor
 *      that it did (a byte count shows only that the upload began), that keeps a
 *      rejection status that had already arrived, and that the `=ask` opt-out
 *      cannot turn into an ask — while a daemon that really was unreachable, and
 *      every other curl failure, behaves exactly as before.
 *
 * WHAT THIS FILE DOES NOT PROVE.
 *   - Nothing here waits five real minutes. The order is proven from the three
 *     observed numbers, not by racing real clocks; the real-clock run is in the
 *     #8529 evidence, not in CI.
 *   - Claude Code is never run. "The host cancels the hook" is SIMULATED below
 *     by killing the hook's process group; what a real host then does with a
 *     hook that returned nothing is not tested here. (Section 9's process-group
 *     kill is this file's own watchdog for its own child processes. It is test
 *     plumbing and says nothing about how production cancels a hook.)
 *   - A curl timeout BEFORE anything was sent is exercised only through a stub
 *     curl (a stalled loopback listener still completes the handshake).
 *   - The budgets are an envelope, not a bound. Only curl's two deadlines are
 *     finite numbers; a stall in stdin, the filesystem, process start, the
 *     scheduler or the daemon's event loop longer than its allowance still lets
 *     an outer clock win, and nothing here shows otherwise.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

// Written out here, not read from the source: a test must not derive its
// expectation from its own subject.
const DECISION_WINDOW_MS = 300_000
const TRANSPORT_TIMEOUT_S = 310
const FLOOR_PROBE_TIMEOUT_S = 10
const HOST_TIMEOUT_S = 330
const MIN_TRANSPORT_MARGIN_MS = 10_000
const MIN_LOCAL_WORK_BUDGET_S = 10
// Big enough that a loopback peer which never reads cannot absorb it into its
// socket buffers, so curl's upload is still incomplete when its deadline hits.
const PARTIAL_UPLOAD_BODY_BYTES = 32 * 1024 * 1024
// The real curl's deadline in the scaled tests, in seconds. Long enough that a
// slow runner still connects and uploads before it; nothing asserts on it.
const SCALED_CURL_DEADLINE_S = '2'

const USER_DENY = 'Denied by user via Chroxy mobile app'
const NO_ANSWER_DENY = 'No one answered the Chroxy permission request before it timed out. Failing closed (denied).'
const TRANSPORT_TIMEOUT_DENY = 'Chroxy began sending the permission request, but did not receive a complete response before the wait expired. Failing closed (denied).'
const UNREACHABLE_DENY = 'Chroxy could not reach the daemon to request your approval; the request never reached your phone. Failing closed (denied). Retry once Chroxy is reachable.'

// Captured before any test mocks the clock.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSleep = (ms) => new Promise((r) => realSetTimeout(r, ms))

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'spawns hooks/permission-hook.sh via /bin/bash' : false }

const HOOK_SECRET = 'test-hook-secret'
const BASH_REQUEST = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
const READ_REQUEST = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/work/project/.env' } })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'chroxy-deadline-chain-')) })
after(() => { rmSync(scratch, { recursive: true, force: true }) })

/** A directory holding one executable named `curl`, to be put first on PATH. */
function makeBinDir(curlScript) {
  const dir = mkdtempSync(join(scratch, 'bin-'))
  const file = join(dir, 'curl')
  writeFileSync(file, curlScript)
  chmodSync(file, 0o755)
  return dir
}

/**
 * A stand-in `curl` that records the argv it was given and plays back a canned
 * result. Records are RS-separated and args US-separated, because the hook's
 * `-w` argument itself contains a newline.
 */
const STUB_CURL = `#!/bin/bash
{ printf '%s\\037' "$@"; printf '\\036'; } >> "$STUB_CURL_LOG"
cat > /dev/null
case " $* " in
  *"/permission-floor "*) printf '%s' "$STUB_FLOOR_STDOUT"; exit "\${STUB_FLOOR_EXIT:-0}" ;;
esac
printf '%s' "$STUB_CURL_STDOUT"
exit "\${STUB_CURL_EXIT:-0}"
`

/**
 * The REAL curl, with only the value after --max-time replaced. Used to reach
 * curl's own timeout in about a second instead of five minutes; connect, upload,
 * the -w trailer and the exit code are all the real program's.
 */
const SCALED_CURL = `#!/bin/bash
args=()
next=0
for a in "$@"; do
  if [ "$next" = 1 ]; then args+=("$SCALED_MAX_TIME"); next=0; continue; fi
  if [ "$a" = "--max-time" ]; then next=1; fi
  args+=("$a")
done
exec "$REAL_CURL" "\${args[@]}"
`

/**
 * SCALED_CURL, also copying what the real curl wrote to stdout into
 * $CURL_STDOUT_COPY, so a test can read the real trailer the hook was given.
 */
const SCALED_CURL_RECORDING = `#!/bin/bash
args=()
next=0
for a in "$@"; do
  if [ "$next" = 1 ]; then args+=("$SCALED_MAX_TIME"); next=0; continue; fi
  if [ "$a" = "--max-time" ]; then next=1; fi
  args+=("$a")
done
"$REAL_CURL" "\${args[@]}" > "$CURL_STDOUT_COPY"
code=$?
cat "$CURL_STDOUT_COPY"
exit $code
`

function findRealCurl() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'curl')
    try { accessSync(candidate, fsConstants.X_OK); return candidate } catch { /* next */ }
  }
  throw new Error('curl not found on PATH')
}

function readCurlCalls(logFile) {
  let raw = ''
  try { raw = readFileSync(logFile, 'utf8') } catch { return [] }
  return raw.split('\x1e').filter((r) => r.length > 0).map((r) => r.split('\x1f').slice(0, -1))
}

function optionValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const DEFAULT_HOOK_WATCHDOG_MS = 20000
// After the watchdog kills the hook's process group, how long the fixture waits
// for the child's stdio to close before it settles anyway.
const WATCHDOG_GRACE_MS = 2000

/**
 * SIGKILL the process group of a hook THIS FILE spawned (bash is its leader, so
 * the group is bash plus the curl it started, and nothing else). A group that
 * has already gone is not an error.
 */
function killHookGroup(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 1) return false
  try {
    process.kill(-child.pid, 'SIGKILL')
    return true
  } catch (err) {
    if (err.code === 'ESRCH') return false
    throw err
  }
}

/**
 * Spawn the REAL hook script, in a process group of its own. Resolves with how
 * it ended; never rejects on a non-zero exit, so a test can assert on a killed
 * hook too.
 *
 * WATCHDOG. A hook that has not finished after `timeout` ms is a test failure,
 * and it has to arrive as one. Killing only bash is not enough: its curl child
 * keeps the stdout/stderr pipes open, 'close' never fires, and the test hangs
 * until curl's own five-minute deadline. So the watchdog kills the whole group,
 * and if the pipes still have not closed a grace period later it settles
 * anyway. Either way the result carries `watchdog: true`, which decisionFrom()
 * turns into a failure that says what happened.
 */
function spawnHook({ port = 1, request = BASH_REQUEST, env = {}, mode = 'approve', binDir, timeout = DEFAULT_HOOK_WATCHDOG_MS }) {
  let exited = false
  let child
  let rearm = () => {}
  let watchdogAfterMs = timeout
  const done = new Promise((resolve, reject) => {
    child = spawn('/bin/bash', [hookPath], {
      detached: true,
      env: {
        PATH: binDir ? `${binDir}${delimiter}${process.env.PATH}` : process.env.PATH,
        CHROXY_PORT: String(port),
        CHROXY_HOOK_SECRET: HOOK_SECRET,
        CHROXY_PERMISSION_MODE: mode,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    let watchdog = false
    let graceTimer = null
    const settle = (result) => {
      if (exited) return
      exited = true
      realClearTimeout(timer)
      if (graceTimer) realClearTimeout(graceTimer)
      resolve({ stdout, stderr, watchdog, watchdogAfterMs, ...result })
    }
    const onWatchdog = () => {
      if (exited) return
      watchdog = true
      killHookGroup(child)
      graceTimer = realSetTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        settle({ status: null, signal: 'SIGKILL', stdioNeverClosed: true })
      }, WATCHDOG_GRACE_MS)
    }
    let timer = realSetTimeout(onWatchdog, timeout)
    // Replace the watchdog with a shorter one, counted from NOW. Lets a test
    // wait for the hook to be demonstrably mid-request first, so the short
    // deadline never races process start-up on a slow runner.
    rearm = (ms) => {
      if (exited) return
      realClearTimeout(timer)
      watchdogAfterMs = ms
      timer = realSetTimeout(onWatchdog, ms)
    }
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.stdin.on('error', () => { /* the hook went away before reading its input */ })
    child.on('error', (err) => {
      if (exited) return
      exited = true
      realClearTimeout(timer)
      reject(err)
    })
    child.on('close', (status, signal) => settle({ status, signal }))
    child.stdin.write(request)
    child.stdin.end()
  })
  done.catch(() => {})
  return { done, hasExited: () => exited, killGroup: () => killHookGroup(child), armWatchdog: (ms) => rearm(ms) }
}

/** The decision of a hook that ran to a clean exit, or a failure that says why not. */
function decisionFrom(r) {
  assert.equal(r.watchdog, false,
    `WATCHDOG: the hook had not finished after ${r.watchdogAfterMs} ms, so the fixture killed its process group. stdout so far: ${JSON.stringify(r.stdout)}; stderr: ${r.stderr}`)
  assert.equal(r.signal, null, `hook was killed (${r.signal}); stderr: ${r.stderr}`)
  assert.equal(r.status, 0, `hook exited ${r.status}; stderr: ${r.stderr}`)
  return JSON.parse(r.stdout.trim()).hookSpecificOutput
}

/** Run the hook to a clean exit and return its hookSpecificOutput. */
async function hookDecision(opts) {
  return decisionFrom(await spawnHook(opts).done)
}

function stubEnv({ stdout = '', exit = 0, floorStdout = '', floorExit = 0, log }) {
  return {
    STUB_CURL_LOG: log,
    STUB_CURL_STDOUT: stdout,
    STUB_CURL_EXIT: String(exit),
    STUB_FLOOR_STDOUT: floorStdout,
    STUB_FLOOR_EXIT: String(floorExit),
  }
}

let logCounter = 0
const newLog = () => join(scratch, `curl-${++logCounter}.log`)

function makeHandler({ pending = new Map(), prompts = [], ownerSession = { cwd: '/work/project' } } = {}) {
  return createPermissionHandler({
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
      secret === HOOK_SECRET ? { session: ownerSession, sessionId: 'sess-1' } : null
    ),
  })
}

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
    endCalls: 0,
    writeHead(code) { this.statusCode = code; this.headersSent = true },
    end(b) { this.endCalls++; this.body = b },
    on(event, cb) { listeners[event] = cb; return this },
  }
}

/** Raise one hook request against a handler under the mocked clock. */
async function raiseMocked() {
  const pending = new Map()
  const prompts = []
  const handler = makeHandler({ pending, prompts })
  const res = makeRes()
  handler.handlePermissionRequest(makeReq(BASH_REQUEST), res)
  await new Promise((r) => setImmediate(r))
  assert.equal(pending.size, 1, 'the hook request is held pending')
  return { handler, pending, prompts, res }
}

/** Both registration sites, asked for what they actually write. */
async function readRegisteredHostTimeouts() {
  const dir = mkdtempSync(join(scratch, 'reg-'))
  const userSettings = join(dir, 'settings.json')
  const manager = createPermissionHookManager(new EventEmitter(), { settingsPath: userSettings })
  let userEntries
  try {
    await manager.register()
    userEntries = JSON.parse(readFileSync(userSettings, 'utf8')).hooks.PreToolUse
  } finally {
    // destroy() unregisters asynchronously (it rewrites the settings file under
    // the settings lock). Awaited here so that write cannot land after the
    // scratch root is gone, nor be skipped when the read above throws.
    await manager.destroy()
  }
  const userHooks = userEntries.flatMap((e) => e.hooks).filter((h) => /permission-hook\.sh/.test(h.command))

  const sink = mkdtempSync(join(scratch, 'sink-'))
  const tuiSettings = JSON.parse(readFileSync(writeHookSettings(sink, { permissionsEnabled: true }), 'utf8'))
  const tuiHooks = tuiSettings.hooks.PreToolUse.flatMap((e) => e.hooks).filter((h) => /permission-hook\.sh/.test(h.command))

  return { userHooks, tuiHooks, tuiSettings }
}

/** What the real hook hands to curl, per mode. */
async function observeCurlArgv({ mode, request, floorStdout }) {
  const log = newLog()
  const binDir = makeBinDir(STUB_CURL)
  const out = await hookDecision({
    mode,
    request,
    binDir,
    env: stubEnv({ stdout: '{"decision":"deny"}\n200 50', floorStdout, log }),
  })
  return { calls: readCurlCalls(log), out }
}

// ---------------------------------------------------------------------------
// 1. The numbers, and their order
// ---------------------------------------------------------------------------

describe('permission deadlines: one source, innermost expires first (#8529)', () => {
  it('the exported deadlines are the documented numbers', () => {
    assert.equal(deadlines.HOOK_PERMISSION_DECISION_WINDOW_MS, DECISION_WINDOW_MS)
    assert.equal(deadlines.HOOK_TRANSPORT_TIMEOUT_S, TRANSPORT_TIMEOUT_S)
    assert.equal(deadlines.HOOK_FLOOR_PROBE_TIMEOUT_S, FLOOR_PROBE_TIMEOUT_S)
    assert.equal(deadlines.HOOK_HOST_TIMEOUT_S, HOST_TIMEOUT_S)
  })

  it('the user decision window is still five minutes: the outer layers were widened, the window was not shortened', () => {
    assert.equal(deadlines.HOOK_PERMISSION_DECISION_WINDOW_MS, 5 * 60 * 1000)
  })

  it('decision window < transport timeout < host timeout, each by its budget', () => {
    const { HOOK_PERMISSION_DECISION_WINDOW_MS: windowMs, HOOK_TRANSPORT_TIMEOUT_S: transportS, HOOK_FLOOR_PROBE_TIMEOUT_S: floorS, HOOK_HOST_TIMEOUT_S: hostS } = deadlines
    assert.ok(transportS * 1000 - windowMs >= MIN_TRANSPORT_MARGIN_MS,
      `curl must outlast the daemon's timer by at least ${MIN_TRANSPORT_MARGIN_MS} ms (window ${windowMs} ms, transport ${transportS} s)`)
    assert.ok(hostS - transportS >= floorS + MIN_LOCAL_WORK_BUDGET_S,
      `the host timeout must cover the floor probe (${floorS} s) and the hook's own work (${MIN_LOCAL_WORK_BUDGET_S} s) on top of the long poll (${transportS} s); it is ${hostS} s`)
  })

  it('the widening is bounded: the host waits at most 30 s longer than the decision window', () => {
    assert.ok(deadlines.HOOK_HOST_TIMEOUT_S * 1000 - deadlines.HOOK_PERMISSION_DECISION_WINDOW_MS <= 30_000)
  })
})

// ---------------------------------------------------------------------------
// 2. The daemon: its timer and the countdown it advertises are the window
// ---------------------------------------------------------------------------

describe('POST /permission: the daemon timer and the advertised countdown are the decision window (#8529)', () => {
  let handler
  afterEach(() => {
    mock.timers.reset()
    handler?.destroy()
    handler = null
  })

  it('the no-answer deny fires at exactly the window, and clients are told the same number', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const raised = await raiseMocked()
    handler = raised.handler
    const { pending, prompts, res } = raised

    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].remainingMs, DECISION_WINDOW_MS, 'the broadcast countdown')
    assert.equal([...pending.values()][0].data.remainingMs, DECISION_WINDOW_MS, 'the countdown a reconnecting client is resent')

    mock.timers.tick(DECISION_WINDOW_MS - 1)
    assert.equal(res.endCalls, 0, 'nothing is answered before the window closes')
    mock.timers.tick(1)
    assert.equal(res.endCalls, 1)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { decision: 'deny', reason: 'timeout' })
  })
})

// ---------------------------------------------------------------------------
// 3. Both host registrations
// ---------------------------------------------------------------------------

describe('Claude Code hook registrations: both sites write the host timeout (#8529)', () => {
  it('the user-level registration (claude-cli) gives the hook the host timeout', async () => {
    const { userHooks } = await readRegisteredHostTimeouts()
    assert.equal(userHooks.length, 1)
    assert.equal(userHooks[0].timeout, HOST_TIMEOUT_S)
  })

  it('the per-session --settings registration (claude-tui) gives the hook the host timeout', async () => {
    const { tuiHooks } = await readRegisteredHostTimeouts()
    assert.equal(tuiHooks.length, 1)
    assert.equal(tuiHooks[0].timeout, HOST_TIMEOUT_S)
  })

  it('the two sites agree', async () => {
    const { userHooks, tuiHooks } = await readRegisteredHostTimeouts()
    assert.equal(userHooks[0].timeout, tuiHooks[0].timeout)
  })

  it('the event-capture hooks beside it are untouched: no timeout was added to them', async () => {
    const { tuiSettings } = await readRegisteredHostTimeouts()
    const others = [
      ...tuiSettings.hooks.PreToolUse.flatMap((e) => e.hooks),
      ...tuiSettings.hooks.PostToolUse.flatMap((e) => e.hooks),
      ...tuiSettings.hooks.Stop.flatMap((e) => e.hooks),
    ].filter((h) => !/permission-hook\.sh/.test(h.command))
    assert.ok(others.length >= 3)
    for (const h of others) assert.equal('timeout' in h, false, h.command)
  })
})

// ---------------------------------------------------------------------------
// 4. What the real hook hands to curl
// ---------------------------------------------------------------------------

describe('permission-hook.sh: the deadlines it gives curl (#8529)', POSIX_ONLY, () => {
  it('approve mode: one long poll to /permission with the transport timeout', async () => {
    const { calls } = await observeCurlArgv({ mode: 'approve', request: BASH_REQUEST })
    assert.equal(calls.length, 1)
    assert.ok(calls[0].some((a) => a.endsWith('/permission')), calls[0].join(' '))
    assert.equal(optionValue(calls[0], '--max-time'), String(TRANSPORT_TIMEOUT_S))
  })

  it('auto mode on a floored target: the floor probe keeps its own short deadline, then the long poll gets the transport timeout', async () => {
    const { calls, out } = await observeCurlArgv({ mode: 'auto', request: READ_REQUEST, floorStdout: '{"floor":true}' })
    assert.equal(calls.length, 2)
    assert.ok(calls[0].some((a) => a.endsWith('/permission-floor')), calls[0].join(' '))
    assert.equal(optionValue(calls[0], '--max-time'), String(FLOOR_PROBE_TIMEOUT_S))
    assert.ok(calls[1].some((a) => a.endsWith('/permission')), calls[1].join(' '))
    assert.equal(optionValue(calls[1], '--max-time'), String(TRANSPORT_TIMEOUT_S))
    assert.equal(out.permissionDecision, 'deny', 'the floored call was routed to the prompt, and the prompt said deny')
  })

  it('auto mode on an unfloored target: no long poll at all', async () => {
    const { calls, out } = await observeCurlArgv({ mode: 'auto', request: READ_REQUEST, floorStdout: '{"floor":false}' })
    assert.equal(calls.length, 1)
    assert.ok(calls[0].some((a) => a.endsWith('/permission-floor')))
    assert.equal(out.permissionDecision, 'allow')
  })
})

// ---------------------------------------------------------------------------
// 5. The chain, from the three OBSERVED numbers
// ---------------------------------------------------------------------------

describe('the deadline chain holds across the three programs that own it (#8529)', POSIX_ONLY, () => {
  let handler
  afterEach(() => {
    mock.timers.reset()
    handler?.destroy()
    handler = null
  })

  it('the daemon has answered at least 10 s before curl gives up, and the host timeout covers the script\'s budgeted envelope', async () => {
    // curl's deadlines: what the real script passes, in the mode that runs both calls.
    const { calls } = await observeCurlArgv({ mode: 'auto', request: READ_REQUEST, floorStdout: '{"floor":true}' })
    const floorS = Number(optionValue(calls[0], '--max-time'))
    const transportS = Number(optionValue(calls[1], '--max-time'))
    assert.ok(Number.isInteger(floorS) && floorS > 0, `floor --max-time: ${floorS}`)
    assert.ok(Number.isInteger(transportS) && transportS > 0, `transport --max-time: ${transportS}`)

    // The daemon's timer: has it fired by (curl's deadline - margin)?
    mock.timers.enable({ apis: ['setTimeout'] })
    const raised = await raiseMocked()
    handler = raised.handler
    mock.timers.tick(transportS * 1000 - MIN_TRANSPORT_MARGIN_MS)
    assert.equal(raised.res.endCalls, 1,
      `the daemon must have answered ${MIN_TRANSPORT_MARGIN_MS} ms before curl's ${transportS} s deadline`)
    assert.deepEqual(JSON.parse(raised.res.body), { decision: 'deny', reason: 'timeout' })
    mock.timers.reset()

    // The host timeout: what both registration sites wrote.
    const { userHooks, tuiHooks } = await readRegisteredHostTimeouts()
    for (const [site, hook] of [['user-level', userHooks[0]], ['claude-tui', tuiHooks[0]]]) {
      assert.ok(hook.timeout >= floorS + transportS + MIN_LOCAL_WORK_BUDGET_S,
        `${site} host timeout ${hook.timeout} s must cover floor ${floorS} s + long poll ${transportS} s + ${MIN_LOCAL_WORK_BUDGET_S} s of local work`)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Transport classification (stub curl: exact exit code and trailer)
// ---------------------------------------------------------------------------

describe('permission-hook.sh: a curl timeout after the upload began is not "unreachable" (#8529)', POSIX_ONLY, () => {
  async function classify({ exit, stdout, ask = false }) {
    const binDir = makeBinDir(STUB_CURL)
    return hookDecision({
      binDir,
      env: {
        ...stubEnv({ stdout, exit, log: newLog() }),
        ...(ask ? { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' } : {}),
      },
    })
  }

  it('exit 28 after the upload began DENIES with the transport-timeout wording', async () => {
    const out = await classify({ exit: 28, stdout: '\n000 50' })
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
    assert.ok(!/never reached your phone/.test(out.permissionDecisionReason), 'the upload began; do not say it never arrived')
    // ...and a byte count is not delivery either: claim neither.
    assert.ok(!/sent the permission request to the daemon|reached the daemon|reached your phone|was shown/i.test(out.permissionDecisionReason),
      'a positive byte count does not show the daemon or the phone received anything')
    assert.ok(/began sending/.test(out.permissionDecisionReason) && /complete response/.test(out.permissionDecisionReason), out.permissionDecisionReason)
    assert.ok(!/Denied by user/.test(out.permissionDecisionReason), 'nobody denied it')
    assert.notEqual(out.permissionDecisionReason, NO_ANSWER_DENY, 'the daemon did not say nobody answered; curl gave up')
  })

  it('exit 28 after the upload began DENIES even under CHROXY_HOOK_UNREACHABLE_DECISION=ask', async () => {
    const out = await classify({ exit: 28, stdout: '\n000 50', ask: true })
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
  })

  it('exit 28 never reads the body: an allow token in a timed-out transfer still DENIES', async () => {
    for (const stdout of ['{"decision":"allow"}\n200 50', '{"decision":"allow"}\n000 50', '{"decision":"allowAlways"}\n200 50']) {
      for (const ask of [false, true]) {
        const out = await classify({ exit: 28, stdout, ask })
        assert.equal(out.permissionDecision, 'deny', JSON.stringify(stdout))
        assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
      }
    }
  })

  // The daemon had already REJECTED the request (status line received) and then
  // stalled. That rejection is the more specific truth; a timeout must not hide it.
  for (const status of [401, 413, 429, 500, 503]) {
    it(`exit 28 after a ${status} status arrived keeps the rejection visible, and DENIES under =ask too`, async () => {
      for (const ask of [false, true]) {
        const out = await classify({ exit: 28, stdout: `{"decision":"allow"}\n${status} 50`, ask })
        assert.equal(out.permissionDecision, 'deny')
        assert.ok(out.permissionDecisionReason.includes(`(HTTP ${status})`), out.permissionDecisionReason)
        assert.notEqual(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
      }
    })
  }

  it('exit 28 after any other final non-200 status reads as that status, as a completed transfer would', async () => {
    for (const status of [204, 302, 404]) {
      const timedOut = await classify({ exit: 28, stdout: `\n${status} 50` })
      const completed = await classify({ exit: 0, stdout: `\n${status} 50` })
      assert.equal(timedOut.permissionDecision, 'deny', String(status))
      assert.ok(timedOut.permissionDecisionReason.includes(`(HTTP ${status})`), timedOut.permissionDecisionReason)
      assert.deepEqual(timedOut, completed, String(status))
    }
  })

  it('exit 28 after a rejection status keeps it even when curl counted no uploaded bytes', async () => {
    const out = await classify({ exit: 28, stdout: '\n413 0' })
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(out.permissionDecisionReason.includes('(HTTP 413)'), out.permissionDecisionReason)
  })

  it('exit 28 with a status that is not a final rejection (none, 1xx, out of range) is a plain transport timeout', async () => {
    for (const status of ['000', '100', '199', '600', '999']) {
      const out = await classify({ exit: 28, stdout: `\n${status} 50` })
      assert.equal(out.permissionDecision, 'deny', status)
      assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY, status)
    }
  })

  it('exit 28 with any positive byte count, however small, is the same deny: one byte is "began", not "delivered"', async () => {
    for (const count of ['1', '7', '65536', '99999999999']) {
      for (const ask of [false, true]) {
        const out = await classify({ exit: 28, stdout: `\n000 ${count}`, ask })
        assert.equal(out.permissionDecision, 'deny', count)
        assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY, count)
      }
    }
  })

  it('exit 28 with a rejection status but a malformed byte count trusts neither: unreachable wording', async () => {
    for (const stdout of ['\n500 abc', '\n500 ', '\n500', '\n500 5 5']) {
      const out = await classify({ exit: 28, stdout })
      assert.equal(out.permissionDecision, 'deny', JSON.stringify(stdout))
      assert.equal(out.permissionDecisionReason, UNREACHABLE_DENY, JSON.stringify(stdout))
    }
  })

  // Not proof that the upload even began: these keep the unreachable handling, opt-out included.
  const NOT_PROVEN_SENT = ['\n000 0', '', '\n000', '\n000 ', '\n000 abc', '\n000 -5', '\n000 5 5', '\n000 5.000', '\n000 050', '\n 50', '\nabc 50', '50']
  for (const stdout of NOT_PROVEN_SENT) {
    it(`exit 28 without proof the upload began (${JSON.stringify(stdout)}) keeps the unreachable wording`, async () => {
      const out = await classify({ exit: 28, stdout })
      assert.equal(out.permissionDecision, 'deny')
      assert.equal(out.permissionDecisionReason, UNREACHABLE_DENY)
    })
  }

  it('exit 28 with no byte uploaded still honours CHROXY_HOOK_UNREACHABLE_DECISION=ask (unchanged)', async () => {
    const out = await classify({ exit: 28, stdout: '\n000 0', ask: true })
    assert.equal(out.permissionDecision, 'ask')
  })

  // Every other curl failure is NOT a timeout and must not be worded as one.
  for (const exit of [6, 7, 35, 52, 56]) {
    it(`curl exit ${exit} is not a timeout: unreachable wording, and the =ask opt-out still applies (unchanged)`, async () => {
      const denied = await classify({ exit, stdout: '\n000 50' })
      assert.equal(denied.permissionDecision, 'deny')
      assert.equal(denied.permissionDecisionReason, UNREACHABLE_DENY)
      const asked = await classify({ exit, stdout: '\n000 50', ask: true })
      assert.equal(asked.permissionDecision, 'ask')
    })
  }

  it('a failed transfer never reads the body, whatever the exit code', async () => {
    for (const exit of [7, 52, 56]) {
      const out = await classify({ exit, stdout: '{"decision":"allow"}\n200 50' })
      assert.equal(out.permissionDecision, 'deny', `exit ${exit}`)
    }
  })

  it('a successful transfer reads the status from the first field of the trailer', async () => {
    assert.equal((await classify({ exit: 0, stdout: '{"decision":"allow"}\n200 50' })).permissionDecision, 'allow')
    const deny = await classify({ exit: 0, stdout: '{"decision":"deny"}\n200 50' })
    assert.equal(deny.permissionDecision, 'deny')
    assert.equal(deny.permissionDecisionReason, USER_DENY)
    const noAnswer = await classify({ exit: 0, stdout: '{"decision":"deny","reason":"timeout"}\n200 50' })
    assert.equal(noAnswer.permissionDecisionReason, NO_ANSWER_DENY)
    const rejected = await classify({ exit: 0, stdout: '{"decision":"allow"}\n500 50' })
    assert.equal(rejected.permissionDecision, 'deny')
    assert.ok(rejected.permissionDecisionReason.includes('(HTTP 500)'), rejected.permissionDecisionReason)
  })

  it('a trailer that is not a status denies: the byte count cannot stand in for the status', async () => {
    for (const stdout of ['{"decision":"allow"}\n 200', '{"decision":"allow"}\n50 200', '{"decision":"allow"}\n2000 50', '{"decision":"allow"}\n']) {
      const out = await classify({ exit: 0, stdout })
      assert.equal(out.permissionDecision, 'deny', JSON.stringify(stdout))
      assert.ok(/\(HTTP (unknown|\d{3})\)/.test(out.permissionDecisionReason), out.permissionDecisionReason)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Real curl, real sockets
// ---------------------------------------------------------------------------

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

async function realHookAgainst(status, body, env = {}) {
  const srv = await startFixedServer(status, body)
  try {
    return await hookDecision({ port: srv.port, env })
  } finally {
    await srv.close()
  }
}

async function getClosedPort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

/** The PRODUCTION handler behind a real http server, counting what it writes. */
/** A Map that also remembers every value ever set, in order. */
class RecordingMap extends Map {
  held = []
  set(key, value) {
    this.held.push(value)
    return super.set(key, value)
  }
}

async function startRealDaemon() {
  const pending = new RecordingMap()
  const prompts = []
  const handler = makeHandler({ pending, prompts })
  const writes = { end: 0 }
  const sockets = new Set()
  const server = createServer((req, res) => {
    const end = res.end.bind(res)
    res.end = (...args) => { writes.end++; return end(...args) }
    if (req.method === 'POST' && req.url === '/permission') { handler.handlePermissionRequest(req, res); return }
    if (req.method === 'POST' && req.url === '/permission-floor') { handler.handlePermissionFloorCheck(req, res); return }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    handler,
    pending,
    held: pending.held,
    prompts,
    writes,
    async waitForPending() {
      for (let i = 0; i < 400 && pending.size === 0; i++) await realSleep(25)
      assert.equal(pending.size, 1, 'the hook request reached the daemon and is held pending')
      return [...pending.keys()][0]
    },
    async waitForReleased() {
      for (let i = 0; i < 400 && pending.size !== 0; i++) await realSleep(25)
      assert.equal(pending.size, 0, 'the daemon released the request once its asker went away')
    },
    close: async () => {
      handler.destroy()
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

describe('permission-hook.sh with the real curl: every outcome still reads correctly (#8529)', POSIX_ONLY, () => {
  it('an explicit allow allows', async () => {
    const out = await realHookAgainst(200, '{"decision":"allow"}')
    assert.equal(out.permissionDecision, 'allow')
    assert.equal('permissionDecisionReason' in out, false)
  })

  it('an explicit deny is a user deny', async () => {
    const out = await realHookAgainst(200, '{"decision":"deny"}')
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, USER_DENY)
  })

  it('the daemon no-answer deny reads as nobody answered, also under the =ask opt-out', async () => {
    for (const env of [{}, { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' }]) {
      const out = await realHookAgainst(200, '{"decision":"deny","reason":"timeout"}', env)
      assert.equal(out.permissionDecision, 'deny')
      assert.equal(out.permissionDecisionReason, NO_ANSWER_DENY)
    }
  })

  for (const status of [400, 413, 429, 500, 503]) {
    it(`a non-200 (${status}) denies with its status, whatever the body claims`, async () => {
      const out = await realHookAgainst(status, '{"decision":"allow"}', { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' })
      assert.equal(out.permissionDecision, 'deny')
      assert.ok(out.permissionDecisionReason.includes(`(HTTP ${status})`), out.permissionDecisionReason)
    })
  }

  it('a body that forges a trailer line cannot change the status curl reported', async () => {
    const forged500 = await realHookAgainst(500, '{"decision":"allow"}\n200 50')
    assert.equal(forged500.permissionDecision, 'deny')
    assert.ok(forged500.permissionDecisionReason.includes('(HTTP 500)'), forged500.permissionDecisionReason)
    const forged200 = await realHookAgainst(200, '{"decision":"deny"}\n500 0\n')
    assert.equal(forged200.permissionDecision, 'deny')
    assert.equal(forged200.permissionDecisionReason, USER_DENY)
  })

  for (const body of ['', 'not json', '[]', '{"decision":"maybe"}']) {
    it(`a 200 with no recognizable decision (${JSON.stringify(body)}) denies as unrecognized`, async () => {
      const out = await realHookAgainst(200, body)
      assert.equal(out.permissionDecision, 'deny')
      assert.ok(/unrecognized permission response/.test(out.permissionDecisionReason), out.permissionDecisionReason)
    })
  }

  it('nothing listening: unreachable wording, and the =ask opt-out applies (unchanged)', async () => {
    const port = await getClosedPort()
    const denied = await hookDecision({ port })
    assert.equal(denied.permissionDecision, 'deny')
    assert.equal(denied.permissionDecisionReason, UNREACHABLE_DENY)
    const asked = await hookDecision({ port, env: { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' } })
    assert.equal(asked.permissionDecision, 'ask')
  })
})

describe('daemon and hook, real sockets: timeouts, cancellation and what is left behind (#8529)', POSIX_ONLY, () => {
  let daemon
  afterEach(async () => {
    mock.timers.reset()
    await daemon?.close()
    daemon = null
  })

  // SCALED: the wrapper replaces only the number after --max-time, so the real
  // curl reaches its own deadline in a couple of seconds. The daemon's timer is frozen
  // by the mocked clock, standing in for a daemon whose reply never comes.
  async function scaledTransportTimeout(extraEnv = {}) {
    mock.timers.enable({ apis: ['setTimeout'] })
    daemon = await startRealDaemon()
    const binDir = makeBinDir(SCALED_CURL)
    const hook = spawnHook({ port: daemon.port, binDir, env: { REAL_CURL: findRealCurl(), SCALED_MAX_TIME: SCALED_CURL_DEADLINE_S, ...extraEnv } })
    // The resolver is taken from the record of every request the daemon ever
    // held, after the hook has finished. Nothing here has to observe the
    // request inside curl's short window.
    const out = decisionFrom(await hook.done)
    assert.equal(daemon.held.length, 1, 'the hook request reached the daemon and was held')
    return { out, lateAnswer: daemon.held[0].resolve }
  }

  it('real curl times out on a request the daemon is holding: transport-timeout deny, not "unreachable"', async () => {
    const { out } = await scaledTransportTimeout()
    assert.equal(daemon.prompts.length, 1, 'the prompt had been shown to clients')
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
  })

  it('the same under CHROXY_HOOK_UNREACHABLE_DECISION=ask: still a deny', async () => {
    const { out } = await scaledTransportTimeout({ CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' })
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
  })

  // The server writes a status line (and, for the 200, part of a body) and then
  // stalls. REAL curl, deadline scaled to one second by the wrapper: exit 28 with
  // a real trailer carrying that status.
  async function stalledResponse(status, partialBody, extraEnv = {}) {
    const sockets = new Set()
    const server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        if (partialBody) res.write(partialBody)
        else res.flushHeaders()
        // never ended
      })
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      const binDir = makeBinDir(SCALED_CURL)
      return await hookDecision({ port: server.address().port, binDir, env: { REAL_CURL: findRealCurl(), SCALED_MAX_TIME: SCALED_CURL_DEADLINE_S, ...extraEnv } })
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    }
  }

  for (const status of [401, 429, 500]) {
    it(`real curl: a ${status} whose body stalls keeps the HTTP rejection visible, and DENIES under =ask`, async () => {
      for (const env of [{}, { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' }]) {
        const out = await stalledResponse(status, '{"decision":"allow"}', env)
        assert.equal(out.permissionDecision, 'deny')
        assert.ok(out.permissionDecisionReason.includes(`(HTTP ${status})`), out.permissionDecisionReason)
      }
    })
  }

  it('real curl: a rejection status with no body bytes at all is still kept', async () => {
    const out = await stalledResponse(503, '')
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(out.permissionDecisionReason.includes('(HTTP 503)'), out.permissionDecisionReason)
  })

  it('real curl: an INCOMPLETE 200 is refused even though its partial body says allow', async () => {
    for (const env of [{}, { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' }]) {
      const out = await stalledResponse(200, '{"decision":"allow"}', env)
      assert.equal(out.permissionDecision, 'deny', 'a response that never completed is not an answer')
      assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
    }
  })

  // A listener that accepts the connection and never READS from it. curl still
  // writes into the socket, so its uploaded-byte count is positive, while the
  // application on the other end has received nothing at all. This is the case
  // the wording must survive: "began sending" is true, "the daemon got it" is not.
  async function neverReadingListener(request, extraEnv = {}, scaledMaxTime = SCALED_CURL_DEADLINE_S) {
    const sockets = new Set()
    let appBytesRead = 0
    const server = createNetServer({ pauseOnConnect: true }, (s) => {
      sockets.add(s)
      s.on('data', (d) => { appBytesRead += d.length })
      s.on('error', () => {})
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const copy = join(scratch, `curl-stdout-${++logCounter}`)
    try {
      const binDir = makeBinDir(SCALED_CURL_RECORDING)
      const out = await hookDecision({
        port: server.address().port,
        request,
        binDir,
        timeout: 60000,
        env: { REAL_CURL: findRealCurl(), SCALED_MAX_TIME: scaledMaxTime, CURL_STDOUT_COPY: copy, ...extraEnv },
      })
      const trailer = readFileSync(copy, 'utf8').split('\n').at(-1)
      return { out, trailer, uploaded: Number(trailer.split(' ')[1]), appBytesRead }
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    }
  }

  it('real curl: bytes counted as uploaded were never read by the listener, and the wording claims no delivery', async () => {
    for (const env of [{}, { CHROXY_HOOK_UNREACHABLE_DECISION: 'ask' }]) {
      const { out, trailer, uploaded, appBytesRead } = await neverReadingListener(BASH_REQUEST, env)
      assert.ok(/^000 \d+$/.test(trailer), `curl's trailer: ${JSON.stringify(trailer)}`)
      assert.ok(uploaded > 0, 'curl counted uploaded bytes')
      assert.equal(appBytesRead, 0, 'the application on the other end read none of them')
      assert.equal(out.permissionDecision, 'deny')
      assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
    }
  })

  it('real curl: a PARTIAL upload (fewer bytes than the request) that times out is the same deny', async () => {
    // Larger than the loopback socket buffers can absorb with nobody reading.
    // Longer than the other scaled cases: for a body this size curl first waits a
    // second for a "100 Continue" that never comes, and only then starts the upload.
    const big = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/work/project/big.txt', content: 'x'.repeat(PARTIAL_UPLOAD_BODY_BYTES) } })
    const { out, trailer, uploaded, appBytesRead } = await neverReadingListener(big, {}, '4')
    assert.ok(/^000 \d+$/.test(trailer), `curl's trailer: ${JSON.stringify(trailer)}`)
    assert.ok(uploaded > 0, 'the upload began')
    assert.ok(uploaded < Buffer.byteLength(big), `the upload did not finish (${uploaded} of ${Buffer.byteLength(big)} bytes)`)
    assert.equal(appBytesRead, 0)
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, TRANSPORT_TIMEOUT_DENY)
  })

  it('after a transport timeout the daemon releases the request, and a late answer writes nothing', async () => {
    const { lateAnswer } = await scaledTransportTimeout()
    await daemon.waitForReleased()
    lateAnswer('allow')
    mock.timers.tick(DECISION_WINDOW_MS)
    await realSleep(50)
    assert.equal(daemon.writes.end, 0, 'no response is written to a request whose asker is gone')
  })

  // SIMULATED host expiry: Claude Code is not run. Killing the hook's process
  // group is what "the host cancelled the hook" looks like from the daemon.
  it('SIMULATED host cancellation: a killed hook returns no decision, the daemon releases the request, a late answer writes nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    daemon = await startRealDaemon()
    const hook = spawnHook({ port: daemon.port })
    const requestId = await daemon.waitForPending()
    const lateAnswer = daemon.pending.get(requestId).resolve

    assert.equal(hook.killGroup(), true, 'the hook process group was there to kill')
    const r = await hook.done
    assert.equal(r.watchdog, false, 'killed by this test, not by the fixture watchdog')
    assert.equal(r.signal, 'SIGKILL')
    assert.equal(r.stdout, '', 'a cancelled hook has said nothing: no allow, no deny')

    await daemon.waitForReleased()
    lateAnswer('allow')
    mock.timers.tick(DECISION_WINDOW_MS)
    await realSleep(50)
    assert.equal(daemon.writes.end, 0)
  })

  it('a decision that arrives in time still wins: allow allows, deny is a user deny', async () => {
    daemon = await startRealDaemon()
    const allowHook = spawnHook({ port: daemon.port })
    daemon.handler.resolvePermission(await daemon.waitForPending(), 'allow')
    const allowed = decisionFrom(await allowHook.done)
    assert.equal(allowed.permissionDecision, 'allow')

    const denyHook = spawnHook({ port: daemon.port })
    daemon.handler.resolvePermission(await daemon.waitForPending(), 'deny')
    const denied = decisionFrom(await denyHook.done)
    assert.equal(denied.permissionDecision, 'deny')
    assert.equal(denied.permissionDecisionReason, USER_DENY)
  })

  it('nobody answers: the daemon timer fires at the window and the hook, still listening, reads it as nobody answered', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    daemon = await startRealDaemon()
    const hook = spawnHook({ port: daemon.port })
    await daemon.waitForPending()

    mock.timers.tick(DECISION_WINDOW_MS - 1)
    await realSleep(150)
    assert.equal(hook.hasExited(), false, 'the hook is still waiting one millisecond before the window closes')

    mock.timers.tick(1)
    const out = decisionFrom(await hook.done)
    assert.equal(out.permissionDecision, 'deny')
    assert.equal(out.permissionDecisionReason, NO_ANSWER_DENY)
    assert.equal(daemon.pending.size, 0)
  })
})

// ---------------------------------------------------------------------------
// 8. claude-tui: the session's own silence watchdogs stand down for the prompt
// ---------------------------------------------------------------------------

/**
 * A fourth clock used to run on the same prompt. ClaudeTuiSession arms a
 * stream-stall watchdog (default 300 s) every time a hook event drains, and
 * did not stand it down while an ordinary hook-routed permission was pending.
 * It started when the PreToolUse event drained; the daemon's decision window
 * started when the hook's request arrived. Whichever started first won: either
 * the daemon's deny, or a stream-stall teardown that Ctrl-C'd the turn about a
 * prompt that was simply waiting for a person. CliSession and SdkSession
 * already pause for a pending prompt; this holds claude-tui to the same.
 */
describe('claude-tui: silence watchdogs are suspended while a hook permission is pending (#8529)', () => {
  const STALL_MS = 300_000
  let skillsDir
  let unpin
  let session
  let handler

  before(() => { skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-deadline-chain-skills-')) })
  after(() => { rmSync(skillsDir, { recursive: true, force: true }) })
  afterEach(async () => {
    mock.timers.reset()
    handler?.destroy()
    handler = null
    if (session) { try { await session.destroy() } catch { /* already gone */ } }
    session = null
    if (unpin) unpin()
    unpin = null
  })

  function makeBusySession() {
    unpin = pinTmpDaemonBase(ClaudeTuiSession, 'SINK_BASE')
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null,
      resultTimeoutMs: 1_800_000, hardTimeoutMs: 7_200_000,
      streamStallTimeoutMs: STALL_MS, firstOutputTimeoutMs: 90_000,
    })
    session._isBusy = true
    session._currentMessageId = 'msg-1'
    const errors = []
    session.on('error', (e) => errors.push(e))
    return { s: session, errors }
  }

  it('the first pending prompt suspends the soft and stall timers; the hard cap stays armed', () => {
    const { s } = makeBusySession()
    s._armResultTimeout()
    assert.ok(s._streamStallTimeout, 'armed before the prompt')
    assert.ok(s._resultTimeout)

    s.notifyPermissionPending('perm-1')
    assert.equal(s._streamStallTimeout, null, 'stream-stall suspended')
    assert.equal(s._resultTimeout, null, 'soft inactivity suspended')
    assert.equal(s._firstOutputTimeout, null, 'a prompt is itself first output')
    assert.ok(s._hardTimeout, 'hard cap stays armed (last-resort backstop)')
  })

  // Covers both orders the two can arrive in: the test above is "drained, then
  // the prompt"; this is "the prompt, then a drain" — whether that drain is the
  // prompt's own PreToolUse file (the hook's request beat the poller) or a
  // later hook event while the prompt is still up.
  it('a hook-drain re-arm while the prompt is pending does not resurrect them', () => {
    const { s } = makeBusySession()
    s.notifyPermissionPending('perm-1')
    s._armResultTimeout() // what the drain loop does after every consumed hook file
    assert.equal(s._streamStallTimeout, null)
    assert.equal(s._resultTimeout, null)
    assert.ok(s._hardTimeout)
    s._armResultTimeout() // and again, for a second event under the same prompt
    assert.equal(s._streamStallTimeout, null)
    assert.equal(s._resultTimeout, null)
  })

  it('a request the daemon fails to hold (it answers 500) does not leave the session thinking a prompt is pending', async () => {
    const { s } = makeBusySession()
    s._armResultTimeout()
    const pending = new Map()
    handler = createPermissionHandler({
      sendFn: () => {},
      broadcastFn: () => { throw new Error('broadcast failed') },
      validateBearerAuth: () => true,
      validateHookAuth: () => true,
      pushManager: null,
      pendingPermissions: pending,
      permissionSessionMap: new Map(),
      getSessionManager: () => null,
      pairingManager: null,
      findSessionByHookSecret: () => ({ session: s, sessionId: 'sess-1' }),
    })
    const res = makeRes()
    handler.handlePermissionRequest(makeReq(BASH_REQUEST), res)
    await new Promise((r) => setImmediate(r))

    assert.equal(res.statusCode, 500)
    assert.equal(pending.size, 0, 'nothing is held')
    assert.equal(s.getPendingPermissionCount(), 0, 'and the session was told so')
    assert.ok(s._streamStallTimeout, 'so its stall watchdog is running again')
    assert.ok(s._resultTimeout)
  })

  it('they resume when the LAST pending prompt resolves, not before', () => {
    const { s } = makeBusySession()
    s._armResultTimeout()
    s.notifyPermissionPending('perm-1')
    s.notifyPermissionPending('perm-2')
    s.notifyPermissionResolved('perm-1')
    assert.equal(s._streamStallTimeout, null, 'one prompt is still pending')
    s.notifyPermissionResolved('perm-2')
    assert.ok(s._streamStallTimeout, 'stream-stall re-armed')
    assert.ok(s._resultTimeout, 'soft re-armed')
    assert.ok(s._hardTimeout)
  })

  it('a prompt resolving after the turn ended does not arm timers on an idle session', () => {
    const { s } = makeBusySession()
    s.notifyPermissionPending('perm-1')
    s._isBusy = false
    s._currentMessageId = null
    s.notifyPermissionResolved('perm-1')
    assert.equal(s._streamStallTimeout, null)
    assert.equal(s._resultTimeout, null)
  })

  // Deliberately NOT asserted: that the stall handler returns early under a
  // pending prompt. It cannot fire under one (the tests above), and if it ever
  // did it must still end the turn and expire the prompt — which
  // hook-routed-permission-bookkeeping.test.js (#7382) holds it to.
  it('if the stall handler ever did fire under a pending prompt, the turn ends and the prompt is expired, not left live', () => {
    const { s } = makeBusySession()
    s._activeTurn = { messageId: 'msg-1', startedAt: Date.now(), aborted: false, synthSeq: 0 }
    const expired = []
    s.on('permission_expired', (e) => expired.push(e))
    s.notifyPermissionPending('perm-1')
    s._handleStreamStall()
    assert.equal(s._isBusy, false)
    assert.deepEqual(expired.map((e) => e.requestId), ['perm-1'])
  })

  it('with no prompt pending the stall watchdog still tears a silent turn down', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { s, errors } = makeBusySession()
    // As after a consumed hook event: the 90 s first-output watchdog shares the
    // stream_stall error code, so it has to be out of the way or it would be
    // what ends the turn here and the stall timer would never be exercised.
    s._clearFirstOutputWatchdog()
    s._armResultTimeout()
    assert.equal(s._firstOutputTimeout, null)
    mock.timers.tick(STALL_MS - 1)
    assert.equal(s._isBusy, true, 'not before the stall deadline')
    mock.timers.tick(1)
    assert.equal(s._isBusy, false, 'a genuinely silent turn is still recovered')
    const stalls = errors.filter((e) => e.code === 'stream_stall')
    assert.equal(stalls.length, 1)
    assert.equal(stalls[0].timeoutMs, STALL_MS, 'by the stall watchdog, not the first-output one')
  })

  // The daemon releases an expired prompt synchronously, and that release comes
  // back through notifyPermissionResolved while the session is still marked
  // busy. Wired here as production wires it: permission_expired -> the real
  // handler's releaseAbandonedPermission -> cleanup -> the session.
  function wireProductionRelease(s) {
    const pending = new Map()
    handler = makeHandler({ pending, ownerSession: s })
    s.on('permission_expired', (e) => handler.releaseAbandonedPermission(e.requestId))
    return pending
  }
  async function holdOneRequest(s, pending) {
    const res = makeRes()
    handler.handlePermissionRequest(makeReq(BASH_REQUEST), res)
    await new Promise((r) => setImmediate(r))
    assert.equal(pending.size, 1)
    assert.equal(s.getPendingPermissionCount(), 1)
    return res
  }
  const TEARDOWNS = [
    ['the hard cap', (s) => s._handleHardTimeout()],
    ['a stream-stall teardown', (s) => s._handleStreamStall()],
    ['a first-output teardown', (s) => s._handleFirstOutputTimeout()],
    ['the PTY going away', (s) => s._onPtyGone({ exitCode: 1 }, 'exit')],
    ['a turn ending normally', (s) => s._clearTurnEndState()],
  ]
  for (const [name, drive] of TEARDOWNS) {
    it(`${name} with a prompt pending abandons it: the daemon's release does not re-arm any timer`, async () => {
      const { s } = makeBusySession()
      s._activeTurn = { messageId: 'msg-1', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      const pending = wireProductionRelease(s)
      const res = await holdOneRequest(s, pending)

      drive(s)

      assert.equal(s._isBusy, false, 'the turn ended')
      assert.equal(pending.size, 0, 'the daemon released its entry')
      assert.equal(res.endCalls, 1, 'and answered the hook')
      assert.deepEqual(JSON.parse(res.body), { decision: 'deny' })
      assert.equal(s.getPendingPermissionCount(), 0)
      assert.equal(s._streamStallTimeout, null, 'no stall timer on an idle session')
      assert.equal(s._resultTimeout, null, 'no soft timer on an idle session')
      assert.equal(s._hardTimeout, null, 'no hard cap on an idle session')
      assert.equal(s._abandoningPermissions, false, 'the latch is released')
    })
  }

  it('a stall or first-output teardown leaves none of the three turn timers armed, prompt or no prompt', () => {
    for (const drive of [(s) => s._handleStreamStall(), (s) => s._handleFirstOutputTimeout(), (s) => s._handleHardTimeout()]) {
      const { s } = makeBusySession()
      s._activeTurn = { messageId: 'msg-1', startedAt: Date.now(), aborted: false, synthSeq: 0 }
      s._armResultTimeout()
      assert.ok(s._hardTimeout && s._resultTimeout && s._streamStallTimeout, 'all three armed')
      drive(s)
      assert.equal(s._isBusy, false)
      assert.equal(s._hardTimeout, null)
      assert.equal(s._resultTimeout, null)
      assert.equal(s._streamStallTimeout, null)
    }
  })

  it('the abandon latch is released even when a permission_expired listener throws', () => {
    const { s } = makeBusySession()
    s.notifyPermissionPending('perm-1')
    s.on('permission_expired', () => { throw new Error('listener failed') })
    assert.throws(() => s._expirePendingPermissions('x'), /listener failed/)
    assert.equal(s._abandoningPermissions, false)
  })

  it('a prompt answered in the ordinary way after an earlier abandonment still resumes the watchdogs', () => {
    const { s } = makeBusySession()
    s.notifyPermissionPending('perm-old')
    s._expirePendingPermissions('the earlier turn ended')
    s._armResultTimeout()
    s.notifyPermissionPending('perm-new')
    assert.equal(s._streamStallTimeout, null)
    s.notifyPermissionResolved('perm-new')
    assert.ok(s._streamStallTimeout, 'the latch did not stick')
  })

  it('the hard cap still force-clears across a pending prompt, and the prompt is expired', () => {
    const { s, errors } = makeBusySession()
    const expired = []
    s.on('permission_expired', (e) => expired.push(e))
    s.notifyPermissionPending('perm-1')
    s._handleHardTimeout()
    assert.equal(s._isBusy, false)
    assert.equal(errors.length, 1)
    assert.deepEqual(expired.map((e) => e.requestId), ['perm-1'])
    assert.equal(s.getPendingPermissionCount(), 0)
  })

  it('a pending id left over at the start of a turn does not switch the first-output watchdog off', () => {
    const { s } = makeBusySession()
    s._pendingPermissionIds.add('perm-stale') // not via notify: its turn is long gone
    s._firstOutputDisarmed = false
    s._armResultTimeout()
    assert.equal(s._streamStallTimeout, null, 'silence timers wait for the daemon to release the stale prompt')
    assert.ok(s._firstOutputTimeout, 'the new turn keeps its first-output watchdog')
  })

  // The whole chain, under one mocked clock: the REAL session timers and the
  // PRODUCTION permission handler, wired exactly as ws-permissions wires them
  // (it calls notifyPermissionPending / notifyPermissionResolved on the session
  // that owns the hook secret). The hook's request arrives 10 s after the
  // PreToolUse event drained, which is the floor probe taking its full budget:
  // the session's stall deadline (t = 300 s) then falls BEFORE the daemon's
  // decision deadline (t = 310 s).
  it('the stall deadline that falls inside the decision window does not fire; the daemon timer ends the wait and the watchdog resumes', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { s, errors } = makeBusySession()
    const pending = new Map()
    handler = makeHandler({ pending, ownerSession: s })

    s._armResultTimeout() // t = 0: the PreToolUse event drained
    mock.timers.tick(10_000) // t = 10 s: the floor probe used its whole budget

    const res = makeRes()
    handler.handlePermissionRequest(makeReq(BASH_REQUEST), res)
    await new Promise((r) => setImmediate(r))
    assert.equal(pending.size, 1, 'the request is held')
    assert.equal(s.getPendingPermissionCount(), 1, 'and the session was told')

    mock.timers.tick(STALL_MS - 10_000) // t = 300 s: the session's old stall deadline
    assert.equal(s._isBusy, true, 'the turn was not torn down under a pending prompt')
    assert.equal(errors.length, 0, 'no stream_stall error')
    assert.equal(res.endCalls, 0, 'and the daemon has not answered yet: the user still has 10 s')

    mock.timers.tick(DECISION_WINDOW_MS - (STALL_MS - 10_000)) // t = 310 s: the decision window closes
    assert.equal(res.endCalls, 1)
    assert.deepEqual(JSON.parse(res.body), { decision: 'deny', reason: 'timeout' })
    assert.equal(s.getPendingPermissionCount(), 0)
    assert.equal(s._isBusy, true, 'the turn goes on: the model is told nobody answered')
    assert.ok(s._streamStallTimeout, 'and silence is watched again from here')

    mock.timers.tick(STALL_MS - 1)
    assert.equal(s._isBusy, true)
    mock.timers.tick(1) // 300 s of real silence after the deny
    assert.equal(s._isBusy, false, 'a turn that then stays silent is recovered as before')
    const stalls = errors.filter((e) => e.code === 'stream_stall')
    assert.equal(stalls.length, 1)
    assert.equal(stalls[0].timeoutMs, STALL_MS, 'by the stall watchdog')
  })
})

// ---------------------------------------------------------------------------
// 9. The fixture itself: a hook that never finishes must FAIL, not hang
// ---------------------------------------------------------------------------

describe('test fixture: a hook left waiting is a quick, named failure, not a hang (#8529)', POSIX_ONLY, () => {
  /** A server that reads the request and deliberately never answers it. */
  async function startHoldingServer() {
    const sockets = new Set()
    const state = { requests: 0, connectionsClosed: 0 }
    let seen
    const requestSeen = new Promise((r) => { seen = r })
    const server = createServer((req, res) => {
      state.requests++
      seen()
      req.on('data', () => {})
      res.on('close', () => { state.connectionsClosed++ })
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    return {
      port: server.address().port,
      state,
      requestSeen,
      close: async () => {
        for (const s of sockets) s.destroy()
        await new Promise((r) => server.close(r))
      },
    }
  }

  it('the watchdog takes down the whole hook process group, bash AND curl, and says so', async () => {
    const holding = await startHoldingServer()
    let hook
    try {
      // Start-up is not what is being timed: wait until curl is demonstrably
      // mid-request under the default (long) watchdog, and only then arm the
      // short one. What proves the group kill is that the pipes closed by
      // themselves (no stdioNeverClosed) and that the server saw the socket
      // drop, not how many milliseconds it took.
      hook = spawnHook({ port: holding.port })
      // Raced against the hook itself: if it exits (or its own long watchdog
      // fires) before any request arrives, that is a fixture failure to report,
      // not something to wait on forever.
      const first = await Promise.race([
        holding.requestSeen.then(() => 'request'),
        hook.done.then(() => 'hook-ended'),
      ])
      assert.equal(first, 'request', 'the hook ended before its request reached the server')
      hook.armWatchdog(300)
      const r = await hook.done

      assert.equal(holding.state.requests, 1, 'the hook had reached the server and was being held')
      assert.equal(r.watchdog, true)
      assert.equal(r.watchdogAfterMs, 300)
      assert.equal(r.stdout, '', 'a hook cut off mid-wait has decided nothing')
      assert.equal(r.stdioNeverClosed, undefined,
        'the pipes closed on their own once the group was killed, so nothing in it (curl) outlived bash')
      assert.equal(r.signal, 'SIGKILL')

      // curl is gone too: the server saw its connection drop.
      for (let i = 0; i < 80 && holding.state.connectionsClosed === 0; i++) await realSleep(25)
      assert.equal(holding.state.connectionsClosed, 1, "the server saw the hook's connection close")
    } finally {
      // Whatever failed above, do not leave a hook behind holding the server open.
      if (hook && !hook.hasExited()) {
        hook.killGroup()
        await hook.done
      }
      await holding.close()
    }
  })

  it('a test that expected a decision gets a failure naming the watchdog, not a JSON parse error', async () => {
    const holding = await startHoldingServer()
    try {
      await assert.rejects(
        hookDecision({ port: holding.port, timeout: 1000 }),
        (err) => /WATCHDOG: the hook had not finished after 1000 ms/.test(err.message),
      )
    } finally {
      await holding.close()
    }
  })

  it('killing a group that has already gone is harmless', async () => {
    const srv = await startFixedServer(200, '{"decision":"allow"}')
    try {
      const hook = spawnHook({ port: srv.port })
      assert.equal(decisionFrom(await hook.done).permissionDecision, 'allow')
      assert.equal(hook.killGroup(), false, 'nothing left to signal, and no error')
    } finally {
      await srv.close()
    }
  })
})
