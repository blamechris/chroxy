/**
 * Tests for SessionManager git worktree isolation.
 *
 * Each test uses a real temp git repo (git init) to exercise the actual
 * git worktree commands. The SessionManager is given a stub provider so
 * no real Claude process is spawned.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { SessionManager, WorktreeError } from '../src/session-manager.js'
import { GIT } from '../src/git.js'

// ---------------------------------------------------------------------------
// Register a no-op stub provider (avoids importing real SDK/CLI sessions)
// ---------------------------------------------------------------------------

before(async () => {
  const { registerProvider } = await import('../src/providers.js')

  class StubSession extends EventEmitter {
    constructor({ cwd, model, permissionMode }) {
      super()
      this.cwd = cwd
      this.model = model || 'stub'
      this.permissionMode = permissionMode || 'approve'
      this.isRunning = false
      this.resumeSessionId = null
    }

    static get capabilities() {
      return {
        permissions: false,
        inProcessPermissions: false,
        modelSwitch: false,
        permissionModeSwitch: false,
        planMode: false,
        resume: false,
        terminal: false,
        thinkingLevel: false,
      }
    }

    start() {}
    destroy() {}
    sendMessage() {}
    setModel(m) { this.model = m }
    setPermissionMode(m) { this.permissionMode = m }
  }

  registerProvider('stub-worktree', StubSession)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a real git repository in a temp directory with an initial commit.
 * Returns the repo path. Caller is responsible for cleanup.
 */
function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-wt-test-'))
  execFileSync(GIT, ['init', '--initial-branch=main', dir], { stdio: 'pipe' })
  execFileSync(GIT, ['-C', dir, 'config', 'user.email', 'test@chroxy.test'], { stdio: 'pipe' })
  execFileSync(GIT, ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
  // worktree add requires at least one commit so HEAD is valid
  execFileSync(GIT, ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  return dir
}

/**
 * Create a SessionManager backed by the stub provider.
 * Worktrees are created inside the given gitRepo to keep temp files local.
 */
function makeManager(gitRepo) {
  const stateFile = join(gitRepo, 'session-state.json')
  const mgr = new SessionManager({
    maxSessions: 5,
    stateFilePath: stateFile,
    providerType: 'stub-worktree',
    defaultCwd: gitRepo,
  })
  // Redirect worktrees into the temp dir rather than ~/.chroxy/worktrees
  mgr._worktreeBase = join(gitRepo, 'worktrees')
  return mgr
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager worktree isolation', () => {
  let gitRepo

  beforeEach(() => {
    gitRepo = makeGitRepo()
  })

  afterEach(() => {
    rmSync(gitRepo, { recursive: true, force: true })
  })

  it('creates a worktree directory when worktree:true is passed', () => {
    const mgr = makeManager(gitRepo)
    const sessionId = mgr.createSession({ cwd: gitRepo, worktree: true })

    const entry = mgr.getSession(sessionId)
    assert.ok(entry, 'session entry should exist')
    assert.ok(entry.worktreePath, 'worktreePath should be set on the entry')
    assert.ok(existsSync(entry.worktreePath), 'worktree directory should exist on disk')
    assert.notEqual(entry.cwd, gitRepo, 'session cwd should differ from original repo')
    assert.equal(entry.cwd, entry.worktreePath, 'session cwd should point to the worktree')

    mgr.destroyAll()
  })

  it('session provider receives the worktree path as its cwd', () => {
    const mgr = makeManager(gitRepo)
    const sessionId = mgr.createSession({ cwd: gitRepo, worktree: true })
    const entry = mgr.getSession(sessionId)

    assert.equal(entry.session.cwd, entry.worktreePath,
      'provider cwd must be the worktree path, not the original repo')

    mgr.destroyAll()
  })

  it('destroySession removes the worktree directory', () => {
    const mgr = makeManager(gitRepo)

    // Need a second session so destroy does not hit "last session" guard in handler
    // (the guard is in the handler, not SessionManager itself, so we can directly destroy)
    const id1 = mgr.createSession({ cwd: gitRepo, worktree: true })
    const wtPath = mgr.getSession(id1).worktreePath

    assert.ok(existsSync(wtPath), 'worktree should exist before destroySession')

    mgr.destroySession(id1)

    assert.ok(!existsSync(wtPath), 'worktree directory should be removed after destroySession')

    mgr.destroyAll()
  })

  it('destroyAll removes all worktrees', () => {
    const mgr = makeManager(gitRepo)

    const id1 = mgr.createSession({ cwd: gitRepo, worktree: true })
    const id2 = mgr.createSession({ cwd: gitRepo, worktree: true })

    const path1 = mgr.getSession(id1).worktreePath
    const path2 = mgr.getSession(id2).worktreePath

    assert.ok(existsSync(path1), 'worktree 1 should exist before destroyAll')
    assert.ok(existsSync(path2), 'worktree 2 should exist before destroyAll')

    mgr.destroyAll()

    assert.ok(!existsSync(path1), 'worktree 1 should be removed after destroyAll')
    assert.ok(!existsSync(path2), 'worktree 2 should be removed after destroyAll')
  })

  it('rejects worktree:true when cwd is not a git repository', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'chroxy-nongit-'))
    try {
      const mgr = makeManager(nonGitDir)
      assert.throws(
        () => mgr.createSession({ cwd: nonGitDir, worktree: true }),
        (err) => {
          assert.ok(err instanceof WorktreeError,
            `expected WorktreeError, got ${err.constructor.name}: ${err.message}`)
          assert.ok(err.message.includes('Not a git repository'),
            `expected "Not a git repository" in: ${err.message}`)
          return true
        }
      )
      mgr.destroyAll()
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true })
    }
  })

  it('sessions without worktree:true behave as before', () => {
    const mgr = makeManager(gitRepo)
    const sessionId = mgr.createSession({ cwd: gitRepo })
    const entry = mgr.getSession(sessionId)

    assert.equal(entry.worktreePath, null,
      'worktreePath should be null for non-worktree sessions')
    assert.equal(entry.cwd, gitRepo,
      'cwd should be the original directory for non-worktree sessions')

    mgr.destroyAll()
  })

  it('listSessions reports worktree:true for worktree sessions only', () => {
    const mgr = makeManager(gitRepo)

    mgr.createSession({ cwd: gitRepo })
    mgr.createSession({ cwd: gitRepo, worktree: true })

    const list = mgr.listSessions()
    assert.equal(list.length, 2)

    const regular = list.find(s => !s.worktree)
    const isolated = list.find(s => s.worktree)

    assert.ok(regular, 'non-worktree session should appear in list')
    assert.ok(isolated, 'worktree session should appear in list')
    assert.equal(regular.worktree, false)
    assert.equal(isolated.worktree, true)

    mgr.destroyAll()
  })

  it('concurrent worktree sessions receive independent directories', () => {
    const mgr = makeManager(gitRepo)

    const id1 = mgr.createSession({ cwd: gitRepo, worktree: true })
    const id2 = mgr.createSession({ cwd: gitRepo, worktree: true })

    const path1 = mgr.getSession(id1).worktreePath
    const path2 = mgr.getSession(id2).worktreePath

    assert.notEqual(path1, path2, 'concurrent worktrees must use distinct directories')
    assert.ok(existsSync(path1), 'worktree 1 directory exists')
    assert.ok(existsSync(path2), 'worktree 2 directory exists')

    mgr.destroyAll()
  })
})
