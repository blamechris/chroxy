import { describe, expect, it } from 'vitest'
import { deriveWorktreeSwitch, WORKTREE_NEEDS_CWD_REASON } from './worktree-switch'

describe('deriveWorktreeSwitch', () => {
  it('disables with the reason when cwd is empty or whitespace', () => {
    for (const cwd of ['', '   ']) {
      const s = deriveWorktreeSwitch(cwd, false)
      expect(s.disabled).toBe(true)
      expect(s.disabledReason).toBe(WORKTREE_NEEDS_CWD_REASON)
      expect(s.hint).toBe(WORKTREE_NEEDS_CWD_REASON)
    }
  })
  it('never submits a stale ticked flag once cwd is cleared', () => {
    expect(deriveWorktreeSwitch('', true).effectiveWorktree).toBe(false)
  })
  it('is enabled with no reason when cwd is set', () => {
    const s = deriveWorktreeSwitch('/repo', false)
    expect(s.disabled).toBe(false)
    expect(s.disabledReason).toBe(null)
    expect(s.effectiveWorktree).toBe(false)
    expect(s.hint).toBe('Runs in an isolated git worktree — requires a git repo CWD')
  })
  it('keeps the ticked flag and the git-repo hint when cwd is set', () => {
    const s = deriveWorktreeSwitch(' /repo ', true)
    expect(s.effectiveWorktree).toBe(true)
    expect(s.hint).toBe('CWD must point to an existing git repository')
  })
})
