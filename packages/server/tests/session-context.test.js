import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { readSessionContext } from '../src/session-context.js'
import { GIT } from './test-helpers.js'

describe('readSessionContext', () => {
  let gitDir   // temp dir with git init + commit
  let plainDir // temp dir with no git

  before(async () => {
    // Create a temp git repo fixture
    gitDir = await mkdtemp(join(tmpdir(), 'session-ctx-git-'))
    execFileSync(GIT, ['init', '-b', 'main'], { cwd: gitDir })
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: gitDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: gitDir })
    await writeFile(join(gitDir, 'package.json'), JSON.stringify({ name: 'test-project' }))
    execFileSync(GIT, ['add', '.'], { cwd: gitDir })
    execFileSync(GIT, ['commit', '-m', 'init'], { cwd: gitDir })

    // Create a plain temp dir (no git, no package.json)
    plainDir = await mkdtemp(join(tmpdir(), 'session-ctx-plain-'))
  })

  after(async () => {
    await rm(gitDir, { recursive: true, force: true })
    await rm(plainDir, { recursive: true, force: true })
  })

  it('returns git branch for a git repository', async () => {
    const ctx = await readSessionContext(gitDir)
    assert.equal(ctx.gitBranch, 'main')
    assert.equal(typeof ctx.gitDirty, 'number')
    assert.equal(typeof ctx.gitAhead, 'number')
  })

  it('returns project name from package.json', async () => {
    const ctx = await readSessionContext(gitDir)
    assert.equal(ctx.projectName, 'test-project')
  })

  it('returns dirty count for uncommitted changes', async () => {
    await writeFile(join(gitDir, 'dirty.txt'), 'uncommitted')
    const ctx = await readSessionContext(gitDir)
    assert.ok(ctx.gitDirty >= 1, `expected dirty >= 1, got ${ctx.gitDirty}`)
    // Clean up: reset tracked files and index, then remove untracked file
    execFileSync(GIT, ['reset', '--hard'], { cwd: gitDir })
    await rm(join(gitDir, 'dirty.txt'), { force: true })
  })

  it('returns null gitBranch for non-git directory', async () => {
    const ctx = await readSessionContext(plainDir)
    assert.equal(ctx.gitBranch, null)
    assert.equal(ctx.gitDirty, 0)
    assert.equal(ctx.gitAhead, 0)
  })

  it('falls back to dirname when no package.json', async () => {
    const ctx = await readSessionContext(plainDir)
    assert.ok(ctx.projectName.startsWith('session-ctx-plain-'),
      `expected dirname fallback, got: ${ctx.projectName}`)
  })
})
