import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repoHandlers } from '../../src/handlers/repo-handlers.js'
import { createSpy, nsCtx } from '../test-helpers.js'

/**
 * Build a ctx with stubbed scanConversations / readReposFromConfig / writeReposToConfig
 * so handlers never touch ~/.chroxy or ~/.claude/projects on the test machine.
 */
function makeCtx(overrides = {}) {
  const sent = []
  const repoStore = []
  const ctx = nsCtx({
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
  })
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

    // The config read+write used to sit outside the handler's try/catch, so a
    // write failure threw out and the client got no response (silent failure).
    it('sends session_error (not an uncaught throw) when the config write fails', async () => {
      const ctx = makeCtx()
      ctx._repoStore.push({ path: '/tmp/keep', name: 'keep' })
      ctx.writeReposToConfig = createSpy(() => { throw new Error('EROFS: read-only file system') })

      // Must not throw out of the handler.
      await assert.doesNotReject(
        repoHandlers.remove_repo(makeWs(), makeClient(), { path: '/tmp/keep' }, ctx),
      )

      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Failed to remove repo/)
      assert.match(ctx._sent[0].message, /read-only file system/)
    })

    it('sends session_error when the config read fails', async () => {
      const ctx = makeCtx()
      ctx.readReposFromConfig = createSpy(() => { throw new Error('config parse error') })

      await assert.doesNotReject(
        repoHandlers.remove_repo(makeWs(), makeClient(), { path: '/tmp/keep' }, ctx),
      )

      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Failed to remove repo/)
      assert.equal(ctx.writeReposToConfig.callCount, 0, 'no write attempted when the read failed')
    })

    // The removal persisted; only the follow-up list refresh failed. The message
    // must NOT claim the removal failed (the repo IS gone from config).
    it('reports a refresh-only failure distinctly after a successful write', async () => {
      const ctx = makeCtx()
      ctx._repoStore.push({ path: '/tmp/gone', name: 'gone' })
      // buildRepoList scans conversations; make that throw AFTER the write lands.
      ctx.scanConversations = createSpy(async () => { throw new Error('scanner offline') })

      await assert.doesNotReject(
        repoHandlers.remove_repo(makeWs(), makeClient(), { path: '/tmp/gone' }, ctx),
      )

      assert.equal(ctx.writeReposToConfig.callCount, 1, 'the write still persisted')
      assert.equal(ctx._repoStore.length, 0, 'repo actually removed from config')
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /Repo removed/, 'message acknowledges the removal succeeded')
      assert.doesNotMatch(ctx._sent[0].message, /Failed to remove repo/)
    })
  })
})
