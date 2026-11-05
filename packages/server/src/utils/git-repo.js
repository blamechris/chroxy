import { execFileSync, execFile } from 'child_process'
import { promisify } from 'util'
import { GIT } from '../git.js'

const execFileAsync = promisify(execFile)

/**
 * The one "is this directory inside a git repository?" probe. Both the
 * worktree-create path (`SessionManager._addDetachedWorktree`) and the
 * New Session dialog's up-front `check_git_repo` query use it, so the two
 * agree on what a repo is (#8972). They can still disagree at the margins
 * (timeouts, transient failures, the filesystem changing between the check and
 * Create); the create-time refusal is the backstop.
 *
 * `git -C <dir> rev-parse --git-dir` succeeds for the repo root and for any
 * subdirectory of a repo or worktree. `dir` is the argument of `-C`, so it is
 * never parsed as an option. The argv is written out as a literal at each call
 * so the argv-sink lint can resolve it.
 */

/** Synchronous probe. Never throws: any failure reads as "not a repo". */
export function isGitRepoSync(dir) {
  try {
    execFileSync(GIT, ['-C', dir, 'rev-parse', '--git-dir'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    })
    return true
  } catch {
    return false
  }
}

/** Async probe for request handlers (does not block the event loop). */
export async function isGitRepo(dir) {
  try {
    await execFileAsync(GIT, ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf-8', timeout: 5000 })
    return true
  } catch {
    return false
  }
}
