import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { WebTaskManager, WebTaskUnavailableError } from '../src/web-task-manager.js'

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
})
