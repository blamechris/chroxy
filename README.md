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
- **Provider flexibility** — If you're hitting your Claude programmatic credit cap, swap providers per session with `--provider codex` or `CHROXY_PROVIDER=gemini`. Codex and Gemini bill separately from Anthropic. See [Billing & API usage](#billing--api-usage) below.
- **No tmux required** — CLI headless mode wraps your AI CLI directly (via the Agent SDK for Claude, or `gemini -p` / `codex exec` for the others). Just start and connect.
- **Two views, one session** — Switch between a clean chat UI (markdown-rendered) and a full xterm.js terminal emulator.
- **Multi-session** — Run multiple AI sessions from one server. Create, switch, and destroy from any client.
- **Phone + Desktop** — React Native mobile app and a Tauri desktop tray app with a web dashboard.
- **Encrypted** — End-to-end encryption over Cloudflare tunnel. Your machine, your tunnel, no cloud middleman.
- **Resilient** — Auto-reconnect on network drops, supervisor auto-restart on crash, push notifications for permission prompts.
- **Voice input** — Dictate messages with speech-to-text on mobile and macOS desktop.
- **Docker isolation** — Run sessions in Docker containers with resource limits and security guards.
- **Open source** — MIT licensed. Audit it, fork it, improve it.

## Billing & API usage

Chroxy uses the Claude Agent SDK (or `claude -p`), which Anthropic classifies as **programmatic usage**. Starting **June 15, 2026**, programmatic usage on Claude subscriptions draws from a separate monthly credit pool — not the interactive Claude Code allowance:

| Plan | Programmatic credit / month |
|---|---|
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard | $20 / seat |
| Team Premium | $100 / seat |

Credits reset each billing cycle and don't roll over. When the credit is exhausted, you can either enable paid usage credits (billed at API rates) or have programmatic usage pause until reset.

**For heavy users:** set `ANTHROPIC_API_KEY` to bypass the subscription credit pool entirely and bill the raw Anthropic API account directly. Same SDK, predictable per-token pricing.

Chroxy includes cost controls to help you stay within budget — see `CHROXY_COST_BUDGET` and `CHROXY_SESSION_TIMEOUT` in [packages/server/CONFIG.md](packages/server/CONFIG.md). Prompt caching is enabled by default and typically reduces credit burn 5–10x on long sessions.

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
  # macOS
  brew install node@22

  # Windows
  winget install OpenJS.NodeJS.LTS

  # Linux — use nvm or fnm to get Node 22 (distro packages are usually older)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
  nvm install 22 && nvm use 22
  ```

- **cloudflared** — Cloudflare's tunnel client for remote access (no account needed for Quick Tunnels):
  ```bash
  # macOS
  brew install cloudflared

  # Windows
  winget install Cloudflare.cloudflared

  # Linux (Debian/Ubuntu) — official signed repository
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update && sudo apt-get install cloudflared
  ```

## Quick Start

### Provider credentials

Chroxy reads provider API keys from environment variables at server startup. The default Claude provider uses your existing `claude` CLI login (no extra setup), but Gemini and Codex require explicit keys:

| Provider | Env var | Get a key |
|----------|---------|-----------|
| Claude (default) | `ANTHROPIC_API_KEY` *(optional — uses `claude` CLI login if unset)* | https://console.anthropic.com/settings/keys |
| Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| Codex (OpenAI) | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |

> Claude can also authenticate via your existing `claude` CLI login if you'd rather not set `ANTHROPIC_API_KEY`. Setting the key bypasses your Claude subscription's programmatic credit pool and bills the raw API account — see [Billing & API usage](#billing--api-usage).

Add the keys you'll use to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
```

Or pass them inline when starting the server:

```bash
OPENAI_API_KEY=sk-... PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

If you create a session for a provider whose key isn't set, the server returns a clear error (e.g. *"Codex: required credential not set — OPENAI_API_KEY"*). See [docs/providers.md](docs/providers.md) for per-provider capabilities and full env var reference.

### Server (on your dev machine)

Chroxy is not published to npm yet, so `npx chroxy` resolves from your local clone. Clone the repo and install dependencies first:

```bash
git clone https://github.com/blamechris/chroxy.git
cd chroxy
npm install

# Install and configure
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy init

# Start the server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start
```

The server prints a QR code. Scan it with the Chroxy mobile app, or open the dashboard URL in your browser.

#### Verify it worked

A healthy server prints something like:

```
[✓] Server ready! (CLI headless mode, cloudflare:quick)

📱 Scan this QR code with the Chroxy app:

   <QR code>

Or connect manually:
   URL:   wss://<random>.trycloudflare.com
   Token: ********  (use --show-token to see full token)
   Dashboard: https://<random>.trycloudflare.com/dashboard (use --show-token to see full URL)
```

If something looks off, `npx chroxy doctor` reports which dependencies are missing or misconfigured.

### Development mode

Use `chroxy dev` when iterating on Chroxy itself. It forces supervisor mode (auto-restart on crash) and requires a tunnel (quick or named):

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy dev
```

### Local WiFi (same network)

If your phone and dev machine are on the same WiFi, connect directly without the tunnel. Start the server with `--tunnel none` to skip the tunnel entirely:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start --tunnel none
```

Then:

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

> **Quick Tunnel security note.** The tunnel URL is randomized, but anyone with both your tunnel URL *and* your API token can connect. The token — stored in your OS keychain (or `~/.chroxy/config.json` as fallback) — is the actual secret. Protect it, rotate it if leaked (`npx chroxy init` regenerates), and prefer a Named Tunnel + IP allowlist for anything production-shaped.

### Mobile App

The app requires a **custom dev build** (not Expo Go) because native modules are included. The root `npm install` already covers the workspace:

```bash
cd packages/app

# Build a dev client (one-time, or when native deps change)
npx expo run:ios    # or npx expo run:android

# Daily development (hot-reload)
npx expo start
```

See `packages/app/README.md` for EAS cloud build instructions.

### Desktop App

The desktop app is a Tauri tray application wrapping the web dashboard:

```bash
# One-time: install the Tauri CLI
cargo install cargo-binstall          # optional but fast
cargo binstall tauri-cli --version "^2" --no-confirm

cd packages/desktop
cargo tauri dev
```

## Running on Windows

The server runs on Windows natively — `platform.js`, `supervisor.js`, and `service.js` already handle Windows code paths. The Tauri desktop app ships as a pre-built MSI from the `desktop-windows` release job (attached to each GitHub Release); see the build-from-source instructions below if you want to compile locally.

### Server (headless daemon)

```powershell
# Prereqs
winget install OpenJS.NodeJS.LTS
winget install Cloudflare.cloudflared
winget install Git.Git

# Restart PowerShell so the new tools land on PATH, then:
git clone https://github.com/blamechris/chroxy
cd chroxy
npm install
npx chroxy init
npx chroxy start
```

Same QR-code / manual-entry connection flow as macOS. All session features (model switching, files, git, plan mode, agents) work identically.

**Run at startup:** native Windows service install is not supported by the CLI. Pick one of:
- **Task Scheduler** — schedule `node <chroxy-path> start` at logon
- **NSSM** (https://nssm.cc/) — `nssm install Chroxy node <chroxy-path> start`
- **PM2 with pm2-windows-service** — for full process-manager features

### Desktop tray app (recommended)

Download the latest MSI from the [Releases page](https://github.com/blamechris/chroxy/releases/latest) and double-click to install. WebView2 is preinstalled on Windows 11; on Windows 10, install it once from https://developer.microsoft.com/microsoft-edge/webview2/.

### Desktop tray app — build from source

Only needed if you want to compile locally:

```powershell
# Toolchain prereqs
winget install Rustlang.Rustup
rustup default stable-x86_64-pc-windows-msvc
winget install Microsoft.VisualStudio.2022.BuildTools
# In the installer, select "Desktop development with C++"

# Tauri CLI (one-time)
cargo install cargo-binstall
cargo binstall tauri-cli --version "^2" --no-confirm

# Build
cd packages\desktop
cargo tauri build
```

The MSI lands at `packages\desktop\src-tauri\target\release\bundle\msi\Chroxy_<version>_x64_en-US.msi`.

## Project Structure

```
chroxy/
├── packages/
│   ├── server/      # Node.js daemon, CLI, and bundled web dashboard server
│   ├── dashboard/   # Web dashboard (React + Vite) — built into the server bundle
│   ├── desktop/     # Tauri tray app (Rust) wrapping the dashboard
│   ├── app/         # React Native mobile app (TypeScript, Expo 54)
│   ├── protocol/    # Shared WebSocket protocol types and Zod schemas
│   └── store-core/  # Shared store logic and crypto for app + dashboard
├── docs/            # Setup guides, architecture, provider reference
└── scripts/         # Install and tooling helpers
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
# Server tests (Node 22 required)
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test

# Dashboard tests (Vitest)
cd packages/dashboard
npm test

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
