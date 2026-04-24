/**
 * Tests for SessionManager git worktree isolation.
 *
 * Each test uses a real temp git repo (git init) to exercise the actual
 * git worktree commands. The SessionManager is given a stub provider so
 * no real Claude process is spawned.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, renameSync } from 'fs'
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
    interrupt() {}
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
  const mgr = new SessionManager({ skipPreflight: true,
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

describe('SessionManager _removeWorktree fallback (#2460)', () => {
  let gitRepo
  let externalWorktreeBase

  beforeEach(() => {
    gitRepo = makeGitRepo()
    // Use a worktree base OUTSIDE the repo (mirrors production ~/.chroxy/worktrees/)
    // so that deleting the repo does not implicitly remove the worktree directory.
    externalWorktreeBase = mkdtempSync(join(tmpdir(), 'chroxy-wt-ext-'))
  })

  afterEach(() => {
    rmSync(gitRepo, { recursive: true, force: true })
    rmSync(externalWorktreeBase, { recursive: true, force: true })
  })

  it('falls back to rmSync when repoDir is deleted before worktree removal', () => {
    const mgr = makeManager(gitRepo)
    mgr._worktreeBase = externalWorktreeBase
    const sessionId = mgr.createSession({ cwd: gitRepo, worktree: true })
    const entry = mgr.getSession(sessionId)
    const wtPath = entry.worktreePath

    assert.ok(existsSync(wtPath), 'worktree directory should exist before destroy')
    // Worktree is outside gitRepo — verify it's in the external base
    assert.ok(wtPath.startsWith(externalWorktreeBase),
      'worktree should be in external base, not inside repo')

    // Simulate the original repo being deleted before cleanup
    const movedRepo = gitRepo + '-moved'
    renameSync(gitRepo, movedRepo)
    // Point gitRepo to moved path for afterEach cleanup
    gitRepo = movedRepo

    // Worktree directory still exists even though repo is gone
    assert.ok(existsSync(wtPath), 'worktree should still exist after repo is moved')

    // destroySession should clean up the worktree via rmSync fallback
    mgr.destroySession(sessionId)

    assert.ok(!existsSync(wtPath), 'worktree directory should be removed via rmSync fallback')

    mgr.destroyAll()
  })

  it('cleans up worktree via git when repoDir still exists (normal path)', () => {
    const mgr = makeManager(gitRepo)
    mgr._worktreeBase = externalWorktreeBase
    const sessionId = mgr.createSession({ cwd: gitRepo, worktree: true })
    const entry = mgr.getSession(sessionId)
    const wtPath = entry.worktreePath

    assert.ok(existsSync(wtPath), 'worktree should exist before destroy')

    mgr.destroySession(sessionId)

    assert.ok(!existsSync(wtPath), 'worktree should be removed via git worktree remove')

    mgr.destroyAll()
  })

  it('handles already-deleted worktree directory gracefully', () => {
    const mgr = makeManager(gitRepo)
    mgr._worktreeBase = externalWorktreeBase
    const sessionId = mgr.createSession({ cwd: gitRepo, worktree: true })
    const entry = mgr.getSession(sessionId)
    const wtPath = entry.worktreePath

    // Manually delete the worktree dir before destroySession
    rmSync(wtPath, { recursive: true, force: true })
    assert.ok(!existsSync(wtPath), 'worktree should already be gone')

    // Should not throw — both git removal and rmSync fallback handle missing dirs
    mgr.destroySession(sessionId)

    assert.ok(!existsSync(wtPath), 'worktree still absent after destroySession')

    mgr.destroyAll()
  })
})

describe('SessionManager isolation derivation (#2475)', () => {
  let gitRepo

  beforeEach(() => {
    gitRepo = makeGitRepo()
  })

  afterEach(() => {
    rmSync(gitRepo, { recursive: true, force: true })
  })

  it('default session has isolation "none"', () => {
    const mgr = makeManager(gitRepo)
    const sessionId = mgr.createSession({ cwd: gitRepo })
    const list = mgr.listSessions()
    const session = list.find(s => s.sessionId === sessionId)
    assert.equal(session.isolation, 'none')
    mgr.destroyAll()
  })

  it('worktree session derives isolation "worktree"', () => {
    const mgr = makeManager(gitRepo)
    const sessionId = mgr.createSession({ cwd: gitRepo, worktree: true })
    const list = mgr.listSessions()
    const session = list.find(s => s.sessionId === sessionId)
    assert.equal(session.isolation, 'worktree')
    mgr.destroyAll()
  })

  it('listSessions exposes isolation field', () => {
    const mgr = makeManager(gitRepo)
    const s1 = mgr.createSession({ cwd: gitRepo })
    const s2 = mgr.createSession({ cwd: gitRepo, worktree: true })
    const list = mgr.listSessions()
    const plain = list.find(s => s.sessionId === s1)
    const wt = list.find(s => s.sessionId === s2)
    assert.equal(plain.isolation, 'none')
    assert.equal(wt.isolation, 'worktree')
    mgr.destroyAll()
  })
})
