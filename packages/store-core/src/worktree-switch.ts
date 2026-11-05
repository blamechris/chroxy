/**
 * The New Session "Isolate filesystem (worktree)" switch is only meaningful
 * once a working directory is set: the server rejects `worktree` with no `cwd`
 * ("Worktree requires an explicit CWD"). One implementation for both clients
 * (#7332 dashboard, #8214 mobile) so the disabled state, the submitted flag and
 * the reason text can never drift apart.
 *
 * #8972: it is also meaningless for a directory that is not a git repository
 * (the server refuses that only after Create). Clients learn the answer from
 * the `check_git_repo` query and feed it in as `isGitRepo`.
 */
export const WORKTREE_NEEDS_CWD_REASON =
  'Choose a working directory first — worktree isolation needs a git repo'

export const WORKTREE_NOT_GIT_REASON =
  'This directory is not a git repository — worktree isolation needs a git repo'

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

/**
 * @param isGitRepo - what the server said about THIS cwd: `false` = known not a
 *   git repo (disables the switch), `true`/`null`/`undefined` = a repo, unknown
 *   or still checking (leaves it enabled; the server refusal on create remains
 *   the backstop). Callers must only pass an answer that belongs to `cwd`.
 */
export function deriveWorktreeSwitch(
  cwd: string,
  worktree: boolean,
  isGitRepo?: boolean | null,
): WorktreeSwitchState {
  const hasCwd = Boolean(cwd.trim())
  if (!hasCwd) {
    return {
      disabled: true,
      disabledReason: WORKTREE_NEEDS_CWD_REASON,
      effectiveWorktree: false,
      hint: WORKTREE_NEEDS_CWD_REASON,
    }
  }
  if (isGitRepo === false) {
    return {
      disabled: true,
      disabledReason: WORKTREE_NOT_GIT_REASON,
      effectiveWorktree: false,
      hint: WORKTREE_NOT_GIT_REASON,
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
