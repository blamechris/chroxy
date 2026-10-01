/**
 * repoLabel tests (#7328) — worktree-aware cwd badge label.
 */
import { describe, it, expect } from 'vitest'
import { abbreviateCwd, repoDisplayName, sessionGroupKey } from './repoLabel'

describe('abbreviateCwd', () => {
  it('returns the last path segment', () => {
    expect(abbreviateCwd('/home/user/projects/api')).toBe('api')
  })

  it('falls back to the input when there is no segment', () => {
    expect(abbreviateCwd('')).toBe('')
    expect(abbreviateCwd('/')).toBe('/')
  })

  // Review nitpick on PR #8180 (issuecomment-5921537989): this split on `/`
  // only, while RepoEventsSection.tsx's `repoBasename` already split on
  // `[\\/]+` for exactly this reason (a Windows daemon sends backslash
  // cwds). Unify on the same separator set so the two "basename of a path"
  // helpers can't silently disagree on a Windows session.
  it('normalizes Windows backslash separators the same way repoBasename does (review nitpick, #8180)', () => {
    expect(abbreviateCwd('C:\\Users\\me\\chroxy')).toBe('chroxy')
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

// #8123 — the sidebar repo group, footer cwd, and file-tree root label all
// reuse this same function instead of growing their own copy. The footer's
// pre-existing (and intentionally different) fallback shape — last 2 path
// segments, not 1 — is threaded through as an optional `fallback`, so the
// worktree-repo-name PART is shared while each surface's own non-worktree
// display rule is preserved.
describe('repoDisplayName with a custom fallback (#8123)', () => {
  const lastTwoSegments = (cwd: string) => cwd.split('/').slice(-2).join('/')

  it('uses the custom fallback instead of the default single-segment one when repoCwd is absent', () => {
    expect(repoDisplayName('/Users/me/Projects/chroxy', null, lastTwoSegments)).toBe('Projects/chroxy')
  })

  it('still prefers the repo name over the custom fallback when repoCwd is present', () => {
    const cwd = '/Users/me/.chroxy/worktrees/34914672f8578ecdf71accf8f8aec47e'
    expect(repoDisplayName(cwd, '/Users/me/Projects/chroxy', lastTwoSegments)).toBe('chroxy')
  })

  it('defaults to the single-segment fallback when no fallback is passed (unchanged pre-#8123 signature)', () => {
    expect(repoDisplayName('/Users/me/Projects/chroxy', null)).toBe('chroxy')
  })
})

// Review follow-up on PR #8180 (issuecomment-5921537989, Critical #1):
// App.tsx's `sidebarRepos` memo computes the sidebar's repo GROUP KEY as
// `repoCwd || cwd`, but `sidebarContextMenuItems.ts`'s repo-group "Summarize"
// filter kept comparing against raw `cwd` — a second, independent copy of
// the same rule that drifted the moment the memo's rule changed. This
// helper is the ONE place that rule now lives; both call sites use it so
// they cannot drift again.
describe('sessionGroupKey (#8123 review follow-up)', () => {
  it('is repoCwd for a worktree-isolated session', () => {
    expect(sessionGroupKey({
      cwd: '/Users/me/.chroxy/worktrees/34914672f8578ecdf71accf8f8aec47e',
      repoCwd: '/Users/me/Projects/chroxy',
    })).toBe('/Users/me/Projects/chroxy')
  })

  it('falls back to cwd when repoCwd is null (plain session)', () => {
    expect(sessionGroupKey({ cwd: '/home/user/projects/api', repoCwd: null })).toBe('/home/user/projects/api')
  })

  it('falls back to cwd when repoCwd is undefined (pre-#7328 server)', () => {
    expect(sessionGroupKey({ cwd: '/home/user/projects/api' })).toBe('/home/user/projects/api')
  })

  it('falls back to cwd when repoCwd is an empty string', () => {
    expect(sessionGroupKey({ cwd: '/home/user/projects/api', repoCwd: '' })).toBe('/home/user/projects/api')
  })

  it('returns an empty string rather than throwing when cwd is missing too', () => {
    expect(sessionGroupKey({})).toBe('')
  })
})
