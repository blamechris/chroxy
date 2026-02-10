import pty from "node-pty";
import { execFileSync } from "child_process";
import { EventEmitter } from "events";

export function createDefaultTmuxExecutor() {
  return {
    hasTmuxSession(name) {
      try {
        execFileSync('tmux', ['has-session', '-t', name], {
          stdio: 'ignore', timeout: 5000,
        })
        return true
      } catch { return false }
    },
    checkPaneStatus(name) {
      return execFileSync('tmux',
        ['list-panes', '-t', name, '-F', '#{pane_dead}'],
        { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
    },
    getCurrentCommands(name) {
      return execFileSync('tmux',
        ['list-panes', '-t', name, '-F', '#{pane_current_command}'],
        { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
    },
  }
}

/**
 * Manages a PTY process running tmux.
 * Handles spawning, attaching, resizing, cleanup, and crash detection.
 */
export class PtyManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.sessionName = config.sessionName || "claude-code";
    this.shellCmd = config.shell || process.env.SHELL || "/bin/zsh";
    this.resume = config.resume || false;
    this.ptyProcess = null;
    this.cols = config.cols || 120;
    this.rows = config.rows || 40;
    this._healthCheckInterval = null;
    this._healthCheckIntervalMs = 30000; // 30 seconds
    this._tmux = config.tmuxExecutor || createDefaultTmuxExecutor();
  }

  /**
   * Start a tmux session with Claude Code.
   *
   * Default: kills any existing session and starts fresh.
   * With resume=true: attaches to an existing session if one exists.
   */
  async start() {
    const hasSession = this._hasTmuxSession();

    if (hasSession && !this.resume) {
      // Fresh start — kill the old session so there's no scrollback
      console.log(`[pty] Killing old tmux session: ${this.sessionName}`);
      try {
        execFileSync('/opt/homebrew/bin/tmux', ['kill-session', '-t', this.sessionName], {
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch {
        // Session may have died already
      }
    }

    const shouldCreate = !this._hasTmuxSession();
    const tmuxCmd = shouldCreate
      ? ["/opt/homebrew/bin/tmux", "new-session", "-s", this.sessionName]
      : ["/opt/homebrew/bin/tmux", "attach-session", "-t", this.sessionName];

    try {
      this.ptyProcess = pty.spawn(tmuxCmd[0], tmuxCmd.slice(1), {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: process.env.HOME,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          FORCE_COLOR: "1",
          COLORTERM: "truecolor",
        },
      });
    } catch (err) {
      throw new Error(`Failed to spawn PTY: ${err.message}`);
    }

    // Forward raw PTY data
    this.ptyProcess.onData((data) => {
      this.emit("data", data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.emit("exit", { exitCode, signal });
      this.ptyProcess = null;
    });

    if (shouldCreate) {
      // Fresh session — launch Claude Code after a short delay for shell init
      console.log(`[pty] Created new tmux session: ${this.sessionName}`);
      setTimeout(() => {
        this.write("claude\r");
        console.log(`[pty] Launched Claude Code`);
      }, 500);
    } else {
      console.log(`[pty] Resumed tmux session: ${this.sessionName}`);
    }

    // Start periodic health checks to detect session crashes
    this._startHealthCheck();

    return this;
  }

  /** Send input to the PTY (keystrokes from the client) */
  write(data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  /** Resize the PTY to match the client's terminal dimensions */
  resize(cols, rows) {
    if (this.ptyProcess && cols > 0 && rows > 0) {
      this.cols = cols;
      this.rows = rows;
      this.ptyProcess.resize(cols, rows);
    }
  }

  /** Kill the PTY process (not the tmux session — it persists) */
  destroy() {
    this._stopHealthCheck();
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
  }

  /** Check if the named tmux session already exists */
  _hasTmuxSession() {
    return this._tmux.hasTmuxSession(this.sessionName);
  }

  /**
   * Start periodic health checks to detect crashes.
   * Checks if the tmux session still exists and if panes are alive.
   */
  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthCheckInterval = setInterval(() => {
      this._checkHealth();
    }, this._healthCheckIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  _stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Check if the tmux session and its panes are still alive.
   * Emits 'crashed' event if the session or Claude process has died.
   */
  _checkHealth() {
    try {
      // Check if tmux session exists
      if (!this._hasTmuxSession()) {
        console.log(`[pty] Health check failed: tmux session '${this.sessionName}' no longer exists`);
        this._stopHealthCheck();
        this.emit('crashed', { reason: 'session_not_found' });
        return;
      }

      // Check pane status (pane_dead flag) to catch dead panes
      const paneDeadOutput = this._tmux.checkPaneStatus(this.sessionName);

      // If any pane reports '1', it's dead
      const panes = paneDeadOutput.split('\n');
      const deadPanes = panes.filter((status) => status === '1');

      if (deadPanes.length > 0) {
        console.log(
          `[pty] Health check failed: ${deadPanes.length} dead pane(s) in session '${this.sessionName}'`
        );
        this._stopHealthCheck();
        this.emit('crashed', { reason: 'pane_dead' });
        return;
      }

      // Additionally, verify that a Claude process/command is still running in the session.
      const currentCmdOutput = this._tmux.getCurrentCommands(this.sessionName);

      const paneCommands = currentCmdOutput === '' ? [] : currentCmdOutput.split('\n');
      // Consider Claude "present" if any pane's current command string contains "claude".
      const hasClaudeProcess = paneCommands.some((cmd) =>
        typeof cmd === 'string' && cmd.toLowerCase().includes('claude')
      );

      if (!hasClaudeProcess) {
        console.log(
          `[pty] Health check failed: no Claude process found in tmux session '${this.sessionName}'`
        );
        this._stopHealthCheck();
        this.emit('crashed', { reason: 'claude_process_not_found' });
        return;
      }
    } catch (err) {
      console.error(`[pty] Health check error for session '${this.sessionName}':`, err.message);
      this._stopHealthCheck();
      this.emit('crashed', { reason: 'health_check_error', error: err.message });
    }
  }
}
