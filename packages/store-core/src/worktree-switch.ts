/**
 * The New Session "Isolate filesystem (worktree)" switch is only meaningful
 * once a working directory is set: the server rejects `worktree` with no `cwd`
 * ("Worktree requires an explicit CWD"). One implementation for both clients
 * (#7332 dashboard, #8214 mobile) so the disabled state, the submitted flag and
 * the reason text can never drift apart.
 */
export const WORKTREE_NEEDS_CWD_REASON =
  'Choose a working directory first — worktree isolation needs a git repo'

export interface WorktreeSwitchState {
  /** True while the switch cannot be turned on. */
  disabled: boolean
  /** The reason it is disabled, or null when enabled. */
  disabledReason: string | null
  /** The value to show AND submit: a stale tick never survives a cleared cwd. */
  effectiveWorktree: boolean
  /** Helper text to render beside the switch (reason first when disabled). */
  hint: string
}

export function deriveWorktreeSwitch(cwd: string, worktree: boolean): WorktreeSwitchState {
  const hasCwd = Boolean(cwd.trim())
  if (!hasCwd) {
    return {
      disabled: true,
      disabledReason: WORKTREE_NEEDS_CWD_REASON,
      effectiveWorktree: false,
      hint: WORKTREE_NEEDS_CWD_REASON,
    }
  }
  return {
    disabled: false,
    disabledReason: null,
    effectiveWorktree: worktree,
    hint: worktree
      ? 'CWD must point to an existing git repository'
      : 'Runs in an isolated git worktree — requires a git repo CWD',
  }
}
