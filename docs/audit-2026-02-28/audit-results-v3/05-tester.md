# Tester v3: Desktop Architecture Audit

**Agent**: Tester -- QA engineer focused on edge cases, test coverage gaps, and test strategy
**v2 Rating**: 3.0/5
**v3 Rating**: 3.0/5 (unchanged -- all v2 findings confirmed, none addressed)
**Date**: 2026-02-28

---

## v2 Finding Re-Verification

Every v2 finding was re-verified against the current codebase. No fixes or new tests have been added since the v2 assessment. The git log shows only documentation (audit reports) and feature commits (follow mode, protocol versioning, session overview, haptics, animations, icons) -- none of which addressed the identified test gaps.

### Finding 1: `safeTokenCompare` Has Zero Tests -- CONFIRMED

**File**: `packages/server/src/crypto.js:115-135`
**Test file**: `packages/server/tests/crypto.test.js`

Re-verified by reading both files. The test file imports `createKeyPair, deriveSharedKey, encrypt, decrypt, nonceFromCounter, DIRECTION_SERVER, DIRECTION_CLIENT` at line 3 -- `safeTokenCompare` is not imported and not tested. The function has 5 distinct code paths:

1. Both inputs are non-strings (line 117-121): `valid = false`, compare empty buffers
2. One input is non-string: same path
3. Both empty strings (line 133): `maxLen === 0` so `timingSafeEqual` is skipped, returns `false`
4. Same-length strings that match: returns `true`
5. Different-length strings (line 134): `bufA.length === bufB.length` check fails, returns `false`

This is the authentication gatekeeper for every WebSocket connection to the server. Zero test coverage remains.

**Status**: UNCHANGED. Still zero coverage. Still critical.

### Finding 2: EventNormalizer Completeness Test Misses 3 of 20 Entries -- CONFIRMED

**File**: `packages/server/tests/event-normalizer.test.js:372-377`
**Source**: `packages/server/src/event-normalizer.js:20-200`

EVENT_MAP has 20 entries. The completeness test at line 372 lists 17:
```
ready, conversation_id, stream_start, stream_delta, stream_end,
message, tool_start, tool_result, agent_spawned, agent_completed,
mcp_servers, plan_started, plan_ready, result,
user_question, permission_request, error
```

Missing from the test: `cost_update` (line 148), `budget_warning` (line 152), `budget_exceeded` (line 156). These three handlers exist in the EVENT_MAP but are not listed in the `expectedEvents` array and are not exercised in the second test (`all handlers return an object with messages array`, line 384) either -- the `testData` object at line 386 has the same 17 entries.

**Status**: UNCHANGED. The completeness test passes but provides false assurance.

### Finding 3: Tunnel Recovery Re-Entry Race -- CONFIRMED

**File**: `packages/server/src/tunnel/base.js:92-156`
**Test file**: `packages/server/tests/tunnel/base.test.js`

`_handleUnexpectedExit` at line 92 is an async method with `await` sleep (line 116). There is no mutex, `_recovering` flag, or re-entry guard. The `while` loop at line 104 reads/writes `this.recoveryAttempt` which is shared state. If the tunnel process exits twice in rapid succession (e.g., crashes on startup), two concurrent invocations would:

- Both read `recoveryAttempt` before either increments it
- Both call `_startTunnel()`, potentially spawning two tunnel processes
- Shared state `this.process` and `this.url` would be written by both

The unit tests (`base.test.js`, 285 lines) thoroughly test single-exit recovery scenarios but do NOT test concurrent `_handleUnexpectedExit` calls.

**Status**: UNCHANGED. No guard added. No test for the race.

### Finding 4: `stream_delta` Ordering Assumptions Untested -- CONFIRMED

Searched all server test files for `stream_delta.*ordering`, `delta.*order`, `out.of.order` -- zero matches. The event normalizer's delta buffering coalesces deltas by `(sessionId, messageId)` key using string concatenation (`packages/server/src/event-normalizer.js:249`). If deltas arrive out of order (e.g., due to WebSocket message reordering, which is rare but possible with multiple intermediary proxies), the accumulated text would be garbled. No test verifies the assumption that deltas arrive in order, and no test verifies behavior when they do not.

The ws-server.test.js file has zero mentions of `stream_delta` in any test.

**Status**: UNCHANGED.

### Finding 5: 12 Zod Schemas Use `.passthrough()` -- CONFIRMED

**File**: `packages/server/src/ws-schemas.js`

12 schemas use `.passthrough()`:
- Line 17: `DeviceInfoSchema`
- Line 26: `AuthSchema`
- Line 33: `InputSchema`
- Line 37: `InterruptSchema`
- Line 42: `SetModelSchema`
- Line 48: `SetPermissionModeSchema`
- Line 101: `BrowseFilesSchema`
- Line 106: `ReadFileSchema`
- Line 110: `ListSlashCommandsSchema`
- Line 114: `ListAgentsSchema`
- Line 137: `GetDiffSchema`
- Line 231: `ServerAuthOkSchema`

The schema test file (`packages/server/tests/ws-schemas.test.js`, 1342 lines) has zero tests verifying passthrough behavior. No test sends a message with extra fields to verify they are preserved or stripped. This means unknown fields from clients pass through validation and could propagate to handlers that don't expect them.

**Status**: UNCHANGED.

---

## New Findings in v3

### Finding 6: Client-Side Message Handler Coverage Remains at ~7%

**File**: `packages/app/src/store/message-handler.ts` -- 68 `case` branches
**Test file**: `packages/app/src/__tests__/store/message-handler.test.ts` -- 586 lines

The test file covers exactly 5 of 68 cases:
- `session_timeout` (6 tests)
- `session_list` GC cleanup (5 tests)
- `conversations_list` (2 tests)
- unknown message type / default case (3 tests)
- `client_focus_changed` follow mode (4 tests)

Not tested (63 cases): `pong`, `auth_ok`, `key_exchange_ok`, `auth_fail`, `server_mode`, `session_context`, `session_switched`, `conversation_id`, `session_error`, `history_replay_start`, `history_replay_end`, `message`, `stream_start`, `stream_delta`, `stream_end`, `tool_start`, `tool_result`, `result`, `model_changed`, `available_models`, `permission_mode_changed`, `confirm_permission_mode`, `available_permission_modes`, `raw`, `claude_ready`, `agent_idle`, `agent_busy`, `agent_spawned`, `agent_completed`, `plan_started`, `plan_ready`, `raw_background`, `permission_request`, `permission_expired`, `user_question`, `server_status`, `server_shutdown`, `client_joined`, `client_left`, `primary_changed`, `directory_listing`, `file_listing`, `file_content`, `diff_result`, `slash_commands`, `agent_list`, `checkpoint_created`, `checkpoint_list`, `checkpoint_restored`, `mcp_servers`, `cost_update`, `budget_warning`, `budget_exceeded`, `budget_resumed`, `dev_preview`, `dev_preview_stopped`, `web_feature_status`, `web_task_created/updated`, `web_task_error`, `web_task_list`, `server_error`, `token_rotated`, `session_warning`.

The entire streaming pipeline (`stream_start` -> `stream_delta` -> `stream_end`), reconnect deduplication logic, offline message queue, and permission request UI flow have zero automated tests.

### Finding 7: `_broadcastToSession` Filtering Gap Has a Test That Proves It

**File**: `packages/server/tests/ws-server.test.js:1695`

The test named "delivers messages for inactive sessions to all clients" at line 1695 explicitly demonstrates that `_broadcastToSession` sends to ALL authenticated clients, not just those viewing the session. This is deliberate test behavior that confirms the v2 master finding. The test passes and asserts this behavior as correct. If session filtering were added (per the priority matrix), this test would need to be updated or the broadcast behavior intentionally changed.

---

## v2 Master Priority Matrix: Testability Assessment

### Immediate Items

| Action | Testable? | Test Strategy | Current Coverage |
|--------|-----------|---------------|------------------|
| Fix `config.json` permissions in `setup.rs` (0o600) | Partially | Would need a Rust unit test or integration test that checks file permissions after `ensure_config()`. No Rust test infrastructure exists in the project. | 0% -- `setup.rs:34` uses `fs::write()` with default permissions |
| Remove token from HTML/URL rendering | Yes | Unit test on `dashboard.js` template function to verify token is not in output HTML. E2E test that `window.rs:26` does not include `?token=` in URL. | 0% -- Token is in HTML at `dashboard.js:138` and URL at `window.rs:26` |
| Add `safeTokenCompare` tests (7 cases) | Yes | Pure function, trivially testable. Recommended 7 cases: identical strings, different strings, different lengths, both empty, one empty, non-string inputs, timing resistance (statistical). | 0% |
| Fix EventNormalizer completeness test | Yes | Add `cost_update`, `budget_warning`, `budget_exceeded` to the `expectedEvents` array at `event-normalizer.test.js:372` and `testData` at line 386. | 85% (17/20 events) |

### Short-Term Items

| Action | Testable? | Test Strategy | Effort |
|--------|-----------|---------------|--------|
| Fix `_broadcastToSession` to filter by session | Yes | Modify existing test at `ws-server.test.js:1695` to verify client on sess-1 does NOT receive sess-2 messages. Add filter by `client.activeSessionId`. | 1-2 hours for tests |
| Add re-entry guard to tunnel recovery | Yes | Unit test in `base.test.js`: call `_handleUnexpectedExit` twice concurrently, verify only one recovery loop runs. Check `_startCallCount` equals expected. | 1 hour |
| Replace `win.eval()` with `app.emit()` events | Partially | Rust test would need Tauri test harness. Manual verification more practical for v1. | No automated test path currently |
| Add orphan process detection on startup | Yes | Unit test: write a PID file, verify startup detects stale PID. Integration: verify port conflict handling. | 2-3 hours |
| Permission notification when window hidden | Partially | Would need Tauri test harness for window visibility state. Maestro E2E flow could verify notification display. | Manual testing recommended |

### Key Testability Gaps for Short-Term Items

1. **No Rust test infrastructure**: The Tauri desktop app (`packages/desktop/src-tauri/`) has zero Rust tests. Items touching `setup.rs`, `window.rs`, or `server.rs` cannot be automatically tested without adding `#[cfg(test)]` modules and a test runner.

2. **No integration test for the full auth chain**: `safeTokenCompare` is called from `ws-server.js:_handleMessage`, which parses the auth message, validates it, and calls the compare. The unit test gap is the function itself, but the integration path (client sends auth -> server validates -> accepts/rejects) is tested in `ws-server.test.js` but only with correct tokens.

3. **Dashboard is untestable in isolation**: `dashboard.js` generates an HTML string with embedded JavaScript. No rendering engine, no DOM, no way to verify the token is or is not in the output without string matching on the template.

---

## Minimum Test Coverage for Safe Desktop Ship

The desktop app changes touch four risk surfaces. Here is the minimum test coverage needed before shipping:

### Must Have (Blocks Ship)

1. **`safeTokenCompare` tests** (7 cases, 30 min): This is the authentication gatekeeper. Any regression means auth bypass. No excuse for zero coverage on a security-critical function.

2. **EventNormalizer completeness fix** (20 min): The current test gives false confidence. Three events pass through without any validation coverage. A regression in `cost_update`, `budget_warning`, or `budget_exceeded` handlers would go undetected.

3. **Tunnel recovery re-entry guard + test** (1 hour): Desktop app restarts the server process. If the tunnel process crashes and re-entry occurs, two tunnels could spawn. The desktop user would see confusing behavior (two URLs, port conflicts).

4. **`_broadcastToSession` behavior documented in test** (30 min): Either add a test asserting the current all-clients behavior is intentional OR add session filtering with an updated test. The current test at line 1695 demonstrates the gap but does not assert the desired behavior for multi-session desktop use.

### Should Have (Ship with Known Limitations)

5. **Basic `auth_ok` message handler test** (2 hours): The `auth_ok` case in `message-handler.ts` (lines 523-625) is 100+ lines of state parsing with zero tests. A single malformed `auth_ok` response could crash the app.

6. **Stream lifecycle test** (`stream_start` -> `stream_delta` -> `stream_end`) in message handler (3 hours): Core user-visible flow, zero tests on the client side.

7. **`setup.rs` permissions test**: File permissions for the config are security-critical. If Rust test infrastructure is too expensive, at minimum add a shell script integration test.

### Accept Risk

8. **Dashboard token exposure**: Fixing this requires architectural change (HttpOnly cookie or Tauri command bridge). Test coverage alone does not fix the vulnerability. Ship with the known limitation and prioritize the fix.

9. **Client-side full message handler coverage**: Covering 63 untested cases is 2-3 weeks of work. Not blocking for desktop ship, but the debt compounds with every new message type.

---

## Section Ratings

| Section | Rating | Rationale |
|---------|--------|-----------|
| Message Synchronization | 3/5 | Delta buffering tested (normalizer), but `stream_delta` ordering untested, client-side batching at 0%, no tests for the full stream lifecycle on either side |
| Repository & Session Mgmt | 4/5 | Strongest coverage (session-manager.test.js is comprehensive). SessionLimitError still untested but cosmetic. |
| Tunnel Implementation | 3/5 | Base adapter recovery well-tested (9 test cases in `base.test.js`). Re-entry guard still missing. `safeTokenCompare` still at zero. Integration test exists but is environment-dependent (requires `cloudflared`). |
| WebSocket Layer | 4/5 | ws-server.test.js is thorough. Schema tests comprehensive (1342 lines). But `_broadcastToSession` filter gap confirmed by test at line 1695. 12 `.passthrough()` schemas untested for unknown field propagation. |
| Data Flow Diagram | 4/5 | Accurate and useful. Missing state transitions still apply but diagrams match implementation. |
| Proposed Protocol | 2/5 | `sync_request.lastSeq` still structurally incompatible with per-client ephemeral `seq`. No tests possible for a design that conflicts with the data model. |

---

## Top 5 Findings (v3)

### 1. `safeTokenCompare` Has Zero Tests -- Still Critical (UNCHANGED)

**File**: `packages/server/src/crypto.js:115-135`
**Test file**: `packages/server/tests/crypto.test.js` (function not imported, not tested)

The sole authentication gate for all WebSocket connections has 5 code paths, 0 tests. This was identified in v2, placed in the "Immediate" priority matrix by the master assessment, and remains unaddressed. The v2 master estimated 30 minutes to fix. Recommended test cases:

| # | Input | Expected | Path |
|---|-------|----------|------|
| 1 | `('abc', 'abc')` | `true` | Happy path |
| 2 | `('abc', 'xyz')` | `false` | Different content |
| 3 | `('abc', 'abcd')` | `false` | Different length |
| 4 | `('', '')` | `false` | Empty strings (line 133) |
| 5 | `(null, 'abc')` | `false` | Non-string input (line 117) |
| 6 | `(123, 456)` | `false` | Both non-string |
| 7 | `('abc', 'abcx')` | `false` | Suffix attack |

### 2. EventNormalizer Completeness Test Misses 3/20 Events (UNCHANGED)

**File**: `packages/server/tests/event-normalizer.test.js:372-377`
**Source**: `packages/server/src/event-normalizer.js` lines 148-158

Missing from test: `cost_update`, `budget_warning`, `budget_exceeded`. The test title says "has handlers for all expected events" but it does not. This is a test that provides false confidence -- it passes while being incomplete.

### 3. Client Message Handler at ~7% Coverage -- 63/68 Cases Untested (UNCHANGED)

**File**: `packages/app/src/__tests__/store/message-handler.test.ts`
**Source**: `packages/app/src/store/message-handler.ts` -- 68 `case` branches

Five cases tested: `session_timeout`, `session_list` (GC only), `conversations_list`, unknown type, `client_focus_changed`. The entire streaming pipeline, auth flow, permission UI, reconnect dedup, and 58 other message types have no automated tests. This is the highest-volume code path in the mobile app.

### 4. Tunnel Recovery Re-Entry Race Has No Guard or Test (UNCHANGED)

**File**: `packages/server/src/tunnel/base.js:92-156`
**Test file**: `packages/server/tests/tunnel/base.test.js` (9 tests, none for concurrent calls)

Two rapid `close` events from the tunnel process would spawn parallel recovery loops. Both would read/write `this.recoveryAttempt` (shared state, no lock), potentially spawning two tunnel processes. Fix: add `this._recovering = true` guard at entry, clear on exit. Test: call `_handleUnexpectedExit` twice, assert `_startCallCount` matches expected.

### 5. 12 `.passthrough()` Schemas Accept Unknown Fields With Zero Tests (UNCHANGED)

**File**: `packages/server/src/ws-schemas.js` (12 occurrences)
**Test file**: `packages/server/tests/ws-schemas.test.js` (0 passthrough-related tests)

Schemas including `AuthSchema`, `InputSchema`, `SetModelSchema`, and others use `.passthrough()` which allows any extra fields through validation. No test verifies this behavior. An attacker could inject fields like `{ type: 'input', data: 'hello', __proto__: {...} }` and the extra fields would pass validation and propagate to handlers. At minimum, test that passthrough fields are not used by handlers. Ideally, switch to `.strip()` for security-sensitive schemas (`AuthSchema`, `PermissionResponseSchema`).

---

## Overall Rating: 3.0/5

**Rationale**: The server-side test suite has genuine strengths -- 42 test files, comprehensive schema validation (1342 lines), thorough ws-server tests, solid event normalizer coverage, and good session manager tests. But the five findings from v2 remain unaddressed despite being placed in the "Immediate" priority matrix. The authentication gatekeeper has zero tests. The client-side message handler, which processes every user-visible event, has 7% coverage. No new tests were added between v2 and v3. The rating cannot improve while critical-path security code remains untested.

**What would raise the rating**:
- 3.5: Fix findings 1 and 2 (safeTokenCompare tests + EventNormalizer completeness). ~50 minutes of work.
- 4.0: Add finding 4 fix (re-entry guard + test) and basic stream lifecycle test in message handler. ~4 hours additional.
- 4.5: Bring client message handler to 30%+ coverage (top 20 cases by frequency). ~2-3 days.
- 5.0: Full integration test for auth chain, Rust test infrastructure, `.passthrough()` audit. ~1-2 weeks.
