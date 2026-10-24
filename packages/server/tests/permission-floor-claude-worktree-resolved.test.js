import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realResolver from '../src/utils/componentwise-resolver.js'

/**
 * #8741 — the worktree carve-out is decided on the path as written, and the
 * symlink-resolving pass keeps it only when it resolves to that same path.
 *
 * On a quiet filesystem the two always agree (the written path holds no symlink
 * and no `..`), so this check can only be shown by making the resolver answer
 * differently, as it would if the path changed between the two walks. The
 * resolver is replaced for this file only; `permission-floor.js` is imported
 * after the mock is installed, with a query string so it binds to it.
 */

let answer = null
const resolverMock = mock.module(new URL('../src/utils/componentwise-resolver.js', import.meta.url).href, {
  namedExports: {
    ...realResolver,
    resolveTargetComponentwiseSync: (base, target) => (answer ? answer(base) : realResolver.resolveTargetComponentwiseSync(base, target)),
  },
})
const { isFlooredTarget } = await import('../src/permission-floor.js?resolved-path')

describe('#8741 — the carve-out needs the resolved path to be the written one', () => {
  let root
  let repo

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-floor-wt-resolved-')))
    repo = join(root, 'repo')
    mkdirSync(join(repo, '.claude/worktrees/a2c/src'), { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
  })

  after(() => {
    answer = null
    resolverMock.restore()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('premise: with the real resolver, an ordinary worktree file is not floored', () => {
    answer = null
    assert.equal(isFlooredTarget('Write', { file_path: '.claude/worktrees/a2c/src/a.js' }, repo), false)
  })

  it('a resolved path that differs from the written one gets the full scan', () => {
    answer = (base) => join(base, '.git', 'config')
    try {
      assert.equal(isFlooredTarget('Write', { file_path: '.claude/worktrees/a2c/src/a.js' }, repo), true)
    } finally {
      answer = null
    }
  })

  it('positive control: the same resolved path keeps the carve-out', () => {
    answer = (base) => join(base, '.claude', 'worktrees', 'a2c', 'src', 'a.js')
    try {
      assert.equal(isFlooredTarget('Write', { file_path: '.claude/worktrees/a2c/src/a.js' }, repo), false)
    } finally {
      answer = null
    }
  })
})
