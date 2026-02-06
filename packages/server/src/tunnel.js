import { spawn } from "child_process";

/**
 * Manages a Cloudflare Quick Tunnel.
 * Spawns `cloudflared tunnel` as a child process and parses
 * the assigned URL from its stderr output.
 * No account or configuration required.
 */
export class TunnelManager {
  constructor({ port }) {
    this.port = port;
    this.process = null;
    this.url = null;
  }

  /** Start the Cloudflare tunnel and return the public URL */
  async start() {
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

      proc.on("close", (code) => {
        if (!resolved) {
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`));
        } else {
          console.log(`[tunnel] cloudflared exited with code ${code}`);
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

  /** Stop the tunnel */
  async stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.url = null;
      console.log(`[tunnel] Tunnel closed`);
    }
  }
}
