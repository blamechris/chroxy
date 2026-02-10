# Chroxy

> Remote terminal for Claude Code from your phone.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

Run a lightweight daemon on your dev machine. Connect from anywhere via your phone. Get both a full terminal view and a clean chat-like UI that parses Claude Code's output into readable messages.

```
┌─────────────┐                        ┌──────────────────┐
│  Phone      │◄───── secure tunnel ──►│  Your Mac        │
│             │                        │                  │
│ ┌─────────┐ │                        │ ┌──────────────┐ │
│ │Chat View│ │◄── parsed messages ────│ │ Chroxy Server│ │
│ └─────────┘ │                        │ └──────┬───────┘ │
│ ┌─────────┐ │                        │ ┌──────┴───────┐ │
│ │Terminal │ │◄── raw PTY stream ─────│ │  Claude Code  │ │
│ └─────────┘ │                        │ └──────────────┘ │
└─────────────┘                        └──────────────────┘
```

## Why Chroxy?

- **No tmux required** — CLI headless mode wraps Claude Code directly. Just start the server and connect.
- **Two views, one session** — Switch between a clean chat UI and raw terminal access.
- **Multi-session** — Run multiple Claude sessions from one server. Create, switch, and destroy from the app.
- **Privacy-first** — Your machine, your tunnel. No cloud middleman storing your code.
- **Resilient** — Auto-reconnect on network drops, supervisor auto-restart on crash, push notifications for permission prompts.
- **Open source** — MIT licensed. Audit it, fork it, improve it.

## Prerequisites

- **Node.js 22** — Required for `node-pty` (PTY mode). Install via Homebrew:
  ```bash
  brew install node@22
  ```
  Run server commands with Node 22 on your PATH:
  ```bash
  PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
  ```

- **cloudflared** — Cloudflare's tunnel client for remote access. No account needed for Quick Tunnels:
  ```bash
  brew install cloudflared
  ```

- **tmux** *(optional)* — Only required for PTY mode (`--terminal` flag). CLI headless mode (default) does not need tmux:
  ```bash
  brew install tmux
  ```

## Quick Start

### Server (on your Mac)

```bash
# Install and configure
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy init

# Start the server (CLI headless mode — no tmux needed)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

The server prints a QR code. Scan it with the Chroxy app.

### Local WiFi (same network)

If your phone and Mac are on the same WiFi, you can connect directly without the tunnel:

1. Find your Mac's local IP:
   ```bash
   ipconfig getifaddr en0
   ```
2. In the Chroxy app, tap **"Enter manually"** and enter:
   - URL: `ws://YOUR_MAC_IP:8765` (e.g. `ws://192.168.1.100:8765`)
   - Token: your API token from `~/.chroxy/config.json`

This skips the Cloudflare tunnel — lower latency, fully local.

### App (on your phone)

For development, use Expo Go:
```bash
cd packages/app
npm install
npx expo start
```

Scan the Expo dev server QR code with Expo Go on your phone.

## How It Works

1. **Server** starts a Claude Code process (`claude -p` with structured JSON streaming)
2. **WebSocket server** streams parsed messages, tool use, and permission requests to the app
3. **Cloudflare tunnel** provides secure remote access without port forwarding
4. **Mobile app** renders a chat UI with markdown, handles permissions, and sends input back
5. **Multi-session manager** lets you run multiple conversations in parallel

### Server Modes

| Mode | Flag | Description |
|------|------|-------------|
| CLI headless | *(default)* | Wraps `claude -p` directly. No tmux needed. Structured JSON streaming. |
| PTY/tmux | `--terminal` | Spawns tmux session for raw terminal access. Requires tmux + node-pty. |

### Tunnel Modes

| Mode | Flag | Description |
|------|------|-------------|
| Quick Tunnel | *(default)* | Random URL, no account needed. URL changes on restart. |
| Named Tunnel | `--tunnel named` | Stable URL that survives restarts. Requires Cloudflare account + domain. |
| No Tunnel | `--tunnel none` | Local only. Use with `--no-auth` for development. |

## Project Structure

```
chroxy/
├── packages/
│   ├── server/     # Node.js daemon + CLI (ES modules, no TypeScript)
│   └── app/        # React Native mobile app (TypeScript, Expo 54)
├── docs/           # Setup guides, architecture
└── scripts/        # Install helpers
```

## Development

You need **two terminals** during development:

```bash
# Clone the repo
git clone https://github.com/blamechris/chroxy.git
cd chroxy
npm install

# Terminal 1: Start the Chroxy server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start

# Terminal 2: Start the Expo dev server (for hot-reload to phone)
cd packages/app
npx expo start
```

Open Expo Go on your phone and scan the Expo dev server QR code. Then use the Chroxy app to scan the server's QR code (from Terminal 1) to connect.

### Running Tests

```bash
# Server tests (395 tests)
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test
```

## Roadmap

- [x] CLI headless mode with structured JSON streaming
- [x] Claude Agent SDK integration
- [x] WebSocket protocol with auth
- [x] Cloudflare tunnel (Quick + Named)
- [x] Supervisor auto-restart (named tunnel mode)
- [x] Multi-session support
- [x] Push notifications for permission prompts
- [x] React Native app with QR scanning
- [x] Chat view with markdown rendering
- [x] Permission handling UI (approve/deny/always allow)
- [x] Model switching and permission mode switching
- [x] Context window and cost tracking
- [x] Auto-reconnect with ConnectionPhase state machine
- [x] Message selection (copy/share)
- [x] Agent monitoring (background tasks)
- [ ] Terminal view with xterm.js (currently plain text)
- [ ] Plan mode UI
- [ ] Settings page polish
- [ ] TestFlight / Play Store release
- [ ] Tailscale support as tunnel alternative
- [ ] Session recording and replay

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

## License

MIT © [blamechris](https://github.com/blamechris)
