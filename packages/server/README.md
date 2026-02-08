# @chroxy/server

Node.js daemon that bridges your phone to Claude Code via WebSocket over Cloudflare tunnel.

**Two modes:**
- **CLI headless (default)**: Wraps `claude -p --input-format stream-json --output-format stream-json`, no tmux needed
- **PTY/tmux (opt-in with `--terminal`)**: Spawns tmux session for raw terminal access

## Quick Start

```bash
# Initialize configuration
npx chroxy init

# Start the server
npx chroxy start
```

The server will print a QR code. Scan it with the Chroxy app.

## CLI Commands

| Command | Description |
|---------|-------------|
| `chroxy init` | Interactive setup — generates API token and config file |
| `chroxy start` | Start server in CLI headless mode (default) |
| `chroxy start --terminal` | Start server in PTY/tmux mode |
| `chroxy start --no-auth` | Start without authentication in CLI mode only; binds to localhost and disables Cloudflare tunnel (development only) |
| `chroxy start --config /path` | Use a specific config file instead of the default |
| `chroxy start --resume` | Resume the previous session where supported (reuses prior working directory/context) |
| `chroxy start --cwd /path` | Set working directory (CLI mode) |
| `chroxy start --model opus` | Use a specific Claude model (CLI mode) |
| `chroxy start --allowed-tools tool1,tool2` | Restrict which tools are exposed to clients (CLI mode, comma-separated list) |
| `chroxy config` | Show current configuration |

## Manual Setup

If you prefer to configure manually:

```bash
cp .env.example .env
# Edit .env with your settings
npm run dev
```

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
│ server-cli.js │ │ ws-server │ │    tunnel     │
│               │ │           │ │               │
│ Orchestrates  │ │ WebSocket │ │ cloudflared   │
│ CLI sessions  │ │ + auth    │ │ management    │
└───────┬───────┘ └───────────┘ └───────────────┘
        │
        ▼
┌───────────────┐
│ cli-session.js│
│               │
│ claude -p     │
│ --output-     │
│ format        │
│ stream-json   │
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
│  pty-manager  │ │ ws-server │ │    tunnel     │
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

## WebSocket Protocol

See the main [README](../../README.md) for protocol details.

## Tuning the Output Parser

The output parser (`src/output-parser.js`) is only used in PTY/tmux mode. It uses regex patterns and state machines to identify Claude Code output structures from raw terminal output.

CLI headless mode receives structured JSON events from `claude -p --output-format stream-json`, so no parsing is needed.

To capture sample output for PTY mode analysis:

```bash
# Start server in PTY mode
npx chroxy start --terminal

# In another terminal, capture the raw output
tmux pipe-pane -o -t claude-code 'cat >> ~/claude-output.log'

# Run claude code, do some work, then analyze the log
```

## Development

```bash
# Run with auto-reload
npm run dev

# Test with the CLI client
node src/test-client.js wss://your-cloudflare-url
```
