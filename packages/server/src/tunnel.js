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

  async _startTunnel() {
    return new Promise((resolve, reject) => {
      const proc = spawn("cloudflared", [
        "tunnel", "--url", `http://localhost:${this.port}`, "--no-autoupdate",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
      });

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
          this._handleUnexpectedExit(code, signal);
        }
        this.process = null;
        this.url = null;
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill();
          reject(new Error("Tunnel timed out after 30s. Is cloudflared installed? (brew install cloudflared)"));
        }
      }, 30_000);
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
    this.emit('tunnel_lost', { code, signal });

    if (this.recoveryAttempt >= this.maxRecoveryAttempts) {
      console.error(`[tunnel] Recovery failed after ${this.maxRecoveryAttempts} attempts`);
      this.emit('tunnel_failed', {
        message: `Tunnel recovery failed after ${this.maxRecoveryAttempts} attempts`,
        lastExitCode: code,
        lastSignal: signal,
      });
      return;
    }

    const backoff = this.recoveryBackoffs[this.recoveryAttempt];
    this.recoveryAttempt++;

    console.log(`[tunnel] Attempting recovery ${this.recoveryAttempt}/${this.maxRecoveryAttempts} in ${backoff}ms...`);
    this.emit('tunnel_recovering', { attempt: this.recoveryAttempt, delayMs: backoff });

    await new Promise((r) => setTimeout(r, backoff));

    try {
      const { httpUrl, wsUrl} = await this._startTunnel();
      console.log(`[tunnel] Recovery successful`);
      this.emit('tunnel_recovered', { httpUrl, wsUrl, attempt: this.recoveryAttempt });
      this.recoveryAttempt = 0; // Reset on success
    } catch (err) {
      console.error(`[tunnel] Recovery attempt ${this.recoveryAttempt} failed: ${err.message}`);
      // The close handler will be called again, triggering another recovery attempt
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
