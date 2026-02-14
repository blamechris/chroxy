# Tester's Audit: Chroxy Security Architecture

**Agent**: Tester -- QA engineer who finds edge cases developers miss
**Overall Rating**: 6.5 / 10 (Security), 7 / 10 (Coverage)
**Date**: 2026-02-12

## Verdict

Solid bones but critical edge case gaps. 9,553 LOC of tests cover happy paths well, but **0 tests** for race conditions, fuzzing, resource exhaustion, or failure injection.

## Section Testability Ratings

### 1. Auth Flow: 3.5/5
**Tested**: Constant-time comparison, rate limiting exists, timeout enforced
**Untested**:
- ❌ Concurrent auth from same IP (rate limiter Map race)
- ❌ Auth timeout edge case (input during timeout)
- ❌ Malformed deviceInfo validation
- ❌ Rate limit cleanup race

### 2. Permission System: 2.5/5
**Tested**: 5-min timeout, body size limit, auto-deny
**Untested**:
- ❌ Permission during process crash (HTTP connection hangs)
- ❌ Concurrent permission responses (two clients, same requestId)
- ❌ Permission request flood (unbounded Map growth)
- ❌ HTTP connection leak after `req.on('aborted')`

### 3. Session Management: 4/5
**Tested**: Session limit, creation/destruction, state serialization
**Untested**:
- ❌ Concurrent createSession (race to check size >= maxSessions)
- ❌ destroySession during active message
- ❌ History replay during concurrent messages
- ❌ attachSession timeout (PtySession.start can hang)

### 4. WebSocket Protocol: 3/5
**Tested**: Malformed JSON ignored, message routing, ping/pong
**Untested**:
- ❌ Message flood (no backpressure)
- ❌ Partial JSON parse (truncated message)
- ❌ Message ordering (async handlers, FIFO not guaranteed)
- ❌ ws.send() failure

### 5. Tunnel Recovery: 2/5
**Tested**: Exponential backoff, Quick/Named modes, max retry limit
**Untested**:
- ❌ Tunnel crash during active message
- ❌ URL change during recovery (client gets stale URL)
- ❌ Recovery during drain (supervisor stops while recovering)
- ❌ Tunnel timeout during process spawn

### 6. Process Crashes: 3.5/5
**Tested**: Respawn, max attempts (5), exponential backoff
**Untested**:
- ❌ Crash during permission request
- ❌ Rapid crash loop final state
- ❌ Crash during setModel() (kills process)
- ❌ stdin.write() after process dead

## TOP 5 UNTESTED EDGE CASES

### 1. Concurrent Auth from Same IP (HIGH)
**File**: ws-server.js:544-583
**Issue**: `Map.get() → check → Map.set()` without lock. Two simultaneous failures corrupt rate limit.

**Missing Test**:
```javascript
it('rate limits concurrent auth failures', async () => {
  // Spawn 10 connections, send wrong token simultaneously
  // Expected: majority get rate-limited
})
```

**Effort**: 50 LOC, 2 hours

---

### 2. Permission Timeout During Crash (CRITICAL)
**File**: ws-server.js:1577-1690, cli-session.js:176-194
**Issue**: Permission holds HTTP for 5min. If session crashes, resolve() references dead session.

**Missing Test**:
```javascript
it('auto-denies if session crashes before response', async () => {
  // Trigger permission
  // Kill CliSession
  // Verify HTTP responds "deny" immediately, no leak
})
```

**Effort**: 80 LOC, 4 hours

---

### 3. Session Switch Mid-Message (MEDIUM)
**File**: ws-server.js:726-738
**Issue**: Send `input` → processing → `switch_session` → result tagged with old sessionId.

**Missing Test**:
```javascript
it('handles session switch during processing', async () => {
  // Send to session 1
  // Switch to session 2
  // Send to session 2
  // Verify: no cross-contamination
})
```

**Effort**: 60 LOC, 3 hours

---

### 4. Message Flood (Backpressure) (MEDIUM)
**File**: ws-server.js:326-334
**Issue**: No rate limit. Client sends 1000 messages in 1s.

**Missing Test**:
```javascript
it('handles message flood gracefully', async () => {
  // Send 100 messages back-to-back
  // Expected: first processes, rest get errors
})
```

**Effort**: 60 LOC, 3 hours

---

### 5. Tunnel URL Change During Connection (MEDIUM)
**File**: tunnel.js:198-277
**Issue**: Quick tunnel crashes → recovery → NEW URL → clients still on old URL.

**Missing Test**:
```javascript
it('broadcasts new URL after recovery', async () => {
  // Start tunnel
  // Simulate crash with URL change
  // Expected: clients receive tunnel_url_changed
})
```

**Effort**: 70 LOC, 3 hours

---

## Test Strategy Recommendations

### Integration Tests (High Priority) - 200 LOC, 8h
1. Multi-client concurrent operations (10 clients, different sessions)
2. Failure recovery integration (tunnel/session crash → reconnect)

### Chaos Tests (Medium Priority) - 180 LOC, 8h
3. Network partition simulation (50% packet loss with `tc`)
4. Process kill chaos (random CliSession kills)

### Security Tests (High Priority) - 370 LOC, 15h
5. Auth bypass fuzz (100 malformed auth messages)
6. Permission injection fuzz (64KB+ bodies, XSS payloads)
7. Input validation fuzz (path traversal, shell injection, null bytes)

### Stress Tests (Medium Priority) - 200 LOC, 7h
8. Long-running session (1000 messages over 1 hour)
9. Max sessions stress (create 100 rapidly, verify limit)

## Evidence of Untested Paths

### Untested Error Paths
- `list_directory` EACCES (permission denied) - ws-server.js:1441-1454
- AskUserQuestion parse failure - cli-session.js:372-383
- Attach session failure cleanup - session-manager.js:316-321

### Untested Race Conditions
- Delta buffer flush vs stream_end - ws-server.js:1082-1150
- Ping interval client deletion during iteration - ws-server.js:365-378

### Untested Boundaries
- Permission body exactly 65536 vs 65537 bytes - ws-server.js:1585-1594
- Tool input exactly MAX_TOOL_INPUT_LENGTH±1 - cli-session.js:357-364

## Estimated Test Effort

| Category | Tests | LOC | Hours |
|----------|-------|-----|-------|
| Concurrent ops | 5 | 250 | 10 |
| Chaos tests | 4 | 260 | 12 |
| Security fuzz | 6 | 370 | 15 |
| Stress tests | 3 | 200 | 7 |
| **TOTAL** | **18** | **1,080** | **44** |

**ROI**: 44 hours (~1 week) → catch 80% of critical edge cases

## Critical Recommendations

### Priority 1 (Do First)
1. Add concurrent auth test (prevents credential stuffing)
2. Add permission timeout during crash test (prevents memory leak)
3. Add input validation fuzz suite (prevents injection attacks)

### Priority 2 (Do Next)
4. Add tunnel recovery integration test
5. Add message flood backpressure test
6. Add multi-client session management test

### Priority 3 (Nice to Have)
7. Add chaos testing framework
8. Add performance regression tests
9. Add end-to-end security audit

## Final Rating: 6.5/10

**Production-ready for MVP**, but needs hardening before scale.

**Coverage Gaps**:
- **0 tests** for concurrent operations
- **0 tests** for malicious input
- **0 tests** for resource exhaustion
- **0 tests** for failure injection

Recommend prioritizing concurrent operation tests and permission system hardening before production scale.
