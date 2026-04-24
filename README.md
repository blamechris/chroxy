# Chroxy

> Remote terminal for Claude Code, Gemini, and Codex — from your phone or desktop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

Run a lightweight daemon on your dev machine, connect from your phone or desktop via a secure tunnel. Get both a full terminal view and a clean chat-like UI that parses the AI CLI's output into readable messages. Pluggable session providers let you swap between Claude Code (Agent SDK or legacy CLI), Google Gemini, and OpenAI Codex.

```
┌─────────────┐                        ┌──────────────────────┐
│  Phone /    │◄───── secure tunnel ──►│  Your Machine        │
│  Desktop    │                        │                      │
│ ┌─────────┐ │                        │ ┌──────────────────┐ │
│ │Chat View│ │◄── parsed messages ────│ │  Chroxy Server   │ │
│ └─────────┘ │                        │ └────────┬─────────┘ │
│ ┌─────────┐ │                        │ ┌────────┴─────────┐ │
│ │Terminal │ │◄── raw stream ─────────│ │ Provider: Claude │ │
│ └─────────┘ │                        │ │   / Gemini /     │ │
│             │                        │ │   Codex          │ │
│             │                        │ └──────────────────┘ │
└─────────────┘                        └──────────────────────┘
```

## Why Chroxy?

- **Works with Claude Code, Gemini, and Codex** — Pluggable providers let you pick `claude-sdk` (default), `claude-cli`, `gemini`, or `codex` per session. See [docs/providers.md](docs/providers.md).
- **No tmux required** — CLI headless mode wraps your AI CLI directly (via the Agent SDK for Claude, or `gemini -p` / `codex exec` for the others). Just start and connect.
- **Two views, one session** — Switch between a clean chat UI (markdown-rendered) and a full xterm.js terminal emulator.
- **Multi-session** — Run multiple AI sessions from one server. Create, switch, and destroy from any client.
- **Phone + Desktop** — React Native mobile app and a Tauri desktop tray app with a web dashboard.
- **Encrypted** — End-to-end encryption over Cloudflare tunnel. Your machine, your tunnel, no cloud middleman.
- **Resilient** — Auto-reconnect on network drops, supervisor auto-restart on crash, push notifications for permission prompts.
- **Voice input** — Dictate messages with speech-to-text on mobile and macOS desktop.
- **Docker isolation** — Run sessions in Docker containers with resource limits and security guards.
- **Open source** — MIT licensed. Audit it, fork it, improve it.

## Features

**Server:**
CLI headless mode, multi-provider support (Claude Agent SDK, legacy `claude -p`, Gemini, Codex — see [docs/providers.md](docs/providers.md)), WebSocket protocol with auth, Cloudflare tunnel (Quick + Named), supervisor auto-restart, push notifications, multi-session management, model switching, plan mode detection, background agent tracking, web dashboard, persistent container environments (Docker Compose, DevContainer, snapshot/restore), Docker session providers, git worktree isolation, permission rule engine, extensible provider/handler system, shared skills system (drop Markdown files in `~/.chroxy/skills/` — see [docs/skills.md](docs/skills.md))

**Desktop (Tauri):**
System tray app, web dashboard with syntax highlighting (15+ languages), xterm.js terminal, session tabs, desktop notifications, voice-to-text (macOS SFSpeechRecognizer), command palette with keyboard shortcuts

**Mobile (React Native / Expo):**
QR code scanning, LAN auto-discovery, markdown rendering, dual-view chat/terminal, xterm.js terminal emulation, plan approval UI, agent monitoring, voice-to-text input, biometric lock, conversation search, settings screen, auto-reconnect with ConnectionPhase state machine

## Prerequisites

- **Node.js 22+** — Required for the server:
  ```bash
  brew install node@22
  ```

- **cloudflared** — Cloudflare's tunnel client for remote access (no account needed for Quick Tunnels):
  ```bash
  brew install cloudflared
  ```

## Quick Start

### Server (on your dev machine)

```bash
# Install and configure
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy init

# Start the server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

The server prints a QR code. Scan it with the Chroxy mobile app, or open the dashboard URL in your browser.

### Development mode

Use `chroxy dev` when iterating on Chroxy itself. It forces supervisor mode (auto-restart on crash) and requires a tunnel (quick or named):

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy dev
```

### Local WiFi (same network)

If your phone and dev machine are on the same WiFi, connect directly without the tunnel:

1. Find your machine's local IP:
   ```bash
   ipconfig getifaddr en0
   ```
2. In the Chroxy app, tap **"Enter manually"** and enter:
   - URL: `ws://YOUR_IP:8765`
   - Token: the API token printed during `chroxy init` (stored in OS keychain, or `~/.chroxy/config.json` as fallback)

### Tunnel Modes

| Mode | Flag | Description |
|------|------|-------------|
| Quick Tunnel | *(default)* | Random URL, no account needed. URL changes on restart. |
| Named Tunnel | `--tunnel named` | Stable URL that survives restarts. Requires Cloudflare account + domain. |
| No Tunnel | `--tunnel none` | Local only. Use with `--no-auth` for development. |

### Mobile App

The app requires a **custom dev build** (not Expo Go) because native modules are included:

```bash
cd packages/app
npm install

# Build a dev client (one-time, or when native deps change)
npx expo run:ios    # or npx expo run:android

# Daily development (hot-reload)
npx expo start
```

See `packages/app/README.md` for EAS cloud build instructions.

### Desktop App

The desktop app is a Tauri tray application wrapping the web dashboard:

```bash
cd packages/desktop
cargo tauri dev
```

## Project Structure

```
chroxy/
├── packages/
│   ├── server/      # Node.js daemon + CLI + web dashboard
│   ├── app/         # React Native mobile app (TypeScript, Expo 54)
│   ├── desktop/     # Tauri tray app (Rust + web dashboard)
│   ├── protocol/    # Shared protocol types and version
│   └── store-core/  # Shared utilities and crypto
├── docs/            # Setup guides, architecture
└── scripts/         # Install helpers
```

## Architecture

```
Mobile App / Desktop ◄──► Cloudflare Tunnel ◄──► WebSocket Server ◄──► Session Provider ◄──► AI CLI (Claude / Gemini / Codex)
```

- **Server:** `server-cli.js` starts a WebSocket server and creates sessions via pluggable providers (`sdk-session.js` for the Claude Agent SDK, `cli-session.js` for legacy `claude -p`, `gemini-session.js` for Google Gemini, `codex-session.js` for OpenAI Codex, `docker-session.js` for container isolation). Select a provider with `--provider` or `CHROXY_PROVIDER`; see [docs/providers.md](docs/providers.md) for per-provider setup, env vars, and capabilities.
- **WebSocket layer:** Auth, E2E encryption (TweetNaCl), message routing, session management, permission handling
- **Tunnel:** Cloudflare Quick or Named tunnel for secure remote access without port forwarding
- **Supervisor:** When using a tunnel (quick or named), owns the tunnel and auto-restarts the server on crash with exponential backoff
- **Clients:** Mobile app (React Native) and desktop tray app (Tauri) connect over WebSocket; web dashboard served directly by the server

## Development

```bash
# Clone the repo
git clone https://github.com/blamechris/chroxy.git
cd chroxy
npm install

# Terminal 1: Start the server (Node 22 required)
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start

# Terminal 2: Start Expo dev server (for mobile hot-reload)
cd packages/app
npx expo start

# Terminal 3 (optional): Start desktop in dev mode
cd packages/desktop
cargo tauri dev
```

### Running Tests

```bash
# Server tests
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test

# Dashboard tests
cd packages/server
npm run dashboard:test

# App type check
cd packages/app
npx tsc --noEmit

# Lint
cd packages/server
npm run lint
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

## License

MIT © [blamechris](https://github.com/blamechris)
