# Chroxy

> Remote terminal for Claude Code from your phone.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

Run a lightweight daemon on your dev machine. Connect from anywhere via your phone. Get both a full terminal view and a clean chat-like UI that parses Claude Code's output into readable messages.

```
┌─────────────┐                        ┌──────────────────┐
│  Phone      │◄───── secure tunnel ──►│  Your Machine    │
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
- **Two views, one session** — Switch between a clean chat UI and a full xterm.js terminal emulator.
- **Multi-session** — Run multiple Claude sessions from one server. Create, switch, and destroy from the app.
- **Encrypted** — End-to-end encryption over Cloudflare tunnel. Your machine, your tunnel, no cloud middleman.
- **Resilient** — Auto-reconnect on network drops, supervisor auto-restart on crash, push notifications for permission prompts.
- **Voice input** — Dictate messages with speech-to-text from your phone.
- **Cross-platform server** — Runs on macOS, Linux, and Windows.
- **Open source** — MIT licensed. Audit it, fork it, improve it.

## Prerequisites

- **Node.js 22** — Required for the server. Install via Homebrew (macOS) or your package manager:
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

- **tmux** *(optional, macOS/Linux only)* — Only required for PTY mode (`--terminal` flag). CLI headless mode (default) does not need tmux:
  ```bash
  brew install tmux
  ```

## Quick Start

### Server (on your dev machine)

```bash
# Install and configure
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy init

# Start the server (CLI headless mode — no tmux needed)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

The server prints a QR code. Scan it with the Chroxy app.

#### Development mode

Use `chroxy dev` when iterating on Chroxy itself. It forces supervisor mode (auto-restart on crash) regardless of tunnel type, so you can modify server code and deploy without losing your phone connection:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy dev
```

Does not support `--terminal` (PTY) mode.

### Local WiFi (same network)

If your phone and dev machine are on the same WiFi, you can connect directly without the tunnel:

1. Find your machine's local IP:
   ```bash
   ipconfig getifaddr en0
   ```
2. In the Chroxy app, tap **"Enter manually"** and enter:
   - URL: `ws://YOUR_MAC_IP:8765` (e.g. `ws://192.168.1.100:8765`)
   - Token: your API token from `~/.chroxy/config.json`

This skips the Cloudflare tunnel — lower latency, fully local.

### App (on your phone)

The app requires a **custom dev build** (not Expo Go) because native modules like `expo-speech-recognition` and `expo-secure-store` are included:

```bash
cd packages/app
npm install

# Build a dev client (one-time, or when native deps change)
npx expo run:ios    # or npx expo run:android

# For daily development (hot-reload, same as Expo Go)
npx expo start
```

See `packages/app/README.md` for EAS cloud build instructions.

## How It Works

1. **Server** starts a Claude Code process via the Agent SDK (or `claude -p` in legacy mode)
2. **WebSocket server** streams parsed messages, tool use, and permission requests to the app
3. **End-to-end encryption** secures all messages between the server and app
4. **Cloudflare tunnel** provides secure remote access without port forwarding
5. **Mobile app** renders a chat UI with markdown, handles permissions, and sends input back
6. **Multi-session manager** lets you run multiple conversations in parallel

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
# Server tests (700+ tests)
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test

# App type check
cd packages/app
npx tsc --noEmit
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
- [x] Terminal view with xterm.js emulation (WebView)
- [x] Plan mode UI (plan approval card, feedback)
- [x] End-to-end encryption for WebSocket messages
- [x] Voice-to-text input (speech recognition)
- [x] Provider adapter interface (pluggable session backends)
- [x] Windows support for CLI headless mode
- [ ] TestFlight / Play Store release
- [ ] Tailscale support as tunnel alternative
- [ ] Session recording and replay

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

## License

MIT © [blamechris](https://github.com/blamechris)
