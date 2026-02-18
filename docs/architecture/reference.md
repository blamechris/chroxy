# Chroxy Architecture Reference

Detailed component tables, protocol messages, and file reference for the Chroxy project.
For essential dev workflow, see [CLAUDE.md](/CLAUDE.md).

## Server Components

| Component | File | Purpose |
|-----------|------|---------|
| CLI | `src/cli.js` | `init`, `start`, `config`, `tunnel setup` commands |
| Config | `src/config.js` | Schema validation + merge (CLI > ENV > file > defaults) |
| Supervisor | `src/supervisor.js` | Tunnel owner + child auto-restart (named tunnel mode) |
| ServerCLI | `src/server-cli.js` | CLI mode orchestrator |
| CliSession | `src/cli-session.js` | Claude Code headless executor (stream-json) |
| SdkSession | `src/sdk-session.js` | Claude Agent SDK executor |
| Server | `src/server.js` | PTY mode orchestrator |
| WsServer | `src/ws-server.js` | WebSocket protocol with auth |
| PushManager | `src/push.js` | Push notifications via Expo Push API (CLI mode) |
| PtyManager | `src/pty-manager.js` | tmux session management (PTY mode) |
| OutputParser | `src/output-parser.js` | Terminal output parser (PTY mode) |
| NoisePatterns | `src/noise-patterns.js` | Terminal noise filter patterns (PTY mode) |
| TunnelManager | `src/tunnel.js` | Cloudflare tunnel lifecycle (quick/named/none) |
| TunnelEvents | `src/tunnel-events.js` | Tunnel event wiring helpers |
| ProviderRegistry | `src/providers.js` | Provider adapter interface + built-in registrations |
| SessionManager | `src/session-manager.js` | Session lifecycle management + auto-discovery |
| SessionDiscovery | `src/session-discovery.js` | tmux session discovery utilities |
| Models | `src/models.js` | Model switching utilities |
| ContentBlocks | `src/content-blocks.js` | Content block builder for structured output |
| PermissionHook | `src/permission-hook.js` | Permission hook management (CLI mode) |
| Platform | `src/platform.js` | Cross-platform utilities (Windows/macOS/Linux) |
| Logger | `src/logger.js` | Shared logging utility |

## App Screens

| Screen | Purpose |
|--------|---------|
| ConnectScreen | QR scan or manual URL/token entry |
| SessionScreen | Dual-view: chat mode + terminal mode |
| SettingsScreen | App version, server URL, tap-to-copy |

## App Components

| Component | File | Purpose |
|-----------|------|---------|
| ChatView | `src/components/ChatView.tsx` | Message list, tool bubbles, plan approval card |
| TerminalView | `src/components/TerminalView.tsx` | xterm.js terminal emulator (WebView), resize forwarding, crash recovery |
| InputBar | `src/components/InputBar.tsx` | Text input with send/interrupt + mic button |
| SettingsBar | `src/components/SettingsBar.tsx` | Collapsible bar: model/permission/cost/agents |
| SessionPicker | `src/components/SessionPicker.tsx` | Horizontal session tab strip |
| MarkdownRenderer | `src/components/MarkdownRenderer.tsx` | Markdown parsing + inline code highlighting |
| CreateSessionModal | `src/components/CreateSessionModal.tsx` | New session creation dialog |

## State Management (Zustand)

Key state: `connectionPhase` (ConnectionPhase enum), `wsUrl`, `apiToken`, `viewMode`, `messages[]`, `terminalBuffer`

`ConnectionPhase`: `disconnected` → `connecting` → `connected` / `reconnecting` / `server_restarting`
`selectShowSession`: stays on SessionScreen during transient disconnects (reconnecting/server_restarting)

## Data Flow

**CLI Headless Mode:**
```
[Mobile App] ←WebSocket→ [Cloudflare] ←→ [WsServer]
                                            ↕
                                      [CliSession]
                                            ↕
                              [claude -p --output-format stream-json]
                                            ↕
                                    [Streaming JSON Events]
```

**PTY/tmux Mode:**
```
[Mobile App] ←WebSocket→ [Cloudflare] ←→ [WsServer]
                                            ↕
                                  [PtyManager] → [OutputParser]
                                       ↕              ↕
                                  [tmux/Claude]   [Parsed Messages]
```

## WebSocket Protocol

### Client → Server

`auth`, `input`, `resize`, `mode`, `interrupt`, `set_model`, `set_permission_mode`, `permission_response`, `list_sessions`, `switch_session`, `create_session`, `destroy_session`, `rename_session`, `discover_sessions`, `attach_session`, `trigger_discovery`, `register_push_token`, `user_question_response`, `list_directory`, `key_exchange`

### Server → Client

`auth_ok`, `auth_fail`, `server_mode`, `stream_start`, `stream_delta`, `stream_end`, `raw`, `message`, `status`, `model_changed`, `status_update`, `available_models`, `permission_request`, `confirm_permission_mode`, `permission_mode_changed`, `available_permission_modes`, `session_list`, `session_switched`, `session_created`, `session_destroyed`, `session_error`, `discovered_sessions`, `discovery_triggered`, `history_replay_start`, `history_replay_end`, `raw_background`, `claude_ready`, `tool_start`, `result`, `agent_busy`, `agent_idle`, `agent_spawned`, `agent_completed`, `server_shutdown`, `server_status`, `server_error`, `user_question`, `plan_started`, `plan_ready`, `client_joined`, `client_left`, `primary_changed`, `directory_listing`, `key_exchange`

### Protocol Details

- `list_directory` requests a directory listing; `directory_listing` returns sorted non-hidden subdirectories (or error)
- `server_shutdown` sent before server goes down; `reason` is `'restart'` (coming back) or `'shutdown'` (not coming back); `restartEtaMs` is estimated ms until server is available (0 for permanent shutdown); supervisor standby health check also includes `restartEtaMs` for crash recovery
- `server_status` for non-error updates; `server_error` for error conditions
- `discovered_sessions` sent proactively when auto-discovery finds new tmux sessions (configurable via `--discovery-interval`, default 45s)
- `trigger_discovery` requests an immediate discovery scan
- `permission_request` includes an `input` field (always present, defaults to `{}`) with structured tool input for rich UI rendering; `remainingMs` (milliseconds until auto-deny) lets the client compute a local deadline without clock skew
- `user_question` forwards `AskUserQuestion` prompts from plan mode; `user_question_response` sends the user's answer back
- `agent_spawned` fires when the Task tool is detected (description truncated to 200 chars); `agent_completed` fires per-agent when the turn's `result` arrives or on process crash/destroy
- `plan_started` fires on `EnterPlanMode` tool; `plan_ready` fires on `ExitPlanMode`, includes `allowedPrompts` payload — both are transient events (not recorded in history or replayed)
- `key_exchange` implements ECDH key exchange for end-to-end encryption; after `auth_ok`, client and server exchange public keys, derive a shared secret, and encrypt all subsequent messages; `auth_ok` includes `encryption: true` when server supports encryption; disable with `--no-encrypt`
- `session_list` includes `provider` (provider name) and `capabilities` (feature flags from the provider adapter interface) per session
- `auth` accepts optional `deviceInfo: { deviceId, deviceName, deviceType, platform }` for multi-client awareness
- `auth_ok` includes `clientId` (assigned ID) and `connectedClients` (list of all connected clients)
- `client_joined` broadcasts when a new client authenticates; `client_left` on disconnect
- `primary_changed` broadcasts last-writer-wins primary status per session (fires on `input`)
- `set_permission_mode` accepts optional `confirmed: true` (required for `auto` mode); without it, server responds with `confirm_permission_mode` challenge containing a `warning` string

## Project Files

### Server (`packages/server/src/`)

| File | Purpose |
|------|---------|
| `cli.js` | CLI commands (init, start, config, tunnel setup) |
| `config.js` | Config schema validation + merge precedence |
| `supervisor.js` | Supervisor: tunnel owner + child auto-restart |
| `server-cli-child.js` | Supervised child entry point |
| `server-cli.js` | CLI mode orchestrator |
| `cli-session.js` | Claude Code headless executor (stream-json) |
| `sdk-session.js` | Claude Agent SDK executor |
| `providers.js` | Provider adapter registry + built-in registrations |
| `content-blocks.js` | Content block builder for structured output |
| `permission-hook.js` | Permission hook management (CLI mode) |
| `push.js` | Push notifications via Expo Push API |
| `platform.js` | Cross-platform utilities (Windows/macOS/Linux) |
| `server.js` | PTY mode orchestrator |
| `pty-manager.js` | PTY/tmux management |
| `pty-session.js` | PTY session state + I/O handling |
| `output-parser.js` | Terminal output parser |
| `noise-patterns.js` | Terminal noise filter patterns |
| `ws-server.js` | WebSocket protocol with auth |
| `tunnel.js` | Cloudflare tunnel manager (quick/named/none) |
| `tunnel-check.js` | Tunnel health verification |
| `tunnel-events.js` | Tunnel event wiring helpers |
| `session-manager.js` | Session lifecycle management |
| `session-discovery.js` | Session discovery utilities |
| `models.js` | Model switching utilities |
| `logger.js` | Shared logging utility |

### App (`packages/app/src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | App root with navigation |
| `screens/ConnectScreen.tsx` | QR scan + manual connection UI |
| `screens/SessionScreen.tsx` | Session orchestrator (wires components) |
| `screens/SettingsScreen.tsx` | App settings and version info |
| `components/ChatView.tsx` | Message list, tool bubbles, plan approval card |
| `components/TerminalView.tsx` | xterm.js terminal emulator (WebView), resize forwarding, crash recovery |
| `components/xterm-html.ts` | Inline HTML template for xterm.js WebView |
| `components/InputBar.tsx` | Text input with send/interrupt + mic button |
| `components/SettingsBar.tsx` | Collapsible bar: model/permission/cost/agents |
| `components/SessionPicker.tsx` | Horizontal session tab strip |
| `components/MarkdownRenderer.tsx` | Markdown parsing + inline code highlighting |
| `components/CreateSessionModal.tsx` | New session creation dialog |
| `store/connection.ts` | Zustand state store (ConnectionPhase) |
| `hooks/useSpeechRecognition.ts` | Voice-to-text input hook |
| `notifications.ts` | Push notification registration |
| `constants/colors.ts` | Shared color palette |
| `constants/icons.ts` | Shared icon constants |

### Docs

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Essential dev workflow and conventions |
| `docs/architecture/reference.md` | This file — detailed component/protocol reference |
| `docs/architecture/in-app-dev.md` | In-app iterative development design |
| `docs/qa-log.md` | QA audit log with coverage matrix |
| `docs/smoke-test.md` | Manual smoke test checklist |
| `docs/named-tunnel-guide.md` | Named tunnel setup guide |
| `docs/self-hosting-guide.md` | Self-hosting requirements and deployment |
