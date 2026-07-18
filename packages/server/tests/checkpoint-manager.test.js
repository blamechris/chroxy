import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { CheckpointManager } from '../src/checkpoint-manager.js'
import { GIT, disableRepoAutoGc, rmDirRobust } from './test-helpers.js'

// Create a temporary git repo for testing
function createTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-cp-test-'))
  execFileSync(GIT, ['init'], { cwd: dir })
  disableRepoAutoGc(dir) // #6075: stop background gc racing the teardown rmSync
  execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'file.txt'), 'initial content')
  execFileSync(GIT, ['add', '.'], { cwd: dir })
  execFileSync(GIT, ['commit', '-m', 'initial'], { cwd: dir })
  return dir
}

describe('CheckpointManager', () => {
  let manager
  let gitDir
  let tmpCheckpointsDir

  beforeEach(() => {
    // Pass a tmp checkpointsDir so the manager doesn't write to the
    // developer's real ~/.chroxy/checkpoints/ (sandbox guard in
    // tests/_setup.mjs blocks it; see #4633).
    tmpCheckpointsDir = mkdtempSync(join(tmpdir(), 'chroxy-cp-state-'))
    manager = new CheckpointManager({ checkpointsDir: tmpCheckpointsDir })
    // Clear any persisted state from prior tests
    manager.clearCheckpoints('sess-1')
    gitDir = createTempGitRepo()
  })

  afterEach(() => {
    rmDirRobust(gitDir)
    try { rmDirRobust(tmpCheckpointsDir) } catch {}
  })

  it('creates a checkpoint with metadata', async () => {
    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-abc',
      cwd: gitDir,
      name: 'Before query',
      description: 'User asked about auth',
      messageCount: 5,
    })

    assert.ok(cp.id)
    assert.equal(cp.sessionId, 'sess-1')
    assert.equal(cp.resumeSessionId, 'sdk-abc')
    assert.equal(cp.name, 'Before query')
    assert.equal(cp.description, 'User asked about auth')
    assert.equal(cp.messageCount, 5)
    assert.ok(cp.createdAt > 0)
    assert.ok(cp.gitRef) // should have a git tag
  })

  // #6766: the fork boundary must round-trip through create → restore so the
  // restore handler can truncate the conversation to the checkpoint's point.
  it('stores the boundaryMessageId and returns it on restore (#6766)', async () => {
    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-abc',
      cwd: gitDir,
      name: 'Before query',
      messageCount: 3,
      boundaryMessageId: 'uuid-boundary-1',
    })
    assert.equal(cp.boundaryMessageId, 'uuid-boundary-1')

    const restored = await manager.restoreCheckpoint('sess-1', cp.id)
    assert.equal(restored.boundaryMessageId, 'uuid-boundary-1', 'restore returns the fork boundary')
  })

  // #6766: providers that can't supply a boundary (subprocess providers) must
  // land as an explicit null so restore honestly degrades to files-only.
  it('defaults boundaryMessageId to null when absent (#6766)', async () => {
    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-abc',
      cwd: gitDir,
      name: 'No boundary',
      messageCount: 1,
    })
    assert.equal(cp.boundaryMessageId, null)
  })

  it('#5731 (T3): emits checkpoint_persist_failed when the disk write fails, but still returns the checkpoint', async () => {
    // Root bypasses DAC permission checks, so the read-only-dir trick can't force
    // a write failure when run as uid 0 (Docker/devcontainer) — skip there, mirroring
    // permission-hook-sidecar-integration.test.js.
    if (process.getuid && process.getuid() === 0) return
    // Read-only checkpoints dir → writeFileRestricted can't create the file.
    const roDir = mkdtempSync(join(tmpdir(), 'chroxy-cp-ro-'))
    chmodSync(roDir, 0o555)
    const roManager = new CheckpointManager({ checkpointsDir: roDir })
    let failed = null
    roManager.on('checkpoint_persist_failed', (e) => { failed = e })
    try {
      const cp = await roManager.createCheckpoint({
        sessionId: 'sess-ro', resumeSessionId: 'sdk-x', cwd: gitDir, name: 'x', messageCount: 1,
      })
      // The checkpoint exists in memory and is returned (the user sees it)...
      assert.ok(cp.id)
      assert.equal(roManager.listCheckpoints('sess-ro').length, 1)
      // ...but the failed disk write is surfaced so the user knows it isn't durable.
      assert.ok(failed, 'should emit checkpoint_persist_failed')
      assert.equal(failed.sessionId, 'sess-ro')
      assert.equal(failed.operation, 'create')
    } finally {
      chmodSync(roDir, 0o755)
      try { rmSync(roDir, { recursive: true, force: true }) } catch {}
    }
  })

  it('lists checkpoints for a session', async () => {
    await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: gitDir,
      name: 'CP 1',
    })
    await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-2',
      cwd: gitDir,
      name: 'CP 2',
    })

    const list = manager.listCheckpoints('sess-1')
    assert.equal(list.length, 2)
    assert.equal(list[0].name, 'CP 1')
    assert.equal(list[1].name, 'CP 2')
    assert.ok(list[0].hasGitSnapshot)
  })

  it('returns empty list for unknown session', () => {
    const list = manager.listCheckpoints('unknown')
    assert.equal(list.length, 0)
  })

  it('deletes a checkpoint', async () => {
    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: gitDir,
    })

    manager.deleteCheckpoint('sess-1', cp.id)
    const list = manager.listCheckpoints('sess-1')
    assert.equal(list.length, 0)
  })

  it('restores a checkpoint and returns the data with correct file state', async () => {
    // Make some changes after the initial commit
    writeFileSync(join(gitDir, 'file.txt'), 'modified content')

    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-abc',
      cwd: gitDir,
    })

    // Modify the file further
    writeFileSync(join(gitDir, 'file.txt'), 'further changes')

    const restored = await manager.restoreCheckpoint('sess-1', cp.id)
    assert.equal(restored.resumeSessionId, 'sdk-abc')

    // Verify file content was restored to the checkpoint state
    const content = readFileSync(join(gitDir, 'file.txt'), 'utf8')
    assert.equal(content, 'modified content')
  })

  it('captures and restores git state with untracked files', async () => {
    writeFileSync(join(gitDir, 'new-file.txt'), 'untracked content')

    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: gitDir,
    })

    assert.ok(cp.gitRef)

    // Remove the untracked file and verify restore brings it back
    rmSync(join(gitDir, 'new-file.txt'))
    await manager.restoreCheckpoint('sess-1', cp.id)

    const content = readFileSync(join(gitDir, 'new-file.txt'), 'utf8')
    assert.equal(content, 'untracked content')
  })

  it('works in clean git state (no changes)', async () => {
    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: gitDir,
    })

    assert.ok(cp.gitRef) // tags HEAD when clean
  })

  it('enforces max checkpoints per session', async () => {
    // Override for test speed — create 3 and check oldest is removed
    const originalMax = 50
    for (let i = 0; i < originalMax + 1; i++) {
      await manager.createCheckpoint({
        sessionId: 'sess-1',
        resumeSessionId: `sdk-${i}`,
        cwd: gitDir,
        name: `CP ${i}`,
      })
    }

    const list = manager.listCheckpoints('sess-1')
    assert.equal(list.length, originalMax)
    // First checkpoint should have been evicted
    assert.equal(list[0].name, 'CP 1') // CP 0 was evicted
  })

  it('clears all checkpoints for a session', async () => {
    await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: gitDir,
    })
    await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-2',
      cwd: gitDir,
    })

    manager.clearCheckpoints('sess-1')
    assert.equal(manager.listCheckpoints('sess-1').length, 0)
  })

  it('emits checkpoint_created event', async () => {
    let emitted = null
    manager.on('checkpoint_created', (cp) => { emitted = cp })

    await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: gitDir,
    })

    assert.ok(emitted)
    assert.equal(emitted.sessionId, 'sess-1')
  })

  it('handles non-git directory gracefully', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'chroxy-cp-nogit-'))

    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-1',
      cwd: nonGitDir,
    })

    assert.ok(cp.id)
    assert.equal(cp.gitRef, null) // No git ref for non-git dir

    rmSync(nonGitDir, { recursive: true, force: true })
  })

  it('git stash stack is untouched after creating a checkpoint with dirty changes', async () => {
    // Snapshot uses commit-tree, not git stash push — stash list must remain empty
    writeFileSync(join(gitDir, 'file.txt'), 'dirty content')

    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-stash-test',
      cwd: gitDir,
    })

    assert.ok(cp.gitRef)

    // The working tree must be unchanged (index-only operations, no stash pop)
    const content = readFileSync(join(gitDir, 'file.txt'), 'utf8')
    assert.equal(content, 'dirty content', 'working tree must be unchanged after snapshot creation')

    // The shared stash stack must remain empty
    // execFileSync returns the stdout string directly when encoding is provided
    const stashList = execFileSync(GIT, ['stash', 'list'], { cwd: gitDir, encoding: 'utf8' })
    assert.equal(stashList.trim(), '', 'git stash stack must be empty after checkpoint creation')
  })

  it('concurrent checkpoints on the same cwd serialise and produce independent snapshots', async () => {
    // Two sessions checkpoint the same repo concurrently.
    // Without the per-cwd mutex the git index operations (write-tree / add -A
    // / read-tree) would interleave and produce incorrect snapshot trees.
    writeFileSync(join(gitDir, 'file.txt'), 'shared baseline')
    execFileSync(GIT, ['add', '.'], { cwd: gitDir })
    execFileSync(GIT, ['commit', '-m', 'baseline'], { cwd: gitDir })

    // Session A has one pending untracked file, Session B has another.
    // Both create checkpoints concurrently to stress the mutex.
    const cpAPromise = (async () => {
      writeFileSync(join(gitDir, 'a.txt'), 'session-a content')
      return manager.createCheckpoint({
        sessionId: 'sess-a',
        resumeSessionId: 'sdk-a',
        cwd: gitDir,
      })
    })()

    const cpBPromise = (async () => {
      writeFileSync(join(gitDir, 'b.txt'), 'session-b content')
      return manager.createCheckpoint({
        sessionId: 'sess-b',
        resumeSessionId: 'sdk-b',
        cwd: gitDir,
      })
    })()

    const [cpA, cpB] = await Promise.all([cpAPromise, cpBPromise])

    // Both must succeed and have distinct refs
    assert.ok(cpA.gitRef, 'session A must have a git ref')
    assert.ok(cpB.gitRef, 'session B must have a git ref')
    assert.notEqual(cpA.gitRef, cpB.gitRef, 'git refs must be distinct')

    // Stash stack must still be empty — commit-tree is used, not git stash push
    const stashList = execFileSync(GIT, ['stash', 'list'], { cwd: gitDir, encoding: 'utf8' })
    assert.equal(stashList.trim(), '', 'git stash stack must be empty after concurrent checkpoints')
  })

  it('restore applies the correct snapshot tree when tag points to a snapshot commit', async () => {
    // Write a dirty file so a snapshot commit is produced (not just HEAD tag)
    writeFileSync(join(gitDir, 'file.txt'), 'checkpoint content')

    const cp = await manager.createCheckpoint({
      sessionId: 'sess-1',
      resumeSessionId: 'sdk-restore-sha',
      cwd: gitDir,
    })

    assert.ok(cp.gitRef)

    // Overwrite the file and commit after checkpoint
    writeFileSync(join(gitDir, 'file.txt'), 'post-checkpoint change')
    execFileSync(GIT, ['add', '.'], { cwd: gitDir })
    execFileSync(GIT, ['commit', '-m', 'post-checkpoint'], { cwd: gitDir })

    // Restore must bring back the checkpoint state
    await manager.restoreCheckpoint('sess-1', cp.id)

    const content = readFileSync(join(gitDir, 'file.txt'), 'utf8')
    assert.equal(content, 'checkpoint content', 'file must be restored to checkpoint state')
  })

  // #5335 (IP-7) — restore-failure must not orphan the user's auto-stashed
  // pending changes.
  describe('restore failure preserves pending changes (#5335)', () => {
    it('a corrupt/missing ref throws but pops the auto-stash back', async () => {
      const cp = await manager.createCheckpoint({
        sessionId: 'sess-1', resumeSessionId: 'sdk-1', cwd: gitDir, name: 'cp',
      })
      assert.ok(cp.gitRef, 'checkpoint captured a git ref')
      // Simulate the corrupt-ref case: drop the tag so rev-parse fails.
      execFileSync(GIT, ['tag', '-d', cp.gitRef], { cwd: gitDir })
      // The user has uncommitted work in flight at restore time.
      writeFileSync(join(gitDir, 'file.txt'), 'WORK IN PROGRESS')

      await assert.rejects(
        () => manager.restoreCheckpoint('sess-1', cp.id),
        (err) => /Git restore failed/.test(err.message) && /pending changes were preserved/.test(err.message),
        'restore must fail loudly AND report the changes were preserved'
      )

      // The crux: the pending work is still in the working tree, not stranded
      // in a stash.
      assert.equal(readFileSync(join(gitDir, 'file.txt'), 'utf8'), 'WORK IN PROGRESS',
        'auto-stashed changes must be popped back when restore fails')
      const stashList = execFileSync(GIT, ['stash', 'list'], { cwd: gitDir, encoding: 'utf8' })
      assert.equal(stashList.trim(), '', 'no stash should be left behind')
    })

    it('a successful no-op restore (tag == HEAD) parks pending changes in a stash, leaving the checkpoint state', async () => {
      // Checkpoint taken on a clean tree → tag points at HEAD → restore is a
      // no-op. The contract matches the checkout success path: pending changes
      // are SET ASIDE (recoverable via stash), not re-applied over the restore.
      const cp = await manager.createCheckpoint({
        sessionId: 'sess-1', resumeSessionId: 'sdk-1', cwd: gitDir, name: 'cp',
      })
      writeFileSync(join(gitDir, 'file.txt'), 'dirty work')

      await manager.restoreCheckpoint('sess-1', cp.id) // resolves, no throw

      assert.equal(readFileSync(join(gitDir, 'file.txt'), 'utf8'), 'initial content',
        'working tree is left at the checkpoint (HEAD) state, not the dirty content')
      const stashList = execFileSync(GIT, ['stash', 'list'], { cwd: gitDir, encoding: 'utf8' })
      assert.match(stashList, /chroxy: auto-stash before rewind/,
        'the pending changes are parked in a recoverable stash')
    })
  })

  // #5335 (IP-7) — orphaned `chroxy-checkpoint/*` tags accrue when `git tag -d`
  // fails. Rather than speculatively prune (which races in-flight tag creation
  // and, since tags are repo-global, could delete a sibling worktree's live
  // ref), we record the KNOWN-orphaned ref and retry deleting it later.
  describe('orphan ref retry (#5335)', () => {
    it('a tag-delete that fails is recorded and cleared on a later retry', async () => {
      const cp = await manager.createCheckpoint({ sessionId: 'sess-1', resumeSessionId: 's', cwd: gitDir, name: 'a' })
      // Force the first delete to fail; record it, leave the tag in place.
      const realDelete = manager._deleteGitRef.bind(manager)
      let failOnce = true
      manager._deleteGitRef = async (cwd, ref) => {
        if (failOnce && ref === cp.gitRef) { failOnce = false; return false }
        return realDelete(cwd, ref)
      }
      manager.deleteCheckpoint('sess-1', cp.id)
      await new Promise((r) => setImmediate(r)) // let the fire-and-forget delete settle

      // The checkpoint is gone from the manager but its tag leaked + was recorded.
      let tags = execFileSync(GIT, ['tag', '-l', 'chroxy-checkpoint/*'], { cwd: gitDir, encoding: 'utf8' })
      assert.ok(tags.includes(cp.gitRef), 'tag survives the failed delete')
      assert.ok(manager._failedRefDeletes.get(gitDir)?.has(cp.gitRef), 'failed delete is recorded for retry')

      // Retry now succeeds (the forced failure was one-shot).
      const cleared = await manager.retryFailedRefDeletes(gitDir)
      assert.equal(cleared, 1, 'the recorded orphan is cleared on retry')
      tags = execFileSync(GIT, ['tag', '-l', 'chroxy-checkpoint/*'], { cwd: gitDir, encoding: 'utf8' })
      assert.ok(!tags.includes(cp.gitRef), 'orphan tag is gone after retry')
      assert.ok(!manager._failedRefDeletes.has(gitDir), 'cleared cwd is dropped from the map')
    })

    it('retry only ever touches KNOWN orphans — never a live or sibling-worktree ref', async () => {
      // A live checkpoint exists; the retry set is empty → retry must be a no-op
      // and must not list/inspect repo-global tags at all.
      const cp = await manager.createCheckpoint({ sessionId: 'sess-1', resumeSessionId: 's', cwd: gitDir, name: 'a' })
      assert.equal(await manager.retryFailedRefDeletes(gitDir), 0, 'no recorded orphans → no-op')
      const tags = execFileSync(GIT, ['tag', '-l', 'chroxy-checkpoint/*'], { cwd: gitDir, encoding: 'utf8' })
      assert.ok(tags.includes(cp.gitRef), 'a live ref is never touched by retry')
    })

    it('retryFailedRefDeletes counts only successful deletions', async () => {
      // Record two orphans; make one delete keep failing.
      manager._recordFailedRefDelete(gitDir, 'chroxy-checkpoint/gone-1')
      manager._recordFailedRefDelete(gitDir, 'chroxy-checkpoint/stuck-2')
      execFileSync(GIT, ['tag', 'chroxy-checkpoint/gone-1', 'HEAD'], { cwd: gitDir })
      manager._deleteGitRef = async (_cwd, ref) =>
        ref === 'chroxy-checkpoint/stuck-2' ? false : true

      const cleared = await manager.retryFailedRefDeletes(gitDir)
      assert.equal(cleared, 1, 'only the successful delete is counted')
      assert.ok(manager._failedRefDeletes.get(gitDir)?.has('chroxy-checkpoint/stuck-2'),
        'the still-failing ref stays recorded for a future retry')
    })

    it('createCheckpoint retries recorded orphans after an eviction', async () => {
      const fakes = Array.from({ length: 50 }, (_, i) => ({
        id: `fake-${i}`, sessionId: 'sess-1', cwd: gitDir,
        gitRef: `chroxy-checkpoint/fake-${i}`, createdAt: i,
      }))
      manager._checkpoints.set('sess-1', fakes)
      let retriedCwd = null
      manager.retryFailedRefDeletes = async (cwd) => { retriedCwd = cwd; return 0 }

      await manager.createCheckpoint({ sessionId: 'sess-1', resumeSessionId: 's', cwd: gitDir, name: 'new' })
      assert.equal(retriedCwd, gitDir, 'eviction must trigger an orphan-retry for the evicted cwd')
    })

    it('_deleteGitRef reports already-absent tags as success', async () => {
      assert.equal(await manager._deleteGitRef(gitDir, 'chroxy-checkpoint/never-existed'), true,
        'a missing tag is "gone afterwards" → success, not a recorded failure')
    })
  })
})
