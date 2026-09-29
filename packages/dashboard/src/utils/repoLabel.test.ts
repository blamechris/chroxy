/**
 * repoLabel tests (#7328) — worktree-aware cwd badge label.
 */
import { describe, it, expect } from 'vitest'
import { abbreviateCwd, repoDisplayName } from './repoLabel'

describe('abbreviateCwd', () => {
  it('returns the last path segment', () => {
    expect(abbreviateCwd('/home/user/projects/api')).toBe('api')
  })

  it('falls back to the input when there is no segment', () => {
    expect(abbreviateCwd('')).toBe('')
    expect(abbreviateCwd('/')).toBe('/')
  })
})

describe('repoDisplayName (#7328)', () => {
  it('prefers the repo name (basename of repoCwd) for a worktree session', () => {
    const cwd = '/Users/blamechris/.chroxy/worktrees/34914672f8578ecdf71accf8f8aec47e'
    const repoCwd = '/Users/blamechris/Projects/chroxy'
    expect(repoDisplayName(cwd, repoCwd)).toBe('chroxy')
    // Mutant B1 target: must not be the opaque hex.
    expect(repoDisplayName(cwd, repoCwd)).not.toBe('34914672f8578ecdf71accf8f8aec47e')
  })

  it('falls back to the cwd basename for a plain (non-worktree) session — repoCwd null', () => {
    expect(repoDisplayName('/home/user/projects/api', null)).toBe('api')
  })

  it('falls back to the cwd basename when repoCwd is undefined (pre-#7328 server)', () => {
    expect(repoDisplayName('/home/user/projects/api', undefined)).toBe('api')
  })

  it('falls back to the cwd basename when repoCwd is an empty string', () => {
    expect(repoDisplayName('/home/user/projects/api', '')).toBe('api')
  })

  it('returns empty string rather than throwing when both cwd and repoCwd are missing', () => {
    expect(repoDisplayName(undefined, undefined)).toBe('')
    expect(repoDisplayName(undefined, null)).toBe('')
  })
})
