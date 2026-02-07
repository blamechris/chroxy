import { execSync } from 'child_process'

/**
 * Discover tmux sessions running Claude Code on the host.
 *
 * Scans all tmux panes, checks their child processes for claude,
 * and returns structured session info for the app to display.
 *
 * @returns {Array<{ sessionName: string, cwd: string, pid: number }>}
 */
export function discoverTmuxSessions() {
  try {
    // Check if tmux is available
    execSync('which tmux', { stdio: 'pipe' })
  } catch {
    return []
  }

  try {
    // List all tmux panes with their session name, pane PID, and current path
    const raw = execSync(
      "tmux list-panes -a -F '#{session_name} #{pane_pid} #{pane_current_path}'",
      { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }
    ).trim()

    if (!raw) return []

    const results = []

    for (const line of raw.split('\n')) {
      const parts = line.trim().split(' ')
      if (parts.length < 3) continue

      const sessionName = parts[0]
      const panePid = parseInt(parts[1], 10)
      const paneCwd = parts.slice(2).join(' ') // cwd may contain spaces

      if (isNaN(panePid)) continue

      // Find child processes of this pane's shell
      const claudePid = _findClaudeChild(panePid)
      if (claudePid) {
        // Try to get the actual CWD of the Claude process
        const cwd = _getProcessCwd(claudePid) || paneCwd

        results.push({
          sessionName,
          cwd,
          pid: claudePid,
        })
      }
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
function _findClaudeChild(parentPid) {
  try {
    // Get all child PIDs
    const childrenRaw = execSync(
      `pgrep -P ${parentPid}`,
      { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 }
    ).trim()

    if (!childrenRaw) return null

    for (const childPidStr of childrenRaw.split('\n')) {
      const childPid = parseInt(childPidStr.trim(), 10)
      if (isNaN(childPid)) continue

      // Check if this child is claude
      try {
        const cmd = execSync(
          `ps -p ${childPid} -o command=`,
          { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 }
        ).trim()

        if (/\bclaude\b/i.test(cmd)) {
          return childPid
        }
      } catch {
        continue
      }

      // Check grandchildren (claude may be a child of node)
      const grandchild = _findClaudeChild(childPid)
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
function _getProcessCwd(pid) {
  try {
    const raw = execSync(
      `lsof -p ${pid} -a -d cwd -Fn 2>/dev/null`,
      { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 }
    ).trim()

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
