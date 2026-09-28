import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebTaskManager, WebTaskUnavailableError, buildRemoteTaskArgs } from '../src/web-task-manager.js'
import { SessionManager } from '../src/session-manager.js'
import { waitFor } from './test-helpers.js'

// ── #8039 — verified-binary gate fixtures ──────────────────────────────────
//
// Every spawn site in web-task-manager.js (detectFeatures, _spawnRemoteTask,
// teleportTask) now resolves its binary through SessionManager's real
// verifyOneShotExecutable(ProviderClass) gate (#8030, generalized #8036)
// instead of a bare `execFile('claude', ...)`. These tests exercise that
// REAL gate — same conventions (fakeProvenanceLedger, SPAWN_GATE_*_HASH) as
// session-manager-preflight.test.js and ws-history.test.js's own #8036 suite
// — rather than a hand-rolled stand-in, so a regression in the gate's own
// wiring (not just this file's call sites) would also be caught here.

let _gateTmpDir
function tmpStateFile() {
  if (!_gateTmpDir) _gateTmpDir = mkdtempSync(join(tmpdir(), 'web-task-gate-'))
  return join(_gateTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_gateTmpDir) rmSync(_gateTmpDir, { recursive: true, force: true })
})

// The REAL hash of the running Node binary, and a hash that can never match
// it — same convention as session-manager-preflight.test.js /
// ws-history.test.js's #8036 suite.
const SPAWN_GATE_REAL_HASH = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const SPAWN_GATE_WRONG_HASH = 'f'.repeat(64)

function fakeProvenanceLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve: (p, sha256) => { records.set(p, { sha256 }); return true },
    _records: records,
  }
}

// A `CliSession`-shaped fixture provider whose "binary" is the running Node
// executable, so preflight's existence/quarantine checks pass on any test
// machine with no real `claude` CLI installed. `resolvedOverride` lets a
// test prove the manager re-resolves fresh each call rather than caching a
// stale path.
class FixtureClaudeProvider {
  static resolvedOverride = null
  static get resolvedBinary() { return FixtureClaudeProvider.resolvedOverride || process.execPath }
  static get preflight() {
    return { label: 'Fixture Claude', binary: { name: 'claude', candidates: [] } }
  }
}

/**
 * Build a WebTaskManager wired to a REAL SessionManager + the fixture
 * provider above. Defaults to gates OFF (`binaryProvenanceMode` unset, same
 * default production runs with when the operator hasn't opted in) so the
 * pre-existing --help-parsing tests below exercise the real gate end to end
 * without needing a provenance ledger at all — matching #8036's "gates OFF"
 * convention. Pass `binaryProvenanceMode`/`binaryProvenanceLedger` to
 * exercise `block` mode.
 */
function makeManager({ sessionManagerOpts = {}, providerClass = FixtureClaudeProvider, cwd } = {}) {
  const sessionManager = new SessionManager({
    maxSessions: 5,
    stateFilePath: tmpStateFile(),
    defaultCwd: tmpdir(),
    ...sessionManagerOpts,
  })
  return new WebTaskManager({ cwd, sessionManager, providerClass })
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * A REAL, tiny executable script that writes a marker file the instant it
 * runs and exits 0 — same convention as session-manager-preflight.test.js's
 * `makeGateShim()`. Used (rather than a mocked `execFile`) so a spawn is
 * observed by its actual, real-subprocess side effect: `_spawnRemoteTask`
 * and `teleportTask` call the module-level `execFile`/`execFileAsync`
 * directly (no injectable seam — keeping them statically visible to
 * `scripts/lint-argv-sinks.mjs`, which traces the real `execFile` import),
 * so "was the VERIFIED path actually spawned" is proven by pointing
 * `FixtureClaudeProvider.resolvedOverride` at this script and waiting for
 * its marker, exactly as the existing #8030/#8035 gate suites already do
 * for other providers.
 */
function makeGateShim() {
  const dir = mkdtempSync(join(tmpdir(), 'web-task-gate-shim-'))
  const shimPath = join(dir, 'gate-shim.mjs')
  const markerPath = join(dir, 'marker.txt')
  const body = [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
    `console.log('shim-ok')`,
    'process.exit(0)',
  ].join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
  return { dir, shimPath, markerPath }
}

// #8039 review (Copilot) — a `.mjs` shebang shim (`makeGateShim()` above) is
// not directly executable via the REAL `execFile` on Windows: there is no
// shebang interpretation the way POSIX `execve` provides, so `Server Windows
// Tests` failed every case below that spawns one. Every case that instead
// proves a REFUSAL (a block-mode ledger mismatch, no `sessionManager`
// configured) never reaches `execFile` at all — those keep running,
// unmodified, on every platform, including Windows.
const WINDOWS_SHIM_EXEC_SKIP = process.platform === 'win32'
  ? 'a .mjs shebang shim is not directly executable via execFile on Windows; the refusal/no-spawn cases still run there'
  : false

describe('WebTaskManager', () => {
  let manager

  afterEach(() => {
    if (manager) {
      manager.destroy()
      manager = null
    }
  })

  describe('feature detection', () => {
    it('defaults to unavailable before detection', () => {
      manager = new WebTaskManager()
      assert.equal(manager.isAvailable, false)
      assert.equal(manager.teleportAvailable, false)
      assert.equal(manager.detected, false)
    })

    it('detects features as unavailable when claude CLI lacks --remote', async () => {
      // Hermetic: inject a --help output without the flags rather than shelling
      // out to the real `claude` binary (whose flags vary by version/host).
      manager = makeManager()
      await manager.detectFeatures({ exec: async () => 'Usage: claude [options]\n  --help\n  --print' })
      assert.equal(manager.isAvailable, false)
      assert.equal(manager.teleportAvailable, false)
      assert.equal(manager.detected, true)
    })

    it('detects --remote and --teleport when present in --help', async () => {
      manager = makeManager()
      const features = await manager.detectFeatures({ exec: async () => 'Usage:\n  --remote\n  --teleport\n' })
      assert.equal(manager.isAvailable, true)
      assert.equal(manager.teleportAvailable, true)
      assert.deepEqual(features, { remote: true, teleport: true })
    })

    // ── #7291: the availability gate is a substring match ─────────────────
    //
    // The test above ('...lacks --remote') feeds a help text containing no
    // '--remote' substring AT ALL, so a naive `.includes('--remote')` already
    // answers it correctly. It passes before and after this fix and proves
    // nothing — the textbook false-safety test shape from
    // docs/false-safety-guards.md.
    //
    // The control that actually bites is a help text carrying a LONGER flag
    // that merely starts the same way. This is the real installed CLI's shape:
    // it advertises --remote-control and --remote-control-session-name-prefix
    // and has no --remote at all, so the old gate reported the flag available
    // on a CLI that cannot accept it, opening the argv in _spawnRemoteTask.
    it('#7291: --remote-control in --help must NOT be read as --remote', async () => {
      manager = makeManager()
      // Verbatim shape of the installed Claude Code CLI's help text.
      const help = [
        'Usage: claude [options] [command] [prompt]',
        '  --remote-control                      Enable remote control',
        '  --remote-control-session-name-prefix <prefix>',
        '  --teleport                            Teleport a task',
      ].join('\n')

      const features = await manager.detectFeatures({ exec: async () => help })

      assert.equal(features.remote, false,
        '--remote-control must not satisfy a --remote probe')
      assert.equal(manager.isAvailable, false)
      // POSITIVE CONTROL in the same fixture: --teleport IS genuinely present,
      // so a guard that simply answered "false" to everything would fail here.
      assert.equal(features.teleport, true, '--teleport is really advertised')
    })

    it('#7291: an exactly-matching flag is still detected (positive control)', async () => {
      manager = makeManager()
      // --remote at end-of-line, and --teleport followed by whitespace: both
      // are genuine advertisements and must still register.
      const features = await manager.detectFeatures({
        exec: async () => 'Usage:\n  --remote\n  --teleport <id>   Teleport\n',
      })
      assert.deepEqual(features, { remote: true, teleport: true })
    })

    it('treats a failed --help invocation as unavailable', async () => {
      manager = makeManager()
      await manager.detectFeatures({ exec: async () => { throw new Error('claude: command not found') } })
      assert.equal(manager.isAvailable, false)
      assert.equal(manager.teleportAvailable, false)
      assert.equal(manager.detected, true)
    })

    it('returns feature status object', async () => {
      manager = makeManager()
      await manager.detectFeatures({ exec: async () => 'Usage: claude [options]\n' })
      const status = manager.getFeatureStatus()
      assert.equal(typeof status.available, 'boolean')
      assert.equal(typeof status.remote, 'boolean')
      assert.equal(typeof status.teleport, 'boolean')
      assert.equal(status.available, status.remote)
    })
  })

  describe('task lifecycle', () => {
    it('throws WebTaskUnavailableError when feature not available', () => {
      manager = new WebTaskManager()
      assert.throws(
        () => manager.launchTask('build a website'),
        (err) => {
          assert.equal(err instanceof WebTaskUnavailableError, true)
          assert.equal(err.code, 'WEB_TASK_UNAVAILABLE')
          return true
        }
      )
    })

    it('throws on empty prompt', () => {
      manager = new WebTaskManager()
      // Force available for this test
      manager._remoteAvailable = true
      assert.throws(
        () => manager.launchTask(''),
        /Task prompt is required/
      )
      assert.throws(
        () => manager.launchTask(null),
        /Task prompt is required/
      )
    })

    it('launches task when feature is available', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {} // no-op — don't spawn real processes

      const events = []
      manager.on('task_created', (task) => events.push(task))

      const { taskId, task } = manager.launchTask('build a landing page')
      assert.ok(taskId)
      assert.equal(task.prompt, 'build a landing page')
      assert.equal(task.status, 'pending')
      assert.ok(task.createdAt > 0)
      assert.equal(task.result, null)
      assert.equal(task.error, null)

      // Should have emitted task_created
      assert.equal(events.length, 1)
      assert.equal(events[0].taskId, taskId)
    })

    it('lists all tasks', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {} // no-op

      manager.launchTask('task 1')
      manager.launchTask('task 2')

      const tasks = manager.listTasks()
      assert.equal(tasks.length, 2)
      assert.equal(tasks[0].prompt, 'task 1')
      assert.equal(tasks[1].prompt, 'task 2')
    })

    it('gets a single task by ID', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {} // no-op

      const { taskId } = manager.launchTask('specific task')
      const task = manager.getTask(taskId)
      assert.equal(task.prompt, 'specific task')

      const missing = manager.getTask('nonexistent')
      assert.equal(missing, null)
    })

    it('returns copies of tasks (not references)', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {} // no-op

      const { taskId } = manager.launchTask('test')
      const task1 = manager.getTask(taskId)
      const task2 = manager.getTask(taskId)
      assert.notEqual(task1, task2)
      assert.deepEqual(task1, task2)
    })
  })

  describe('teleport', () => {
    it('throws when teleport not available', async () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {} // no-op

      const { taskId } = manager.launchTask('test')
      await assert.rejects(
        () => manager.teleportTask(taskId),
        /--teleport flag is not available/
      )
    })

    it('throws for unknown task ID', async () => {
      manager = new WebTaskManager()
      manager._teleportAvailable = true

      await assert.rejects(
        () => manager.teleportTask('nonexistent'),
        /Task not found/
      )
    })
  })

  describe('destroy', () => {
    it('clears tasks and listeners', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {} // no-op
      manager.launchTask('test')
      manager.on('task_created', () => {})

      assert.equal(manager.listTasks().length, 1)
      assert.equal(manager.listenerCount('task_created'), 1)

      manager.destroy()
      assert.equal(manager.listTasks().length, 0)
      assert.equal(manager.listenerCount('task_created'), 0)
      manager = null // prevent double destroy in afterEach
    })
  })

  describe('task ID format', () => {
    it('uses full UUID for task IDs', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('test')
      // Full UUID: 8-4-4-4-12 = 36 chars
      assert.equal(taskId.length, 36)
      assert.match(taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })
  })

  describe('eviction', () => {
    it('evicts oldest completed tasks when map exceeds MAX_TASKS', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      // Fill to 101 tasks, marking first 50 as completed
      for (let i = 0; i < 101; i++) {
        const { taskId } = manager.launchTask(`task ${i}`)
        if (i < 50) {
          const task = manager._tasks.get(taskId)
          task.status = 'completed'
          task.updatedAt = i // oldest first
        }
      }

      // Eviction should have trimmed to 100
      assert.ok(manager._tasks.size <= 100)
    })

    it('does not evict pending or running tasks', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      // Create 101 tasks — all pending (no completed/failed to evict)
      for (let i = 0; i < 101; i++) {
        manager.launchTask(`task ${i}`)
      }

      // Can't evict pending tasks, so map stays at 101
      assert.equal(manager._tasks.size, 101)
    })
  })

  describe('polling', () => {
    it('fails running tasks after max poll count (timeout backstop)', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('test')
      const task = manager._tasks.get(taskId)
      task.status = 'running'

      const errors = []
      manager.on('task_error', (e) => errors.push(e))

      // Simulate exceeding max poll count
      manager._pollCount = 59
      manager._pollTaskStatus()

      assert.equal(task.status, 'failed')
      assert.ok(task.error.includes('timed out'))
      assert.equal(errors.length, 1)
    })

    it('transitions a healthy task running→completed instead of force-failing (#5327)', async () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('build a site')
      const task = manager._tasks.get(taskId)
      task.status = 'running'

      // Inject a status check that reports completion with a result.
      manager._checkRemoteStatus = async () => ({ status: 'completed', result: 'https://preview.example' })

      const updates = []
      manager.on('task_updated', (t) => updates.push(t))

      await manager._pollTaskStatus()

      assert.equal(task.status, 'completed', 'a healthy task must complete, not be force-failed')
      assert.equal(task.result, 'https://preview.example')
      assert.equal(task.error, null)
      assert.ok(updates.some((u) => u.taskId === taskId && u.status === 'completed'))
    })

    it('transitions a task running→failed when the remote reports failure (#5327)', async () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('bad task')
      const task = manager._tasks.get(taskId)
      task.status = 'running'
      manager._checkRemoteStatus = async () => ({ status: 'failed', error: 'sandbox crashed' })

      const errors = []
      manager.on('task_error', (e) => errors.push(e))

      await manager._pollTaskStatus()

      assert.equal(task.status, 'failed')
      assert.equal(task.error, 'sandbox crashed')
      assert.equal(errors.length, 1)
    })

    it('leaves a task running when the status check is still pending or throws', async () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('slow task')
      const task = manager._tasks.get(taskId)
      task.status = 'running'

      // Still running.
      manager._checkRemoteStatus = async () => ({ status: 'running' })
      await manager._pollTaskStatus()
      assert.equal(task.status, 'running')

      // Transient check failure — must not fail the task.
      manager._checkRemoteStatus = async () => { throw new Error('network blip') }
      await manager._pollTaskStatus()
      assert.equal(task.status, 'running')
    })

    it('stops the timer once no tasks remain running', async () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('one task')
      const task = manager._tasks.get(taskId)
      task.status = 'running'
      manager._startPolling()
      assert.ok(manager._pollTimer, 'timer armed')

      manager._checkRemoteStatus = async () => ({ status: 'completed', result: 'done' })
      await manager._pollTaskStatus()

      assert.equal(task.status, 'completed')
      assert.equal(manager._pollTimer, null, 'timer cleared after last task completes')
    })

    it('skips an overlapping poll while the prior status check is still in flight (#5327 review)', async () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true
      manager._spawnRemoteTask = () => {}

      const { taskId } = manager.launchTask('slow check')
      const task = manager._tasks.get(taskId)
      task.status = 'running'

      let checkStarts = 0
      let releaseCheck
      manager._checkRemoteStatus = () => {
        checkStarts++
        return new Promise((resolve) => { releaseCheck = resolve })
      }

      // First poll starts the (stuck) status check and increments _pollCount.
      const firstPoll = manager._pollTaskStatus()
      assert.equal(checkStarts, 1)
      assert.equal(manager._pollCount, 1)

      // A second tick while the first is in flight must be skipped entirely —
      // no new status check, no _pollCount advance (which would time out early).
      await manager._pollTaskStatus()
      assert.equal(checkStarts, 1, 'overlapping poll must not start a second check')
      assert.equal(manager._pollCount, 1, 'overlapping poll must not advance the count')

      // Release the in-flight check; the first poll settles and clears the flag.
      releaseCheck({ status: 'running' })
      await firstPoll
      assert.equal(manager._inPoll, false, 'in-flight flag cleared after the poll settles')

      // A subsequent poll now runs normally — swap to an immediately-resolving
      // check so this poll doesn't hang on the stuck-promise mock.
      manager._checkRemoteStatus = async () => { checkStarts++; return { status: 'running' } }
      await manager._pollTaskStatus()
      assert.equal(checkStarts, 2)
    })

    it('unref\'s the poll timer so it never holds the event loop open (#5327)', () => {
      manager = new WebTaskManager()
      let unrefed = false
      const realSetInterval = globalThis.setInterval
      // Capture-and-unref seam via a fake timer object.
      manager._pollTimer = null
      globalThis.setInterval = () => ({ unref: () => { unrefed = true }, _fake: true })
      try {
        manager._startPolling()
      } finally {
        globalThis.setInterval = realSetInterval
      }
      assert.equal(unrefed, true, 'poll interval must be unref\'d')
      // Avoid clearInterval on the fake handle in destroy/afterEach.
      manager._pollTimer = null
    })
  })

  describe('WebTaskUnavailableError', () => {
    it('has correct name and code', () => {
      const err = new WebTaskUnavailableError()
      assert.equal(err.name, 'WebTaskUnavailableError')
      assert.equal(err.code, 'WEB_TASK_UNAVAILABLE')
      assert.ok(err.message.includes('--remote'))
    })
  })

  describe('#7291 remote task argv', () => {
    it('puts a -- separator before the client prompt', () => {
      const args = buildRemoteTaskArgs('do the thing')
      const sep = args.indexOf('--')
      assert.ok(sep !== -1, 'argv must carry an end-of-options separator')
      assert.equal(args[sep + 1], 'do the thing', 'the prompt must sit AFTER the --')
      // Every flag must precede the separator, or it becomes positional text.
      for (const a of args.slice(sep + 2)) {
        assert.ok(!a.startsWith('-'), `flag ${a} must not follow the --`)
      }
    })

    it('keeps a dash-leading prompt as TEXT rather than rejecting it', () => {
      // A prompt legitimately can start with a dash. The fix must not refuse
      // it — it must stop it being OPTION-PARSED while preserving it verbatim.
      for (const prompt of ['--print', '--dangerously-skip-permissions', '-p', '- a bullet']) {
        const args = buildRemoteTaskArgs(prompt)
        const sep = args.indexOf('--')
        assert.ok(sep !== -1 && sep < args.length - 1,
          `no separator protects ${prompt}`)
        assert.equal(args[args.length - 1], prompt, 'prompt must survive verbatim')
        // Assert by POSITION, not by searching for the value. `indexOf(prompt)`
        // returns the separator's own index when the prompt is exactly '--',
        // so it would fail against a CORRECT implementation.
        assert.equal(sep, args.length - 2,
          `the separator must sit immediately before ${JSON.stringify(prompt)}`)
      }
    })

    it('protects a prompt that is exactly the separator', () => {
      // The degenerate input the assertion above used to get wrong. '--' is a
      // legitimate thing for a user to type and must arrive as TEXT.
      const args = buildRemoteTaskArgs('--')
      assert.equal(args[args.length - 1], '--', 'the prompt survives verbatim')
      assert.equal(args.indexOf('--'), args.length - 2,
        'the FIRST -- is the separator; the second is the prompt')
      assert.equal(args.filter(a => a === '--').length, 2)
    })
  })


  describe('#7291 --remote arity gate', () => {
    // buildRemoteTaskArgs protects the prompt with a `--`, and a separator is
    // only correct for a boolean or optional-arg flag. Against a REQUIRED-arg
    // `--remote <name>` the `--` becomes the flag's value and the prompt is
    // freed to be option-parsed — strictly WORSE than no separator (measured
    // against commander 12.1.0). Since no argv is correct under both arities,
    // the gate must refuse rather than guess.
    const withRemote = (decl) => `Usage: claude [options]\n  ${decl}   Launch a web task\n  --teleport <id>   Teleport\n`

    it('refuses the feature when --remote takes a REQUIRED argument', async () => {
      manager = makeManager()
      const features = await manager.detectFeatures({ exec: async () => withRemote('--remote <name>') })
      assert.equal(features.remote, false,
        'a required-arg --remote cannot be protected by a -- separator, so it must be refused')
      assert.equal(manager.isAvailable, false)
      // Positive control in the same fixture: --teleport is unaffected.
      assert.equal(features.teleport, true)
    })

    it('allows boolean and optional-arg --remote (positive control)', async () => {
      for (const decl of ['--remote', '--remote [name]']) {
        const m = makeManager()
        const features = await m.detectFeatures({ exec: async () => withRemote(decl) })
        assert.equal(features.remote, true, `${decl} must remain available`)
        m.destroy()
      }
    })
  })

  describe('#7291 the production call site is wired to the builder', () => {
    // buildRemoteTaskArgs is covered as a pure function above, but EVERY other
    // test in this file stubs `_spawnRemoteTask` to avoid spawning a real
    // process — so nothing observes that the real one actually CALLS the
    // builder. Someone could inline `['--remote', prompt]` back into
    // _spawnRemoteTask and the whole suite would stay green: the guard would
    // be wired to none of its callers.
    //
    // execFile is a module-scope import with no injection seam, and
    // mock.module of a global leaks across the parallel test runner, so this
    // asserts on the SOURCE instead. It is deliberately narrow: it checks the
    // call site names the builder and does not build an argv literal itself.
    it('_spawnRemoteTask passes buildRemoteTaskArgs(...) to execFile, not a literal argv', async () => {
      const { fileURLToPath } = await import('node:url')
      const { join: joinPath, dirname } = await import('node:path')
      const src = readFileSync(
        joinPath(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web-task-manager.js'),
        'utf8',
      )
      // Anchor on the METHOD DEFINITION, not the call in launchTask.
      const defIdx = src.indexOf('_spawnRemoteTask(task) {')
      assert.ok(defIdx !== -1, '_spawnRemoteTask definition not found')
      const callSite = src.slice(defIdx, src.indexOf('\n  }', defIdx))

      // #8039: the call site must pass a VERIFIED, GATED bin — never the
      // bare literal 'claude' the pre-#8039 code spawned from a plain PATH
      // lookup. this._verifyBinary() is the one gate every spawn site in
      // this class goes through (see the class docblock).
      assert.match(callSite, /bin\s*=\s*this\._verifyBinary\(\)/,
        '_spawnRemoteTask must resolve its binary through the verified gate')
      assert.match(callSite, /execFile\(bin, buildRemoteTaskArgs\(task\.prompt\)/,
        '_spawnRemoteTask must delegate its argv to buildRemoteTaskArgs and spawn the GATED bin, not a literal')
      assert.ok(!/execFile\(\s*'claude'/.test(callSite),
        '_spawnRemoteTask must never pass the bare literal \'claude\' to execFile')
      assert.ok(!/\[\s*'--remote'\s*,/.test(callSite),
        '_spawnRemoteTask must not construct an argv literal of its own')
    })
  })

  // ── #8039 — every spawn site routed through the verified binary gate ────
  //
  // web-task-manager.js previously ran execFile('claude', ...) resolved by a
  // bare OS PATH lookup at three sites: detectFeatures (daemon start),
  // _spawnRemoteTask (every launch_web_task), and teleportTask (every
  // teleport). In binaryProvenance.mode: 'block', a claude whose hash no
  // longer matched its pin was still executed unchecked at each of these.
  // These tests exercise the REAL SessionManager.verifyOneShotExecutable()
  // gate end to end (not a hand-rolled stand-in) for each of the three
  // sites, and pin that a refusal never reaches a real spawn.
  //
  // No mocked `execFile` seam is used here on purpose (#8039 review): an
  // earlier draft added an instance-level `this._execFile` property so tests
  // could intercept the call, but that moved the real spawn behind a
  // property access that `scripts/lint-argv-sinks.mjs` (which statically
  // traces the imported `execFile`/`spawn` bindings) can no longer see —
  // silently narrowing that lint's coverage of this file. `_spawnRemoteTask`
  // and `teleportTask` call the plain module-level `execFile`/`execFileAsync`
  // directly, exactly as before #8039 (only the bare `'claude'` literal
  // became the gated `bin` variable), so "was the verified path actually
  // spawned" is instead observed the way session-manager-preflight.test.js's
  // #8030/#8035 suites already do: point the fixture provider's
  // `resolvedBinary` at a real marker-writing shim script and wait for the
  // marker. `detectFeatures` keeps using its pre-existing `deps.exec` seam
  // (never itself a recognized spawn-API name, so untouched by the lint).
  describe('#8039 — binary provenance gate (verifyOneShotExecutable)', () => {
    afterEach(() => { FixtureClaudeProvider.resolvedOverride = null })

    describe('detectFeatures', () => {
      it('a block-mode ledger mismatch refuses: no --help spawn attempted, feature detection reports unavailable', async () => {
        const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
        manager = makeManager({ sessionManagerOpts: { binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger } })
        const execCalls = []

        const features = await manager.detectFeatures({
          exec: async (cmd, args) => { execCalls.push({ cmd, args }); return 'Usage:\n  --remote\n  --teleport\n' },
        })

        assert.deepEqual(features, { remote: false, teleport: false })
        assert.equal(manager.detected, true)
        assert.equal(execCalls.length, 0,
          'a provenance refusal must never reach --help — this is the test that goes red if the #8039 gate is removed')
      })

      it('a matching ledger entry resolves through the verified path and runs --help on it', async () => {
        const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_REAL_HASH } })
        manager = makeManager({ sessionManagerOpts: { binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger } })
        const execCalls = []

        const features = await manager.detectFeatures({
          exec: async (cmd, args) => { execCalls.push({ cmd, args }); return 'Usage:\n  --remote\n  --teleport\n' },
        })

        assert.equal(execCalls.length, 1)
        assert.equal(execCalls[0].cmd, process.execPath, 'must resolve to the exact verified absolute path')
        assert.notEqual(execCalls[0].cmd, 'claude', 'must never pass the bare name')
        assert.deepEqual(execCalls[0].args, ['--help'])
        assert.deepEqual(features, { remote: true, teleport: true })
      })

      it('gates OFF (no binaryProvenanceMode configured): behaviour is unchanged', async () => {
        manager = makeManager()
        const execCalls = []

        const features = await manager.detectFeatures({
          exec: async (cmd, args) => { execCalls.push({ cmd, args }); return 'Usage:\n  --remote\n  --teleport\n' },
        })

        assert.equal(execCalls.length, 1, 'with the gate off, a healthy binary must still probe exactly as before #8039')
        assert.equal(execCalls[0].cmd, process.execPath)
        assert.deepEqual(features, { remote: true, teleport: true })
      })

      it('fails CLOSED with no sessionManager configured — no spawn attempted', async () => {
        manager = new WebTaskManager({ providerClass: FixtureClaudeProvider }) // sessionManager omitted
        const execCalls = []

        const features = await manager.detectFeatures({
          exec: async (cmd, args) => { execCalls.push({ cmd, args }) },
        })

        assert.deepEqual(features, { remote: false, teleport: false })
        assert.equal(execCalls.length, 0, 'no verified gate available must refuse, not silently fall back to an unverified spawn')
      })

      it('exercises the REAL default exec path end to end (no deps.exec override)', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
        // ws-server.js calls detectFeatures() with no deps at all — this
        // pins THAT exact path (the default `exec = deps.exec ||
        // execFileAsync` line), using a real gate-shim binary as the
        // resolved path so the module-level execFileAsync default actually
        // runs, rather than only ever exercising the deps.exec stand-in.
        const shim = makeGateShim()
        try {
          class ShimProvider {
            static get resolvedBinary() { return shim.shimPath }
            static get preflight() { return { label: 'Shim Claude', binary: { name: 'claude', candidates: [] } } }
          }
          manager = makeManager({ providerClass: ShimProvider })

          const features = await manager.detectFeatures()

          assert.equal(existsSync(shim.markerPath), true, 'the default exec path must have actually spawned the verified binary')
          // The shim's stdout has no --remote/--teleport text — asserting the
          // flags here just confirms detectFeatures parsed its REAL output.
          assert.deepEqual(features, { remote: false, teleport: false })
        } finally {
          rmSync(shim.dir, { recursive: true, force: true })
        }
      })
    })

    describe('launchTask / _spawnRemoteTask', () => {
      it('a block-mode ledger mismatch refuses: task fails immediately, no spawn attempted', async () => {
        // #8060 review (Suggestion 2 / mutant R2): the status/message
        // assertions below prove the refusal was REPORTED — they do NOT
        // prove nothing was EXECUTED. A mutant that still runs
        // execFile(this._providerClass.resolvedBinary, ...) before marking
        // the task failed passed this test at 47/47 when the fixture
        // resolved to process.execPath (running it with a bad flag leaves no
        // trace). Pinning resolvedOverride at a REAL marker-writing shim
        // closes that gap: if the mutant's fallback spawn ran, THIS shim's
        // marker would exist.
        const shimBad = makeGateShim()
        try {
          const ledger = fakeProvenanceLedger({ [shimBad.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
          manager = makeManager({ sessionManagerOpts: { binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger } })
          FixtureClaudeProvider.resolvedOverride = shimBad.shimPath
          manager._remoteAvailable = true

          const errors = []
          manager.on('task_error', (e) => errors.push(e))

          const { taskId, task } = manager.launchTask('build a site')

          // Synchronous: _spawnRemoteTask's gate-refusal branch sets
          // task.status BEFORE launchTask() returns. execFile's callback is
          // always async (never before the call returns), so a task still
          // 'pending' here would mean the gate was bypassed and a real spawn
          // was attempted instead — this is the assertion that goes red if the
          // #8039 gate is removed or its refusal swallowed. Runs on every
          // platform, including Windows.
          assert.equal(task.status, 'failed')
          assert.match(task.error, /PROVIDER_BINARY_PROVENANCE/)
          assert.equal(errors.length, 1)
          assert.equal(errors[0].taskId, taskId)

          // The direct "was a process actually spawned" observation is
          // POSIX-only: Windows cannot execFile the .mjs shim at all
          // (WINDOWS_SHIM_EXEC_SKIP), so an absent marker there would prove
          // nothing about the gate — see the reviewer's "Windows gap" note.
          if (!WINDOWS_SHIM_EXEC_SKIP) {
            // Positive control FIRST: prove this environment can actually
            // spawn a shim at all, so "the bad shim's marker is absent"
            // below is evidence of a refusal, not of a broken test harness.
            const shimGood = makeGateShim()
            try {
              ledger._records.set(shimGood.shimPath, { sha256: hashFile(shimGood.shimPath) })
              FixtureClaudeProvider.resolvedOverride = shimGood.shimPath
              manager.launchTask('positive control')
              await waitFor(() => existsSync(shimGood.markerPath), { label: 'positive-control spawn marker' })
              assert.equal(existsSync(shimGood.markerPath), true,
                'positive control: a correctly-pinned shim must actually spawn in this environment')

              assert.equal(existsSync(shimBad.markerPath), false,
                'the WRONG-hash shim must NEVER have been spawned — this is the test that goes red under mutant R2 (exec the unverified resolvedBinary before reporting the refusal)')
            } finally {
              rmSync(shimGood.dir, { recursive: true, force: true })
            }
          }
        } finally {
          rmSync(shimBad.dir, { recursive: true, force: true })
        }
      })

      it('a matching ledger entry spawns the VERIFIED absolute path, not the bare name', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
        const shim = makeGateShim()
        try {
          const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
          manager = makeManager({ sessionManagerOpts: { binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger } })
          FixtureClaudeProvider.resolvedOverride = shim.shimPath
          manager._remoteAvailable = true

          const { task } = manager.launchTask('build a site')
          assert.equal(task.status, 'pending', 'gate passed synchronously — the real execFile callback has not fired yet')

          await waitFor(() => existsSync(shim.markerPath), { label: 'launch spawn marker' })
          assert.equal(existsSync(shim.markerPath), true,
            'the exact verified absolute path (the shim, never the bare name \'claude\') must have been spawned')
        } finally {
          rmSync(shim.dir, { recursive: true, force: true })
        }
      })

      it('gates OFF: behaviour is unchanged — the task still spawns through the resolved path', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
        const shim = makeGateShim()
        try {
          FixtureClaudeProvider.resolvedOverride = shim.shimPath
          manager = makeManager()
          manager._remoteAvailable = true

          manager.launchTask('test')

          await waitFor(() => existsSync(shim.markerPath), { label: 'launch spawn marker (gates off)' })
          assert.equal(existsSync(shim.markerPath), true, 'with the gate off, a healthy binary must still spawn exactly as before #8039')
        } finally {
          rmSync(shim.dir, { recursive: true, force: true })
        }
      })

      it('fails CLOSED with no sessionManager configured — task fails, no spawn attempted', () => {
        manager = new WebTaskManager({ providerClass: FixtureClaudeProvider }) // sessionManager omitted
        manager._remoteAvailable = true

        const { task } = manager.launchTask('test')

        assert.equal(task.status, 'failed')
        assert.match(task.error, /PROVIDER_BINARY_UNVERIFIED/)
      })

      it('re-resolves fresh on every call rather than reusing a stale/cached path', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
        // One-shot calls (this class has no create-time session to pin a
        // path from) re-run the FULL gate fresh each time, unlike a chat
        // session's pinned per-turn spawnPreflight. Two DIFFERENT shims prove
        // each call independently spawns whatever resolvedBinary CURRENTLY
        // returns — never a value cached from an earlier call, and never a
        // bare OS PATH lookup for 'claude'.
        const shimA = makeGateShim()
        const shimB = makeGateShim()
        try {
          manager = makeManager()
          manager._remoteAvailable = true

          FixtureClaudeProvider.resolvedOverride = shimA.shimPath
          manager.launchTask('first')
          await waitFor(() => existsSync(shimA.markerPath), { label: 'shim A marker' })

          FixtureClaudeProvider.resolvedOverride = shimB.shimPath
          manager.launchTask('second')
          await waitFor(() => existsSync(shimB.markerPath), { label: 'shim B marker' })
        } finally {
          rmSync(shimA.dir, { recursive: true, force: true })
          rmSync(shimB.dir, { recursive: true, force: true })
        }
      })
    })

    describe('teleportTask', () => {
      // Seed a task without exercising the launch spawn gate itself (covered
      // above) — stub _spawnRemoteTask as a no-op purely to obtain a taskId.
      function seedTask(mgr) {
        mgr._remoteAvailable = true
        mgr._spawnRemoteTask = () => {}
        const { taskId } = mgr.launchTask('teleport me')
        mgr._teleportAvailable = true
        return taskId
      }

      it('a block-mode ledger mismatch refuses: rejects, no spawn attempted', async () => {
        // #8060 review (Suggestion 2 / mutant R2) — same gap as the launch
        // refusal test above: rejecting with the right message proves the
        // refusal was REPORTED, not that nothing was EXECUTED. Pin
        // resolvedOverride at a real marker-writing shim so a mutant that
        // execs the unverified resolvedBinary before rethrowing the gate
        // error leaves a trace.
        const shimBad = makeGateShim()
        try {
          const ledger = fakeProvenanceLedger({ [shimBad.shimPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
          manager = makeManager({ sessionManagerOpts: { binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger } })
          FixtureClaudeProvider.resolvedOverride = shimBad.shimPath
          const taskId = seedTask(manager)

          await assert.rejects(
            () => manager.teleportTask(taskId),
            (err) => {
              assert.match(err.message, /Teleport failed/)
              assert.match(err.message, /PROVIDER_BINARY_PROVENANCE/,
                'this is the test that goes red if the #8039 gate is removed — a bypassed gate would instead surface a spawn/argv error with no gate code')
              return true
            },
          )

          // POSIX-only direct spawn observation — see the launch refusal
          // test's comment above for why Windows cannot make this check.
          if (!WINDOWS_SHIM_EXEC_SKIP) {
            const shimGood = makeGateShim()
            try {
              ledger._records.set(shimGood.shimPath, { sha256: hashFile(shimGood.shimPath) })
              FixtureClaudeProvider.resolvedOverride = shimGood.shimPath

              const result = await manager.teleportTask(taskId)
              assert.equal(result.success, true,
                'positive control: teleport against a correctly-pinned shim must actually succeed in this environment')
              assert.equal(existsSync(shimGood.markerPath), true)

              assert.equal(existsSync(shimBad.markerPath), false,
                'the WRONG-hash shim must NEVER have been spawned — this is the test that goes red under mutant R2 (exec the unverified resolvedBinary before rethrowing the gate error)')
            } finally {
              rmSync(shimGood.dir, { recursive: true, force: true })
            }
          }
        } finally {
          rmSync(shimBad.dir, { recursive: true, force: true })
        }
      })

      it('a matching ledger entry spawns the VERIFIED absolute path, not the bare name', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
        const shim = makeGateShim()
        try {
          const ledger = fakeProvenanceLedger({ [shim.shimPath]: { sha256: hashFile(shim.shimPath) } })
          manager = makeManager({ sessionManagerOpts: { binaryProvenanceMode: 'block', binaryProvenanceLedger: ledger } })
          FixtureClaudeProvider.resolvedOverride = shim.shimPath
          const taskId = seedTask(manager)

          const result = await manager.teleportTask(taskId)

          assert.equal(result.success, true)
          assert.equal(existsSync(shim.markerPath), true,
            'the exact verified absolute path (the shim, never the bare name \'claude\') must have been spawned')
        } finally {
          rmSync(shim.dir, { recursive: true, force: true })
        }
      })

      it('gates OFF: behaviour is unchanged — teleport still spawns through the resolved path', { skip: WINDOWS_SHIM_EXEC_SKIP }, async () => {
        const shim = makeGateShim()
        try {
          FixtureClaudeProvider.resolvedOverride = shim.shimPath
          manager = makeManager()
          const taskId = seedTask(manager)

          const result = await manager.teleportTask(taskId)

          assert.equal(result.success, true, 'with the gate off, a healthy binary must still teleport exactly as before #8039')
          assert.equal(existsSync(shim.markerPath), true)
        } finally {
          rmSync(shim.dir, { recursive: true, force: true })
        }
      })

      it('fails CLOSED with no sessionManager configured — rejects, no spawn attempted', async () => {
        manager = new WebTaskManager({ providerClass: FixtureClaudeProvider }) // sessionManager omitted
        const taskId = seedTask(manager)

        await assert.rejects(
          () => manager.teleportTask(taskId),
          /PROVIDER_BINARY_UNVERIFIED/,
        )
      })
    })
  })

})
