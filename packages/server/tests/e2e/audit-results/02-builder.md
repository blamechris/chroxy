# Builder's Audit: E2E Test Suite

**Agent**: Builder -- Pragmatic full-stack dev who will maintain this test suite
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-12

## Section Ratings

| Component | Rating | Justification |
|-----------|--------|---------------|
| Harness: MockSession | 4/5 | Faithful interface; `emit*` helpers well-designed; `start()` 10ms timer is a magic number |
| Harness: MockSessionManager | 4/5 | Complete interface; history recording mirrors production; `_wireSessionEvents` matches real code |
| Harness: Server helpers | 4/5 | Clean startup with port 0; duplicates pattern from ws-server.test.js |
| Harness: Client helpers | 3/5 | `messagesOfType` and `getMockSession` barely justify export; `waitForMessage` returns first match not latest |
| Test: Health | 2/5 | Overlaps ws-server.test.js; only 404 test is novel |
| Test: Auth | 2/5 | Strict subset of unit test coverage |
| Test: Post-auth | 2/5 | Strict subset of unit test coverage |
| Test: Session CRUD | 4/5 | **Best section** -- unique lifecycle testing through real WS protocol |
| Test: Streaming | 3/5 | Streaming and tool_start are novel; delta buffering untested |
| Test: Model/Permission | 3/5 | Mostly novel; weak negative assertion on invalid model |
| Test: Multi-client | 2/5 | Overlaps unit tests; device info mildly novel |
| Test: History replay | 4/5 | Genuinely novel cross-session flow |
| CI integration | 4/5 | Correct; missing test timeout flag |

## Top 5 Findings

1. **Critical protocol flows NOT tested** -- POST /permission, delta buffering, drain mode, rate limiting, transient events (agent/plan)
2. **Negative test weakness** -- "rejects invalid model" uses timing-based absence check (`setTimeout(200)` + `<= 1`)
3. **Boilerplate in describe blocks** -- 9 repetitions of identical beforeEach/afterEach (~8 lines each)
4. **Device info test has confusing server lifecycle** -- Closes beforeEach server and creates a new one mid-test
5. **`waitForMessage` returns first match** -- Should support `afterIndex` parameter for repeated message types

## Verdict

Solid first-generation E2E suite. The harness is clean and extensible. Session CRUD lifecycle, streaming, and history replay are the highest-value tests. However, ~12 of 34 tests overlap with existing unit tests, and the suite is roughly halfway to comprehensive protocol coverage. The CI integration works and will catch regressions in tested flows.
