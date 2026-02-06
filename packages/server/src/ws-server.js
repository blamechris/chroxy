import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

/**
 * WebSocket server that bridges the phone client to the PTY.
 *
 * Protocol (JSON messages over WebSocket):
 *
 * Client -> Server:
 *   { type: "auth",   token: "..." }              — authenticate
 *   { type: "input",  data: "..." }               — send keystrokes to PTY
 *   { type: "resize", cols: 120, rows: 40 }       — resize PTY
 *   { type: "mode",   mode: "terminal"|"chat" }   — switch view mode
 *
 * Server -> Client:
 *   { type: "auth_ok" }                            — auth succeeded
 *   { type: "auth_fail", reason: "..." }           — auth failed
 *   { type: "raw",     data: "..." }               — raw PTY output (terminal view)
 *   { type: "message", ... }                       — parsed chat message (chat view)
 *   { type: "status",  connected: true }           — connection status
 */
export class WsServer {
  constructor({ port, apiToken, ptyManager, outputParser }) {
    this.port = port;
    this.apiToken = apiToken;
    this.ptyManager = ptyManager;
    this.outputParser = outputParser;
    this.clients = new Map(); // ws -> { id, authenticated, mode }
    this.wss = null;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on("connection", (ws) => {
      const clientId = uuidv4().slice(0, 8);
      this.clients.set(ws, {
        id: clientId,
        authenticated: false,
        mode: "chat", // default to chat view
      });

      console.log(`[ws] Client ${clientId} connected (awaiting auth)`);

      // Auto-disconnect if not authenticated within 10s
      const authTimeout = setTimeout(() => {
        const client = this.clients.get(ws);
        if (client && !client.authenticated) {
          this._send(ws, { type: "auth_fail", reason: "timeout" });
          ws.close();
        }
      }, 10_000);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // ignore non-JSON
        }
        this._handleMessage(ws, msg);
      });

      ws.on("close", () => {
        clearTimeout(authTimeout);
        const client = this.clients.get(ws);
        console.log(`[ws] Client ${client?.id} disconnected`);
        this.clients.delete(ws);
      });

      ws.on("error", (err) => {
        console.error(`[ws] Client error:`, err.message);
      });
    });

    // Forward PTY output to all authenticated clients
    this._setupPtyForwarding();

    console.log(`[ws] Server listening on port ${this.port}`);
  }

  /** Route incoming client messages */
  _handleMessage(ws, msg) {
    const client = this.clients.get(ws);
    if (!client) return;

    // Auth must come first
    if (!client.authenticated) {
      if (msg.type === "auth" && msg.token === this.apiToken) {
        client.authenticated = true;
        client.authTime = Date.now();
        this._send(ws, { type: "auth_ok" });
        this._send(ws, { type: "status", connected: true });
        // Tell client if Claude Code is already ready
        if (this.outputParser.claudeReady) {
          this._send(ws, { type: "claude_ready" });
        }
        console.log(`[ws] Client ${client.id} authenticated`);
      } else {
        this._send(ws, { type: "auth_fail", reason: "invalid_token" });
        ws.close();
      }
      return;
    }

    switch (msg.type) {
      case "input":
        // Forward keystrokes to the PTY
        if (msg.data && msg.data !== "\r" && msg.data !== "\n") {
          console.log(`[ws] Input from ${client.id}: "${msg.data.replace(/[\r\n]/g, '\\n').slice(0, 80)}"`);
        }
        this.ptyManager.write(msg.data);
        break;

      case "resize":
        this.ptyManager.resize(msg.cols, msg.rows);
        break;

      case "mode":
        // Switch between terminal and chat view
        if (msg.mode === "terminal" || msg.mode === "chat") {
          client.mode = msg.mode;
        }
        break;

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`);
    }
  }

  /** Wire up PTY + parser output to broadcast to clients */
  _setupPtyForwarding() {
    // Raw PTY data -> terminal view clients
    this.outputParser.on("raw", (data) => {
      this._broadcast(
        { type: "raw", data },
        (client) => client.mode === "terminal"
      );
    });

    // Parsed messages -> chat view clients (only messages after client connected)
    this.outputParser.on("message", (message) => {
      this._broadcast(
        {
          type: "message",
          messageType: message.type,
          content: message.content,
          tool: message.tool,
          options: message.options,
          timestamp: message.timestamp,
        },
        (client) => client.mode === "chat" && message.timestamp > (client.authTime || 0)
      );
    });

    // Also send raw to chat clients (they may need it for the
    // embedded terminal view or for fallback rendering)
    this.outputParser.on("raw", (data) => {
      this._broadcast(
        { type: "raw_background", data },
        (client) => client.mode === "chat"
      );
    });

    // Claude Code ready signal -> all clients
    this.outputParser.on("claude_ready", () => {
      this._broadcast({ type: "claude_ready" });
    });
  }

  /** Broadcast a message to all authenticated clients matching a filter */
  _broadcast(message, filter = () => true) {
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        this._send(ws, message);
      }
    }
  }

  /** Send JSON to a single client */
  _send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.error(`[ws] Send error:`, err.message);
    }
  }

  /** Graceful shutdown */
  close() {
    if (this.wss) {
      for (const [ws] of this.clients) {
        ws.close();
      }
      this.wss.close();
    }
  }
}
