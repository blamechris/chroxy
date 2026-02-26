# Tester's Audit: Chroxy Codebase Re-Baseline

**Agent**: Tester — Quality engineer who measures coverage, identifies untested paths, and validates test effectiveness
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 4/5 | Good unit test coverage for core modules; integration gaps |
| App | 3/5 | Type safety compensates somewhat, but runtime test coverage is thin |
| Desktop | 2/5 | Dashboard has zero test coverage — cannot be tested in current form |
| WS Protocol | 3/5 | Schema tests exist but schema itself is incomplete |
| Testing Infrastructure | 4/5 | Test helpers, mocks, and CI pipeline are well-structured |
| Security Testing | 3/5 | Auth flow tested; no fuzzing, no adversarial input tests |
| E2E Testing | 3.5/5 | Maestro flows cover connect screen; no flows for session or history |
| Regression Safety | 3.5/5 | CI catches type errors and lint; runtime regressions slip through |

---

## Top 5 Findings

### 1. list_conversations and resume_conversation Have Zero Test Coverage at Every Layer

**Severity**: Critical
**Status**: Open

The conversation history feature has no tests at any layer — no unit tests for the handlers, no integration tests for the message flow, no E2E tests for the UI. This is the root cause of the schema validation bug (the feature shipped broken because no test exercised the full path).

**Evidence**:
- `ws-message-handlers.js:427-473` — handler code for both types, zero test references
- `ws-server.test.js` — no test case sends `list_conversations` or `resume_conversation`
- `conversation-scanner.test.js` — tests the scanner module in isolation but not its integration with WS handlers
- `message-handler.ts` — handles `conversations_list` and `conversation_resumed` response types, untested
- `HistoryScreen.tsx` — no component tests

**Test gap analysis**:
| Layer | File | Tested? |
|-------|------|---------|
| Schema | ws-schemas.js | No — types not in schema |
| Handler | ws-message-handlers.js | No |
| Integration | ws-server.js dispatch | No |
| Scanner | conversation-scanner.js | Partial (unit only) |
| App handler | message-handler.ts | No |
| UI | HistoryScreen.tsx | No |
| E2E | Maestro flows | No |

**Impact**: A feature shipped broken to production with no automated safety net to catch it.

**Recommendation**: Before fixing the schema bug, write the tests first (TDD approach). Create an integration test that sends `list_conversations` through a WebSocket connection and verifies the response. Add a handler unit test. Add a Maestro flow for the HistoryScreen.

---

### 2. ws-message-handlers.js Is Never Directly Tested

**Severity**: High
**Status**: Open

`ws-message-handlers.js` contains the dispatch logic for all client message types — the core of the server's WebSocket protocol implementation. Despite this, it has no dedicated test file. All existing coverage comes indirectly through `ws-server.test.js`, which tests the handlers through the full server stack.

**Evidence**:
- No `ws-message-handlers.test.js` file exists
- `ws-server.test.js` tests handlers indirectly by sending messages through a WebSocket connection
- Indirect testing means handler bugs are conflated with transport bugs, auth bugs, and setup bugs
- Handler functions are exported and could be tested in isolation with mock context objects

**Impact**: When a handler test fails in `ws-server.test.js`, it is unclear whether the issue is in the handler, the dispatch, the WebSocket layer, or the test setup. Debugging is slow. New handlers are often added without tests because the barrier to testing is too high.

**Recommendation**: Create `ws-message-handlers.test.js` that tests each handler function in isolation. Mock the context object (session, WebSocket send, etc.) and verify that each handler produces the correct side effects and responses. This would also enable testing the unreachable `list_conversations` and `resume_conversation` handlers.

---

### 3. message-handler.ts Handles 67 Message Types but Only 3 Are Tested

**Severity**: High
**Status**: Open

The app's `message-handler.ts` is a 1906-line file that processes 67 distinct server message types and translates them into Zustand store mutations. Only 3 of these types have any test coverage.

**Evidence**:
- `message-handler.ts` — 67 distinct message type handlers (counted by case/if branches)
- `message-handler.test.ts` — tests exist for `assistant`, `tool_use`, and `result` types only
- Untested types include: `plan_started`, `plan_ready`, `cost_update`, `models_updated`, `permission_request`, `background_agents`, `conversations_list`, `budget_status`, and 55 more
- Coverage: 3/67 = 4.5%

**Impact**: Any change to message handling logic risks breaking untested paths. Refactoring the file (as recommended by the Builder) is dangerous without test coverage to verify behavior preservation.

**Recommendation**: Before any refactoring of message-handler.ts, add snapshot-style tests for each message type: given a specific incoming message, assert the expected store mutations. This provides a safety net for future changes. Prioritize testing message types that trigger user-visible state changes (permissions, plan mode, cost updates).

---

### 4. 102 Sleep-Based Assertions Across the Test Suite

**Severity**: Medium
**Status**: Open

The test suite contains 102 instances of `setTimeout`, `sleep`, or `await new Promise(resolve => setTimeout(resolve, ...))` used to wait for asynchronous operations before asserting. These introduce flakiness (too short = intermittent failure, too long = slow suite) and obscure the actual timing contract.

**Evidence**:
- Grep for `setTimeout` in test files — 78 instances
- Grep for `sleep` in test files — 24 instances
- Common pattern: `await sleep(100); expect(spy).toHaveBeenCalled()`
- Sleep durations range from 10ms to 2000ms with no clear rationale for specific values
- Total added delay from sleeps: estimated 15-30 seconds per full suite run

**Impact**: Tests are slower than necessary and prone to timing-dependent failures, especially on CI runners with variable performance. Sleep-based tests do not document the actual timing contract — is 100ms the expected latency, or just "long enough"?

**Recommendation**: Replace sleep-based waits with event-driven assertions. Use `waitFor` utilities that poll a condition with short intervals and a timeout. For EventEmitter-based code, await the specific event. For Zustand store changes, use `subscribe` with a promise wrapper. Target eliminating at least 80% of sleep-based assertions.

---

### 5. HistoryScreen Has No Component or E2E Tests

**Severity**: Medium
**Status**: Open

`HistoryScreen.tsx` — the conversation history UI — has no component-level tests and no Maestro E2E flow. This is a screen that users navigate to, that depends on async data loading, and that has multiple states (loading, empty, populated, error). None of these states are verified by any automated test.

**Evidence**:
- No `HistoryScreen.test.tsx` file
- `packages/app/.maestro/` — no flow for HistoryScreen
- The screen has at least 4 distinct states: loading, empty (no conversations), populated list, error
- Each state renders different UI elements that should be verified

**Impact**: UI regressions in the HistoryScreen are invisible until a human manually navigates to the screen and checks each state.

**Recommendation**: Add a component test using React Native Testing Library that renders HistoryScreen with mocked store states (loading, empty, populated, error) and verifies the correct UI elements are present. Add a Maestro flow that navigates to the History tab and verifies the screen renders. Once the schema bug is fixed, extend the Maestro flow to verify populated state with real data.

---

## Verdict

Chroxy's test infrastructure is well-designed — the CI pipeline, test helpers, mock utilities, and Maestro setup provide a solid foundation. The problem is coverage distribution. Core modules like ws-server.js and session management are well-tested, but newer features (conversation history, plan mode UI, cost tracking, agent monitoring) shipped with little or no test coverage. The most damaging example is the conversation history feature, which is broken in production because no test ever sent a `list_conversations` message through the full stack. The 102 sleep-based assertions add fragility and slowness without documenting real timing contracts. The path forward is clear: write integration tests for new features before (or alongside) the code, replace sleeps with event-driven waits, and create dedicated test files for modules that are currently only tested indirectly.
