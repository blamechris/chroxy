# Tester's Audit: Desktop Architecture Audit

**Agent**: Tester -- Obsessive QA engineer who thinks in edge cases, state machines, and boundary conditions
**Overall Rating**: 3.2 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

### Section 1: Message Synchronization -- Rating: 3/5

The EventNormalizer has good test coverage (15 of 17 event types tested) but 3 EVENT_MAP entries (`cost_update`, `budget_warning`, `budget_exceeded`) have zero tests. The completeness test at `event-normalizer.test.js:372` lists 17 expected events but EVENT_MAP has 20 entries. Client-side delta batching (100ms flush timer) and history replay deduplication are entirely untested.

### Section 2: Repository and Session Management -- Rating: 4/5

Strongest test coverage in the codebase. `session-manager.test.js` (879 lines) covers serialization, restoration, TTL, auto-persist, ring buffer, budget pause lifecycle. `session-timeout.test.js` (200 lines) covers warning, destruction, viewer exemption. `checkpoint-manager.test.js` (207 lines) covers FIFO eviction. Missing: `SessionLimitError` on 6th session never tested. `destroyAll` during active streaming untested.

### Section 3: Tunnel Implementation -- Rating: 3/5

`base.test.js` (285 lines) covers all 5 tunnel events and 7 recovery scenarios. `crypto.test.js` (145 lines) covers round-trip, direction isolation, tamper detection. Missing: nonce counter overflow untested, `safeTokenCompare` has **ZERO** tests (crypto.js:115-135), tunnel recovery re-entry race untested.

### Section 4: WebSocket / Real-Time Communication -- Rating: 4/5

Most thoroughly tested subsystem. `ws-server.test.js` is 8,356 lines with 48 `describe` blocks. `ws-schemas.test.js` (1,342 lines) tests every schema. Missing: compression threshold behavior, offline message queue TTL, concurrent broadcast during client add/remove.

### Section 5: Data Flow Diagram -- Rating: 4/5

Accurate diagrams. Missing transitions: `reconnecting -> disconnected` (max retry exhaustion), `connecting -> disconnected` (auth failure), and the `intentionalShutdown` flag in tunnel recovery.

### Proposed Protocol -- Rating: 2/5

Under-specified for the edge cases each enhancement introduces. Differential sync conflates per-client and per-session sequence numbers -- a fundamental design flaw.

---

## Top 5 Findings

### Finding 1: `safeTokenCompare` Has Zero Tests (Critical)

**File:** `crypto.js:115-135`

The sole authentication check for every WebSocket connection has 5 distinct code paths and **none are tested**. Non-obvious behavior: `safeTokenCompare('', '')` returns `false` (line 133). This is the authentication gatekeeper for the entire system.

**Recommendation:** Add 7 test cases: identical tokens, different tokens, different lengths, empty strings, non-string inputs, token+suffix, and timing consistency.

### Finding 2: EventNormalizer Completeness Test Is Incomplete (High)

**File:** `event-normalizer.test.js:372-377`

The `expectedEvents` array lists 17 events but `EVENT_MAP` has 20. Missing: `cost_update`, `budget_warning`, `budget_exceeded`. The completeness test is supposed to catch exactly this scenario but has a stale list.

**Recommendation:** Replace hardcoded list with `Object.keys(EVENT_MAP)`. Add 3 test cases for cost/budget events.

### Finding 3: Client-Side Message Handler Has 5 of ~50 Types Tested (High)

**File:** `message-handler.test.ts` (586 lines) vs `message-handler.ts` (~1100 lines)

Tests cover only: `session_timeout`, `session_list` GC, `conversations_list`, unknown messages, `client_focus_changed`. The ~50 other message types (`stream_start/delta/end`, `auth_ok`, `key_exchange_ok`, `permission_request`, `result`, etc.) have zero unit tests. Delta batching, history replay dedup, and encryption state transitions are entirely untested on the client side.

### Finding 4: Tunnel Recovery Has No Re-Entry Guard (Medium)

**File:** `tunnel/base.js:92-156`

`_handleUnexpectedExit` is async with a `while` loop and `await` sleep. If called twice rapidly (first recovery attempt crashes immediately), two parallel recovery loops run, both incrementing `recoveryAttempt` and potentially spawning conflicting tunnel processes. No mutex or re-entry check.

**Recommendation:** Add `_recovering` boolean guard and a test for double-call.

### Finding 5: Differential Sync Proposal Conflates Per-Client and Per-Session Sequences (Medium)

**Source:** ws-server.js:1199 -- `client._seq++`

The proposed `sync_request { sessionId, lastSeq }` assumes `lastSeq` identifies session-specific messages. But `seq` is per-client monotonic across all sessions. Client A's seq=42 means "42nd message to client A across ALL sessions," not "42nd message for session X." Seq also resets on reconnect (verified by test at ws-server.test.js:5064). The proposal needs per-session monotonic sequence numbers.

---

## State Machine Validation

### ConnectionPhase (Client)

**Documented:** `disconnected -> connecting -> connected -> reconnecting`
**Missing transitions:**
- `reconnecting -> disconnected` (max retry exhaustion)
- `connecting -> disconnected` (auth_fail response)
- `key_exchange -> failed` (10s timeout, server closes socket)

### Tunnel Recovery

**Documented:** `stopped -> starting -> running -> lost -> recovering -> recovered/failed`
**Missing:** The `intentionalShutdown` flag is the critical state variable not mentioned. Without it, `stop()` during recovery spawns a new tunnel after stop.

### Encryption State

**Documented:** `none -> key_exchange -> encrypted`
**Missing:** `key_exchange -> failed` transition when timeout fires. Tested server-side but not documented.

---

## Recommended Test Strategy

| Priority | Action | Effort |
|----------|--------|--------|
| Immediate | `safeTokenCompare` tests (7 cases) | 30 min |
| Immediate | Fix EVENT_MAP completeness test | 20 min |
| Immediate | Tunnel recovery re-entry guard + test | 30 min |
| Before protocol changes | Design per-session sequence numbering | 1-2 days |
| Before protocol changes | Ring buffer boundary property-based tests | 1 day |
| Client-side | `stream_delta` accumulation tests | 2-3 hours |
| Client-side | History replay dedup tests | 2-3 hours |
| Client-side | Offline message queue TTL tests | 1-2 hours |
| Integration | Full reconnection flow E2E test | 1 day |

---

## Verdict

The codebase has strong server-side test coverage (42 test files, 8,356-line ws-server test) but critical-path components have zero coverage: `safeTokenCompare` (authentication), cost/budget event mappings, and the client-side message handler for core types. The proposed protocol changes are under-specified for edge cases -- differential sync conflates per-client and per-session sequences (a fundamental design flaw), multi-session subscription lacks failure mode specs, and message priority ignores that TCP is FIFO. The document is adequate as an architectural guide but should not be treated as a specification for protocol changes without substantial edge-case analysis and test planning.
