import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync, statSync, symlinkSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { CliSession } from '../src/cli-session.js'
import { ensureOwnedBaseDir } from '../src/utils/stale-session-dirs.js'
import { writePermissionModeSidecarAtomic } from '../src/utils/permission-mode-sidecar.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

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
  //
  // The hook env is built from `...process.env`, so EVERY CHROXY_ var the hook
  // reads must be scrubbed — not just the one under test. CHROXY_HOST in
  // particular redirects the hook's curl target: with it set (as it is inside a
  // container, or when this suite runs inside a chroxy session) both `approve`
  // positive controls fail while the auto test stays green, i.e. exactly the
  // shape where "fix the flake by skipping it" silently unguards the auto path.
  const AMBIENT_KEYS = [
    'CHROXY_PERMISSION_MODE_FILE',
    'CHROXY_PERMISSION_MODE',
    'CHROXY_HOST',
    'CHROXY_HOOK_HOST',
    'CHROXY_HOOK_SECRET',
    'CHROXY_PORT',
    'CHROXY_SINK_DIR',
    'CHROXY_HOOK_UNREACHABLE_DECISION',
  ]
  let ambient

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cli-perm-sidecar-test-'))
    ambient = {}
    for (const k of AMBIENT_KEYS) {
      ambient[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    // Restored FIRST so an assertion throwing mid-test cannot leak the scrub
    // into the next file.
    for (const k of AMBIENT_KEYS) {
      if (ambient?.[k] === undefined) delete process.env[k]
      else process.env[k] = ambient[k]
    }
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
    // Capture the env AT SPAWN TIME rather than calling _buildChildEnv() again
    // afterwards. `_ensurePermissionModeSidecar()` must run BEFORE the spawn —
    // _spawnPersistentProcess reads _buildChildEnv() inline — and a post-hoc
    // call cannot see that ordering: moving the sidecar creation to AFTER the
    // spawn leaves the real child with no CHROXY_PERMISSION_MODE_FILE at all
    // (i.e. #7337 reproduced) while every assertion still passes.
    session.spawnedEnvs = []
    session._spawnPersistentProcess = () => {
      session.spawnedEnvs.push(session._buildChildEnv())
    }
    session.start()
    session._child = createMockChild()
    session._processReady = true
    return session
  }

  /** The env of the most recent spawn — what the live child actually holds. */
  const lastSpawnEnv = (session) => session.spawnedEnvs[session.spawnedEnvs.length - 1]

  // ---- wiring ----------------------------------------------------------

  it('start() seeds the sidecar with the session\'s ACTUAL mode and spawns the child pointing at it', () => {
    // NOT the default: 'approve' is BaseSession's default, so seeding with a
    // hardcoded 'approve' would satisfy this assertion while breaking every
    // restored session — `permissionMode` is a real constructor opt, so a
    // session restored in `acceptEdits` would seed `approve` and prompt on
    // every tool call until the user toggled the mode.
    const session = startedSession({ permissionMode: 'acceptEdits' })

    assert.ok(session._permissionModeFile,
      'CliSession must create a permission-mode sidecar when permissions are enabled')
    assert.equal(readFileSync(session._permissionModeFile, 'utf8'), 'acceptEdits',
      'sidecar must be seeded with the session\'s ACTUAL initial mode, not a hardcoded default')

    const env = lastSpawnEnv(session)
    assert.ok(env, 'positive control: the spawn must have happened')
    assert.equal(env.CHROXY_PERMISSION_MODE_FILE, session._permissionModeFile,
      'the child must be SPAWNED with the sidecar path — built before the spawn, not after')
    assert.equal(env.CHROXY_PERMISSION_MODE, 'acceptEdits',
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

  it('a session without permissions enabled gets no sidecar, and an EMPTY sidecar env var', () => {
    const session = new CliSession({ cwd: tmp, stateFilePath: join(tmp, 'state.json') })
    created.push(session)
    session._spawnPersistentProcess = () => {}
    session.start()

    assert.equal(session._permissionModeFile, null, 'no port -> no sidecar')
    assert.equal(session._buildChildEnv().CHROXY_PERMISSION_MODE_FILE, '',
      'no sidecar -> the key must be SET-BUT-EMPTY, not omitted. buildSpawnEnv(\'claude\') is denylist mode, so omitting it lets an ambient CHROXY_PERMISSION_MODE_FILE inherited from an outer chroxy session decide this session\'s permissions')
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
      const frozenEnv = lastSpawnEnv(session)

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
      const frozenEnv = lastSpawnEnv(session)

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

  // ---- the sidecar outranks the env var, so it must never go stale --------

  /**
   * THE fail-open this whole mechanism can produce. The hook prefers the file
   * over CHROXY_PERMISSION_MODE, so a sidecar holding a STALE, more-permissive
   * mode beats the correct value in the freshly-spawned child's env — silently,
   * for the rest of the session, while the daemon/state file/UI all disagree.
   *
   * The original code early-returned from `_ensurePermissionModeSidecar()` on a
   * non-null path, so nothing ever re-validated the contents, and the comment
   * claimed "the respawn below is still the eventual repair". It was not.
   */
  it('start() RE-SEEDS an existing sidecar, so a respawn repairs stale contents', () => {
    const session = startedSession({ permissionMode: 'auto' })
    const sidecar = session._permissionModeFile

    // Simulate the mid-session write having failed: the session's mode moved on
    // but the file still holds the old, more permissive value.
    session.permissionMode = 'approve'
    writeFileSync(sidecar, 'auto')

    session.start() // the respawn

    assert.equal(session._permissionModeFile, sidecar,
      'the path must stay stable across a respawn — a still-draining old child holds it in its env')
    assert.equal(readFileSync(sidecar, 'utf8'), 'approve',
      'contents must be re-asserted on every start(); a stale sidecar outranks the correct env var')
  })

  it('a failed mode-change write REMOVES the sidecar rather than leaving it stale', () => {
    const session = startedSession({ permissionMode: 'auto' })
    const sidecar = session._permissionModeFile
    const dir = join(sidecar, '..')

    // Make the atomic write fail the way a full/read-only disk would, without
    // touching the rest of the filesystem: drop the directory out from under it.
    rmSync(dir, { recursive: true, force: true })

    assert.equal(session.setPermissionMode('approve'), true, 'the tighten must still be accepted')
    assert.equal(session._permissionModeFile, null,
      'the sidecar reference must be dropped so the hook falls back to the env var, not to a stale file')
  })

  it('_ensurePermissionModeSidecar is idempotent on the path across repeated start()s', () => {
    const session = startedSession()
    const first = session._permissionModeFile
    const firstDir = session._permissionModeDir

    session.start()
    session.start()

    assert.equal(session._permissionModeFile, first, 'the sidecar path must not move on respawn')
    assert.equal(session._permissionModeDir, firstDir,
      'a new dir per respawn would leak every previous one — owner.pid names this LIVE daemon, so the sweep keeps them all')
    assert.equal(session.spawnedEnvs.length, 3, 'positive control: three spawns really happened')
    for (const env of session.spawnedEnvs) {
      assert.equal(env.CHROXY_PERMISSION_MODE_FILE, first, 'every spawn must name the same sidecar')
    }
  })

  it('destroy() removes the sidecar only AFTER the child has been killed', () => {
    const session = startedSession({ permissionMode: 'auto' })
    const sidecar = session._permissionModeFile

    // The child stays alive for up to the 3s force-kill grace and can fire a
    // PreToolUse hook in that window. If the sidecar is gone by then the hook
    // falls back to the spawn-frozen CHROXY_PERMISSION_MODE — which on a
    // session tightened since spawn (spawned `auto`, switched to `approve`) is
    // MORE permissive than the user's current setting.
    let sidecarAliveAtKill = null
    const child = session._child
    const realEnd = child.stdin.end.bind(child.stdin)
    child.stdin.end = (...args) => { sidecarAliveAtKill = existsSync(sidecar); return realEnd(...args) }

    session.destroy()

    assert.equal(sidecarAliveAtKill, true,
      'the sidecar must still be readable while the child is being killed')
    assert.equal(existsSync(sidecar), false, 'and removed once destroy() returns')
  })

  it('the sidecar write goes through the restricted-write helper (owner-only, not a plain write)', { skip: process.platform === 'win32' }, () => {
    const dir = join(tmp, 'atomic')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'permission-mode')

    writePermissionModeSidecarAtomic(path, 'auto')

    assert.equal(readFileSync(path, 'utf8'), 'auto')
    assert.equal(statSync(path).mode & 0o777, 0o600,
      'this file decides whether a tool call is prompted — a plain writeFileSync would leave it 0644')
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('.tmp-')), [],
      'no intermediate temp file may survive the rename',
    )
  })

  // ---- the base dir is attacker-reachable on a shared /tmp ----------------

  describe('ensureOwnedBaseDir', () => {
    it('creates the base owner-only and re-asserts the mode on an existing dir', { skip: process.platform === 'win32' }, () => {
      const base = join(tmp, 'base-mode')
      ensureOwnedBaseDir(base)
      assert.equal(statSync(base).mode & 0o777, 0o700, 'a fresh base must be 0700, not umask-dependent')

      chmodSync(base, 0o777)
      ensureOwnedBaseDir(base)
      assert.equal(statSync(base).mode & 0o777, 0o700,
        'an ADOPTED base keeps whatever mode it had — re-assert rather than trust the create')
    })

    // Gated on the PROBED capability, not on `process.platform` (#7273): the
    // same Windows box answers differently for an interactive developer account
    // (has SeCreateSymbolicLinkPrivilege) and for the CI service account (does
    // not) — which is precisely how the platform-inferred version of this guard
    // passes locally and fails in CI. Only the fixture is unbuildable there; the
    // symlink branch of ensureOwnedBaseDir is not platform-gated and still runs.
    it('refuses a base that is a symlink', { skip: SKIP_NO_SYMLINK }, () => {
      const real = join(tmp, 'attacker-owned')
      const link = join(tmp, 'squatted-base')
      mkdirSync(real, { recursive: true })
      symlinkSync(real, link)
      // Positive control: plain mkdirSync would silently accept this and write
      // straight through the link — that is the whole reason for the check.
      mkdirSync(link, { recursive: true })
      assert.equal(existsSync(link), true)

      assert.throws(() => ensureOwnedBaseDir(link), /symlink/i,
        'a symlinked base lets another local user substitute a permission-mode file that decides every tool call')
    })

    it('a session whose base is unusable degrades to env-var-only instead of failing start()', () => {
      const badBase = join(tmp, 'not-a-dir')
      writeFileSync(badBase, 'i am a file')
      const original = Object.getOwnPropertyDescriptor(CliSession, 'PERMISSION_MODE_SIDECAR_BASE')
      Object.defineProperty(CliSession, 'PERMISSION_MODE_SIDECAR_BASE', { get: () => badBase, configurable: true })
      try {
        const session = startedSession()
        assert.equal(session._permissionModeFile, null, 'no sidecar when the base is unusable')
        assert.equal(lastSpawnEnv(session).CHROXY_PERMISSION_MODE_FILE, '',
          'and the key must still be set-but-empty so no ambient path leaks in')
        assert.equal(lastSpawnEnv(session).CHROXY_PERMISSION_MODE, 'approve',
          'the env var carries the mode instead — degraded, not broken')
      } finally {
        Object.defineProperty(CliSession, 'PERMISSION_MODE_SIDECAR_BASE', original)
      }
    })
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

    /**
     * EPERM from `process.kill(pid, 0)` means the process EXISTS but belongs to
     * another user — so it is ALIVE and its dir must be kept. Reading EPERM as
     * "dead" would make the reaper delete a live session's dir on any host where
     * two users run chroxy. This branch had no coverage anywhere in the repo,
     * which is how a mutation of exactly this line survived a 923-test run.
     */
    it('treats EPERM (another user\'s LIVE process) as alive, not dead', () => {
      const dir = makeSidecarDir(`test-eperm-${process.pid}`, 1)
      const realKill = process.kill
      process.kill = (pid, sig) => {
        if (sig === 0 && pid === 1) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
        return realKill.call(process, pid, sig)
      }
      try {
        CliSession.sweepStaleSidecarDirs({ info() {}, warn() {} })
        assert.equal(existsSync(dir), true,
          'EPERM means the process exists but is not ours — keeping the dir is the only safe read')
      } finally {
        process.kill = realKill
        rmSync(dir, { recursive: true, force: true })
      }
    })

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
   * A reaper nobody calls is dead code that reads as cleanup.
   *
   * #7374 — this used to grep the whole boot block out of `server-cli.js`, and
   * claimed the anchoring meant it "cannot be satisfied by the explanatory
   * comment beside it". That claim was too strong: mutation testing found two
   * bypasses that kept it green — wrapping the block in
   * `if (process.env.__NEVER_SET__)`, and replacing the call with
   * `.then(({CliSession}) => void CliSession)` while leaving the expected
   * string in a comment INSIDE the anchored window.
   *
   * The block now lives in `sweep-stale-provider-dirs.js` and its behaviour is
   * covered by `tests/sweep-stale-provider-dirs.test.js`, which RUNS it — all
   * three of those mutants die there.
   *
   * What is left here is only the CALL SITE, and it is still source-level:
   * short of booting the daemon, nothing distinguishes this call from the same
   * characters behind a false condition. That residual is recorded in
   * `docs/false-safety-guards.md`; it is deliberately not talked away here.
   */
  it('server-cli boot calls the provider stale-dir sweep', () => {
    const src = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf8')

    assert.ok(
      /^import \{ sweepStaleProviderDirs \} from '\.\/sweep-stale-provider-dirs\.js'/m.test(src),
      'positive control: server-cli must import the sweep',
    )
    // Line-anchored, so a mention inside a comment or docstring does not count.
    assert.ok(
      /^\s*sweepStaleProviderDirs\(log\)/m.test(src),
      'boot must actually call sweepStaleProviderDirs(log) — otherwise the reapers never run and crashed sessions leak a dir each',
    )
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
   * #7374 — this is a source-level grep of the array literal, and it has a
   * KNOWN bypass: pushing `--env CHROXY_PERMISSION_MODE_FILE=…` into
   * `dockerArgs` outside the allowlist loop keeps it green, and two explicit
   * single-key pushes already sit below that loop. It is kept because it names
   * the naive fix precisely (adding the key to the array goes red here with a
   * pointed message), but it is NO LONGER the guard.
   *
   * The real guard is now behavioural:
   * `docker-session.test.js` → 'DockerSession._spawnPersistentProcess — real
   * argv (#7374)' drives the real method and captures argv at the
   * `_spawnDocker` seam, so every route into `dockerArgs` is covered. Verified:
   * the outside-the-loop mutant fails 2 tests there and 0 here.
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
      // Spawned in `auto`, so the FROZEN env var says `auto` too. Only the
      // sidecar can carry the tighten — if the sidecar channel were deleted
      // entirely this test would auto-allow and fail. Starting from the default
      // `approve` made it a duplicate of the previous test: the env var alone
      // satisfied every assertion, so it passed on origin/main (where no
      // sidecar exists at all) and with the channel mutated out.
      const session = startedSession({ port: mock.port, permissionMode: 'auto' })
      const frozenEnv = lastSpawnEnv(session)
      assert.equal(frozenEnv.CHROXY_PERMISSION_MODE, 'auto',
        'positive control: the frozen env var must say auto, so only the sidecar can re-tighten')

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
