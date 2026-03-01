# Chroxy Desktop Architecture Audit

Comprehensive codebase audit to inform the development of an enhanced desktop application layer.

## Executive Summary

Chroxy's architecture is already well-suited for a desktop orchestration hub. The existing system implements a mature event-driven WebSocket protocol (58+ message types) with E2E encryption (XSalsa20-Poly1305 / Curve25519 ECDH), multi-session management with persistent state, a pluggable tunnel adapter registry, and a working Tauri tray app that manages the Node.js server as a supervised child process. The primary opportunities for the new desktop app are: (1) replacing the vanilla-JS dashboard with a React-based UI that shares component patterns with the mobile app, (2) adding direct in-process communication between the desktop UI and the server to eliminate localhost WebSocket overhead for local clients, and (3) implementing repository discovery, session orchestration, and rich settings UI natively in the desktop layer.

---

## Section 1: Message Synchronization Mechanism

### Current Implementation

**Architecture: Event-driven push, not polling.** All state changes propagate immediately via WebSocket broadcast. The server never polls clients; clients never poll the server for state updates.

**Message flow path:**

```
Claude SDK/CLI → session events → EventNormalizer → WsForwarding → WsServer.broadcast → WebSocket → Client
```

1. **Backend sessions** (SdkSession or CliSession) emit raw events: `ready`, `stream_start`, `stream_delta`, `stream_end`, `message`, `tool_start`, `tool_result`, `result`, `error`, `user_question`, `permission_request`, `agent_spawned`, `agent_completed`, `plan_started`, `plan_ready`.

2. **SessionManager** (`session-manager.js:686-724`) proxies these as `session_event { sessionId, event, data }` and records activity-type events in a 500-message ring buffer per session.

3. **EventNormalizer** (`event-normalizer.js`) maps raw events to WS message objects via a declarative `EVENT_MAP`. Each mapping returns `{ messages, sideEffects, registrations, buffer }`. The `buffer: true` flag on `stream_delta` signals the caller to batch deltas rather than sending immediately.

4. **WsForwarding** (`ws-forwarding.js:15-99`) wires everything together:
   - Calls `normalizer.normalize(event, data, ctx)` for each session event
   - For delta events: calls `normalizer.bufferDelta(sessionId, messageId, delta)` which accumulates text and flushes on a timer
   - Executes side effects (flush deltas, emit session list, log)
   - Broadcasts messages via `broadcastToSession(sessionId, msg)` or global `broadcast(msg)`

5. **WsServer** (`ws-server.js:1032-1210`) delivers messages to connected clients:
   - `_broadcastToSession(sessionId, msg, filter?)`: sends to all authenticated clients viewing that session
   - `_broadcast(msg, filter?)`: sends to all authenticated clients
   - If E2E encryption active: encrypts per-client before sending
   - Adds `seq` number per client for ordering metadata
   - WebSocket per-message deflate compression for messages >1KB

**Delta streaming optimization:**

The normalizer implements a timer-based delta flush mechanism:
- `stream_delta` events are buffered per `(sessionId, messageId)` key
- Accumulated text is flushed every N milliseconds (configurable, default ~50ms)
- On `stream_end`, remaining deltas are force-flushed before the end marker

**Client-side delta batching (app):**

The mobile app (`message-handler.ts:931-972`) implements additional client-side batching:
- Incoming `stream_delta` messages are accumulated in a `pendingDeltas` map
- A 100ms `setTimeout` flushes accumulated deltas to the Zustand store
- This reduces React re-renders during rapid token streaming

### Identified Bottlenecks and Limitations

1. **Localhost WebSocket overhead for desktop.** The desktop app connects to its own server via `ws://localhost:{port}`, going through full WebSocket framing, JSON serialization, and (optionally) encryption. For a local-only connection, this adds unnecessary overhead.

2. **Full-state replay on reconnect.** When a client reconnects, the server replays the entire message history (up to 500 messages). There is no differential sync — the client receives everything and must deduplicate against its local cache (`message-handler.ts:859-869`).

3. **No message acknowledgment.** The protocol is fire-and-forget (at-most-once delivery). If a message is lost during a brief disconnect, there's no mechanism to detect or recover the gap. The only recovery is full history replay.

4. **Session-scoped broadcast fan-out.** Every message is broadcast to all clients viewing that session. With multiple desktop + mobile clients, each message is serialized/encrypted N times. No message deduplication at the protocol level.

5. **Terminal buffer sync.** Terminal output is synced as raw ANSI text via `stream_delta` and the terminal buffer. There's no incremental terminal state sync — on reconnect, the full terminal buffer (up to 50KB persisted on client) is the only state available.

### Recommendations for New Desktop App

1. **Add IPC channel for local desktop UI.** When the desktop UI and server run in the same process group, use Node IPC (or Tauri command bridge) instead of WebSocket for the local connection. Reserve WebSocket for remote/mobile clients.

2. **Implement differential sync with sequence numbers.** Add per-session monotonic sequence numbers to messages. On reconnect, the client sends its last-seen sequence number; the server replays only messages after that point. This eliminates the full-replay overhead.

3. **Add message acknowledgment for critical messages.** Permission responses and user inputs should have delivery confirmation. Other messages (stream deltas, status updates) can remain fire-and-forget.

4. **Consider shared-memory terminal state.** For the local desktop terminal view, pass terminal data through shared memory or direct IPC rather than WebSocket serialization.

---

## Section 2: Repository and Session Management

### Current Implementation

**Repository discovery** operates through two mechanisms:

1. **Conversation scanning** (`conversation-scanner.js`): Scans `~/.claude/projects/` for JSONL conversation files. Claude Code stores conversations in directories named by encoded paths (e.g., `-Users-blamechris-Projects-chroxy/`). The scanner decodes these back to filesystem paths, verifies they exist, and extracts metadata (project name, last message preview, modification time). Results are cached for 5 seconds.

2. **Session context** (`session-context.js`): Reads git metadata for a session's working directory — branch name, dirty file count, commits ahead of upstream, and project name from `package.json`. Each git operation has a 3-second timeout with graceful degradation.

**Session lifecycle:**

The `SessionManager` (`session-manager.js`, 945 lines) manages up to 5 concurrent sessions:

| Phase | Mechanism |
|-------|-----------|
| **Creation** | `createSession()` → validate CWD → instantiate provider → wire events → `session.start()` |
| **Running** | Events proxied via `session_event`, recorded in ring buffer, broadcast to clients |
| **Switching** | Client sends `switch_session` → server sets `client.activeSessionId` → replays history |
| **Idle timeout** | Configurable timeout (e.g., "2h"). Checked every 60s. Warning at T-2min. Sessions with active viewers are exempt. |
| **Destruction** | `destroySession()` → `session.destroy()` → cleanup events → remove from maps → emit `session_destroyed` |
| **Persistence** | Debounced (2s) atomic write to `~/.chroxy/session-state.json`. TTL: 24h. Restored on server restart. |

**Provider architecture** (`providers.js`):

Two built-in providers via a registry pattern:
- **`claude-sdk`** (SdkSession): Agent SDK `query()`, in-process permissions, conversation resume via `resumeSessionId`, model/permission switching without restart
- **`claude-cli`** (CliSession): Legacy headless `claude -p` process, NDJSON stream, HTTP permission hooks, no resume capability

**State persistence:**

Server persists to `~/.chroxy/session-state.json`:
```json
{
  "version": 1,
  "timestamp": 1709136000000,
  "sessions": [{
    "id": "a1b2c3d4",
    "sdkSessionId": "conv-uuid",
    "cwd": "/Users/user/project",
    "model": "claude-sonnet-4-6",
    "permissionMode": "approve",
    "provider": "claude-sdk",
    "name": "Main Session",
    "history": [/* up to 500 messages, content truncated at 50KB each */]
  }],
  "costs": { "a1b2c3d4": 0.42 },
  "budgetWarned": [],
  "budgetExceeded": [],
  "budgetPaused": []
}
```

Client (mobile app) persists to AsyncStorage:
- Per-session messages (last 100, base64 stripped)
- Active session ID, view mode, terminal buffer (50KB max)
- Session list (for offline display)
- Debounced saves: 500ms for messages, 1s for terminal buffer

**Checkpoint system** (`checkpoint-manager.js`):
- Max 50 checkpoints per session (FIFO eviction)
- Creates git tags (`chroxy-checkpoint/{id}`) for code state snapshots
- Stored in `~/.chroxy/checkpoints/{sessionId}.json`
- Restore creates a new session with `resumeSessionId` from the checkpoint

### Identified Bottlenecks and Limitations

1. **No proactive repository discovery.** Repos are only discovered through past Claude Code conversations. There's no filesystem scanning for git repos, no integration with IDE project lists, and no way to browse repos that haven't been used with Claude yet.

2. **Session limit is hardcoded.** The 5-session limit is set at construction time. Desktop users with more resources may want more concurrent sessions.

3. **State file is single-writer.** The state file uses atomic write (temp + rename) but has no locking. If multiple server instances write concurrently (unlikely but possible), data could be lost.

4. **No cross-device session sync.** Session state is local to the server machine. Mobile app caches locally but can't transfer sessions between machines.

5. **Checkpoint storage is unbounded per session.** While limited to 50 per session, there's no global limit. Many sessions with many checkpoints could accumulate significant disk usage.

### Recommendations for New Desktop App

1. **Add filesystem-based repo discovery.** Scan common project directories (`~/Projects`, `~/Developer`, `~/Code`, etc.) for git repos. Combine with conversation history scanning for a unified repo browser.

2. **Make session limit configurable.** Allow desktop users to increase beyond 5 based on available system resources.

3. **Desktop should own session lifecycle.** Session creation, switching, and destruction should be initiated from the desktop UI as the primary orchestrator, with mobile as a follower that syncs state.

4. **Implement repo pinning/favorites.** Let users pin frequently-used repos for quick session creation.

5. **Add session templates.** Allow saving session configurations (model, permission mode, CWD, provider) as reusable templates.

---

## Section 3: Tunnel Implementation

### Current Implementation

**Architecture: Pluggable adapter registry** (`tunnel/registry.js`):

```
TunnelRegistry (Map)
  └── "cloudflare" → CloudflareTunnelAdapter
      ├── Quick mode: random URL, no auth needed
      └── Named mode: stable FQDN, requires Cloudflare account
```

**BaseTunnelAdapter** (`tunnel/base.js`) provides shared recovery logic:
- Events: `tunnel_lost`, `tunnel_recovering`, `tunnel_recovered`, `tunnel_url_changed`, `tunnel_failed`
- Recovery: max 3 attempts, exponential backoff [3s, 6s, 12s]
- URL change detection on recovery

**CloudflareTunnelAdapter** (`tunnel/cloudflare.js`):

| Mode | Command | URL | Setup |
|------|---------|-----|-------|
| Quick | `cloudflared tunnel --url http://localhost:{port}` | Random `*.trycloudflare.com` | None |
| Named | `cloudflared tunnel run {name} --url http://localhost:{port}` | User's domain | `chroxy tunnel setup` |

- 30-second timeout for tunnel establishment
- URL parsed from cloudflared stdout via regex (quick mode)
- Named mode URL known from config (no parsing needed)
- Recovery preserves URL for named tunnels (DNS stability)

**Tunnel verification** (`tunnel-check.js`):
- After tunnel starts, HTTP health check polls the tunnel URL
- 10 attempts, 2s interval
- Ensures DNS propagation before advertising URL

**E2E encryption** (`crypto.js`):

| Component | Algorithm | Library |
|-----------|-----------|---------|
| Key exchange | Curve25519 ECDH | tweetnacl (nacl.box.before) |
| Encryption | XSalsa20-Poly1305 | tweetnacl (nacl.secretbox) |
| Nonce | 24-byte: direction(1) + counter(8) + padding(15) | Custom |

**Key exchange flow:**
1. Client generates ephemeral X25519 keypair
2. Server generates ephemeral keypair on `key_exchange` message
3. Both derive identical shared secret via `nacl.box.before()`
4. All subsequent messages encrypted with XSalsa20-Poly1305
5. Direction byte in nonce prevents reuse across send directions
6. Monotonic counter prevents replay attacks
7. Forward secrecy: ephemeral keys discarded after exchange

**Localhost bypass:** Encryption skipped for connections from `127.0.0.1`, `::1`, `::ffff:127.0.0.1` (raw socket IP, not proxy headers).

**Authentication:**
- Token-based: constant-time comparison via `safeTokenCompare()` (padded `timingSafeEqual`)
- Rate limiting: per-IP exponential backoff (1s→60s cap), cleaned every 60s
- Token rotation: `TokenManager` supports rotation with grace period; `token_rotated` event notifies clients
- 10-second auth timeout: unauthenticated sockets auto-closed
- 10-second key exchange timeout: prevents encryption downgrade

### Identified Bottlenecks and Limitations

1. **Quick tunnel URL instability.** Every server restart generates a new random URL. Users must re-scan QR codes or re-enter the URL. The named tunnel mode solves this but requires Cloudflare account setup.

2. **Single tunnel provider.** Only Cloudflare is supported. The adapter registry pattern exists but no alternative providers are implemented.

3. **No tunnel health monitoring in desktop UI.** The desktop tray app has no visibility into tunnel state beyond server health polling. Tunnel crashes, URL changes, and recovery attempts are invisible to the user.

4. **Recovery limited to 3 attempts.** If the tunnel fails 3 times, it gives up permanently. The server continues on localhost only, and the user must manually restart.

5. **No split-tunnel architecture.** All traffic goes through the same tunnel. There's no way to route some clients through the tunnel and serve others directly on LAN.

### Recommendations for New Desktop App

1. **Surface tunnel status in desktop UI.** Show tunnel state (connecting, active, recovering, failed), current URL, and connection count. Wire the existing tunnel events to desktop notifications.

2. **Implement LAN discovery as a complement to tunnels.** The server already broadcasts via mDNS (`_chroxy._tcp`). The desktop app should show the LAN URL alongside the tunnel URL, allowing local clients to bypass the tunnel entirely.

3. **Add tunnel provider selection in desktop UI.** Expose the adapter registry to the UI. When additional providers (ngrok, etc.) are implemented, users can switch from the desktop settings.

4. **Carry forward the encryption pattern.** The E2E encryption implementation is production-grade. The desktop app should use the same protocol for remote connections and bypass encryption for local IPC.

5. **Add tunnel auto-recovery with longer persistence.** Increase recovery attempts for transient failures (network blips). Add a "restart tunnel" button in the desktop UI for manual recovery.

---

## Section 4: WebSocket / Real-Time Communication Layer

### Current Implementation

**Protocol overview:**

- **Transport:** WebSocket over HTTP/HTTPS (via Cloudflare tunnel or localhost)
- **Serialization:** JSON, with optional XSalsa20-Poly1305 encryption envelope
- **Compression:** per-message deflate (zlib level 6, threshold 1KB)
- **Protocol version:** `SERVER_PROTOCOL_VERSION = 1` (additive-only bumps)
- **Max payload:** 10MB (supports image/document attachments)

**Complete message catalog:**

| Direction | Count | Examples |
|-----------|-------|---------|
| Client → Server | 28 types | `auth`, `input`, `interrupt`, `switch_session`, `create_session`, `permission_response`, `set_model`, `browse_files`, `get_diff`, `list_conversations`, `resume_conversation`, `launch_web_task`, `create_checkpoint` |
| Server → Client | 55+ types | `auth_ok`, `stream_start/delta/end`, `message`, `tool_start/result`, `permission_request`, `session_list/switched/created/destroyed`, `agent_busy/idle/spawned/completed`, `plan_started/ready`, `cost_update`, `checkpoint_created`, `dev_preview` |

**Bidirectional patterns:**

| Pattern | Example | Mechanism |
|---------|---------|-----------|
| Request-Response | `ping` → `pong` | Immediate reply |
| Streaming | `input` → `stream_start` → `stream_delta`* → `stream_end` → `result` | Token-by-token push |
| Broadcast | Session state changes | Server pushes to all viewers |
| Challenge-Response | `set_permission_mode(auto)` → `confirm_permission_mode` → `set_permission_mode(auto, confirmed)` | Security confirmation |
| History Replay | `request_full_history` → `history_replay_start` → messages → `history_replay_end` | Bulk replay |

**Heartbeat mechanism:**

| Component | Interval | Timeout | Action on failure |
|-----------|----------|---------|-------------------|
| Client ping | 15s | 5s pong timeout | Close socket, trigger reconnect |
| Server ping | 30s | Next cycle (30s) | Terminate unresponsive client |

Client measures RTT with EWMA smoothing (alpha=0.3) and reports connection quality (good <200ms, fair <500ms, poor ≥500ms).

**Reconnection logic (client):**

```
socket.onclose
  → phase = 'reconnecting'
  → HTTP health check (GET /)
    → status 'restarting' → exponential backoff with ETA
    → status 'ok' → open WebSocket
    → failure → retry (max 5, delays: 1s, 2s, 3s, 5s, 8s with ±10% jitter)
  → auth → key_exchange (if remote) → connected
  → request session_list → switch_session → history_replay
```

**Offline message queue (client):**
- Max 10 queued messages
- TTL per type: input (60s), interrupt (5s), permission_response (300s), user_question_response (60s)
- Excluded from queue: set_model, set_permission_mode, resize
- Drained on reconnect after auth

**Multi-client coordination:**
- `auth_ok` includes `clientId` and `connectedClients` list
- `client_joined` / `client_left` broadcast on connect/disconnect
- `primary_changed` tracks last-writer-wins per session (fires on `input`)
- `client_focus_changed` broadcast when client switches sessions

**Schema validation:**
- All client→server messages validated via Zod `discriminatedUnion` (`ws-schemas.js:451-483`)
- Invalid messages rejected with `{ type: 'error', code: 'INVALID_MESSAGE', details }`

### Identified Bottlenecks and Limitations

1. **JSON serialization overhead.** Every message is JSON-serialized, even for local connections. Binary formats (MessagePack, CBOR) would reduce CPU and bandwidth for high-throughput scenarios (terminal streaming).

2. **No message-level acknowledgment.** Fire-and-forget delivery means message gaps during brief disconnects are undetectable without full replay.

3. **Single WebSocket connection.** All message types share one connection. A large file transfer or history replay can block real-time stream deltas. No priority lanes or multiplexing.

4. **Schema validation on every message.** Zod validation runs on every incoming message. For high-frequency messages (stream_delta, ping), this adds overhead.

5. **Per-client encryption.** Each broadcast message is encrypted separately for each client. With N clients, this is O(N) encryption operations per message.

### Recommendations for New Desktop App

1. **Implement message prioritization.** Stream deltas and permission requests should have higher priority than file listings or history replays. Consider separate logical channels over the same WebSocket.

2. **Add optional binary serialization for high-throughput messages.** Terminal output and stream deltas could use a more compact format. Keep JSON for control messages for debuggability.

3. **Cache schema validators.** Pre-compile Zod schemas at startup rather than re-parsing on each message. Skip validation for trusted local connections.

4. **Implement shared encryption for broadcast.** For messages going to multiple clients with the same session view, encrypt once and multicast. (Requires protocol change.)

5. **Add sequence-based gap detection.** The existing `seq` field on server-sent messages (line 1200 of ws-server.js) could be used for gap detection. Clients should track expected sequence numbers and request re-sync on gaps.

---

## Section 5: Data Flow Diagram

### System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         DESKTOP (Tauri + Rust)                           │
│                                                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────────────┐   │
│  │  Tray Menu   │    │  Settings     │    │  WebView Window           │   │
│  │  Start/Stop  │    │  ~/.chroxy/   │    │  ┌─────────────────────┐ │   │
│  │  Restart     │    │  desktop-     │    │  │  Dashboard (HTML/JS) │ │   │
│  │  Dashboard   │    │  settings.json│    │  │  Chat + Terminal     │ │   │
│  │  Tunnel Mode │    │              │    │  │  Sessions + Files    │ │   │
│  └──────┬───────┘    └──────────────┘    │  └──────────┬──────────┘ │   │
│         │                                │             │            │   │
│         │ spawn/kill                     │    ws://localhost:{port}  │   │
│         ▼                                │             │            │   │
│  ┌──────────────┐                        │             │            │   │
│  │ ServerManager │──health poll (GET /)──│─────────────┘            │   │
│  │  (Rust)       │                        └─────────────────────────┘   │
│  └──────┬───────┘                                                       │
└─────────┼───────────────────────────────────────────────────────────────┘
          │
          │ child process (node cli.js start --no-supervisor)
          │ env: PORT, API_TOKEN, CHROXY_TUNNEL, CHROXY_CWD, CHROXY_MODEL
          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         SERVER (Node.js)                                 │
│                                                                          │
│  ┌──────────┐   ┌───────────────┐   ┌─────────────────────────────────┐ │
│  │ ServerCLI │──▶│ SessionManager │──▶│ Sessions (max 5)               │ │
│  │           │   │                │   │  ┌────────────┐ ┌───────────┐  │ │
│  │  startup  │   │  create/switch │   │  │ SdkSession │ │ CliSession│  │ │
│  │  config   │   │  destroy/list  │   │  │ (SDK query)│ │ (claude-p)│  │ │
│  │  restore  │   │  persist state │   │  └─────┬──────┘ └─────┬─────┘  │ │
│  └──────────┘   └───────┬───────┘   │        │              │         │ │
│                         │            │        ▼              ▼         │ │
│                    session_event     │  ┌──────────────────────────┐   │ │
│                         │            │  │ Claude Code (SDK / CLI)  │   │ │
│                         ▼            │  │ Streaming JSON events    │   │ │
│                  ┌──────────────┐    │  └──────────────────────────┘   │ │
│                  │EventNormalizer│    └─────────────────────────────────┘ │
│                  │ EVENT_MAP     │                                        │
│                  │ delta buffer  │                                        │
│                  └──────┬───────┘                                        │
│                         │                                                │
│                         ▼                                                │
│                  ┌──────────────┐    ┌────────────────┐                  │
│                  │ WsForwarding  │──▶│    WsServer     │                  │
│                  │ event→message │   │                │                  │
│                  └──────────────┘   │  ┌───────────┐ │   ┌──────────┐  │
│                                     │  │   Auth    │ │   │ Dashboard │  │
│                                     │  │   E2E     │ │   │  (HTTP)   │  │
│                                     │  │  Encrypt  │ │   │  /qr      │  │
│                                     │  │  Compress │ │   │  /health  │  │
│                                     │  └─────┬─────┘ │   └──────────┘  │
│                                     │        │       │                  │
│                                     └────────┼───────┘                  │
│                                              │                          │
│                  ┌───────────────────────────┐│                          │
│                  │     Tunnel (Cloudflare)    ││                          │
│                  │  Quick: random URL         ├┘                          │
│                  │  Named: stable FQDN        │                          │
│                  │  None:  localhost only      │                          │
│                  └────────────┬──────────────┘                          │
│                               │                                          │
│  Supporting Services:         │                                          │
│  ┌──────────────┐  ┌────────┐│  ┌───────────┐  ┌──────────────────┐    │
│  │PushManager   │  │Token   ││  │Checkpoint  │  │ConversationScanner│   │
│  │(Expo Push)   │  │Manager ││  │Manager     │  │(~/.claude/projects)│  │
│  └──────────────┘  └────────┘│  └───────────┘  └──────────────────┘    │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
│   MOBILE APP      │  │ WEB BROWSER  │  │  OTHER CLIENTS   │
│  (React Native)   │  │  (Dashboard) │  │  (test-client.js)│
│                   │  │              │  │                  │
│  Zustand Store    │  │  Vanilla JS  │  │  Node.js WS      │
│  ├ connection.ts  │  │  dashboard-  │  │                  │
│  ├ message-handler│  │  app.js      │  │                  │
│  ├ persistence.ts │  │              │  │                  │
│  └ types.ts       │  │              │  │                  │
│                   │  │              │  │                  │
│  E2E Encryption   │  │  Optional    │  │  Optional        │
│  (XSalsa20)       │  │  Encryption  │  │  Encryption      │
│                   │  │              │  │                  │
│  ConnectionPhase: │  │  Reconnect   │  │                  │
│  disconnected →   │  │  Banner      │  │                  │
│  connecting →     │  │              │  │                  │
│  connected →      │  │              │  │                  │
│  reconnecting     │  │              │  │                  │
└──────────────────┘  └──────────────┘  └──────────────────┘
```

### Message Flow: User Sends Input

```
1. User types message in app/dashboard
2. Client: { type: 'input', data: 'Build a login page', sessionId: 'abc123' }
   → Encrypt (if remote) → WebSocket → Cloudflare tunnel → Server

3. WsServer receives → decrypt → validate schema → route to handler
4. ws-message-handlers.js: find session → session.sendMessage(text)

5. SdkSession: query(Claude SDK)
   ├── emit 'stream_start' { messageId: 'msg-1' }
   ├── emit 'stream_delta' { messageId: 'msg-1', delta: 'I' }
   ├── emit 'stream_delta' { messageId: 'msg-1', delta: "'ll" }
   ├── emit 'stream_delta' { messageId: 'msg-1', delta: ' create' }
   │   ... (hundreds of deltas)
   ├── emit 'tool_start'  { tool: 'Write', input: { path: '...', content: '...' } }
   ├── emit 'tool_result' { result: 'File written' }
   ├── emit 'stream_end'  { messageId: 'msg-1' }
   └── emit 'result'      { cost: { input: 5000, output: 2000 }, duration: 12.5 }

6. SessionManager: proxy as session_event → record in ring buffer → update activity

7. EventNormalizer:
   - stream_start → { messages: [{ type: 'stream_start', messageId }] }
   - stream_delta → buffer=true → accumulate in delta buffer → flush every ~50ms
   - tool_start  → { messages: [{ type: 'tool_start', ... }] }
   - stream_end  → { sideEffects: [{ type: 'flush_deltas' }], messages: [{ type: 'stream_end' }] }
   - result      → { messages: [{ type: 'result', ... }, { type: 'agent_idle' }] }

8. WsForwarding: broadcastToSession('abc123', each_message)

9. WsServer: for each client viewing session 'abc123':
   → add seq number → encrypt (if needed) → compress (if >1KB) → ws.send()

10. Client receives:
    App: buffer deltas → flush to Zustand store every 100ms → React re-render
    Dashboard: append to DOM, auto-scroll, update status bar
```

### Message Flow: Reconnection

```
1. Connection drops (network change, sleep, tunnel restart)

2. Client detects (heartbeat pong timeout after 5s)
   → connectionPhase = 'reconnecting'

3. HTTP health check: GET https://tunnel-url/
   ├── 200 OK, { status: 'ok' }     → proceed to WebSocket
   ├── 200 OK, { status: 'restarting', restartEtaMs: 5000 } → wait, retry
   └── Error (timeout, DNS)          → exponential backoff (1s, 2s, 3s, 5s, 8s)

4. Open WebSocket → send auth → receive auth_ok

5. If remote: key_exchange → derive shared key → key_exchange_ok

6. Client: drain offline message queue (max 10, TTL-filtered)

7. Client: send list_sessions → receive session_list
   → send switch_session → receive session_switched
   → receive history_replay_start → messages (up to 500) → history_replay_end

8. Client: deduplicate replayed messages against local cache
   → connectionPhase = 'connected'
```

---

## Proposed Message Protocol for New Desktop App

### Protocol Enhancement: Differential Sync

Add these new message types to the existing protocol (backward-compatible, protocol version bump to 2):

**Client → Server (new):**

| Type | Fields | Purpose |
|------|--------|---------|
| `sync_request` | `sessionId`, `lastSeq: number` | Request messages after last-seen sequence |
| `ack` | `sessionId`, `seq: number` | Acknowledge receipt of messages up to seq |
| `subscribe_sessions` | `sessionIds: string[]` | Subscribe to multiple sessions simultaneously |

**Server → Client (new):**

| Type | Fields | Purpose |
|------|--------|---------|
| `sync_response` | `sessionId`, `fromSeq`, `messages[]`, `complete: boolean` | Differential message replay |
| `session_state_patch` | `sessionId`, `patch: object` | Partial state update (model, permission, busy, cost) |

### Protocol Enhancement: Desktop IPC Channel

For the local desktop UI, implement a parallel IPC channel that bypasses WebSocket:

```
Desktop UI (React) ←→ Tauri Command Bridge ←→ Rust Backend ←→ Node Server (stdin/stdout IPC)
```

This channel would:
- Skip JSON serialization for terminal data (pass raw bytes)
- Skip encryption (local-only)
- Skip WebSocket framing overhead
- Support direct memory sharing for large payloads (file content, diffs)

### Protocol Enhancement: Message Priority

Add a `priority` field to server-sent messages:

| Priority | Message Types | Behavior |
|----------|---------------|----------|
| `critical` | `permission_request`, `auth_fail`, `server_shutdown` | Deliver immediately, never batch |
| `high` | `stream_delta`, `stream_start/end`, `user_question` | Deliver within 50ms |
| `normal` | `message`, `tool_start/result`, `session_list` | Deliver within 200ms, batchable |
| `low` | `cost_update`, `available_models`, `mcp_servers` | Deliver within 1s, batchable |

### Protocol Enhancement: Multi-Session Subscription

Currently, clients view one session at a time. The desktop app should support viewing multiple sessions simultaneously (split-pane, tab-per-session):

```json
{ "type": "subscribe_sessions", "sessionIds": ["abc", "def", "ghi"] }
```

The server would broadcast messages for all subscribed sessions to the client, tagged with `sessionId`. The client routes messages to the appropriate pane.

### Backward Compatibility

All enhancements are additive. Existing clients (mobile app, dashboard) continue using protocol version 1. The server detects the client's protocol version from the `auth` message and adjusts its behavior:
- Protocol 1: Full history replay, single-session view, no ack
- Protocol 2: Differential sync, multi-session subscription, ack-based gap detection

---

## Appendix: Existing Desktop App (Tauri) Summary

The existing desktop app (`packages/desktop/`) is a lightweight tray app with 1,197 lines of Rust:

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Main app + tray | `src-tauri/src/lib.rs` | 452 | Tray menu, lifecycle handlers, settings |
| Server manager | `src-tauri/src/server.rs` | 369 | Child process spawn/stop, health polling |
| Node resolver | `src-tauri/src/node.rs` | 74 | Find Node 22 binary |
| Config loader | `src-tauri/src/config.rs` | 49 | Load `~/.chroxy/config.json` |
| Settings | `src-tauri/src/settings.rs` | 86 | Desktop settings persistence |
| Setup | `src-tauri/src/setup.rs` | 46 | First-run config generation |
| Window mgr | `src-tauri/src/window.rs` | 115 | Dashboard + fallback window |

**Features already implemented:**
- Tray icon with Start/Stop/Restart, Dashboard, tunnel mode, auto-start toggles
- Server process management (spawn, health poll, graceful shutdown SIGTERM→SIGKILL)
- Node 22 resolution (Homebrew, nvm, system)
- Settings persistence (`~/.chroxy/desktop-settings.json`)
- macOS autostart via LaunchAgent
- OS notifications
- Loading/fallback page during server startup
- Dashboard window (WebView → `http://localhost:{port}/dashboard`)

**The web dashboard** (`packages/server/src/dashboard/`) is a full-featured vanilla JS application (~2000 lines) with:
- Chat interface with markdown rendering
- Syntax highlighting for 16 languages (custom tokenizer)
- xterm.js terminal emulation
- Session tabs with create/rename/destroy
- Permission prompts with countdown timers
- Plan approval cards
- QR code pairing modal
- Conversation history browser
- Model and permission mode selectors
- Reconnection banner with retry
- Status bar (model, cost, context, agent badges)
- Keyboard shortcuts (Ctrl+Enter, Escape, Ctrl+N)
- localStorage message persistence
- Dark theme, responsive design

The new desktop app should build on this foundation rather than replacing it — the existing Tauri + dashboard architecture works well. Focus investment on the React UI layer, IPC optimization, and enhanced orchestration features.
