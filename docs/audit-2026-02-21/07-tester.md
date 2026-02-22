# Tester's Audit: Chroxy Test Suite Assessment

**Agent**: Tester -- Meticulous QA engineer who finds coverage gaps
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-21

---

## Test Inventory

| Suite | Framework | Files | Tests | Pass | Fail |
|-------|-----------|-------|-------|------|------|
| Server | Node.js built-in test runner | 29 | 991 | 990 | 1 |
| App | Jest | 9 | 243 | 243 | 0 |
| E2E | Maestro | 11 flows | N/A | N/A | N/A |
| **Total** | | **49** | **1,234+** | **1,233** | **1** |

The single failing test is `doctor.test.js:33` -- the Node.js version check returns `'warn'` instead of `'pass'` because the test environment runs Node 22 which the doctor considers non-latest. CI runs green because CI uses the expected Node version.

---

## Coverage Gaps

### 1. push.js -- Zero Tests

`packages/server/src/push.js` implements the PushManager: Expo Push API integration, rate limiting per category, device token management. There is **no test file** for it anywhere in the repository.

This is the most critical coverage gap. Push notifications are a production feature that interacts with an external API (Expo Push Service) and has rate limiting logic that could easily break.

### 2. Untested WS Message Handlers

`ws-server.js` has 30+ message type handlers. The test file `ws-server.test.js` covers the core paths but these handlers have no dedicated tests:

| Handler | Line | Risk |
|---------|------|------|
| `request_full_history` | ~1050 | Replays entire message history -- no test for large histories |
| `get_untracked_files` | ~1160 | File system access -- no test for edge cases (empty repo, huge dirs) |
| `get_diff` | ~1149 | Git operation -- no test for base ref validation |
| `browse_files` | Tested in PR #708 (now merged) | Covered |
| `read_file` | Tested in PR #708 (now merged) | Covered |

### 3. Zero App Component Tests

All 243 app tests cover utilities and store logic:

| Test File | What It Tests |
|-----------|---------------|
| `connection.test.ts` | Zustand store state transitions |
| `connection-connect.test.ts` | Connect/disconnect flows |
| `formatters.test.ts` | String formatting utilities |
| `markdown.test.ts` | Markdown parsing utilities |
| `crypto.test.ts` | Encryption utilities |
| `syntax.test.ts` | Syntax highlighting utilities |
| `xterm-html.test.ts` | Terminal HTML generation |
| `useSpeechRecognition.test.ts` | Speech recognition hook |
| `notifications.test.ts` | Push notification handling |

**Zero component rendering tests.** No tests for:
- ConnectScreen rendering and interaction
- SessionScreen rendering
- ChatView message display
- TerminalView WebView integration
- SettingsBar mode switching
- PlanApprovalCard approve/deny flow
- InputBar text entry and send

This means UI regressions are only caught by Maestro E2E flows (which require a running simulator) or manual testing.

---

## False Confidence Tests

### Mock sendMessage is a No-Op

`ws-server.test.js:229`:
```javascript
mockSession.sendMessage = (text) => {
```

and `ws-server.test.js:2886`:
```javascript
mockSession.sendMessage = () => {}
```

The mock `sendMessage` either captures the text for assertion or does nothing. This means the test verifies that ws-server *calls* sendMessage, but never verifies that the message actually reaches the session and produces a response.

**Impact:** A bug in session message routing (e.g., wrong session ID, message transformation error) would not be caught by ws-server tests. The session tests cover session internals, but the integration boundary between ws-server and session is untested.

**Recommendation:** Replace no-op mocks with spy functions that verify:
1. The correct session received the message
2. The message content matches what the client sent
3. The response flows back through ws-server to the client

### Permission Response Tests

Permission responses are tested in session tests but the full round-trip (client sends `permission_response` -> ws-server routes to session -> session responds -> ws-server broadcasts result) is not tested end-to-end in ws-server tests.

---

## Edge Case Audit

### 1. Encryption Nonce Overflow
Nonces are JavaScript numbers, incrementing per message. At `Number.MAX_SAFE_INTEGER` (2^53 - 1), the next increment produces a floating-point number that may not match the client's expected nonce. No test covers this boundary.

**Likelihood:** Effectively zero in practice (requires 9 quadrillion messages). But a test documenting this boundary condition would be valuable for future developers.

### 2. Reconnect Mid-Stream
If the client disconnects while Claude is streaming a response, the reconnect replays history. But what about the partial message that was in-flight? Tests do not cover:
- Partial message in the history buffer on reconnect
- Content block that started but did not finish (`content_block_start` without `content_block_stop`)
- Tool use that was approved but result not yet received

### 3. Concurrent Permission Responses
If two clients are connected (possible in the current architecture) and both respond to the same permission prompt, the behavior is undefined. No test covers this scenario.

### 4. Session Destruction During Active Stream
If a user destroys a session while Claude is streaming a response, what happens? The session should clean up gracefully, but no test verifies the teardown path during active streaming.

---

## App-Side Testing Gap

The app has **243 utility/store tests** but **zero component tests**. This is a significant gap:

| Layer | Test Coverage |
|-------|--------------|
| Utilities (formatters, markdown, syntax, crypto) | Excellent |
| Store (connection state machine, connect/disconnect) | Good |
| Hooks (speech recognition) | Basic |
| Components (screens, views, UI elements) | **None** |
| Navigation (screen transitions) | **None** |
| Integration (WebSocket + store + UI) | **None** (only Maestro E2E) |

The Maestro E2E flows partially compensate but they:
- Require a booted iOS simulator
- Cannot run in CI without macOS runners
- Are slow (seconds per flow vs milliseconds for unit tests)
- Cannot test edge cases (error states, race conditions)

Adding React Native Testing Library (`@testing-library/react-native`) tests for key components would close this gap.

---

## Test Infrastructure Issues

### 1. Timing Fragility
177 `setTimeout` calls across server test files:

| File | setTimeout Count |
|------|-----------------|
| ws-server.test.js | 102 |
| output-parser.test.js | 50 |
| pty-manager.test.js | 7 |
| cli-session.test.js | 4 |
| sdk-session.test.js | 4 |
| Others | 10 |

These are mostly used for async event settling (e.g., "wait 50ms for the event to fire, then assert"). This pattern is fragile -- on slower machines or under load, 50ms may not be enough. On faster machines, it adds unnecessary delay.

**Recommendation:** Replace `setTimeout` assertions with explicit event waiters (e.g., `await once(emitter, 'event')`).

### 2. Doctor Tests Are Environment-Dependent
`doctor.test.js:33` fails locally because it checks the Node.js version against a hardcoded expectation. The test passes in CI but fails on developer machines with slightly different Node versions.

**Recommendation:** Make the test version-range aware, or mock the version check.

### 3. Failing Tests Clarification
The 1 failing test (`doctor.test.js`) is a false positive -- it is testing the doctor's version detection, and the "warn" result is actually correct for Node 22 (the doctor warns about non-latest versions). The test expectation is wrong, not the code.

---

## Top 5 Recommendations

1. **Replace no-op sendMessage mock with a spy.** `ws-server.test.js:229,2886` -- the mock should verify that the correct message reaches the correct session and that responses flow back. This is the biggest false-confidence gap.

2. **Add push.js test coverage.** Create `push.test.js` covering: device token registration, rate limiting per category, Expo Push API call formatting, error handling for API failures.

3. **Fix the doctor test.** `doctor.test.js:33` -- either update the expected value for Node 22 or make the assertion version-range aware. One failing test creates noise that hides real failures.

4. **Add coverage reporting.** Neither the server (`node --test`) nor the app (Jest) runs with coverage enabled by default. Add `--experimental-test-coverage` for server tests and `--coverage` for Jest. Track coverage over time to prevent regression.

5. **Test the 5 untested WS handlers.** `request_full_history`, `get_untracked_files`, `get_diff`, `request_session_context`, and `destroy_session` all lack dedicated test coverage. These handle user data and git operations -- they should not be untested.
