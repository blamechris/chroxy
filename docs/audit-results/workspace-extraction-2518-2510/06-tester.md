# Tester's Audit: Workspace Extraction (#2518, #2510)

**Agent**: Tester -- QA architect obsessed with testability and coverage
**Overall Rating**: 2.5/5
**Date**: 2026-03-19

## Methodology

Audited test coverage for all code proposed for extraction. Measured handler coverage by message type. Identified untested critical paths. Evaluated test portability for cross-package extraction.

## Finding 1: Handler Coverage by Message Type

**Severity**: High (extraction risk without coverage)

### App handler coverage

| Metric | Value |
|--------|-------|
| Test files | 45+ |
| Test lines | ~13,000 |
| Message types handled | 82 |
| Message types with tests | 31 |
| Coverage | 37.8% |

**Tested types** include: `stream_start`, `stream_delta`, `stream_end`, `tool_start`, `tool_end`, `permission_request`, `session_list`, `session_started`, `error`, and ~22 others.

**Untested types** include: `auth_ok`, `auth_error`, `server_restart`, `plan_started`, `plan_ready`, `models_updated`, `background_agent_*`, and ~51 others.

### Dashboard handler coverage

| Metric | Value |
|--------|-------|
| Test files | 88 |
| Test lines | ~13,869 |
| Message types handled | 53 |
| Message types with tests | ~8 |
| Coverage | ~15% |

The dashboard has many test files but most test UI components and store logic, not message handlers directly. Only ~8 message types have explicit handler tests.

### Coverage gap

37 message types are app-only (no dashboard handler). 8 message types are dashboard-only (no app handler). Only ~45 types overlap. Of those 45, only ~6 have tests in BOTH codebases.

**Extracting handlers with 37.8% and 15% coverage means 62-85% of the extracted code has no safety net.** Any bug introduced during extraction would be undetected until runtime.

## Finding 2: auth_ok -- The Scariest Untested Path

**Severity**: Critical (zero coverage on most complex handler)

The `auth_ok` handler is the most complex handler in both codebases (~120 lines in app, ~90 lines in dashboard). It:

1. Stores the authentication token
2. Initializes session state
3. Sets up encryption context (nonce counters, key material)
4. Triggers session list request
5. Processes server capabilities
6. Configures push notification registration
7. Sets connection phase to `connected`
8. Emits events that trigger UI transitions

**Zero tests in either codebase.** Not a single test exercises the auth_ok path.

This handler is:
- The first handler called after WebSocket connection
- The gateway to all subsequent functionality
- The most likely to break during extraction (touches encryption, state, side effects)
- The hardest to debug when broken (failure = blank screen, no error)

**This is the single most important test to write before any extraction work begins.**

## Finding 3: No Handler Coverage Contract Test

**Severity**: High (drift detection gap)

There is no test that verifies both handlers support the same `ServerMessageType` values. The protocol package defines all message types, but neither consumer is tested against the full list.

Current state:
- `@chroxy/protocol` defines ~90 `ServerMessageType` values
- App handles 82 of them
- Dashboard handles 53 of them
- 37 are app-only, 8 are dashboard-only
- No test verifies this or alerts when a new type is added to one but not the other

**A contract test should:**
1. Import all `ServerMessageType` values from `@chroxy/protocol`
2. Import the handler registry from each consumer
3. Assert that both consumers handle the same set of types (or explicitly mark types as platform-specific)
4. Fail CI when a new type is added to protocol but not to handlers

This test should live in `@chroxy/protocol` (or a new `packages/integration-tests/` package) and run in CI.

## Finding 4: store-core Tests Exist but Are NOT in CI

**Severity**: Medium (false confidence)

`packages/store-core/` has test files, but they are not executed in CI:

- CI runs: server tests, server lint, app typecheck
- CI does NOT run: store-core tests, dashboard tests (separately)

Store-core tests run locally with `npm test` in the package directory, but there's no CI job for them. This means:

- Tests could be broken on main without anyone knowing
- Extracted code could have passing local tests but broken CI
- No regression detection for store-core changes

**Before extracting anything into store-core, add it to CI.** This is a prerequisite, not an afterthought.

## Finding 5: Test Portability Is LOW

**Severity**: High (effort multiplier)

App handler tests are deeply coupled to React Native test infrastructure:

```
jest.mock('react-native', ...)
jest.mock('expo-secure-store', ...)
jest.mock('expo-haptics', ...)
jest.mock('@react-navigation/native', ...)
jest.mock('expo-speech-recognition', ...)
// ... 10+ more RN module mocks in jest.setup.js
```

These mocks are in `jest.setup.js` and are required for any test that imports from the app's store layer. Moving handler tests to store-core means:

1. Store-core tests can't use RN mocks (store-core is framework-agnostic)
2. Handler tests need to be rewritten to use the DI adapter interface instead of mocking RN modules
3. Existing app tests become integration tests that verify the adapter layer
4. Test utilities (`createMockSession()` in `test-helpers.js`) need store-core-compatible versions

**Estimated test migration effort**: 3-4 days just for test rewiring, on top of the handler extraction itself.

### Recommended test strategy for extraction

1. **Before extraction**: Write `auth_ok` tests for both handlers. Add handler contract test. Add store-core to CI.
2. **During extraction**: Create behavioral snapshot tests -- capture current handler output for each message type, then verify extracted handlers produce identical output.
3. **After extraction**: Convert snapshot tests to proper unit tests. Add property-based tests for stateless handlers.

## Recommendation

1. **Write `auth_ok` tests before any extraction** -- this is the most complex, most critical, and completely untested handler. Both app and dashboard need coverage.
2. **Add handler coverage contract test** to `@chroxy/protocol` -- verifies both consumers handle the same message types. Catches drift immediately.
3. **Add store-core tests to CI** -- without this, extraction provides false confidence.
4. **Create behavioral snapshot tests** before moving any handler -- capture inputs and outputs for regression detection.
5. **Budget 3-4 days for test migration** on top of handler extraction effort -- the Builder's 5-6 day estimate should be 8-10 days when test work is included.
