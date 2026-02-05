import ngrok from "@ngrok/ngrok";

/**
 * Manages the ngrok tunnel lifecycle.
 * Creates a tunnel to the local WebSocket server and
 * provides the public URL for client connections.
 */
export class TunnelManager {
  constructor({ port, authToken, domain }) {
    this.port = port;
    this.authToken = authToken;
    this.domain = domain; // optional fixed domain (paid plans)
    this.listener = null;
    this.url = null;
  }

  /** Start the ngrok tunnel and return the public URL */
  async start() {
    const config = {
      addr: this.port,
      authtoken: this.authToken,
    };

    // Use a fixed domain if configured (avoids random URLs)
    if (this.domain) {
      config.domain = this.domain;
    }

    this.listener = await ngrok.forward(config);
    this.url = this.listener.url();

    // Convert https:// to wss:// for WebSocket clients
    const wsUrl = this.url.replace("https://", "wss://");

    console.log(`[ngrok] Tunnel established:`);
    console.log(`  HTTP:      ${this.url}`);
    console.log(`  WebSocket: ${wsUrl}`);

    // Monitor tunnel health
    this._startHealthCheck(wsUrl);

    return { httpUrl: this.url, wsUrl };
  }

  /** Periodically verify the tunnel is still alive */
  _startHealthCheck(wsUrl) {
    this._healthInterval = setInterval(async () => {
      try {
        const url = this.url;
        if (!url) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
          headers: { "ngrok-skip-browser-warning": "1" },
        });
        clearTimeout(timeout);

        if (!res.ok && res.status !== 426) {
          // 426 = Upgrade Required (expected for WS server), that's fine
          console.log(`[ngrok] Tunnel health check: HTTP ${res.status}`);
        }
      } catch (err) {
        console.error(`[ngrok] Tunnel appears dead: ${err.message}`);
        console.error(`[ngrok] Restart the server to get a new tunnel.`);
      }
    }, 30_000); // check every 30s
  }

  /** Stop the tunnel */
  async stop() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
    }
    if (this.listener) {
      await ngrok.disconnect();
      this.listener = null;
      this.url = null;
      console.log(`[ngrok] Tunnel closed`);
    }
  }
}
