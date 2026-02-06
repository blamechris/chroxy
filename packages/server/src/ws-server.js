import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

/**
 * WebSocket server that bridges the phone client to the backend.
 *
 * Supports two modes:
 *   - PTY mode (ptyManager + outputParser): existing tmux/PTY behavior
 *   - CLI mode (cliSession): headless `claude -p` with structured JSON
 *
 * Protocol (JSON messages over WebSocket):
 *
 * Client -> Server:
 *   { type: "auth",      token: "..." }              — authenticate
 *   { type: "input",     data: "..." }               — send text (keystrokes in PTY, message in CLI)
 *   { type: "resize",    cols: 120, rows: 40 }       — resize PTY (PTY mode only)
 *   { type: "mode",      mode: "terminal"|"chat" }   — switch view mode
 *   { type: "interrupt" }                             — interrupt current operation
 *   { type: "set_model", model: "..." }              — change Claude model (CLI mode)
 *
 * Server -> Client:
 *   { type: "auth_ok" }                               — auth succeeded
 *   { type: "auth_fail",    reason: "..." }           — auth failed
 *   { type: "server_mode",  mode: "cli"|"terminal" }  — which backend mode is active
 *   { type: "raw",          data: "..." }             — raw PTY output (terminal view)
 *   { type: "message",      ... }                     — parsed chat message
 *   { type: "stream_start", messageId: "..." }        — beginning of streaming response (CLI mode)
 *   { type: "stream_delta", messageId, delta }         — token-by-token text (CLI mode)
 *   { type: "stream_end",   messageId: "..." }        — streaming response complete (CLI mode)
 *   { type: "tool_start",   messageId, tool, input }   — tool invocation (CLI mode)
 *   { type: "result",       ... }                     — query stats (CLI mode)
 *   { type: "status",       connected: true }         — connection status
 *   { type: "claude_ready" }                          — Claude Code ready for input
 *   { type: "model_changed", model: "..." }          — active model updated (CLI mode)
 */
export class WsServer {
  constructor({ port, apiToken, ptyManager, outputParser, cliSession }) {
    this.port = port;
    this.apiToken = apiToken;
    this.ptyManager = ptyManager || null;
    this.outputParser = outputParser || null;
    this.cliSession = cliSession || null;
    this.serverMode = this.cliSession ? "cli" : "terminal";
    this.clients = new Map(); // ws -> { id, authenticated, mode }
    this.httpServer = null;
    this.wss = null;
  }

  start() {
    // Create HTTP server that handles health checks and WebSocket upgrades
    this.httpServer = createServer((req, res) => {
      // Health check endpoint — Cloudflare and the app verify connectivity via GET /
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", mode: this.serverMode }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // WebSocket server in noServer mode — we handle the upgrade manually
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

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

    this.httpServer.listen(this.port);

    // Wire up event forwarding based on mode
    if (this.cliSession) {
      this._setupCliForwarding();
    } else {
      this._setupPtyForwarding();
    }

    console.log(`[ws] Server listening on port ${this.port} (${this.serverMode} mode)`);
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
        this._send(ws, { type: "server_mode", mode: this.serverMode });
        this._send(ws, { type: "status", connected: true });

        // In PTY mode, tell client if Claude Code is already ready
        if (this.outputParser && this.outputParser.claudeReady) {
          this._send(ws, { type: "claude_ready" });
        }

        // In CLI mode, gate on actual process readiness (may be respawning)
        if (this.cliSession) {
          if (this.cliSession.isReady) {
            this._send(ws, { type: "claude_ready" });
          }
          this._send(ws, {
            type: "model_changed",
            model: this.cliSession.model ?? null,
          });
        }

        console.log(`[ws] Client ${client.id} authenticated`);
      } else {
        this._send(ws, { type: "auth_fail", reason: "invalid_token" });
        ws.close();
      }
      return;
    }

    // Route based on server mode
    if (this.cliSession) {
      this._handleCliMessage(ws, client, msg);
    } else {
      this._handlePtyMessage(ws, client, msg);
    }
  }

  /** Handle messages in CLI mode */
  _handleCliMessage(ws, client, msg) {
    switch (msg.type) {
      case "input": {
        const text = msg.data;
        if (!text || !text.trim()) break;
        console.log(`[ws] Message from ${client.id}: "${text.slice(0, 80)}"`);
        this.cliSession.sendMessage(text.trim());
        break;
      }

      case "interrupt":
        console.log(`[ws] Interrupt from ${client.id}`);
        this.cliSession.interrupt();
        break;

      case "set_model": {
        const ALLOWED_MODELS = [
          "claude-sonnet-4-20250514",
          "claude-haiku-235-20250421",
          "claude-opus-4-20250514",
          "sonnet", "haiku", "opus",
        ];
        if (
          typeof msg.model === "string" &&
          ALLOWED_MODELS.includes(msg.model)
        ) {
          console.log(`[ws] Model change from ${client.id}: ${msg.model}`);
          this.cliSession.setModel(msg.model);
          // Broadcast model change to all authenticated clients
          this._broadcast({ type: "model_changed", model: msg.model });
        } else {
          console.warn(`[ws] Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`);
        }
        break;
      }

      case "mode":
        if (msg.mode === "terminal" || msg.mode === "chat") {
          client.mode = msg.mode;
        }
        break;

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`);
    }
  }

  /** Handle messages in PTY mode */
  _handlePtyMessage(ws, client, msg) {
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

  /** Wire up CLI session events to broadcast to clients */
  _setupCliForwarding() {
    // Notify clients when Claude process is ready (initial start or respawn)
    this.cliSession.on("ready", () => {
      this._broadcast({ type: "claude_ready" });
      this._broadcast({
        type: "model_changed",
        model: this.cliSession.model ?? null,
      });
    });

    // Buffer stream deltas to reduce WS message volume (50ms batch window).
    // This prevents flooding mobile clients over cellular/tunnel connections.
    const deltaBuffer = new Map(); // messageId -> accumulated text
    let deltaFlushTimer = null;
    const flushDeltas = () => {
      deltaFlushTimer = null;
      for (const [messageId, delta] of deltaBuffer) {
        this._broadcast({ type: "stream_delta", messageId, delta });
      }
      deltaBuffer.clear();
    };

    this.cliSession.on("stream_start", ({ messageId }) => {
      console.log(`[ws] Broadcasting stream_start: ${messageId}`);
      this._broadcast({ type: "stream_start", messageId });
    });

    this.cliSession.on("stream_delta", ({ messageId, delta }) => {
      const existing = deltaBuffer.get(messageId) || "";
      deltaBuffer.set(messageId, existing + delta);
      if (!deltaFlushTimer) {
        deltaFlushTimer = setTimeout(flushDeltas, 50);
      }
    });

    this.cliSession.on("stream_end", ({ messageId }) => {
      // Flush remaining deltas before sending stream_end
      if (deltaBuffer.size > 0) {
        if (deltaFlushTimer) {
          clearTimeout(deltaFlushTimer);
          deltaFlushTimer = null;
        }
        flushDeltas();
      }
      console.log(`[ws] Broadcasting stream_end: ${messageId}`);
      this._broadcast({ type: "stream_end", messageId });
    });

    this.cliSession.on("message", (message) => {
      this._broadcast({
        type: "message",
        messageType: message.type,
        content: message.content,
        tool: message.tool,
        timestamp: message.timestamp,
      });
    });

    this.cliSession.on("tool_start", ({ messageId, tool, input }) => {
      this._broadcast({ type: "tool_start", messageId, tool, input });
    });

    this.cliSession.on("result", ({ cost, duration, usage, sessionId }) => {
      this._broadcast({ type: "result", cost, duration, usage, sessionId });
    });

    this.cliSession.on("error", ({ message }) => {
      this._broadcast({
        type: "message",
        messageType: "error",
        content: message,
        timestamp: Date.now(),
      });
    });
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
    for (const [ws] of this.clients) {
      ws.close();
    }
    if (this.wss) this.wss.close();
    if (this.httpServer) this.httpServer.close();
  }
}
