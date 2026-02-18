# @chroxy/server

Node.js daemon that bridges your phone to Claude Code via WebSocket over Cloudflare tunnel.

**Two modes:**
- **CLI headless (default)**: Uses the Claude Agent SDK for in-process streaming. No tmux needed.
- **PTY/tmux (opt-in with `--terminal`)**: Spawns tmux session for raw terminal access.

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
| `chroxy start` | Start server in CLI headless mode (default) |
| `chroxy start --terminal` | Start server in PTY/tmux mode |
| `chroxy start --tunnel named` | Use a named tunnel for stable URLs (requires Cloudflare account) |
| `chroxy start --tunnel cloudflare:named` | Explicit provider:mode syntax |
| `chroxy start --tunnel none` | Disable tunnel (local only) |
| `chroxy start --no-auth` | Start without authentication (CLI mode only, binds to localhost) |
| `chroxy start --no-supervisor` | Disable supervisor auto-restart (named tunnel mode) |
| `chroxy start --config /path` | Use a specific config file |
| `chroxy start --resume` | Resume the previous session |
| `chroxy start --cwd /path` | Set working directory (CLI mode) |
| `chroxy start --model opus` | Use a specific Claude model (CLI mode) |
| `chroxy start --allowed-tools tool1,tool2` | Restrict exposed tools (CLI mode) |
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
| `chroxy wrap -n name` | Create a discoverable tmux session running Claude |

## Architecture

**CLI Headless Mode (default):**
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
│ SDK sessions  │ │ + auth    │ │ management    │
└───────┬───────┘ └───────────┘ └───────────────┘
        │
        ▼
┌───────────────┐
│sdk-session.js │
│               │
│ Claude Agent  │
│ SDK query()   │
└───────────────┘
```

**PTY/tmux Mode (`--terminal` flag):**
```
┌─────────────────────────────────────────────────────┐
│                    index.js                         │
│                   (entry point)                     │
└─────────────────────┬───────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌───────────────┐ ┌───────────┐ ┌───────────────┐
│  pty-manager  │ │ ws-server │ │   tunnel/    │
│               │ │           │ │               │
│ Spawns tmux,  │ │ WebSocket │ │ cloudflared   │
│ handles PTY   │ │ + auth    │ │ management    │
└───────┬───────┘ └─────┬─────┘ └───────────────┘
        │               │
        ▼               │
┌───────────────┐       │
│ output-parser │◄──────┘
│               │
│ Raw PTY →     │
│ structured    │
│ messages      │
└───────────────┘
```

## Key Components

| Component | File | Purpose |
|-----------|------|---------|
| ProviderRegistry | `providers.js` | Provider adapter interface + built-in registrations |
| SdkSession | `sdk-session.js` | Claude Agent SDK executor (default provider) |
| CliSession | `cli-session.js` | Legacy headless executor via `claude -p` |
| SessionManager | `session-manager.js` | Multi-session lifecycle management |
| WsServer | `ws-server.js` | WebSocket protocol with auth + encryption |
| TunnelRegistry | `tunnel/registry.js` | Pluggable tunnel adapter registry |
| BaseTunnelAdapter | `tunnel/base.js` | Base class with shared recovery logic |
| CloudflareTunnelAdapter | `tunnel/cloudflare.js` | Cloudflare adapter (quick/named modes) |
| Supervisor | `supervisor.js` | Tunnel owner + child auto-restart (named tunnel) |
| PushManager | `push.js` | Push notifications via Expo Push API |
| PtyManager | `pty-manager.js` | tmux session management (PTY mode) |
| OutputParser | `output-parser.js` | Terminal output parser (PTY mode) |

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
