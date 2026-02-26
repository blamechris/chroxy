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
| WsServer | `src/ws-server.js` | WebSocket protocol with auth |
| WsMessageHandlers | `src/ws-message-handlers.js` | WS message handler dispatch |
| WsForwarding | `src/ws-forwarding.js` | Session event → WS broadcast wiring |
| WsSchemas | `src/ws-schemas.js` | Zod schemas for WebSocket message validation |
| EventNormalizer | `src/event-normalizer.js` | Normalize SDK/CLI events into unified format |
| PushManager | `src/push.js` | Push notifications via Expo Push API |
| TunnelRegistry | `src/tunnel/registry.js` | Tunnel adapter registry (`registerTunnel`/`getTunnel`/`parseTunnelArg`) |
| BaseTunnelAdapter | `src/tunnel/base.js` | Base class with shared recovery logic (backoff, events) |
| CloudflareTunnelAdapter | `src/tunnel/cloudflare.js` | Cloudflare adapter (quick/named modes) |
| TunnelManager | `src/tunnel.js` | Backward-compat shim re-exporting CloudflareTunnelAdapter |
| TunnelEvents | `src/tunnel-events.js` | Tunnel event wiring helpers |
| ProviderRegistry | `src/providers.js` | Provider adapter interface + built-in registrations |
| SessionManager | `src/session-manager.js` | Session lifecycle management |
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
| ChatView | `src/components/ChatView.tsx` | Message list, tool bubbles, plan approval card (inline component) |
| TerminalView | `src/components/TerminalView.tsx` | xterm.js terminal emulator (WebView), resize forwarding, crash recovery |
| InputBar | `src/components/InputBar.tsx` | Text input with send/interrupt + mic button |
| SettingsBar | `src/components/SettingsBar.tsx` | Collapsible bar: model/permission/cost/agents |
| SessionPicker | `src/components/SessionPicker.tsx` | Horizontal session tab strip |
| MarkdownRenderer | `src/components/MarkdownRenderer.tsx` | Markdown parsing + inline code highlighting |
| CreateSessionModal | `src/components/CreateSessionModal.tsx` | New session creation dialog |
| DiffViewer | `src/components/DiffViewer.tsx` | Git diff modal with file list and line-level changes |
| FileBrowser | `src/components/FileBrowser.tsx` | Project file browser with syntax-highlighted viewer |

## State Management (Zustand)

Key state: `connectionPhase` (ConnectionPhase enum), `wsUrl`, `apiToken`, `viewMode`, `messages[]`, `terminalBuffer`

`ConnectionPhase`: `disconnected` → `connecting` → `connected` / `reconnecting` / `server_restarting`
`selectShowSession`: stays on SessionScreen during transient disconnects (reconnecting/server_restarting)

## Data Flow

```
[Mobile App / Desktop] ←WebSocket→ [Cloudflare] ←→ [WsServer]
                                                       ↕
                                                 [CliSession / SdkSession]
                                                       ↕
                                         [claude -p / Agent SDK]
                                                       ↕
                                               [Streaming JSON Events]
```

## WebSocket Protocol

### Client → Server

| Type | Purpose |
|------|---------|
| `auth` | Authenticate with server token and device info |
| `browse_files` | Request file/directory listing within project |
| `create_session` | Create new session with optional name/cwd |
| `destroy_session` | Delete session by ID |
| `encrypted` | Encrypted message envelope (E2E encryption) |
| `get_diff` | Request git diff for uncommitted changes |
| `input` | Send text or voice message to session |
| `interrupt` | Interrupt active Claude task |
| `key_exchange` | Send client X25519 public key for encryption |
| `list_agents` | Request available custom agent definitions |
| `list_conversations` | Request scan of conversation history files |
| `list_directory` | Request home directory listing for browsing |
| `list_sessions` | Request list of all sessions |
| `list_slash_commands` | Request available slash command definitions |
| `mode` | Switch between terminal and chat view modes |
| `permission_response` | Respond to permission prompt (allow/deny) |
| `ping` | Client heartbeat for connection keep-alive |
| `read_file` | Request file content within project |
| `register_push_token` | Register Expo push token for notifications |
| `rename_session` | Rename existing session by ID |
| `request_full_history` | Request complete JSONL history for session |
| `request_session_context` | Get context info for specific session |
| `resume_conversation` | Resume a past conversation by creating a new session with `resumeSessionId` |
| `set_model` | Change active Claude model |
| `set_permission_mode` | Change permission handling mode |
| `switch_session` | Switch to different active session |
| `user_question_response` | Respond to AskUserQuestion prompt |

### Server → Client

| Type | Purpose |
|------|---------|
| `agent_busy` | Agent started processing in session |
| `agent_completed` | Subagent completed execution |
| `agent_idle` | Agent finished processing in session |
| `agent_list` | Available custom agent definitions list |
| `agent_spawned` | New subagent spawned (transient event) |
| `auth_fail` | Authentication failed (timeout/invalid token) |
| `auth_ok` | Authentication successful with server info |
| `available_models` | List of models server accepts |
| `available_permission_modes` | List of permission modes available |
| `claude_ready` | Claude Code ready for input |
| `client_joined` | New client connected to server |
| `client_left` | Client disconnected from server |
| `confirm_permission_mode` | Challenge auto mode (needs confirmation) |
| `conversation_id` | SDK conversation ID for session portability |
| `conversations_list` | List of conversation metadata (id, project, preview, mtime, size) |
| `diff_result` | Git diff for uncommitted changes |
| `directory_listing` | Home directory listing response |
| `encrypted` | Encrypted message envelope (E2E encryption) |
| `file_content` | File content with syntax metadata |
| `file_listing` | Project file/directory listing response |
| `history_replay_end` | End of session history replay |
| `history_replay_start` | Beginning of session history replay |
| `key_exchange_ok` | Server X25519 public key for encryption |
| `message` | Parsed chat message (user/response/tool_use) |
| `model_changed` | Active model updated by user |
| `permission_expired` | Permission request expired or already handled |
| `permission_mode_changed` | Permission mode changed by user |
| `permission_request` | Permission prompt from hook/SDK |
| `plan_ready` | Plan complete, awaiting user approval |
| `plan_started` | Claude entered plan mode |
| `pong` | Heartbeat response to client ping |
| `primary_changed` | Last-writer-wins primary client changed |
| `result` | Query stats (cost/duration/tokens) |
| `server_error` | Server-side error forwarded to app |
| `server_mode` | Which backend mode active (cli/terminal) |
| `server_shutdown` | Server shutting down (reason/ETA) |
| `server_status` | Non-error status update (e.g., recovery) |
| `session_context` | Context info for specific session |
| `session_created` | New session created |
| `session_destroyed` | Session removed |
| `session_error` | Session operation error |
| `session_list` | All available sessions |
| `session_switched` | Switched to active session |
| `slash_commands` | Available slash command definitions |
| `status` | Connection status (connected: true/false) |
| `stream_delta` | Token-by-token streaming response text |
| `stream_end` | Streaming response complete |
| `stream_start` | Beginning of streaming response |
| `tool_result` | Tool execution result output |
| `tool_start` | Tool invocation started |
| `user_question` | AskUserQuestion prompt from Claude |

### Protocol Details

- `list_directory` requests a directory listing; `directory_listing` returns sorted non-hidden subdirectories (or error)
- `server_shutdown` sent before server goes down; `reason` is `'restart'` (coming back) or `'shutdown'` (not coming back); `restartEtaMs` is estimated ms until server is available (0 for permanent shutdown); supervisor standby health check also includes `restartEtaMs` for crash recovery
- `server_status` for non-error updates; `server_error` for error conditions
- `permission_request` includes an `input` field (always present, defaults to `{}`) with structured tool input for rich UI rendering; `remainingMs` (milliseconds until auto-deny) lets the client compute a local deadline without clock skew
- `list_conversations` triggers a scan of `~/.claude/projects/` JSONL files; `conversations_list` returns `{ conversations: [{ conversationId, project, projectName, modifiedAt, modifiedAtMs, sizeBytes, preview, cwd }] }` sorted by most recently modified
- `resume_conversation` accepts `{ conversationId, cwd?, name? }` where `conversationId` is a UUID and `name` (optional) labels the new session (defaults to `'Resumed'`); creates a new session with `resumeSessionId` and responds with `session_switched`
- `user_question` forwards `AskUserQuestion` prompts from plan mode; `user_question_response` sends the user's answer back
- `agent_spawned` fires when the Task tool is detected (description truncated to 200 chars); `agent_completed` fires per-agent when the turn's `result` arrives or on process crash/destroy
- `plan_started` fires on `EnterPlanMode` tool; `plan_ready` fires on `ExitPlanMode`, includes `allowedPrompts` payload — both are transient events (not recorded in history or replayed)
- `key_exchange` implements ECDH key exchange for end-to-end encryption; after `auth_ok`, client and server exchange public keys, derive a shared secret, and encrypt all subsequent messages; `auth_ok` includes `encryption: 'required'` when encryption is enabled or `encryption: 'disabled'` when turned off; disable with `--no-encrypt`
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
| `ws-server.js` | WebSocket protocol with auth |
| `ws-message-handlers.js` | WS message handler dispatch |
| `ws-forwarding.js` | Session event → WS broadcast wiring |
| `ws-schemas.js` | Zod schemas for WebSocket message validation |
| `diff-parser.js` | Unified diff parser for git output |
| `crypto.js` | ECDH key exchange + AES-GCM encryption |
| `event-normalizer.js` | Normalize SDK/CLI events into unified format |
| `tunnel.js` | Backward-compat shim (re-exports CloudflareTunnelAdapter as TunnelManager) |
| `tunnel/index.js` | Tunnel module entry — re-exports + registers built-in adapters |
| `tunnel/registry.js` | Tunnel adapter registry + `parseTunnelArg` flag parser |
| `tunnel/base.js` | BaseTunnelAdapter — shared recovery logic |
| `tunnel/cloudflare.js` | CloudflareTunnelAdapter — quick/named modes |
| `tunnel-check.js` | Tunnel health verification |
| `tunnel-events.js` | Tunnel event wiring helpers |
| `session-manager.js` | Session lifecycle management |
| `models.js` | Model switching utilities |
| `logger.js` | Shared logging utility |

### App (`packages/app/src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | App root with navigation |
| `screens/ConnectScreen.tsx` | QR scan + manual connection UI |
| `screens/SessionScreen.tsx` | Session orchestrator (wires components) |
| `screens/SettingsScreen.tsx` | App settings and version info |
| `components/ChatView.tsx` | Message list, tool bubbles, plan approval card (inline component) |
| `components/TerminalView.tsx` | xterm.js terminal emulator (WebView), resize forwarding, crash recovery |
| `components/xterm-html.ts` | Inline HTML template for xterm.js WebView |
| `components/InputBar.tsx` | Text input with send/interrupt + mic button |
| `components/SettingsBar.tsx` | Collapsible bar: model/permission/cost/agents |
| `components/SessionPicker.tsx` | Horizontal session tab strip |
| `components/MarkdownRenderer.tsx` | Markdown parsing + inline code highlighting |
| `components/CreateSessionModal.tsx` | New session creation dialog |
| `components/DiffViewer.tsx` | Git diff modal with file list and line-level changes |
| `components/FileBrowser.tsx` | Project file browser with syntax-highlighted viewer |
| `store/connection.ts` | Zustand state store (ConnectionPhase) |
| `hooks/useSpeechRecognition.ts` | Voice-to-text input hook |
| `notifications.ts` | Push notification registration |
| `constants/colors.ts` | Shared color palette |
| `constants/icons.ts` | Shared icon constants |
| `utils/syntax.ts` | Syntax tokenizer for code highlighting |

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
