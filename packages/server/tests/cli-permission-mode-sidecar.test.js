import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { CliSession } from '../src/cli-session.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

/**
 * #7337 — `claude-cli` must resolve its permission mode through the SAME
 * re-readable sidecar file `claude-tui` has had since #4013.
 *
 * The defect: `permission-hook.sh` resolves the mode as
 *   1. CHROXY_PERMISSION_MODE_FILE (re-read on every tool call)
 *   2. CHROXY_PERMISSION_MODE      (frozen at subprocess spawn)
 *   3. "approve"
 *
 * `CliSession._buildChildEnv()` set only (2). Its ONLY way to refresh the
 * mode was `_onPermissionModeChanged` -> `_killAndRespawn()`, which does not
 * take effect until the OLD child has exited (up to a 10s force-kill grace).
 * Every PreToolUse hook fired by the still-live old child in that window —
 * and every hook fired at all if the respawn never lands — resolves the
 * STALE mode. Observed in production as an Allow/Deny card for `Bash` on a
 * session whose persisted state read `"permissionMode": "auto"`.
 *
 * Two layers here, deliberately:
 *   - the wiring (sidecar exists, env points at it, a mode flip rewrites it
 *     synchronously, destroy() cleans it up)
 *   - the OUTCOME, driven through the real `permission-hook.sh` with the
 *     exact frozen env the running child holds. That is the layer that says
 *     "no prompt is raised", which is what the user actually reported.
 *
 * The `approve` positive controls are load-bearing (docs/false-safety-guards.md):
 * a "fix" that made the hook allow unconditionally would satisfy every auto
 * assertion below while deleting the permission system. They fail such a fix,
 * because they require the prompt to STILL be raised in approve mode through
 * the very same sidecar channel.
 */

// ---------------------------------------------------------------- helpers

/** Async spawn of the real hook script. */
function runHook({ input, env, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [hookPath], { env })
    let stdout = ''
    let stderr = ''
    let timer = null
    let settled = false
    const settle = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(arg)
    }
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => settle(reject, err))
    child.on('close', (status, signal) => settle(resolve, { status, signal, stdout, stderr }))
    if (timeout) timer = setTimeout(() => { child.kill('SIGKILL') }, timeout)
    if (input != null) child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Stands in for the daemon's POST /permission endpoint. `count` is the
 * assertion that matters: >0 means a prompt was raised on the user's device.
 */
async function startMockPermissionServer({ decision = 'allow' } = {}) {
  const received = { count: 0, body: null }
  const server = createServer((req, res) => {
    received.count++
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.body = body
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ decision }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_c, _e, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = () => true
  child.killed = false
  return child
}

// A non-file tool: `Bash` carries no PROTECTED_PATH_INPUT_FIELDS value, so the
// permission floor can never cover it (permission-floor.js:70-71). In `auto`
// it must short-circuit to allow; in `approve` it must route to the phone.
// The three tests that drive the real hook spawn it via `/bin/bash`, which
// Windows does not have. Guarded PER TEST rather than exempting the whole file
// in scripts/lib/windows-test-set.mjs — that manifest names per-test skips as
// the preferred fix and whole-file exemption as the blunt instrument, and the
// other eight tests here cover the JS side of the fix and run fine on Windows.
const SKIP_POSIX_SHELL = process.platform === 'win32'
  ? 'spawns hooks/permission-hook.sh via /bin/bash, which Windows has no analogue for'
  : false

const BASH_PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'git commit -m wip' },
  session_id: 'cli-sidecar-test',
})

describe('CliSession permission-mode sidecar (#7337)', () => {
  let tmp
  const created = []
  // `claude` is a DENYLIST-mode provider in buildSpawnEnv, so the whole parent
  // env is forwarded to the child. Running this suite from inside a chroxy
  // session therefore inherits the OUTER daemon's CHROXY_PERMISSION_MODE_FILE
  // and every assertion below about "the session did/didn't set it" would be
  // reading someone else's value. Scrub it for the suite; restore in afterEach
  // so a failing assertion can't leak the scrubbed state into the next file.
  let ambientModeFile

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cli-perm-sidecar-test-'))
    ambientModeFile = process.env.CHROXY_PERMISSION_MODE_FILE
    delete process.env.CHROXY_PERMISSION_MODE_FILE
  })

  afterEach(() => {
    if (ambientModeFile === undefined) delete process.env.CHROXY_PERMISSION_MODE_FILE
    else process.env.CHROXY_PERMISSION_MODE_FILE = ambientModeFile
    for (const s of created) {
      s._child = null
      try { const r = s.destroy(); if (r?.catch) r.catch(() => {}) } catch { /* ignore */ }
    }
    created.length = 0
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Real CliSession, real start() — only the subprocess spawn is stubbed, so
   * every step the entry point takes before spawning (hook registration,
   * sidecar creation, env construction) runs for real.
   */
  function startedSession(opts = {}) {
    const session = new CliSession({
      cwd: tmp,
      port: 9999,
      settingsPath: join(tmp, 'settings.json'),
      stateFilePath: join(tmp, 'state.json'),
      ...opts,
    })
    created.push(session)
    session._spawnPersistentProcess = () => {}
    session.start()
    session._child = createMockChild()
    session._processReady = true
    return session
  }

  // ---- wiring ----------------------------------------------------------

  it('start() creates a sidecar holding the initial mode and points the child env at it', () => {
    const session = startedSession()

    assert.ok(session._permissionModeFile,
      'CliSession must create a permission-mode sidecar when permissions are enabled')
    assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'approve',
      'sidecar must be seeded with the session\'s initial permission mode')

    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PERMISSION_MODE_FILE, session._permissionModeFile,
      'the child env must name the sidecar so permission-hook.sh reads it first')
    assert.equal(env.CHROXY_PERMISSION_MODE, 'approve',
      'the frozen env var stays as the fallback for a hook that cannot read the file')
  })

  it('setPermissionMode() rewrites the sidecar synchronously, before any respawn lands', () => {
    const session = startedSession()
    const sidecar = session._permissionModeFile
    // Freeze the env exactly as the LIVE child holds it — this is the env the
    // hook inherits, and it is not mutable from outside the process.
    const frozenEnv = session._buildChildEnv()

    assert.equal(session.setPermissionMode('auto'), true, 'mode change must be accepted')

    // The old child has NOT closed, so _killAndRespawn's start() has not run.
    assert.equal(session._respawning, true,
      'positive control: the respawn is still in flight, so no new env has been built')
    assert.equal(readFileSync(sidecar, 'utf8'), 'auto',
      'the sidecar must already hold the new mode — the live child reads it on the next tool call')
    assert.equal(frozenEnv.CHROXY_PERMISSION_MODE, 'approve',
      'positive control: the spawn-frozen env var is still stale, which is exactly why the sidecar exists')
  })

  it('a session without permissions enabled gets no sidecar and no env var', () => {
    const session = new CliSession({ cwd: tmp, stateFilePath: join(tmp, 'state.json') })
    created.push(session)
    session._spawnPersistentProcess = () => {}
    session.start()

    assert.equal(session._permissionModeFile, null, 'no port -> no sidecar')
    assert.equal(session._buildChildEnv().CHROXY_PERMISSION_MODE_FILE, undefined,
      'no sidecar -> the env var must be absent, not an empty string')
    assert.equal(session.setPermissionMode('auto'), true,
      'a mode change must still succeed without a sidecar')
  })

  it('destroy() removes the sidecar and clears the reference', () => {
    const session = startedSession()
    const sidecar = session._permissionModeFile
    assert.ok(existsSync(sidecar), 'positive control: sidecar exists before destroy')

    session._child = null
    session.destroy()

    assert.equal(session._permissionModeFile, null, 'reference cleared')
    assert.equal(existsSync(sidecar), false, 'sidecar removed from /tmp')
  })

  // ---- outcome, through the real hook ----------------------------------

  it('after switching to auto, the real hook allows Bash with NO prompt — using the child\'s frozen env', { skip: SKIP_POSIX_SHELL }, async () => {
    const mock = await startMockPermissionServer()
    try {
      const session = startedSession({ port: mock.port })
      // The env the running child was spawned with. Nothing can mutate it.
      const frozenEnv = session._buildChildEnv()

      session.setPermissionMode('auto')

      const { status, stdout } = await runHook({
        input: BASH_PAYLOAD,
        env: { ...process.env, ...frozenEnv },
      })

      assert.equal(status, 0)
      const out = JSON.parse(stdout)
      assert.equal(out.hookSpecificOutput.permissionDecision, 'allow',
        'auto mode must auto-allow Bash; a prompt here is #7337')
      assert.equal(mock.received.count, 0,
        'no POST /permission — the whole point is that the prompt is never raised')
    } finally {
      await mock.close()
    }
  })

  it('POSITIVE CONTROL: in approve mode the same path still raises the prompt', { skip: SKIP_POSIX_SHELL }, async () => {
    const mock = await startMockPermissionServer({ decision: 'allow' })
    try {
      const session = startedSession({ port: mock.port })
      const frozenEnv = session._buildChildEnv()

      // No mode change: the session stays in `approve`.
      assert.equal(session.permissionMode, 'approve')

      const { status, stdout } = await runHook({
        input: BASH_PAYLOAD,
        env: { ...process.env, ...frozenEnv },
      })

      assert.equal(status, 0)
      assert.equal(mock.received.count, 1,
        'approve mode MUST still route to the phone — a fix that allows unconditionally fails here')
      assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'allow',
        'the decision comes from the mocked user answer, not from a bypass')
    } finally {
      await mock.close()
    }
  })

  // ---- crash cleanup ---------------------------------------------------

  /**
   * destroy() removes a session's own sidecar dir, but a SIGKILL leaks it, so
   * a long-lived host accumulates one dir per crashed session. Same leak
   * claude-tui's sink dirs had at #5323 — and, since #7337, the same reaper.
   */
  describe('sweepStaleSidecarDirs', () => {
    function makeSidecarDir(name, pid) {
      const dir = join(CliSession.PERMISSION_MODE_SIDECAR_BASE, `s-${name}`)
      mkdirSync(dir, { recursive: true })
      if (pid !== undefined) writeFileSync(join(dir, 'owner.pid'), String(pid))
      writeFileSync(join(dir, 'permission-mode'), 'approve')
      return dir
    }

    it('reaps a dir whose owner pid is dead and keeps one whose owner is alive', () => {
      // A pid that is definitely dead: run a process to completion and reuse its
      // pid. A magic large number would be a guess — Windows pids are DWORDs, so
      // there is no portable "above pid_max" value, and a guess that happened to
      // be live would keep the dir and pass this test for the WRONG reason.
      const reaped = spawnSync(process.execPath, ['-e', ''])
      assert.ok(reaped.pid > 0, 'positive control: the throwaway process must have started')
      const orphan = makeSidecarDir(`test-orphan-${process.pid}`, reaped.pid)
      const live = makeSidecarDir(`test-live-${process.pid}`, process.pid)
      try {
        assert.ok(existsSync(orphan) && existsSync(live), 'positive control: both dirs exist before the sweep')

        CliSession.sweepStaleSidecarDirs({ info() {}, warn() {} })

        assert.equal(existsSync(orphan), false, 'a dead owner\'s dir must be reaped')
        assert.equal(existsSync(live), true,
          'a LIVE owner\'s dir must survive — including the dir this very daemon is about to use')
      } finally {
        rmSync(orphan, { recursive: true, force: true })
        rmSync(live, { recursive: true, force: true })
      }
    })
  })

  /**
   * The pidfile is what makes a LIVE session's dir survive the reaper. Without
   * it the dir falls into the pidfile-less branch, which reaps anything older
   * than the grace window — so a session running for more than a minute would
   * have its sidecar deleted out from under it on the next daemon boot, and
   * `permission-hook.sh` would silently fall back to the spawn-frozen env var.
   * That is #7337 re-created by its own cleanup, so it gets its own test:
   * asserting the file merely EXISTS would not prove the reaper honours it.
   */
  it('a running session\'s sidecar dir survives the sweep even once it is older than the grace window', () => {
    const session = startedSession()
    const dir = join(session._permissionModeFile, '..')

    assert.equal(readFileSync(join(dir, 'owner.pid'), 'utf8'), String(process.pid),
      'the dir must be stamped with THIS process as its owner')

    // Backdate well past the pidfile-less grace so the only thing that can
    // save the dir is the liveness probe on that pidfile.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    utimesSync(dir, longAgo, longAgo)

    CliSession.sweepStaleSidecarDirs({ info() {}, warn() {} })

    assert.equal(existsSync(session._permissionModeFile), true,
      'the live session\'s sidecar must survive — reaping it would silently drop the session back to the frozen env var')
  })

  /**
   * A reaper nobody calls is dead code that reads as cleanup. Both boot calls
   * are pinned here, ANCHORED to the `import(` expression that performs them so
   * the assertion cannot be satisfied by the explanatory comment beside it.
   */
  it('server-cli boot sweeps BOTH providers\' stale per-session dirs', () => {
    const src = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf8')

    for (const [module, method] of [
      ['./claude-tui-session.js', 'sweepStaleSinkDirs'],
      ['./cli-session.js', 'sweepStaleSidecarDirs'],
    ]) {
      const start = src.indexOf(`import('${module}')`)
      assert.ok(start !== -1, `positive control: server-cli must lazily import ${module} at boot`)
      // The `.then(...)` that consumes the import, and nothing after it.
      const slice = src.slice(start, src.indexOf('.catch(', start))
      assert.ok(slice.length > 0, `positive control: the ${module} import slice must be non-empty`)
      assert.ok(slice.includes(`${method}(log)`),
        `boot must actually call ${method}(log) on the ${module} import — otherwise the reaper never runs and crashed sessions leak a dir each`)
    }
  })

  // ---- blast radius: DockerSession extends CliSession -----------------

  /**
   * `DockerSession` inherits `_buildChildEnv()` — and therefore the new
   * `CHROXY_PERMISSION_MODE_FILE` — but forwards into the container through
   * its own `FORWARDED_ENV_KEYS` allowlist. The allowlist is what stopped the
   * new key from silently reaching a container where the host tmp path does
   * not exist; this pins that it STAYS out until a bind mount makes the
   * sidecar readable in there.
   *
   * Source-level and ANCHORED: docker-session.test.js drives a hand-written
   * MIRROR of `_spawnPersistentProcess`, so an argv assertion over that mirror
   * would keep passing with the real array changed. Slice the real array out
   * of the real module instead, and assert only within the slice — a file-wide
   * grep would be satisfiable by the explanatory comment sitting right below
   * it, which names the key.
   */
  it('DockerSession does NOT forward CHROXY_PERMISSION_MODE_FILE into the container', () => {
    const src = readFileSync(join(__dirname, '../src/docker-session.js'), 'utf8')
    const start = src.indexOf('const FORWARDED_ENV_KEYS = [')
    assert.ok(start !== -1, 'positive control: the FORWARDED_ENV_KEYS array must still exist')
    const end = src.indexOf(']', start)
    assert.ok(end > start, 'positive control: the array literal must be closed')
    const arrayLiteral = src.slice(start, end + 1)

    assert.match(arrayLiteral, /'CHROXY_PERMISSION_MODE'/,
      'positive control: the slice really is the env allowlist, and it does carry the frozen mode var')
    assert.doesNotMatch(arrayLiteral, /CHROXY_PERMISSION_MODE_FILE/,
      'the sidecar path is a HOST path; `docker exec` cannot mount it, so forwarding the key would name a path that does not exist in the container. Add the bind mount in _startContainer() before adding the key.')
  })

  it('POSITIVE CONTROL: switching back from auto to approve re-raises the prompt', { skip: SKIP_POSIX_SHELL }, async () => {
    const mock = await startMockPermissionServer({ decision: 'deny' })
    try {
      const session = startedSession({ port: mock.port })
      const frozenEnv = session._buildChildEnv()

      session.setPermissionMode('auto')
      session._isBusy = false
      assert.equal(session.setPermissionMode('approve'), true, 'switch back must be accepted')

      const { status, stdout } = await runHook({
        input: BASH_PAYLOAD,
        env: { ...process.env, ...frozenEnv },
      })

      assert.equal(status, 0)
      assert.equal(mock.received.count, 1,
        'the sidecar must be able to RE-TIGHTEN the mode, not just loosen it')
      assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny',
        'the user\'s deny must reach claude')
    } finally {
      await mock.close()
    }
  })
})
