import { normalize, resolve } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { GIT } from '../git.js'

const execFileAsync = promisify(execFileCb)

/**
 * Git operations: status, branches, stage, unstage, commit.
 *
 * @param {Function} sendFn - (ws, message) => void
 * @param {Function} resolveSessionCwd - shared CWD resolver
 * @param {Function} validatePathWithinCwd - shared path validator
 * @returns {Object} git operation methods
 */
export function createGitOps(sendFn, resolveSessionCwd, validatePathWithinCwd) {

  /** Get git status (branch, staged, unstaged, untracked) for a session CWD */
  async function gitStatus(ws, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'git_status_result',
        branch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        error: 'Git status is not available in this mode',
      })
      return
    }

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)

      // Get current branch
      let branch = null
      try {
        const { stdout } = await execFileAsync(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: cwdReal,
          timeout: 5000,
        })
        const ref = stdout.trim()
        // In detached HEAD state, git prints literal "HEAD" with exit code 0
        branch = ref === 'HEAD' ? null : ref
      } catch {
        // Not a git repo
      }

      // Get porcelain status
      const { stdout: statusOutput } = await execFileAsync(GIT, ['status', '--porcelain=v1'], {
        cwd: cwdReal,
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      })

      const staged = []
      const unstaged = []
      const untracked = []

      const STATUS_MAP = {
        'M': 'modified',
        'A': 'added',
        'D': 'deleted',
        'R': 'renamed',
        'C': 'copied',
      }

      for (const rawLine of statusOutput.split(/\r?\n/)) {
        const line = rawLine.trimEnd()
        if (!line) continue
        const x = line[0] // index/staged status
        const y = line[1] // working tree status
        let filePath = line.slice(3)
        // Rename/copy entries use "old -> new" format; extract destination
        if ((x === 'R' || x === 'C') && filePath.includes(' -> ')) {
          filePath = filePath.split(' -> ').pop()
        }

        if (x === '?' && y === '?') {
          untracked.push(filePath)
        } else {
          if (x !== ' ' && x !== '?') {
            staged.push({ path: filePath, status: STATUS_MAP[x] || 'unknown' })
          }
          if (y !== ' ' && y !== '?') {
            unstaged.push({ path: filePath, status: STATUS_MAP[y] || 'unknown' })
          }
        }
      }

      sendFn(ws, {
        type: 'git_status_result',
        branch,
        staged,
        unstaged,
        untracked,
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'git_status_result',
        branch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        error: err.message || 'Failed to get git status',
      })
    }
  }

  /** List git branches (local + remote) with current branch marked */
  async function gitBranches(ws, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, {
        type: 'git_branches_result',
        branches: [],
        currentBranch: null,
        error: 'Git branches is not available in this mode',
      })
      return
    }

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)

      // Get all branches
      const { stdout } = await execFileAsync(GIT, ['branch', '-a', '--no-color'], {
        cwd: cwdReal,
        maxBuffer: 512 * 1024,
        timeout: 5000,
      })

      let currentBranch = null
      const branches = []

      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const isCurrent = line.startsWith('* ')
        const name = trimmed.replace(/^\*\s+/, '')

        // Skip HEAD pointer lines like "remotes/origin/HEAD -> origin/main"
        if (name.includes(' -> ')) continue

        const isRemote = name.startsWith('remotes/')
        const displayName = isRemote ? name.replace(/^remotes\//, '') : name

        if (isCurrent) currentBranch = displayName

        branches.push({
          name: displayName,
          isCurrent,
          isRemote,
        })
      }

      sendFn(ws, {
        type: 'git_branches_result',
        branches,
        currentBranch,
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'git_branches_result',
        branches: [],
        currentBranch: null,
        error: err.message || 'Failed to list branches',
      })
    }
  }

  /** Stage specified files via git add */
  async function gitStage(ws, files, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'git_stage_result', error: 'Git staging is not available in this mode' })
      return
    }

    if (!Array.isArray(files) || files.length === 0) {
      sendFn(ws, { type: 'git_stage_result', error: 'No files specified to stage' })
      return
    }

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)
      // Validate each file path is within session CWD (prevents path traversal)
      const validatedFiles = []
      for (const file of files) {
        const absPath = normalize(resolve(cwdReal, file))
        const { valid } = await validatePathWithinCwd(absPath, sessionCwd)
        if (!valid) {
          sendFn(ws, { type: 'git_stage_result', error: `Access denied: path outside project directory — ${file}` })
          return
        }
        validatedFiles.push(file)
      }
      await execFileAsync(GIT, ['add', '--', ...validatedFiles], {
        cwd: cwdReal,
        timeout: 10000,
      })
      sendFn(ws, { type: 'git_stage_result', error: null })
    } catch (err) {
      sendFn(ws, { type: 'git_stage_result', error: err.message || 'Failed to stage files' })
    }
  }

  /** Unstage specified files via git reset HEAD */
  async function gitUnstage(ws, files, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'git_unstage_result', error: 'Git unstaging is not available in this mode' })
      return
    }

    if (!Array.isArray(files) || files.length === 0) {
      sendFn(ws, { type: 'git_unstage_result', error: 'No files specified to unstage' })
      return
    }

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)
      // Validate each file path is within session CWD (prevents path traversal)
      const validatedFiles = []
      for (const file of files) {
        const absPath = normalize(resolve(cwdReal, file))
        const { valid } = await validatePathWithinCwd(absPath, sessionCwd)
        if (!valid) {
          sendFn(ws, { type: 'git_unstage_result', error: `Access denied: path outside project directory — ${file}` })
          return
        }
        validatedFiles.push(file)
      }
      await execFileAsync(GIT, ['reset', 'HEAD', '--', ...validatedFiles], {
        cwd: cwdReal,
        timeout: 10000,
      })
      sendFn(ws, { type: 'git_unstage_result', error: null })
    } catch (err) {
      sendFn(ws, { type: 'git_unstage_result', error: err.message || 'Failed to unstage files' })
    }
  }

  /** Create a git commit with the given message */
  async function gitCommit(ws, message, sessionCwd) {
    if (!sessionCwd) {
      sendFn(ws, { type: 'git_commit_result', hash: null, message: null, error: 'Git commit is not available in this mode' })
      return
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      sendFn(ws, { type: 'git_commit_result', hash: null, message: null, error: 'Commit message cannot be empty' })
      return
    }

    try {
      const cwdReal = await resolveSessionCwd(sessionCwd)
      const { stdout } = await execFileAsync(GIT, ['commit', '-m', message.trim()], {
        cwd: cwdReal,
        timeout: 30000,
      })

      // Extract commit hash from output by finding a hex hash before closing bracket
      let hash = null
      const match = stdout.match(/\b([a-f0-9]{7,})\]/)
      if (match) hash = match[1]

      sendFn(ws, {
        type: 'git_commit_result',
        hash,
        message: message.trim(),
        error: null,
      })
    } catch (err) {
      sendFn(ws, {
        type: 'git_commit_result',
        hash: null,
        message: null,
        error: err.message || 'Failed to create commit',
      })
    }
  }

  return {
    gitStatus,
    gitBranches,
    gitStage,
    gitUnstage,
    gitCommit,
  }
}
