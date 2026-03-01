# Guardian Safety Audit v3: Chroxy Desktop Architecture

**Auditor:** Guardian (Security/SRE)
**Date:** 2026-02-28
**Subject:** `docs/audit-2026-02-28/desktop-architecture-audit.md` and supporting source files
**Scope:** Safety, failure modes, race conditions, data integrity, crash recovery, operational resilience
**Prior version:** v2 rated 3.1/5 — this v3 pass re-verifies those findings and investigates newly scoped failure modes

---

## v2 Findings Re-Verification

### Finding 1 (v2): No PID file in --no-supervisor mode — CONFIRMED, UNCHANGED

**Status:** Still present. No code changes since v2.

- `server.rs:141` still passes `--no-supervisor` to the Node.js child.
- `supervisor.js:224-230` writes a PID file, but that code path is never reached in desktop mode.
- `server-cli.js` writes `pid` into the connection-info file (`server-cli.js:367`), but that is informational only — no startup code reads it to detect orphans.
- The `ServerManager::start()` method (`server.rs:93-185`) checks `ServerStatus::Running` but has no mechanism to detect a Node process from a previous crashed Tauri instance.

**Verdict:** Confirmed. Orphan detection is still absent.

### Finding 2 (v2): Tunnel recovery re-entry race condition — CONFIRMED, PARTIALLY MITIGATED

**Status:** Still present but less severe than originally stated.

- `base.js:104`: The `while` loop in `_handleUnexpectedExit` uses `this.recoveryAttempt < this.maxRecoveryAttempts` as the loop guard. If `_handleUnexpectedExit` were called concurrently (e.g., the tunnel process rapidly exits, triggering two `close` events), two concurrent recovery loops could run.
- However, the `close` event on a child process fires exactly once per process instance. The race requires a second `close` event from a *recovered* tunnel process that exits before the first recovery loop finishes and resets `recoveryAttempt`. Since the recovery loop awaits `_startTunnel()` (line 121) and sets `this.process` to the new process, a second exit would need to happen within the `_startTunnel` await — at which point `this.process` is the new process and its close handler would be a separate invocation.
- The real risk is that `recoveryAttempt` is reset to 0 on success (line 128) but never reset on partial failure. If the tunnel fails 2 of 3 attempts, succeeds on the 3rd, then immediately crashes again, the recovery counter is fresh. This is actually correct behavior — but the code lacks a re-entry guard (`this._recovering` flag) that would prevent overlapping recovery loops in pathological timing.

**Verdict:** Confirmed. Low practical risk but no guard against concurrent re-entry.

### Finding 3 (v2): State file atomicity correct but no locking — CONFIRMED, UNCHANGED

**Status:** Still present.

- `session-manager.js:331-342`: temp file + `renameSync` pattern is still correct.
- No file locking. Two Node processes writing the same state file would corrupt it, but this scenario requires two independent server instances — which ties back to Finding 1 (orphan processes).
- The Windows path (`session-manager.js:335-341`) still has the `unlinkSync` + `renameSync` non-atomic gap.

**Verdict:** Confirmed. Safe on POSIX, narrow corruption window on Windows.

### Finding 4 (v2): Config file permissions — CONFIRMED, UNCHANGED

**Status:** `setup.rs:34` still uses `fs::write()` with default permissions.

```rust
// setup.rs:34
if let Err(e) = fs::write(&path, json_str) {
```

This creates `~/.chroxy/config.json` with the umask default (typically 0o644), making the API token world-readable. The Node side uses `writeFileRestricted()` (`platform.js:12-18`) which does `writeFileSync` with `mode: 0o600` + `chmodSync`. The Rust side does not.

Additionally, `settings.rs:84` has the same issue:

```rust
// settings.rs:84
fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))
```

`desktop-settings.json` is written with default permissions. While this file does not contain the API token, it reveals the tunnel mode and window position — minor information leakage.

**Verdict:** Confirmed. `setup.rs:34` is critical (token exposure). `settings.rs:84` is low severity.

### Finding 5 (v2): Drop trait not called on SIGKILL — CONFIRMED, UNCHANGED

**Status:** Still present.

- `server.rs:365-369`: `Drop` for `ServerManager` calls `self.stop()`.
- On SIGKILL of the Tauri process, `Drop` is never invoked. Node.js child becomes an orphan.
- No process group (`setsid`) is used, so the kernel does not propagate the signal to children.

**Verdict:** Confirmed. This is the same as Finding 1 — the root cause of the orphan problem.

---

## New Failure Modes Investigated (v3)

### Failure Mode A: Server Restart with Active Sessions

**Scenario:** User clicks "Restart Server" in the tray menu while Claude is mid-response in an active session.

**Code path:**
1. `lib.rs:323-338`: `handle_restart()` calls `mgr.restart()`.
2. `server.rs:232-235`: `restart()` calls `self.stop()` then `self.start()`.
3. `server.rs:188-229`: `stop()` sends SIGTERM, waits 5s, then SIGKILL.
4. On SIGTERM, the Node server enters `server-cli.js:375-391`: `shutdown()` calls `wsServer.broadcastShutdown('shutdown', 0)`, then `sessionManager.destroyAll()`.
5. `session-manager.js:277-289`: `destroyAll()` calls `serializeState()` synchronously, then destroys all sessions.

**Analysis:**

The graceful path works: SIGTERM triggers synchronous state serialization before exit. Sessions are persisted and can be restored by the new server instance (`server-cli.js:75-78`).

**But:** The 5-second SIGTERM grace period (`server.rs:212`) may be insufficient if:
- Multiple sessions have in-flight Agent SDK queries. `session.destroy()` must abort the SDK process for each session. If the SDK process hangs (e.g., waiting on a network call), `destroy()` may take longer than 5s.
- `serializeState()` must stringify potentially large state (up to 125MB theoretical). `JSON.stringify` of 50MB takes ~1-2 seconds. Combined with destroy overhead, the 5s window may be tight.
- If SIGKILL fires at 5s, `destroyAll()` may not have completed. The state file reflects the last debounced persist (up to 2s stale), not the current in-flight state.

**Data loss window:** Between `broadcastShutdown` (clients notified) and `serializeState()` completing, any `stream_delta` events still in `_pendingStreams` are lost. `destroyAll()` does not flush `_pendingStreams` to history before serializing — it calls `serializeState()` first (line 281), which serializes the ring buffer. But `_pendingStreams` content is never committed to the ring buffer (that happens on `stream_end`, which never fires during forced shutdown).

**Impact:** Mid-stream responses are silently truncated. The restored session shows the last *completed* response, not the partial one. The user sees Claude's response cut off with no indication of data loss.

**Severity:** MEDIUM. Graceful path is sound but mid-stream data is lost.

### Failure Mode B: Two Tauri Instances Launch Simultaneously

**Scenario:** User double-clicks the app, or login auto-start races with manual launch.

**Code path:**
1. Tauri has no single-instance plugin configured. `Cargo.toml` includes `tauri`, `tauri-plugin-shell`, `tauri-plugin-autostart`, and `tauri-plugin-notification` — but NOT `tauri-plugin-single-instance`.
2. `tauri.conf.json` has no single-instance configuration.
3. Both instances call `setup::ensure_config()` (`lib.rs:49`). This is safe — `setup.rs:14` checks `if path.exists()` and returns early.
4. Both instances may call `handle_start()` (`lib.rs:59`) if `auto_start_server` is true.
5. `ServerManager::start()` (`server.rs:93-96`) checks `ServerStatus::Running | ServerStatus::Starting` — but this is per-process state. Each Tauri instance has its own `ServerManager` with `ServerStatus::Stopped`.
6. Both instances spawn `node cli.js start --no-supervisor`. The first one binds port 8765. The second one gets `EADDRINUSE` and crashes.
7. Instance 2's `ServerManager` transitions to `ServerStatus::Error` after the health check timeout (30s).
8. Meanwhile, Instance 1 is running normally. Instance 2 shows an error state in the tray menu.
9. If the user quits Instance 2, nothing happens (its child already crashed). If the user quits Instance 1, Instance 2 cannot recover because its `ServerManager.child` is `None`.

**The insidious case:** If Instance 1 is quit first, its child exits cleanly. Instance 2 is now running with no child and an error state. The user must manually quit Instance 2 and relaunch. There is no visual distinction between the two tray icons.

**But there is a worse case:** macOS tray apps can have multiple tray icons but the user sees only one. If Instance 2's tray icon is hidden behind Instance 1's, the user may not know Instance 2 exists. When they quit "the app" (Instance 1), the orphaned Instance 2 continues running invisibly with no child process and no way to interact with it.

**Impact:** Confusing UX, potential invisible orphan Tauri process. No data loss, but operational confusion.

**Severity:** HIGH for UX, LOW for data integrity. Missing `tauri-plugin-single-instance` is a straightforward fix.

### Failure Mode C: Node.js Server Crashes Mid-Persist

**Scenario:** The Node.js server process is OOM-killed or segfaults during `serializeState()`.

**Code path:**
1. `session-manager.js:331-342`: `serializeState()` does:
   - `writeFileRestricted(tmpPath, JSON.stringify(state, null, 2))` — writes to `.tmp` file
   - `renameSync(tmpPath, this._stateFilePath)` — atomic rename

2. If the process crashes DURING `writeFileRestricted`:
   - The `.tmp` file is partially written (corrupt JSON).
   - The previous `session-state.json` is untouched (safe).
   - On restart, `restoreState()` reads `session-state.json` (the old, complete version). The orphaned `.tmp` file is never cleaned up.

3. If the process crashes BETWEEN `writeFileRestricted` and `renameSync`:
   - The `.tmp` file is complete.
   - The old `session-state.json` is intact.
   - On restart, the old state is restored. The newer `.tmp` file is orphaned and never recovered.
   - This is a 1-2 instruction window — practically impossible to hit.

4. If the process crashes DURING `renameSync`:
   - On POSIX, `rename()` is atomic. The file is either the old version or the new version. No corruption.
   - On Windows, the `unlinkSync` + `renameSync` path (`session-manager.js:335-341`) has a window where the state file is deleted but not yet replaced. If the process crashes here, both files are gone. `restoreState()` finds no file, returns `null`, and a fresh session is created. **All persisted history is lost.**

5. If the process crashes DURING `JSON.stringify`:
   - `JSON.stringify` is synchronous. If the state object is so large it triggers OOM during serialization, the process dies. The `.tmp` file has not been written yet. Previous state file is intact.
   - However, `JSON.stringify(state, null, 2)` with pretty-printing creates a string ~30% larger than compact JSON. For large state, this matters.

**New finding:** The `.tmp` file is never cleaned up on startup. `restoreState()` (`session-manager.js:353-363`) reads only `session-state.json`. If a previous crash left an orphaned `.tmp` file, it persists forever. Over many crashes, orphaned `.tmp` files could accumulate (though realistically only one at a time since the path is fixed).

**Impact:** On POSIX, crash mid-persist is safe — previous state survives. On Windows, there is a narrow total-loss window. Orphaned `.tmp` files are a minor disk hygiene issue.

**Severity:** LOW on POSIX, MEDIUM on Windows.

### Failure Mode D: Cloudflared Crashes During Key Exchange

**Scenario:** The Cloudflare tunnel process crashes after a client has authenticated but before the E2E key exchange completes.

**Code path:**
1. Client connects via `wss://random.trycloudflare.com`, sends `auth` message.
2. Server authenticates, sends `auth_ok` with `encryption: 'required'` (`ws-server.js:733`).
3. Server sets `client.encryptionPending = true` and starts a 10s timeout (`ws-server.js:741-756`).
4. Server queues all subsequent messages (session list, history replay, etc.) in `client.postAuthQueue` (`ws-server.js:743`).
5. Client receives `auth_ok`, generates keypair, sends `key_exchange`.
6. **At this exact moment, cloudflared crashes.** The TCP connection is severed mid-flight.

**What happens:**
- The `key_exchange` message from the client is lost in transit (never reaches the server).
- The server's WebSocket detects the connection close via the TCP RST. The `close` handler (`ws-server.js:618-627`) fires, clears the key exchange timeout, and removes the client.
- The queued messages in `postAuthQueue` are garbage collected. No harm done server-side.
- The client detects the disconnect via heartbeat timeout (up to 5 seconds).
- The tunnel recovery loop starts (`base.js:92-156`). For Quick tunnels, the URL changes. The client cannot reconnect to the new URL without a new QR scan.
- For Named tunnels, the URL is stable. The client reconnects, re-authenticates, and completes key exchange successfully.

**The real problem is the server-side queued messages during key exchange:**

Between `auth_ok` and `key_exchange_ok`, the server eagerly queues messages: `server_mode`, `status`, `session_list`, `session_switched`, model info, history replay, available models, pending permissions (`ws-server.js:758-787`). All of these are queued in `postAuthQueue`. If the queue grows large (e.g., long history replay), this is unbounded memory allocation per client.

A malicious client could connect, authenticate, never send `key_exchange`, and force the server to queue messages for 10 seconds (the `_keyExchangeTimeoutMs`). During those 10 seconds, every session event, every `stream_delta`, every broadcast is queued. With a fast-streaming session, this could be thousands of messages.

But wait — examining the `_send` method (`ws-server.js:1192-1196`): the queue check is `if (client?.encryptionPending && client.postAuthQueue)`. This means ALL messages sent to this client during the 10s window are queued, not just the initial burst. If the server is broadcasting `stream_delta` at 20/s to this client, that is 200 messages queued over 10s. Each delta is small (~100 bytes), so ~20KB total. Not a real memory concern.

**But:** The key exchange timeout disconnect (`ws-server.js:745-755`) sets `client.encryptionPending = false` and `client.postAuthQueue = null`, then closes the socket. The queued messages are dropped. If the client was in the process of sending `key_exchange` when the timeout fires, there is a TOCTOU: the client's `key_exchange` message could arrive between the timeout firing and `ws.close()` completing. In Node.js, this cannot happen — `setTimeout` and `ws.on('message')` are both event loop tasks, so they cannot interleave. Safe.

**Impact:** Clean recovery for Named tunnels. Unrecoverable for Quick tunnels (needs new QR scan). No data corruption. Minor queued-message memory during the 10s window.

**Severity:** LOW for data integrity. The Quick tunnel URL instability is a known architectural limitation, not a crash-specific issue.

### Failure Mode E: Concurrent Config File Writes from Tauri and Node (NEW)

**Scenario:** The Tauri app writes `~/.chroxy/config.json` via `setup.rs` while the Node server is writing the same file via `writeFileRestricted()`.

**Code path:**
1. `setup.rs:34` uses `fs::write()` — a single atomic call on most OSes (writes to a buffer, then flushes).
2. The Node server can write `config.json` during token rotation (`token-manager.js` → `config.js`).
3. Neither side uses file locking or atomic rename for config writes.

**Analysis:** `setup.rs:ensure_config()` only writes if the file does not exist (`setup.rs:14`). It is called once during Tauri `setup` (`lib.rs:49`). After the file exists, the Rust side never writes it again. The Node server may write it during token rotation, but this happens while the server is running — and the Tauri setup has already completed. The race window is between first launch (config does not exist) and the Node server starting up. Since the Node server is spawned *after* `ensure_config()` returns (`lib.rs:59`), this race cannot occur.

**Verdict:** No race in practice. The code paths are sequenced. However, the `settings.rs:84` write (desktop-settings.json) uses `fs::write()` which is NOT atomic. If the Tauri app crashes during settings save (e.g., window resize event triggers save, app force-quit), the settings file could be partially written. On next launch, `serde_json::from_str` would fail, and `unwrap_or_default()` (`settings.rs:68`) would return defaults — silently losing user preferences.

**Severity:** LOW. Settings loss is annoying but not dangerous.

---

## Section-by-Section Ratings

### Section 1: Message Synchronization Mechanism — 2/5

**Change from v2:** Unchanged.

The fire-and-forget protocol with no acknowledgment, no gap detection, and no differential sync remains the fundamental data integrity weakness. The `seq` field (`ws-server.js:1199`) is generated but never validated by clients for continuity. Mid-stream disconnections silently lose `_pendingStreams` content. The audit document continues to describe these as "bottlenecks" rather than data-loss vectors.

**New observation:** During server restart (Failure Mode A), `destroyAll()` calls `serializeState()` but does NOT flush `_pendingStreams` to the ring buffer first. Any mid-stream response is permanently lost — not just for the reconnecting client, but for the persisted state file that the new server instance will restore.

### Section 2: Repository and Session Management — 3/5

**Change from v2:** Unchanged.

The atomic rename pattern is solid. The 2-second debounce window is the primary data-loss vector for ungraceful kills. The Windows path still has the narrow total-loss window. New observation: `.tmp` files are never cleaned up on startup.

### Section 3: Tunnel Implementation — 3/5

**Change from v2:** Unchanged.

Tunnel recovery is capped at 3 attempts with no reset-after-time mechanism. Quick tunnel URL changes on recovery require user intervention (new QR scan). The recovery loop lacks a re-entry guard. Named tunnel recovery is robust (URL stable, reconnect automatic).

### Section 4: WebSocket / Real-Time Communication Layer — 3/5

**Change from v2:** Unchanged.

The nonce increment before send issue (`ws-server.js:1205-1206`) remains. The `_send` method increments `sendNonce`, then calls `ws.send()`. If `ws.send()` throws (line 1211-1213), the nonce has been incremented but the message was never sent. The next successful send uses `sendNonce + 1`, but the client expects `sendNonce` (the one that was skipped). The client will reject with "Unexpected nonce" and the connection is effectively dead.

**New observation:** The `catch` block on line 1211 logs the error but does not decrement the nonce or close the socket. The connection is in an unrecoverable state — all subsequent sends will have wrong nonces — but neither side knows it. The client will eventually detect the issue when it receives the next message, but that could be seconds later.

### Section 5: Data Flow Diagram — 4/5

**Change from v2:** Unchanged. Accurate and useful. Still missing failure path annotations.

### Proposed Protocol Enhancements — 3/5

**Change from v2:** Unchanged. The proposals remain over-engineered for the current client count.

### Appendix: Existing Desktop App (Tauri) — 2.5/5

**Change from v2:** Downgraded from 3 to 2.5.

New finding: No `tauri-plugin-single-instance` means multiple Tauri instances can launch simultaneously. Combined with `auto_start_server: true` (the default, `settings.rs:10`), this creates a realistic failure mode where login auto-start and manual launch race. The audit document does not mention single-instance protection at all.

---

## Top 5 Findings

### Finding 1: CRITICAL — No Single-Instance Protection for Tauri App (NEW)

**Severity:** High
**Category:** Operational reliability, UX

**Evidence:**
- `Cargo.toml`: `tauri-plugin-single-instance` is NOT in the dependencies list.
- `tauri.conf.json`: No single-instance configuration.
- `settings.rs:10`: `auto_start_server` defaults to `true`.
- `lib.rs:56-61`: Auto-start on launch calls `handle_start()` unconditionally.
- `server.rs:93-96`: `start()` only checks its own in-process status, not external state.

**Failure scenario:**
1. **Trigger:** User enables "Start at Login" (`tauri-plugin-autostart`). On next login, the auto-start launches Instance A. User also manually opens Chroxy. Instance B launches.
2. **Observable behavior:** Instance A starts the Node server, binds port 8765. Instance B tries to start another Node server, gets `EADDRINUSE`, enters error state. Two tray icons appear (one working, one broken). User may not notice the duplicate.
3. **Blast radius:** If user quits the wrong instance (the working one), the broken instance remains running invisibly. The port is now free but the broken instance does not retry. User must force-quit the orphan Tauri process.
4. **Recovery procedure:** Manual — Activity Monitor → kill the duplicate. No programmatic detection.

**Recommendation:** Add `tauri-plugin-single-instance` to `Cargo.toml` and configure it. This is a one-line dependency addition plus ~5 lines of setup code. It is the standard Tauri pattern for tray apps.

### Finding 2: HIGH — _pendingStreams Not Flushed on Shutdown (NEW)

**Severity:** High
**Category:** Data loss, silent

**Evidence:**
- `session-manager.js:277-289`: `destroyAll()` calls `serializeState()` on line 281, THEN destroys sessions (lines 282-285).
- `session-manager.js:305-320`: `serializeState()` serializes `this._messageHistory` (the ring buffer).
- `session-manager.js:543-575`: `_pendingStreams` accumulates `stream_delta` text. Content is only committed to the ring buffer on `stream_end` (line 559-575).
- During shutdown, `stream_end` never fires for in-flight responses. The `_pendingStreams` content is never flushed.

**Failure scenario:**
1. **Trigger:** User restarts the server (tray menu → Restart) while Claude is mid-response. Or: SIGTERM is received during active streaming.
2. **Observable behavior:** The `shutdown()` function broadcasts `server_shutdown`, then calls `sessionManager.destroyAll()`. `serializeState()` writes the ring buffer — which does NOT contain the partial response still in `_pendingStreams`. The response-in-progress is silently discarded.
3. **Blast radius:** Per-session. Every session with an active stream at shutdown time loses its partial response. On restart, the session's history shows the last *completed* response, with no indication that a partial response was lost.
4. **Recovery procedure:** None. The partial response exists only in `_pendingStreams` in memory. The SDK's JSONL file may have the complete conversation, but the Chroxy history does not.

**Recommendation:** Add a `_flushPendingStreams()` method that commits all `_pendingStreams` entries to the ring buffer (as partial responses with a `[truncated — server restart]` marker). Call it at the top of `destroyAll()` before `serializeState()`.

### Finding 3: HIGH — Orphaned Node.js Process on Desktop SIGKILL (CONFIRMED from v2)

**Severity:** High
**Category:** Crash recovery, orphaned processes

**Evidence:** (unchanged from v2)
- `server.rs:365-369`: `Drop` for `ServerManager` calls `self.stop()`.
- `server.rs:188-229`: `stop()` sends SIGTERM, waits 5s, then SIGKILL.
- On SIGKILL of the Tauri process, `Drop` is never invoked.
- No PID file in `--no-supervisor` mode.

**Failure scenario:** (unchanged from v2)
1. **Trigger:** macOS force-quit, `kill -9`, OOM killer targets the Tauri process.
2. **Observable behavior:** Node.js server continues as orphan. Port remains bound. Tunnel stays active.
3. **Blast radius:** Port conflict prevents restart. Tunnel accepting connections to unsupervised server.
4. **Recovery procedure:** None automated. Manual `lsof -i :8765` and `kill`.

**v3 observation:** Combined with Finding 1 (no single-instance), this is worse than in v2. A second Tauri instance can launch, find the port in use, and present a confusing error — without detecting or cleaning up the orphan from the first instance.

**Recommendation:** (unchanged) Write a PID file in `--no-supervisor` mode. On Tauri startup, check for stale PIDs. Additionally, the `ServerManager::start()` method should probe the port before spawning and offer to kill the existing process.

### Finding 4: HIGH — Config File World-Readable (CONFIRMED from v2, EXPANDED)

**Severity:** High
**Category:** Security, credential exposure

**Evidence:**
- `setup.rs:34`: `fs::write(&path, json_str)` — uses default permissions (typically 0o644 on macOS/Linux).
- `settings.rs:84`: `fs::write(&path, json)` — same issue for desktop-settings.json.
- `platform.js:12-18`: Node side correctly uses `writeFileSync` with `mode: 0o600` + `chmodSync`.

**Impact:** The API token in `~/.chroxy/config.json` is readable by any process running as any user on the system. On a multi-user system (shared dev server, CI runner), any user can read the token and gain full access to all sessions, history, and the ability to execute arbitrary code via Claude.

**v3 expansion:** The `settings.rs:84` write also uses default permissions. While `desktop-settings.json` does not contain the API token, it reveals operational details (tunnel mode, window position). More importantly, the pattern demonstrates that the Rust side consistently ignores file permissions — any future config file added on the Rust side will inherit this vulnerability.

**Recommendation:** Create a Rust equivalent of `writeFileRestricted()`:
```rust
use std::os::unix::fs::OpenOptionsExt;
let file = std::fs::OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
    .mode(0o600)
    .open(&path)?;
```
Apply to both `setup.rs` and `settings.rs`.

### Finding 5: MEDIUM — Nonce Desync on ws.send() Failure Leaves Connection in Unrecoverable State (NEW detail on v2 finding)

**Severity:** Medium
**Category:** Data integrity, cryptographic safety

**Evidence:**
- `ws-server.js:1204-1213`:
  ```javascript
  if (client?.encryptionState) {
    const envelope = encrypt(JSON.stringify(message), client.encryptionState.sharedKey, client.encryptionState.sendNonce, DIRECTION_SERVER)
    client.encryptionState.sendNonce++  // line 1206: incremented BEFORE send completes
    ws.send(JSON.stringify(envelope))   // line 1207: can throw
  }
  ```
- `ws-server.js:1211-1213`: The `catch` block logs the error but does NOT:
  - Decrement the nonce
  - Close the connection
  - Mark the client as broken

**Failure scenario:**
1. **Trigger:** `ws.send()` throws because the underlying TCP connection entered a bad state (buffer full, connection reset not yet detected). This is rare but documented in the `ws` library.
2. **Observable behavior:** The nonce counter on the server advances past the failed message. All subsequent encrypted messages use nonces that the client does not expect. The client receives the next message, attempts decryption with the expected nonce, and gets "Decryption failed: message tampered or wrong key" (`crypto.js:107`). The client's connection handler closes the socket.
3. **Blast radius:** Single client loses its encrypted connection. The client must fully reconnect and re-derive keys. Mid-stream data between the failed send and the reconnect is lost.
4. **Recovery procedure:** Automatic — client detects the decryption failure, closes, and reconnects. But the user sees a brief interruption and potentially loses in-flight content.

**Recommendation:** In the `catch` block of `_send()`, close the WebSocket immediately when encryption is active:
```javascript
} catch (err) {
  console.error('[ws] Send error:', err.message)
  if (client?.encryptionState) {
    // Nonce desync — connection is unrecoverable
    ws.close(1011, 'Encryption nonce desync')
  }
}
```

---

## Failure Scenario Summary (All 12)

| # | Scenario | Source | Severity | Data Loss | Auto-Recovery |
|---|----------|--------|----------|-----------|---------------|
| 1 | Server SIGKILL mid-persist | v2 | Medium | Up to 2s of events | Yes (previous state) |
| 2 | Desktop app SIGKILLed | v2 | High | None | No — manual kill |
| 3 | Tunnel dies during active streaming | v2 | Medium | In-flight deltas | Partial (Named: yes, Quick: no) |
| 4 | Two clients send input simultaneously | v2 | Low | None | Yes |
| 5 | Checkpoint during active git ops | v2 | Medium | Corrupted snapshot | Manual (git reflog) |
| 6 | Token rotation during active session | v2 | Low | None | Yes (grace period) |
| 7 | Client reconnects during history replay | v2 | Low | None (wasteful) | Yes |
| 8 | Nonce counter overflow | v2 | Negligible | Theoretical | Yes (reconnect) |
| 9 | **Server restart with active sessions** | **v3 NEW** | Medium | Mid-stream responses | Yes (stale state) |
| 10 | **Two Tauri instances launch simultaneously** | **v3 NEW** | High | None | No — manual kill |
| 11 | **Node.js crash mid-persist** | **v3 NEW** | Low (POSIX) / Medium (Win) | Previous persist cycle | Yes (previous state) |
| 12 | **Nonce desync on send failure** | **v3 NEW** | Medium | Brief interruption | Yes (reconnect) |

---

## Overall Rating: 3.3 / 5

**Change from v2:** Up from 3.1.

**Rationale for increase:** My v2 findings remain confirmed and valid, but deeper investigation reveals that the overall architecture is more resilient than the individual findings suggest. The atomic rename pattern genuinely protects state integrity on POSIX. The key exchange protocol correctly handles tunnel crashes (no dangling state). The 5-second SIGTERM grace period is usually sufficient for clean shutdown. The `destroyAll()` → `serializeState()` path handles the graceful restart case correctly.

**Rationale for not going higher:** Two new findings push against the increase. The missing single-instance protection (Finding 1) is a straightforward oversight that creates a realistic operational failure mode — especially for non-technical users who may double-click the app. The `_pendingStreams` not being flushed on shutdown (Finding 2) is a silent data loss vector that affects every server restart with active sessions. The config permissions issue (Finding 4) remains unfixed and is the most critical security finding across all rounds.

**What would make this a 4/5:**
1. Add `tauri-plugin-single-instance` (Finding 1 — 30 min)
2. Fix config file permissions in `setup.rs` and `settings.rs` (Finding 4 — 30 min)
3. Flush `_pendingStreams` in `destroyAll()` (Finding 2 — 1 hour)
4. Close WebSocket on encrypted send failure (Finding 5 — 15 min)
5. Write PID file in `--no-supervisor` mode (Finding 3 — 2 hours)

Total estimated effort: ~4.5 hours. All findings are independently fixable without architectural changes.
