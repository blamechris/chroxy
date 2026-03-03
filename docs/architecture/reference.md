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
| ServerCLIChild | `src/server-cli-child.js` | Supervised child entry point (IPC to supervisor) |
| CliSession | `src/cli-session.js` | Claude Code headless executor (stream-json) |
| SdkSession | `src/sdk-session.js` | Claude Agent SDK executor |
| WsServer | `src/ws-server.js` | WebSocket protocol with auth + HTTP dashboard |
| WsMessageHandlers | `src/ws-message-handlers.js` | WS message handler dispatch |
| WsForwarding | `src/ws-forwarding.js` | Session event → WS broadcast wiring |
| WsSchemas | `src/ws-schemas.js` | Zod schemas for WebSocket message validation |
| WsFileOps | `src/ws-file-ops.js` | File browsing/reading WS message handlers |
| WsPermissions | `src/ws-permissions.js` | Permission request/response WS message handlers |
| EventNormalizer | `src/event-normalizer.js` | Normalize SDK/CLI events into unified format |
| SessionManager | `src/session-manager.js` | Session lifecycle management |
| ConversationScanner | `src/conversation-scanner.js` | Conversation history file scanning (parallel) |
| CheckpointManager | `src/checkpoint-manager.js` | Checkpoint creation/restore with git state |
| WebTaskManager | `src/web-task-manager.js` | Claude Code Web cloud task management |
| DevPreview | `src/dev-preview.js` | Dev server preview tunnel management |
| TokenManager | `src/token-manager.js` | API token rotation + expiry management |
| PushManager | `src/push.js` | Push notifications via Expo Push API |
| ConnectionInfo | `src/connection-info.js` | Write/remove connection info file for programmatic access |
| SessionContext | `src/session-context.js` | Session context data extraction (git branch, project, diff) |
| McpTools | `src/mcp-tools.js` | MCP (Model Context Protocol) server integration |
| ProviderRegistry | `src/providers.js` | Provider adapter interface + built-in registrations |
| Models | `src/models.js` | Model list management (static + dynamic from SDK) |
| ContentBlocks | `src/content-blocks.js` | Content block builder for structured output |
| ToolResult | `src/tool-result.js` | Tool result processing and formatting |
| MessageTransform | `src/message-transform.js` | Message transformation pipeline |
| PermissionHook | `src/permission-hook.js` | Permission hook management (CLI mode) |
| Dashboard | `src/dashboard.js` | Web dashboard HTML generation |
| TunnelRegistry | `src/tunnel/registry.js` | Tunnel adapter registry (`registerTunnel`/`getTunnel`/`parseTunnelArg`) |
| BaseTunnelAdapter | `src/tunnel/base.js` | Base class with shared recovery logic (backoff, events) |
| CloudflareTunnelAdapter | `src/tunnel/cloudflare.js` | Cloudflare adapter (quick/named modes) |
| TunnelManager | `src/tunnel.js` | Backward-compat shim re-exporting CloudflareTunnelAdapter |
| TunnelEvents | `src/tunnel-events.js` | Tunnel event wiring helpers |
| TunnelCheck | `src/tunnel-check.js` | Tunnel health verification (DNS propagation) |
| Crypto | `src/crypto.js` | ECDH key exchange + AES-GCM encryption |
| DiffParser | `src/diff-parser.js` | Unified diff parser for git output |
| JsonlReader | `src/jsonl-reader.js` | JSONL file reading utilities |
| LanIp | `src/lan-ip.js` | Local network IP detection |
| Duration | `src/duration.js` | Duration formatting utilities |
| Platform | `src/platform.js` | Cross-platform utilities (Windows/macOS/Linux) |
| Logger | `src/logger.js` | Shared logging utility |
| Doctor | `src/doctor.js` | Diagnostic command for troubleshooting |
| Service | `src/service.js` | Service management utilities |

## App Screens

| Screen | Purpose |
|--------|---------|
| ConnectScreen | QR scan or manual URL/token entry |
| SessionScreen | Dual-view: chat mode + terminal mode |
| SettingsScreen | App version, server URL, tap-to-copy |
| OnboardingScreen | Initial onboarding flow for first-time setup |
| HistoryScreen | Conversation history browsing and resume |
| PermissionHistoryScreen | Permission request history viewer |

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
| FolderBrowser | `src/components/FolderBrowser.tsx` | Folder selection dialog for session cwd |
| ImageViewer | `src/components/ImageViewer.tsx` | Image preview modal |
| LockScreen | `src/components/LockScreen.tsx` | Biometric authentication lock screen |
| PermissionDetail | `src/components/PermissionDetail.tsx` | Permission request detail rendering |
| SessionNotificationBanner | `src/components/SessionNotificationBanner.tsx` | Session status notifications banner |
| DevPreviewBanner | `src/components/DevPreviewBanner.tsx` | Dev server preview tunnel banner |
| WebTasksPanel | `src/components/WebTasksPanel.tsx` | Cloud tasks panel/list |
| xterm-html | `src/components/xterm-html.ts` | Inline HTML template for xterm.js WebView |
| xterm-bundle | `src/components/xterm-bundle.generated.ts` | Generated xterm.js + FitAddon bundle |

## State Management (Zustand)

Key state: `connectionPhase` (ConnectionPhase enum), `wsUrl`, `apiToken`, `viewMode`, `messages[]`, `terminalBuffer`

`ConnectionPhase`: `disconnected` → `connecting` → `connected` / `reconnecting` / `server_restarting`
`selectShowSession`: stays on SessionScreen during transient disconnects (reconnecting/server_restarting)

Store files:
| File | Purpose |
|------|---------|
| `store/connection.ts` | Zustand state store (ConnectionPhase, actions) |
| `store/message-handler.ts` | WS message handling logic (auth flow, events) |
| `store/persistence.ts` | State persistence (saved connections, view mode) |
| `store/types.ts` | TypeScript type definitions |
| `store/utils.ts` | Store utility functions |

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
| `close_dev_preview` | Close a dev server preview tunnel |
| `create_checkpoint` | Create a new checkpoint for session |
| `create_session` | Create new session with optional name/cwd |
| `delete_checkpoint` | Delete a checkpoint by ID |
| `destroy_session` | Delete session by ID |
| `encrypted` | Encrypted message envelope (E2E encryption) |
| `get_diff` | Request git diff for uncommitted changes |
| `input` | Send text or voice message to session |
| `interrupt` | Interrupt active Claude task |
| `key_exchange` | Send client X25519 public key for encryption |
| `launch_web_task` | Launch a Claude Code Web cloud task |
| `list_agents` | Request available custom agent definitions |
| `list_checkpoints` | Request list of checkpoints for session |
| `list_conversations` | Request scan of conversation history files |
| `list_directory` | Request home directory listing for browsing |
| `list_sessions` | Request list of all sessions |
| `list_slash_commands` | Request available slash command definitions |
| `list_web_tasks` | Request list of cloud web tasks |
| `permission_response` | Respond to permission prompt (allow/deny) |
| `ping` | Client heartbeat for connection keep-alive |
| `read_file` | Request file content within project |
| `register_push_token` | Register Expo push token for notifications |
| `rename_session` | Rename existing session by ID |
| `request_full_history` | Request complete JSONL history for session |
| `request_session_context` | Get context info for specific session |
| `restore_checkpoint` | Restore from a checkpoint (creates new session) |
| `resume_budget` | Resume a paused session after budget exceeded |
| `resume_conversation` | Resume a past conversation by creating a new session |
| `set_model` | Change active Claude model |
| `set_permission_mode` | Change permission handling mode |
| `switch_session` | Switch to different active session |
| `teleport_web_task` | Pull cloud task result into local session |
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
| `budget_exceeded` | Cost budget exceeded — session paused |
| `budget_resumed` | Previously paused session resumed after budget increase |
| `budget_warning` | Cost approaching budget limit |
| `claude_ready` | Claude Code ready for input |
| `checkpoint_created` | Checkpoint created (auto or manual) |
| `checkpoint_list` | List of checkpoints for session |
| `checkpoint_restored` | Checkpoint restored (new session created) |
| `client_joined` | New client connected to server |
| `client_left` | Client disconnected from server |
| `confirm_permission_mode` | Challenge auto mode (needs confirmation) |
| `conversation_id` | SDK conversation ID for session portability |
| `conversations_list` | List of conversation metadata (id, project, preview, mtime, size) |
| `cost_update` | Cost update for session (sessionCost, totalCost, budget) |
| `dev_preview` | Dev server preview tunnel opened |
| `dev_preview_stopped` | Dev server preview tunnel closed |
| `diff_result` | Git diff for uncommitted changes |
| `directory_listing` | Home directory listing response |
| `encrypted` | Encrypted message envelope (E2E encryption) |
| `file_content` | File content with syntax metadata |
| `file_listing` | Project file/directory listing response |
| `history_replay_end` | End of session history replay |
| `history_replay_start` | Beginning of session history replay |
| `key_exchange_ok` | Server X25519 public key for encryption |
| `mcp_servers` | Connected MCP servers list |
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
| `session_timeout` | Session destroyed due to idle timeout |
| `session_updated` | Session metadata changed (e.g., name via rename or auto-label) |
| `session_warning` | Session about to timeout (with remainingMs) |
| `slash_commands` | Available slash command definitions |
| `status` | Connection status (connected: true/false) |
| `stream_delta` | Token-by-token streaming response text |
| `stream_end` | Streaming response complete |
| `stream_start` | Beginning of streaming response |
| `token_rotated` | API token was rotated (client must re-authenticate) |
| `tool_result` | Tool execution result output |
| `tool_start` | Tool invocation started |
| `user_question` | AskUserQuestion prompt from Claude |
| `web_feature_status` | Web features availability flags |
| `web_task_created` | Cloud task launched |
| `web_task_error` | Cloud task error |
| `web_task_list` | Response to list_web_tasks |
| `web_task_updated` | Cloud task status changed |

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
- `cost_update` sent after each query with `{ sessionCost, totalCost, budget }` where budget is null if no cost budget configured
- `budget_warning` sent when session cost exceeds 80% of budget; `budget_exceeded` when budget is hit (session paused); `resume_budget` from client to unpause; `budget_resumed` broadcast by server after successful resume
- `session_updated` sent when session metadata changes (rename or auto-label); payload: `{ type: 'session_updated', sessionId, name }`
- `session_warning` sent before session timeout with `{ sessionId, name, reason, message, remainingMs }`; `session_timeout` when session is destroyed
- `token_rotated` broadcast when API token is rotated by TokenManager; includes `{ expiresAt }` only — the new token is NOT sent over the wire for security; clients must re-authenticate
- `checkpoint_created` payload: `{ sessionId, checkpoint: { id, name, description, messageCount, createdAt, hasGitSnapshot } }`; `checkpoint_list` returns array of checkpoints; `restore_checkpoint` creates a new session from checkpoint state
- `launch_web_task` includes a `prompt` string field; `web_task_created` confirms task launch; `web_task_updated` streams status changes; `teleport_web_task` pulls completed task result into local session
- `dev_preview` sent when a dev server tunnel is opened with `{ url, port }` (session-scoped via `broadcastToSession`); `close_dev_preview` from client to shut it down
- **Broadcast scoping (#1138):** `_broadcastToSession(sessionId, message)` defaults to `client.activeSessionId === sessionId || client.subscribedSessionIds.has(sessionId)`, delivering to clients viewing or subscribed to that session. Session-scoped messages: `stream_delta`, `model_changed`, `permission_mode_changed`, `budget_resumed`, `primary_changed`, `session_context`, `dev_preview`, `dev_preview_stopped`, and normalizer event messages. Global messages use `broadcast()`: `session_list`, `session_destroyed`, `session_activity`, `session_updated`, `client_joined`, `client_left`, `token_rotated`, `available_models`, `session_warning`, `session_timeout`, `server_error`, `server_status`, `server_shutdown`, `web_task_created`, `web_task_updated`, `web_task_error`.
- `mcp_servers` lists connected MCP tool servers and their status
- `auth_ok` includes `protocolVersion` (integer, currently `1`) — bumped when the WS message set changes; the app stores this and logs unknown message types when the server version is newer, enabling graceful degradation when the app lags behind the server

## Project Files

### Server (`packages/server/src/`)

| File | Purpose |
|------|---------|
| `checkpoint-manager.js` | Checkpoint creation/restore with git state |
| `cli.js` | CLI commands (init, start, config, tunnel setup) |
| `cli-session.js` | Claude Code headless executor (stream-json) |
| `config.js` | Config schema validation + merge precedence |
| `connection-info.js` | Write/remove connection info file |
| `content-blocks.js` | Content block builder for structured output |
| `conversation-scanner.js` | Conversation history file scanning (parallel) |
| `crypto.js` | ECDH key exchange + AES-GCM encryption |
| `dashboard.js` | Web dashboard HTML generation |
| `dev-preview.js` | Dev server preview tunnel management |
| `diff-parser.js` | Unified diff parser for git output |
| `doctor.js` | Diagnostic command for troubleshooting |
| `duration.js` | Duration formatting utilities |
| `event-normalizer.js` | Normalize SDK/CLI events into unified format |
| `jsonl-reader.js` | JSONL file reading utilities |
| `lan-ip.js` | Local network IP detection |
| `logger.js` | Shared logging utility |
| `mcp-tools.js` | MCP (Model Context Protocol) server integration |
| `message-transform.js` | Message transformation pipeline |
| `models.js` | Model list management (static + dynamic from SDK) |
| `permission-hook.js` | Permission hook management (CLI mode) |
| `platform.js` | Cross-platform utilities (Windows/macOS/Linux) |
| `providers.js` | Provider adapter registry + built-in registrations |
| `push.js` | Push notifications via Expo Push API |
| `sdk-session.js` | Claude Agent SDK executor |
| `server-cli.js` | CLI mode orchestrator |
| `server-cli-child.js` | Supervised child entry point (IPC to supervisor) |
| `service.js` | Service management utilities |
| `session-context.js` | Session context data extraction (git, project) |
| `session-manager.js` | Session lifecycle management |
| `supervisor.js` | Supervisor: tunnel owner + child auto-restart |
| `token-manager.js` | API token rotation + expiry management |
| `tool-result.js` | Tool result processing and formatting |
| `tunnel.js` | Backward-compat shim (re-exports CloudflareTunnelAdapter) |
| `tunnel/index.js` | Tunnel module entry — re-exports + registers built-in adapters |
| `tunnel/registry.js` | Tunnel adapter registry + `parseTunnelArg` flag parser |
| `tunnel/base.js` | BaseTunnelAdapter — shared recovery logic |
| `tunnel/cloudflare.js` | CloudflareTunnelAdapter — quick/named modes |
| `tunnel-check.js` | Tunnel health verification (DNS propagation) |
| `tunnel-events.js` | Tunnel event wiring helpers |
| `web-task-manager.js` | Claude Code Web cloud task management |
| `ws-file-ops.js` | File browsing/reading WS message handlers |
| `ws-forwarding.js` | Session event → WS broadcast wiring |
| `ws-message-handlers.js` | WS message handler dispatch |
| `ws-permissions.js` | Permission request/response WS handlers |
| `ws-schemas.js` | Zod schemas for WebSocket message validation |
| `ws-server.js` | WebSocket protocol with auth + HTTP dashboard |

### App (`packages/app/src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | App root with navigation |
| `screens/ConnectScreen.tsx` | QR scan + manual connection UI |
| `screens/SessionScreen.tsx` | Session orchestrator (wires components) |
| `screens/SettingsScreen.tsx` | App settings and version info |
| `screens/OnboardingScreen.tsx` | Initial onboarding flow |
| `screens/HistoryScreen.tsx` | Conversation history browsing and resume |
| `screens/PermissionHistoryScreen.tsx` | Permission request history viewer |
| `components/ChatView.tsx` | Message list, tool bubbles, plan approval card |
| `components/TerminalView.tsx` | xterm.js terminal emulator (WebView) |
| `components/xterm-html.ts` | Inline HTML template for xterm.js WebView |
| `components/xterm-bundle.generated.ts` | Generated xterm.js + FitAddon bundle |
| `components/InputBar.tsx` | Text input with send/interrupt + mic button |
| `components/SettingsBar.tsx` | Collapsible bar: model/permission/cost/agents |
| `components/SessionPicker.tsx` | Horizontal session tab strip |
| `components/MarkdownRenderer.tsx` | Markdown parsing + inline code highlighting |
| `components/CreateSessionModal.tsx` | New session creation dialog |
| `components/DiffViewer.tsx` | Git diff modal with file list and line-level changes |
| `components/FileBrowser.tsx` | Project file browser with syntax-highlighted viewer |
| `components/FolderBrowser.tsx` | Folder selection dialog for session cwd |
| `components/ImageViewer.tsx` | Image preview modal |
| `components/LockScreen.tsx` | Biometric authentication lock screen |
| `components/PermissionDetail.tsx` | Permission request detail rendering |
| `components/SessionNotificationBanner.tsx` | Session status notifications |
| `components/DevPreviewBanner.tsx` | Dev server preview tunnel banner |
| `components/WebTasksPanel.tsx` | Cloud tasks panel/list |
| `store/connection.ts` | Zustand state store (ConnectionPhase, actions) |
| `store/message-handler.ts` | WS message handling logic (auth flow, events) |
| `store/persistence.ts` | State persistence (saved connections, view mode) |
| `store/types.ts` | TypeScript type definitions |
| `store/utils.ts` | Store utility functions |
| `hooks/useSpeechRecognition.ts` | Voice-to-text input hook |
| `hooks/useBiometricLock.ts` | Biometric authentication hook |
| `hooks/useLayout.ts` | Layout and keyboard handling hook |
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
