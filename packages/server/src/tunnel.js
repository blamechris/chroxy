import { spawn } from "child_process";
import { EventEmitter } from "events";

/**
 * Manages a Cloudflare Quick Tunnel.
 * Spawns `cloudflared tunnel` as a child process and parses
 * the assigned URL from its stderr output.
 * No account or configuration required.
 *
 * Auto-recovers on unexpected cloudflared crash with exponential backoff.
 */
export class TunnelManager extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.process = null;
    this.url = null;
    this.intentionalShutdown = false;
    this.recoveryAttempt = 0;
    this.maxRecoveryAttempts = 3;
    this.recoveryBackoffs = [3000, 6000, 12000]; // ms
  }

  /** Start the Cloudflare tunnel and return the public URL */
  async start() {
    this.intentionalShutdown = false;
    this.recoveryAttempt = 0;
    return this._startTunnel();
  }

  _spawnCloudflared(argv, spawnOpts) {
    return spawn("cloudflared", argv, spawnOpts)
  }

  async _startTunnel() {
    return new Promise((resolve, reject) => {
      const argv = [
        "tunnel", "--url", `http://localhost:${this.port}`, "--no-autoupdate",
      ]
      const spawnOpts = {
        stdio: ["ignore", "pipe", "pipe"],
      }
      const proc = this._spawnCloudflared(argv, spawnOpts)

      this.process = proc;
      let resolved = false;

      const handleOutput = (data) => {
        const text = data.toString();
        // cloudflared prints the URL to stderr like:
        // "https://random-words.trycloudflare.com"
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          this.url = match[0];
          const wsUrl = this.url.replace("https://", "wss://");

          console.log(`[tunnel] Cloudflare tunnel established:`);
          console.log(`  HTTP:      ${this.url}`);
          console.log(`  WebSocket: ${wsUrl}`);

          resolve({ httpUrl: this.url, wsUrl });
        }
      };

      proc.stdout.on("data", handleOutput);
      proc.stderr.on("data", handleOutput);

      proc.on("error", (err) => {
        if (!resolved) {
          reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: brew install cloudflared`));
        }
      });

      proc.on("close", (code, signal) => {
        if (!resolved) {
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`));
        } else {
          // Tunnel was running and now it crashed
          void this._handleUnexpectedExit(code, signal).catch((err) => {
            console.error("[tunnel] Error while handling unexpected cloudflared exit:", err);
          });
        }
        this.process = null;
        this.url = null;
      });

      // Timeout after 30 seconds
      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill();
          reject(new Error("Tunnel timed out after 30s. Is cloudflared installed? (brew install cloudflared)"));
        }
      }, 30_000);

      // Clear timeout on close (success or failure)
      proc.once('close', () => {
        clearTimeout(timeoutHandle);
      });
    });
  }

  async _handleUnexpectedExit(code, signal) {
    // Don't attempt recovery if this was an intentional shutdown
    if (this.intentionalShutdown) {
      console.log(`[tunnel] cloudflared exited cleanly (code ${code})`);
      return;
    }

    // Unexpected exit - attempt recovery
    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[tunnel] cloudflared exited unexpectedly (${exitReason})`);
    this.emit("tunnel_lost", { code, signal });

    // Perform recovery attempts with backoff until success or max attempts reached
    while (this.recoveryAttempt < this.maxRecoveryAttempts && !this.intentionalShutdown) {
      const backoff = this.recoveryBackoffs[this.recoveryAttempt];
      this.recoveryAttempt++;

      console.log(
        `[tunnel] Attempting recovery ${this.recoveryAttempt}/${this.maxRecoveryAttempts} in ${backoff}ms...`
      );
      this.emit("tunnel_recovering", {
        attempt: this.recoveryAttempt,
        delayMs: backoff,
      });

      await new Promise((r) => setTimeout(r, backoff));

      if (this.intentionalShutdown) {
        // Stop trying if a shutdown was requested during backoff
        return;
      }

      try {
        const { httpUrl, wsUrl } = await this._startTunnel();
        console.log(`[tunnel] Recovery successful`);
        this.emit("tunnel_recovered", {
          httpUrl,
          wsUrl,
          attempt: this.recoveryAttempt,
        });
        this.recoveryAttempt = 0; // Reset on success
        return;
      } catch (err) {
        console.error(
          `[tunnel] Recovery attempt ${this.recoveryAttempt} failed: ${err.message}`
        );
        // Loop will continue if we still have remaining attempts
      }
    }

    if (!this.intentionalShutdown && this.recoveryAttempt >= this.maxRecoveryAttempts) {
      console.error(
        `[tunnel] Recovery failed after ${this.maxRecoveryAttempts} attempts`
      );
      this.emit("tunnel_failed", {
        message: `Tunnel recovery failed after ${this.maxRecoveryAttempts} attempts`,
        lastExitCode: code,
        lastSignal: signal,
      });
    }
  }

  /** Stop the tunnel */
  async stop() {
    if (this.process) {
      this.intentionalShutdown = true;
      this.process.kill();
      this.process = null;
      this.url = null;
      console.log(`[tunnel] Tunnel closed`);
    }
  }
}
