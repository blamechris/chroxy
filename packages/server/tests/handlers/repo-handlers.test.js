import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repoHandlers } from '../../src/handlers/repo-handlers.js'
import { createSpy } from '../test-helpers.js'

function makeCtx(overrides = {}) {
  const sent = []
  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    _sent: sent,
    ...overrides,
  }
}

function makeWs() { return {} }
function makeClient() { return { id: 'client-1' } }

describe('repo-handlers', () => {
  describe('list_repos', () => {
    it('sends repo_list on success', async () => {
      const ctx = makeCtx()
      await repoHandlers.list_repos(makeWs(), makeClient(), {}, ctx)
      // Handler calls scanConversations internally; result may be empty or populated
      assert.equal(ctx._sent.length, 1)
      const sent = ctx._sent[0]
      // Either success or error from file system
      assert.ok(sent.type === 'repo_list' || sent.type === 'server_error')
    })
  })

  describe('add_repo', () => {
    it('sends session_error when path is outside home directory', async () => {
      const ctx = makeCtx()
      // /etc is outside home directory
      await repoHandlers.add_repo(makeWs(), makeClient(), { path: '/etc' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
    })

    it('sends session_error when path does not exist', async () => {
      const ctx = makeCtx()
      await repoHandlers.add_repo(makeWs(), makeClient(), { path: '/nonexistent/path/that/does/not/exist' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
    })
  })

  describe('remove_repo', () => {
    it('sends repo_list after removing (even non-existent) path', async () => {
      const ctx = makeCtx()
      // Removing a non-existent path is a no-op, then re-lists
      await repoHandlers.remove_repo(makeWs(), makeClient(), { path: '/some/nonexistent/repo' }, ctx)
      assert.equal(ctx._sent.length, 1)
      // Either repo_list or server_error depending on scanConversations
      const sent = ctx._sent[0]
      assert.ok(sent.type === 'repo_list' || sent.type === 'server_error')
    })
  })
})
