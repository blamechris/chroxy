# Tester's Audit: Chroxy v0.6.8 Full Codebase

**Agent**: Tester — Testability, edge cases, coverage gaps, test strategy.
**Overall Rating**: 3.2 / 5
**Date**: 2026-04-05

---

## Section Ratings

### Server Test Suite Coverage — 3/5

The server has an extensive test suite: ~100 test files covering session management, WebSocket protocol, file operations, tunnel management, push notifications, and more. The coverage breadth is impressive for a project this size.

**Gaps**:
- Handler modules under `packages/server/src/handlers/` have no dedicated tests. They are exercised indirectly through `ws-message-handlers.test.js`, but individual handler functions are not unit tested.
- `event-normalizer.js` is tested, but only happy paths. Error handling within normalization (malformed events from Claude Code) is not covered.
- `session-message-history.js` has no test for the unbounded growth scenario.

### Respawn Bound Testing — 2/5

`supervisor.js` implements a respawn backoff. The tests (`supervisor.test.js`) test individual restart events but do not verify the maximum restart count is enforced and that the supervisor exits after hitting it. A test that fires 15 rapid crashes and asserts the supervisor exits is missing.

**Risk**: If the backoff cap logic has an off-by-one error, the supervisor will either: (a) exit one restart early (surprising), or (b) never exit (infinite restart loop). Neither scenario is caught by the current tests.

### Backpressure Testing — 2/5

`ws-server-backpressure.test.js` exists and tests basic backpressure. However, the ordering invariant — that messages delivered after backpressure drains are in the correct order — is not tested. The current tests verify that the server does not crash under backpressure, not that messages arrive in order.

### Integration Test Coverage — 3/5

Three integration tests exist:
- `integration/ws-roundtrip.test.js`
- `integration/permission-whitelist.test.js`
- `integration/docker-sdk-roundtrip.test.js`

The Docker integration test is skipped if Docker is not available (reasonable). The WS roundtrip test covers the auth flow but not E2E encryption. An integration test that performs an encrypted session end-to-end is missing.

### App Test Suite — 4/5

The React Native app has good test coverage for stores, hooks, and components. The Zustand store tests (`connection.test.ts`, `conversation-store.test.ts`, etc.) are thorough. The main gap is UI interaction tests — component tests validate rendering but not user interaction flows (scrolling, input, modal behavior).

### store-core Tests — 4/5

`packages/store-core/src/crypto.test.ts` now has 31 tests covering createKeyPair, deriveSharedKey, nonce generation, encrypt/decrypt round-trips, error handling, and overflow guards. Good coverage. One gap: no test for nonce reuse behavior (the critical security finding) — a test that demonstrates the keystream reuse attack would serve as both documentation and regression guard.

---

## Top 5 Findings

1. **Handler modules have no unit tests** (`handlers/*.js`): 9 handler files, 0 dedicated tests. Handler logic is tested only as a side effect of WS roundtrip tests. Extract handler logic to pure functions and test directly. Effort: ~1 day.

2. **Supervisor max-retry enforcement not tested** (`supervisor.test.js`): No test verifies the supervisor exits after max retries. Add: fire N+1 crashes, assert supervisor emits `exit` event, assert no further restarts occur.

3. **Backpressure message ordering not tested** (`ws-server-backpressure.test.js`): Messages delivered after drain are not order-checked. Add: send 100 messages under backpressure, verify received sequence matches sent sequence.

4. **No encrypted E2E integration test**: The WS roundtrip integration test uses plaintext. No test exercises the full encrypt → transmit → decrypt path against a real server. Add one integration test that enables encryption and validates a round-trip.

5. **No nonce-reuse demonstration test** (`crypto.test.ts`): The critical security finding (nonce resets to 0 on reconnect) has no regression test. Add a test that creates two encryption sessions with the same key and demonstrates ciphertext XOR recovery. This serves as documentation and a canary for the fix.

---

## Missing Test Scenarios

| Scenario | Current Coverage | Risk if Missing |
|----------|-----------------|-----------------|
| Handler error propagation | None | Client hangs on any handler error |
| Supervisor exits at max retries | None | Infinite restart loop possible |
| Encrypted WS roundtrip | None | Crypto regression goes undetected |
| Symlink read in file ops | None | TOCTOU exploit not caught in CI |
| Rate limiter with tunneled IP | None | Bypass not caught in CI |
| Large message (10MB) rejection | None | OOM DoS not caught in CI |
| Session destroy during reconnect | None | Race condition not detected |

---

## Concrete Recommendations

1. Create `packages/server/tests/handlers/` directory, add one test file per handler module with at least happy path + error path tests.
2. Add `supervisor-max-retry-exit.test.js`: fire 12 crashes, assert supervisor emits `exit` and process does not respawn after.
3. Add ordering assertion to `ws-server-backpressure.test.js`: send messages, saturate, drain, verify order.
4. Add `integration/encrypted-roundtrip.test.js`: performs a full encrypted WS session.
5. Add `crypto.reuse.test.ts`: demonstrates nonce reuse attack, serves as regression guard for the fix.

---

## Overall Verdict

The Chroxy test suite is above average for an open-source project of this size. The server unit tests are comprehensive and the app store tests are well-written. The gaps are in integration testing (no encrypted roundtrip), specific risk scenarios (supervisor exit, backpressure ordering), and the new handler modules (untested). The most impactful addition would be an encrypted E2E integration test — it would have caught the nonce reuse bug earlier if it existed. The handler unit tests would significantly reduce debugging time for production issues.

**Overall Rating: 3.2 / 5**
