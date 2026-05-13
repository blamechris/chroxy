# @chroxy/server

Node.js daemon that bridges your phone to Claude Code via WebSocket over Cloudflare tunnel.

The server runs in **CLI headless mode**: it executes the Claude Agent SDK in-process by default, or shells out to `claude -p`, `gemini -p`, or `codex exec` for the other providers, and streams parsed events to clients. No tmux, no PTY.

## Quick Start

```bash
# Initialize configuration
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy init

# Start the server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

The server will print a QR code. Scan it with the Chroxy app.

## CLI Commands

| Command | Description |
|---------|-------------|
| `chroxy init` | Interactive setup — generates API token and config file |
| `chroxy start` | Start server (default: Quick Tunnel) |
| `chroxy start --tunnel named` | Use a named tunnel for stable URLs (requires Cloudflare account) |
| `chroxy start --tunnel cloudflare:named` | Explicit provider:mode syntax |
| `chroxy start --tunnel none` | Disable tunnel (local only) |
| `chroxy start --no-auth` | Start without authentication (localhost only) |
| `chroxy start --no-supervisor` | Disable supervisor auto-restart (named tunnel mode) |
| `chroxy start --config /path` | Use a specific config file |
| `chroxy start --cwd /path` | Set working directory |
| `chroxy start --model opus` | Use a specific Claude model |
| `chroxy start --allowed-tools tool1,tool2` | Restrict exposed tools |
| `chroxy start --provider name` | Use a specific session provider (default: `claude-sdk`) |
| `chroxy start --no-encrypt` | Disable end-to-end encryption |
| `chroxy dev` | Development mode (supervisor + auto-restart) |
| `chroxy deploy` | Validate and restart the running server |
| `chroxy config` | Show current configuration |
| `chroxy doctor` | Check dependencies and environment |
| `chroxy sessions` | List saved sessions with conversation IDs |
| `chroxy resume [session]` | Resume a Chroxy session in your terminal |
| `chroxy tunnel setup` | Interactive named tunnel setup (default: Cloudflare) |
| `chroxy tunnel setup --provider <name>` | Setup a specific tunnel provider |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    index.js                         │
│                   (entry point)                     │
└─────────────────────┬───────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌───────────────┐ ┌───────────┐ ┌───────────────┐
│ server-cli.js │ │ ws-server │ │   tunnel/    │
│               │ │           │ │               │
│ Orchestrates  │ │ WebSocket │ │ cloudflared   │
│ sessions via  │ │ + auth    │ │ management    │
│ providers.js  │ └───────────┘ └───────────────┘
└───────┬───────┘
        │
        ▼
┌───────────────┐
│sdk-session.js │  (default — Claude Agent SDK)
│cli-session.js │  (legacy claude -p)
│gemini-session │  (Google Gemini)
│codex-session  │  (OpenAI Codex)
│docker-session │  (containerized — opt-in)
└───────────────┘
```

## Key Components

| Component | File | Purpose |
|-----------|------|---------|
| ProviderRegistry | `providers.js` | Provider adapter interface + built-in registrations |
| SdkSession | `sdk-session.js` | Claude Agent SDK executor (default provider) |
| CliSession | `cli-session.js` | Legacy headless executor via `claude -p` |
| GeminiSession | `gemini-session.js` | Google Gemini CLI executor |
| CodexSession | `codex-session.js` | OpenAI Codex CLI executor |
| SessionManager | `session-manager.js` | Multi-session lifecycle management |
| WsServer | `ws-server.js` | WebSocket protocol with auth + encryption |
| TunnelRegistry | `tunnel/registry.js` | Pluggable tunnel adapter registry |
| BaseTunnelAdapter | `tunnel/base.js` | Base class with shared recovery logic |
| CloudflareTunnelAdapter | `tunnel/cloudflare.js` | Cloudflare adapter (quick/named modes) |
| Supervisor | `supervisor.js` | Tunnel owner + child auto-restart (named tunnel) |
| PushManager | `push.js` | Push notifications via Expo Push API |

## Development

```bash
# Run with auto-reload
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dev

# Run tests (700+ tests)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test

# Test with the CLI client
node src/test-client.js wss://your-cloudflare-url
```

## WebSocket Protocol

See the main [README](../../README.md) for protocol details, or the header comment in `src/ws-server.js` for the full message type reference.
