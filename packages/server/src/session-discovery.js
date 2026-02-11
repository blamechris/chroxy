import { execSync } from 'child_process'

/** Default executor that runs real shell commands */
const defaultExecutor = {
  whichTmux() {
    execSync('which tmux', { stdio: 'pipe' })
  },
  listPanes() {
    return execSync(
      "tmux list-panes -a -F '#{session_name} #{pane_pid} #{pane_current_path}'",
      { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }
    ).trim()
  },
  getChildren(pid) {
    return execSync(
      `pgrep -P ${pid}`,
      { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 }
    ).trim()
  },
  getCommand(pid) {
    return execSync(
      `ps -p ${pid} -o command=`,
      { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 }
    ).trim()
  },
  getCwd(pid) {
    return execSync(
      `lsof -p ${pid} -a -d cwd -Fn 2>/dev/null`,
      { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 }
    ).trim()
  },
}

/**
 * Discover tmux sessions running Claude Code on the host.
 *
 * Scans all tmux panes, checks their child processes for claude,
 * and returns structured session info for the app to display.
 *
 * @param {{ prefix?: string, executor?: object }} [options]
 * @param {string} [options.prefix] - Only return sessions whose name starts with this prefix (e.g. 'chroxy-')
 * @param {object} [options.executor] - Injectable executor for testing (defaults to real shell commands)
 * @returns {Array<{ sessionName: string, cwd: string, pid: number }>}
 */
export function discoverTmuxSessions({ prefix, executor } = {}) {
  const exec = executor || defaultExecutor

  try {
    exec.whichTmux()
  } catch {
    return []
  }

  try {
    const raw = exec.listPanes()
    if (!raw) return []

    const results = []

    for (const line of raw.split('\n')) {
      const parts = line.trim().split(' ')
      if (parts.length < 3) continue

      const sessionName = parts[0]
      const panePid = parseInt(parts[1], 10)
      const paneCwd = parts.slice(2).join(' ') // cwd may contain spaces

      if (isNaN(panePid)) continue

      const claudePid = _findClaudeChild(panePid, exec)
      if (claudePid) {
        const cwd = _getProcessCwd(claudePid, exec) || paneCwd

        results.push({
          sessionName,
          cwd,
          pid: claudePid,
        })
      }
    }

    if (prefix) {
      return results.filter((s) => s.sessionName.startsWith(prefix))
    }
    return results
  } catch (err) {
    console.error(`[discovery] Failed to discover tmux sessions: ${err.message}`)
    return []
  }
}

/**
 * Check if a process has a child running claude.
 * Walks the process tree (shell → claude, or shell → node → claude).
 * @returns {number | null} PID of the claude process, or null
 */
function _findClaudeChild(parentPid, exec) {
  try {
    const childrenRaw = exec.getChildren(parentPid)
    if (!childrenRaw) return null

    for (const childPidStr of childrenRaw.split('\n')) {
      const childPid = parseInt(childPidStr.trim(), 10)
      if (isNaN(childPid)) continue

      try {
        const cmd = exec.getCommand(childPid)
        if (/\bclaude\b/i.test(cmd)) {
          return childPid
        }
      } catch {
        continue
      }

      // Check grandchildren (claude may be a child of node)
      const grandchild = _findClaudeChild(childPid, exec)
      if (grandchild) return grandchild
    }

    return null
  } catch {
    return null
  }
}

/**
 * Get the current working directory of a process (macOS).
 * @returns {string | null}
 */
function _getProcessCwd(pid, exec) {
  try {
    const raw = exec.getCwd(pid)

    // lsof -Fn outputs lines like "n/path/to/dir"
    for (const line of raw.split('\n')) {
      if (line.startsWith('n/')) {
        return line.slice(1)
      }
    }
    return null
  } catch {
    return null
  }
}
