import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { miscHandlers as environmentHandlers } from '../../src/handlers/misc-handlers.js'
import { createSpy } from '../test-helpers.js'

function makeCtx(overrides = {}) {
  const sent = []
  const broadcasts = []

  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    broadcast: createSpy((msg) => { broadcasts.push(msg) }),
    environmentManager: null,
    _sent: sent,
    _broadcasts: broadcasts,
    ...overrides,
  }
}

function makeWs() { return {} }
function makeClient() { return { id: 'client-1' } }

describe('environment-handlers', () => {
  describe('create_environment', () => {
    it('sends environment_error when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev', cwd: '/tmp' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /not enabled/)
    })

    it('sends environment_error when name is missing', () => {
      const ctx = makeCtx({
        environmentManager: { create: createSpy(async () => ({})) },
      })
      environmentHandlers.create_environment(makeWs(), makeClient(), { cwd: '/tmp' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /name is required/)
    })

    it('sends environment_error when cwd is missing', () => {
      const ctx = makeCtx({
        environmentManager: { create: createSpy(async () => ({})) },
      })
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /cwd is required/)
    })

    it('sends environment_error when cwd is outside home directory', () => {
      const ctx = makeCtx({
        environmentManager: { create: createSpy(async () => ({})) },
      })
      // /etc is outside home directory
      environmentHandlers.create_environment(makeWs(), makeClient(), { name: 'dev', cwd: '/etc' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
    })
  })

  describe('list_environments', () => {
    it('sends empty list when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.list_environments(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_list')
      assert.deepEqual(ctx._sent[0].environments, [])
    })

    it('sends environments from manager', () => {
      const ctx = makeCtx({
        environmentManager: {
          list: createSpy(() => [{ id: 'env-1', name: 'dev', status: 'running' }]),
        },
      })

      environmentHandlers.list_environments(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'environment_list')
      assert.equal(ctx._sent[0].environments.length, 1)
      assert.equal(ctx._sent[0].environments[0].id, 'env-1')
    })
  })

  describe('destroy_environment', () => {
    it('sends environment_error when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.destroy_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
    })

    it('sends environment_error when environmentId is missing', () => {
      const ctx = makeCtx({
        environmentManager: { destroy: createSpy(async () => {}) },
      })
      environmentHandlers.destroy_environment(makeWs(), makeClient(), {}, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /environmentId is required/)
    })

    it('sends environment_destroyed and broadcasts on success', async () => {
      const ctx = makeCtx({
        environmentManager: {
          destroy: createSpy(async () => {}),
          list: createSpy(() => []),
        },
      })

      environmentHandlers.destroy_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      // Wait for async resolution
      await new Promise(r => setTimeout(r, 10))

      const destroyed = ctx._sent.find(m => m.type === 'environment_destroyed')
      assert.ok(destroyed, 'environment_destroyed not sent')
      assert.equal(destroyed.environmentId, 'env-1')
    })
  })

  describe('get_environment', () => {
    it('sends environment_error when environmentManager not available', () => {
      const ctx = makeCtx()
      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)
      assert.equal(ctx._sent[0].type, 'environment_error')
    })

    it('sends environment_error when environment not found', () => {
      const ctx = makeCtx({
        environmentManager: {
          get: createSpy(() => null),
        },
      })

      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)

      assert.equal(ctx._sent[0].type, 'environment_error')
      assert.match(ctx._sent[0].error, /not found/)
    })

    it('sends environment_info when found', () => {
      const envData = { id: 'env-1', name: 'dev', status: 'running' }
      const ctx = makeCtx({
        environmentManager: {
          get: createSpy(() => envData),
        },
      })

      environmentHandlers.get_environment(makeWs(), makeClient(), { environmentId: 'env-1' }, ctx)

      assert.equal(ctx._sent[0].type, 'environment_info')
      assert.deepEqual(ctx._sent[0].environment, envData)
    })
  })
})
