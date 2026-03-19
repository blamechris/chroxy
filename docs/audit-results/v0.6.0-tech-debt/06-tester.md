# Tester's Audit: Chroxy v0.6.0 Tech Debt

**Agent**: Tester
**Overall Rating**: 3.0/5
**Date**: 2026-03-18

## Perspective

The Tester evaluates the codebase for test coverage, test quality, and confidence in making changes. Asks: *if I change this line, will a test tell me if I broke something?*

---

## 1. Coverage Gaps (2.0/5)

### Server: ~30% of critical files untested

| File | Lines | Tests | Risk |
|------|-------|-------|------|
| `server-cli.js` | ~350 | None | CLI entry point, flag parsing |
| `handler-utils.js` | 175 | None | **Security-critical** path validation |
| `environment-manager.js` | 743 | None | Docker operations, state management |
| `supervisor.js` | ~280 | None | Process lifecycle, IPC |
| CLI commands (`cmd-*.js`) | ~600 total | None | User-facing commands |

The existing test suite covers `ws-server.js`, `session-manager.js`, `config.js`, `models.js`, `crypto.js`, and `ws-schemas.js`. This is the core protocol layer, which is good. But the operational layer (CLI, Docker, process management) is entirely untested.

### App: all 6 screens untested

| Screen | Lines | Tests |
|--------|-------|-------|
| `SessionScreen.tsx` | 1,408 | None |
| `ConnectScreen.tsx` | ~350 | None |
| `SettingsScreen.tsx` | ~250 | None |
| `OnboardingScreen.tsx` | ~200 | None |
| `SearchScreen.tsx` | ~150 | None |
| `AgentMonitorScreen.tsx` | ~180 | None |

The app has tests for `message-handler.ts` and some store modules, but zero component tests. The Maestro E2E flows provide some UI coverage for ConnectScreen, but they are not part of CI and require a running simulator.

### Dashboard: zero tests
`packages/server/src/dashboard-next/` has no test files at all. The dashboard shares the same message handler architecture as the app, but unlike the app, it has no test coverage of any kind.

---

## 2. Test Quality (3.0/5)

### Good: shared test helpers
`packages/server/tests/test-helpers.js` provides `createSpy()` and `createMockSession()` — well-designed utilities that reduce boilerplate and encourage consistent test patterns.

### Good: ws-server.test.js structure
The WebSocket server tests are well-organized with proper setup/teardown, realistic mock sessions, and meaningful assertions. The auth extraction test is a model for how to test protocol-level behavior.

### Bad: private member access
Multiple test files access private members directly:
- `ws-server.test.js` reads `server._clients`, `server._authFailures`
- `session-manager.test.js` reads `manager._sessions`, `manager._stateFile`

This couples tests to implementation details. Refactoring internals (e.g., changing `_clients` from Map to WeakMap) would break tests even if behavior is preserved.

### Bad: no test isolation for stateful modules
`models.js` has mutable module-level state. Tests call `resetModels()` in `afterEach`, but if an assertion fails and throws before `afterEach`, the state leaks into subsequent tests. Using `beforeEach` reset would be safer.

---

## 3. Flaky Test Patterns (3.0/5)

### Timing-dependent assertions
Several tests use `setTimeout` or `await new Promise(r => setTimeout(r, N))` to wait for async operations:
- Delta batching tests wait 100ms for batch flush
- WebSocket tests wait 50ms for message delivery
- Session state persistence tests wait 200ms for debounced write

On a loaded CI runner, these timeouts can be insufficient. On a fast machine, they waste time.

**Recommendation**: Use deterministic triggers (flush functions, drain events) instead of wall-clock waits.

### Port conflicts in parallel runs
`ws-server.test.js` starts a real HTTP server. If multiple test files run in parallel (Node.js `--test` default), they can conflict on ports. Currently mitigated by using port 0 (random), but some tests hardcode expectations about the server address.

---

## 4. Missing Edge Case Tests (3.5/5)

### Concurrent session operations
No test exercises two clients creating sessions simultaneously, or one client destroying a session while another reads from it. Given the EnvironmentManager concurrency issues found by the Guardian, these tests would catch real bugs.

### Encryption roundtrip
`crypto.js` has tests for encrypt and decrypt individually, but no test verifies that `decrypt(encrypt(plaintext))` returns the original plaintext across various input sizes (empty, large, binary, Unicode).

### Reconnection behavior
No test verifies that:
- A client reconnecting receives the correct session state
- Messages sent during reconnection are properly queued
- The `connectionAttemptId` mechanism correctly cancels stale reconnection chains

### Plan mode lifecycle
No test exercises the full plan mode lifecycle:
- Enter plan mode -> receive plan content -> approve/reject -> exit plan mode
- Plan mode persisting across turns
- Plan mode interaction with session serialization

---

## 5. Infrastructure Gaps (3.5/5)

### No coverage measurement
The project has no coverage tool configured. Neither `c8` (server) nor `jest --coverage` (app) is set up. Without coverage numbers, it is impossible to track progress on closing gaps or detect coverage regressions.

**Recommendation**: Add `c8` to server test script, `jest --coverage` to app test script. Add coverage thresholds to CI to prevent regressions.

### No test categorization
All tests run in a single pass. There is no distinction between:
- Unit tests (fast, no I/O)
- Integration tests (WebSocket server, file I/O)
- E2E tests (Maestro flows)

This means CI runs everything or nothing. A failing integration test blocks the fast unit test feedback loop.

### Maestro flows not in CI
The Maestro E2E flows exist but are not part of any CI pipeline. They require a simulator, which makes CI integration non-trivial but not impossible (macOS runners support Xcode simulators).

---

## Summary

The test suite covers the protocol core well but leaves operational code, UI code, and the entire dashboard untested. The existing tests are well-structured but rely on timing and private member access. The biggest infrastructure gap is the lack of coverage measurement — without it, coverage improvements are unverifiable.

**Priority order for test investment:**
1. `handler-utils.js` — security-critical, 175 lines, easy to test
2. Coverage measurement (`c8` + `jest --coverage`)
3. `environment-manager.js` — concurrent operation tests
4. Component tests for SessionScreen (highest complexity screen)
5. Encryption roundtrip test

| Area | Rating | Priority |
|------|--------|----------|
| Coverage gaps | 2.0/5 | **High** |
| Test quality | 3.0/5 | Medium |
| Flaky patterns | 3.0/5 | Medium |
| Edge case gaps | 3.5/5 | Medium |
| Infrastructure | 3.5/5 | Medium |
