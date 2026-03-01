# Guardian's Audit: Desktop Architecture Audit

**Agent**: Guardian -- Paranoid security/SRE who designs for 3am pages
**Overall Rating**: 3.2 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Section 1: Message Sync | 3/5 | `broadcastToSession` behavior misstated; `seq` limitations not addressed |
| Section 2: Repo/Session Mgmt | 3/5 | Debounced persist crash window; no state file integrity check |
| Section 3: Tunnel Implementation | 3/5 | Recovery message loss unaddressed; "production-grade" encryption overstated |
| Section 4: WebSocket/Real-Time | 4/5 | Most thorough section; minor rate-limit logging inconsistency |
| Section 5: Data Flow Diagram | 4/5 | Accurate diagrams; minor simplification of pipeline stages |
| Proposed Protocol | 3/5 | Sound ideas but missing ring buffer eviction handling and IPC security model |

---

## Top 5 Findings

### Finding 1: Nonce Counter Precision Limit (HIGH)

**File:** `crypto.js:52-62`

The nonce counter is a JavaScript `number` (IEEE 754 double) used as an 8-byte little-endian integer. JavaScript loses integer precision above `Number.MAX_SAFE_INTEGER` (2^53 - 1). The `nonceFromCounter` function uses `Math.floor(val / 256)` which will produce incorrect results when `val > 2^53`. The document implies 8 bytes = 2^64 capacity. The actual safe capacity is 2^53.

**Practical risk:** Extremely low (285 million years at 1000 msg/s). But the gap between documented and actual behavior is a correctness issue.

### Finding 2: 2-Second Debounce Window Loses Data on Crash (HIGH)

**File:** `session-manager.js:654-664`

`_schedulePersist()` uses a 2-second debounce. If the process is killed (SIGKILL, OOM, power failure) during this window, state changes since last persist are lost. This includes:
- Cost tracking data -- budget enforcement silently bypassed
- Session history -- most recent conversation turn disappears
- Budget warning/exceeded flags reset

`destroyAll()` at line 277-289 calls `serializeState()` synchronously for graceful shutdown, but SIGKILL and OOM skip this entirely. No crash recovery logic in `restoreState()`.

**Recommendation:** Write cost updates immediately (not debounced), or use a write-ahead log. At minimum, fsync the temp file before rename.

### Finding 3: Checkpoint Creation Is Non-Atomic (MEDIUM)

**File:** `checkpoint-manager.js:195-227`

Multi-step git operation that is not atomic:
1. `git stash push --include-untracked` (modifies working tree)
2. `git tag chroxy-checkpoint/{id} stash@{0}` (creates tag)
3. `git stash pop` (restores working tree)

If process crashes between step 1 and 3, working tree is left in stashed state with uncommitted changes missing. Recovery at line 223 is best-effort catch block only.

Additionally, `_persist` at line 300-308 uses `writeFileRestricted` (not atomic temp+rename), so checkpoint JSON write can corrupt on crash.

### Finding 4: Token Rotation Grace Period Attack Surface (MEDIUM)

**File:** `token-manager.js:76-81`, `ws-server.js:288-298`

During the 5-minute grace period, both old and new tokens are valid. An attacker with the old token (e.g., from a QR code screenshot) can still authenticate. The `token_rotated` broadcast does not include the new token, so connected mobile clients cannot seamlessly re-authenticate -- they're effectively disconnected until they manually get the new token.

### Finding 5: `broadcastToSession` Leaks Cross-Session Data (MEDIUM)

**File:** `ws-server.js:1038-1045`

All authenticated clients receive all sessions' messages. This is both a bandwidth waste and information leak. With 5 active sessions streaming, each client processes 5x the data. All stream_delta traffic, file contents, and tool inputs from every session are transmitted to every client.

---

## Failure Scenario Analysis

| Scenario | Outcome | Severity |
|----------|---------|----------|
| Server crashes mid-persist | State file safe (temp+rename), but 2s of data lost | Medium |
| Tunnel dies during streaming | In-flight deltas in `_pendingStreams` lost on reconnect | Medium |
| Two clients send conflicting input | Both reach backend; first processed, second depends on `isRunning` state | Low |
| Desktop app SIGKILLed | Node.js child orphaned; port held until manual cleanup | Medium |
| Token rotation during active session | Existing connections unaffected; mobile clients can't reconnect without new token | Medium |
| Nonce counter overflow | Decrypt fails due to precision loss; connection breaks | Very Low |
| Client reconnects during replay | No corruption; dedup is O(N*M) but correct | Low |

---

## Verdict

The system is well-designed for the happy path. The recovery gaps are in edge cases -- crash during debounce window, SIGKILL of the desktop app, tunnel recovery during active streaming. None will cause data corruption (temp+rename prevents that), but they will cause data loss (recent state, in-flight messages, orphaned processes). For a tool with real monetary cost tracking (budget enforcement), the 2-second persist window for cost data is the most operationally concerning finding.
