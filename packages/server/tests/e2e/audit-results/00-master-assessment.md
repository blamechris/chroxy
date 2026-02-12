# Master Assessment: E2E Test Suite Swarm Audit

**Target**: `packages/server/tests/e2e/` (harness.js + protocol.e2e.test.js)
**Date**: 2026-02-12
**Agents**: 6

---

## a. Auditor Panel

| Agent | Perspective | Rating | Key Contribution |
|-------|-------------|--------|------------------|
| Skeptic | Claims vs reality | 3.0/5 | Identified 50% protocol message coverage gap; POST /permission hook untested |
| Builder | Maintainability & gaps | 3.5/5 | Mapped overlap with unit tests; identified boilerplate and DRY violations |
| Guardian | Safety & flakiness | 3.0/5 | Found client WebSocket leak on assertion failure (all 34 tests); dangling timers |
| Minimalist | Complexity reduction | 2.5/5 | MockSessionManager is 193 lines of production duplication; 12/34 tests redundant |
| Tester | Test strategy & coverage | 3.2/5 | Protocol state machine transitions untested; delta buffering has zero coverage |
| Adversary | Security & attack surface | 2.5/5 | Pre-auth injection untested; non-string input can crash server (potential bug) |

---

## b. Consensus Findings (4+ agents agree)

### 1. Delta buffering (50ms) is never exercised
**Agents**: Skeptic, Builder, Tester, Guardian
**Evidence**: `ws-server.js:1082-1093` implements 50ms batching. `MockSession.emitStream()` (`harness.js:84-97`) fires all events synchronously. The timer path never fires.
**Action**: Add async stream simulation that emits deltas across event loop ticks.

### 2. Client WebSocket connections leak on test failure
**Agents**: Guardian, Builder, Tester, Minimalist
**Evidence**: All 34 tests follow `connectClient() -> assertions -> closeClient()` with no try/finally. Assertion failures skip `closeClient`.
**Action**: Track clients in afterEach or wrap in try/finally.

### 3. ~12 tests overlap with existing unit tests
**Agents**: Minimalist, Builder, Skeptic, Tester
**Evidence**: Health, auth, post-auth, user questions, and permission request tests duplicate `ws-server.test.js` coverage.
**Action**: Consider removing or merging redundant tests. Prioritize novel coverage (session CRUD, streaming, history replay).

### 4. MockSessionManager duplicates production code and will drift
**Agents**: Skeptic, Minimalist, Tester, Builder
**Evidence**: `harness.js:246-324` near-copies `session-manager.js:505-633`. Missing `tool_start`/`user_question` in history, no ring buffer cap.
**Action**: Inject session factory into real SessionManager, or extract shared history logic.

### 5. POST /permission HTTP hook has zero E2E coverage
**Agents**: Skeptic, Builder, Tester, Adversary
**Evidence**: `ws-server.js:1578-1680` (102 lines) handles HTTP-held-open permission flow. No E2E test exercises it.
**Action**: Add test that POSTs to `/permission`, receives WS `permission_request`, responds via WS, verifies HTTP response resolves.

### 6. Negative assertions use fragile sleep patterns
**Agents**: Guardian, Builder, Tester, Adversary
**Evidence**: `protocol.e2e.test.js:292` (`setTimeout(100)`) and `:363` (`setTimeout(200)`) + absence checks.
**Action**: Use sentinel-message pattern: send a follow-up, wait for it, then assert absence.

---

## c. Contested Points

### MockSessionManager: Replace vs Keep?
- **Minimalist** (strongly for replace): "193 lines of near-copied production code. Use real SessionManager with injected factory. Save 170 lines."
- **Builder** (neutral): "The mock is adequate and well-structured. Refactoring SessionManager adds coupling between test and production code."
- **Skeptic** (leans replace): "The divergence in history recording is a real problem that will cause silent test rot."

**Assessment**: Minimalist is right that the duplication is costly, but the refactor is non-trivial -- SessionManager.createSession does `statSync` validation and constructs specific session types. A cleaner middle ground: extract `_wireSessionEvents` and `_recordHistory` as importable utilities shared between real and mock.

### 12 Redundant Tests: Delete or Keep?
- **Minimalist** (strongly for delete): "35% of tests add zero novel coverage. Delete them."
- **Builder** (keep some): "The E2E versions test through real WebSocket connections in a different integration context. They're not pure duplicates."
- **Tester** (conditional keep): "Keep auth tests as smoke tests; delete health endpoint tests."

**Assessment**: The E2E auth tests are genuinely running through a different code path (auto-auth vs token auth with real WS). Health tests are pure duplication. Recommend: delete health tests (3), keep auth tests (3), evaluate the rest case-by-case.

---

## d. Factual Corrections

| Claim/Issue | Found By | Correction |
|-------------|----------|------------|
| Mock `_recordHistory` matches production | Skeptic, Minimalist | Missing `tool_start` recording (`session-manager.js:556-563`), `user_question` recording (`:576-583`), `options` field (`:549`), and ring buffer cap (`:590-595`) |
| `emitReady()` is used in tests | -- | Minimalist found it is **dead code** -- never called in any test file |
| Non-string `input.data` is handled safely | Adversary | **Potential bug**: `ws-server.js:630` calls `text.trim()` which throws TypeError if `data` is a number |

---

## e. Risk Heatmap

```
Impact →     Low         Medium       High         Critical
Likelihood
  ↓
High      │ Timer leaks │ Flaky CI   │            │
          │ (Guardian)  │ (Guardian) │            │
          │             │            │            │
Medium    │ Test        │ Mock drift │ Pre-auth   │ Input type
          │ redundancy  │ hides bugs │ bypass gap │ crash (Adv)
          │ (Minimalist)│ (Skeptic)  │ (Adversary)│
          │             │            │            │
Low       │ Boilerplate │ Delta buf  │ Permission │ HTTP perm
          │ DRY (Build) │ untested   │ race cond  │ untested
          │             │ (Tester)   │ (Adversary)│ (Skeptic)
```

---

## f. Recommended Action Plan

### P0 -- Fix Now (safety/correctness)

1. **Fix client cleanup on test failure** (Guardian)
   - Add client tracking to afterEach or use try/finally wrapper
   - Impact: Prevents leaked sockets and flaky CI
   - Effort: ~20 lines

2. **Investigate non-string input crash** (Adversary)
   - `ws-server.js:630` may throw TypeError on `data: 12345`
   - Add type guard: `if (typeof text !== 'string' || !text.trim()) break`
   - Add E2E test for type-confused input
   - Effort: ~5 lines fix + ~15 lines test

3. **Cancel MockSession.start() timer on destroy** (Guardian)
   - Store timer handle, clearTimeout in destroy()
   - Effort: ~3 lines

### P1 -- Add Soon (coverage gaps)

4. **Add pre-auth message rejection test** (Adversary, Tester)
   - Send input before auth, verify silently dropped
   - Effort: ~15 lines

5. **Add permission deny test** (Adversary)
   - Test deny path; test multi-client permission race
   - Effort: ~30 lines

6. **Add protocol state machine tests** (Tester)
   - Input before auth, destroy while streaming, switch during stream
   - Effort: ~50 lines

7. **Replace sleep-based negative assertions** (Guardian, Builder)
   - Use sentinel-message pattern
   - Effort: ~20 lines refactor

### P2 -- Improve Later (quality)

8. **Add async stream simulation for delta buffering** (Skeptic, Tester)
   - Emit deltas across event loop ticks
   - Effort: ~30 lines

9. **Reduce mock duplication** (Minimalist, Skeptic)
   - Extract shared `_wireSessionEvents` / `_recordHistory` utilities
   - Effort: ~50 lines refactor

10. **Delete 3 redundant health endpoint tests** (Minimalist)
    - Already covered by ws-server.test.js
    - Effort: ~15 lines removed

---

## g. Final Verdict

**Aggregate Rating: 2.95 / 5** (weighted: core 1.0x, extended 0.8x)

| Agent | Weight | Rating | Weighted |
|-------|--------|--------|----------|
| Skeptic | 1.0 | 3.0 | 3.0 |
| Builder | 1.0 | 3.5 | 3.5 |
| Guardian | 1.0 | 3.0 | 3.0 |
| Minimalist | 1.0 | 2.5 | 2.5 |
| Tester | 0.8 | 3.2 | 2.56 |
| Adversary | 0.8 | 2.5 | 2.0 |
| **Total** | **5.6** | | **16.56** |
| **Average** | | | **2.96** |

This E2E test suite is an **adequate foundation that needs hardening**. It successfully validates the core happy paths of the WebSocket protocol through real server/client connections -- session CRUD, streaming, history replay, multi-client awareness, and primary tracking are genuinely valuable tests that the existing unit tests don't cover at this integration level. The harness is well-designed and extensible.

However, the suite has three categories of issues that need addressing before it becomes a reliable safety net: (1) **resource leaks** -- all 34 tests leak client sockets on failure, with multiple categories of dangling timers; (2) **coverage gaps** -- ~50% of protocol message types, the HTTP permission hook, delta buffering, and all security-critical paths (rate limiting, auth timeout, input validation) are untested; (3) **mock divergence** -- the MockSessionManager reimplements production logic that will silently drift.

The suite does not need fundamental rethinking. It needs the P0 fixes (client cleanup, input type guard, timer cancellation), followed by targeted test additions for the highest-risk gaps (pre-auth rejection, permission deny, state machine transitions). With those additions, it would be a solid regression safety net for the Chroxy WebSocket protocol.

---

## h. Appendix: Individual Reports

| File | Agent | Rating |
|------|-------|--------|
| [01-skeptic.md](./01-skeptic.md) | Skeptic | 3.0/5 |
| [02-builder.md](./02-builder.md) | Builder | 3.5/5 |
| [03-guardian.md](./03-guardian.md) | Guardian | 3.0/5 |
| [04-minimalist.md](./04-minimalist.md) | Minimalist | 2.5/5 |
| [05-tester.md](./05-tester.md) | Tester | 3.2/5 |
| [06-adversary.md](./06-adversary.md) | Adversary | 2.5/5 |
