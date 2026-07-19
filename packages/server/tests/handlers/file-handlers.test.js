import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileHandlers } from '../../src/handlers/file-handlers.js'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'

function makeFileOps(overrides = {}) {
  return {
    listDirectory: createSpy(),
    browseFiles: createSpy(),
    listFiles: createSpy(),
    readFile: createSpy(),
    writeFile: createSpy(),
    appendMemory: createSpy(),
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
  return nsCtx({
    fileOps,
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
    },
    ...overrides,
  })
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

      assert.equal(ctx.services.fileOps.listDirectory.callCount, 1)
      const [callWs, callPath] = ctx.services.fileOps.listDirectory.lastCall
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

      const [, callPath, callCwd] = ctx.services.fileOps.browseFiles.lastCall
      assert.equal(callPath, 'src')
      assert.equal(callCwd, '/project')
    })

    it('passes null cwd when no active session', () => {
      const ctx = makeCtx()

      fileHandlers.browse_files(makeWs(), makeClient(), { path: 'src' }, ctx)

      const [, , callCwd] = ctx.services.fileOps.browseFiles.lastCall
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

      const [, callCwd, callQuery] = ctx.services.fileOps.listFiles.lastCall
      assert.equal(callCwd, '/app')
      assert.equal(callQuery, 'README')
    })

    it('uses null cwd when session not found', () => {
      const ctx = makeCtx()
      fileHandlers.list_files(makeWs(), makeClient(), {}, ctx)

      const [, callCwd] = ctx.services.fileOps.listFiles.lastCall
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

      const [, callPath, callCwd] = ctx.services.fileOps.readFile.lastCall
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

      const [, callPath, callContent, callCwd] = ctx.services.fileOps.writeFile.lastCall
      assert.equal(callPath, 'README.md')
      assert.equal(callContent, '# Hi')
      assert.equal(callCwd, '/proj')
    })
  })

  describe('append_memory (#6861)', () => {
    it('passes the note text and session cwd to fileOps.appendMemory (no client path)', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.append_memory(makeWs(), client, { type: 'append_memory', text: 'remember X' }, ctx)

      assert.equal(ctx.services.fileOps.appendMemory.callCount, 1)
      const [, callText, callCwd] = ctx.services.fileOps.appendMemory.lastCall
      assert.equal(callText, 'remember X')
      assert.equal(callCwd, '/proj')
    })

    it('passes null cwd when no active session', () => {
      const ctx = makeCtx()
      fileHandlers.append_memory(makeWs(), makeClient(), { type: 'append_memory', text: 'x' }, ctx)
      const [, , callCwd] = ctx.services.fileOps.appendMemory.lastCall
      assert.equal(callCwd, null)
    })
  })

  describe('git operations', () => {
    it('git_status passes session cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_status(makeWs(), client, {}, ctx)

      const [, callCwd] = ctx.services.fileOps.gitStatus.lastCall
      assert.equal(callCwd, '/repo')
    })

    it('git_branches passes session cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_branches(makeWs(), client, {}, ctx)

      const [, callCwd] = ctx.services.fileOps.gitBranches.lastCall
      assert.equal(callCwd, '/repo')
    })

    it('git_stage passes files and cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_stage(makeWs(), client, { files: ['a.js', 'b.js'] }, ctx)

      const [, callFiles, callCwd] = ctx.services.fileOps.gitStage.lastCall
      assert.deepEqual(callFiles, ['a.js', 'b.js'])
      assert.equal(callCwd, '/repo')
    })

    it('git_commit passes message and cwd', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/repo' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.git_commit(makeWs(), client, { message: 'fix: bug' }, ctx)

      const [, callMessage, callCwd] = ctx.services.fileOps.gitCommit.lastCall
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

      const [, callCwd, callSid] = ctx.services.fileOps.listSlashCommands.lastCall
      assert.equal(callCwd, '/proj')
      assert.equal(callSid, 's1')
    })

    it('list_slash_commands forwards the session provider (#3856)', () => {
      const sessions = new Map()
      sessions.set('s1', {
        session: createMockSession(),
        name: 'S',
        cwd: '/proj',
        provider: 'claude-sdk',
      })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.list_slash_commands(makeWs(), client, { sessionId: 's1' }, ctx)

      const [, , , callProvider] = ctx.services.fileOps.listSlashCommands.lastCall
      assert.equal(callProvider, 'claude-sdk')
    })

    it('list_slash_commands passes null provider when entry has none (#3856)', () => {
      // Legacy single-cliSession mode: resolveSession returns null, so no
      // provider is available. Built-ins shouldn't surface; project/user
      // commands still do.
      const ctx = makeCtx()
      const client = makeClient()

      fileHandlers.list_slash_commands(makeWs(), client, {}, ctx)

      const [, , , callProvider] = ctx.services.fileOps.listSlashCommands.lastCall
      assert.equal(callProvider, null)
    })

    it('list_agents passes cwd and session id', () => {
      const sessions = new Map()
      sessions.set('s1', { session: createMockSession(), name: 'S', cwd: '/proj' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      fileHandlers.list_agents(makeWs(), client, { sessionId: 's1' }, ctx)

      const [, callCwd, callSid] = ctx.services.fileOps.listAgents.lastCall
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

      const [, , , callOpts] = ctx.services.fileOps.listAgents.lastCall
      assert.ok(callOpts, 'opts argument must be passed')
      assert.deepEqual(callOpts.userAgentsDirs, userAgentsDirs)
    })

    it('list_agents passes empty opts when ctx has no userAgentsDirs', () => {
      const ctx = makeCtx()
      fileHandlers.list_agents(makeWs(), makeClient(), {}, ctx)

      const [, , , callOpts] = ctx.services.fileOps.listAgents.lastCall
      assert.ok(callOpts, 'opts argument must be passed')
      assert.ok(!callOpts.userAgentsDirs, 'userAgentsDirs must not be set when ctx lacks it')
    })
  })

  // #6541: file/git mutation handlers must reject pairing-bound (share-a-session)
  // tokens — a bound token can observe a session but must not overwrite files or
  // mutate git state. The primary token + the main app's UNBOUND linking token
  // still write. Mirrors the auto-mode/permission-rules/credential-write gates.
  describe('#6541 — bound-token mutation gate', () => {
    const MUTATIONS = [
      ['write_file', 'writeFile', { path: '/repo/x.js', content: 'x' }],
      ['append_memory', 'appendMemory', { text: 'a note' }],
      ['git_stage', 'gitStage', { files: ['x.js'] }],
      ['git_unstage', 'gitUnstage', { files: ['x.js'] }],
      ['git_commit', 'gitCommit', { message: 'm' }],
    ]

    for (const [type, method, msg] of MUTATIONS) {
      it(`${type}: rejects a pairing-bound token WITHOUT performing the mutation`, () => {
        const send = createSpy()
        const ctx = makeCtx(new Map(), { send })
        const ws = { readyState: 1 }
        fileHandlers[type](ws, makeClient({ boundSessionId: 'sess-1' }), { ...msg, requestId: 'r1' }, ctx)
        assert.equal(ctx.services.fileOps[method].callCount, 0, `${type} must be blocked for a bound token`)
        assert.equal(send.callCount, 1, 'a rejection error is sent')
        assert.equal(send.lastCall[1].code, 'FILE_MUTATION_FORBIDDEN_BOUND_CLIENT')
        assert.equal(send.lastCall[1].requestId, 'r1')
      })

      it(`${type}: allows an UNBOUND (primary / linking-mode) token`, () => {
        const send = createSpy()
        const ctx = makeCtx(new Map(), { send })
        const ws = { readyState: 1 }
        fileHandlers[type](ws, makeClient(), msg, ctx) // no boundSessionId
        assert.equal(ctx.services.fileOps[method].callCount, 1, `${type} must pass through for an unbound token`)
      })
    }

    it('read_file (non-mutation) is NOT gated for a bound token', () => {
      const ctx = makeCtx()
      fileHandlers.read_file({ readyState: 1 }, makeClient({ boundSessionId: 'sess-1' }), { path: '/repo/x.js' }, ctx)
      assert.equal(ctx.services.fileOps.readFile.callCount, 1, 'reads stay open to bound tokens')
    })
  })
})
