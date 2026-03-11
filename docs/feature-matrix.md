# Chroxy Feature Matrix

Cross-platform feature availability for Mobile App, Desktop Dashboard, and Server.

**Legend:** Y = available, — = not available

## Connection & Auth

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| QR Code Scanning | Y | Y (tray) | Y (endpoint) |
| Manual URL Entry | Y | Y | Y |
| Token Authentication | Y | Y | Y |
| LAN/mDNS Discovery | Y | — | Y |
| Keychain/Secure Storage | Y | Y (localStorage) | Y (config.json) |
| Biometric Lock | Y | — | — |
| Auto-reconnect | Y | Y | Y |
| Saved Connection | Y | Y | Y |

## Chat & Messaging

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Chat View | Y | Y | Y |
| Markdown Rendering | Y | Y | — |
| Syntax Highlighting | Y (50+ langs) | Y (15 langs) | — |
| Message Streaming | Y | Y | Y |
| Plan Mode Approval | Y | Y | Y |
| Agent Monitoring | Y | Y | Y |
| Activity Groups | Y | Y | Y |
| Conversation Search | Y | Y | Y |
| Search Highlighting | Y | Y | — |

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
| Voice-to-Text Input | Y | — | — |
| Speech Language Selection | Y | — | — |
| Recording Indicator | Y | — | — |

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

## Settings

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Theme/Appearance | Y | Y | — |
| Keyboard Shortcuts | — | Y | — |
| Biometric Lock Toggle | Y | — | — |
| Auto-update | — | Y | — |
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
| Graceful Shutdown | Y | Y | Y |

## Onboarding

| Feature | Mobile | Desktop | Server |
|---------|--------|---------|--------|
| Setup Wizard | Y | Y | Y |
| Dependency Check | — | Y | Y |
