import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repoHandlers } from '../../src/handlers/repo-handlers.js'
import { createSpy } from '../test-helpers.js'

/**
 * Build a ctx with stubbed scanConversations / readReposFromConfig / writeReposToConfig
 * so handlers never touch ~/.chroxy or ~/.claude/projects on the test machine.
 */
function makeCtx(overrides = {}) {
  const sent = []
  const repoStore = []
  const ctx = {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    scanConversations: createSpy(async () => []),
    readReposFromConfig: createSpy(() => repoStore.slice()),
    writeReposToConfig: createSpy((repos) => {
      repoStore.length = 0
      repoStore.push(...repos)
    }),
    _sent: sent,
    _repoStore: repoStore,
    ...overrides,
  }
  return ctx
}

function makeWs() { return {} }
function makeClient() { return { id: 'client-1' } }

describe('repo-handlers', () => {
  describe('list_repos', () => {
    it('sends repo_list with merged manual + auto-discovered repos', async () => {
      const ctx = makeCtx()
      // Manual config has one entry; scanner returns conversations grouped into another repo.
      ctx._repoStore.push({ path: '/tmp/manual-repo', name: 'manual-repo' })
      ctx.scanConversations = createSpy(async () => [
        { cwd: '/tmp/auto-repo', timestamp: 1 },
      ])

      await repoHandlers.list_repos(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent.length, 1)
      const sent = ctx._sent[0]
      assert.equal(sent.type, 'repo_list', `expected repo_list, got ${sent.type}`)
      assert.ok(Array.isArray(sent.repos))
      // Manual repo always comes first
      assert.equal(sent.repos[0].path, '/tmp/manual-repo')
      assert.equal(sent.repos[0].source, 'manual')
      assert.equal(ctx.scanConversations.callCount, 1)
      assert.equal(ctx.readReposFromConfig.callCount, 1)
    })

    it('sends server_error when the injected scanner throws', async () => {
      const ctx = makeCtx()
      ctx.scanConversations = createSpy(async () => { throw new Error('scan failed') })

      await repoHandlers.list_repos(makeWs(), makeClient(), {}, ctx)

      assert.equal(ctx._sent[0].type, 'server_error')
      assert.match(ctx._sent[0].message, /scan failed/)
    })

    it('passes projectsDirs from ctx to the scanner (#2965)', async () => {
      const projectsDirs = ['/tmp/claude/projects', '/tmp/codex/projects']
      const ctx = makeCtx({ projectsDirs })
      let capturedOpts
      ctx.scanConversations = createSpy(async (opts) => { capturedOpts = opts; return [] })

      await repoHandlers.list_repos(makeWs(), makeClient(), {}, ctx)

      assert.ok(capturedOpts, 'scan must be called with opts')
      assert.deepEqual(capturedOpts.projectsDirs, projectsDirs)
    })

    it('calls scanner with empty opts when ctx has no projectsDirs', async () => {
      const ctx = makeCtx()
      let capturedOpts
      ctx.scanConversations = createSpy(async (opts) => { capturedOpts = opts; return [] })

      await repoHandlers.list_repos(makeWs(), makeClient(), {}, ctx)

      assert.ok(capturedOpts !== undefined, 'opts must be defined')
      assert.ok(!capturedOpts.projectsDirs, 'projectsDirs must not be set when ctx lacks it')
    })
  })

  describe('add_repo', () => {
    it('sends session_error when path is outside home directory', async () => {
      const ctx = makeCtx()
      // /etc is outside home directory
      await repoHandlers.add_repo(makeWs(), makeClient(), { path: '/etc' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      // Must NOT have written to (mocked) config
      assert.equal(ctx.writeReposToConfig.callCount, 0)
    })

    it('sends session_error when path does not exist', async () => {
      const ctx = makeCtx()
      await repoHandlers.add_repo(makeWs(), makeClient(), { path: '/nonexistent/path/that/does/not/exist' }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.equal(ctx.writeReposToConfig.callCount, 0)
    })
  })

  describe('remove_repo', () => {
    it('sends repo_list after removing (even non-existent) path via injected store', async () => {
      const ctx = makeCtx()
      ctx._repoStore.push({ path: '/tmp/keep', name: 'keep' })

      await repoHandlers.remove_repo(makeWs(), makeClient(), { path: '/some/nonexistent/repo' }, ctx)

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'repo_list')
      assert.equal(ctx.writeReposToConfig.callCount, 1)
      // Existing entry preserved (target not in list)
      assert.equal(ctx._repoStore.length, 1)
      assert.equal(ctx._repoStore[0].path, '/tmp/keep')
    })
  })
})
