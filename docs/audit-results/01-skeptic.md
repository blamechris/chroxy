# Skeptic's Audit: Chroxy System

**Agent**: Skeptic -- Cynical systems engineer who has seen too many designs fail. Cross-references every claim against actual code.
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-10

---

## Section Ratings

### 1. Architecture: Two Server Modes + Supervisor -- 4/5

**Strengths:**
- Dual-mode architecture (CLI headless vs PTY/tmux) cleanly separated. `WsServer` routes through three distinct handlers at `ws-server.js:462-468`
- `SessionManager` at `session-manager.js:95-113` properly abstracts both `CliSession` and `PtySession` behind EventEmitter interface
- Supervisor at `supervisor.js:29-447` is solid: standby health server during restart, deploy rollback tracking, exponential backoff, drain protocol

**Concerns:**
- `SdkSession` and `CliSession` have subtly different capabilities. SDK has `respondToPermission()` for in-process handling; CLI does not. `WsServer._handleSessionMessage` at line 559-569 tries SDK path first, then falls through to HTTP -- dual-path silent failure mode
- `_useLegacyCli` flag in SessionManager (line 101) means two distinct code paths with different capabilities, doubling test coverage requirements

### 2. WebSocket Protocol -- 4/5

**Strengths:**
- `noServer` WebSocket setup at `ws-server.js:174` with HTTP upgrade handling is exactly right for Cloudflare compatibility
- Auth timeout at 10s (line 213-219), draining mode (line 453-459), 30s ping/pong keepalive (line 260-274) all well-implemented
- Delta buffering at 50ms server-side (line 870-916) and 100ms client-side is smart bandwidth optimization

**Concerns:**
- `_broadcastToSession` at line 1338-1345 sends to ALL authenticated clients, not just those viewing the session. Client-side routing via `msg.sessionId` handles this, but bandwidth waste over cellular is real
- Permission HTTP endpoint at line 1196-1304 holds connections open for 5 minutes. Mobile app backgrounding + failed push = connection sitting open doing nothing

### 3. Tunnel Reliability -- 4/5

**Strengths:**
- `waitForTunnel` verifies routability before QR code display, 10 attempts at 2s intervals
- Auto-recovery with 3 attempts and exponential backoff (3s/6s/12s)
- Named tunnels preserve URL on crash; quick tunnels clear it

**Concerns:**
- Quick tunnel recovery gives new URL, but connected clients are on the old one. The `tunnel_url_changed` event fires but there is no mechanism to push the new URL to connected clients -- they must rescan QR
- `waitForTunnel` uses `fetch()` without `User-Agent` header -- some Cloudflare edge nodes rate-limit headerless requests

### 4. Test Safety -- 2/5

**CRITICAL:** `session-manager.test.js` writes to real `~/.chroxy/session-state.json` (line 9):
```javascript
const STATE_FILE = join(homedir(), '.chroxy', 'session-state.json')
```
Lines 141-199 repeatedly write/read from the real home directory. Same class of bug as the P1 settings.json incident (#429). If test crashes, stale state file causes phantom session restoration on next server start.

`permission-hook.test.js` correctly removed offending tests (lines 80-82), but the underlying code at `permission-hook.js:43` still hardcodes `homedir()`. Issue #429 open.

### 5. State Management: App ConnectionPhase -- 3/5

**Strengths:**
- `ConnectionPhase` state machine with 5 states covers important transitions
- `connectionAttemptId` pattern prevents "two competing reconnect loops" bug
- `AppState.addEventListener` handles iOS/Android app resume detecting stale sockets

**Concerns:**
- `handleMessage` function at `connection.ts:565-1318` is a 750-line switch with 11 pieces of module-level mutable state. Race between `session_switched` and `history_replay_start` could leave flags in wrong state
- `selectShowSession` returns true during `server_restarting`, showing stale messages until `history_replay_end` fires
- Dual state management (per-session dict + flat legacy state) creates large surface for missed routing bugs

### 6. Configuration & Hook Registration -- 3/5

**Strengths:**
- Config precedence well-tested
- `withSettingsLock` correctly serializes concurrent read-modify-write operations

**Concerns:**
- If Chroxy crashes without running `unregisterPermissionHookSync()`, hook entry left in settings.json permanently. Orphaned entry causes confusion though hook script falls through gracefully
- `unregisterPermissionHookSync` throws if settings.json missing or invalid JSON
- Hook script uses fragile grep-based JSON parser for response parsing

---

## Top 5 Findings

1. **session-manager.test.js writes to real `~/.chroxy/session-state.json`** -- same P1 class as settings.json incident
2. **Quick tunnel URL change invisible to connected clients** -- hard disconnect requiring QR rescan
3. **Broadcast sends to ALL clients regardless of active session** -- bandwidth waste on cellular
4. **750-line handleMessage with 11 mutable state variables** -- race condition surface
5. **Dual state management (flat + per-session)** -- every message handler must route correctly

---

## Verdict

A surprisingly well-built v0.1.0 for a remote control app over hostile network conditions. Architecture choices are mostly sound, edge cases handled better than most projects at this stage. The dual-session model is cleanly abstracted. Real problems: test safety (session-manager.test.js P1 class bug), state management complexity in connection.ts, and assumptions about mobile network behavior that will bite. The foundation is solid but the complexity is accumulating faster than the test coverage.
