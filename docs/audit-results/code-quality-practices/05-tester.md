# Tester's Audit: Codebase-Wide Code Quality

**Agent**: Tester -- Meticulous QA engineer focused on coverage gaps and test quality
**Overall Rating**: 3.0 / 5
**Date**: 2026-03-15

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Server Tests | 3.5/5 | Broad coverage, strong security tests, source-scan anti-pattern |
| App Tests | 2.5/5 | 81 message types, only 11 tested; all screens untested |
| Desktop/Dashboard Tests | 3/5 | RTL pattern is healthy; Rust tests not in CI |
| Integration Tests | 2/5 | One file, 7 tests for entire WS protocol |

---

## Finding 1 — `ws-auth.js` has zero direct tests (244 lines)

Implements `handleAuthMessage`, `handlePairMessage`, `handleKeyExchange` — the three functions gating every client connection. Contains exponential backoff logic, protocol version negotiation, device info sanitization, and pairing flow. Tested only incidentally through full-server `ws-server.test.js`, which uses `authRequired: false` in most cases.

---

## Finding 2 — `ws-history.js` has zero tests

Implements `sendPostAuthInfo`, `replayHistory`, `flushPostAuthQueue`, `sendSessionInfo` — responsible for delivering all post-auth state to newly connected clients. The encryption pending queue logic and localhost bypass path are never tested in isolation.

---

## Finding 3 — Source-code analysis tests are overused and fragile

38 server test files use `readFileSync` to parse source code and assert on string inclusion. These cannot catch behavioral regressions — a developer could move a handler inside a conditional and the test still passes. 8 app component test files follow the same pattern. ~25% of server tests and the majority of app component tests verify text rather than behavior.

---

## Finding 4 — `codex-session.js` is completely untested (246 lines)

Spawns a real child process, parses JSONL output, maps Codex events to the provider contract. No test file exists. The JSONL parsing and event mapping should have unit tests following the `GeminiSession` test pattern.

---

## Finding 5 — Message handler covers only 14% of message types

`message-handler.ts` has 81 case branches. `message-handler.test.ts` exercises exactly 11 distinct types. Critical untested paths: `permission_request`, `stream_start`/`stream_delta` ID collision remapping, `budget_exceeded`/`budget_resumed`, `auth_ok` session initialization, `result` cost accumulation.

---

## Additional Gaps

- **All 6 app screens have zero tests** (ConnectScreen, SessionScreen, SettingsScreen, HistoryScreen, OnboardingScreen, PermissionHistoryScreen)
- **Rust tests not in CI**: 65 `#[test]` functions in Tauri source, no `cargo test` in GitHub Actions
- **No cross-package integration tests**: Server and app tested entirely independently with mocks at the boundary
- **`handler-utils.js` attachment validation**: Multiple decision paths (image allowlist, size limits, path traversal) with no focused test file
- **`waitFor` polling pattern**: 10ms polling loop with 2-second timeout is a CI flakiness risk
- **`createMockSession` spy never validates argument shape**: Tests assert `lastCall[0]` but never verify full argument structure
