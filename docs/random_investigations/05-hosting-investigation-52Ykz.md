# Chroxy Hosting & Competitive Landscape Investigation

*Date: 2026-02-12*

## Executive Summary

This report investigates always-on hosting options for Chroxy, analyzes the competitive landscape of 15+ mobile/remote Claude Code clients, and identifies differentiation strategies. The key finding: **Chroxy's dual chat+terminal view, Cloudflare tunnel integration, and native mobile app give it a unique position in a fragmented market -- but the window is narrowing as Anthropic ships its own mobile Claude Code experience.**

**Recommended hosting path:** Hetzner CX22 (~$6/mo) or Contabo VPS 10 (~$5/mo) with Cloudflare Named Tunnel for a stable always-on deployment.

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Competitive Landscape](#2-competitive-landscape)
3. [Hosting Options](#3-hosting-options)
4. [Differentiation Strategy](#4-differentiation-strategy)
5. [Recommendations](#5-recommendations)

---

## 1. Current Architecture Analysis

### What Chroxy Needs to Run

| Dependency | Required | Notes |
|-----------|----------|-------|
| Node.js 22 | Yes | node-pty breaks on Node 25 |
| Claude CLI (`claude`) | Yes | Must be installed, authenticated, in PATH |
| `cloudflared` | Yes (for remote) | Quick or Named tunnel |
| tmux | Only PTY mode | Default CLI headless mode doesn't need it |
| Git | Optional | Used by supervisor for rollback |

### Resource Profile

| Resource | Idle | Active Session | Multiple Sessions |
|----------|------|----------------|-------------------|
| RAM | ~80MB (server) | ~400-600MB (server + claude CLI) | +200-500MB per session |
| CPU | <1% | Spikes during streaming | Additive per session |
| Disk | <50MB (app) | Claude's cache varies | Grows with conversation history |
| Network | Heartbeat only | Streaming WebSocket | Proportional to activity |

**Critical issue:** Claude CLI has known memory leaks (can grow from ~300MB to 12GB+ over extended sessions). The Chroxy supervisor already handles auto-restart, but VPS RAM sizing must account for this.

### What Changes for Always-On VPS Hosting

**Must do:**
- Use Named Tunnels (stable URL across restarts) instead of Quick Tunnels (random URL)
- Pre-configure Cloudflare credentials on the VPS
- Add swap space (2-4GB) as buffer for Claude CLI memory spikes
- Disable mDNS/Bonjour discovery (not useful over internet)
- Use supervisor mode for auto-restart

**Nice to have:**
- Make `~/.chroxy/` config path configurable via env var
- Health check endpoint for external monitoring
- Structured JSON logging for log aggregation
- Docker image with Claude CLI pre-installed

---

## 2. Competitive Landscape

### The Full Market Map

There are at least 15 tools competing in the "Claude Code from your phone" space. Here's every significant player:

### Tier 1: First-Party Solutions

#### Anthropic Claude Code (iOS + Web)
- **What:** Anthropic's own mobile preview within the Claude iOS app + web sessions at claude.ai/code
- **How:** Cloud-hosted sandboxes run Claude Code on Anthropic's infrastructure. Use `&` prefix in CLI to send tasks to web sessions. Sessions persist when laptop sleeps.
- **Pricing:** Requires Pro ($20/mo) or Max plan
- **Strengths:** Official solution, cloud compute (no local machine needed), parallel web sessions, most reliable long-term
- **Weaknesses:** iOS only (no Android yet), early/limited mobile experience, no terminal view, requires paid plan
- **Threat level to Chroxy: HIGH** -- this is the existential risk

#### GitHub Copilot Mobile
- **What:** AI coding assistant integrated into GitHub Mobile (iOS + Android)
- **How:** Assign issues to Copilot, get PRs back. Chat about code, navigate repos.
- **Pricing:** Free tier (50 chat messages/mo), Pro from $10/mo
- **Strengths:** Most polished native mobile experience, free tier, deep GitHub integration, new Copilot SDK for embedding
- **Weaknesses:** Not Claude Code, different model/capabilities

#### Cursor Web
- **What:** Web app for managing background coding agents via any browser
- **Pricing:** Pro $20/mo+
- **Strengths:** PWA for mobile-like experience, background agent dispatch
- **Weaknesses:** Not a full IDE on mobile, no native app, management interface only

#### OpenAI Codex CLI
- **What:** Remote-capable coding agent with JSON-RPC client-server architecture
- **Strengths:** `codex cloud` for dispatching to isolated environments, device-code auth for mobile/headless
- **Weaknesses:** No dedicated mobile app, requires terminal access

### Tier 2: Direct Competitors (Third-Party Claude Code Clients)

#### Happy Coder (Slopus/Bulka LLC) -- STRONGEST COMPETITOR
- **What:** Free, open-source mobile client for Claude Code + Codex
- **Platforms:** iOS, Android, Web
- **Architecture:** CLI wrapper (`npm i -g happy-coder`) + cloud relay + mobile app
- **Key differentiators vs Chroxy:**
  - End-to-end encryption (TweetNaCl/NaCl, same primitives as Signal)
  - Zero-knowledge relay (server can't read messages)
  - Voice commands (ElevenLabs, not just transcription)
  - Codex support alongside Claude Code
  - ~8-10k GitHub stars, larger community
- **Weaknesses vs Chroxy:**
  - No terminal view (chat only)
  - Relay dependency (public relay has had availability issues)
  - Reliability complaints ("rarely works reliably" per HN commenter)
  - Permission prompt bugs reported on macOS
  - Possible abandonment concerns (went through rough patch)
- **Pricing:** Free (MIT license). $19.99/mo voluntary donation available.

#### CCC - Code Chat Connect (Naarang)
- **What:** Mobile IDE companion for Claude Code
- **Platforms:** iOS, Android
- **Architecture:** Self-hosted CLI (`@naarang/ccc` on npm) + mobile app, ngrok for remote access
- **Key features:** Parallel agents, checkpoints/rewind, file browser with syntax highlighting
- **Weaknesses:** Requires Bun runtime (not Node.js), small user base, ngrok dependency
- **Pricing:** Free

#### CCC - Claude Code Companion (kidandcat)
- **What:** Open-source tool for controlling Claude Code via Telegram
- **Architecture:** Go service + Telegram bot + tmux sessions
- **Key features:** Voice messages (Whisper transcription), image analysis, multi-session via Telegram topics
- **Weaknesses:** Telegram-dependent, uses `--dangerously-skip-permissions`, requires Go 1.21+
- **Pricing:** Free (open source)

#### CloudCLI / Claude Code UI (Siteboon)
- **What:** Free, open-source web UI for Claude Code, Cursor CLI, and Codex
- **Platforms:** Web (responsive PWA)
- **Key features:** Chat + terminal + file explorer + git, multi-agent support, MCP server support, self-host or cloud
- **Weaknesses:** Web-only (no native app)
- **Pricing:** Free (open source)

#### Vibe Companion (The Vibe Company)
- **What:** Open-source web UI using reverse-engineered Claude Code WebSocket protocol
- **Key features:** Multi-session side-by-side, token-by-token streaming, cost tracking, git worktree support
- **Weaknesses:** Reverse-engineered protocol could break, web-only
- **Pricing:** Free (open source)

#### CodeRemote
- **What:** Commercial CLI tool creating a web interface via Tailscale
- **Key features:** Fully self-hosted, no external servers, works on any browser
- **Pricing:** $49/month

#### Remote Code (Vanna.ai)
- **What:** iPhone app for Claude Code + OpenCode
- **Platforms:** iOS only
- **Pricing:** Unknown

#### Mobile IDE for Claude Code
- **What:** Apple ecosystem companion app (macOS menu bar agent + iOS)
- **Architecture:** CloudKit sync between iOS and macOS
- **Weaknesses:** Apple-only, macOS 14+/iOS 17+, slow response times reported
- **Pricing:** 1 free prompt/day, premium subscription for unlimited

#### Superconductor
- **What:** Platform for running multiple AI coding agents with mobile support
- **Key features:** Multi-agent orchestration (Claude, Codex, Amp, Gemini), live browser previews, team collaboration
- **Pricing:** Unknown (likely commercial)

### Tier 3: DIY / Infrastructure Approaches

#### SSH + tmux + Tailscale ("Harper Reed Method")
- Run Claude Code in tmux on a VPS, SSH from mobile terminal apps (Blink, Termius, Moshi)
- Free beyond VPS costs, full terminal, works with any agent
- No chat UI, raw terminal on phone

#### Moshi (iOS Terminal)
- Purpose-built iOS terminal app for AI coding agents
- Native Mosh connections (resilient UDP), push notifications, voice-to-terminal
- Good for SSH approach but no chat-like UI

#### Claude-Code-Remote (JessyTsui)
- Open-source multi-channel: email, Discord, Telegram
- Smart notifications, interactive Telegram buttons

#### Obsidian Claude Anywhere
- Obsidian plugin streaming Claude Code to mobile via Tailscale

### Competitive Comparison Matrix

| Tool | Native App | Terminal View | Chat View | E2E Encryption | Self-Hosted | Multi-Agent | Price |
|------|-----------|--------------|-----------|----------------|-------------|-------------|-------|
| **Chroxy** | iOS + Android | Yes (xterm.js) | Yes | No (tunnel-secured) | Yes | No | Free/OSS |
| **Anthropic (official)** | iOS only | No | Partial | N/A (cloud) | No | No | Pro+ plan |
| **Happy Coder** | iOS + Android + Web | No | Yes | Yes (NaCl) | Relay (self-hostable) | Claude + Codex | Free/OSS |
| **CCC (Naarang)** | iOS + Android | Yes | Yes | No | Yes | Parallel agents | Free |
| **CloudCLI** | Web (PWA) | Yes | Yes | No | Yes or cloud | Claude + Cursor + Codex | Free/OSS |
| **CodeRemote** | Web | No | Yes | Self-hosted | Yes | No | $49/mo |
| **Superconductor** | iOS | Preview | Yes | N/A (cloud) | No | Multi-vendor | Commercial |
| **Copilot Mobile** | iOS + Android | No | Yes | N/A | No | No | Free tier |

---

## 3. Hosting Options

### Tier 1: Budget VPS (Recommended)

These are traditional Linux VPS providers where you get full root access. Best fit for Chroxy's daemon + subprocess architecture.

#### Hetzner Cloud -- BEST VALUE
| Plan | Specs | Price |
|------|-------|-------|
| **CX22** | 2 vCPU, 4GB RAM, 40GB NVMe | ~$6/mo |
| CAX21 (ARM) | 4 vCPU, 8GB RAM, 80GB NVMe | ~$7/mo |
| CX32 | 4 vCPU, 8GB RAM, 80GB NVMe | ~$8.50/mo |

- US locations: Ashburn VA, Hillsboro OR
- 20TB traffic included
- Hourly billing with monthly cap
- EUR 20 signup credit
- **Verdict: Top pick.** CX22 at ~$6/mo is the sweet spot for single-user Chroxy.

#### Contabo -- MOST RAM PER DOLLAR
| Plan | Specs | Price |
|------|-------|-------|
| **VPS 10** | 3 vCPU, 8GB RAM, 75GB NVMe | ~$5/mo |
| VPS 20 | 6 vCPU, 12GB RAM, 100GB NVMe | ~$8/mo |

- 8GB RAM at $5/mo is unmatched
- 32TB outbound included
- **Caveat:** Inconsistent performance due to possible overselling
- **Verdict: Best for RAM-hungry workloads** (Claude CLI memory leaks). Accept occasional performance dips.

#### Other Budget Options
| Provider | Min Viable Plan | Price | Notes |
|----------|----------------|-------|-------|
| Vultr | 2GB RAM, 1 vCPU | $10/mo | Good API, 30+ locations |
| DigitalOcean | 2GB RAM, 2 vCPU | $12/mo | Best docs/UX, $200 trial credit |
| Linode (Akamai) | 2GB RAM, 1 vCPU | $10/mo | Solid, 25+ locations |
| RackNerd | 2GB RAM, 1 vCPU | ~$2/mo (promo) | Cheap annual deals, basic support |
| BuyVM | 2GB RAM, 1 vCPU | $3.50/mo | No overselling, often out of stock |

### Tier 2: Cloud Providers

Better for organizations, but overpriced for this use case after free tiers expire.

| Provider | Min Viable Plan | Price | Free Tier |
|----------|----------------|-------|-----------|
| **GCP e2-micro** | 0.25 vCPU, 1GB RAM | **Free forever** | Always-free tier |
| AWS Lightsail | 1 vCPU, 2GB RAM | $12/mo | 3 months free |
| AWS EC2 t3.micro | 2 vCPU, 1GB RAM | ~$8/mo | 12 months free |
| Azure B1s | 1 vCPU, 1GB RAM | ~$8/mo | 12 months free |
| GCP e2-small | 0.5 vCPU, 2GB RAM | ~$12/mo | $300 credit (90 days) |

- **GCP e2-micro (free)** is useful for testing but 1GB RAM is borderline
- Hyperscaler VMs cost 3-5x more than budget VPS after free tier

### Tier 3: PaaS / Container Platforms

Managed platforms with less control but simpler deployment.

| Provider | Min Viable Config | Price | Fit |
|----------|------------------|-------|-----|
| **Fly.io** | shared-cpu-1x, 2GB RAM | ~$10/mo | Good WebSocket support, auto-stop |
| Railway | Usage-based (Hobby) | $5/mo + usage | Quick deploy, may exceed $5 |
| Render | Background Worker, 512MB | $7/mo | 512MB too small |
| **Coolify** (self-hosted PaaS) | Your own VPS | Free + VPS cost | Heroku-like DX on Hetzner |

- **Fly.io** is the best PaaS option if you want managed infrastructure
- **Coolify on Hetzner** gives PaaS convenience at VPS prices

### NOT Viable

These platforms **cannot** run Chroxy due to architectural limitations:

| Platform | Why Not |
|----------|---------|
| Cloudflare Workers | No child process spawning, no Node.js runtime, CPU time limits |
| Deno Deploy | No persistent processes, no subprocess spawning, 50ms CPU limit |
| GCP Cloud Run | 60-min WebSocket timeout, not designed for persistent daemons |
| AWS ECS Fargate | Subprocess spawning in containers is awkward, expensive for always-on |
| Kubernetes | Massive overkill for a single daemon |

### Cost Comparison Summary

| Solution | Monthly Cost | RAM | Best For |
|----------|-------------|-----|----------|
| GCP e2-micro | **$0** | 1GB | Testing/dev only |
| Contabo VPS 10 | **$5** | 8GB | Max RAM, budget production |
| Hetzner CX22 | **$6** | 4GB | Best overall value |
| Vultr/DO/Linode | $10-12 | 2GB | Premium VPS with better DX |
| Fly.io | ~$10 | 2GB | Managed container platform |
| AWS Lightsail | $12 | 2GB | AWS ecosystem integration |

---

## 4. Differentiation Strategy

### Where Chroxy Already Wins

1. **Dual chat + terminal view** -- Only Chroxy and CCC (Naarang) offer both in a native mobile app. Happy Coder has no terminal view. CloudCLI has both but is web-only.

2. **Cloudflare tunnel integration** -- More robust than ngrok (CCC), cheaper than Tailscale setups (CodeRemote at $49/mo), and already built-in. No third-party relay dependency (unlike Happy).

3. **Native React Native app** -- True native mobile experience on both iOS and Android. Happy Coder also has this, but most competitors are web-only (CloudCLI, Vibe Companion, Cursor).

4. **Deep Claude Code integration** -- Stream-JSON protocol parsing, plan mode detection, permission handling, session management, model switching. Most competitors wrap the CLI more opaquely.

5. **Self-contained** -- No relay server, no Telegram bot, no cloud platform. Just your machine + Cloudflare tunnel + the app.

### Gaps to Address for Competitive Edge

#### High Impact

1. **End-to-end encryption** -- Happy Coder's #1 selling point. Chroxy currently relies on transport-layer security via Cloudflare tunnel. Adding E2E encryption (NaCl/libsodium) would neutralize Happy's key differentiator.

2. **Always-on cloud hosting option** -- The core of this investigation. Offering a one-command VPS deployment (Docker image or install script) would set Chroxy apart from competitors that assume a local dev machine.

3. **Codex/multi-agent support** -- Happy and CloudCLI support Codex alongside Claude Code. If Chroxy could run OpenAI Codex or other agents, it widens the addressable market.

#### Medium Impact

4. **Voice interaction** -- Happy has voice commands via ElevenLabs. Expo supports speech-to-text natively. Adding voice-to-text input would be a meaningful mobile UX improvement.

5. **PWA/Web companion** -- A lightweight web view alongside the native app (like Happy's web version) would expand access to tablets and desktops without a separate install.

6. **Push notification improvements** -- Already implemented, but ensuring reliability for permission requests and task completion is critical for the mobile-first workflow.

#### Lower Priority

7. **Checkpoints/rewind** -- CCC's unique feature. Could be valuable but complex to implement.

8. **Team/multi-user features** -- Superconductor's angle. Probably premature for v0.1.

### The "Always-On" Angle as Differentiator

Most competitors assume you run Claude Code on your personal dev machine. Chroxy's architecture is uniquely suited for always-on VPS hosting:

- **Supervisor mode** already handles auto-restart with backoff
- **Named Tunnel** support gives stable URLs across restarts
- **Session management** supports multiple concurrent sessions
- **The daemon model** (long-running server process) maps cleanly to a VPS

If Chroxy ships a Docker image or one-liner install script for VPS deployment, it becomes the first tool that offers **"Claude Code as a service on your own infrastructure"** -- not just "access your laptop from your phone."

This positions Chroxy differently from every competitor:
- **Happy/CCC/CloudCLI:** Require your dev machine to be on
- **Anthropic's cloud:** Runs on their infrastructure (you don't control it)
- **Chroxy on VPS:** Runs on YOUR cloud server, always available, you control everything

---

## 5. Recommendations

### Phase 1: Quick Win -- VPS Hosting Support

**Goal:** Let users deploy Chroxy to a VPS with one command.

1. **Create a Docker image** with Node.js 22 + `cloudflared` pre-installed
   - Users bring their own Claude CLI credentials (mount or env var)
   - `docker-compose.yml` with Chroxy server + cloudflared sidecar

2. **Add a VPS install script** (`scripts/install-vps.sh`)
   - Installs Node.js 22, cloudflared, Chroxy
   - Sets up systemd service for auto-start on boot
   - Configures Named Tunnel with user's Cloudflare credentials
   - Adds swap space and memory limits

3. **Document the setup** for Hetzner CX22 (~$6/mo) as the reference deployment

### Phase 2: Competitive Parity

4. **Add E2E encryption** -- Implement NaCl-based encryption between app and server. QR code pairing exchanges the shared key. This neutralizes Happy Coder's main advantage.

5. **Ship to App Store / Play Store** -- A published app listing dramatically increases discoverability.

### Phase 3: Differentiation

6. **"Chroxy Cloud" offering** -- A managed hosting tier where users don't need their own VPS. You run Hetzner/Contabo instances and charge $10-15/mo per user (covers hosting + margin). Each user gets their own isolated container with Chroxy + Claude CLI.

7. **Multi-agent support** -- Add Codex CLI support alongside Claude Code. The architecture already supports swapping the underlying CLI process.

8. **Voice input** -- Use Expo's speech-to-text for basic voice-to-text input on mobile.

### Hosting Decision Matrix

| Scenario | Recommended | Monthly Cost |
|----------|------------|-------------|
| Personal use (testing) | GCP e2-micro (free) | $0 |
| Personal use (production) | Hetzner CX22 | ~$6 |
| Personal use (heavy) | Contabo VPS 10 | ~$5 |
| Managed PaaS preference | Fly.io | ~$10 |
| Multi-user hosting (4-6 users) | Hetzner CX42 | ~$22 |
| "Chroxy Cloud" (per user) | Contabo VPS 10 per user | ~$5/user |

### Bottom Line

The market for mobile Claude Code access is real (15+ competitors) but fragmented (no winner yet). Chroxy has genuine architectural advantages (dual view, native app, Cloudflare tunnels, self-contained) but faces two headwinds: Happy Coder's E2E encryption and community size, and Anthropic's own mobile push.

The always-on VPS hosting angle is Chroxy's best path to differentiation -- nobody else is offering "Claude Code as a service on your own infrastructure" with a polished mobile interface. Ship Docker + install script, add E2E encryption, and get on the app stores. Total hosting cost: ~$6/month.
