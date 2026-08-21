import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { WebTaskManager, WebTaskUnavailableError, buildRemoteTaskArgs } from '../src/web-task-manager.js'

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
      manager = new WebTaskManager()
      await manager.detectFeatures({ exec: async () => 'Usage: claude [options]\n  --help\n  --print' })
      assert.equal(manager.isAvailable, false)
      assert.equal(manager.teleportAvailable, false)
      assert.equal(manager.detected, true)
    })

    it('detects --remote and --teleport when present in --help', async () => {
      manager = new WebTaskManager()
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
      manager = new WebTaskManager()
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
      manager = new WebTaskManager()
      // --remote at end-of-line, and --teleport followed by whitespace: both
      // are genuine advertisements and must still register.
      const features = await manager.detectFeatures({
        exec: async () => 'Usage:\n  --remote\n  --teleport <id>   Teleport\n',
      })
      assert.deepEqual(features, { remote: true, teleport: true })
    })

    it('treats a failed --help invocation as unavailable', async () => {
      manager = new WebTaskManager()
      await manager.detectFeatures({ exec: async () => { throw new Error('claude: command not found') } })
      assert.equal(manager.isAvailable, false)
      assert.equal(manager.teleportAvailable, false)
      assert.equal(manager.detected, true)
    })

    it('returns feature status object', async () => {
      manager = new WebTaskManager()
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
      manager = new WebTaskManager()
      const features = await manager.detectFeatures({ exec: async () => withRemote('--remote <name>') })
      assert.equal(features.remote, false,
        'a required-arg --remote cannot be protected by a -- separator, so it must be refused')
      assert.equal(manager.isAvailable, false)
      // Positive control in the same fixture: --teleport is unaffected.
      assert.equal(features.teleport, true)
    })

    it('allows boolean and optional-arg --remote (positive control)', async () => {
      for (const decl of ['--remote', '--remote [name]']) {
        const m = new WebTaskManager()
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
      const { readFileSync } = await import('node:fs')
      const { fileURLToPath } = await import('node:url')
      const { join, dirname } = await import('node:path')
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web-task-manager.js'),
        'utf8',
      )
      // Anchor on the METHOD DEFINITION, not the call in launchTask.
      const defIdx = src.indexOf('_spawnRemoteTask(task) {')
      assert.ok(defIdx !== -1, '_spawnRemoteTask definition not found')
      const callSite = src.slice(defIdx, src.indexOf('\n  }', defIdx))

      assert.match(callSite, /execFile\('claude', buildRemoteTaskArgs\(task\.prompt\)/,
        '_spawnRemoteTask must delegate its argv to buildRemoteTaskArgs')
      assert.ok(!/\[\s*'--remote'\s*,/.test(callSite),
        '_spawnRemoteTask must not construct an argv literal of its own')
    })
  })

})
