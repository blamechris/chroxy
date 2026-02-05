/**
 * Direct entry point for development.
 * In production, use the CLI: npx chroxy start
 */
import "dotenv/config";
import { startServer } from "./server.js";

// Load config from environment variables (for dev/testing)
const config = {
  port: parseInt(process.env.PORT || "8765", 10),
  apiToken: process.env.API_TOKEN,
  ngrokAuthToken: process.env.NGROK_AUTHTOKEN,
  ngrokDomain: process.env.NGROK_DOMAIN,
  tmuxSession: process.env.TMUX_SESSION || "claude-code",
  shell: process.env.SHELL_CMD,
};

startServer(config);
