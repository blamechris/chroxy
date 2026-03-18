# Chroxy Feature Matrix

Cross-platform feature availability for Mobile App, Desktop Dashboard, and Server.

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
