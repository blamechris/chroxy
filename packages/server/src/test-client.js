/**
 * Quick test client — connect to the server from your terminal.
 * Usage: node src/test-client.js wss://your-cloudflare-url
 *
 * This lets you validate the server works before building the mobile app.
 */
import WebSocket from "ws";
import readline from "readline";
import "dotenv/config";

const url = process.argv[2];
const token = process.env.API_TOKEN;

if (!url) {
  console.error("Usage: node src/test-client.js <wss://url>");
  process.exit(1);
}

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

ws.on("open", () => {
  console.log("[connected] Authenticating...");
  ws.send(JSON.stringify({ type: "auth", token }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  switch (msg.type) {
    case "auth_ok":
      console.log("[authenticated] Switching to terminal mode. Type to interact.\n");
      // Start in terminal mode to see raw output
      ws.send(JSON.stringify({ type: "mode", mode: "terminal" }));
      break;

    case "auth_fail":
      console.error("[auth failed]", msg.reason);
      process.exit(1);
      break;

    case "raw":
      // Write raw PTY output directly to stdout
      process.stdout.write(msg.data);
      break;

    case "message":
      // Show parsed chat messages with a prefix
      console.log(`\n[${msg.type}:${msg.tool || "claude"}] ${msg.content}`);
      break;

    default:
      // Show other messages for debugging
      console.log(`[${msg.type}]`, JSON.stringify(msg).slice(0, 200));
  }
});

// Forward stdin keystrokes to the PTY
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  ws.send(JSON.stringify({ type: "input", data: data.toString() }));
});

ws.on("close", () => {
  console.log("\n[disconnected]");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[error]", err.message);
  process.exit(1);
});
