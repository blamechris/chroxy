import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readSessionContext } from '../src/session-context.js'

describe('readSessionContext', () => {
  it('returns git branch for a git repository', async () => {
    // Use the chroxy repo itself as test subject
    const ctx = await readSessionContext(process.cwd())
    assert.ok(typeof ctx.gitBranch === 'string', 'gitBranch should be a string')
    assert.ok(ctx.gitBranch.length > 0, 'gitBranch should be non-empty')
    assert.ok(typeof ctx.gitDirty === 'number', 'gitDirty should be a number')
    assert.ok(typeof ctx.gitAhead === 'number', 'gitAhead should be a number')
    assert.ok(typeof ctx.projectName === 'string', 'projectName should be a string')
  })

  it('returns project name from package.json', async () => {
    const ctx = await readSessionContext(process.cwd())
    // process.cwd() may be monorepo root ("chroxy") or packages/server ("@chroxy/server")
    assert.ok(typeof ctx.projectName === 'string' && ctx.projectName.length > 0,
      `projectName should be a non-empty string, got: ${ctx.projectName}`)
    assert.ok(ctx.projectName.includes('chroxy'),
      `projectName should contain "chroxy", got: ${ctx.projectName}`)
  })

  it('returns null gitBranch for non-git directory', async () => {
    const ctx = await readSessionContext('/tmp')
    assert.equal(ctx.gitBranch, null)
    assert.equal(ctx.gitDirty, 0)
    assert.equal(ctx.gitAhead, 0)
    // /tmp has no package.json, should fall back to dirname
    assert.equal(ctx.projectName, 'tmp')
  })
})
