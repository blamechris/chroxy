# Guardian's Audit: Codebase-Wide Code Quality

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 3.4 / 5
**Date**: 2026-03-15

---

## Section Ratings

| Module | Rating | Verdict |
|---|---|---|
| `supervisor.js` | 3.5/5 | Solid; one shutdown race |
| `ws-server.js` | 4/5 | Well-hardened; auth cleanup memory growth |
| `session-manager.js` | 4/5 | Good locking and cleanup |
| `sdk-session.js` | 3.5/5 | 5-min timeout good; resultTimeout not cleared on destroy race |
| `cli-session.js` | 2.5/5 | Silent message drop, unguarded stdin writes, stale _destroying flag |
| `permission-manager.js` | 4/5 | Timeout/abort well-handled |
| `push.js` | 3.5/5 | fetchWithRetry correct; TOCTOU token set race |
| `session-state-persistence.js` | 4.5/5 | Atomic rename is correct |
| `tunnel/cloudflare.js` + `base.js` | 3/5 | Missing `error` listener on process after recovery |
| `checkpoint-manager.js` | 3/5 | Git stash-pop race; arbitrary-path git ops |
| `ws-client-sender.js` | 4/5 | Backpressure handling correct |
| `rate-limiter.js` | 4/5 | Unbounded internal Map on mass reconnect |

---

## Finding 1 — CRITICAL: Single-Slot Pending Message Queue Silently Drops User Input

**File:** `packages/server/src/cli-session.js:261-264`

`_pendingMessage` is a single scalar reference. If the user sends a second message while the process is respawning (e.g. during model switch, 2-10 seconds), the second write overwrites the first. The user's earlier message is **silently discarded** — no error, no acknowledgment.

**Fix:** Replace `_pendingMessage` with `_pendingQueue = []`. Dequeue in FIFO order. Add max-depth guard and emit `error` for overflow.

---

## Finding 2 — HIGH: Unguarded stdin Write — Unhandled Exception on Closed Pipe

**File:** `packages/server/src/cli-session.js:294,665`

Both `sendMessage()` and `respondToQuestion()` write to `this._child.stdin` without error handling. If the child process has closed its stdin, `stdin.write()` throws `Error: write EPIPE`. This is a TOCTOU — the child can die between the null check and the write.

**Fix:** Wrap in try/catch. Also add `this._child.stdin.on('error', () => {})` after spawn.

---

## Finding 3 — HIGH: Supervisor Shutdown Race — Force-Kill Timer Fires After Child Reference Cleared

**File:** `packages/server/src/supervisor.js:554-562`

The `forceKillTimer` callback references `this._child`, but the child's `'exit'` handler sets `this._child = null`. If the timer fires while a new child is starting, `forceKill(this._child)` kills the **new child**.

**Fix:** Capture a local reference: `const childRef = this._child` before the timeout.

---

## Finding 4 — MEDIUM: Orphaned Permission and Question Routing Maps

**File:** `packages/server/src/ws-server.js:311-313`

`_permissionSessionMap` and `_questionSessionMap` are populated on every permission/question event but never cleaned up when a session is destroyed with pending prompts. These maps grow unbounded across long-running sessions.

**Fix:** Prune entries matching destroyed sessionId in the `session_destroyed` event handler.

---

## Finding 5 — MEDIUM: CliSession `_destroying` Flag Misuse

**File:** `packages/server/src/cli-session.js` `_killAndRespawn()`

`_destroying` serves two purposes: "permanently destroyed" and "controlled kill-respawn". If `destroy()` is called during a `_killAndRespawn()` cycle, `respawn()` sets `_destroying = false`, re-enabling respawn for a permanently destroyed session.

**Fix:** Use a separate `_respawning` flag.

---

## Additional Findings

- **App auto-reconnect has no backoff**: `AUTO_RECONNECT_DELAY = 1500ms` flat rate, indefinitely. Server permanently down = battery drain.
- **`session-lock.js` has no timeout**: A lock holder that hangs causes all subsequent operations to queue indefinitely.
- **`checkpoint-manager.js` git stash-pop race**: Another process running `git stash` between push and pop corrupts the working tree.
- **`devPreview.handleToolResult` fire-and-forget async**: Errors before the try block become unhandled rejections.
- **`push.js` TOCTOU**: Concurrent `send()` and `sendLiveActivityUpdate()` can race on token deletion.
