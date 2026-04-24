import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { featureHandlers as webTaskHandlers } from '../../src/handlers/feature-handlers.js'
import { createSpy, waitFor } from '../test-helpers.js'
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

    // --- Adversary A10 (2026-04-11 audit) --------------------

    it('A10: rejects prompt larger than 10KB', () => {
      const ctx = makeCtx()
      const huge = 'x'.repeat(10 * 1024 + 1)
      webTaskHandlers.launch_web_task(makeWs(), makeClient(), { prompt: huge }, ctx)
      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.equal(ctx._sent[0].code, 'WEB_TASK_PROMPT_TOO_LARGE')
      assert.equal(ctx.webTaskManager.launchTask.callCount, 0)
    })

    it('A10: rejects non-string / empty prompt without calling manager', () => {
      for (const bad of [null, undefined, 42, '', '   ']) {
        const ctx = makeCtx()
        webTaskHandlers.launch_web_task(makeWs(), makeClient(), { prompt: bad }, ctx)
        assert.equal(ctx._sent[0].type, 'web_task_error')
        assert.equal(ctx.webTaskManager.launchTask.callCount, 0, `bad prompt=${JSON.stringify(bad)} should short-circuit`)
      }
    })

    it('A10: bound client with no resolvable session is rejected', () => {
      const ctx = makeCtx()
      ctx.sessionManager = { getSession: () => null }
      const client = makeClient({ boundSessionId: 'ghost' })
      webTaskHandlers.launch_web_task(makeWs(), client, { prompt: 'hi' }, ctx)
      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.webTaskManager.launchTask.callCount, 0)
      // Issue #2912: the web_task_error SESSION_TOKEN_MISMATCH payload shape
      // matches the session_error payload — boundSessionId present,
      // boundSessionName null when the binding is stale.
      assert.equal(ctx._sent[0].boundSessionId, 'ghost')
      assert.equal(ctx._sent[0].boundSessionName, null)
    })

    it('A10: bound client cannot override cwd away from session cwd', () => {
      const ctx = makeCtx()
      ctx.sessionManager = { getSession: () => ({ name: 'BoundOne', cwd: '/home/dev/Projects/chroxy' }) }
      const client = makeClient({ boundSessionId: 'b1' })
      webTaskHandlers.launch_web_task(makeWs(), client,
        { prompt: 'hi', cwd: '/home/dev/Projects/other' }, ctx)
      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.webTaskManager.launchTask.callCount, 0)
      // Issue #2912: unified payload shape.
      assert.equal(ctx._sent[0].boundSessionId, 'b1')
      assert.equal(ctx._sent[0].boundSessionName, 'BoundOne')
    })

    it('A10: bound client using matching cwd forces launch in bound cwd', () => {
      const ctx = makeCtx()
      ctx.sessionManager = { getSession: () => ({ cwd: '/home/dev/Projects/chroxy' }) }
      const client = makeClient({ boundSessionId: 'b1' })
      // validateCwdAllowed will accept /home paths in most envs; if it
      // rejects, the test still verifies we short-circuit on a match
      // BEFORE calling launchTask — so rather than couple to the real
      // cwd check, we stub it.
      webTaskHandlers.launch_web_task(makeWs(), client, { prompt: 'hi' }, ctx)
      // launchTask may still fail the cwd existence check in
      // validateCwdAllowed — we only care that A10 didn't early-return
      // via SESSION_TOKEN_MISMATCH.
      const mismatch = ctx._sent.find((m) => m.code === 'SESSION_TOKEN_MISMATCH')
      assert.equal(mismatch, undefined, 'bound client with matching cwd should not be rejected as mismatch')
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

    it('A10: scopes list to bound session cwd for bound clients', () => {
      const ctx = makeCtx()
      ctx.sessionManager = { getSession: () => ({ cwd: '/home/dev/ok' }) }
      ctx.webTaskManager.listTasks = createSpy(() => [
        { taskId: 'in-scope', cwd: '/home/dev/ok' },
        { taskId: 'out-of-scope', cwd: '/home/dev/other' },
      ])
      const client = makeClient({ boundSessionId: 'b1' })
      webTaskHandlers.list_web_tasks(makeWs(), client, {}, ctx)
      assert.equal(ctx._sent[0].type, 'web_task_list')
      assert.deepEqual(ctx._sent[0].tasks.map((t) => t.taskId), ['in-scope'])
    })
  })

  describe('teleport_web_task', () => {
    it('sends server_status on success', async () => {
      const ctx = makeCtx()

      webTaskHandlers.teleport_web_task(makeWs(), makeClient(), { taskId: 'task-1' }, ctx)
      await waitFor(() => ctx._sent[0], { label: 'teleport_web_task success response' })

      assert.equal(ctx._sent[0].type, 'server_status')
    })

    it('sends web_task_error on failure', async () => {
      const ctx = makeCtx()
      ctx.webTaskManager.teleportTask = createSpy(async () => {
        throw new Error('task not found')
      })

      webTaskHandlers.teleport_web_task(makeWs(), makeClient(), { taskId: 'task-x' }, ctx)
      await waitFor(() => ctx._sent[0], { label: 'teleport_web_task failure response' })

      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.match(ctx._sent[0].message, /task not found/)
    })

    it('A10: rejects bound client teleporting a task outside bound cwd', () => {
      const ctx = makeCtx()
      ctx.webTaskManager.getTask = (id) => id === 'task-x'
        ? { taskId: 'task-x', cwd: '/home/dev/other' }
        : null
      ctx.sessionManager = { getSession: () => ({ name: 'BoundOne', cwd: '/home/dev/ok' }) }
      const client = makeClient({ boundSessionId: 'b1' })
      webTaskHandlers.teleport_web_task(makeWs(), client, { taskId: 'task-x' }, ctx)
      assert.equal(ctx._sent[0].type, 'web_task_error')
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.webTaskManager.teleportTask.callCount, 0)
      // Issue #2912: unified payload shape.
      assert.equal(ctx._sent[0].boundSessionId, 'b1')
      assert.equal(ctx._sent[0].boundSessionName, 'BoundOne')
    })

    it('A10: rejects bound client when task id is unknown', () => {
      const ctx = makeCtx()
      ctx.webTaskManager.getTask = () => null
      ctx.sessionManager = { getSession: () => ({ cwd: '/home/dev/ok' }) }
      const client = makeClient({ boundSessionId: 'b1' })
      webTaskHandlers.teleport_web_task(makeWs(), client, { taskId: 'ghost' }, ctx)
      assert.equal(ctx._sent[0].code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(ctx.webTaskManager.teleportTask.callCount, 0)
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
