# Guardian Safety Audit: Chroxy Desktop Architecture

**Auditor:** Guardian (Security/SRE)
**Date:** 2026-02-28
**Subject:** `docs/audit-2026-02-28/desktop-architecture-audit.md` and supporting source files
**Scope:** Safety, failure modes, race conditions, data integrity, crash recovery, operational resilience

---

## Section-by-Section Ratings

### Section 1: Message Synchronization Mechanism — 2/5

**Justification:** The audit document accurately describes the event-driven push architecture, but it soft-pedals critical data integrity gaps. The protocol is explicitly fire-and-forget (at-most-once delivery) with no message acknowledgment, no gap detection, and no differential sync. The `seq` field exists (`ws-server.js:1199-1200`) but is never checked by clients for continuity. The document acknowledges "no message acknowledgment" and "full-state replay on reconnect" but rates them as mere "bottlenecks" rather than the data-loss vectors they actually are.

**Specific concerns:**
- A brief network blip during `stream_delta` delivery silently drops tokens. The user sees a truncated response with no indication that content was lost.
- The delta flush timer (`~50ms`) means accumulated text in the buffer is lost if the server crashes between flushes.
- History replay replays the *last response only* (`ws-server.js:826-836`), not the full ring buffer. If the disconnect happened mid-stream, the partial deltas accumulated in `_pendingStreams` are lost permanently since `stream_end` never fires.

### Section 2: Repository and Session Management — 3/5

**Justification:** The persistence model is well-designed with atomic write (temp + rename, `session-manager.js:331-342`) and the debounce pattern is appropriate. However, the 2-second debounce window (`session-manager.js:88`) creates a concrete data-loss window. The document mentions "state file is single-writer" and "no locking" but does not analyze the consequences: if `writeFileRestricted` writes to the temp file and the process is killed before `renameSync`, the temp file is orphaned and the previous state file remains intact (safe). If killed during `renameSync` itself, the behavior is filesystem-dependent (on most POSIX systems, `rename` is atomic, so this is safe). The real risk is the 2-second debounce: data accumulated in memory between the last persist and a crash is lost.

**Specific concerns:**
- The ring buffer (`_maxHistory = 500`) uses `shift()` in a while loop (`session-manager.js:637-639`), which is O(n) per eviction. With 500 messages, this is not a performance concern, but the document does not discuss the unbounded growth of `_pendingStreams` if `stream_end` never fires (e.g., session crashes mid-stream).
- Session state can grow large: 5 sessions * 500 messages * 50KB truncation limit = 125MB theoretical maximum for the state file. The document mentions this indirectly but does not call out the disk exhaustion risk.

### Section 3: Tunnel Implementation — 3/5

**Justification:** The tunnel recovery logic in `tunnel/base.js` is reasonable but brittle. Recovery is capped at 3 attempts with no reset mechanism once the cap is hit. The document correctly identifies this as a limitation ("Recovery limited to 3 attempts"). The encryption implementation is solid (XSalsa20-Poly1305, direction bytes in nonce, constant-time comparison). However, the document does not analyze what happens to in-flight data during tunnel recovery: the WebSocket connections are dropped, the client must detect the loss via heartbeat timeout (up to 5 seconds), reconnect, re-authenticate, re-derive encryption keys, and replay history. During this entire window, all user inputs submitted during the gap are either lost (if the offline queue is full or TTLs expire) or stale.

**Specific concerns:**
- Tunnel URL change on recovery (`base.js:130-136`) emits `tunnel_url_changed`, but connected clients are connected to the *old* URL. They must detect the disconnect, get the *new* URL somehow (QR code rescan or push notification), and reconnect. This is not a graceful migration.
- The document claims "Forward secrecy: ephemeral keys discarded after exchange" but does not verify that the server zeroes key material. Looking at `crypto.js`, the `secretKey` (Uint8Array) is returned and stored in `client.encryptionState` for the session duration. It is never explicitly zeroed on disconnect.

### Section 4: WebSocket / Real-Time Communication Layer — 3/5

**Justification:** The protocol design is well-structured with Zod schema validation, rate-limited auth, and clear message taxonomy. The heartbeat mechanism with EWMA-smoothed RTT is a nice touch. However, the document's analysis misses critical concurrency concerns. The Node.js event loop provides single-threaded execution for JavaScript, which eliminates low-level race conditions, but the `handleSessionMessage` function (`ws-message-handlers.js:95`) is `async` and can yield control via `await`. Between the session existence check and the actual `sendMessage()` call, the session could be destroyed by another client. The document does not discuss this TOCTOU window.

**Specific concerns:**
- The `_send` method (`ws-server.js:1190-1214`) increments `sendNonce` non-atomically with the actual send. If `ws.send()` throws, the nonce has already been incremented, creating a gap. The receiver will reject the next message as a replay ("Unexpected nonce").
- The 10MB `maxPayload` (`ws-server.js:188`) means a malicious or buggy client can send a 10MB JSON message that must be fully parsed before validation. Combined with Zod validation on every message, this could cause a brief CPU spike.

### Section 5: Data Flow Diagram — 4/5

**Justification:** The diagram is accurate and comprehensive. The message flow descriptions correctly trace the data path end-to-end. The reconnection flow accurately documents the sequence. I dock one point because the diagram omits the failure cases: there is no indication of what happens when any box in the diagram fails, no circuit breaker annotations, and no mention of the data-loss windows at each hop.

### Proposed Protocol Enhancements — 3/5

**Justification:** The differential sync, IPC channel, and message priority proposals are sound in principle. However, the backward compatibility claim ("existing clients continue using protocol version 1") is untested and the audit document provides no migration path for the race condition where a v2 client connects to a v1 server or vice versa. The `ack`-based gap detection proposal does not specify what happens when a gap is detected: does the server re-send individual messages, or trigger a full replay? The proposal is silent on this.

### Appendix: Existing Desktop App (Tauri) — 3/5

**Justification:** The Tauri tray app summary is accurate. The `Drop` implementation on `ServerManager` (`server.rs:365-369`) calls `stop()`, which sends SIGTERM and waits 5 seconds before SIGKILL. This is correct for graceful shutdown. However, the summary does not analyze what happens if the Tauri app itself is SIGKILLed: the `Drop` implementation is *never called* on SIGKILL, leaving the Node.js child process orphaned.

---

## Top 5 Findings

### Finding 1: CRITICAL -- Orphaned Node.js Process on Desktop SIGKILL

**Severity:** High
**Category:** Crash recovery, orphaned processes

**Evidence:**
- `packages/desktop/src-tauri/src/server.rs:365-369`: `Drop` for `ServerManager` calls `self.stop()`.
- `server.rs:188-229`: `stop()` sends SIGTERM, waits 5s, then SIGKILL.
- **But:** On SIGKILL of the Tauri process, `Drop` is never invoked. The child Node.js process continues running, holding the port. The tunnel (if managed by the Node process with `--no-supervisor`) also continues running.

**Failure scenario:**
1. **Trigger:** macOS force-quits the Tauri app (Activity Monitor, `kill -9`, OOM killer).
2. **Observable behavior:** Node.js server continues running as an orphan. Port remains bound. Tunnel stays active. User sees "server already running" error on next launch.
3. **Blast radius:** Port conflict prevents restart. Users must manually `kill` the Node process. The tunnel keeps accepting connections to a now-unsupervised server.
4. **Recovery procedure:** None automated. User must `lsof -i :8765` and `kill` manually. No PID file is written by the `--no-supervisor` path (PID file is a supervisor-only feature: `supervisor.js:224-230`).

**Recommendation:** Write a PID file in the Node server's `--no-supervisor` mode. On Tauri startup, check for stale PID files and kill orphan processes. Alternatively, use a process group (setsid) so SIGKILL propagates.

### Finding 2: HIGH -- 2-Second Data Loss Window on Server Kill Mid-Persist

**Severity:** High
**Category:** Data integrity

**Evidence:**
- `packages/server/src/session-manager.js:654-663`: `_schedulePersist()` debounces with 2-second delay.
- `session-manager.js:331-342`: `serializeState()` writes temp file, then `renameSync`.
- `session-manager.js:573`: `_schedulePersist()` is called on `stream_end`.
- `session-manager.js:617`: `_schedulePersist()` is called on `result`.

**Failure scenario:**
1. **Trigger:** Server process killed (OOM, SIGKILL, power failure) within 2 seconds after `stream_end` fires but before the debounced `serializeState()` runs.
2. **Observable behavior:** The completed response is in the in-memory ring buffer but never written to disk. On restart, the restored session is missing the last 1-2 complete responses.
3. **Blast radius:** Per-session. Only the session(s) that had recent activity lose data. Cost tracking data in `_sessionCosts` is also lost (budget accounting becomes inaccurate).
4. **Recovery procedure:** None. The data exists only in memory. The SDK conversation JSONL file (`~/.claude/projects/`) may have the data, but only if the SDK session completed successfully.

**Note:** The `destroyAll()` method (`session-manager.js:277-289`) does call `serializeState()` synchronously, which handles graceful SIGTERM. The risk is only for ungraceful kills.

**Recommendation:** Reduce debounce to 500ms for critical events (result, stream_end). Consider an immediate write-through for budget-paused state transitions since budget enforcement losing state means a paused session could be un-paused on restart.

### Finding 3: HIGH -- Checkpoint Git Stash Race Condition During Active Writes

**Severity:** High
**Category:** Race condition, data integrity

**Evidence:**
- `packages/server/src/checkpoint-manager.js:195-227`: `_createGitSnapshot()` runs `git stash push --include-untracked`, then `git tag`, then `git stash pop`.
- `packages/server/src/ws-message-handlers.js:130-136`: Auto-checkpoint is created on every `input` message, *before* the query is sent to Claude (`entry.session.sendMessage` is on line 141).
- The auto-checkpoint is fire-and-forget: `.catch((err) => console.warn(...))`.

**Failure scenario:**
1. **Trigger:** User sends a message. Auto-checkpoint begins `git stash push`. Simultaneously, Claude from a *previous* query is still writing files via the Agent SDK (the session may be "busy" from a prior tool use that is still completing).
2. **Observable behavior:** `git stash push --include-untracked` captures a *partial* file write. The stash contains a half-written file. The tag points to corrupted state. If the user later restores this checkpoint, they get a broken codebase.
3. **Blast radius:** The restored checkpoint has corrupted files. The user may not notice until they try to build or run the project.
4. **Recovery procedure:** Manual: `git stash list`, find the correct stash, or use `git reflog` to find the pre-restore state.

**Mitigating factor:** The auto-checkpoint fires *before* `sendMessage`, so for the *current* query, Claude has not started writing yet. The race is with *concurrent* sessions or *still-completing* previous queries in the same session.

**Recommendation:** Check `entry.session.isRunning` before creating a checkpoint. If busy, skip or defer the auto-checkpoint. The manual checkpoint handler (`ws-message-handlers.js:574-576`) already checks `isRunning`, but the auto-checkpoint path does not.

### Finding 4: MEDIUM -- Nonce Counter Overflow Causes Silent Encryption Failure

**Severity:** Medium
**Category:** Data integrity, cryptographic safety

**Evidence:**
- `packages/server/src/crypto.js:52-62`: `nonceFromCounter(n, direction)` writes the counter as a little-endian uint64 across bytes 1-8.
- The counter is incremented in `ws-server.js:1206`: `client.encryptionState.sendNonce++`.
- JavaScript `Number` has 53 bits of integer precision. At 2^53, incrementing produces 2^53 (no change). The nonce would repeat silently.

**Failure scenario:**
1. **Trigger:** A client maintains a connection long enough to exchange 2^53 messages (approximately 9 * 10^15). At 1000 messages/second, this would take ~285 million years. This is practically unreachable.
2. **Observable behavior:** Nonce reuse, allowing an attacker to XOR two ciphertexts and recover plaintexts.
3. **Blast radius:** Theoretical only. The connection would be dropped and re-established long before this limit.
4. **Recovery procedure:** Reconnect (new ephemeral keys, nonce resets to 0).

**Assessment:** Practically zero risk. The ephemeral key exchange on every reconnect resets the nonce. Still, the code should assert `n < Number.MAX_SAFE_INTEGER` for defense in depth.

### Finding 5: MEDIUM -- History Replay Not Resilient to Mid-Replay Disconnection

**Severity:** Medium
**Category:** Recovery gaps

**Evidence:**
- `packages/server/src/ws-server.js:821-844`: `_replayHistory()` iterates over history entries and sends each one synchronously via `_send()`.
- There is no tracking of how far the replay got. If the client disconnects mid-replay (e.g., network drop after receiving `history_replay_start` but before `history_replay_end`), the next reconnect starts a fresh replay from the beginning.
- The replay only sends the last response (`ws-server.js:829-834`), not the full buffer. But `request_full_history` (`ws-message-handlers.js:407-433`) replays the *entire* JSONL file.

**Failure scenario:**
1. **Trigger:** Client reconnects over a slow/unstable connection. History replay begins. Connection drops after receiving 300 of 500 messages. Client reconnects again.
2. **Observable behavior:** Full replay restarts. The client receives the first 300 messages again (wasted bandwidth, potential UI flicker from duplicate processing). Client-side deduplication (`message-handler.ts:859-869` per the audit doc) should handle this, but it relies on message identity matching which may not be perfect for all message types.
3. **Blast radius:** Poor user experience (delay, flicker). No data loss.
4. **Recovery procedure:** Automatic on next successful reconnect.

**Recommendation:** Use the `seq` field already present on server-sent messages to implement resume-from-seq on reconnect. The infrastructure is already there; it just needs the client to send `lastSeq` on auth and the server to skip messages below that seq.

---

## Failure Scenario Analysis (All 10)

### 1. Server process killed mid-persist

**File:** `packages/server/src/session-manager.js`

| Aspect | Detail |
|--------|--------|
| Debounce window | 2000ms (`session-manager.js:88`) |
| Persist mechanism | `writeFileRestricted` to `.tmp`, then `renameSync` (`session-manager.js:333-342`) |
| Data lost | All in-memory state accumulated since last persist: recent messages in ring buffer, cost tracking updates, budget state |
| Corruption risk | **Low.** `renameSync` is atomic on POSIX. On Windows, the code explicitly `unlinkSync` first (`session-manager.js:335-341`), creating a brief window where neither file exists. If killed between `unlinkSync` and `renameSync`, both old and new state files are gone. Recovery reads `null` and starts fresh. |
| `writeFileRestricted` | Writes with `mode: 0o600`, then `chmodSync` (`platform.js:12-18`). Not atomic -- the file is world-readable for a brief moment between `writeFileSync` and `chmodSync` on systems that ignore the mode parameter in `writeFileSync`. |

**Verdict:** The atomic rename pattern is solid. The real risk is the 2-second debounce window and the Windows double-write gap. Rating: **3/5** -- data loss possible in a narrow window, no corruption.

### 2. Desktop app SIGKILLed

**File:** `packages/desktop/src-tauri/src/server.rs`

| Aspect | Detail |
|--------|--------|
| `Drop` implementation | Calls `stop()` which sends SIGTERM, waits 5s, then SIGKILL (`server.rs:188-229`) |
| SIGKILL behavior | `Drop` is **not called** on SIGKILL. The Node child process becomes an orphan. |
| Port release | The orphaned Node process continues holding the port. |
| Tunnel cleanup | The Node server was started with `--no-supervisor` (`server.rs:141`), meaning the tunnel is managed by the Node server itself. It keeps running. |
| PID tracking | No PID file in `--no-supervisor` mode. No way to find the orphan programmatically. |

**Verdict:** Orphaned process is the primary risk. No automated recovery. Rating: **2/5** -- realistic failure causes persistent broken state.

### 3. Tunnel dies during active streaming

**File:** `packages/server/src/tunnel/base.js`

| Aspect | Detail |
|--------|--------|
| Detection | Client detects via heartbeat pong timeout (5 seconds). Server detects via `tunnel_lost` event from process exit handler. |
| In-flight deltas | **Lost.** The WebSocket connection is severed. Any `stream_delta` messages in transit are dropped. The delta buffer in `EventNormalizer` is flushed on the next timer tick but to a dead socket. |
| Gap detection | **None.** No acknowledgment protocol. The client has no way to know how many deltas it missed. |
| Recovery time | 3s + tunnel restart time (up to 30s) + health check verification (up to 20s) = 53 seconds worst case. Plus client reconnect (up to 5 retries with exponential backoff). Total: potentially 1-2 minutes. |
| Quick tunnel URL change | On recovery, Quick tunnel gets a new random URL. Client cannot reconnect without user intervention (new QR scan). |

**Verdict:** Data loss is guaranteed for in-flight messages. Quick tunnel recovery requires user intervention. Rating: **2/5** for Quick tunnel, **3/5** for Named tunnel.

### 4. Two clients send input simultaneously

**File:** `packages/server/src/ws-message-handlers.js`

| Aspect | Detail |
|--------|--------|
| Locking | **None.** Both inputs are dispatched to the event loop sequentially (Node.js single-threaded). |
| Concurrent queries | `session.sendMessage()` is called for both. The SDK session behavior depends on the provider: `SdkSession` queues queries internally (the Agent SDK handles concurrency), `CliSession` sends to stdin which the CLI process handles sequentially. |
| Last-writer-wins | `updatePrimary()` is called for both inputs, with the second one winning (`ws-server.js:1107-1117`). |
| Budget check | `isBudgetPaused` is checked before `sendMessage`. Between the check and the send, the budget could be exceeded by the other concurrent query. Not a correctness issue (the query will just run), but the budget is "soft". |

**Verdict:** Safe due to Node.js event loop serialization and SDK internal queuing. The "two queries at once" scenario is handled by the provider. Rating: **4/5** -- functionally safe, but no user-facing coordination (both clients see each other's inputs interleaved).

### 5. Checkpoint created during active git operations

**File:** `packages/server/src/checkpoint-manager.js`

| Aspect | Detail |
|--------|--------|
| Trigger | Auto-checkpoint on `input` (`ws-message-handlers.js:130-136`), which is fire-and-forget. |
| `git stash push` safety | `git stash` captures the working tree atomically from git's perspective, but if a file is being written by Claude (via `Write` tool) at the exact moment of the stash, the stash captures the partial write. |
| Stash/pop failure path | If `git stash push` succeeds but `git tag` or `git stash pop` fails, the catch block attempts `git stash pop` recovery (`checkpoint-manager.js:223`). If both fail, the working tree is left in the post-stash state (clean), and the user's changes are trapped in the stash stack. |
| Concurrent checkpoint + write | No lock prevents concurrent `_createGitSnapshot` and Claude file operations. |

**Verdict:** The auto-checkpoint fires before `sendMessage`, which mitigates the most common race. But concurrent sessions or still-completing previous queries can still conflict. Rating: **3/5** -- mostly safe in practice, but the failure mode (corrupted snapshot) is hard to detect.

### 6. Token rotation during active session

**File:** `packages/server/src/token-manager.js`

| Aspect | Detail |
|--------|--------|
| Grace period | 5 minutes default (`token-manager.js:20`). Old token remains valid during grace. |
| Client notification | `token_rotated` is broadcast to all clients (`ws-server.js:289-295`). The new token is NOT sent to clients -- they must re-authenticate. |
| Already-authenticated clients | Remain authenticated. Token validation only happens on initial `auth` message. Existing WebSocket connections are not terminated on rotation. |
| Reconnect during rotation | If a client disconnects and reconnects within the grace period, the old token still works. After grace period, the old token is invalidated (`token-manager.js:124-128`) and the client cannot reconnect without the new token. |
| New token distribution | **No automated mechanism.** The user must re-scan the QR code or get the new token from the server logs/config. |

**Verdict:** Well-designed grace period. The risk is that after grace expiry, there is no way for a remote client to obtain the new token without physical access to the server. Rating: **4/5** -- robust during grace, but requires manual intervention afterward.

### 7. Client reconnects during history replay

**File:** `packages/server/src/ws-server.js:821-844`

| Aspect | Detail |
|--------|--------|
| Replay mechanism | Synchronous iteration over history array, calling `_send()` for each entry. |
| Mid-replay disconnect | The `ws.send()` in `_send()` throws or silently fails for a closed socket. The remaining messages are lost. |
| Next reconnect | A fresh `_replayHistory()` starts from scratch. No resume capability. |
| Deduplication | Client-side responsibility. No server-side tracking of replay progress. |

**Verdict:** No data loss (replay restarts), but wasteful. Rating: **3/5** -- no corruption, just inefficiency.

### 8. Nonce counter overflow

**File:** `packages/server/src/crypto.js:52-62`

| Aspect | Detail |
|--------|--------|
| Counter type | JavaScript `Number` (IEEE 754 double). Safe integer range: 0 to 2^53 - 1. |
| Overflow behavior | At `Number.MAX_SAFE_INTEGER + 1`, the increment produces the same value. Nonce repeats silently. |
| Practical risk | At 10,000 messages/second: 2^53 / 10000 / 86400 / 365 = 28 million years. |
| Mitigation | Ephemeral keys are regenerated on every reconnect, resetting the counter. |

**Verdict:** Theoretical only. Rating: **5/5** -- no practical risk.

### 9. State file grows unbounded

**File:** `packages/server/src/session-manager.js:305-345`

| Aspect | Detail |
|--------|--------|
| Max entries | 500 messages per session (`_maxHistory = 500`, line 92). |
| Truncation | Content/input fields > 50KB are truncated (`_truncateEntry`, line 670-680). |
| Max sessions | 5 (hardcoded at construction, line 75). |
| Theoretical max | 5 sessions * 500 messages * ~50KB = **125MB**. Plus cost tracking, budget arrays: negligible. |
| Actual max | Most messages are small (tool_start, result, etc.). Only `message` type entries carry content. Realistic worst case: ~25-50MB. |
| Disk exhaustion risk | On a typical dev machine, 125MB is negligible. But on a resource-constrained system (CI runner, small VM), this could be a concern if many restarts accumulate temp files. |
| JSON serialization | `JSON.stringify(state, null, 2)` with pretty-printing. The pretty-printed JSON is ~30% larger than compact. |

**Verdict:** Bounded but large. No cleanup of old state files. The 24-hour TTL (`_stateTtlMs`, line 87) prevents indefinite accumulation across restarts. Rating: **4/5** -- bounded, but could use compact JSON and a size cap.

### 10. Server OOM during large file diff

**File:** `packages/server/src/ws-file-ops.js:330-497`

| Aspect | Detail |
|--------|--------|
| `git diff` output | Captured via `execFileAsync` with `maxBuffer: 2 * 1024 * 1024` (2MB) (`ws-file-ops.js:348-349`). |
| Staged diff | Also 2MB max (`ws-file-ops.js:384`). Combined: up to 4MB in memory. |
| Untracked files | Each file read up to 50KB (`MAX_UNTRACKED_SIZE`, line 424), max 10 files = 500KB. |
| File read | `readFile` handler (`ws-file-ops.js:261`): rejects files > 512KB. |
| Total memory per request | Up to ~4.5MB per `get_diff` request. Multiple concurrent requests could multiply this. |
| OOM risk | Low for a single request. With N concurrent clients each requesting diffs, memory = N * 4.5MB. For 10 clients: 45MB. |
| Timeout | 10-second timeout on git commands (`ws-file-ops.js:349`). Prevents indefinite hangs. |

**Verdict:** Bounded by `maxBuffer` and file size limits. Multiple concurrent requests are the main risk, but they are bounded by the number of clients. Rating: **4/5** -- well-bounded with appropriate limits.

---

## Overall Rating: 3.1 / 5

**Verdict:** Chroxy's architecture is well-considered for the happy path and handles most graceful shutdown scenarios correctly. The atomic rename for state persistence, constant-time token comparison, XSalsa20-Poly1305 encryption with direction-tagged nonces, and the Zod schema validation layer all demonstrate security awareness. However, the system has significant gaps in crash recovery and ungraceful failure modes. The orphaned process problem on desktop SIGKILL is the most operationally impactful finding -- it leaves users in a state that requires manual intervention with no guidance from the application. The fire-and-forget protocol design means any connection interruption during active streaming causes silent data loss with no mechanism for the user to detect or recover the gap. The checkpoint system's lack of coordination with active file operations is a time bomb that produces corrupted snapshots under load. These issues are all addressable without fundamental architecture changes, but they represent real operational risks that would cause pain at 3am. The audit document describes the architecture accurately but consistently underweights failure modes in favor of feature descriptions and enhancement proposals.
