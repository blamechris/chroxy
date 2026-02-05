import pty from "node-pty";
import { execSync } from "child_process";
import { EventEmitter } from "events";

/**
 * Manages a PTY process running tmux.
 * Handles spawning, attaching, resizing, and cleanup.
 */
export class PtyManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.sessionName = config.sessionName || "claude-code";
    this.shellCmd = config.shell || process.env.SHELL || "/bin/zsh";
    this.ptyProcess = null;
    this.cols = config.cols || 120;
    this.rows = config.rows || 40;
  }

  /**
   * Start or attach to a tmux session.
   * If the session exists, attaches. Otherwise creates a new one.
   */
  async start() {
    const tmuxCmd = await this._hasTmuxSession()
      ? ["tmux", "attach-session", "-t", this.sessionName]
      : ["tmux", "new-session", "-s", this.sessionName];

    this.ptyProcess = pty.spawn(tmuxCmd[0], tmuxCmd.slice(1), {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: process.env.HOME,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        // Ensure Claude Code gets proper color support
        FORCE_COLOR: "1",
        COLORTERM: "truecolor",
      },
    });

    // Forward raw PTY data
    this.ptyProcess.onData((data) => {
      this.emit("data", data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.emit("exit", { exitCode, signal });
      this.ptyProcess = null;
    });

    console.log(`[pty] Attached to tmux session: ${this.sessionName}`);
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
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
  }

  /** Check if the named tmux session already exists */
  _hasTmuxSession() {
    try {
      execSync(`tmux has-session -t ${this.sessionName} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }
}
