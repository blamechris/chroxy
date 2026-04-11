/**
 * Quick test client — connect to the server from your terminal.
 * Usage: node src/test-client.js wss://your-cloudflare-url [--no-encrypt]
 *
 * This lets you validate the server works before building the mobile app.
 */
import WebSocket from "ws";
import "dotenv/config";
import { createKeyPair, deriveSharedKey, deriveConnectionKey, generateConnectionSalt, encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT } from "@chroxy/store-core/crypto";

const url = process.argv[2];
const token = process.env.API_TOKEN;
const noEncrypt = process.argv.includes("--no-encrypt");

if (!url) {
  console.error("Usage: node src/test-client.js <wss://url> [--no-encrypt]");
  process.exit(1);
}

const ws = new WebSocket(url);

/** E2E encryption state */
let encryptionState = null;
let pendingKeyPair = null;
let pendingSalt = null;

/** Send a message, encrypting if E2E is active */
function wsSend(payload) {
  if (encryptionState) {
    const envelope = encrypt(JSON.stringify(payload), encryptionState.sharedKey, encryptionState.sendNonce, DIRECTION_CLIENT);
    encryptionState.sendNonce++;
    ws.send(JSON.stringify(envelope));
  } else {
    ws.send(JSON.stringify(payload));
  }
}

ws.on("open", () => {
  console.log("[connected] Authenticating...");
  ws.send(JSON.stringify({ type: "auth", token }));
});

ws.on("message", (raw) => {
  let msg = JSON.parse(raw.toString());

  // Decrypt incoming encrypted messages
  if (msg.type === "encrypted" && encryptionState) {
    try {
      msg = decrypt(msg, encryptionState.sharedKey, encryptionState.recvNonce, DIRECTION_SERVER);
      encryptionState.recvNonce++;
    } catch (err) {
      console.error("[crypto] Decryption failed:", err.message);
      ws.close();
      return;
    }
  }

  switch (msg.type) {
    case "auth_ok":
      console.log(`[authenticated] server v${msg.serverVersion} protocol v${msg.protocolVersion}`, msg.encryption === "required" ? "E2E encryption required" : "No encryption");
      if (msg.encryption === "required" && !noEncrypt) {
        pendingKeyPair = createKeyPair();
        pendingSalt = generateConnectionSalt();
        // salt is REQUIRED by the server as of the 2026-04-11 audit fix —
        // see packages/server/src/ws-auth.js and KEY_EXCHANGE_SALT_REQUIRED.
        ws.send(JSON.stringify({ type: "key_exchange", publicKey: pendingKeyPair.publicKey, salt: pendingSalt }));
        console.log("[crypto] Key exchange initiated...");
      } else {
        console.log("Switching to terminal mode. Type to interact.\n");
        wsSend({ type: "mode", mode: "terminal" });
      }
      break;

    case "key_exchange_ok":
      if (pendingKeyPair) {
        if (typeof msg.publicKey !== "string") {
          console.error("[crypto] Invalid key_exchange_ok message: missing or non-string publicKey");
          ws.close();
          process.exit(1);
        }
        // Match the server: derive per-connection sub-key using the salt we
        // generated for this connection. Without this, encrypt/decrypt on
        // either end would use mismatched keys and fail.
        const rawSharedKey = deriveSharedKey(msg.publicKey, pendingKeyPair.secretKey);
        const sharedKey = deriveConnectionKey(rawSharedKey, pendingSalt);
        encryptionState = { sharedKey, sendNonce: 0, recvNonce: 0 };
        pendingKeyPair = null;
        pendingSalt = null;
        console.log("[crypto] E2E encryption established");
        console.log("Switching to terminal mode. Type to interact.\n");
        wsSend({ type: "mode", mode: "terminal" });
      }
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
  wsSend({ type: "input", data: data.toString() });
});

ws.on("close", () => {
  console.log("\n[disconnected]");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[error]", err.message);
  process.exit(1);
});
