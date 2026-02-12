# Minimalist's Audit: E2E Test Suite

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.5 / 5
**Date**: 2026-02-12

## Section Ratings

| Component | Rating | Justification |
|-----------|--------|---------------|
| MockSession (124 lines) | 3/5 | `emit*` helpers earn their keep; mock methods are trivial stores; `emitReady()` is dead code |
| MockSessionManager (193 lines) | 2/5 | **~150 of 193 lines are near-copies of real SessionManager**; could inject factory instead |
| Server helpers (36 lines) | 4/5 | Clean, essential, no waste |
| Client helpers (130 lines) | 3/5 | `messagesOfType` and `getMockSession` are trivial one-liners that should be inlined |
| 12 overlapping tests | 2/5 | Health, auth, post-auth, user questions, permission, multi-client tests duplicate unit coverage |
| 22 novel tests | 4/5 | Session CRUD, streaming, model/permission, history replay, primary tracking |

## Top 5 Findings

1. **MockSessionManager is 193 lines that duplicate production code** -- `_wireSessionEvents`, `_recordHistory`, `listSessions`, etc. are near-copies. Refactor real SessionManager to accept a session factory; eliminate 170 lines.
2. **12 of 34 tests (35%) overlap with existing unit tests** -- Health, auth, post-auth, user questions, permission requests, multi-client tests add zero novel coverage. Delete for ~180 line savings.
3. **Two trivial one-liner exports should be inlined** -- `messagesOfType` = `filter()`, `getMockSession` = `getSession()?.session`. ~15 lines.
4. **`emitReady()` is dead code** -- Never called in any test. `start()` already auto-emits ready. Remove for ~5 lines.
5. **beforeEach/afterEach boilerplate repeated 9 times** -- ~60 lines of identical setup/teardown.

## The 80/20 Set (14 tests that catch 80% of regressions)

1. Session create (full create -> switch -> list cycle)
2. Session switch
3. Session destroy
4. Forward input to session
5. Streaming response (start -> delta -> end -> result)
6. Tool_start event
7. Change model
8. Permission mode with auto confirmation
9. Permission request + response
10. User question + response
11. Directory listing
12. History replay on reconnect
13. Multi-client device info + client_joined
14. Primary_changed on input

## Estimated Savings

| Change | Lines Saved |
|--------|-------------|
| Use real SessionManager with factory | ~170 |
| Delete 12 overlapping tests | ~180 |
| Inline trivial helpers | ~15 |
| Remove dead code (`emitReady`) | ~5 |
| Extract boilerplate | ~60 |
| **Total** | **~430 lines (37%)** |

## Verdict

The suite landed in an awkward middle ground. A third of the tests duplicate unit coverage. The MockSessionManager is a 193-line reimplementation that will silently drift from production. The genuinely valuable tests (session CRUD, streaming, history replay, primary tracking) could be preserved in ~300 lines total. Recommended path: inject session factory into real SessionManager, delete redundant tests, consolidate remaining into 4 suites.
