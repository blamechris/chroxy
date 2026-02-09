# In-App Iterative Development Architecture

> Design document for self-updating Chroxy from within the app itself.
> Synthesized from 6 specialized agent analyses (System Architecture, Mobile App Updates, Server Migration, Connection Persistence, Build Pipeline, Safety & Reliability).

**Version:** 0.1.0-draft
**Date:** 2026-02-09
**Status:** Design Phase

---

## Table of Contents

1. [Vision & Problem Statement](#1-vision--problem-statement)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Supervisor Process](#3-supervisor-process)
4. [Server Self-Update](#4-server-self-update)
5. [Connection Persistence](#5-connection-persistence)
6. [Mobile App Updates](#6-mobile-app-updates)
7. [Build & Deploy Pipeline](#7-build--deploy-pipeline)
8. [Safety & Reliability](#8-safety--reliability)
9. [WebSocket Protocol Extensions](#9-websocket-protocol-extensions)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Vision & Problem Statement

### The Goal

Iterate on Chroxy from within Chroxy itself. Connect from your phone, tell Claude Code to modify the server or app, have changes deploy automatically, and continue working -- no QR re-scan, no SSH, no manual restarts.

### The Core Challenges

1. **Chicken-and-Egg**: The server must update itself while serving the client requesting the update
2. **Tunnel Instability**: Cloudflare Quick Tunnels generate random URLs on every restart -- the phone loses its connection endpoint
3. **Session Loss**: Claude Code runs as a child of the server process -- when the server dies, the conversation dies
4. **App Updates**: React Native apps on a phone can't hot-reload over a Cloudflare tunnel
5. **Safety**: A bad self-update can brick the only interface the user has

### The Solution in One Sentence

A lightweight **supervisor process** owns the tunnel and manages the server as a restartable child, while **Named Tunnels** provide a stable URL and **expo-updates** enables OTA app updates served from the Chroxy server itself.

---

## 2. System Architecture Overview

### Current Architecture (v0.1.0)

```
[Mobile App] <--WSS--> [Cloudflare Quick Tunnel] <--> [Server Process]
                        (random URL each time)          ├── WsServer
                                                        ├── TunnelManager
                                                        ├── SessionManager
                                                        │   └── CliSession(s)
                                                        │       └── claude -p (child)
                                                        └── (everything dies together)
```

**Problems**: Server restart = new tunnel URL = re-scan QR. Claude session lost. No rollback.

### Target Architecture (v0.2.0)

```
                    SUPERVISOR PROCESS (~100 LOC, never self-updates)
                   +--------------------------------------------------+
                   |                                                    |
[Mobile App] <--WSS--> [Cloudflare Named Tunnel] <--> localhost:8765   |
                   |     (stable URL, survives restarts)     |          |
                   |                                         |          |
                   |   IPC channel (lifecycle signals)       |          |
                   |         |                               |          |
                   +---------+-------------------------------+----------+
                             |
                   +---------v----------------------------------+
                   |   SERVER CHILD PROCESS (restartable)       |
                   |                                            |
                   |  [WsServer :8765]                          |
                   |       |                                    |
                   |  [SessionManager]                          |
                   |       |                                    |
                   |  [CliSession(s)]                           |
                   |       |                                    |
                   |  [claude -p ... cwd=chroxy/]               |
                   +--------------------------------------------+
```

**Key property**: The tunnel URL never changes during a restart cycle. The supervisor owns `cloudflared`, the server is a restartable child. The app's saved connection stays valid.

### The Self-Update Loop

```
1. User sends instruction via app ("Fix the bug in tunnel.js")
2. Claude Code modifies files in the Chroxy repo
3. User (or Claude) runs: npx chroxy deploy
4. Deploy script validates code (node --check, tests)
5. Deploy script signals supervisor via IPC
6. Supervisor sends server_restarting to app via WS
7. Supervisor SIGTERMs old server, waits for exit
8. Supervisor spawns new server on same port (:8765)
9. Health check passes -> app auto-reconnects through same tunnel URL
10. Session restored, user continues working
```

---

## 3. Supervisor Process

### Design Principles

The supervisor is the **immovable foundation** of the self-update system. It must be:

- **Trivially simple**: ~100 lines, pure Node.js, zero npm dependencies
- **Never self-updated**: Lives at `~/.chroxy/supervisor.js`, copied once during `chroxy init`
- **Robust**: Only does three things: spawn server, watch for exit, optionally restart

### Responsibilities

| Concern | Owner |
|---------|-------|
| Spawn `cloudflared` tunnel | Supervisor |
| Spawn Chroxy server as child | Supervisor |
| Forward SIGTERM/SIGINT to child | Supervisor |
| Restart server on IPC request | Supervisor |
| Rollback on crash (3 failures in 5min) | Supervisor |
| Write `~/.chroxy/supervisor-state.json` | Supervisor |
| Display QR code (owns terminal output) | Supervisor |
| All business logic | Server child |

### Startup Sequence

```
1. Read ~/.chroxy/config.json
2. Spawn cloudflared tunnel --url http://localhost:8765 [named or quick]
3. Wait for tunnel URL
4. Fork child: node packages/server/src/server-cli.js --supervised --tunnel-url=<url>
5. Display QR code (first time only)
6. Enter event loop: listen for IPC messages from child
```

### IPC Protocol

```
Child -> Supervisor:
  { type: 'ready', port: 8765 }          -- server is listening
  { type: 'restart', snapshot: {...} }    -- request restart with state

Supervisor -> Child:
  { type: 'tunnel_url', wsUrl, httpUrl }  -- tunnel established
  { type: 'prepare_shutdown', timeout: 30000 }  -- begin drain
  { type: 'shutdown_now' }                -- SIGTERM imminent
```

### server-cli.js Changes

When `--supervised` flag is present:
- Skip TunnelManager creation (supervisor owns the tunnel)
- Skip QR code display (supervisor owns terminal)
- Skip SIGINT/SIGTERM handlers (supervisor handles signals)
- Listen for IPC messages from parent process
- Use tunnel URL provided via IPC

### Supervisor Self-Update

Rare but possible. When Claude modifies `supervisor.js`:
1. Supervisor writes a restart sentinel to `~/.chroxy/.restart-supervisor`
2. Supervisor spawns a **new** supervisor process
3. Old supervisor exits
4. New supervisor detects sentinel, cleans up, continues

The tunnel URL will change (new cloudflared instance). This is acceptable because supervisor updates should be extremely rare.

### CLI Integration

```bash
# New command that launches supervisor instead of server directly
npx chroxy dev

# Equivalent to current behavior (no supervisor, backwards compatible)
npx chroxy start
```

---

## 4. Server Self-Update

### State Machine

```
                     +--------+
                     |  IDLE  |<------------------------------------------+
                     +---+----+                                           |
                         |                                                |
                    restart_request                                       |
                         |                                                |
                    +----v-----+                                          |
                    | DRAINING |  Wait for in-flight CliSession           |
                    +----+-----+  messages to complete (max 30s)          |
                         |                                                |
                   +-----v-------+                                        |
                   | VALIDATING  |  node --check on changed files         |
                   +-----+-------+  git status must be clean              |
                         |                                                |
               +---------+---------+                                      |
               |                   |                                      |
          validation OK       validation FAILED                           |
               |                   |                                      |
        +------v------+    +------v------+                                |
        |  STOPPING   |    |  ABORTED    |--- broadcast error ---------->+
        +------+------+    +-------------+
               |
          SIGTERM to child, wait for exit
               |
        +------v------+
        | RESTARTING  |  spawn new server child on same port
        +------+------+
               |
        +------v------+
        | VERIFYING   |  GET http://localhost:8765/health
        +------+------+  retry 5x, 1s interval
               |
         +-----+------+
         |            |
     health OK    health FAILED
         |            |
   +-----v----+  +----v------+
   |  READY   |  | ROLLBACK  |  kill bad child, git checkout known-good
   +-----+----+  +----+------+  respawn previous version
         |            |
         +-----+------+
               |
         broadcast restart_complete (or restart_failed)
               |
               v
            [IDLE]
```

### Claude Code Session Preservation

The Claude process is a child of the server -- it dies on restart. The solution uses `--resume`:

1. Before drain, each `CliSession` records its `_sessionId` (from `system.init` event)
2. Session metadata written to `~/.chroxy/session-state.json`:
   ```json
   {
     "sessions": [
       {
         "chroxyId": "a1b2c3d4",
         "claudeSessionId": "sess_abc123",
         "cwd": "/home/user/project",
         "model": "claude-sonnet-4-20250514",
         "name": "Default"
       }
     ]
   }
   ```
3. Old server kills Claude processes during drain
4. New server reads state file, spawns Claude with `--resume <session_id>`
5. Claude Code's internal checkpointing (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`) preserves conversation

**Graceful degradation**: If `--resume` fails, fall back to fresh session. App-side message history is preserved via existing `isReconnect` logic in `connection.ts`.

### Version Tracking

**Build manifest** generated at deploy time (`~/.chroxy/deploy-manifest.json`):
```json
{
  "version": "0.1.0",
  "gitCommit": "abc1234",
  "gitBranch": "feat/dark-mode",
  "buildDate": "2026-02-09T12:00:00Z",
  "deploys": [
    {
      "id": "deploy-001",
      "timestamp": "2026-02-09T12:34:56Z",
      "gitHash": "abc1234",
      "changedPackages": ["server"],
      "status": "success",
      "rollbackHash": "def5678"
    }
  ]
}
```

**Version HTTP endpoint** (`GET /version`):
```json
{
  "version": "0.1.0",
  "gitCommit": "abc1234",
  "gitBranch": "feat/dark-mode",
  "buildDate": "2026-02-09T12:00:00Z",
  "uptime": 3600
}
```

**`auth_ok` extension**: Add `serverCommit` field alongside existing `serverVersion`.

---

## 5. Connection Persistence

### The Core Problem

Cloudflare Quick Tunnels generate a random `*.trycloudflare.com` URL on every `cloudflared` invocation. Every server restart = new URL = QR re-scan. This is the single biggest UX pain point.

### Solution: Named Tunnels (Recommended)

**One-time setup** (~2 minutes):
```bash
npx chroxy tunnel setup
# Runs: cloudflared tunnel login (opens browser)
# Runs: cloudflared tunnel create chroxy
# Saves credentials to ~/.cloudflared/<uuid>.json
# Updates ~/.chroxy/config.json
# Result: Persistent URL like abc123.cfargotunnel.com
```

**Comparison**:

| Factor | Quick Tunnel (current) | Named Tunnel | Custom Domain |
|--------|:---:|:---:|:---:|
| URL stability | New every restart | Persistent | Persistent |
| Setup time | 0 | 2 min | 10+ min |
| Account needed | No | Free CF acct | CF acct + domain |
| Reconnect works | Never | Always | Always |

**Strategy**: Default to Quick Tunnels (zero friction onboarding). Offer Named Tunnels as opt-in via `chroxy tunnel setup`. Auto-detect which mode based on config.

### TunnelManager Changes

```javascript
// New constructor options
constructor({ port, mode = 'auto', tunnelName, credentialsFile, knownUrl })

// Named tunnel spawn (different from quick tunnel)
const argv = [
  "tunnel", "run",
  "--url", `http://localhost:${this.port}`,
  "--credentials-file", this.credentialsFile,
  this.tunnelName
]
```

For Named Tunnels, the URL is known ahead of time (deterministic from tunnel config). No need to parse stderr for URLs. The `tunnel_url_changed` event never fires.

### Reconnection State Machine

Replace boolean `isConnected`/`isReconnecting` with a `connectionPhase` enum:

```typescript
type ConnectionPhase =
  | 'initial'          // No connection attempt
  | 'connecting'       // First connection in progress
  | 'connected'        // WebSocket open and authenticated
  | 'server_updating'  // Close code 4000, fast retry (500ms, 1s, 2s)
  | 'reconnecting'     // Abnormal close, exp. backoff (2s, 4s, 8s, 16s, 32s)
  | 'slow_polling'     // Backoff exhausted, 60s health checks
  | 'dormant'          // Polling exhausted (5min), "Tap to reconnect"
  | 'failed'           // Auth failed or max retries on first connect
  | 'disconnected'     // User-initiated disconnect
```

**Navigation guard change**: Keep user on SessionScreen during `server_updating`, `reconnecting`, `slow_polling`, `dormant` -- don't bounce them to ConnectScreen and destroy their message history.

### Custom WebSocket Close Codes

| Code | Meaning | App Behavior |
|------|---------|-------------|
| `4000` | Server restarting | Fast retry, "Server restarting..." banner |
| `4001` | Server shutting down permanently | Stop retrying |
| `1006` | Abnormal closure | Standard exponential backoff |

### Device Pairing

One-time QR scan, permanent storage:

1. First time: Scan QR, app stores `{ url, token }` in SecureStore
2. Subsequent: App auto-connects on launch using saved credentials
3. **Critical fix**: Never clear `savedConnection` on retry exhaustion (current code does this -- hostile UX with Named Tunnels where the URL is permanent)

### Message Queue for Offline Periods

Messages sent while disconnected get queued and delivered on reconnect:

```typescript
interface QueuedMessage {
  type: string;
  data: unknown;
  timestamp: number;
  maxAge: number;  // ms, per-type TTL
}
```

- `input` messages: 60s TTL, queued
- `interrupt` messages: 5s TTL, queued
- `permission_response`: 5min TTL, queued
- `set_model`, `set_permission_mode`: NOT queued (state changes)
- Max queue size: 10 messages
- Drain after `auth_ok` + `claude_ready` on reconnect

### Local Network Fallback

When phone and dev machine are on same WiFi:
1. Server advertises local IP in QR code: `chroxy://tunnel.url?token=X&local=192.168.1.5:8765`
2. App tries local first (2s timeout), falls back to tunnel
3. Lower latency (1-5ms vs 50-200ms through Cloudflare)
4. Seamless failover on network change

---

## 6. Mobile App Updates

### The Challenge

The app is a React Native/Expo 54 project running on the user's phone. It can't hot-reload over a Cloudflare tunnel (Metro bundler requires LAN connectivity). The user needs to update the app after Claude Code modifies it.

### Approach Comparison

| Mechanism | Speed | Remote-OK | Cloud Deps | Setup |
|-----------|-------|:---------:|:----------:|-------|
| Metro HMR | Sub-second | No | None | None |
| expo-updates (self-hosted) | 10-25s | **Yes** | **None** | Medium |
| EAS Update | 5-20s | **Yes** | EAS acct | High |
| Custom bundle from Chroxy | 10-25s | **Yes** | **None** | Medium |

### Recommended: Self-Hosted Bundle via Chroxy Server

The Chroxy server already has an HTTP server. Serve the app's JS bundle from it, using `expo-updates` as the runtime mechanism.

```
Claude Code modifies app code
        |
        v
npx expo export --output-dir /tmp/chroxy-bundle
        |
        v
Chroxy Server serves bundle at GET /update/*
        |
        v
Server sends WS: { type: 'app_update_available', version: '...' }
        |
        v
App (expo-updates) fetches manifest + bundle from server
        |
        v
App reloads with new code (1-2s)
```

### Server-Side Bundle Serving

New module `packages/server/src/app-updates.js`:
- `exportBundle()`: Runs `npx expo export --output-dir <path>`
- `serveBundle(httpServer)`: Adds `GET /update/manifest` and `GET /update/bundles/*` routes
- `getBundleVersion()`: Returns current bundle metadata

New HTTP routes on the existing server:
```
GET /update/manifest      -> expo-updates manifest JSON
GET /update/bundles/*     -> JS bundle and assets
```

### Dynamic Tunnel URL Problem

`expo-updates` expects a fixed URL in `app.json`, but the tunnel URL can change. **Solution**: Use `Updates.fetchUpdateAsync()` with a runtime URL constructed from the active WebSocket connection URL (replace `wss://` with `https://`, append `/update/manifest`). Bypasses the static config entirely.

### App Update Flow (User Perspective)

1. User is chatting with Claude in the Session screen
2. Update banner appears: "Update ready. Tap to install."
3. User taps install
4. App reloads (~1s blank screen)
5. App reads `savedConnection` from SecureStore, auto-connects
6. Server sends `auth_ok` + `history_replay` -> full chat restored
7. Back to normal within 2-3 seconds

### Version Awareness UI

In the SettingsBar (expanded view):
```
Model: [Opus 4] [Sonnet 4]
Permissions: [Approve] [Auto] [Plan]
Cost: $0.03 | 2.1s | 45k tokens

─── App ───
Version: 0.1.1 (abc1234)
Server: 0.1.0 (def5678)

[Update Available: 0.1.2]
[Install Now]
```

### Rollback

- `expo-updates` maintains the previous bundle automatically
- If new bundle crashes within 5s of load, auto-revert to last working bundle
- Server keeps last 3 bundles, `npx chroxy rollback-app` switches the served bundle
- Manual rollback button in SettingsBar when running non-embedded update

---

## 7. Build & Deploy Pipeline

### Deploy Script

New file: `scripts/deploy.js`

```bash
npx chroxy deploy [--server-only] [--app-only] [--dry-run]
```

### Change Detection

```bash
git diff --name-only <last-deployed-hash> HEAD
```

- Files in `packages/server/` changed -> server deploy
- Files in `packages/app/` changed -> app deploy
- Root `package.json` changed -> both
- `--server-only` / `--app-only` override auto-detection

### Server Deploy Sequence

```
1. PRE-CHECK
   ├── git status --porcelain must be empty (abort if dirty)
   ├── ~/.chroxy/update.lock must not exist (abort if locked)
   └── Write lock file with PID

2. VALIDATE
   ├── node --check on all changed .js files
   └── node --test ./tests/*.test.js

3. TAG KNOWN-GOOD
   ├── git tag known-good-{timestamp}
   └── Write commit hash to ~/.chroxy/known-good-ref

4. WRITE MANIFEST
   └── Update ~/.chroxy/deploy-manifest.json

5. SIGNAL SUPERVISOR
   └── process.send({ type: 'restart', snapshot: {...} }) via IPC
       (or SIGUSR2 to supervisor PID from ~/.chroxy/supervisor.pid)

6. SUPERVISOR HANDLES RESTART
   ├── Send server_restarting to app via WS
   ├── SIGTERM old server, wait for exit
   ├── Spawn new server on same port
   ├── Health check (5 attempts, 1s interval)
   ├── Pass: broadcast restart_complete
   └── Fail: rollback to known-good, broadcast restart_failed

7. CLEANUP
   └── Remove lock file
```

### App Deploy Sequence

```
1. VALIDATE
   └── npx tsc --noEmit in packages/app/

2. EXPORT BUNDLE
   └── npx expo export --output-dir /tmp/chroxy-bundle-v{N}

3. PUBLISH
   ├── Move bundle to serving directory
   └── Update current symlink

4. NOTIFY
   └── Server broadcasts: { type: 'app_update_available', version: '...' }

5. APP DOWNLOADS
   └── expo-updates fetches from /update/manifest + /update/bundles/*
```

### The Meta-Restart Problem

Claude Code runs INSIDE the server it's restarting. The deploy script must:
1. Send the restart signal and immediately exit
2. The supervisor handles the actual restart asynchronously
3. Deploy success/failure appears in the NEW session after reconnect

---

## 8. Safety & Reliability

### Risk Matrix

| # | Failure Mode | Likelihood | Impact | Mitigation |
|---|---|:---:|:---:|---|
| F1 | Server crash on startup after update | HIGH | HIGH | Health check gate + automatic rollback |
| F2 | App update breaks connectivity | MEDIUM | HIGH | Server-only scope for v1; app updates later |
| F3 | Build corrupts codebase | MEDIUM | HIGH | Git clean check + known-good tags |
| F4 | Tunnel lost during migration | HIGH | MEDIUM | Supervisor owns tunnel; Named Tunnels |
| F5 | Claude session lost | HIGH | MEDIUM | Session serialization + --resume |
| F6 | Overlapping update cycles | MEDIUM | HIGH | Lock file with PID |
| F7 | User input during migration | HIGH | MEDIUM | Message queue + restart banners |
| F8 | Interrupted build | MEDIUM | HIGH | Watchdog timer (5min) + rollback |
| F9 | Permission hook corruption | MEDIUM | HIGH | Excluded file list |
| F10 | Recursive self-modification loop | LOW | CRITICAL | Excluded file list (supervisor untouchable) |

### Safety Mechanisms (Priority Order)

#### P1: Known-Good Version (MUST HAVE)
- `git tag known-good-{timestamp}` before every deploy
- Record hash in `~/.chroxy/known-good-ref`
- Never delete last 3 known-good tags

#### P2: Health Check Gate (MUST HAVE)
- New server must respond `GET /health` with `200 OK` before cutover
- Extended health check: verify WS upgrade works, Claude process spawns
- 5 attempts, 1s interval, 30s total timeout

#### P3: Automatic Rollback (MUST HAVE)
- Server crashes within 60s of deploy -> supervisor rolls back to known-good
- 3 crashes in 5 minutes -> supervisor gives up, stays on known-good
- Rollback: `git checkout {known-good-hash}`, restart

#### P4: Watchdog Timer (MUST HAVE)
- 5-minute hard timeout on entire deploy operation
- Fires -> kill children, restore pre-update commit, restart, remove lock

#### P5: Git Safety (MUST HAVE)
- `git status --porcelain` must be empty before deploy
- No `git stash` (hides state, complicates rollback)
- All changes must be committed before deploy begins

#### P6: Lock File (MUST HAVE)
- `~/.chroxy/update.lock` with PID and timestamp
- Check for stale locks (dead PID or older than watchdog timeout)
- Prevents concurrent deploys

### Excluded Files (v1)

The deploy system must REFUSE to proceed if Claude has modified:
- The supervisor script (`~/.chroxy/supervisor.js`)
- Config files (`~/.chroxy/config.json`, `~/.claude/settings.json`)
- The app directory (`packages/app/`) -- server-only updates in v1
- Any file outside the `chroxy/` repo

### Rollback Architecture

```
~/.chroxy/
  known-good-ref              # git hash of last verified-working version
  update.lock                 # PID file during updates
  deploy-manifest.json        # deploy history with rollback hashes
  session-state.json          # serialized Claude sessions
  supervisor.js               # immutable supervisor
  supervisor-state.json       # supervisor runtime state
```

**Level 1 - Instant rollback (server)**: Supervisor detects crash, `git checkout known-good`, restart (~15-30s)
**Level 2 - Full rollback (server + app)**: Same + roll back app bundle (~2-5min)
**Level 3 - Manual recovery**: SSH in, follow runbook

### Recovery Runbook

When everything is broken:

```bash
# 1. Stop everything
pkill -f "chroxy" || true
pkill -f "cloudflared" || true
pkill -f "claude.*stream-json" || true

# 2. Find last working version
cat ~/.chroxy/known-good-ref
# or: git tag -l 'known-good-*' --sort=-creatordate | head -3

# 3. Restore
git checkout $(cat ~/.chroxy/known-good-ref)

# 4. Clean install
rm -rf node_modules packages/*/node_modules
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm install

# 5. Start fresh
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx chroxy start

# 6. Scan new QR code from phone

# 7. Clean up stale lock
rm -f ~/.chroxy/update.lock
```

---

## 9. WebSocket Protocol Extensions

### New Client -> Server Messages

```json
{ "type": "restart_request" }
{ "type": "restart_request", "rollback": true }
{ "type": "check_update" }
{ "type": "apply_update" }
```

### New Server -> Client Messages

```json
{ "type": "restart_status", "phase": "draining|validating|stopping|restarting|complete|aborted|failed", "message": "..." }
{ "type": "restart_complete", "version": "0.1.1", "gitSha": "abc1234" }
{ "type": "server_shutting_down", "reason": "server_restart|server_shutdown" }
{ "type": "app_update_available", "version": "0.1.2", "size": 245000 }
{ "type": "app_update_ready" }
{ "type": "app_update_error", "message": "Export failed: syntax error" }
```

### Custom WebSocket Close Codes

```
4000 = Server restarting (will be back, client should retry fast)
4001 = Server shutting down permanently (stop retrying)
```

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Enables Everything Else)

**Server-side only. No app changes. No supervisor yet. Backwards compatible.**

| Step | Description | Files | Effort |
|------|-------------|-------|--------|
| 1.1 | Build manifest + `GET /version` endpoint | `ws-server.js` | Small |
| 1.2 | Session state serialization (`serialize()`/`restore()`) | `cli-session.js`, `session-manager.js` | Medium |
| 1.3 | IPC drain protocol (`process.on('message')` in server) | `server-cli.js`, `ws-server.js` | Medium |
| 1.4 | `--supervised` mode for server-cli.js | `server-cli.js` | Medium |
| 1.5 | Named Tunnel support in TunnelManager | `tunnel.js`, `cli.js` | Medium |

### Phase 2: Supervisor + Restart

**The core self-update capability.**

| Step | Description | Files | Effort |
|------|-------------|-------|--------|
| 2.1 | Supervisor process | `supervisor.js` (new) | Medium |
| 2.2 | Move tunnel ownership to supervisor | `supervisor.js` | Small |
| 2.3 | `chroxy dev` command (launches supervisor) | `cli.js` | Small |
| 2.4 | Blue-green restart via IPC | `supervisor.js` | Medium |
| 2.5 | Health check gate | `supervisor.js` | Small |
| 2.6 | Automatic rollback + known-good tagging | `supervisor.js` | Medium |
| 2.7 | Deploy script with change detection + validation | `scripts/deploy.js` (new) | Medium |

### Phase 3: App-Side Reconnection UX

**Make the phone experience smooth during restarts.**

| Step | Description | Files | Effort |
|------|-------------|-------|--------|
| 3.1 | `connectionPhase` enum replacing boolean flags | `connection.ts` | Medium |
| 3.2 | Exponential backoff with phase transitions | `connection.ts` | Medium |
| 3.3 | Restart banner in SessionScreen | `SessionScreen.tsx` | Small |
| 3.4 | Auto-connect on app launch (skip QR on saved conn) | `ConnectScreen.tsx` | Small |
| 3.5 | Never clear savedConnection on timeout | `connection.ts` | Small |
| 3.6 | Message queue for offline periods | `connection.ts` | Medium |
| 3.7 | `chroxy tunnel setup` guided command | `cli.js` | Medium |

### Phase 4: App Self-Updates (Future)

**OTA app updates served from Chroxy server.**

| Step | Description | Files | Effort |
|------|-------------|-------|--------|
| 4.1 | Install `expo-updates` + `expo-dev-client` | `packages/app/package.json` | Small |
| 4.2 | Bundle export + serving from server | `app-updates.js` (new), `ws-server.js` | Medium |
| 4.3 | `npx chroxy update-app` command | `cli.js` | Small |
| 4.4 | Update state in Zustand store | `connection.ts` | Medium |
| 4.5 | Update banner + version display in SettingsBar | `SessionScreen.tsx`, `SettingsBar.tsx` | Medium |
| 4.6 | Rollback support (keep last 3 bundles) | `app-updates.js` | Small |

### Critical Path

```
Phase 1.1-1.5 (foundation)
    |
    v
Phase 2.1-2.7 (supervisor + restart) <-- THIS IS THE MVP
    |
    v
Phase 3.1-3.7 (app UX) <-- makes it pleasant
    |
    v
Phase 4.1-4.6 (app updates) <-- full vision
```

**MVP = Phase 1 + Phase 2**: Server can self-update with rollback safety. App reconnects automatically (basic). Named tunnel keeps URL stable.

---

## New File Inventory

After implementation, the project gains:

```
packages/server/
  src/
    supervisor.js          # NEW: External supervisor process
    app-updates.js         # NEW: Bundle export + serving (Phase 4)
    deploy-manifest.js     # NEW: Read/write deploy manifest
  scripts/
    deploy.js              # NEW: Deploy orchestrator

  # Modified:
  src/cli.js               # Add: chroxy dev, chroxy deploy, chroxy tunnel setup
  src/server-cli.js        # Add: --supervised mode, IPC listener, drain protocol
  src/ws-server.js         # Add: /version endpoint, restart messages, bundle routes
  src/cli-session.js       # Add: serialize(), resumeSessionId support
  src/session-manager.js   # Add: serializeState(), restoreState()
  src/tunnel.js            # Add: Named Tunnel mode

packages/app/
  src/store/connection.ts  # Refactor: connectionPhase enum, message queue, auto-connect
  src/screens/SessionScreen.tsx  # Add: restart banner, update banner
  src/screens/ConnectScreen.tsx  # Add: auto-connect on saved connection
  src/App.tsx              # Fix: navigation guard for reconnection phases

~/.chroxy/
  supervisor.js            # Copied during chroxy init (immutable)
  supervisor-state.json    # Supervisor runtime state
  known-good-ref           # Git hash of last verified-working version
  deploy-manifest.json     # Deploy history
  session-state.json       # Serialized Claude sessions
  update.lock              # PID file during deploys
```

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Supervisor complexity | ~100 LOC, zero deps | Must never need updating itself |
| Tunnel strategy | Named Tunnel (opt-in) | Stable URL is the #1 enabler |
| Quick Tunnel fallback | Keep as default | Zero-friction first experience |
| Session preservation | `--resume` flag | Leverages Claude's built-in checkpointing |
| App update mechanism | Self-hosted expo-updates | No cloud deps, uses existing tunnel |
| v1 scope | Server-only updates | App bricking risk too high for v1 |
| Version tracking | Git commit hash | Already in use, no new systems needed |
| Rollback trigger | Crash within 60s | Simple, deterministic, no false positives |
| Connection state | Phase enum over booleans | Explicit, exhaustive, no impossible states |
| Message queue TTL | Per-type expiry | Stale interrupts shouldn't replay |

---

*Design reviewed by specialized audits: System Architecture, Mobile App Updates, Server Migration, Connection Persistence, Build Pipeline, and Safety & Reliability.*
