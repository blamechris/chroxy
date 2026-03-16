import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { CheckpointManager } from '../src/checkpoint-manager.js'
import { GIT } from './test-helpers.js'

// Create a temporary git repo for testing
function createTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-cp-test-'))
  execFileSync(GIT, ['init'], { cwd: dir })
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

  beforeEach(() => {
    manager = new CheckpointManager()
    // Clear any persisted state from prior tests
    manager.clearCheckpoints('sess-1')
    gitDir = createTempGitRepo()
  })

  afterEach(() => {
    rmSync(gitDir, { recursive: true, force: true })
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
})
