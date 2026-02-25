# Guardian's Audit: Local Desktop Chat Hub for Chroxy

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages. Finds race conditions and nuclear scenarios.
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-24

---

## Section Ratings

| Section | Rating | Justification |
|---------|--------|---------------|
| Multi-client Safety | 2/5 | No session locking -- multiple clients can send conflicting input simultaneously |
| Config File Safety | 2/5 | Non-atomic writes to `~/.chroxy/config.json` and `session-state.json` |
| Process Cleanup | 3/5 | Server cleanup is good but force-kill can orphan sub-agent processes |
| Localhost Security | 3/5 | Token auth exists but localhost exposure has risks on shared machines |
| Data Integrity | 4/5 | Session state serialization has reasonable safeguards (TTL, error handling) |

---

## Top 5 Findings

### 1. Multi-Client Conflict: No Session Locking

The server supports multiple simultaneous WebSocket clients (`ws-server.js` tracks `_primaryClients`). When both a desktop dashboard and mobile app are connected:
- Both can send `user_input` to the same session
- Last-writer-wins semantics -- no conflict detection
- No "someone else is typing" indicator
- No visual indication that another client has primary control

In a desktop hub scenario, a developer might have the dashboard open AND a browser tab at `/dashboard` AND the mobile app -- all connected to the same session. Simultaneous input from multiple clients could produce confusing results.

**Evidence:** `ws-server.js` assigns primary client but doesn't prevent non-primary clients from sending input. The `ConnectedClient` type tracks `isSelf` but doesn't enforce exclusivity.

### 2. Non-Atomic Config Writes

`config.js` uses `withSettingsLock()` (a promise chain) for serialized writes, but the actual file write (`fs.writeFileSync`) is not atomic. On crash or power loss during write, the config file can be corrupted (truncated or empty).

Similarly, `session-manager.js:serializeState()` writes session state to `~/.chroxy/session-state.json`. If the server crashes during serialization, the state file can be corrupted, losing all session history.

**Recommended fix:** Write to a temp file, then atomically rename (`fs.renameSync`). This is a standard pattern for config file safety.

### 3. Orphaned Sub-Agent Processes on Force-Kill

When Claude Code spawns sub-agents (via the `Task` tool), these run as child processes. If the server is force-killed (`kill -9`), the child process tree may not be fully cleaned up:
- The supervisor (`supervisor.js`) handles graceful shutdown with `SIGTERM` cascading
- But `kill -9` bypasses signal handlers entirely
- Orphaned Claude Code processes continue running, consuming API credits

The Tauri app's "Stop Server" button sends `SIGTERM` (graceful), but if the user force-quits the Tauri app or the system crashes, orphaned processes can result.

**Evidence:** `server.rs` uses `child.kill()` which sends `SIGTERM` on Unix. But the Tauri `window_event` handler for `CloseRequested` only hides the window, doesn't stop the server.

### 4. Localhost Security Model

The dashboard is served at `http://localhost:{port}/dashboard?token={token}` with the token in the URL query string. Security concerns:
- Token visible in browser history (if opened outside Tauri WebView)
- Token visible in access logs
- Token visible in WebView developer tools
- Any local process can connect to the WebSocket port (no origin checking beyond token)

For a single-user developer machine, this is acceptable. But on shared machines (university labs, pair programming setups), any process running as any user can access the token and control Claude Code sessions.

**Mitigation:** The token is auto-generated UUID (`setup.rs:28`), and the Tauri app doesn't expose the URL in the address bar. But the risk increases as the desktop hub becomes a primary interface.

### 5. Server Health Polling Race Condition

The Tauri app's `poll_health()` (`server.rs:217-243`) starts a background thread that polls `http://localhost:{port}` every second for up to 60 seconds. If two start commands fire in quick succession (e.g., user double-clicks "Start Server" in tray menu), two polling threads run concurrently. The second one might detect the first's server as healthy and emit duplicate `server-ready` events.

**Evidence:** `server.rs` spawns polling threads with `std::thread::spawn`. There's no guard against concurrent polls.

---

## Recommendations

1. **Add write-ahead-log or atomic rename for config/state files.** Use `write-to-temp + rename` pattern for `config.json` and `session-state.json`.
2. **Add session input locking.** When a client sends input to a session, lock that session for 5 seconds or until the response completes. Show "Controlled by [device]" to other clients.
3. **Move token from URL query to WebSocket auth handshake only.** The dashboard already sends the token via WS `auth` message. Don't also put it in the URL.
4. **Add process group cleanup.** On server shutdown, use `process.kill(-pid, 'SIGTERM')` to kill the entire process group, not just the direct child.
5. **Add mutex guard for health polling.** Use an `AtomicBool` in the Tauri state to prevent concurrent poll threads.

---

## Verdict

The infrastructure is reasonably safe for a single-developer, single-machine setup. The biggest risks emerge when the desktop hub makes it easy to have multiple clients connected simultaneously -- the lack of session locking and input conflict resolution becomes a real usability and safety concern. Config file corruption on crash is a latent bug that will eventually hit someone. The localhost security model is adequate for now but should be hardened if the desktop hub becomes the primary daily-use interface.
