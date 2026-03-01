# Tester's Audit: Desktop Architecture Audit

**Agent**: Tester -- Obsessive QA engineer who thinks in edge cases and state machines
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 3/5 | 3 EVENT_MAP entries untested; client delta batching has 0 tests |
| Repository & Session Mgmt | 4/5 | Strongest coverage (879-line test file); SessionLimitError never tested |
| Tunnel Implementation | 3/5 | Recovery re-entry race untested; `safeTokenCompare` has ZERO tests |
| WebSocket Layer | 4/5 | 8,356-line test file; ping bypasses schema validation (untested edge) |
| Data Flow Diagram | 4/5 | Missing state transitions in ConnectionPhase and tunnel recovery |
| Proposed Protocol | 2/5 | `sync_request.lastSeq` structurally incompatible with per-client `seq` |

## Top 5 Findings

### 1. `safeTokenCompare` Has Zero Tests (CRITICAL)
**File:** `crypto.js:115-135`. The sole authentication gate for all WebSocket connections. 5 distinct code paths, none tested. `safeTokenCompare('', '')` returns `false` (line 133) -- probably correct but unverified.

### 2. EVENT_MAP Completeness Test Misses 3 of 20 Entries (HIGH)
**File:** `event-normalizer.test.js:372-377`. Lists 17 expected events, but EVENT_MAP has 20. Missing: `cost_update`, `budget_warning`, `budget_exceeded`.

### 3. Client Message Handler Has ~7% Test Coverage (HIGH)
**File:** `message-handler.test.ts` (586 lines) tests 5 of ~72 case branches. Entire streaming pipeline, reconnect dedup, offline queue untested.

### 4. Tunnel Recovery Not Re-Entrant (MEDIUM)
**File:** `tunnel/base.js:92-156`. `_handleUnexpectedExit` is async with `await` sleep. Two rapid exits spawn parallel recovery loops. No mutex or guard.

### 5. Proposed `sync_request.lastSeq` Incompatible with Current `seq` (MEDIUM)
Per-client ephemeral `seq` (ws-server.js:1199) resets on reconnect, isn't stored in ring buffer, and spans all sessions. Per-session monotonic counters are a prerequisite that doesn't exist.

## Recommended Test Priorities

| Priority | Action | Effort |
|----------|--------|--------|
| Immediate | `safeTokenCompare` tests (7 cases) | 30 min |
| Immediate | Fix EVENT_MAP completeness test | 20 min |
| Immediate | Tunnel recovery re-entry guard + test | 30 min |
| Before protocol changes | Design per-session sequence numbering | 1-2 days |
| Client-side | `stream_delta` accumulation tests | 2-3 hours |
| Integration | Full reconnection flow E2E test | 1 day |

## Verdict
The server test suite has genuine strengths (8,356-line ws-server test, comprehensive schema validation). But critical-path components have zero coverage: `safeTokenCompare`, cost/budget events, and the client-side message handler for core types. The proposed protocol changes conflict with the current data model and would be impossible to test as designed.
