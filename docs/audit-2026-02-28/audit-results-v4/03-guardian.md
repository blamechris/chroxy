# Guardian Audit: Reliability & Resilience

**Auditor role:** Guardian -- reliability engineer
**Scope:** Desktop CLI Agent IDE implementation plan
**Date:** 2026-03-01
**Rating: 3.2 / 5**

The existing server infrastructure is well-engineered for a single-active-session paradigm with 1-2 clients. The vision document calls for multi-tab concurrent session views, cross-device simultaneous input, repo discovery with filesystem scanning, and a desktop app that manages the server lifecycle. Each of these expansions introduces failure modes that the current architecture does not address. The foundation is solid, but the plan underestimates the reliability work needed to make multi-tab, multi-device orchestration feel rock-solid.

---

## Failure Mode Catalog

### FM-01: Broadcast Storm Under Multi-Tab Subscription

**Trigger:** User opens 5 tabs, each with an active streaming session. All 5 sessions produce `stream_delta` events simultaneously.

**Current code path:** `_broadcastToSession()` in `ws-server.js:1038-1045` iterates ALL connected clients for every delta, tagging messages with `sessionId`. With 5 sessions streaming at ~20 deltas/second each, that is 100 `_send()` calls/second per client. Each `_send()` call serializes JSON and optionally encrypts (`ws-server.js:1189-1214`). With E2E encryption active, every message triggers `nacl.secretbox()` -- 100 symmetric encryptions/second per client.

**Impact:** Increased latency on all tabs. On mobile (connected via tunnel), bandwidth saturation. CPU pressure on Node.js event loop from JSON serialization + encryption.

**Proposed mitigation:**
- The planned `subscribe_sessions` message (vision doc, "New Protocol Messages Needed") must include session-level subscription filtering on the server side. Clients should only receive events for sessions they have open in a tab.
- Add per-session delta coalescing in `EventNormalizer` so multiple deltas within a flush window are batched into a single message per session per client.
- Consider a per-client send queue with backpressure detection. If `ws.bufferedAmount` exceeds a threshold, drop `stream_delta` messages (they are transient) rather than queuing unbounded.

**Severity:** High
**Phase:** Must fix in Phase 2

---

### FM-02: Memory Growth from Multiple xterm.js Terminal Instances

**Trigger:** User opens 5+ tabs, each instantiating an xterm.js terminal in the WebView. Each xterm.js instance maintains its own scrollback buffer (default: 1000 lines, but sessions with verbose tool output can produce much more).

**Current state:** The existing dashboard (`dashboard-app.js`) creates a single xterm.js terminal. The vision calls for one per tab.

**Impact:** Each xterm.js instance with a 5000-line scrollback consumes approximately 5-15 MB of memory in the WebView process. With 5 tabs, that is 25-75 MB just for terminal buffers. Combined with React component trees and the Tauri WebView overhead, the desktop app could easily consume 300+ MB.

**Proposed mitigation:**
- Set a hard scrollback limit per terminal (e.g., 2000 lines) and document this as a design constraint.
- Implement lazy terminal initialization: only create the xterm.js instance when a tab is focused. When a tab is backgrounded for > 60 seconds, serialize its buffer state and dispose the instance. Re-hydrate from the server's message history (`getHistory()` / `getFullHistoryAsync()`) when the tab is focused again.
- Add memory monitoring via `performance.memory` (Chromium WebView) and log warnings when heap exceeds a threshold.

**Severity:** Medium
**Phase:** Must address in Phase 2

---

### FM-03: Session Creation Race Condition

**Trigger:** Two clients (desktop + mobile) both send `create_session` simultaneously when `_sessions.size === maxSessions - 1`. Both calls pass the `this._sessions.size >= this.maxSessions` guard in `session-manager.js:121` before either increments the map.

**Current code path:** `createSession()` (`session-manager.js:120-177`) checks size, then creates and adds. Node.js is single-threaded, so within a single event loop tick this is safe. However, `session.start()` on line 171 may trigger asynchronous work (spawning a subprocess), and the `_wireSessionEvents` call on line 170 sets up listeners that will fire on future ticks.

**Analysis:** Because `this._sessions.set(sessionId, entry)` on line 168 happens synchronously before `session.start()` on line 171, and JavaScript is single-threaded, the race condition described above cannot actually occur for the session limit check. The map size is incremented before any async work begins. **This is safe as-is.**

However, there is a related edge case: if `session.start()` throws synchronously (e.g., binary not found), the session is already in the map but in a broken state. The error propagates to the caller, but the session entry remains in `_sessions` with no cleanup.

**Impact:** Phantom session occupies a slot. User sees it in the list. Interacting with it produces errors.

**Proposed mitigation:**
- Wrap `session.start()` in a try-catch within `createSession()`. On failure, remove the entry from `_sessions`, clean up maps, and re-throw.

**Severity:** Medium
**Phase:** Should fix in Phase 0 (it is a bug in existing code)

---

### FM-04: Destroy While Streaming

**Trigger:** User destroys a session while Claude Code is mid-response (streaming deltas).

**Current code path:** `destroySession()` (`session-manager.js:246-272`) calls `entry.session.destroy()`, deletes from maps, and emits `session_destroyed`. Meanwhile, `_wireSessionEvents` (`session-manager.js:686-724`) has listeners still registered on the session object. If the session's destroy is asynchronous and events fire after the session is removed from `_sessions`, the `_recordHistory` calls will create orphaned entries in `_pendingStreams` (line 545-546) because the `sessionId:messageId` key is written but the session no longer exists.

**Impact:** Minor memory leak from orphaned `_pendingStreams` entries that are never cleaned up by `stream_end`. The cleanup loop in `destroySession()` (lines 260-264) handles entries that exist at destroy time, but not entries created by events that fire after destroy due to async teardown.

**Proposed mitigation:**
- Add a `_destroyedSessions` Set. In `_wireSessionEvents`, check if the session has been destroyed before recording history or emitting events.
- Alternatively, remove all listeners from the session object in `destroySession()` before calling `session.destroy()`.
- In `ws-message-handlers.js:302-332`, the destroy handler redirects all clients viewing the destroyed session to the first session. If the destroyed session was the only one sending a `stream_end` for an in-progress stream, the client may never receive `stream_end`, leaving the UI in a "loading" state. Send a synthetic `stream_end` to affected clients before destroying.

**Severity:** Low-Medium
**Phase:** Should fix before Phase 2

---

### FM-05: Cross-Device Input Collision (Last-Writer-Wins Confusion)

**Trigger:** Desktop sends "implement the sidebar" and mobile sends "fix the bug" to the same session within the same second. The `_primaryClients` map (`ws-server.js:200`) tracks last-writer-wins, and `_updatePrimary` (`ws-server.js:1106-1117`) broadcasts `primary_changed`. But the actual session receives both inputs sequentially -- whichever `input` message the server processes first goes to Claude.

**Current code path:** In `ws-message-handlers.js`, the `input` case (around line 100) calls `entry.session.sendMessage(msg.data)`. If the session `isRunning`, the input is likely queued or rejected depending on the provider. But if both arrive while the session is idle, the first one starts Claude, and the second one may be silently dropped or queued.

**Impact:** User confusion. Desktop user sends a message, mobile user sends a different message. One of them "wins" and the other's input vanishes with no feedback. The `primary_changed` notification arrives but doesn't explain that the other user's input was dropped.

**Proposed mitigation:**
- When a session is already processing input and a second `input` arrives from a different client, send back a `session_error` with `category: 'input_conflict'` to the second client, explaining that another device is already sending input.
- Consider adding an optimistic lock: `input` messages include a `primaryClientId` field. The server rejects input if the sender is not the current primary, responding with `primary_changed` so the client can inform the user.
- At minimum, echo back `user_input` messages to all clients (including the `clientId` of the sender) so both devices see what was submitted.

**Severity:** Medium
**Phase:** Must address in Phase 2 (multi-device is a key feature)

---

### FM-06: Server Crash Recovery -- Data Loss Window

**Trigger:** Node.js server crashes (OOM, unhandled rejection, SIGKILL). The Tauri `ServerManager` (`server.rs:237-306`) detects the crash via health poll failure and sets status to `Error`.

**Current recovery path:** `ServerManager` does not auto-restart. The user must click "Restart Server" in the tray menu, which calls `handle_restart` -> `mgr.restart()` -> `stop()` + `start()`. On start, `SessionManager.restoreState()` reads `session-state.json`.

**Data loss window:** `serializeState()` (`session-manager.js:305-345`) is called by `_schedulePersist()` with a 2-second debounce (`session-manager.js:654-664`). If the server crashes during those 2 seconds, the last state change is lost. More critically, `serializeState()` is called in `destroyAll()` (`session-manager.js:277-289`) during graceful shutdown. A crash (SIGKILL, OOM) skips `destroyAll()` entirely. The state file may contain stale data from the last debounced persist.

**Impact:** After crash recovery, sessions may replay stale history. In-progress work is lost. The 24-hour TTL (`_stateTtlMs`, line 87) may cause state to be rejected as stale if the crash happened near the boundary.

**Proposed mitigation:**
- Reduce persist debounce to 500ms for critical events (session creation, destruction, result).
- Add crash detection in `ServerManager`: if the health poll transitions from `Running` to `Error` (not `Stopped`), auto-restart with a backoff (3s, 6s, 12s) up to 3 attempts, similar to the tunnel recovery pattern in `base.js:92-156`.
- Register a `SIGTERM` handler in the Node server that calls `serializeState()` synchronously before exit.
- Consider write-ahead logging: append critical events (session create/destroy) to a WAL file immediately, independent of the debounced full-state serialize.

**Severity:** High
**Phase:** Must fix before Phase 2

---

### FM-07: Tauri Single-Instance Gap

**Trigger:** User double-clicks the Chroxy app icon, or the app is launched at login while already running.

**Current state:** The vision doc's Phase 0 lists "Add `tauri-plugin-single-instance`" as a required fix. Grep confirms it is not yet implemented. Without it, two Tauri instances will each spawn their own `ServerManager`, each trying to start the Node server on the same port.

**Impact:** Port conflict. Second instance's `start()` fails. But the second instance's health poll may connect to the first instance's server, causing the second Tauri to believe it owns a server it does not control. Stopping the server from the second instance sends SIGTERM to... nothing (it has no child PID). The first instance's server keeps running but the first Tauri thinks it stopped.

**Proposed mitigation:**
- Implement `tauri-plugin-single-instance` as listed in Phase 0. This is the correct fix.
- As defense-in-depth, `ServerManager::start()` should check if the port is already in use before spawning. Attempt a health check on `localhost:{port}` first. If it responds, fail with "Server already running on this port."

**Severity:** High
**Phase:** Must fix in Phase 0 (already listed, confirming priority)

---

### FM-08: Repo Discovery Filesystem Failures

**Trigger:** `ConversationScanner` (`conversation-scanner.js`) scans `~/.claude/projects/`. User has hundreds of past conversations. Some files are on a network mount (slow). Some directories have restrictive permissions.

**Current code path:** `performScan()` (line 118-186) reads all directories, then all JSONL files with concurrency limit of 15. Each file read opens and reads 32KB. The `readdir` and `open` calls have `try/catch` around them (lines 121-124 for readdir, lines 88-93 for open), so individual failures are swallowed gracefully.

**However, the scan blocks on the full directory traversal.** With 500+ conversations (plausible for a power user), even at CONCURRENCY=15, the scan takes hundreds of milliseconds. The 5-second cache TTL (`CACHE_TTL_MS`, line 10) means this scan runs at most every 5 seconds, which is fine for the current usage (one `list_conversations` per client connect). But the vision's sidebar will want to show repo+session status and may poll more frequently.

**Impact:** Momentary UI stutter when sidebar refreshes. Network-mounted home directories could cause hangs if NFS is unresponsive. No timeout on individual file reads.

**Proposed mitigation:**
- Add a per-file read timeout (e.g., 2 seconds). Use `AbortSignal.timeout()` with `fs/promises.open()`.
- Increase cache TTL to 30 seconds for the sidebar use case. The sidebar only needs to refresh when sessions change (event-driven), not on a timer.
- For the "Add Repo" feature (Phase 2), validate the directory is accessible with a timeout before adding it to the repo list. Store repo list in a config file so it survives restarts without re-scanning.
- Consider a filesystem watcher (`fs.watch`) on the projects directory instead of polling, to detect new conversations in real-time.

**Severity:** Low
**Phase:** Should address in Phase 2

---

### FM-09: History Replay Flood on Tab Open

**Trigger:** User opens a tab for a session with 500 messages in its ring buffer (`_maxHistory`, `session-manager.js:92`). `_replayHistory()` (`ws-server.js:821-844`) sends all messages in a tight loop.

**Current code path:** `_replayHistory` slices from the last response message to the end. In a session with many tool calls, this could be 50-100 messages. Each is sent via `_send()` which may trigger encryption. With E2E encryption, 100 messages replayed = 100 `nacl.secretbox()` calls in sequence on a single event loop tick.

**Impact:** Event loop blocked for 10-50ms during history replay. Other sessions' streaming deltas are delayed. On mobile over tunnel, the burst of messages may exceed the WebSocket frame buffer, causing the client to lag.

**Proposed mitigation:**
- Batch history replay messages. Send messages in chunks of 10-20 with `setImmediate()` between chunks to yield the event loop.
- For the multi-tab scenario (Phase 2), when multiple tabs are opened simultaneously (e.g., on app launch restoring all tabs), stagger the history replays with a small delay between sessions.
- Consider compressing history replay into a single message (`history_batch`) rather than individual messages, reducing WS frame overhead.

**Severity:** Medium
**Phase:** Should address in Phase 2

---

### FM-10: Tunnel URL Change Breaks Cross-Device Sync

**Trigger:** Quick Tunnel crashes and recovers with a new URL (`base.js:130-136` emits `tunnel_url_changed`). Desktop continues to work (localhost WebSocket). Mobile is connected via the old tunnel URL.

**Current code path:** `BaseTunnelAdapter` emits `tunnel_url_changed`, but there is no handler in `ws-server.js` that notifies connected mobile clients about the new URL. The mobile client's WebSocket connection dies when the old tunnel URL stops routing. The app must detect the disconnect and reconnect, but it doesn't know the new URL.

**Impact:** Mobile loses connection. Must re-scan QR code or re-enter the new URL. This is documented as a known limitation, but in the IDE context (Phase 2+), mobile sync is a key feature. Losing it silently is a poor experience.

**Proposed mitigation:**
- On `tunnel_url_changed`, broadcast `{ type: 'tunnel_url_changed', newUrl }` to all still-connected clients (desktop, or mobile clients that haven't disconnected yet).
- Update `connection.json` with the new URL (this may already happen -- verify).
- For Quick Tunnel mode, document prominently that URL changes on tunnel restart. Recommend Named Tunnel for reliable mobile sync.
- In the mobile app's reconnection logic, add a fallback: on disconnect, attempt to hit the server's `/connect` endpoint via the last known base URL. If it responds with a new tunnel URL, reconnect to that.

**Severity:** Medium
**Phase:** Should fix before Phase 3

---

### FM-11: E2E Encryption Nonce Counter Overflow

**Trigger:** A long-running session with heavy streaming. The nonce counter (`client.encryptionState.sendNonce`) increments on every `_send()`. With 5 sessions streaming 20 deltas/second, that is 100 increments/second. In 24 hours: ~8.6 million. The nonce is written as a little-endian uint64 across bytes 1-8 of a 24-byte nonce (`crypto.js:52-62`), using `Math.floor(val / 256)` for each byte.

**Current code path:** `nonceFromCounter()` (`crypto.js:52-62`) uses `Math.floor(val / 256)` in a loop to write the counter as little-endian. JavaScript `Number` is IEEE 754 double (53-bit mantissa). `Number.MAX_SAFE_INTEGER` is 2^53 - 1 = ~9 quadrillion. At 100 increments/second, overflow would take ~2.85 billion years. **This is not a practical concern.**

**However**, the nonce counter is not persisted. If the server restarts and the same ECDH keypair were reused, nonces would restart at 0, violating the "never reuse (key, nonce)" invariant. **This is safe because:** `createKeyPair()` generates a fresh ephemeral keypair per connection (`ws-server.js:949`), so key reuse cannot occur across restarts.

**Impact:** None. This is safe as implemented.

**Severity:** None (informational)
**Phase:** N/A

---

### FM-12: `_broadcastToSession` Sends to All Clients Regardless of Session

**Trigger:** Session A is streaming. Client 1 is viewing Session A. Client 2 is viewing Session B. Both clients receive Session A's stream deltas because `_broadcastToSession` (`ws-server.js:1038-1045`) sends to ALL authenticated clients, not just those whose `activeSessionId` matches.

**Current code path:** The filter parameter defaults to `() => true`, meaning every authenticated client receives every session's messages. The `sessionId` tag is included so clients can route locally, but the server sends everything to everyone.

**Impact:** Wasted bandwidth. On mobile over tunnel, receiving 4 sessions' worth of stream deltas when only viewing 1 session wastes data and battery. With 5 concurrent sessions, mobile receives 5x the necessary traffic.

**This is the `_broadcastToSession` bug referenced in the vision doc's Phase 0.** The vision doc confirms it was "confirmed by all 10 auditors."

**Proposed mitigation:**
- Implement session-scoped client subscriptions. Each client maintains a `Set<sessionId>` of subscribed sessions (initially just `activeSessionId`). `_broadcastToSession` only sends to clients subscribed to that session.
- The planned `subscribe_sessions` message (vision doc) should manage this subscription set.
- For backward compatibility with the mobile app, default to subscribing to `activeSessionId` only (current behavior from the client's perspective, but now filtered server-side).

**Severity:** High
**Phase:** Must fix in Phase 0 (already listed, confirming with code reference)

---

### FM-13: Session State File Corruption

**Trigger:** Server crashes during `serializeState()` while writing the temp file. Or: disk is full.

**Current code path:** `serializeState()` (`session-manager.js:330-344`) writes to a `.tmp` file, then atomically renames. The rename is atomic on POSIX systems but NOT on Windows (lines 335-340 show the Windows workaround: delete + rename, which is non-atomic).

**On Linux/macOS:** The atomic rename is safe. A crash during write leaves a partial `.tmp` file. On next restart, `restoreState()` reads the original (pre-crash) state file, which is intact. The `.tmp` file is orphaned but harmless.

**On Windows:** The `unlinkSync` + `renameSync` sequence (lines 336-342) is non-atomic. A crash between delete and rename loses both the old and new state files. `restoreState()` returns `null`, starting with no sessions.

**Impact:** On Windows, crash during persist = complete session state loss. On POSIX, this is safe.

**Proposed mitigation:**
- On Windows, rename the old state file to `.bak` before renaming `.tmp` to the final name. On success, delete `.bak`. On startup, if the main state file is missing but `.bak` exists, restore from `.bak`.
- Handle `ENOSPC` (disk full) explicitly in `serializeState()`. Log a warning and skip the write rather than crashing.

**Severity:** Low (Linux/macOS), Medium (Windows)
**Phase:** Should fix before Phase 2

---

### FM-14: Health Poll Thread Leak in ServerManager

**Trigger:** Rapid start/stop/restart cycles of the server from the tray menu.

**Current code path:** `start_health_poll()` (`server.rs:238-306`) spawns a background thread that polls forever (two loops: startup loop then monitoring loop). `stop()` (`server.rs:188-229`) sets `health_running = false` to signal the thread. But the thread checks `health_running` only at the top of each loop iteration, and `thread::sleep(Duration::from_secs(5))` means up to 5 seconds before it notices the stop signal.

If `start()` is called immediately after `stop()` (as in `restart()`), a new health thread is spawned while the old one is still sleeping. The old thread wakes up, sees `health_running = true` (set by the new `start()`), and continues polling alongside the new thread.

**Impact:** Thread accumulation. Each restart adds one extra polling thread. After 10 restarts, 10 threads are polling the health endpoint every 5 seconds.

**Proposed mitigation:**
- Use a generation counter instead of a boolean. Each `start()` increments the generation. The health thread stores its generation at spawn time and exits if the current generation differs.
- Alternatively, use a `JoinHandle` to join the old health thread before starting a new one.

**Severity:** Low-Medium
**Phase:** Should fix before Phase 2

---

### FM-15: No Graceful Degradation for WebView Crash

**Trigger:** Tauri's WebView (WKWebView on macOS, WebView2 on Windows) crashes due to memory pressure or a JavaScript exception. The dashboard becomes a blank white page.

**Current state:** `window.rs` does not handle WebView crashes. There is no Tauri event handler for WebView process termination. The tray menu still shows "Running" because the Node server is fine -- it is the UI that crashed.

**Impact:** User sees blank window. No indication of what happened. Must manually close and reopen the dashboard window.

**Proposed mitigation:**
- Add a WebView health check: periodically evaluate a small JS expression in the WebView. If it fails or times out, destroy and recreate the window.
- Register a handler for Tauri's `on_web_resource_request` or equivalent error event to detect WebView crashes.
- At minimum, add a "Reload Dashboard" option to the tray menu as a manual recovery path.

**Severity:** Medium
**Phase:** Should add in Phase 3

---

## Must Have Before Phase 2

These items must be resolved before the IDE layout (sidebar + tabs) ships, because Phase 2 introduces multi-tab concurrent session views:

| # | Item | Reference |
|---|------|-----------|
| 1 | **Fix `_broadcastToSession` session filtering** | FM-12, `ws-server.js:1038-1045` |
| 2 | **Implement `subscribe_sessions` with server-side filtering** | FM-01, FM-12, vision doc "New Protocol Messages Needed" |
| 3 | **Add per-session delta coalescing / backpressure** | FM-01, `ws-forwarding.js:26-33` |
| 4 | **Fix session creation failure cleanup** | FM-03, `session-manager.js:168-171` |
| 5 | **Fix destroy-while-streaming event leak** | FM-04, `session-manager.js:246-272` |
| 6 | **Server crash auto-restart in Tauri** | FM-06, `server.rs` |
| 7 | **Single-instance plugin** | FM-07, `lib.rs` |
| 8 | **Health poll thread generation counter** | FM-14, `server.rs:238-306` |
| 9 | **Set xterm.js scrollback limits and lazy initialization** | FM-02 |
| 10 | **Batch history replay to yield event loop** | FM-09, `ws-server.js:821-844` |

## Must Have Before Phase 3

These items must be resolved before the polish/power features phase, which adds native notifications, split pane, and assumes stable daily-driver use:

| # | Item | Reference |
|---|------|-----------|
| 1 | **Cross-device input conflict resolution** | FM-05, `ws-message-handlers.js` |
| 2 | **Tunnel URL change notification to clients** | FM-10, `base.js:130-136` |
| 3 | **WebView crash recovery / reload option** | FM-15, `window.rs` |
| 4 | **Windows state file corruption guard** | FM-13, `session-manager.js:335-342` |
| 5 | **Repo discovery timeouts and event-driven refresh** | FM-08, `conversation-scanner.js` |
| 6 | **Reduce persist debounce for critical events** | FM-06 |

---

## Summary

The codebase exhibits careful engineering -- atomic file writes, constant-time token comparison, proper signal handling, concurrent scan limits, poison-recovering mutexes. The single-session, single-client path is reliable. The risk concentrates in the transition from "one active session" to "five concurrent sessions across two devices," which is exactly what Phases 2-3 deliver.

The most critical systemic risk is **FM-12 / FM-01**: the broadcast architecture assumes all clients want all session events. This must become subscription-based before multi-tab ships, or the server will send N times too much data to every client.

The second systemic risk is **FM-06**: the desktop app manages the server lifecycle but has no auto-restart on crash. For an IDE that users keep open all day, "click Restart in the tray menu" is not acceptable crash recovery.

Everything else is addressable with targeted fixes. The plan is sound; it just needs a reliability pass at each phase boundary.
