#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import readline from "readline";

const CONFIG_DIR = join(homedir(), ".chroxy");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const program = new Command();

program
  .name("chroxy")
  .description("Remote terminal for Claude Code from your phone")
  .version("0.1.0");

/**
 * Interactive prompt helper
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * chroxy init — Set up configuration
 */
program
  .command("init")
  .description("Initialize Chroxy configuration")
  .option("-f, --force", "Overwrite existing configuration")
  .action(async (options) => {
    console.log("\n🔧 Chroxy Setup\n");

    // Check for existing config
    if (existsSync(CONFIG_FILE) && !options.force) {
      console.log(`Config already exists at ${CONFIG_FILE}`);
      const overwrite = await prompt("Overwrite? (y/N): ");
      if (overwrite.toLowerCase() !== "y") {
        console.log("Keeping existing config. Use --force to overwrite.");
        process.exit(0);
      }
    }

    // Create config directory
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Gather configuration
    console.log("We need a few things to get started:\n");

    // ngrok token
    console.log("1. ngrok auth token");
    console.log("   Get yours at: https://dashboard.ngrok.com/get-started/your-authtoken");
    const ngrokToken = await prompt("   Enter token: ");

    if (!ngrokToken) {
      console.error("\n❌ ngrok token is required");
      process.exit(1);
    }

    // Optional: fixed domain
    console.log("\n2. Fixed ngrok domain (optional, for paid plans)");
    console.log("   Leave blank for a random URL each time");
    const ngrokDomain = await prompt("   Domain: ");

    // Generate API token
    const apiToken = randomUUID();

    // Port
    console.log("\n3. Local WebSocket port");
    const portInput = await prompt("   Port (default 8765): ");
    const port = parseInt(portInput, 10) || 8765;

    // tmux session name
    console.log("\n4. tmux session name");
    const sessionName = (await prompt("   Session (default 'claude-code'): ")) || "claude-code";

    // Build config
    const config = {
      ngrokAuthToken: ngrokToken,
      ngrokDomain: ngrokDomain || null,
      apiToken,
      port,
      tmuxSession: sessionName,
      shell: process.env.SHELL || "/bin/zsh",
    };

    // Write config
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    console.log("\n✅ Configuration saved to:", CONFIG_FILE);
    console.log("\n📱 Your API token (keep this secret):");
    console.log(`   ${apiToken}`);
    console.log("\n🚀 Run 'npx chroxy start' to launch the server");
    console.log("");
  });

/**
 * chroxy start — Launch the server
 */
program
  .command("start")
  .description("Start the Chroxy server")
  .option("-c, --config <path>", "Path to config file", CONFIG_FILE)
  .option("-r, --resume", "Resume an existing Claude Code session instead of starting fresh")
  .action(async (options) => {
    // Load config
    if (!existsSync(options.config)) {
      console.error("❌ No config found. Run 'npx chroxy init' first.");
      process.exit(1);
    }

    const config = JSON.parse(readFileSync(options.config, "utf-8"));
    config.resume = !!options.resume;

    // Set environment variables for the server
    process.env.NGROK_AUTHTOKEN = config.ngrokAuthToken;
    process.env.NGROK_DOMAIN = config.ngrokDomain || "";
    process.env.API_TOKEN = config.apiToken;
    process.env.PORT = String(config.port);
    process.env.TMUX_SESSION = config.tmuxSession;
    process.env.SHELL_CMD = config.shell;

    // Import and run the server
    const { startServer } = await import("./server.js");
    await startServer(config);
  });

/**
 * chroxy config — Show current configuration
 */
program
  .command("config")
  .description("Show current configuration")
  .action(() => {
    if (!existsSync(CONFIG_FILE)) {
      console.log("No config found. Run 'npx chroxy init' first.");
      process.exit(1);
    }

    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));

    console.log("\n📋 Current Configuration\n");
    console.log(`   Config file: ${CONFIG_FILE}`);
    console.log(`   Port: ${config.port}`);
    console.log(`   tmux session: ${config.tmuxSession}`);
    console.log(`   ngrok domain: ${config.ngrokDomain || "(random)"}`);
    console.log(`   API token: ${config.apiToken.slice(0, 8)}...`);
    console.log("");
  });

program.parse();
