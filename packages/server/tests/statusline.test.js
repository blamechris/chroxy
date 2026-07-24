/**
 * Unit coverage for the statusLine feature (#6791): config read + precedence,
 * the sandboxed executor (stdin contract, timeout kill, output cap, non-zero
 * exit), and the StatusLineManager (inactive no-op, throttle, dedupe, periodic
 * loop, timer cleanup).
 *
 * Every side-effecting dependency (spawn, timers, clock, file read, env) is
 * injected, so the file runs deterministically and EXITS 0 WITHOUT
 * --test-force-exit (no real slow process, no un-cleared timer, no wall-clock).
 * The two happy-path exec tests use a real `/bin/sh` echo/cat that exits
 * immediately and clears its own (unref'd) timeout.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  parseStatusLineConfig,
  statusLineSettingsPaths,
  buildStatusLineInput,
  runStatusLineCommand,
  statusLineDisplayText,
  StatusLineManager,
  STATUSLINE_MAX_OUTPUT_BYTES,
} from '../src/statusline.js'

// ---------------------------------------------------------------------------
// parseStatusLineConfig
// ---------------------------------------------------------------------------

test('parseStatusLineConfig accepts a type:command entry with a command', () => {
  const cfg = parseStatusLineConfig({ statusLine: { type: 'command', command: '~/s.sh', refreshInterval: 5 } })
  assert.deepEqual(cfg, { command: '~/s.sh', refreshIntervalMs: 5000 })
})

test('parseStatusLineConfig ignores an unused padding field (dead config, never rendered)', () => {
  const cfg = parseStatusLineConfig({ statusLine: { type: 'command', command: '~/s.sh', padding: 2 } })
  assert.equal('padding' in cfg, false)
})

test('parseStatusLineConfig rejects missing / malformed / empty / non-command entries', () => {
  assert.equal(parseStatusLineConfig(null), null)
  assert.equal(parseStatusLineConfig({}), null)
  assert.equal(parseStatusLineConfig({ statusLine: 'nope' }), null)
  assert.equal(parseStatusLineConfig({ statusLine: { type: 'static', command: 'x' } }), null)
  assert.equal(parseStatusLineConfig({ statusLine: { type: 'command', command: '' } }), null)
  assert.equal(parseStatusLineConfig({ statusLine: { type: 'command', command: '   ' } }), null)
  assert.equal(parseStatusLineConfig({ statusLine: { type: 'command' } }), null)
})

test('parseStatusLineConfig floors a tiny refreshInterval', () => {
  const cfg = parseStatusLineConfig({ statusLine: { type: 'command', command: 'x', refreshInterval: 0.1 } })
  assert.equal(cfg.refreshIntervalMs, 1000) // floored to the 1s minimum
  const noInterval = parseStatusLineConfig({ statusLine: { type: 'command', command: 'x' } })
  // Absent → null here, but StatusLineManager._tick then falls back to
  // STATUSLINE_DEFAULT_REFRESH_INTERVAL_MS — NOT event-driven-only.
  assert.equal(noInterval.refreshIntervalMs, null)
})

// ---------------------------------------------------------------------------
// statusLineSettingsPaths — precedence order
// ---------------------------------------------------------------------------

test('statusLineSettingsPaths lists project > user project-settings > user, highest first', () => {
  const paths = statusLineSettingsPaths('/proj', '/home/u')
  assert.deepEqual(paths, [
    '/proj/.claude/settings.json',
    '/home/u/.claude/project-settings.json',
    '/home/u/.claude/settings.json',
  ])
})

// ---------------------------------------------------------------------------
// buildStatusLineInput — stdin contract mapping
// ---------------------------------------------------------------------------

test('buildStatusLineInput maps known fields and omits absent ones', () => {
  const input = buildStatusLineInput({
    sessionId: 'sess-1',
    sessionName: 'My session',
    cwd: '/proj',
    projectDir: '/proj-root',
    model: { id: 'claude-opus-4-8', displayName: 'Opus' },
    cost: { totalCostUsd: 0.42, totalDurationMs: 1000 },
  })
  assert.equal(input.session_id, 'sess-1')
  assert.equal(input.session_name, 'My session')
  assert.equal(input.cwd, '/proj')
  assert.equal(input.model.id, 'claude-opus-4-8')
  assert.equal(input.model.display_name, 'Opus')
  assert.equal(input.workspace.current_dir, '/proj')
  assert.equal(input.workspace.project_dir, '/proj-root')
  assert.equal(input.cost.total_cost_usd, 0.42)
  assert.equal(input.cost.total_duration_ms, 1000)
  // Absent fields are omitted entirely (contract allows absent, not null).
  assert.equal('version' in input, false)
  assert.equal('transcript_path' in input, false)
})

test('buildStatusLineInput omits an empty cost / model object', () => {
  const input = buildStatusLineInput({ cwd: '/p', cost: {}, model: {} })
  assert.equal('cost' in input, false)
  assert.equal('model' in input, false)
})

// ---------------------------------------------------------------------------
// runStatusLineCommand — real /bin/sh happy paths
// ---------------------------------------------------------------------------

test('runStatusLineCommand captures stdout of a simple script (exit 0)', async () => {
  const res = await runStatusLineCommand({
    command: "printf 'branch: main'",
    cwd: process.cwd(),
    input: '{}',
    env: process.env,
  })
  assert.equal(res.exitCode, 0)
  assert.equal(res.stdout, 'branch: main')
  assert.equal(res.timedOut, false)
  assert.equal(statusLineDisplayText(res), 'branch: main')
})

test('runStatusLineCommand pipes the session JSON on stdin (documented contract)', async () => {
  const input = JSON.stringify({ session_id: 'abc123' })
  // `cat` echoes whatever we wrote to stdin — proves the JSON reached the script.
  const res = await runStatusLineCommand({ command: 'cat', cwd: process.cwd(), input, env: process.env })
  assert.equal(res.exitCode, 0)
  assert.match(res.stdout, /abc123/)
})

test('statusLineDisplayText is blank for a non-zero exit', async () => {
  const res = await runStatusLineCommand({ command: 'echo out; exit 3', cwd: process.cwd(), input: '{}', env: process.env })
  assert.equal(res.exitCode, 3)
  assert.equal(statusLineDisplayText(res), '')
})

// ---------------------------------------------------------------------------
// runStatusLineCommand — timeout + output cap via injected seams
// ---------------------------------------------------------------------------

/** A fake child process whose lifecycle the test drives explicitly. */
function makeFakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = () => {}
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.kill = (sig) => {
    child.killed = true
    child._killedWith = sig
    return true
  }
  return child
}

/** Injectable timer registry — captures callbacks so the test fires them. */
function makeTimerHarness() {
  let nextId = 1
  const timers = new Map()
  return {
    cleared: [],
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
      return undefined
    },
    fire: (id) => {
      const t = timers.get(id)
      if (t) t.fn()
    },
    pending: () => [...timers.keys()],
  }
}

// ---------------------------------------------------------------------------
// runStatusLineCommand — shell chosen by platform (#6978 Copilot thread: win32
// hard-coded /bin/sh, which doesn't exist on Windows)
// ---------------------------------------------------------------------------

test('runStatusLineCommand spawns /bin/sh -c on a non-win32 platform', async () => {
  const child = makeFakeChild()
  let spawnCall = null
  const promise = runStatusLineCommand({
    command: 'echo hi',
    cwd: '/x',
    input: '{}',
    env: {},
    platform: 'darwin',
    spawnFn: (file, args, options) => {
      spawnCall = { file, args, options }
      return child
    },
  })
  assert.equal(spawnCall.file, '/bin/sh')
  assert.deepEqual(spawnCall.args, ['-c', 'echo hi'])
  assert.equal(spawnCall.options.windowsVerbatimArguments, undefined)
  child.exitCode = 0
  child.emit('exit', 0, null)
  await promise
})

test('runStatusLineCommand spawns COMSPEC (cmd.exe) with /d /s /c on win32', async () => {
  const child = makeFakeChild()
  let spawnCall = null
  const prevComspec = process.env.COMSPEC
  process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
  try {
    const promise = runStatusLineCommand({
      command: 'echo hi',
      cwd: '/x',
      input: '{}',
      env: {},
      platform: 'win32',
      spawnFn: (file, args, options) => {
        spawnCall = { file, args, options }
        return child
      },
    })
    assert.equal(spawnCall.file, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(spawnCall.args, ['/d', '/s', '/c', '"echo hi"'])
    assert.equal(spawnCall.options.windowsVerbatimArguments, true)
    child.exitCode = 0
    child.emit('exit', 0, null)
    await promise
  } finally {
    if (prevComspec === undefined) delete process.env.COMSPEC
    else process.env.COMSPEC = prevComspec
  }
})

test('runStatusLineCommand falls back to cmd.exe on win32 when COMSPEC is unset', async () => {
  const child = makeFakeChild()
  let spawnCall = null
  const prevComspec = process.env.COMSPEC
  delete process.env.COMSPEC
  try {
    const promise = runStatusLineCommand({
      command: 'echo hi',
      cwd: '/x',
      input: '{}',
      env: {},
      platform: 'win32',
      spawnFn: (file, args, options) => {
        spawnCall = { file, args, options }
        return child
      },
    })
    assert.equal(spawnCall.file, 'cmd.exe')
    child.exitCode = 0
    child.emit('exit', 0, null)
    await promise
  } finally {
    if (prevComspec === undefined) delete process.env.COMSPEC
    else process.env.COMSPEC = prevComspec
  }
})

test('runStatusLineCommand kills a slow script on timeout (SIGTERM) and reports timedOut', async () => {
  const child = makeFakeChild()
  const timers = makeTimerHarness()
  const promise = runStatusLineCommand({
    command: 'sleep 999',
    cwd: '/x',
    input: '{}',
    env: {},
    timeoutMs: 2000,
    spawnFn: () => child,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  // One timer registered so far: the timeout. Fire it → SIGTERM the child.
  const [timeoutId] = timers.pending()
  timers.fire(timeoutId)
  assert.equal(child.killed, true)
  assert.equal(child._killedWith, 'SIGTERM')
  // The child now actually exits (killed); resolve the executor promise.
  child.exitCode = null
  child.emit('exit', null, 'SIGTERM')
  const res = await promise
  assert.equal(res.timedOut, true)
  assert.equal(res.signal, 'SIGTERM')
  assert.equal(statusLineDisplayText(res), '') // timeout → blank
})

test('runStatusLineCommand caps stdout at the byte limit and truncates', async () => {
  const child = makeFakeChild()
  const timers = makeTimerHarness()
  const promise = runStatusLineCommand({
    command: 'yes',
    cwd: '/x',
    input: '{}',
    env: {},
    spawnFn: () => child,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  // Emit far more than the cap in a single chunk.
  const huge = Buffer.alloc(STATUSLINE_MAX_OUTPUT_BYTES * 3, 0x61) // 'a'
  child.stdout.emit('data', huge)
  assert.equal(child.killed, true) // cap hit → SIGTERM
  child.emit('exit', null, 'SIGTERM')
  const res = await promise
  assert.equal(res.truncated, true)
  assert.equal(res.stdout.length, STATUSLINE_MAX_OUTPUT_BYTES)
})

test('runStatusLineCommand folds a spawn error into a result rather than throwing', async () => {
  const child = makeFakeChild()
  const promise = runStatusLineCommand({ command: 'x', cwd: '/x', input: '{}', env: {}, spawnFn: () => child })
  child.emit('error', new Error('ENOENT'))
  const res = await promise
  assert.equal(res.error, 'ENOENT')
  assert.equal(statusLineDisplayText(res), '')
})

// ---------------------------------------------------------------------------
// StatusLineManager.resolveConfig — precedence + caching
// ---------------------------------------------------------------------------

function fakeReadFrom(fileMap) {
  return async (path) => {
    if (path in fileMap) return fileMap[path]
    const err = new Error('ENOENT')
    err.code = 'ENOENT'
    throw err
  }
}

test('resolveConfig: project .claude/settings.json overrides user settings', async () => {
  const files = {
    '/proj/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'project.sh' } }),
    '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'user.sh' } }),
  }
  const mgr = new StatusLineManager({ homeDir: '/home', readFileFn: fakeReadFrom(files) })
  const cfg = await mgr.resolveConfig('/proj')
  assert.equal(cfg.command, 'project.sh')
})

test('resolveConfig: falls back to user settings when the project has none', async () => {
  const files = {
    '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'user.sh' } }),
  }
  const mgr = new StatusLineManager({ homeDir: '/home', readFileFn: fakeReadFrom(files) })
  const cfg = await mgr.resolveConfig('/proj')
  assert.equal(cfg.command, 'user.sh')
})

test('resolveConfig: returns null when nothing configures a statusLine, and skips malformed JSON', async () => {
  const files = {
    '/proj/.claude/settings.json': '{ not json',
    '/home/.claude/settings.json': JSON.stringify({ other: true }),
  }
  const mgr = new StatusLineManager({ homeDir: '/home', readFileFn: fakeReadFrom(files) })
  assert.equal(await mgr.resolveConfig('/proj'), null)
})

// ---------------------------------------------------------------------------
// StatusLineManager.refresh — inactive no-op, emit, throttle, dedupe
// ---------------------------------------------------------------------------

/** Manager wired to a scripted fake spawn producing `stdout` then exit `code`. */
function managerWithScript({ files, stdout = '', code = 0, now }) {
  const spawnFn = () => {
    const child = makeFakeChild()
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.exitCode = code
      child.emit('exit', code, null)
    })
    return child
  }
  return new StatusLineManager({
    homeDir: '/home',
    readFileFn: fakeReadFrom(files),
    spawnFn,
    buildEnv: () => ({}),
    now: now || Date.now,
    minRefreshIntervalMs: 1000,
  })
}

test('refresh is a silent no-op when no statusLine is configured', async () => {
  const mgr = managerWithScript({ files: {} })
  const events = []
  mgr.on('output', (e) => events.push(e))
  const out = await mgr.refresh('s1', { cwd: '/proj' })
  assert.equal(out.active, false)
  assert.equal(out.emitted, false)
  assert.equal(events.length, 0)
})

test('refresh emits the rendered stdout when configured', async () => {
  const files = { '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 's.sh' } }) }
  const mgr = managerWithScript({ files, stdout: 'main | $0.10\n' })
  const events = []
  mgr.on('output', (e) => events.push(e))
  const out = await mgr.refresh('s1', { cwd: '/proj' })
  assert.equal(out.active, true)
  assert.equal(out.emitted, true)
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 's1')
  assert.equal(events[0].text, 'main | $0.10') // trailing newline trimmed
  assert.equal(events[0].active, true)
})

test('refresh throttles a second call within the debounce floor', async () => {
  const files = { '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 's.sh' } }) }
  let clock = 1000
  const mgr = managerWithScript({ files, stdout: 'x', now: () => clock })
  const events = []
  mgr.on('output', (e) => events.push(e))
  await mgr.refresh('s1', { cwd: '/proj' })
  clock += 100 // still under the 1000ms floor
  const skipped = await mgr.refresh('s1', { cwd: '/proj' })
  assert.equal(skipped, null) // throttled
  clock += 2000 // past the floor
  await mgr.refresh('s1', { cwd: '/proj' })
  assert.equal(events.length, 1) // same text → deduped even though it ran again
})

test('refresh dedupes identical output but re-emits on change', async () => {
  const files = { '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 's.sh' } }) }
  let clock = 0
  let out = 'aaa'
  const spawnFn = () => {
    const child = makeFakeChild()
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(out))
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child
  }
  const mgr = new StatusLineManager({ homeDir: '/home', readFileFn: fakeReadFrom(files), spawnFn, buildEnv: () => ({}), now: () => clock, minRefreshIntervalMs: 0 })
  const events = []
  mgr.on('output', (e) => events.push(e))
  await mgr.refresh('s1', { cwd: '/proj' })
  clock += 10
  await mgr.refresh('s1', { cwd: '/proj' }) // same text → no emit
  assert.equal(events.length, 1)
  out = 'bbb'
  clock += 10
  await mgr.refresh('s1', { cwd: '/proj' }) // changed → emit
  assert.equal(events.length, 2)
  assert.equal(events[1].text, 'bbb')
})

// ---------------------------------------------------------------------------
// StatusLineManager periodic loop — scheduling + cleanup (injected timers)
// ---------------------------------------------------------------------------

test('startSession schedules a tick; stopSession clears the timer', async () => {
  const files = { '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 's.sh' } }) }
  const timers = makeTimerHarness()
  const mgr = managerWithScript({ files, stdout: 'x' })
  // Swap in the injectable timer harness.
  mgr._setTimer = timers.setTimer
  mgr._clearTimer = timers.clearTimer

  mgr.startSession('s1', () => ({ cwd: '/proj' }))
  assert.equal(timers.pending().length, 1) // initial tick scheduled

  mgr.stopSession('s1')
  assert.equal(timers.pending().length, 0) // timer cleared, session dropped
})

test('stopAll clears every tracked timer and blocks further scheduling', async () => {
  const files = { '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 's.sh' } }) }
  const timers = makeTimerHarness()
  const mgr = managerWithScript({ files, stdout: 'x' })
  mgr._setTimer = timers.setTimer
  mgr._clearTimer = timers.clearTimer

  mgr.startSession('s1', () => ({ cwd: '/proj' }))
  mgr.startSession('s2', () => ({ cwd: '/proj2' }))
  assert.equal(timers.pending().length, 2)

  mgr.stopAll()
  assert.equal(timers.pending().length, 0)
  // A start after stopAll is a no-op (stopped latch).
  mgr.startSession('s3', () => ({ cwd: '/proj3' }))
  assert.equal(timers.pending().length, 0)
})
