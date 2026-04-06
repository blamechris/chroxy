import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { featureHandlers as webTaskHandlers } from '../../src/handlers/feature-handlers.js'
import { createSpy } from '../test-helpers.js'
import { WebTaskUnavailableError } from '../../src/web-task-manager.js'

function makeCtx(overrides = {}) {
  const sent = []
  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    webTaskManager: {
      launchTask: createSpy(() => ({ taskId: 'task-1' })),
      listTasks: createSpy(() => []),
      teleportTask: createSpy(async () => {}),
    },
    devPreview: {
      closePreview: createSpy(),
    },
    _sent: sent,
    ...overrides,
  }
}

function makeWs() { return {} }
function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: null, ...overrides }
}

describe('web-task-handlers', () => {
  describe('launch_web_task', () => {
    it('launches a task successfully without sending to ws', () => {
      const ctx = makeCtx()
      webTaskHandlers.launch_web_task(makeWs(), makeClient(), { prompt: 'Do something' }, ctx)
      assert.equal(ctx.webTaskManager.launchTask.callCount, 1)
      assert.equal(ctx._sent.length, 0)
    })

    it('sends web_task_error when cwd is outside home directory', () => {
      const ctx = makeCtx()
      webTaskHandlers.launch_web_task(makeWs(), makeClient(), { prompt: 'Do something', cwd: '/etc' }, ctx)
      assert.equal(ctx._sent[0].type, 'web_task_error')
    })

    it('sends web_task_error when launchTask throws WebTaskUnavailableError', () => {
      const ctx = makeCtx()
      ctx.webTaskManager.launchTask = createSpy(() => {
        throw new WebTaskUnavailableError('Web tasks not available')
      })

      webTaskHandlers.launch_web_task(makeWs(), makeClient(), { prompt: 'Do something' }, ctx)

      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.ok(ctx._sent[0].message.length > 0)
    })

    it('sends web_task_error for generic errors', () => {
      const ctx = makeCtx()
      ctx.webTaskManager.launchTask = createSpy(() => {
        throw new Error('something went wrong')
      })

      webTaskHandlers.launch_web_task(makeWs(), makeClient(), { prompt: 'Do something' }, ctx)

      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.match(ctx._sent[0].message, /Failed to launch/)
    })
  })

  describe('list_web_tasks', () => {
    it('sends web_task_list with tasks from manager', () => {
      const ctx = makeCtx()
      ctx.webTaskManager.listTasks = createSpy(() => [
        { taskId: 'task-1', prompt: 'Test', status: 'running' },
      ])

      webTaskHandlers.list_web_tasks(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'web_task_list')
      assert.equal(ctx._sent[0].tasks.length, 1)
    })
  })

  describe('teleport_web_task', () => {
    it('sends server_status on success', async () => {
      const ctx = makeCtx()

      webTaskHandlers.teleport_web_task(makeWs(), makeClient(), { taskId: 'task-1' }, ctx)
      await new Promise(r => setTimeout(r, 10))

      assert.equal(ctx._sent[0].type, 'server_status')
    })

    it('sends web_task_error on failure', async () => {
      const ctx = makeCtx()
      ctx.webTaskManager.teleportTask = createSpy(async () => {
        throw new Error('task not found')
      })

      webTaskHandlers.teleport_web_task(makeWs(), makeClient(), { taskId: 'task-x' }, ctx)
      await new Promise(r => setTimeout(r, 10))

      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.match(ctx._sent[0].message, /task not found/)
    })
  })

  describe('close_dev_preview', () => {
    it('calls devPreview.closePreview with sessionId and port', () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 's1' })

      webTaskHandlers.close_dev_preview(makeWs(), client, { port: 3000 }, ctx)

      assert.equal(ctx.devPreview.closePreview.callCount, 1)
      assert.deepEqual(ctx.devPreview.closePreview.lastCall, ['s1', 3000])
    })

    it('is a no-op when no sessionId and no activeSessionId', () => {
      const ctx = makeCtx()
      webTaskHandlers.close_dev_preview(makeWs(), makeClient(), { port: 3000 }, ctx)
      assert.equal(ctx.devPreview.closePreview.callCount, 0)
    })
  })
})
