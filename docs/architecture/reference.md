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
| DockerSession | `src/docker-session.js` | Containerized CLI executor (extends CliSession) |
| DockerSdkSession | `src/docker-sdk-session.js` | Containerized SDK executor (extends SdkSession) |
| WsServer | `src/ws-server.js` | WebSocket protocol with auth + HTTP dashboard |
| WsMessageHandlers | `src/ws-message-handlers.js` | WS message handler dispatch |
| WsForwarding | `src/ws-forwarding.js` | Session event → WS broadcast wiring |
| WsSchemas | `src/ws-schemas.js` | Zod schemas for WebSocket message validation |
| WsFileOps | `src/ws-file-ops.js` | File browsing/reading WS message handlers |
| WsPermissions | `src/ws-permissions.js` | Permission request/response WS message handlers |
| EnvironmentManager | `src/environment-manager.js` | Persistent container environment lifecycle (create, start, stop, remove, snapshot, restore) |
| EnvironmentHandlers | `src/environment-handlers.js` | WS message handlers for environment CRUD, snapshot, and restore |
| PermissionManager | `src/permission-manager.js` | Permission rule engine with per-session auto-allow/deny rules |
| SessionHandlers | `src/session-handlers.js` | WS message handlers for session lifecycle operations |
| WsClientManager | `src/ws-client-manager.js` | Client connection lifecycle management |
| WsBroadcaster | `src/ws-broadcaster.js` | Message broadcast to session and global scopes |
| SessionTimeoutManager | `src/session-timeout-manager.js` | Session idle timeout management |
| SessionStatePersistence | `src/session-state-persistence.js` | Session state file I/O |
| CostBudgetManager | `src/cost-budget-manager.js` | Per-session cost budget tracking and enforcement |
| BaseSession | `src/base-session.js` | Shared session logic (model, permissions, lifecycle) |
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

## Docker Provider Env Var Allowlists

Both Docker providers forward only explicitly allowlisted env vars into the container — never the full host environment. The allowlists differ because the providers handle permissions differently.

| Env Var | `DockerSession` (CLI) | `DockerSdkSession` (SDK) | Purpose |
|---------|:---------------------:|:------------------------:|---------|
| `ANTHROPIC_API_KEY` | yes | yes | API authentication |
| `NODE_ENV` | — | yes | Node.js environment mode |
| `CLAUDE_HEADLESS` | yes | — | Enable headless stream-json mode |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | yes | — | Enable file checkpointing |
| `CHROXY_PORT` | yes | — | Permission hook HTTP port on host |
| `CHROXY_HOOK_SECRET` | yes | — | Permission hook auth secret |
| `CHROXY_PERMISSION_MODE` | yes | — | Permission handling mode |
| `CHROXY_HOST` | injected | — | Permission hook hostname (set to `host.docker.internal`) |
| `HOME` | forwarded from host | hardcoded in container | User home directory |
| `PATH` | forwarded from host | hardcoded in container | Executable search path |

**Why they differ:** `DockerSession` extends `CliSession`, which runs `claude -p` as a subprocess and uses an external HTTP permission hook to route permission requests back to the host server. This requires `CHROXY_PORT`, `CHROXY_HOOK_SECRET`, and `CHROXY_PERMISSION_MODE` inside the container, plus `CLAUDE_HEADLESS` for stream-json mode. `DockerSdkSession` extends `SdkSession`, which manages the conversation loop and permissions in-process via the Agent SDK — no external hook calls are needed, so those vars are omitted. `HOME` and `PATH` are forwarded from the host env in `DockerSession` but hardcoded by the SDK spawn callback in `DockerSdkSession` (`/home/<user>` and a standard POSIX path). `CHROXY_HOST` is not in the `FORWARDED_ENV_KEYS` array — it is dynamically injected by `DockerSession._spawnPersistentProcess()` when `CHROXY_PORT` is present, set to `host.docker.internal` so the container can reach the host's permission hook endpoint.

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
                                              [Session Provider]
                                             /         |         \
                                   [CliSession]  [SdkSession]  [Docker*Session]
                                        ↕              ↕              ↕
                                   [claude -p]   [Agent SDK]   [docker exec → claude]
                                        ↕              ↕              ↕
                                            [Streaming JSON Events]
```

Session providers are selected via `--provider` flag or per-session at creation time.
Docker providers (`docker`, `docker-sdk`) require `--environments` flag. See [Container Isolation Guide](/docs/guides/container-isolation.md).

## WebSocket Protocol

### Client → Server

| Type | Purpose |
|------|---------|
| `add_repo` | Add a repo to the server's configured repo list |
| `auth` | Authenticate with server token and device info |
| `browse_files` | Request file/directory listing within project |
| `close_dev_preview` | Close a dev server preview tunnel |
| `create_checkpoint` | Create a new checkpoint for session |
| `create_environment` | Create a persistent container environment (Docker Compose, DevContainer, or plain) |
| `create_session` | Create new session with optional name/cwd |
| `delete_checkpoint` | Delete a checkpoint by ID |
| `destroy_environment` | Remove a persistent container environment |
| `destroy_session` | Delete session by ID |
| `encrypted` | Encrypted message envelope (E2E encryption) |
| `get_diff` | Request git diff for uncommitted changes |
| `git_branches` | Request git branch list for session project |
| `git_commit` | Commit staged changes with a message |
| `git_stage` | Stage files for commit |
| `git_status` | Request git status for session project |
| `git_unstage` | Unstage files from commit |
| `input` | Send text or voice message to session |
| `interrupt` | Interrupt active Claude task |
| `key_exchange` | Send client X25519 public key for encryption |
| `launch_web_task` | Launch a Claude Code Web cloud task |
| `list_agents` | Request available custom agent definitions |
| `list_environments` | Request list of persistent container environments |
| `list_checkpoints` | Request list of checkpoints for session |
| `list_conversations` | Request scan of conversation history files |
| `list_directory` | Request home directory listing for browsing |
| `list_files` | Recursive file search within session CWD (case-insensitive substring match, max depth 3) |
| `list_repos` | Request list of configured repos |
| `list_sessions` | Request list of all sessions |
| `list_slash_commands` | Request available slash command definitions |
| `list_web_tasks` | Request list of cloud web tasks |
| `permission_response` | Respond to permission prompt (allow/deny) |
| `ping` | Client heartbeat for connection keep-alive |
| `read_file` | Request file content within project |
| `register_push_token` | Register push token for notifications |
| `remove_repo` | Remove a repo from the server's configured repo list |
| `rename_session` | Rename existing session by ID |
| `request_cost_summary` | Request per-session cost breakdown |
| `request_full_history` | Request complete JSONL history for session |
| `request_session_context` | Get context info for specific session |
| `restore_checkpoint` | Restore from a checkpoint (creates new session) |
| `restore_environment` | Restore an environment from a named snapshot |
| `resume_budget` | Resume a paused session after budget exceeded |
| `resume_conversation` | Resume a past conversation by creating a new session |
| `search_conversations` | Search conversation history by query |
| `set_thinking_level` | Change thinking level (default, high, max) |
| `snapshot_environment` | Create a named snapshot of a running environment |
| `start_environment` | Start a stopped persistent environment |
| `stop_environment` | Stop a running persistent environment |
| `set_model` | Change active Claude model |
| `set_permission_mode` | Change permission handling mode |
| `set_permission_rules` | Set session-scoped auto-allow/deny rules for eligible tools |
| `subscribe_sessions` | Subscribe to updates for non-active sessions |
| `switch_session` | Switch to different active session |
| `teleport_web_task` | Pull cloud task result into local session |
| `unsubscribe_sessions` | Unsubscribe from non-active session updates |
| `user_question_response` | Respond to AskUserQuestion prompt |
| `write_file` | Write content to a file within the project |

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
| `cost_summary` | Per-session cost breakdown in response to `request_cost_summary` |
| `cost_update` | Cost update for session (sessionCost, totalCost, budget) |
| `dev_preview` | Dev server preview tunnel opened |
| `dev_preview_stopped` | Dev server preview tunnel closed |
| `diff_result` | Git diff for uncommitted changes |
| `directory_listing` | Home directory listing response |
| `encrypted` | Encrypted message envelope (E2E encryption) |
| `environment_created` | Persistent environment created successfully |
| `environment_destroyed` | Persistent environment removed |
| `environment_error` | Environment operation error |
| `environment_list` | List of persistent environments with status |
| `environment_restored` | Environment restored from snapshot |
| `environment_snapshot` | Environment snapshot created |
| `environment_started` | Persistent environment started |
| `environment_stopped` | Persistent environment stopped |
| `environment_updated` | Environment status or metadata changed |
| `file_content` | File content with syntax metadata |
| `file_list` | Response to `list_files` — flat list of matching file paths |
| `file_listing` | Project file/directory listing response (from `browse_files`) |
| `git_branches_result` | Git branch list response |
| `git_commit_result` | Result of a `git_commit` operation (hash, message, or error) |
| `git_stage_result` | Result of a `git_stage` operation |
| `git_status_result` | Git status response (branch, staged, unstaged, untracked) |
| `git_unstage_result` | Result of a `git_unstage` operation |
| `history_replay_end` | End of session history replay |
| `history_replay_start` | Beginning of session history replay |
| `key_exchange_ok` | Server X25519 public key for encryption |
| `mcp_servers` | Connected MCP servers list |
| `message` | Parsed chat message (user/response/tool_use) |
| `model_changed` | Active model updated by user |
| `permission_expired` | Permission request expired or already handled |
| `permission_mode_changed` | Permission mode changed by user |
| `permission_request` | Permission prompt from hook/SDK |
| `permission_resolved` | Permission resolved by another client — dismiss prompt |
| `permission_rules_updated` | Session permission whitelist updated — broadcast to all session clients |
| `plan_ready` | Plan complete, awaiting user approval |
| `plan_started` | Claude entered plan mode |
| `pong` | Heartbeat response to client ping |
| `primary_changed` | Last-writer-wins primary client changed |
| `repo_list` | Updated repo list in response to `list_repos`, `add_repo`, or `remove_repo` |
| `result` | Query stats (cost/duration/tokens) |
| `search_results` | Search results for a `search_conversations` query |
| `server_error` | Server-side error forwarded to app |
| `server_mode` | Which backend mode active (cli/terminal) |
| `server_shutdown` | Server shutting down (reason/ETA) |
| `server_status` | Non-error status update (e.g., recovery) |
| `session_activity` | Session busy state change (isBusy, lastCost) — global broadcast |
| `session_context` | Context info for specific session |
| `session_created` | New session created |
| `session_destroyed` | Session removed |
| `session_error` | Session operation error |
| `session_list` | All available sessions |
| `session_switched` | Switched to active session |
| `session_timeout` | Session destroyed due to idle timeout |
| `session_updated` | Session metadata changed (e.g., rename) |
| `session_warning` | Session about to timeout (with remainingMs) |
| `slash_commands` | Available slash command definitions |
| `status` | Connection status (connected: true/false) |
| `stream_delta` | Token-by-token streaming response text |
| `stream_end` | Streaming response complete |
| `stream_start` | Beginning of streaming response |
| `subscriptions_updated` | Confirmation that session subscriptions were updated |
| `token_rotated` | API token was rotated (client must re-authenticate) |
| `tool_result` | Tool execution result output |
| `tool_start` | Tool invocation started |
| `user_question` | AskUserQuestion prompt from Claude |
| `web_feature_status` | Web features availability flags |
| `web_task_created` | Cloud task launched |
| `web_task_error` | Cloud task error |
| `web_task_list` | Response to list_web_tasks |
| `web_task_updated` | Cloud task status changed |
| `write_file_result` | Result of a `write_file` operation |

### Protocol Details

- `add_repo` takes `{ path, name? }` — `path` must be within the user's home directory; `name` defaults to the directory basename. `remove_repo` takes `{ path }`. On success both respond with `repo_list`; on failure they may respond with `session_error` (validation) or `server_error`.
- `list_files` takes `{ sessionId?, query? }` — performs a recursive walk of the session CWD (max depth 3) with optional case-insensitive substring filtering by `query`; responds with `file_list`.
- On success, `list_repos`/`add_repo`/`remove_repo` respond with: `{ type: 'repo_list', repos: [{ path, name, source: 'manual'|'auto', exists: boolean }] }`.
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
- `set_permission_rules` accepts `{ rules: [{ tool, decision }], sessionId? }` where `tool` must be one of the eligible tools (`Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`) and `decision` is `'allow'` or `'deny'`; tools in `NEVER_AUTO_ALLOW` (`Bash`, `Task`, `WebFetch`, `WebSearch`) are rejected; sending an empty array clears all rules; server broadcasts `permission_rules_updated` with the current rules to all session clients
- `cost_update` sent after each query with `{ sessionCost, totalCost, budget }` where budget is null if no cost budget configured
- `budget_warning` sent when session cost exceeds 80% of budget; `budget_exceeded` when budget is hit (session paused); `resume_budget` from client to unpause; `budget_resumed` broadcast by server after successful resume
- `session_updated` payload: `{ type: 'session_updated', sessionId, name }` — broadcast globally when a session is renamed (user-initiated or auto-label)
- `session_warning` sent before session timeout with `{ sessionId, name, reason, message, remainingMs }`; `session_timeout` when session is destroyed
- `token_rotated` broadcast when API token is rotated by TokenManager; includes `{ expiresAt }` only — the new token is NOT sent over the wire for security; clients must re-authenticate
- `checkpoint_created` payload: `{ sessionId, checkpoint: { id, name, description, messageCount, createdAt, hasGitSnapshot } }`; `checkpoint_list` returns array of checkpoints; `restore_checkpoint` creates a new session from checkpoint state
- `launch_web_task` includes a `prompt` string field; `web_task_created` confirms task launch; `web_task_updated` streams status changes; `teleport_web_task` pulls completed task result into local session
- `dev_preview` sent when a dev server tunnel is opened with `{ url, port }` (session-scoped via `broadcastToSession`); `close_dev_preview` from client to shut it down
- **Broadcast scoping (#1138):** `_broadcastToSession(sessionId, message)` defaults to `client.activeSessionId === sessionId || client.subscribedSessionIds.has(sessionId)`, delivering to clients viewing or subscribed to that session. Session-scoped messages: `stream_delta`, `model_changed`, `permission_mode_changed`, `budget_resumed`, `primary_changed`, `session_context`, `dev_preview`, `dev_preview_stopped`, and normalizer event messages. Global messages use `broadcast()`: `session_list`, `session_destroyed`, `session_activity`, `session_updated`, `client_joined`, `client_left`, `token_rotated`, `available_models`, `session_warning`, `session_timeout`, `server_error`, `server_status`, `server_shutdown`, `web_task_created`, `web_task_updated`, `web_task_error`.
- `mcp_servers` lists connected MCP tool servers and their status
- `auth_ok` includes `protocolVersion` (integer, currently `1`) — bumped when the WS message set changes; the app stores this and logs unknown message types when the server version is newer, enabling graceful degradation when the app lags behind the server
- `permission_resolved` broadcast to all clients when another client approves or denies a `permission_request`; payload: `{ requestId, decision, sessionId }`; receiving clients should dismiss the corresponding prompt
- `subscribe_sessions` / `unsubscribe_sessions`: clients send these to receive session-scoped messages for non-active sessions (background monitoring); `subscriptions_updated` confirms the current set of subscribed session IDs
- `session_activity` global broadcast on stream start/end: `{ sessionId, isBusy: true/false, lastCost }` — allows clients to show busy state for any session
- `search_conversations` accepts `{ query }` and responds with `search_results`: `{ query, results: [{ conversationId, project, projectName, preview, cwd, snippet, matchCount }] }`
- `request_cost_summary` responds with `cost_summary`: `{ totalCost, budget, sessions: [{ sessionId, name, cost, model }] }`
- `write_file` accepts `{ sessionId, path, content }` and responds with `write_file_result`: `{ path, error }` (`error: null` on success, `error: string` on failure)
- `git_status` / `git_branches` / `git_stage` / `git_unstage` / `git_commit` are project-scoped git operations; results dispatched via `_gitStatusCallback`, `_gitBranchesCallback`, `_gitStageCallback` (handles both `git_stage_result` and `git_unstage_result`), and `_gitCommitCallback` in the app store

## Project Files

### Server (`packages/server/src/`)

| File | Purpose |
|------|---------|
| `checkpoint-manager.js` | Checkpoint creation/restore with git state |
| `cli.js` | CLI commands (init, start, config, tunnel setup) |
| `cli-session.js` | Claude Code headless executor (stream-json) |
| `config.js` | Config schema validation + merge precedence |
| `connection-info.js` | Write/remove connection info file |
| `docker-session.js` | Containerized CLI executor (extends CliSession) |
| `docker-sdk-session.js` | Containerized SDK executor (extends SdkSession) |
| `content-blocks.js` | Content block builder for structured output |
| `conversation-scanner.js` | Conversation history file scanning (parallel) |
| `crypto.js` | ECDH key exchange + AES-GCM encryption |
| `dev-preview.js` | Dev server preview tunnel management |
| `diff-parser.js` | Unified diff parser for git output |
| `docker-session.js` | Container-isolated CLI session (extends CliSession) |
| `docker-sdk-session.js` | Container-isolated SDK session (extends SdkSession) |
| `environment-manager.js` | Persistent container environment lifecycle management |
| `environment-handlers.js` | WS message handlers for environment operations |
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
| `permission-manager.js` | Permission rule engine (per-session auto-allow/deny) |
| `base-session.js` | Shared session logic (model, permissions, lifecycle) |
| `session-handlers.js` | WS message handlers for session lifecycle |
| `session-timeout-manager.js` | Session idle timeout management |
| `session-state-persistence.js` | Session state file I/O |
| `cost-budget-manager.js` | Per-session cost budget tracking |
| `ws-client-manager.js` | Client connection lifecycle management |
| `ws-broadcaster.js` | Message broadcast to session and global scopes |
| `ws-client-sender.js` | Message send/encrypt logic per client |
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

### Dashboard Frontend (`packages/server/src/dashboard-next/`)

The web dashboard is a React + Vite SPA served by the Node.js server. It shares the same WebSocket protocol as the mobile app.

| File | Purpose |
|------|---------|
| `src/App.tsx` | App root — routing, WebSocket setup, theme |
| `src/main.tsx` | Vite entry point |
| **Components** | |
| `src/components/ChatView.tsx` | Message list with streaming, tool bubbles |
| `src/components/ChatMessage.tsx` | Individual message bubble with markdown |
| `src/components/InputBar.tsx` | Text input with slash commands, file attachments |
| `src/components/TerminalView.tsx` | xterm.js terminal emulator |
| `src/components/MultiTerminalView.tsx` | Multi-tab terminal container |
| `src/components/Sidebar.tsx` | Session list, navigation, resize |
| `src/components/SessionBar.tsx` | Session tab strip |
| `src/components/StatusBar.tsx` | Connection status, cost, model info |
| `src/components/FooterBar.tsx` | Bottom bar with actions |
| `src/components/SettingsPanel.tsx` | Settings configuration panel |
| `src/components/CommandPalette.tsx` | Keyboard-driven command palette |
| `src/components/SlashCommandPicker.tsx` | Slash command autocomplete picker |
| `src/components/FilePicker.tsx` | File attachment picker |
| `src/components/FileBrowserPanel.tsx` | Project file browser with syntax highlighting |
| `src/components/DiffViewerPanel.tsx` | Git diff viewer with file list |
| `src/components/DirectoryBrowser.tsx` | Directory navigation for session cwd |
| `src/components/CheckpointTimeline.tsx` | Checkpoint list with timeline UI |
| `src/components/ConversationSearch.tsx` | Conversation history search |
| `src/components/PermissionPrompt.tsx` | Permission request dialog |
| `src/components/QuestionPrompt.tsx` | User question prompt dialog |
| `src/components/PlanApproval.tsx` | Plan mode approval UI |
| `src/components/ToolBubble.tsx` | Tool use/result display bubble |
| `src/components/ImageThumbnail.tsx` | Image preview thumbnail |
| `src/components/AttachmentChip.tsx` | File attachment chip display |
| `src/components/AgentMonitorPanel.tsx` | Background agent status panel |
| `src/components/CreateSessionModal.tsx` | New session creation dialog |
| `src/components/CreateSessionPanel.tsx` | Session creation form panel |
| `src/components/Modal.tsx` | Reusable modal component |
| `src/components/Toast.tsx` | Toast notification component |
| `src/components/NotificationBanners.tsx` | Session notification banners |
| `src/components/ReconnectBanner.tsx` | Reconnection status banner |
| `src/components/SplitPane.tsx` | Resizable split pane layout |
| `src/components/ShortcutHelp.tsx` | Keyboard shortcut help overlay |
| `src/components/ServerPicker.tsx` | Multi-server connection picker |
| `src/components/QrModal.tsx` | QR code display modal |
| `src/components/ConsolePage.tsx` | Console page with connection info |
| `src/components/LogPanel.tsx` | Server log panel with filtering |
| `src/components/LoadingScreen.tsx` | Loading state skeleton |
| `src/components/SessionLoadingSkeleton.tsx` | Session loading skeleton |
| `src/components/WelcomeScreen.tsx` | Initial welcome/connect screen |
| `src/components/ErrorScreen.tsx` | Error state display |
| `src/components/ThinkingDots.tsx` | Animated thinking indicator |
| **Hooks** | |
| `src/hooks/useGlobalShortcuts.ts` | Global keyboard shortcut handler |
| `src/hooks/usePathAutocomplete.ts` | Path autocomplete for directory input |
| `src/hooks/usePermissionNotification.ts` | Permission request notification hook |
| `src/hooks/useTauriEvents.ts` | Tauri event listener bridge |
| `src/hooks/useTauriIPC.ts` | Tauri IPC command bridge |
| **Store** | |
| `src/store/connection.ts` | Zustand WebSocket store (mirrors app store) |
| `src/store/message-handler.ts` | WS message handling (shared protocol) |
| `src/store/persistence.ts` | LocalStorage state persistence |
| `src/store/server-registry.ts` | Multi-server connection registry |
| `src/store/commands.ts` | Command palette command registry |
| `src/store/mru.ts` | Most-recently-used tracking |
| `src/store/crypto.ts` | Client-side encryption (ECDH/AES-GCM) |
| `src/store/token-crypto.ts` | Token encryption for secure storage |
| `src/store/types.ts` | TypeScript type definitions |
| `src/store/utils.ts` | Store utility functions |
| **Utils** | |
| `src/utils/auth.ts` | Authentication utilities |
| `src/utils/attachment-utils.ts` | File attachment processing |
| `src/utils/image-utils.ts` | Image processing utilities |
| **Theme** | |
| `src/theme/tokens.ts` | Generated design tokens (colors, spacing) |

### Store Core (`packages/store-core/`)

Shared store logic extracted for reuse between mobile app and dashboard.

| File | Purpose |
|------|---------|
| `src/index.ts` | Package entry point — re-exports |
| `src/platform.ts` | Platform detection (web, mobile, desktop) |
| `src/storage.ts` | Cross-platform storage abstraction |
| `src/user-input-handler.ts` | User input processing and validation |

### Desktop App (`packages/desktop/`)

Tauri tray application wrapping the web dashboard with native integrations.

| File | Purpose |
|------|---------|
| `src-tauri/src/main.rs` | Application entry point |
| `src-tauri/src/lib.rs` | Module declarations, tray menu, app lifecycle |
| `src-tauri/src/server.rs` | ServerManager — spawn/monitor Node.js server process |
| `src-tauri/src/config.rs` | Read `~/.chroxy/config.json` subset for desktop |
| `src-tauri/src/settings.rs` | DesktopSettings — persist to `~/.chroxy/desktop-settings.json` |
| `src-tauri/src/node.rs` | Node.js discovery and version validation (≥22) |
| `src-tauri/src/platform.rs` | Cross-platform path and environment utilities |
| `src-tauri/src/qrcode.rs` | QR code generation from connection URL |
| `src-tauri/src/setup.rs` | First-run setup and config initialization |
| `src-tauri/src/window.rs` | Window management (show/hide/navigate) |

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
| `docs/guides/container-isolation.md` | Container isolation guide (sandbox, Docker, combined) |
