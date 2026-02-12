# Guardian's Audit: E2E Test Suite

**Agent**: Guardian -- Paranoid SRE who finds race conditions, resource leaks, and flakiness sources
**Overall Rating**: 3.0 / 5
**Date**: 2026-02-12

## Section Ratings

| Area | Rating | Justification |
|------|--------|---------------|
| Server lifecycle cleanup | 3/5 | `afterEach` calls `server.close()` but not awaited; delta flush timer survives close |
| WebSocket client cleanup | 3/5 | Every test has `closeClient` at end but **leaks on assertion failure** |
| MockSession.start() timer | 2/5 | 10ms timer never cancelled on destroy; can emit `ready` on destroyed session |
| waitFor() polling | 3/5 | 10ms poll with 2s timeout is adequate; negative-assertion sleeps are flakiness landmines |
| WsServer interval cleanup | 4/5 | Ping and auth intervals properly cleared; delta flush timer is NOT cleared |
| Event listener accumulation | 3/5 | Session listeners not removed on destroy; minor since sessions are GC'd per-test |
| Port conflict safety | 5/5 | Port 0 used exclusively; conflicts impossible |
| Test isolation | 3/5 | Fresh servers per suite; device info test has confusing lifecycle; no double-close guard |

## Top 5 Findings

1. **Client WebSocket leak on test failure (CRITICAL)** -- All 34 tests follow `connectClient` -> assertions -> `closeClient` pattern with no try/finally. Any assertion failure skips `closeClient`, leaking the connection.
2. **Delta flush timer survives server close** -- `deltaFlushTimer` at `ws-server.js:1086` is local to a closure and unreachable by `close()`. Can fire post-shutdown.
3. **MockSession.start() timer not cancelled on destroy** -- Can emit `ready` on a destroyed session, propagating events into cleaned-up session manager.
4. **closeClient force-timeout never cleared** -- 500ms timer per `closeClient` call is never cancelled on normal close. 34-68 dangling timers per test run.
5. **Negative-assertion sleep pattern** -- `setTimeout(100)` / `setTimeout(200)` + absence checks are classic flakiness sources.

## Recommendations

1. Track client sockets in afterEach and close them all (highest impact fix)
2. Store `start()` timer handle and clear in `destroy()`
3. Clear force-timeout in `closeClient` when close event fires
4. Replace sleep-based negative assertions with sentinel-message pattern

## Verdict

The fundamentals are right: OS-assigned ports, fresh servers per suite, clean `waitFor` polling. However, the systematic resource leak on assertion failure (all 34 tests vulnerable) and three categories of dangling timers will surface as mysterious flakes on loaded CI. The fixes are straightforward.
