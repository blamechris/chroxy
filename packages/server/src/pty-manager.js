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
    this.resume = config.resume || false;
    this.ptyProcess = null;
    this.cols = config.cols || 120;
    this.rows = config.rows || 40;
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
        execSync(`/opt/homebrew/bin/tmux kill-session -t ${this.sessionName} 2>/dev/null`);
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
