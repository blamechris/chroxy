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
      manager = new WebTaskManager()
      await manager.detectFeatures()
      // Current CLI v2.1.51 does not have --remote
      assert.equal(manager.isAvailable, false)
      assert.equal(manager.teleportAvailable, false)
      assert.equal(manager.detected, true)
    })

    it('returns feature status object', async () => {
      manager = new WebTaskManager()
      await manager.detectFeatures()
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

      const { taskId } = manager.launchTask('specific task')
      const task = manager.getTask(taskId)
      assert.equal(task.prompt, 'specific task')

      const missing = manager.getTask('nonexistent')
      assert.equal(missing, null)
    })

    it('returns copies of tasks (not references)', () => {
      manager = new WebTaskManager()
      manager._remoteAvailable = true

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

  describe('WebTaskUnavailableError', () => {
    it('has correct name and code', () => {
      const err = new WebTaskUnavailableError()
      assert.equal(err.name, 'WebTaskUnavailableError')
      assert.equal(err.code, 'WEB_TASK_UNAVAILABLE')
      assert.ok(err.message.includes('--remote'))
    })
  })
})
