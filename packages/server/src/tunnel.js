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

    return { httpUrl: this.url, wsUrl };
  }

  /** Stop the tunnel */
  async stop() {
    if (this.listener) {
      await ngrok.disconnect();
      this.listener = null;
      this.url = null;
      console.log(`[ngrok] Tunnel closed`);
    }
  }
}
