# Tester's Audit: Happy vs Chroxy Architecture

**Agent**: Tester -- QA engineer who thinks in edge cases and coverage gaps
**Overall Rating**: 3.7 / 5
**Date**: 2026-02-19

---

## Section-by-Section Ratings

| # | Section | Rating | Notes |
|---|---------|--------|-------|
| 1 | Topology | 4/5 | Diagrams testable, trust boundaries map to integration test boundaries |
| 2 | Wire Protocol | 4/5 | Message enumeration directly maps to test scenarios |
| 3 | Ordering | 5/5 | Ordering guarantees are the most testable claims in the document |
| 4 | Providers | 3/5 | Provider testing strategy not addressed, each provider needs its own suite |
| 5 | Connectivity | 4/5 | Reconnection scenarios are high-value test targets |
| 6 | Events | 4/5 | Event flow provides natural test boundaries |
| 7 | Encryption | 4/5 | Encryption is testable but currently has zero integration tests |
| 8 | State | 4/5 | State management edge cases are where bugs live |
| 9 | RPC | 3/5 | RPC is not relevant (Chroxy doesn't have it) — wasted analysis |
| 10 | Feature Matrix | 3/5 | Feature comparison doesn't map to test priorities |

---

## Current Test Coverage Assessment

### What Exists

- **1,095 test cases** across the server package
- **4 E2E flows** (Maestro) covering ConnectScreen only
- Unit tests for: session management, WS protocol, output parser, tunnel, config, push notifications, providers, models, permission manager
- Integration tests for: WS server connection flow, session lifecycle

### What's Missing

The document highlights several architectural claims that have zero test coverage:

---

## Top 5 Test Coverage Gaps

### 1. History Replay Completely Untested (CRITICAL)

**Severity**: Critical

`_replayHistory()` in `session-manager.js` is called on every reconnection to bring the client up to date. It has **zero tests**.

**What could go wrong**:
- Replayed messages could be malformed (missing fields added since initial send)
- Replay ordering could be wrong (ring buffer wraps, oldest messages first?)
- Replay of transient events (permission_request) could trigger duplicate prompts
- Replay during active streaming could interleave with live messages
- Empty history replay could crash the client (empty array vs. no message)

**Test scenarios needed**:

```javascript
describe('_replayHistory', () => {
  it('should replay messages in chronological order')
  it('should not replay transient events (permission_request, plan_started)')
  it('should handle empty history without error')
  it('should handle ring buffer wraparound correctly')
  it('should not replay more than maxHistory messages')
  it('should not interleave with active streaming')
  it('should handle reconnect during active stream (inject stream_end)')
  it('should include seq numbers if sequence tracking is enabled')
  it('should handle messages with missing optional fields')
  it('should not replay to a different session')
})
```

**Effort**: 1-2 days for comprehensive replay testing.

### 2. Encryption Integration Completely Dark

**Severity**: High

Every WS server test runs with `noEncrypt: true`. This means the entire encryption layer — ECDH key exchange, AES-GCM encryption/decryption, encrypted message routing — has zero integration test coverage.

**What could go wrong**:
- Key exchange could fail silently and fall back to plaintext (known issue)
- Encrypted messages could be malformed (wrong nonce, wrong tag)
- Large messages could exceed encryption buffer limits
- Key exchange timeout could leave connection in undefined state
- Concurrent key exchanges (multi-client) could corrupt shared state

**Test scenarios needed**:

```javascript
describe('encryption integration', () => {
  it('should complete ECDH key exchange within 5 seconds')
  it('should encrypt all messages after key exchange')
  it('should decrypt messages correctly on both sides')
  it('should handle key exchange timeout gracefully')
  it('should not fall back to plaintext silently')
  it('should handle large encrypted messages (>64KB)')
  it('should maintain encryption across reconnection')
  it('should handle concurrent key exchanges from multiple clients')
  it('should reject messages with invalid nonce')
  it('should reject messages with tampered ciphertext')
  it('should handle nonce overflow (counter wrapping)')
})
```

**Effort**: 2-3 days. Requires removing `noEncrypt: true` from test setup and handling the async key exchange in test fixtures.

### 3. Transient Event Loss During Disconnect

**Severity**: High

When the client disconnects and reconnects, transient events (permission_request, plan_started, plan_ready) are not persisted and cannot be replayed. There is no test verifying this behavior or detecting when it causes problems.

**The scenario**:
```
T=0  Client connected
T=1  Client disconnects (phone locks)
T=2  Server sends permission_request (goes nowhere)
T=3  Client reconnects
T=4  Client receives history replay — permission_request is NOT included
T=5  Claude Code is stuck waiting for permission response
T=6  User has no idea why
```

**Test scenarios needed**:

```javascript
describe('transient event loss', () => {
  it('should not include permission_request in history replay')
  it('should re-emit pending permission_request on reconnect')
  it('should not duplicate permission_request if already handled')
  it('should detect orphaned permission requests after reconnect')
  it('should send notification to push when permission lost during disconnect')
  it('should show "action needed" state after reconnect with pending permission')
})
```

**Note**: Some of these tests describe behavior that doesn't exist yet. The tests should be written to FAIL, proving the gap, then the feature should be implemented to make them pass.

**Effort**: 1-2 days for tests + 1-2 days for implementation.

### 4. Multi-Client Race Conditions Have No Concurrent Tests

**Severity**: Medium

The WS server supports multiple simultaneous clients, but no tests exercise concurrent scenarios:

- Two clients send permission_response at the same time
- Client A disconnects while Client B sends a message
- Both clients request file browse simultaneously
- Client connects while another client is mid-key-exchange
- Server restarts while multiple clients are connected

**Test scenarios needed**:

```javascript
describe('multi-client concurrency', () => {
  it('should accept only the first permission_response for a given request')
  it('should silently drop duplicate permission_response')
  it('should handle simultaneous file browse requests independently')
  it('should complete key exchange independently per client')
  it('should not leak messages from one client session to another')
  it('should handle client A disconnect without affecting client B')
  it('should broadcast events to all connected clients')
  it('should route permission_request to all clients, accept first response')
})
```

**Effort**: 2-3 days. Requires test fixtures that manage multiple WebSocket connections.

### 5. E2E Flows Cover Only ConnectScreen

**Severity**: Medium

The Maestro E2E flows test:
- ConnectScreen elements (title, QR button, LAN scan, manual entry)
- Manual connect form expansion
- LAN scan trigger

They do NOT test:
- SessionScreen (chat view, terminal view, input)
- Permission approval flow
- Settings bar interactions
- Session switching
- Model switching
- Voice input
- Tool result display
- Plan mode UI

**The gap**: The most complex and error-prone screens (SessionScreen, ChatView, TerminalView) have zero E2E coverage.

**New E2E flows needed**:

```yaml
# session-screen.yaml
- assertVisible: "Chat" tab
- assertVisible: Input bar
- assertVisible: Settings bar

# permission-flow.yaml
- Simulate permission request
- Assert permission card visible
- Tap Allow
- Assert permission result

# session-switching.yaml
- Create new session
- Assert session picker shows 2 sessions
- Tap second session
- Assert switch

# settings-interactions.yaml
- Tap settings bar to expand
- Assert model/permission/cost visible
- Change permission mode
- Assert mode changed
```

**Effort**: 3-5 days for SessionScreen E2E flows. Requires a test server that simulates Claude Code responses.

---

## Test Strategies for Proposed Adoptions

### Sequence Numbers (18 scenarios)

```
Basic:
1. Server assigns monotonically increasing seq to outbound messages
2. Client tracks lastServerSeq accurately
3. Gap detected when seq jumps (e.g., 5 → 8)
4. No gap detected for sequential messages (5 → 6 → 7)
5. Seq survives server restart (persisted or reset to 0 with indication)
6. Seq is unique per session (different sessions have independent counters)

Reconnect:
7. Client sends lastServerSeq on reconnect
8. Server replays messages with seq > lastServerSeq
9. Server replays nothing when client is up to date
10. Server replays entire history when lastServerSeq is 0 (first connect)
11. Server handles lastServerSeq beyond current seq (client ahead — stale session)

Edge cases:
12. Seq overflow at Number.MAX_SAFE_INTEGER (reset or wrap)
13. Multiple rapid disconnects/reconnects don't duplicate messages
14. Seq works correctly with encryption enabled
15. Seq works correctly with multiple concurrent clients
16. Gap detection works across ring buffer wraparound
17. Synthetic stream_end inserted with correct seq on reconnect during stream
18. Seq included in persisted messages (JSON/SQLite)
```

### Persistence Upgrade — SQLite (12 scenarios)

```
CRUD:
1. Create session → row in sessions table
2. Append message → row in messages table with correct session_id
3. Get recent messages → returns last N in order
4. Get messages since seq → returns correct subset
5. Delete session → cascades to messages

Migration:
6. JSON files migrate to SQLite correctly
7. Empty JSON files don't cause migration errors
8. Corrupted JSON files are skipped with warning
9. Migration is idempotent (running twice is safe)

Edge cases:
10. Concurrent writes don't corrupt database (WAL mode)
11. Database file permissions are restrictive (600)
12. Large messages (>1MB) stored and retrieved correctly
```

### New Permission Mode — acceptEdits (14 scenarios)

```
Basic behavior:
1. File write permission auto-approved in acceptEdits mode
2. File create permission auto-approved in acceptEdits mode
3. File rename/move permission auto-approved in acceptEdits mode
4. Shell command permission prompts user in acceptEdits mode
5. Network access permission prompts user in acceptEdits mode
6. Unknown permission type prompts user in acceptEdits mode

Mode switching:
7. Switching to acceptEdits from approve mid-session works
8. Switching from acceptEdits to approve mid-session works
9. Pending permission re-evaluated when mode changes
10. Mode persisted across reconnect

Edge cases:
11. Permission with both file and shell components prompts user
12. acceptEdits mode communicated to client on connect
13. acceptEdits mode shown in settings bar
14. Push notification sent for prompted (non-auto) permissions in acceptEdits mode
```

---

## Additional Test Coverage Gaps

### 6. Path Traversal Security Test

The file browser has a known symlink bypass. There should be explicit security tests:

```javascript
describe('file browser security', () => {
  it('should reject ../../../etc/passwd')
  it('should reject symlinks pointing outside base directory')
  it('should reject null bytes in path')
  it('should reject paths longer than 4096 characters')
  it('should handle non-existent paths gracefully')
  it('should handle permission-denied paths gracefully')
  it('should not follow symlinks outside base directory')
})
```

### 7. Binary Frame Handling

WebSocket supports binary frames, but Chroxy only handles text frames. A malicious or buggy client sending binary frames could cause:
- Crash (JSON.parse on binary data)
- Memory leak (buffering binary data)
- Undefined behavior

```javascript
describe('binary frame handling', () => {
  it('should reject binary WebSocket frames gracefully')
  it('should not crash on non-JSON text frames')
  it('should not crash on empty messages')
  it('should not crash on extremely large messages')
})
```

### 8. Push Notification Failure Modes

Push notifications (`push.js`) are fire-and-forget. There are no tests for failure modes:

```javascript
describe('push notification failures', () => {
  it('should handle Expo push API timeout')
  it('should handle invalid push token')
  it('should handle rate limiting (429)')
  it('should handle network failure')
  it('should deregister token after repeated failures')
  it('should not block main event loop on push failure')
})
```

### 9. Nonce Overflow

The encryption nonce is a counter. If it overflows (reaches max value), the encryption becomes insecure (nonce reuse). There's no test for this:

```javascript
describe('nonce overflow', () => {
  it('should detect nonce approaching max value')
  it('should trigger key rotation before overflow')
  it('should reject messages after nonce overflow without rotation')
  it('should handle counter reset on new key exchange')
})
```

---

## Test Infrastructure Recommendations

### 1. Remove `noEncrypt: true` from Default Test Setup

Create two test fixture modes:
- `createTestServer({ encrypt: false })` — for tests that don't care about encryption
- `createTestServer({ encrypt: true })` — for encryption-specific tests and integration tests

### 2. Add Multi-Client Test Fixtures

```javascript
async function createMultiClientSetup(clientCount = 2) {
  const server = await createTestServer()
  const clients = await Promise.all(
    Array.from({ length: clientCount }, () => createTestClient(server.url))
  )
  return { server, clients }
}
```

### 3. Add Reconnect Test Helper

```javascript
async function simulateReconnect(client, server, options = {}) {
  const lastSeq = client.lastSeq
  await client.disconnect()
  if (options.serverEventsDuringDisconnect) {
    for (const event of options.serverEventsDuringDisconnect) {
      server.emit(event.type, event)
    }
  }
  await client.connect(server.url, { lastSeq })
  return client
}
```

### 4. Add E2E Test Server Mock

For Maestro flows that test SessionScreen, create a mock server that:
- Accepts WebSocket connections
- Sends scripted responses (stream_start, stream_delta, stream_end)
- Sends permission_request on demand
- Returns mock file browser results

---

## Coverage Priority Matrix

| Gap | Severity | Effort | Priority |
|-----|----------|--------|----------|
| History replay | Critical | 1-2 days | P0 |
| Encryption integration | High | 2-3 days | P0 |
| Transient event loss | High | 1-2 days | P1 |
| Path traversal security | High | 0.5 days | P1 |
| Multi-client concurrency | Medium | 2-3 days | P2 |
| E2E SessionScreen | Medium | 3-5 days | P2 |
| Binary frame handling | Medium | 0.5 days | P2 |
| Push notification failures | Low | 1 day | P3 |
| Nonce overflow | Low | 0.5 days | P3 |

---

## Verdict

The document provides useful architecture comparison that maps well to test boundaries. However, the most important finding from a QA perspective is what's NOT tested in Chroxy's own codebase, regardless of competitive comparison.

**History replay has zero tests** and is called on every reconnection. This is the highest-risk untested code path in the system. If it breaks, every reconnect fails silently.

**Encryption integration is completely dark.** Running all tests with `noEncrypt: true` means the encryption layer could be completely broken and all tests would still pass. This is the testing equivalent of "works on my machine."

**Transient event loss is undetectable.** There's no test that verifies permission requests are re-emitted on reconnect (because they're not — they're silently dropped). Writing a failing test for this would prove the UX gap and drive the fix.

The proposed adoptions (sequence numbers, persistence, permission mode) each have clear test strategies. The sequence number tests (18 scenarios) should be written BEFORE the implementation — TDD is the right approach for protocol changes.

Overall: Chroxy's test infrastructure is solid (1,095 tests is respectable for this codebase size), but the gaps are in the highest-risk areas: reconnection, encryption, and concurrency. Fix these gaps before adding new features.
