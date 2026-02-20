# Happy vs Chroxy: Competitive Architecture Comparison

This document compares the architectures of **Happy** (slopus/happy, 3k+ stars) and **Chroxy** (blamechris/chroxy) — both open-source Claude Code mobile clients with fundamentally different connectivity models.

**Purpose:** Serve as the factual basis for a 10-agent swarm-audit to determine what Chroxy should adopt, whether to add relay mode, and produce an actionable roadmap.

---

## 1. Architecture Topology

### Chroxy: Direct Tunnel Model

```
Phone ──WebSocket──▶ Cloudflare Edge ──tunnel──▶ Dev Machine (server)
                                                    └── Claude Code process
```

- **Phone connects outbound** to Cloudflare edge
- **Dev machine runs cloudflared** (tunnel daemon) connecting outbound to Cloudflare
- Cloudflare stitches both connections at the edge — no inbound ports needed
- Two tunnel modes: Quick (random URL, ephemeral) and Named (stable DNS, requires account + domain)
- Each user runs their own server + tunnel — fully decentralized
- Server is an HTTP server with WebSocket upgrade (`ws-server.js`)

**Key files:** `packages/server/src/ws-server.js`, `packages/server/src/tunnel/registry.js`

### Happy: Centralized Relay Model

```
Phone ──Socket.IO──▶ Relay Server (happy.engineering) ◀──Socket.IO── Dev Machine (CLI)
                            │
                     Postgres / Redis / S3
```

- **Both phone and dev machine connect outbound** to a centralized relay
- Relay persists all state in Postgres — survives full disconnects
- Official SaaS at `app.happy.engineering` or self-hostable (`packages/happy-server`)
- Server stack: Node.js + Fastify (HTTP) + Socket.IO (real-time) + Postgres (Prisma) + Redis + S3 (MinIO)
- Connection scopes: `user-scoped`, `session-scoped`, `machine-scoped`

**Key repos:** `slopus/happy-server`, `slopus/happy-cli`

### Topology Comparison

| Aspect | Chroxy (Tunnel) | Happy (Relay) |
|--------|----------------|---------------|
| Data path | Phone → Edge → Tunnel → Server | Phone → Relay ← CLI |
| Infrastructure owner | User (Cloudflare tunnel) | SaaS or self-hosted relay |
| NAT traversal | Cloudflare handles it | Outbound-only connections |
| Single point of failure | Cloudflare edge | Relay server |
| Multi-user | One tunnel per user | One relay serves all users |
| Offline resilience | None (tunnel must be up) | Relay persists state in Postgres |
| Setup friction | `brew install cloudflared` + account for Named | None for SaaS; Postgres+Redis+S3 for self-host |

---

## 2. Wire Protocol

### Chroxy: Custom WebSocket JSON

Chroxy uses a **flat JSON WebSocket protocol** with 50+ client→server and 60+ server→client message types. Every message is `{type: string, ...payload}`.

**Client → Server messages:**
- `auth` — Token authentication with optional `deviceInfo`
- `input` — Send text + optional base64 attachments (images ≤2MB, docs ≤5MB, max 5)
- `interrupt` — Cancel active generation
- `set_model` / `set_permission_mode` — Runtime config changes
- `permission_response` / `user_question_response` — Interactive prompt replies
- `list_sessions` / `create_session` / `switch_session` / `destroy_session` / `rename_session` — Session management
- `register_push_token` — Expo push notification registration
- `key_exchange` — X25519 public key for E2E encryption
- `list_directory` / `browse_files` / `read_file` — File browser
- `list_slash_commands` / `list_agents` — Introspection
- `request_full_history` — JSONL export for portability

**Server → Client messages:**
- `auth_ok` — Success with `encryption: 'required'|'disabled'`, `clientId`, `connectedClients`
- `stream_start` / `stream_delta` / `stream_end` — Token-by-token streaming
- `message` — Discrete chat message with `messageType` (response/tool_use/thinking/user_input)
- `tool_start` / `tool_result` — Tool invocation lifecycle
- `result` — Turn completion with `usage` (tokens), `cost`, `duration`
- `status_update` — Context window: `contextTokens`, `contextPercent`, `cost`, `model`
- `permission_request` — Tool permission prompt with `tool`, `input`
- `user_question` — AskUserQuestion with options array
- `agent_spawned` / `agent_completed` — Background agent lifecycle
- `plan_started` / `plan_ready` — Plan mode events
- `model_changed` / `available_models` — Model switching
- `session_list` / `session_switched` / `session_created` / `session_destroyed` — Session lifecycle
- `client_joined` / `client_left` / `primary_changed` — Multi-client awareness
- `server_error` / `server_status` / `server_shutdown` — Server lifecycle
- `encrypted` — E2E encrypted envelope `{type: 'encrypted', d: base64, n: nonce_counter}`
- `history_replay_start` / `history_replay_end` — Reconnect history sync
- `raw` / `raw_background` — Terminal ANSI output (PTY mode)

**Key implementation detail:** No sequence numbers. Relies on TCP ordering within a single WebSocket connection. Reconnect replays last response + in-progress state from server-side ring buffer (100 messages max).

### Happy: HTTP + Socket.IO with Zod Schemas

Happy uses a **dual-transport protocol**: HTTP REST for CRUD, Socket.IO for real-time sync.

**HTTP API (`/v1`, `/v2` routes):**
- CRUD for sessions, messages, machines, artifacts, accounts
- Query by sequence number for catch-up
- Optimistic concurrency with `expectedVersion` fields

**Socket.IO (`/v1/updates`):**
- `update` events: `{ id, seq, body: { t: "event-type", ... }, createdAt }`
- `ephemeral` events: Transient presence/activity (no persistence)
- `message` — Emit encrypted message to session
- `rpc-call` / `rpc-register` — Remote procedure calls to daemon
- `session-alive` / `machine-alive` — Heartbeats

**Event types (discriminated by `t` field):**
- `new-session` / `update-session` / `delete-session`
- `new-message` / `new-machine` / `update-machine`
- `new-artifact` / `update-artifact`
- `activity` / `machine-activity` / `usage` (ephemeral)

**Session Protocol (9 standardized event types for all providers):**
- `text` — Streamed text content
- `service` — System/status messages
- `tool-call-start` / `tool-call-end` — Tool lifecycle
- `file` — File references
- `turn-start` / `turn-end` — Conversation turn boundaries
- `start` / `stop` — Session lifecycle

**Key implementation detail:** All schemas validated with Zod. Types generated from schema. Supports both WebSocket and HTTP long-polling fallback.

### Protocol Comparison

| Aspect | Chroxy | Happy |
|--------|--------|-------|
| Transport | WebSocket only | HTTP REST + Socket.IO (WS + polling) |
| Schema validation | Runtime type checks | Zod schemas (compile-time + runtime) |
| Message count | ~110 types | ~20 event types + REST endpoints |
| Streaming | `stream_start/delta/end` (token-level) | Session Protocol `text` events |
| Ordering guarantee | TCP (single connection) | Monotonic sequence numbers |
| Fallback transport | None | HTTP long-polling |

---

## 3. Message Ordering & Reliability

### Chroxy: TCP-Ordered, No Sequences

- Relies on WebSocket (TCP) ordering within a single connection
- No sequence numbers — if a message is lost, it's gone
- Reconnect strategy: Server replays last response + in-progress work from ring buffer
- Ring buffer: 100 messages max per session, 50KB content truncation
- Stream delta dedup: `didStreamText` flag prevents `assistant`/`content_block_stop` duplicates
- History replay flags: `_receivingHistoryReplay`, `_isSessionSwitchReplay` prevent duplicate message additions
- Disconnected message queue: 10 messages max with TTLs (input: 60s, interrupt: 5s, permission: 300s)

**Limitation:** If the WebSocket drops mid-stream and reconnects, the client may miss intermediate deltas. The server replays the accumulated state, but partial tool results or streaming context can be lost.

### Happy: Monotonic Sequences with Gap Detection

- **Per-user monotonic sequence** (`Account.seq`): Strict ordering of all persistent updates
- **Per-session sequence** (`SessionMessage.seq`): Ordering within a session
- Clients track `lastSeq` and request catch-up on reconnect
- Gap detection: If `received.seq > expected.seq + 1`, client triggers resync via HTTP
- All persistent events stored in Postgres with sequence numbers
- Ephemeral events (activity, presence) have no sequences — fire-and-forget

**Key advantage:** No message loss. Client can always catch up by querying `GET /v1/updates?since=lastSeq`. Even if both client and server restart, Postgres has the full history.

### Reliability Comparison

| Scenario | Chroxy | Happy |
|----------|--------|-------|
| Clean reconnect | Replays last response from ring buffer | Catches up via `lastSeq` |
| Server crash + restart | Loses in-memory ring buffer | Full history in Postgres |
| Client reconnect after 1 hour | May miss intermediate state | Full catch-up via sequences |
| Split-brain (2 clients) | Last-writer-wins per session | Sequence-ordered, all clients consistent |
| Network partition | Queues up to 10 messages with TTLs | Persists all events, syncs on reconnect |

---

## 4. Multi-Provider Support

### Chroxy: Provider Registry (2 Providers)

```javascript
// packages/server/src/providers.js
registerProvider('claude-cli', CliSession)   // Legacy: claude -p subprocess
registerProvider('claude-sdk', SdkSession)   // Default: Claude Agent SDK

// Provider capabilities object:
{
  permissions: boolean,           // Supports permission handling
  inProcessPermissions: boolean,  // Handles permissions without HTTP hook
  modelSwitch: boolean,           // Live model switching
  permissionModeSwitch: boolean,  // Live permission mode switching
  planMode: boolean,              // Emits plan mode events
  resume: boolean,                // Conversation portability
  terminal: boolean,              // Raw terminal output
}
```

- Registry pattern with `registerProvider(name, Class)` / `getProvider(name)` / `listProviders()`
- Provider must extend EventEmitter, implement `start()`, `destroy()`, `sendMessage()`, `setModel()`, `setPermissionMode()`
- Capabilities advertised to clients for feature negotiation
- Both providers are Claude-only

### Happy: AgentBackend (4+ Providers)

```
packages/happy-cli/src/
  claude/    → Claude Code via SDK or claude -p
  codex/     → OpenAI Codex CLI
  gemini/    → Google Gemini (ACP-based)
  acp/       → Generic Agent Communication Protocol
```

- CLI routes to provider-specific subcommands: `happy`, `codex`, `gemini`, `acp`
- Unified **Session Protocol** (9 event types) abstracts provider differences
- Deduplication strategies differ by provider:
  - Local: UUID-based + SessionScanner marks processed messages
  - Remote: Ordered live streaming with lifecycle boundaries
- Subagent tracking via `providerSubagentToSessionSubagent` mapping

### Provider Comparison

| Aspect | Chroxy | Happy |
|--------|--------|-------|
| Provider count | 2 (both Claude) | 4+ (Claude, Codex, Gemini, ACP) |
| Abstraction | EventEmitter + capabilities | Session Protocol (9 types) |
| Adding a provider | Implement JS class, register | Implement session-protocol adapter |
| Feature negotiation | Capabilities object per provider | Standardized event types |
| Provider switching | Not supported | Different CLI subcommands |

---

## 5. Tunnel / Connectivity

### Chroxy: Cloudflare Tunnel Adapter Registry

```javascript
// packages/server/src/tunnel/registry.js
registerTunnel('cloudflare', CloudflareTunnel)

// Tunnel argument parsing:
// 'quick' → {provider: 'cloudflare', mode: 'quick'}
// 'named' → {provider: 'cloudflare', mode: 'named'}
// 'none' → null
// 'ngrok' → {provider: 'ngrok', mode: 'default'}
```

- **Quick Tunnel** (default): `cloudflared tunnel --url http://localhost:PORT` — random URL, zero config
- **Named Tunnel**: `cloudflared tunnel run <name>` — stable DNS via CNAME, requires Cloudflare account
- Tunnel health check: Server pings its own tunnel URL before displaying QR code
- Tunnel crash auto-recovery via `_handleUnexpectedExit()` in `BaseTunnelAdapter`
- Supervisor (named tunnel mode): Owns tunnel process, restarts server child on crash
- Extensible for ngrok or custom providers via registry

**Dependencies:** `brew install cloudflared` (mandatory)

### Happy: No Tunnel Needed (Relay Model)

- Both clients (phone + CLI) connect outbound to relay server
- No per-user tunnel infrastructure
- Fixed relay URL (`app.happy.engineering`) or self-hosted
- Socket.IO with WebSocket + HTTP polling fallback
- Bearer token authentication cached in-memory
- Connection scopes enable targeted message delivery

**Self-hosting requirements:** Postgres, Redis, S3-compatible storage, Node.js server

### Connectivity Comparison

| Aspect | Chroxy (Tunnel) | Happy (Relay) |
|--------|----------------|---------------|
| Setup for user | `brew install cloudflared` | None (SaaS) or deploy full stack |
| NAT traversal | Cloudflare handles | Outbound-only (relay) |
| WiFi→cellular handoff | Tunnel persists, WS reconnects | Socket.IO reconnects + seq catch-up |
| Latency (typical) | Phone→Edge→Tunnel→Local (~50-100ms) | Phone→Relay→CLI (~50-200ms depending on relay location) |
| Bandwidth cost | Free (Cloudflare Quick) | Relay operator pays |
| Privacy | Data never leaves Cloudflare + your machine | Data transits relay (encrypted) |
| Offline dev machine | Connection fails | Relay persists state, syncs when back |

---

## 6. Event Architecture

### Chroxy: EventEmitter + Transient Events

```javascript
// Session events (packages/server/src/session-manager.js)
const RECORDED_EVENTS = [
  'stream_start', 'stream_delta', 'stream_end',
  'message', 'tool_start', 'tool_result', 'result', 'user_question'
]

const TRANSIENT_EVENTS = [
  'permission_request', 'agent_spawned', 'agent_completed',
  'plan_started', 'plan_ready'
]
```

- Events emitted via Node.js EventEmitter on session instances
- SessionManager records events into ring buffer (100 entries, 50KB truncation per field)
- Transient events are NOT replayed on reconnect — only recent recorded history
- Stream deltas accumulated: pending streams map `sessionId:messageId → accumulated_delta`
- Debounced persistence to `~/.chroxy/session-state.json` (5s debounce, 24h TTL)

### Happy: Persistent/Ephemeral Event Split

```
Persistent Updates (Postgres, sequence-numbered):
  - new-session, update-session, delete-session
  - new-message (content stored as encrypted blob)
  - new-machine, update-machine
  - new-artifact, update-artifact
  - account changes, feed updates

Ephemeral Events (in-memory, no persistence):
  - activity, machine-activity, usage
  - presence indicators
  - Debounced in-memory before batch-writing
```

- Every persistent update gets a monotonic `seq` within the user's account
- EventRouter distributes to all connected clients for a given scope
- Session Protocol events (9 types) standardize provider output:
  - `text`, `service`, `tool-call-start`, `tool-call-end`, `file`
  - `turn-start`, `turn-end`, `start`, `stop`
- Every event envelope: `{ id: cuid2, time, role, turn, subagent, body: { t: discriminator, ... } }`

### Event Architecture Comparison

| Aspect | Chroxy | Happy |
|--------|--------|-------|
| Persistence | Ring buffer (100 entries, in-memory + JSON file) | Postgres (unlimited, indexed by seq) |
| Event categorization | Recorded vs Transient (2 lists) | Persistent vs Ephemeral (schema-level) |
| Replay mechanism | Last response + in-progress from ring buffer | Full history via seq-based catch-up |
| Event envelope | `{type, ...flat_fields}` | `{id, seq, body: {t, ...}, createdAt}` |
| Schema enforcement | Runtime type checks | Zod validation |

---

## 7. Encryption

### Chroxy: NaCl ECDH with Counter Nonces

```javascript
// packages/server/src/crypto.js
createKeyPair()           // → {publicKey: base64, secretKey: Uint8Array}
deriveSharedKey(pub, sec)  // → Uint8Array (32 bytes)
encrypt(json, key, counter, direction) // → {type: 'encrypted', d: base64, n: counter}
decrypt(envelope, key, nonce, direction) // → parsed JSON

// Nonce construction (24 bytes):
// Byte 0: Direction (0x00 = server, 0x01 = client)
// Bytes 1-8: Counter (little-endian uint64)
// Bytes 9-23: Padding (zeros)
```

- **Key exchange:** Curve25519 (X25519) via `tweetnacl`
- **Symmetric encryption:** XSalsa20-Poly1305 via `nacl.secretbox`
- **Handshake flow:**
  1. `auth_ok` with `encryption: 'required'`
  2. Client generates keypair, sends `key_exchange` (plaintext)
  3. Server responds `key_exchange_ok` (plaintext)
  4. Both derive shared key from ECDH
  5. All subsequent messages wrapped in `{type: 'encrypted', d, n}`
- Direction byte prevents nonce reuse across send/receive
- Counter validated: exact match required (replay detection)
- Optional: `--no-encrypt` disables (for debugging)

### Happy: Dual Encryption (NaCl + AES-256-GCM)

**Client-side E2E (server sees only opaque blobs):**

```
Legacy variant (NaCl secretbox):
  - XSalsa20-Poly1305, 24-byte nonce, 32-byte key
  - Binary layout: nonce + ciphertext + auth tag

DataKey variant (AES-256-GCM):
  - 12-byte nonce, 16-byte auth tag
  - Binary layout: version_byte + nonce + ciphertext + auth tag
  - DataKey itself wrapped via tweetnacl.box with ephemeral keypair
```

**Encrypted fields:**
- Session metadata, agent state, messages, machine metadata
- Daemon state, artifact headers/bodies, KV store values, access keys

**Server-side encryption (separate, NOT E2E):**
- Third-party tokens (GitHub OAuth, vendor tokens) encrypted with `HANDY_MASTER_SECRET` via KeyTree
- Server can decrypt integration tokens but NEVER user content

**Authentication:**
- Public key challenge-response (no passwords)
- Server upserts account by public key
- Returns Bearer token (cached in-memory)

### Encryption Comparison

| Aspect | Chroxy | Happy |
|--------|--------|-------|
| Key exchange | X25519 ECDH per connection | Public key challenge-response per account |
| Symmetric cipher | XSalsa20-Poly1305 | XSalsa20-Poly1305 OR AES-256-GCM |
| Nonce management | Direction byte + counter | Per-message random (legacy) or structured |
| What's encrypted | All WS messages after handshake | Content fields in DB (server-blind) |
| Key lifetime | Per WebSocket connection | Per account (long-lived) |
| Server visibility | Server decrypts (pre-tunnel) | Server never decrypts user content |
| Replay protection | Counter validation | Database uniqueness constraints |
| Authentication | Bearer token from QR code | Public key signature challenge |

**Critical difference:** In Chroxy, the server decrypts messages before routing to Claude Code — encryption is point-to-point (phone→server). In Happy, the server stores encrypted blobs and never sees plaintext — encryption is true E2E (phone→CLI via relay).

---

## 8. Session & State Management

### Chroxy: In-Memory + JSON Persistence

```javascript
// packages/server/src/session-manager.js
{
  session,              // CliSession or PtySession instance
  type: 'cli'|'pty',
  name: string,
  cwd: string,
  createdAt: number,
  tmuxSession?: string  // PTY mode only
}

// Persisted to ~/.chroxy/session-state.json
{
  version: 1,
  timestamp: Date.now(),
  sessions: [{
    sdkSessionId, conversationId, cwd, model,
    permissionMode, name, history: [{...truncated}]
  }]
}
```

- Multi-session limit: configurable (default 5)
- Ring buffer: 100 messages per session
- Persistence: 5s debounce, 24h TTL, atomic write (`.tmp` → rename)
- Content/input truncation at 50KB per field
- Auto-discovery: Polls for tmux sessions every 45s
- Resume: `resumeSessionId` passed to provider for conversation portability
- **App state:** Zustand store with per-session `SessionState` objects

### Happy: Postgres + Redis + S3

```
Prisma Schema:
  Account: id, publicKey, seq (monotonic), settings
  Session: id (cuid), accountId, lastActiveAt, active, metadata (encrypted),
           agentState (encrypted), dataEncryptionKey, tag (unique per account)
  SessionMessage: id (cuid), sessionId, seq (monotonic), localId, content (JSON)
  Machine: id, accountId, metadata (encrypted), daemonState (encrypted),
           dataEncryptionKey, lastActiveAt, active
  AccessKey: session-specific machine credentials
  Artifact: versioned encrypted blobs
```

- All state persisted in Postgres — survives server restarts
- Redis for caching and message broker (pub/sub)
- S3 for large artifacts and file storage
- Activity tracking: `lastActiveAt` timestamps, 10-min inactivity → offline
- Local CLI state: `~/.happy/settings.json`, `access.key`, `daemon.state.json`

### State Management Comparison

| Aspect | Chroxy | Happy |
|--------|--------|-------|
| Server state | In-memory + JSON file | Postgres + Redis |
| Persistence | 24h TTL, 100-message ring buffer | Unlimited (database) |
| Client state | Zustand (React Native) | React state (web/mobile) |
| Session recovery | JSON file + provider resumeSessionId | Full DB restore + seq catch-up |
| Multi-device sync | WebSocket broadcast (real-time only) | DB + seq (survives full disconnects) |
| Scalability | Single-process | Horizontally scalable (stateless relay) |
| Blob storage | None | S3-compatible |

---

## 9. RPC / Remote Operations

### Chroxy: No General RPC

Chroxy has **no RPC subsystem**. The server runs Claude Code directly, so remote file/bash operations aren't needed — Claude does them locally.

**What exists instead:**
- File browser: `list_directory` / `browse_files` / `read_file` — read-only filesystem access
- Slash commands: `list_slash_commands` / `list_agents` — introspection only
- All modifications happen through Claude Code tool use (Write, Edit, Bash tools)

### Happy: Socket.IO RPC Bridge

Happy provides **RPC tunneling** from app→relay→CLI for direct remote operations:

```
RPC Surface:
  - rpc-call: Forward call to session/daemon
  - rpc-register: Register RPC handlers on daemon/session

Available Operations:
  - bash: Execute shell commands
  - file ops: Read, write, directory traversal
  - ripgrep: Full-text search
  - difftastic: File comparison
```

- RPC calls flow through Socket.IO (encrypted in-transit)
- Daemon spawns sessions that expose controlled RPC surface
- Permission modes gate what's allowed (yolo, safe-yolo, read-only, default, plan, acceptEdits, bypassPermissions)
- Sessions can originate from CLI (direct), daemon (background), or remote (RPC)

### RPC Comparison

| Aspect | Chroxy | Happy |
|--------|--------|-------|
| Direct shell access | No (Claude runs commands) | Yes (bash RPC) |
| File operations | Read-only browser | Full read/write via RPC |
| Search | Via Claude tools | Ripgrep RPC |
| Security model | All ops through Claude (audited) | Permission-gated RPC |
| Attack surface | Minimal (read-only + Claude) | Larger (direct bash, file write) |

---

## 10. Feature Matrix

| Feature | Chroxy | Happy |
|---------|--------|-------|
| **Mobile app** | React Native (Expo 54, TypeScript) | React Native (Expo) |
| **Web app** | No | Yes |
| **Desktop app** | No (server CLI only) | No (CLI only) |
| **AI providers** | Claude Code only (2 backends) | Claude, Codex, Gemini, ACP (4+) |
| **Connectivity** | Cloudflare tunnel (Quick/Named) | Centralized relay (SaaS or self-host) |
| **E2E encryption** | X25519 + XSalsa20-Poly1305 | NaCl OR AES-256-GCM (true E2E) |
| **Message ordering** | TCP (no sequences) | Monotonic per-user sequences |
| **Offline resilience** | None (tunnel must be up) | Relay persists all state |
| **Session persistence** | JSON file (24h TTL, 100 msgs) | Postgres (unlimited) |
| **Terminal emulation** | xterm.js in WebView (full VT100) | Unknown/not documented |
| **Chat UI** | Markdown, tool bubbles, plan approval | Structured session protocol events |
| **Streaming** | Token-level deltas | Session protocol text events |
| **Permission handling** | 4 modes + push notifications | 7 modes with state hierarchy |
| **Plan mode** | Native UI (EnterPlanMode/ExitPlanMode) | Not documented |
| **Background agents** | Spawned/completed tracking + badge | Subagent lifecycle tracking |
| **Voice input** | expo-speech-recognition | ElevenLabs integration |
| **File browser** | Read-only (list, browse, read) | Full RPC (read, write, search) |
| **File attachments** | Images (≤2MB) + docs (≤5MB) | Upload-first, then reference |
| **Push notifications** | Expo Push API (permission + idle) | Push notifications |
| **Multi-client** | clientId + connectedClients tracking | Machine-scoped connections |
| **Model switching** | Live via WS message | Provider-specific |
| **Context tracking** | Tokens + percent + cost display | Not documented |
| **Session management** | Multi-session (create/switch/destroy) | Session CRUD via API |
| **Auto-discovery** | tmux session polling (45s) | Machine registration |
| **Supervisor** | Auto-restart with backoff (named tunnel) | Daemon process management |
| **Self-hostable** | Yes (fully) | Yes (relay server is open-source) |
| **Auth model** | QR code with bearer token | Public key challenge-response |
| **Protocol schema** | Runtime type checks | Zod (compile-time + runtime) |
| **Artifact storage** | None | S3-compatible with versioning |
| **GitHub integration** | None | OAuth for repo cloning |
| **Metrics** | None | Prometheus endpoint |

---

## Audit Questions for Agents

Based on this comparison, the swarm-audit should address:

1. **Should Chroxy add a relay mode?** What are the tradeoffs of tunnel-only vs offering an optional relay?
2. **Should Chroxy adopt sequence numbers?** The current TCP-ordering approach works for single connections but limits offline resilience.
3. **Should Chroxy add multi-provider support?** Happy's Session Protocol abstraction is elegant. Is it worth the complexity for Chroxy?
4. **Is Happy's "true E2E" encryption meaningfully better?** Chroxy's server decrypts before routing to Claude — is this a real security gap?
5. **Should Chroxy add RPC?** Direct bash/file access from phone vs. routing everything through Claude.
6. **What's the right persistence strategy?** Ring buffer + JSON vs. database-backed state.
7. **Should Chroxy adopt Zod schemas?** Runtime type checking vs. schema validation.
8. **What should the 30-60-90 day roadmap prioritize?** Given limited resources, which Happy features have the highest impact/effort ratio?

---

*Sources: Happy GitHub (slopus/happy, slopus/happy-server, slopus/happy-cli), Happy docs (protocol.md, backend-architecture.md, encryption.md, session-protocol.md, happy-wire.md, permission-resolution.md), Chroxy source code*
