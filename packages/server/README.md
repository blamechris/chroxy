# @chroxy/server

Node.js daemon that bridges your phone to a tmux session running Claude Code.

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
| `chroxy init` | Interactive setup — prompts for ngrok token, generates API token |
| `chroxy start` | Start the server, display QR code |
| `chroxy config` | Show current configuration |

## Manual Setup

If you prefer to configure manually:

```bash
cp .env.example .env
# Edit .env with your settings
npm run dev
```

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
│  pty-manager  │ │ ws-server │ │    tunnel     │
│               │ │           │ │               │
│ Spawns tmux,  │ │ WebSocket │ │ ngrok tunnel  │
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

The output parser (`src/output-parser.js`) uses regex patterns to identify Claude Code output structures. You'll likely need to tune these patterns based on your actual Claude Code sessions.

To capture sample output for analysis:

```bash
# Start a tmux session
tmux new -s test

# In another terminal, capture the raw output
tmux pipe-pane -o -t test 'cat >> ~/claude-output.log'

# Run claude code, do some work, then analyze the log
```

## Development

```bash
# Run with auto-reload
npm run dev

# Test with the CLI client
node src/test-client.js wss://your-url.ngrok-free.app
```
