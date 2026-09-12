# Chroxy Feature Matrix

Cross-platform feature availability for Mobile App, Desktop Dashboard, and Server.
For per-provider feature support (Claude Agent SDK, legacy `claude -p`, Gemini, Codex) see the [Providers](#providers) section below or [docs/providers.md](providers.md).

**Legend:** Y = available, — = not available

**Column definitions:**
- **Mobile** — React Native/Expo app (iOS & Android)
- **Desktop** — Tauri tray app with web dashboard
- **Server** — Node.js daemon. "Y" means the server either implements the feature natively (e.g., supervisor, headless CLI) or exposes a WS/HTTP endpoint that clients consume (e.g., session management, push notifications)

## Connection & Auth

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| QR Code Scanning (camera) | Y | — | — |
| QR Code Generation/Display | — | Y (tray) | Y (endpoint) |
| Manual URL Entry | Y | Y | Y |
| Token Authentication | Y | Y | Y |
| LAN Scan Discovery | Y | — | — |
| mDNS/Bonjour Advertisement | — | — | Y |
| Token Persistence | Y (OS keychain) | Y (localStorage) | Y (config.json) |
| Biometric Lock | Y | — | — |
| Auto-reconnect | Y | Y | Y |
| Saved Connection | Y | Y | Y |

## Chat & Messaging

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Chat View | Y | Y | Y |
| Markdown Rendering | Y | Y | — |
| Syntax Highlighting | Y (15 langs) | Y (15 langs) | — |
| Message Streaming | Y | Y | Y |
| Plan Mode Approval | Y | Y | Y |
| Agent Monitoring | Y | Y | Y |
| Activity Groups | Y | Y | Y |
| Conversation Search | Y | Y | Y |
| Search Highlighting | Y | — | — |

## Terminal

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Terminal Emulation (xterm.js) | Y (WebView) | Y (direct DOM) | — |
| ANSI Rendering | Y | Y | — |
| Dual View (Chat + Terminal) | Y | Y (split pane) | — |
| Write Batching | Y (50ms) | Y (50ms) | — |

## File Operations

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| File Browser | Y | Y | Y |
| File Editor | Y | — | Y |
| File Viewer | Y | Y | Y |
| Directory Navigation | Y | Y | Y |
| Git Diff Display | Y | Y | Y |
| Image Preview | Y | Y | Y |
| Attachment Support | Y | Y | Y |

## Session Management

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Session Tabs | Y | Y | Y |
| Session Creation | Y | Y | Y |
| Model Switching | Y | Y | Y |
| Permission Handling | Y | Y | Y |
| Session Renaming | Y | Y | Y |
| Session Timeout Banner | Y | Y | Y |

## Notifications

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Push Notifications | Y | — | Y |
| Desktop Notifications | — | Y | Y |
| Permission Alerts | Y | Y | Y |
| Idle Alerts | Y | Y | Y |

## Voice

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Voice-to-Text Input | Y | Y (macOS) | — |
| Speech Language Selection | Y | — | — |
| Recording Indicator | Y | Y | — |

## Slash Commands

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Command Autocomplete | Y | Y | Y |
| Command Palette (Cmd+K) | — | Y | — |
| MRU Tracking | — | Y | — |

## Cost & Budget

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Cost Display | Y | Y | Y |
| Budget Tracking | Y | Y | Y |
| Cost Breakdown | Y | Y | Y |

## Container Environments

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Persistent Environments | — | Y (panel) | Y |
| Docker Compose Stacks | — | Y (panel) | Y |
| DevContainer Support | — | Y (panel) | Y |
| Environment Snapshots | — | Y (panel) | Y |
| Snapshot Restore | — | Y (panel) | Y |
| Docker Session Isolation | — | Y (creation) | Y |
| Git Worktree Isolation | Y (creation) | Y (creation) | Y |
| Sandbox Mode (SDK) | — | — | Y |
| Permission Rules | Y | — | Y |

## Settings

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Theme/Appearance | Y | Y | — |
| Keyboard Shortcuts | — | Y | — |
| Biometric Lock Toggle | Y | — | — |
| Version Display | Y | Y | Y |

## System

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Auto-Update | — | Y | — |
| Tray Icon | — | Y | — |
| Auto-Start at Login | — | Y | — |
| Tunnel Management | — | Y (tray) | Y |
| Supervisor (auto-restart) | — | — | Y |
| Headless CLI Mode | — | — | Y |
| Health Check | Y | Y | Y |
| Graceful Shutdown | — | Y | Y |

## Onboarding

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Setup Wizard | Y | Y | Y |
| Dependency Check | — | Y | Y |

## Providers

Per-provider feature support. Capability-contract rows (Permission handling, Live model switching, Permission mode switching, Plan mode, Conversation resume, Reasoning / thinking level) reflect each session class's `static get capabilities()` in `packages/server/src/`. The remaining rows (Attachments, Backing binary / SDK, Required env) are provider notes documented here rather than fields on the capabilities contract. See [docs/providers.md](providers.md) for setup instructions, env vars, and model lists.

> **The `codex` column describes the DEFAULT driver** — `CodexAppServerSession` (`codex-app-server-session.js`), which `getProvider('codex')` returns unless `CHROXY_CODEX_APPSERVER=0` opts out (#6616). The legacy `codex exec` driver (`codex-session.js`) is a separate capability object and differs on four of these rows; see the note under the table.

> The zero-config default provider is `claude-tui` (see #5819), chosen to keep out-of-the-box setups off the metered programmatic-credit pool at the 2026-06-15 cutover. The columns below cover the feature-richer providers; see [docs/providers.md](providers.md#claude-tui) for `claude-tui`'s capabilities and trade-offs.

| Capability | `claude-sdk` | `claude-cli` | `gemini` | `codex` (app-server, default) |
|------------|------------------------|--------------|----------|---------|
| Permission handling | Y (in-process) | Y (HTTP hook) | — | Y (in-process) |
| Live model switching | Y | Y | Y | Y |
| Permission mode switching | Y | Y | — | Y |
| Plan mode | — | Y | — | — |
| Conversation resume | Y | Y | — | — |
| Reasoning / thinking level | Y | — | — | Y (per-model levels) |
| Attachments | Y | Y | — (error on use) | Y (images → vision, other files by reference) |
| Backing binary / SDK | `@anthropic-ai/claude-agent-sdk` | `claude -p` | `gemini -p` | `codex app-server` |
| Required env | Claude Code login / `ANTHROPIC_API_KEY` | Claude Code login | `GEMINI_API_KEY` | `OPENAI_API_KEY` or a `codex login` session |

Two cells above are worth reading twice, because they were stale here while [docs/providers.md](providers.md) had them right:

- **`claude-cli` conversation resume is `Y`.** `cli-session.js` declares `resume: true` (#4887): the upstream session id is wired into the spawn argv on respawn / restore, so the transcript survives instead of starting cold mid-conversation.
- **The `codex` column is the app-server driver.** Against the legacy `codex exec` driver (`CHROXY_CODEX_APPSERVER=0`) four of these rows flip: Permission handling → **—** (codex runs whatever its own sandbox allows, with no Chroxy approval surface), Permission mode switching → **—**, Reasoning / thinking level → **—**, Attachments → **— (error on use)**, and the backing binary is `codex exec`. Conversation *memory within a session* is **not** one of the differences — both drivers keep it (the exec path resumes its own thread on every turn, #3865).

Neither codex driver supports plan mode, and neither resumes a conversation across a daemon restart.

Docker variants (`docker-sdk`, `docker-cli`) inherit capabilities from their base Claude provider and additionally run the session inside an isolated container — see the Container Environments section above.
