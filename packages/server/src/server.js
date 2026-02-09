import { PtyManager } from "./pty-manager.js";
import { OutputParser } from "./output-parser.js";
import { WsServer } from "./ws-server.js";
import { TunnelManager } from "./tunnel.js";
import { waitForTunnel } from "./tunnel-check.js";
import qrcode from "qrcode-terminal";

/**
 * Start the Chroxy server with the given configuration.
 * Called by the CLI after loading config.
 */
export async function startServer(config) {
  const PORT = config.port || parseInt(process.env.PORT || "8765", 10);
  const API_TOKEN = config.apiToken || process.env.API_TOKEN;

  // Validate required config
  if (!API_TOKEN) {
    console.error("[!] No API token configured. Run 'npx chroxy init'");
    process.exit(1);
  }

  console.log("");
  console.log("╔════════════════════════════════════════╗");
  console.log("║         Chroxy Server v0.1.0           ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");

  // 1. Start the PTY / tmux session
  const ptyManager = new PtyManager({
    sessionName: config.tmuxSession || process.env.TMUX_SESSION || "claude-code",
    shell: config.shell || process.env.SHELL_CMD,
    resume: config.resume || false,
  });

  // 2. Set up the output parser pipeline
  const outputParser = new OutputParser();

  // Wire PTY output into the parser
  let trustAccepted = false;
  ptyManager.on("data", (data) => {
    outputParser.feed(data);

    // Auto-accept the trust dialog ("Do you trust this folder?")
    // The user running chroxy in a folder IS their trust signal.
    // Must fire regardless of claudeReady state — the dialog can appear at any time.
    const clean = data.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
      ""
    );
    if (/trust\s*this\s*folder/i.test(clean) || /Yes.*trust/i.test(clean)) {
      if (!trustAccepted) {
        trustAccepted = true;
        console.log(`[server] Auto-accepting trust dialog`);
        setTimeout(() => ptyManager.write("\r"), 300);
      }
    }
  });

  ptyManager.on("exit", ({ exitCode }) => {
    console.log(`[pty] Session exited with code ${exitCode}`);
    console.log("[pty] Reattaching in 2s...");
    setTimeout(() => ptyManager.start(), 2000);
  });

  // 3. Start the WebSocket server
  const wsServer = new WsServer({
    port: PORT,
    apiToken: API_TOKEN,
    ptyManager,
    outputParser,
  });
  wsServer.start();

  // 4. Start the Cloudflare tunnel
  const tunnel = new TunnelManager({ port: PORT });

  const { wsUrl, httpUrl } = await tunnel.start();

  // 5. Wait for tunnel to be fully routable (DNS propagation)
  await waitForTunnel(httpUrl);

  // Wire up tunnel lifecycle events
  let currentWsUrl = wsUrl
  
  tunnel.on('tunnel_lost', ({ code, signal }) => {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`
    console.log(`\n[!] Tunnel lost (${exitReason})`)
    wsServer.broadcastError('tunnel', `Tunnel connection lost (${exitReason}). Recovering...`, true)
  })

  tunnel.on('tunnel_recovering', ({ attempt, delayMs }) => {
    console.log(`[!] Attempting tunnel recovery (attempt ${attempt}, waiting ${delayMs}ms)...`)
  })

  tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
    console.log(`[✓] Tunnel recovered after ${attempt} attempt(s)`)
    
    // Re-verify the new tunnel URL
    await waitForTunnel(newHttpUrl)
    
    if (newWsUrl !== currentWsUrl) {
      currentWsUrl = newWsUrl
      const newConnectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${API_TOKEN}`
      console.log('\n[✓] New tunnel URL established:\n')
      console.log('📱 Scan this QR code with the Chroxy app:\n')
      qrcode.generate(newConnectionUrl, { small: true })
      console.log(`\nOr connect manually:`)
      console.log(`   URL:   ${newWsUrl}`)
      console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
      console.log('')
      wsServer.broadcastError('tunnel', `Tunnel reconnected with new URL: ${newWsUrl}`, true)
    } else {
      console.log(`[✓] Tunnel URL unchanged: ${newWsUrl}`)
      wsServer.broadcastError('tunnel', 'Tunnel reconnected successfully', true)
    }
  })

  tunnel.on('tunnel_failed', ({ message, lastExitCode, lastSignal }) => {
    console.error(`\n[!] ${message}`)
    console.error(`[!] Last exit: code=${lastExitCode} signal=${lastSignal}`)
    console.error(`[!] Server will continue on localhost only. Remote connections will not work.`)
    wsServer.broadcastError('tunnel', 'Tunnel recovery failed. Remote connections will not work.', false)
  })


  // 6. Start the PTY (do this last so tunnel is ready)
  await ptyManager.start();

  // Generate connection info for the app
  const connectionUrl = `chroxy://${wsUrl.replace("wss://", "")}?token=${API_TOKEN}`;

  console.log("\n[✓] Server ready!\n");
  console.log("📱 Scan this QR code with the Chroxy app:\n");
  qrcode.generate(connectionUrl, { small: true });
  console.log(`\nOr connect manually:`);
  console.log(`   URL:   ${wsUrl}`);
  console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`);
  console.log("\nPress Ctrl+C to stop.\n");

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[${signal}] Shutting down...`);
    ptyManager.destroy();
    wsServer.close();
    await tunnel.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
