/**
 * Tests for SessionManager git worktree isolation.
 *
 * Each test uses a real temp git repo (git init) to exercise the actual
 * git worktree commands. The SessionManager is given a stub provider so
 * no real Claude process is spawned.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, renameSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { SessionManager, WorktreeError } from '../src/session-manager.js'
import { GIT } from '../src/git.js'
import { disableRepoAutoGc, rmDirRobust } from './test-helpers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

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

  declareUnknownCustomization(StubSession)
  registerProvider('stub-worktree', StubSession)

  // #5310 — a stub whose start() throws synchronously, to exercise the
  // createSession start-failure rollback during a restore-rebind.
  class FailStartSession extends StubSession {
    start() { throw new Error('simulated start failure on restore') }
  }
  registerProvider('stub-worktree-failstart', FailStartSession)
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
  disableRepoAutoGc(dir) // #6075: stop background gc racing the teardown rmSync
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
function makeManager(gitRepo, opts = {}) {
  const stateFile = join(gitRepo, 'session-state.json')
  const mgr = new SessionManager({ skipPreflight: true,
    maxSessions: 5,
    stateFilePath: stateFile,
    providerType: opts.providerType || 'stub-worktree',
    defaultCwd: gitRepo,
    sweepOrphanWorktrees: opts.sweepOrphanWorktrees === true,
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
    rmDirRobust(gitRepo)
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

  // destroyAll() is a process-shutdown teardown, NOT a user destroy. It must
  // PRESERVE worktrees so restoreState() can rebind them on the next start.
  // Pre-fix it deleted them, so on restart the serialized worktree sessions
  // pointed at directories that no longer existed and could never restore
  // (losing any uncommitted work in them).
  it('destroyAll PRESERVES worktrees for restore (does not delete them)', () => {
    const mgr = makeManager(gitRepo)

    const id1 = mgr.createSession({ cwd: gitRepo, worktree: true })
    const id2 = mgr.createSession({ cwd: gitRepo, worktree: true })

    const path1 = mgr.getSession(id1).worktreePath
    const path2 = mgr.getSession(id2).worktreePath

    assert.ok(existsSync(path1), 'worktree 1 should exist before destroyAll')
    assert.ok(existsSync(path2), 'worktree 2 should exist before destroyAll')

    mgr.destroyAll()

    assert.ok(existsSync(path1), 'worktree 1 must survive a shutdown destroyAll')
    assert.ok(existsSync(path2), 'worktree 2 must survive a shutdown destroyAll')
  })

  // End-to-end restart regression: a worktree session must survive a full
  // shutdown (destroyAll) + restart (fresh manager restoreState) cycle. This is
  // the realistic path destroyAll's worktree deletion broke.
  it('worktree session survives a destroyAll + restore restart cycle', () => {
    const mgr = makeManager(gitRepo)
    const id = mgr.createSession({ cwd: gitRepo, worktree: true })
    const wtPath = mgr.getSession(id).worktreePath
    assert.ok(wtPath && existsSync(wtPath), 'worktree created')

    // Drop an uncommitted file into the worktree to prove work is preserved.
    const scratch = join(wtPath, 'uncommitted-work.txt')
    writeFileSync(scratch, 'in-progress work that must not be deleted on shutdown')

    // Full shutdown: serializes state, then tears sessions down.
    mgr.destroyAll()
    assert.ok(existsSync(wtPath), 'worktree dir survives shutdown')
    assert.ok(existsSync(scratch), 'uncommitted work survives shutdown')

    // Restart: a fresh manager over the same state file rebinds the session.
    const mgr2 = makeManager(gitRepo)
    mgr2.restoreState()

    const r = mgr2.getSession(id)
    assert.ok(r, 'worktree session restored after restart')
    assert.equal(r.worktreePath, wtPath, 'rebound to the same worktree')
    assert.equal(r.isolation, 'worktree', 'isolation preserved across restart')
    assert.ok(existsSync(scratch), 'uncommitted work intact after restore')

    mgr2.destroySession(id)
    assert.ok(!existsSync(wtPath), 'explicit destroySession still GCs the worktree')
    mgr2.destroyAll()
  })

  // #5310 (WP-0.4) — the worktree binding must survive a daemon restart.
  // Pre-fix, serializeState dropped worktreePath/worktreeRepoDir, so a restored
  // session ran in the worktree dir but carried worktreePath:null — it never
  // GC'd the worktree on destroy (orphan accrual) and reported isolation:'none'.
  it('rebinds the worktree on restore (no recreate, GC works, isolation preserved) (#5310)', () => {
    const mgr = makeManager(gitRepo)
    const id = mgr.createSession({ cwd: gitRepo, worktree: true })
    const wtPath = mgr.getSession(id).worktreePath
    assert.ok(wtPath && existsSync(wtPath), 'worktree created')
    assert.equal(mgr.getSession(id).worktreeRepoDir, gitRepo, 'repo dir recorded for GC')

    // Persist, then simulate a restart with a fresh manager over the same state
    // file. Do NOT destroyAll — a real restart leaves the worktree dir on disk.
    mgr.serializeState()

    const mgr2 = makeManager(gitRepo) // makeManager sets the same _worktreeBase
    mgr2.restoreState()

    const r = mgr2.getSession(id)
    assert.ok(r, 'session restored under its preserved id')
    assert.equal(r.worktreePath, wtPath, 'rebound to the SAME worktree (not a new one)')
    assert.equal(r.worktreeRepoDir, gitRepo, 'worktreeRepoDir round-tripped (needed for git worktree remove)')
    assert.equal(r.isolation, 'worktree', 'isolation reported as worktree after restore')
    assert.equal(r.cwd, wtPath, 'cwd points at the worktree')
    assert.ok(existsSync(wtPath), 'rebind did not recreate/destroy the existing worktree')

    // The actual payoff: GC now works post-restore (pre-fix it leaked).
    mgr2.destroySession(id)
    assert.ok(!existsSync(wtPath), 'restored worktree session GCs its worktree on destroy')
    mgr2.destroyAll()
  })

  // #5310 — regression guard: a restore whose provider start() FAILS must NOT
  // delete the pre-existing worktree (it holds possibly-uncommitted work, and
  // deleting it would make the #2954-preserved retry unrecoverable). Only a
  // freshly-created worktree should roll back on start failure.
  it('does NOT delete the worktree when a restore-rebind start() fails (#5310)', () => {
    const mgr = makeManager(gitRepo)
    const id = mgr.createSession({ cwd: gitRepo, worktree: true })
    const wtPath = mgr.getSession(id).worktreePath
    assert.ok(existsSync(wtPath), 'worktree created')
    mgr.serializeState()

    // Simulate a provider that fails to start on restore by rewriting the
    // persisted provider to the fail-start stub, then restore.
    const stateFile = join(gitRepo, 'session-state.json')
    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'))
    persisted.sessions[0].provider = 'stub-worktree-failstart'
    writeFileSync(stateFile, JSON.stringify(persisted))

    const mgr2 = makeManager(gitRepo)
    mgr2.restoreState() // createSession → start() throws → sync rollback

    assert.ok(!mgr2.getSession(id), 'session not live after failed restore')
    assert.ok(existsSync(wtPath), 'pre-existing worktree MUST survive a failed restore-rebind')
    // #2954 — the failed session is preserved so a later retry can re-hydrate.
    assert.ok(mgr2._failedRestores.has(id), 'failed restore preserved for retry')

    mgr2.destroyAll()
  })

  // #5310 security review — restoreWorktreePath comes from the on-disk state and
  // becomes a recursive-deletion target in _removeWorktree. A corrupted/tampered
  // state file pointing it outside the per-session worktree dir must NOT be
  // rebound (and so must never be deleted on destroy).
  it('rejects a restored worktreePath outside the per-session worktree dir; never deletes it (#5310)', () => {
    const mgr = makeManager(gitRepo)
    const id = mgr.createSession({ cwd: gitRepo, worktree: true })
    mgr.serializeState()

    // Tamper: repoint worktreePath (and cwd, so the existence check passes) at a
    // sensitive directory outside the worktree base.
    const sensitive = mkdtempSync(join(tmpdir(), 'chroxy-sensitive-'))
    const sentinel = join(sensitive, 'keep.txt')
    writeFileSync(sentinel, 'do not delete')
    const stateFile = join(gitRepo, 'session-state.json')
    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'))
    persisted.sessions[0].worktreePath = sensitive
    persisted.sessions[0].cwd = sensitive
    writeFileSync(stateFile, JSON.stringify(persisted))

    const mgr2 = makeManager(gitRepo)
    mgr2.restoreState()
    const r = mgr2.getSession(id)
    assert.ok(r, 'session still restores (safe-degrade, not a hard failure)')
    assert.equal(r.worktreePath, null, 'tampered path is NOT rebound as a worktree')
    assert.equal(r.isolation, 'none')

    mgr2.destroySession(id)
    assert.ok(existsSync(sentinel), 'arbitrary directory MUST NOT be deleted on destroy')

    mgr2.destroyAll()
    rmSync(sensitive, { recursive: true, force: true })
  })

  // #8856 — the agent in a worktree session can delete its own cwd (a close-out
  // `git worktree remove --force`). The next restore must recreate the worktree
  // instead of parking the session as a failed restore that Retry can never fix.
  describe('restore recreates a deleted session worktree (#8856)', () => {
    function persistWithHistory(mgr, id) {
      mgr.serializeState()
      const stateFile = join(gitRepo, 'session-state.json')
      const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'))
      const entry = persisted.sessions.find((s) => s.id === id)
      entry.history = [
        { type: 'user', content: 'before the worktree was deleted' },
        { type: 'response', content: 'still here after restore' },
      ]
      writeFileSync(stateFile, JSON.stringify(persisted))
      return { stateFile, persisted }
    }

    it('recreates a worktree removed with `git worktree remove` and restores the session', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      persistWithHistory(mgr, id)
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' })
      assert.equal(existsSync(wtPath), false, 'precondition: the worktree is gone')

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.equal(mgr2._failedRestores.has(id), false, 'not parked as a failed restore')
      const r = mgr2.getSession(id)
      assert.ok(r, 'session restored under its preserved id')
      assert.equal(r.worktreePath, wtPath, 'rebound to the same per-session path')
      assert.equal(r.cwd, wtPath)
      assert.equal(r.isolation, 'worktree')
      assert.ok(existsSync(join(wtPath, '.git')), 'a real git worktree exists again at the path')
      const history = mgr2._history.getHistory(id)
      assert.deepEqual(history.map((h) => h.content), ['before the worktree was deleted', 'still here after restore'])

      mgr2.destroySession(id)
      assert.equal(existsSync(wtPath), false, 'the recreated worktree is still GC\'d on destroy')
      mgr2.destroyAll()
    })

    it('recreates a worktree deleted without git (still registered but missing)', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      persistWithHistory(mgr, id)
      rmSync(wtPath, { recursive: true, force: true })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      const r = mgr2.getSession(id)
      assert.ok(r, 'restored despite git still listing the missing worktree')
      assert.equal(r.worktreePath, wtPath)
      assert.ok(existsSync(join(wtPath, '.git')), 'worktree recreated over the stale registration')
      mgr2.destroyAll()
    })

    it('stays parked, naming the repository, when the repository is gone too; Retry recovers once it is back', async () => {
      const otherRepo = makeGitRepo()
      const movedRepo = `${otherRepo}-moved`
      let mgr2
      try {
        const mgr = makeManager(gitRepo)
        const id = mgr.createSession({ cwd: otherRepo, worktree: true })
        const wtPath = mgr.getSession(id).worktreePath
        persistWithHistory(mgr, id)
        execFileSync(GIT, ['-C', otherRepo, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' })
        renameSync(otherRepo, movedRepo)

        mgr2 = makeManager(gitRepo)
        const failures = []
        mgr2.on('session_restore_failed', (e) => failures.push(e))
        mgr2.restoreState()

        assert.equal(mgr2.getSession(id), null, 'not restored')
        assert.ok(mgr2._failedRestores.has(id), 'parked for retry with history preserved')
        assert.equal(failures.length, 1)
        assert.equal(failures[0].errorCode, 'INVALID_DIRECTORY')
        assert.ok(failures[0].errorMessage.includes(otherRepo), 'the error names the missing repository')
        assert.equal(existsSync(wtPath), false, 'nothing created at the worktree path')

        // Retry runs the same path: with the repository back, it succeeds.
        renameSync(movedRepo, otherRepo)
        const result = await mgr2.retryFailedRestore(id)
        assert.deepEqual(result, { ok: true, sessionId: id })
        assert.equal(mgr2._failedRestores.has(id), false)
        assert.equal(mgr2.getSession(id).worktreePath, wtPath)
        assert.ok(existsSync(join(wtPath, '.git')), 'Retry recreated the worktree')
        assert.equal(mgr2._history.getHistory(id).length, 2, 'history re-seeded by the retry')
      } finally {
        mgr2?.destroyAll()
        if (existsSync(movedRepo)) renameSync(movedRepo, otherRepo)
        rmDirRobust(otherRepo)
      }
    })

    it('recreates a worktree deleted without git at its last HEAD, keeping its detached commits referenced', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      execFileSync(GIT, ['-C', wtPath, 'commit', '--allow-empty', '-m', 'work on the detached HEAD'], { stdio: 'pipe' })
      const sessionHead = execFileSync(GIT, ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      const repoHead = execFileSync(GIT, ['-C', gitRepo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      assert.notEqual(sessionHead, repoHead, 'precondition: the session advanced past the repo HEAD')
      persistWithHistory(mgr, id)
      rmSync(wtPath, { recursive: true, force: true })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.ok(mgr2.getSession(id), 'restored')
      const recreatedHead = execFileSync(GIT, ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      assert.equal(recreatedHead, sessionHead, 'checked out at the commit the session last had, not the repo HEAD')
      mgr2.destroyAll()
    })

    // Shared setup for the "deleted without git" cases: a session that has
    // committed past the repo HEAD on its detached HEAD, then had its dir
    // rm -rf'd so git still holds the registration (and the only ref to it).
    function sessionWithDetachedCommitThenRmRf() {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      execFileSync(GIT, ['-C', wtPath, 'commit', '--allow-empty', '-m', 'only on the detached HEAD'], { stdio: 'pipe' })
      const sessionHead = execFileSync(GIT, ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      persistWithHistory(mgr, id)
      rmSync(wtPath, { recursive: true, force: true })
      return { id, wtPath, sessionHead }
    }
    const registeredHeads = () => execFileSync(GIT, ['-C', gitRepo, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8' })
    const recoveryRef = (id) => {
      try {
        return execFileSync(GIT, ['-C', gitRepo, 'rev-parse', '--verify', '--quiet', `refs/chroxy/worktree-recovery/${id}`], { encoding: 'utf-8', stdio: 'pipe' }).trim()
      } catch {
        return null
      }
    }

    it('replaces nothing when the registered HEAD cannot be read', () => {
      const { id, sessionHead } = sessionWithDetachedCommitThenRmRf()

      const mgr2 = makeManager(gitRepo)
      mgr2._registeredWorktreeHead = () => null // the lookup is uncertain
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.ok(mgr2._failedRestores.has(id), 'parked for retry')
      assert.ok(registeredHeads().includes(sessionHead), 'the registration still holds the session commit')
      mgr2.destroyAll()
    })

    it('keeps the session commit pinned when the forced recreation fails, and Retry recovers it', async () => {
      const { id, wtPath, sessionHead } = sessionWithDetachedCommitThenRmRf()

      const mgr2 = makeManager(gitRepo)
      const realAdd = mgr2._addDetachedWorktree.bind(mgr2)
      mgr2._addDetachedWorktree = (repoDir, dir, opts) => {
        if (opts?.force) {
          // Model git's own failure order: the stale registration goes first.
          execFileSync(GIT, ['-C', repoDir, 'worktree', 'prune'], { stdio: 'pipe' })
          throw new Error('simulated checkout failure')
        }
        return realAdd(repoDir, dir, opts)
      }
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.equal(registeredHeads().includes(sessionHead), false, 'precondition: the registration is gone')
      assert.equal(recoveryRef(id), sessionHead, 'the session commit is pinned by the recovery ref')

      mgr2._addDetachedWorktree = realAdd
      const result = await mgr2.retryFailedRestore(id)
      assert.deepEqual(result, { ok: true, sessionId: id })
      const head = execFileSync(GIT, ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      assert.equal(head, sessionHead, 'Retry checked out the pinned commit, not the repo HEAD')
      assert.equal(recoveryRef(id), null, 'the pin is dropped once the checkout references the commit')
      mgr2.destroyAll()
    })

    it('refuses a stale pin that differs from a live registration', () => {
      const { id, sessionHead } = sessionWithDetachedCommitThenRmRf()
      const repoHead = execFileSync(GIT, ['-C', gitRepo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      execFileSync(GIT, ['-C', gitRepo, 'update-ref', `refs/chroxy/worktree-recovery/${id}`, repoHead], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.ok(registeredHeads().includes(sessionHead), 'the newer registered commit is not replaced')
      mgr2.destroyAll()
    })

    it('refuses a pin when the registrations cannot be read', () => {
      const { id, sessionHead } = sessionWithDetachedCommitThenRmRf()
      const repoHead = execFileSync(GIT, ['-C', gitRepo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      execFileSync(GIT, ['-C', gitRepo, 'update-ref', `refs/chroxy/worktree-recovery/${id}`, repoHead], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      mgr2._registeredWorktreeHead = () => undefined // `git worktree list` failed
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.ok(registeredHeads().includes(sessionHead), 'the registration is not replaced')
      mgr2.destroyAll()
    })

    it('ignores a pin that does not name a commit', () => {
      const { id, wtPath, sessionHead } = sessionWithDetachedCommitThenRmRf()
      const tree = execFileSync(GIT, ['-C', gitRepo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf-8' }).trim()
      execFileSync(GIT, ['-C', gitRepo, 'update-ref', `refs/chroxy/worktree-recovery/${id}`, tree], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.ok(mgr2.getSession(id), 'restored from the registration instead')
      const head = execFileSync(GIT, ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      assert.equal(head, sessionHead)
      mgr2.destroyAll()
    })

    it('finds the registered HEAD when the whole worktree base was deleted', () => {
      const { id, wtPath, sessionHead } = sessionWithDetachedCommitThenRmRf()
      rmSync(dirname(wtPath), { recursive: true, force: true })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.ok(mgr2.getSession(id), 'restored')
      const head = execFileSync(GIT, ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      assert.equal(head, sessionHead, 'matched the registration through the nearest existing ancestor')
      mgr2.destroyAll()
    })

    it('does not run the repository hooks while recreating', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      persistWithHistory(mgr, id)
      const marker = join(gitRepo, 'hook-ran')
      const hooksDir = join(gitRepo, '.git', 'hooks')
      writeFileSync(join(hooksDir, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
      // Pin where git looks for hooks, then prove this fixture's hook DOES run
      // on an ordinary worktree add — otherwise "no marker" proves nothing.
      execFileSync(GIT, ['-C', gitRepo, 'config', 'core.hooksPath', hooksDir], { stdio: 'pipe' })
      const control = join(gitRepo, 'hook-control-wt')
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'add', '--detach', control, 'HEAD'], { stdio: 'pipe' })
      assert.ok(existsSync(marker), 'positive control: the hook runs on a plain worktree add')
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'remove', '--force', control], { stdio: 'pipe' })
      rmSync(marker)
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.ok(mgr2.getSession(id), 'restored')
      assert.equal(existsSync(marker), false, 'post-checkout hook did not run')
      mgr2.destroyAll()
    })

    it('binds the canonical worktree path when the persisted spelling only resolves lexically', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      const { stateFile, persisted } = persistWithHistory(mgr, id)
      // Built by hand: join() would normalise the '..' away.
      const odd = `${mgr._worktreeBase}/gone/../${id}`
      persisted.sessions[0].worktreePath = odd
      persisted.sessions[0].cwd = odd
      writeFileSync(stateFile, JSON.stringify(persisted))
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      const r = mgr2.getSession(id)
      assert.ok(r, 'restored')
      assert.equal(r.cwd, wtPath, 'cwd is the canonical path that was recreated')
      assert.equal(r.worktreePath, wtPath)
      assert.ok(existsSync(r.cwd), 'the bound cwd exists on disk')
      mgr2.destroyAll()
    })

    it('stays parked when the recorded repository is a relative path', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      const { stateFile, persisted } = persistWithHistory(mgr, id)
      persisted.sessions[0].worktreeRepoDir = '.'
      writeFileSync(stateFile, JSON.stringify(persisted))
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      const failures = []
      mgr2.on('session_restore_failed', (e) => failures.push(e))
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.ok(failures[0].errorMessage.includes('not an absolute path'), failures[0].errorMessage)
      assert.equal(existsSync(wtPath), false, 'nothing created from the daemon cwd')
      mgr2.destroyAll()
    })

    it('stays parked when the state entry records no repository for the worktree', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      const { stateFile, persisted } = persistWithHistory(mgr, id)
      delete persisted.sessions[0].worktreeRepoDir
      writeFileSync(stateFile, JSON.stringify(persisted))
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'remove', '--force', wtPath], { stdio: 'pipe' })

      const mgr2 = makeManager(gitRepo)
      const failures = []
      mgr2.on('session_restore_failed', (e) => failures.push(e))
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.ok(mgr2._failedRestores.has(id), 'parked for retry')
      assert.ok(failures[0].errorMessage.includes('no repository is recorded'), failures[0].errorMessage)
      assert.equal(existsSync(wtPath), false, 'nothing created from the daemon cwd')
      mgr2.destroyAll()
    })

    it('never recreates at a tampered worktreePath outside the per-session dir (#5310)', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      persistWithHistory(mgr, id)
      const elsewhere = join(mkdtempSync(join(tmpdir(), 'chroxy-tamper-')), 'not-a-worktree')
      const stateFile = join(gitRepo, 'session-state.json')
      const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'))
      persisted.sessions[0].worktreePath = elsewhere
      persisted.sessions[0].cwd = elsewhere
      writeFileSync(stateFile, JSON.stringify(persisted))

      const mgr2 = makeManager(gitRepo)
      mgr2.restoreState()

      assert.equal(mgr2.getSession(id), null, 'not restored')
      assert.ok(mgr2._failedRestores.has(id), 'parked exactly as before #8856')
      assert.equal(existsSync(elsewhere), false, 'no checkout created at the tampered path')
      mgr2.destroyAll()
      rmSync(dirname(elsewhere), { recursive: true, force: true })
    })
  })

  it('a non-worktree session restores with no worktree binding (#5310 back-compat)', () => {
    const mgr = makeManager(gitRepo)
    const id = mgr.createSession({ cwd: gitRepo }) // no worktree
    mgr.serializeState()
    const mgr2 = makeManager(gitRepo)
    mgr2.restoreState()
    const r = mgr2.getSession(id)
    assert.equal(r.worktreePath, null, 'no worktree binding on a plain session')
    assert.equal(r.isolation, 'none')
    mgr.destroyAll()
    mgr2.destroyAll()
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
    rmDirRobust(gitRepo)
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
    rmDirRobust(gitRepo)
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

  // audit P1-7 (#5859): the boot-time orphan sweep, exercised through restoreState.
  describe('orphan worktree boot sweep (sweepOrphanWorktrees)', () => {
    it('sweeps a genuinely-orphaned clean worktree dir but keeps live sessions', () => {
      const mgr = makeManager(gitRepo)
      const liveId = mgr.createSession({ cwd: gitRepo, worktree: true })
      const liveWt = mgr.getSession(liveId).worktreePath
      // Fabricate an orphan: a real worktree under the base whose id is in NO
      // session state (as if its session vanished via SIGKILL).
      const orphanId = '0000000000000000000000000000dead'
      const orphanWt = join(mgr._worktreeBase, orphanId)
      execFileSync(GIT, ['-C', gitRepo, 'worktree', 'add', '--detach', orphanWt, 'HEAD'], { stdio: 'pipe' })
      mgr.serializeState()

      // Restart with the sweep enabled.
      const mgr2 = makeManager(gitRepo, { sweepOrphanWorktrees: true })
      mgr2.restoreState()

      assert.ok(existsSync(liveWt), 'live session worktree preserved')
      assert.equal(existsSync(orphanWt), false, 'orphaned worktree swept')
      mgr2.destroyAll()
    })

    it('does NOT sweep a failed-restore session worktree (#2954 retry preservation)', () => {
      const mgr = makeManager(gitRepo)
      const id = mgr.createSession({ cwd: gitRepo, worktree: true })
      const wtPath = mgr.getSession(id).worktreePath
      assert.ok(existsSync(wtPath), 'worktree created')
      mgr.serializeState()

      // Rewrite the persisted provider to the fail-start stub so THIS session's
      // restore throws (mirrors the #5310 failed-restore test), then restart
      // with the sweep enabled. The failed session lands in _failedRestores
      // keyed by its original id (= worktree dir basename) — its clean worktree
      // must be preserved for retry, not swept as an orphan (#2954).
      const stateFile = join(gitRepo, 'session-state.json')
      const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'))
      persisted.sessions[0].provider = 'stub-worktree-failstart'
      writeFileSync(stateFile, JSON.stringify(persisted))

      const mgr2 = makeManager(gitRepo, { sweepOrphanWorktrees: true })
      mgr2.restoreState()

      assert.ok(!mgr2.getSession(id), 'session did not restore (start threw)')
      assert.ok(mgr2._failedRestores.has(id), 'recorded as a failed restore for retry')
      assert.ok(existsSync(wtPath), 'failed-restore worktree preserved, not swept (#2954)')
      mgr2.destroyAll()
    })
  })
})
