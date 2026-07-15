# Chroxy

> Remote terminal for Claude Code, Gemini, Codex, DeepSeek, Ollama, and any OpenAI/Anthropic-compatible model — from your phone or desktop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

Run a lightweight daemon on your dev machine, connect from your phone or desktop via a secure tunnel. Get both a full terminal view and a clean chat-like UI that parses the AI CLI's output into readable messages. Pluggable session providers let you swap between Claude Code (Agent SDK, legacy CLI, or the interactive TUI), Google Gemini, OpenAI Codex, DeepSeek, local models via Ollama, your own Anthropic API key (BYOK), and any config-driven OpenAI- or Anthropic-compatible endpoint (LM Studio, OpenRouter, vLLM, …). See [docs/providers.md](docs/providers.md).

> **Claude is the default, not a requirement.** The daemon defaults to the `claude-tui` provider out of the box, but a Codex-, Gemini-, Ollama-, or BYOK-only setup needs no `claude` binary at all — set `"provider"` in `~/.chroxy/config.json` (both the daemon **and** `chroxy doctor` honor it, so neither demands `claude`).

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

- **Multi-provider, not Claude-only** — Pluggable providers let you pick `claude-tui` (default), `claude-sdk`, `claude-cli`, `claude-byok`, `gemini`, `codex`, `deepseek`, `ollama` (local models), or any config-driven OpenAI/Anthropic-compatible endpoint per session. Claude is the default, not a dependency — run a Codex- or Gemini-only setup with no `claude` binary installed. See [docs/providers.md](docs/providers.md).
- **Provider flexibility** — If you're hitting your Claude programmatic credit cap, swap providers per session with `--provider codex` or `CHROXY_PROVIDER=gemini`. Codex and Gemini bill separately from Anthropic. See [Billing & API usage](#billing--api-usage) below.
- **No tmux required** — CLI headless mode wraps your AI CLI directly (via the Agent SDK for Claude, or `gemini -p` / `codex exec` for the others). Just start and connect.
- **Two views, one session** — Switch between a clean chat UI (markdown-rendered) and a full xterm.js terminal emulator.
- **Multi-session** — Run multiple AI sessions from one server. Create, switch, and destroy from any client.
- **Phone + Desktop** — React Native mobile app and a Tauri desktop tray app with a web dashboard.
- **Encrypted** — End-to-end encryption over Cloudflare tunnel. Your machine, your tunnel, no cloud middleman.
- **Resilient** — Auto-reconnect on network drops, supervisor auto-restart on crash, push notifications for permission prompts.
- **Discord notifications** — A live status embed per project that pings when a session is ready for input or needs approval — even for plain Claude Code sessions outside chroxy, via the `chroxy-hooks` installer. See [docs/guides/discord-notifications.md](docs/guides/discord-notifications.md).
- **Voice input** — Dictate messages with speech-to-text on mobile and macOS desktop.
- **Docker isolation** — Run sessions in Docker containers with resource limits and security guards.
- **Open source** — MIT licensed. Audit it, fork it, improve it.

## Billing & API usage

The default provider is `claude-tui` (see #5819), which drives the interactive `claude` TUI and bills against your subscription's interactive allowance today (a best-effort bet — see below). The Claude Agent SDK / `claude -p` providers (`claude-sdk`, `claude-cli`) instead use what Anthropic classifies as **programmatic usage**. Starting **June 15, 2026**, programmatic usage on Claude subscriptions draws from a separate monthly credit pool — not the interactive Claude Code allowance:

| Plan | Programmatic credit / month |
|---|---|
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard | $20 / seat |
| Team Premium | $100 / seat |

> Figures as of 2026-05 from Anthropic's published plan details — see [anthropic.com/pricing](https://www.anthropic.com/pricing) for the authoritative source. Anthropic may adjust the cutover date or amounts; trust the link above over this table if they ever disagree.

Credits reset each billing cycle and don't roll over. When the credit is exhausted, you can either enable paid usage credits (billed at API rates) or have programmatic usage pause until reset.

**For heavy users:** set `ANTHROPIC_API_KEY` to bypass the subscription credit pool entirely and bill the raw Anthropic API account directly. Same SDK, predictable per-token pricing.

**The default stays on the subscription (best-effort):** the `claude-tui` provider — the zero-config default (see #5819) — drives the interactive `claude` TUI under a PTY instead of the SDK / `claude -p`, so each turn **currently** bills against your subscription's interactive allowance — the same pool `claude` uses when you run it locally — rather than the programmatic credit pool. This is an unguaranteed bet, not a sanctioned path: Anthropic may reclassify or enforce against third-party automation of a subscription login, so treat it as best-effort and keep BYOK (`ANTHROPIC_API_KEY`) as a fallback. Switch to the SDK explicitly with `--provider claude-sdk` (or back with `--provider claude-tui` / `CHROXY_PROVIDER=claude-tui`). Trade-off: `claude-tui` has no live token streaming, no live model switch, no plan mode, no resume — see [docs/providers.md#claude-tui](docs/providers.md#claude-tui).

A second subscription-billed path, `claude-channel`, is in **research preview**: it will drive Claude through Anthropic's first-party channels MCP protocol (`claude --channels`) rather than scraping the TUI, and — once the backend lands — will add live streaming plus a first-party permission relay. It is currently a scaffold whose session backend isn't runnable yet (the bridge lands in a follow-up); when it does run it will require `claude` ≥ 2.1.80 and the `--dangerously-load-development-channels` flag — see [docs/providers.md#claude-channel-research-preview](docs/providers.md#claude-channel-research-preview).

Chroxy includes cost controls to help you stay within budget — see `CHROXY_COST_BUDGET` and `CHROXY_SESSION_TIMEOUT` in [packages/server/CONFIG.md](packages/server/CONFIG.md). Prompt caching is enabled by default and typically reduces credit burn 5–10x on long sessions.

## Features

**Server:**
CLI headless mode, multi-provider support (Claude Agent SDK, legacy `claude -p`, Gemini, Codex, DeepSeek, Ollama, BYOK Anthropic API, any Anthropic-compatible endpoint — see [docs/providers.md](docs/providers.md)), WebSocket protocol with auth, Cloudflare tunnel (Quick + Named), supervisor auto-restart, push notifications, Discord status-embed notifications (see [docs/guides/discord-notifications.md](docs/guides/discord-notifications.md)), external-session event ingest via `@chroxy/claude-hooks`, multi-session management, model switching with a user-extensible model-metadata overlay ([`~/.chroxy/models.json`](docs/guides/model-overlay.md)) and graceful degradation for unknown models, plan mode detection, background agent tracking, web dashboard, per-session / per-repo system-prompt preambles (trust-gated `.chroxy/session.json` + daemon overrides), billing-class-aware cost tracking (BYOK / subscription / programmatic-credit) with a monthly programmatic-credit budget meter, persistent container environments (Docker Compose, DevContainer, snapshot/restore), Docker session providers, git worktree isolation, permission rule engine + per-session permission attribution, encrypted credentials at rest, extensible provider/handler system, runtime skills — inject your own conventions into every session's prompt (drop Markdown files in `~/.chroxy/skills/`, optionally scoped per provider — see [docs/skills.md](docs/skills.md); distinct from the contributor-facing [dev-workflow `/skill` commands](docs/dev-workflow-skills.md))

**Desktop (Tauri):**
System tray app, web dashboard with syntax highlighting (15+ languages), xterm.js terminal, session tabs with per-tab status + pending-permission indicators, desktop notifications, voice-to-text (macOS SFSpeechRecognizer) with hold-Space push-to-talk dictation, sidebar token/credit-spend meter, command palette with keyboard shortcuts

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
  # nvm isn't on PATH until you reload your shell:
  export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
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

> **New here? Follow the [Setup & Smoke Test guide](docs/setup-and-smoke-test.md)** — a
> step-by-step, copy-pasteable walkthrough that takes you from `git clone` to a
> verified, running daemon, with a runnable smoke test (`doctor` → `status` →
> `/health` → the Playwright dashboard check) so you can confirm it works end to end.

### Provider credentials

Chroxy reads provider API keys from environment variables at server startup. The default Claude provider uses your existing `claude` CLI login (no extra setup), but Gemini and Codex require explicit keys:

| Provider | Env var | Get a key |
|----------|---------|-----------|
| Claude (default) | `ANTHROPIC_API_KEY` *(optional)* | https://console.anthropic.com/settings/keys |
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

**Running without Claude installed?** The daemon defaults to the `claude-tui` provider, so a bare `chroxy start` expects a `claude` binary. To run a Codex- or Gemini-only machine (no `claude` at all), make a non-Claude provider the default. The cleanest way is to set it in `~/.chroxy/config.json`, because both the daemon **and** `chroxy doctor` read `config.provider`:

```jsonc
// ~/.chroxy/config.json
{ "provider": "codex" }
```

```bash
# Codex-only — no `claude` binary required. doctor honors config.provider too,
# so it preflights Codex (not claude) and won't complain about a missing binary.
OPENAI_API_KEY=sk-... npx chroxy start
```

`CHROXY_PROVIDER=codex npx chroxy start` also works to set the daemon's start-time default, but `chroxy doctor` reads `config.provider` from `~/.chroxy/config.json` rather than the env var — so setting it in the config file is what keeps *both* commands claude-free. Any client can still switch providers per session on session create (`--provider gemini`, or the provider picker in the app/dashboard).

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

On Windows PowerShell:

```powershell
git clone https://github.com/blamechris/chroxy.git
cd chroxy
npm install

# Install and configure
npx chroxy init

# Start the server
npx chroxy start
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

On Windows PowerShell:

```powershell
npx chroxy start --tunnel none
```

Then:

1. Find your machine's local IP:
   ```bash
   # macOS
   ipconfig getifaddr en0
   ```
   ```powershell
   # Windows PowerShell
   Get-NetIPAddress -AddressFamily IPv4 |
     Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
     Select-Object IPAddress,InterfaceAlias
   ```
2. In the Chroxy app, tap **"Enter manually"** and enter:
   - URL: `ws://YOUR_IP:8765`
   - Token: the API token printed during `chroxy init` (stored in OS keychain, or `~/.chroxy/config.json` as fallback)
3. For the web dashboard, open `http://YOUR_IP:8765/dashboard?token=YOUR_TOKEN` the first time. The token query sets the dashboard auth cookie and lets the browser app open its WebSocket connection. After that, plain `/dashboard` can load the page, but reconnecting may still need the full token URL if browser storage was cleared.

### Tunnel Modes

| Mode | Flag | Description |
|------|------|-------------|
| Quick Tunnel | *(default)* | Random URL, no account needed. URL changes on restart. |
| Named Tunnel | `--tunnel named` | Stable URL that survives restarts. Requires Cloudflare account + domain. |
| No Tunnel | `--tunnel none` | Local only. Use with `--no-auth` for development. |

> **Quick Tunnel security note.** The tunnel URL is randomized, but anyone with both your tunnel URL *and* your API token can connect. The token is the actual secret — protect it, rotate it if leaked (`npx chroxy init` regenerates), and prefer a Named Tunnel + IP allowlist for anything production-shaped.

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
# One-time: install the Tauri CLI (pick one)
cargo install tauri-cli --version "^2"                       # standard, ~3 min
# or, faster via prebuilt binaries:
cargo install cargo-binstall && \
  cargo binstall tauri-cli --version "^2" --no-confirm

cd packages/desktop
cargo tauri dev
```

The `cargo install` step assumes you already have a Rust toolchain. macOS users typically pick one up with Xcode CLI tools. On a clean Linux box you'll need `rustup` plus a few system libraries Tauri links against — see the next section.

### Desktop App — Linux prerequisites

A clean Debian / Ubuntu install is missing both Rust and Tauri's GTK/WebKit deps. Run this once before the `cargo install tauri-cli` step above:

```bash
# 1. Rust toolchain (installs cargo + rustc into ~/.cargo/bin)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. Tauri's required system libraries
# (Debian/Ubuntu — Fedora/Arch package names differ; see Tauri docs link below)
# Maintainers: resync this list against https://v2.tauri.app/start/prerequisites/#linux
# at each Tauri minor bump — upstream occasionally renames/adds packages.
sudo apt update
sudo apt install -y \
  build-essential curl wget file libssl-dev libxdo-dev \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev \
  libayatana-appindicator3-dev
```

Then continue with `cargo install tauri-cli --version "^2"` (or `cargo binstall` for prebuilts) and `cargo tauri dev` from the section above.

For other distros (Fedora, Arch, NixOS) see Tauri's prerequisites guide: https://v2.tauri.app/start/prerequisites/

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
npm install          # no Visual Studio / node-gyp needed — node-pty ships prebuilt Windows binaries
npx chroxy doctor    # verify Node, cloudflared, and the port are ready
npx chroxy init
npx chroxy start
```

Same QR-code / manual-entry connection flow as macOS. All session features (model switching, files, git, plan mode, agents) work identically.

**Quickest start — local/LAN, no Cloudflare account, no tunnel:**

```powershell
npx chroxy start --tunnel none --host 127.0.0.1 --show-token
```

This binds the server locally and prints a **token-gated dashboard URL**. With `--show-token` the printed URL includes the `?token=…`, so you can open it directly in any Windows browser for the full chat/terminal UI — no desktop app needed. (Without the flag the URL and token are masked in the output; add `--show-token`, or append the token yourself.) Drop `--host 127.0.0.1` (the default is `0.0.0.0`) to also reach it from your phone over the LAN. Plain `npx chroxy start` (a Cloudflare Quick Tunnel) works too; if the edge isn't routable yet it degrades to local/LAN instead of aborting — pass `--tunnel named` for a stable remote URL.

**Run at startup:** native Windows service install is not supported by the CLI. Pick one of:
- **Task Scheduler** — schedule `node <chroxy-path> start` at logon
- **NSSM** (https://nssm.cc/) — `nssm install Chroxy node <chroxy-path> start`
- **PM2 with pm2-windows-service** — for full process-manager features

### Desktop tray app (recommended)

Download the latest MSI from the [Releases page](https://github.com/blamechris/chroxy/releases/latest) and double-click to install. WebView2 is preinstalled on Windows 11; on Windows 10, install it once from https://developer.microsoft.com/microsoft-edge/webview2/.

**Prerequisite — Node.js 22.** The MSI bundles the Chroxy server but **not** a Node runtime, so the tray launches the server with your **system Node** (discovered from `%ProgramFiles%\nodejs`, nvm-windows, or `PATH`). Install it first — `winget install OpenJS.NodeJS.LTS` — otherwise the tray window opens but the server won't start, failing with a "Could not find Node.js >= 22" error (the in-app hint points to nodejs.org / nvm-windows). Install Node 22+, then use the tray's Start/Restart.

### Desktop tray app — build from source

Only needed if you want to compile locally:

```powershell
# Toolchain prereqs
winget install Rustlang.Rustup
rustup default stable-x86_64-pc-windows-msvc
winget install Microsoft.VisualStudio.2022.BuildTools
# In the installer, select "Desktop development with C++"

# Tauri CLI (one-time)
cargo install tauri-cli --version "^2"
# or faster via prebuilts: cargo install cargo-binstall && cargo binstall tauri-cli --version "^2" --no-confirm

# Build
cd packages\desktop
cargo tauri build
```

The MSI lands at `packages\desktop\src-tauri\target\release\bundle\msi\Chroxy_<version>_x64_en-US.msi`.

### Running the Linux server under WSL2

If you want the exact Linux runtime, run the daemon inside WSL2 instead of the native-Windows server. Verified on Ubuntu:

```bash
# Inside WSL2 (Ubuntu) — clone NATIVELY (not under /mnt/c; see the note below)
git clone https://github.com/blamechris/chroxy && cd chroxy
npm install                       # a native Linux install — node-pty needs its Linux prebuild
npx chroxy start --host 0.0.0.0   # 0.0.0.0 is required to reach it from Windows
```

- **Reaching it from Windows:** WSL2's localhost-forwarding only forwards to a **`0.0.0.0`-bound** server, so `http://localhost:8765` works from a Windows browser. A `--host 127.0.0.1` bind is **not** forwarded and silently isolates the daemon inside WSL — use `--host 0.0.0.0` (chroxy's default) here.
- **Phone / remote access:** WSL2 sits behind NAT, so run the Cloudflare tunnel **inside** WSL2 (its outbound connection traverses the NAT cleanly): install `cloudflared` in the distro, then plain `npx chroxy start`. Exposing a WSL2 port inbound instead would need a Windows-side `netsh interface portproxy` rule.
- **Clone natively, not from `/mnt/c`:** a Windows checkout mounted at `/mnt/c` carries two hazards — node-pty's Windows prebuilds don't load under Linux (hence the native `npm install`), and `.sh` scripts a Windows checkout wrote with `core.autocrlf` have CRLF endings that break `./script.sh` (`bash script.sh` tolerates it). The repo stores every script LF (`.gitattributes`), so a native WSL clone is clean.

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
