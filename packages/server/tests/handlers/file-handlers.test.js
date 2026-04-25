import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileHandlers } from '../../src/handlers/file-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeFileOps(overrides = {}) {
  return {
    listDirectory: createSpy(),
    browseFiles: createSpy(),
    listFiles: createSpy(),
    readFile: createSpy(),
    writeFile: createSpy(),
    getDiff: createSpy(),
    gitStatus: createSpy(),
    gitBranches: createSpy(),
    gitStage: createSpy(),
    gitUnstage: createSpy(),
    gitCommit: createSpy(),
    listSlashCommands: createSpy(),
    listAgents: createSpy(),
    ...overrides,
  }
}

function makeCtx(sessions = new Map(), overrides = {}) {
  const fileOps = makeFileOps(overrides.fileOps)
  return {
    fileOps,
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
    },
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return {
    id: 'client-1',
    activeSessionId: null,
    ...overrides,
  }
}

function makeWs() {
  return {}
}

describe('file-handlers', () => {
  describe('list_directory', () => {
    it('delegates to fileOps.listDirectory with the provided path', () => {
      const ctx = makeCtx()
      const ws = makeWs()

      fileHandlers.list_directory(ws, makeClient(), { path: '/some/dir' }, ctx)

      assert.equal(ctx.fileOps.listDirectory.callCount, 1)
      const [callWs, callPath] = ctx.fileOps.listDirectory.lastCall
      assert.equal(callWs, ws)
      assert.equal(callPath, '/some/dir')
    })
  })

  describe('browse_files', () => {
    it('passes session cwd to fileOps.browseFiles', () => {
      const sessions = new Map()
      const session = createMockSession()
      sessions.set('s1', { session, name: 'S', cwd: '/project' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.browse_files(makeWs(), client, { path: 'src' }, ctx)

      const [, callPath, callCwd] = ctx.fileOps.browseFiles.lastCall
      assert.equal(callPath, 'src')
      assert.equal(callCwd, '/project')
    })

    it('passes null cwd when no active session', () => {
      const ctx = makeCtx()

      fileHandlers.browse_files(makeWs(), makeClient(), { path: 'src' }, ctx)

      const [, , callCwd] = ctx.fileOps.browseFiles.lastCall
      assert.equal(callCwd, null)
    })
  })

  describe('list_files', () => {
    it('passes session cwd and query to fileOps.listFiles', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/app' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.list_files(makeWs(), client, { query: 'README', sessionId: 's1' }, ctx)

      const [, callCwd, callQuery] = ctx.fileOps.listFiles.lastCall
      assert.equal(callCwd, '/app')
      assert.equal(callQuery, 'README')
    })

    it('uses null cwd when session not found', () => {
      const ctx = makeCtx()
      fileHandlers.list_files(makeWs(), makeClient(), {}, ctx)

      const [, callCwd] = ctx.fileOps.listFiles.lastCall
      assert.equal(callCwd, null)
    })
  })

  describe('read_file', () => {
    it('passes path and session cwd to fileOps.readFile', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.read_file(makeWs(), client, { path: 'package.json' }, ctx)

      const [, callPath, callCwd] = ctx.fileOps.readFile.lastCall
      assert.equal(callPath, 'package.json')
      assert.equal(callCwd, '/proj')
    })
  })

  describe('write_file', () => {
    it('passes path, content, and session cwd to fileOps.writeFile', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.write_file(makeWs(), client, { path: 'README.md', content: '# Hi' }, ctx)

      const [, callPath, callContent, callCwd] = ctx.fileOps.writeFile.lastCall
      assert.equal(callPath, 'README.md')
      assert.equal(callContent, '# Hi')
      assert.equal(callCwd, '/proj')
    })
  })

  describe('git operations', () => {
    it('git_status passes session cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_status(makeWs(), client, {}, ctx)

      const [, callCwd] = ctx.fileOps.gitStatus.lastCall
      assert.equal(callCwd, '/repo')
    })

    it('git_branches passes session cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_branches(makeWs(), client, {}, ctx)

      const [, callCwd] = ctx.fileOps.gitBranches.lastCall
      assert.equal(callCwd, '/repo')
    })

    it('git_stage passes files and cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_stage(makeWs(), client, { files: ['a.js', 'b.js'] }, ctx)

      const [, callFiles, callCwd] = ctx.fileOps.gitStage.lastCall
      assert.deepEqual(callFiles, ['a.js', 'b.js'])
      assert.equal(callCwd, '/repo')
    })

    it('git_commit passes message and cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_commit(makeWs(), client, { message: 'fix: bug' }, ctx)

      const [, callMessage, callCwd] = ctx.fileOps.gitCommit.lastCall
      assert.equal(callMessage, 'fix: bug')
      assert.equal(callCwd, '/repo')
    })
  })

  describe('list_slash_commands / list_agents', () => {
    it('list_slash_commands passes cwd and session id', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.list_slash_commands(makeWs(), client, { sessionId: 's1' }, ctx)

      const [, callCwd, callSid] = ctx.fileOps.listSlashCommands.lastCall
      assert.equal(callCwd, '/proj')
      assert.equal(callSid, 's1')
    })

    it('list_agents passes cwd and session id', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.list_agents(makeWs(), client, { sessionId: 's1' }, ctx)

      const [, callCwd, callSid] = ctx.fileOps.listAgents.lastCall
      assert.equal(callCwd, '/proj')
      assert.equal(callSid, 's1')
    })

    it('list_agents passes userAgentsDirs from ctx to listAgents opts (#2965)', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const userAgentsDirs = ['/tmp/claude/agents', '/tmp/codex/agents']
      const ctx = makeCtx(sessions, { userAgentsDirs })
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.list_agents(makeWs(), client, { sessionId: 's1' }, ctx)

      const [, , , callOpts] = ctx.fileOps.listAgents.lastCall
      assert.ok(callOpts, 'opts argument must be passed')
      assert.deepEqual(callOpts.userAgentsDirs, userAgentsDirs)
    })

    it('list_agents passes empty opts when ctx has no userAgentsDirs', () => {
      const ctx = makeCtx()
      fileHandlers.list_agents(makeWs(), makeClient(), {}, ctx)

      const [, , , callOpts] = ctx.fileOps.listAgents.lastCall
      assert.ok(callOpts, 'opts argument must be passed')
      assert.ok(!callOpts.userAgentsDirs, 'userAgentsDirs must not be set when ctx lacks it')
    })
  })
})
