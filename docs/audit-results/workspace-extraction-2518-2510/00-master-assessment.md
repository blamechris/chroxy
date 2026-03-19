# Master Assessment: Workspace Extraction (#2518, #2510)

**Date**: 2026-03-19
**Aggregate Rating**: 2.9/5
**Agents**: 6 (Skeptic 3.5, Builder 3.0, Guardian 3.2, Minimalist 2.0, Futurist 3.0, Tester 2.5)

## Auditor Panel

| Agent | Perspective | Rating | Key Contribution |
|-------|------------|--------|-----------------|
| Skeptic | Claims vs reality | 3.5/5 | Verified duplication claims, found store-core already exists |
| Builder | Implementability | 3.0/5 | File-by-file change lists, effort estimates |
| Guardian | Safety/failure modes | 3.2/5 | Nonce state risk, encryption pipeline safety |
| Minimalist | YAGNI/complexity | 2.0/5 | 6% sync rate evidence, simpler alternatives |
| Futurist | Architecture evolution | 3.0/5 | Divergence trajectory, extraction timing signal |
| Tester | Testability/coverage | 2.5/5 | Coverage gaps (37.8% app, 15% dashboard), auth_ok untested |

## Consensus Findings (4+ agents agree)

### 1. Do #2518 (dashboard move) first (6/6 agree, except Minimalist says close it)

All agents agree #2518 should precede #2510. Even the Minimalist acknowledges the dependency ordering -- you can't cleanly extract shared code from a package nested inside another package. The Builder provides the detailed implementation plan: 174 files to move, 11 files to edit, critical path through `http-routes.js` and `bundle-server.sh`. The Futurist notes concrete near-term benefits: clean deps, independent CI, Tauri simplification. The Guardian confirms rollback is low-risk (purely mechanical file moves).

### 2. #2510 is significantly harder than described (6/6 agree)

Every agent found problems with #2510's scope and effort estimate:
- **Skeptic**: ~80% shared claim is closer to 70% structurally identical
- **Builder**: App sub-stores vs dashboard monolith is a fundamental architecture mismatch
- **Guardian**: Encryption nonce state extraction risks silent data corruption
- **Minimalist**: 6% sync rate contradicts "synchronized edits" claim
- **Futurist**: Sub-store decomposition and HANDLERS map are still in flux
- **Tester**: 37.8% app / 15% dashboard handler coverage is too thin for safe extraction

### 3. Incremental extraction, not big-bang (5/6 agree)

All except the Minimalist (who says "don't extract at all beyond 50 lines") recommend an incremental approach. The consensus path:
1. Start with types and utilities (`createEmptySessionState()`, stream ID collision logic)
2. Prove the pattern works in both consumers
3. Expand to stateless handlers
4. Full handler factory only after state architecture stabilizes

### 4. store-core already exists and the issue doesn't know it (4/6 mention)

Skeptic, Builder, Futurist, and Tester note that `@chroxy/store-core` already exists with types, crypto, utilities, and platform adapters. Issue #2510 proposes "creating `packages/store-core/`" which is misleading -- the real task is expanding the existing package. This changes the scope, effort, and risk profile.

## Contested Points

### Dashboard workspace value

- **Minimalist**: "Close #2518. Benefits are cosmetic. The 'pollution' is 2 runtime packages. Move them to devDeps instead."
- **Builder/Futurist/Guardian**: "Concrete value in clean deps, independent CI, Tauri simplification, build caching."

**Assessment**: The Builder and Futurist are right. The Minimalist's "move to devDeps" suggestion addresses the npm install concern but misses the CI isolation, Tauri build simplification, and build caching benefits. However, the Minimalist correctly notes the cost is non-trivial (174 files, 11+ edits, CI updates). The benefits justify the cost, but it's not free.

### Full handler extraction value

- **Minimalist**: "50-80 lines max. The 6% sync rate proves it's not worth it."
- **Futurist**: "Divergence accelerates. 2-3 future consumers justify extraction in 4-6 weeks."
- **Guardian**: "Converge handlers first, then extract. Don't extract divergent code."

**Assessment**: The Futurist's trajectory analysis is compelling -- similarity is trending down in a sawtooth pattern, and a third consumer (mobile web) would justify the abstraction. The Minimalist's sync rate is a trailing indicator that measures historical coupling, not future need. But the Guardian is right that convergence must precede extraction -- extracting divergent code creates a worse abstraction than the duplication it replaces. The answer is: converge first, extract later, and only when a concrete third consumer appears.

## Factual Corrections

1. **Issue #2510 says "Create `packages/store-core/`"** -- it already exists with types, crypto, utilities, and platform DI adapters
2. **"~80% shared"** -- closer to 70% structurally identical, 15% functionally same but architecturally different, 15% genuinely platform-specific (Skeptic)
3. **"Eliminates ~3,000 lines"** -- realistic deduplication is ~2,000-2,500 lines after adapter layer overhead (Skeptic)
4. **"Dashboard has zero test coverage"** -- FALSE, it has 88 test files / ~13,869 test lines. Handler-specific coverage is ~15%, but total test coverage is substantial (Tester)
5. **"Every protocol change requires synchronized edits"** -- 6% sync rate (6 of 97 commits) says otherwise. 94% of handler changes are platform-specific (Minimalist)

## Risk Heatmap

```
Impact -->   Low       Medium      High        Critical
Likelihood
  High    |          | CI cache   | State      |            |
          |          | invalidate | shape      |            |
          |          |            | mismatch   |            |
  Medium  |          | Tauri      | Test       | Nonce      |
          |          | bundle     | regression | desyncs    |
          |          | paths      |            |            |
  Low     |          |            | Config     | Rollback   |
          |          |            | injection  | #2510      |
          |          |            | drift      |            |
```

**Top risks:**
- **State shape mismatch** (High likelihood, High impact): App sub-stores vs dashboard monolith makes shared state access fundamentally different. No adapter can paper over this cheaply.
- **Nonce desyncs** (Medium likelihood, Critical impact): Mutable encryption state could desync during extraction, causing silent message loss.
- **Test regression** (Medium likelihood, High impact): 62-85% of handler code has no tests. Bugs introduced during extraction won't be caught.
- **Rollback #2510** (Low likelihood, Critical impact): If handler extraction goes wrong, reverting touches every file in 3 packages.

## Recommended Action Plan

### Phase 0: Pre-work (1-2 days)

1. **Add store-core tests to CI** (Tester finding) -- store-core tests exist but don't run in CI. Without this, any extraction provides false confidence.
2. **Write `auth_ok` handler tests** for both app and dashboard (Tester finding) -- the most complex handler (~120 lines) has zero tests. Most critical path for extraction safety.
3. **Add handler coverage contract test** to `@chroxy/protocol` (Tester finding) -- verifies both consumers handle the same `ServerMessageType` values. Catches drift when new types are added.

### Phase 1: #2518 Dashboard workspace move (2-3 days)

1. Create `packages/dashboard/` with its own `package.json`
2. Move 174 files from `packages/server/dashboard/` to `packages/dashboard/`
3. Update `http-routes.js` dist path resolution (make configurable, add startup assertion per Guardian)
4. Update `bundle-server.sh` source paths for Tauri desktop build
5. Update Tauri config references
6. Update CI workflows (add dashboard build/test job)
7. Update `bump-version.sh` to include new package
8. Remove dashboard-only dependencies from server's `package.json`

### Phase 2: Incremental store-core expansion (3-4 days)

1. **Shared `SessionState` base type** + `createEmptySessionState()` -- both consumers need identical initialization
2. **Delta batching logic** -- message coalescing is identical in both
3. **Message queue logic** -- same queuing pattern in both
4. **Pure handler functions** for ~15 stateless message types (error, ping, models_updated, etc.) -- no side effects, no platform differences
5. **Stream ID collision resolution utility** -- the `_deltaIdRemaps` pattern that has caused bugs when implementations diverged

### Phase 3: Full handler extraction (5-6 days, 4-6 weeks after Phase 2)

**Wait for:**
- App sub-store decomposition to stabilize (currently in flux)
- Dashboard HANDLERS map refactoring to complete (recently changed)
- Phase 2 patterns to prove out in production usage
- Ideally, a concrete third consumer (mobile web) to validate the abstraction

**Then:**
1. `createMessageHandler()` factory with platform dependency injection
2. Migrate remaining shared handlers (~30 types)
3. Create platform adapters for state access, notifications, storage
4. Adapt existing tests to use DI interface instead of platform mocks
5. Add behavioral snapshot tests for regression detection

## Final Verdict

**Aggregate Rating: 2.9/5** (weighted: core agents 1.0x, extended agents 0.8x)

Both issues identify genuine architectural problems -- dashboard coupling and handler duplication are real. But the proposals need significant refinement before implementation.

**Issue #2518** (dashboard workspace) is worth doing NOW. It's mechanical, low-risk, and prerequisite for everything else. The Minimalist's objection (cosmetic benefits) is outweighed by concrete CI, Tauri, and build caching improvements. Estimated effort: 2-3 days including CI updates.

**Issue #2510** (message handler extraction) is the RIGHT goal but the WRONG approach at the WRONG time. The handlers have diverged more than the issue acknowledges:
- Different state architectures (10 sub-stores vs monolith)
- 6% sync rate (94% of changes are platform-specific)
- 37 app-only message types, 8 dashboard-only
- Test coverage too thin (37.8% app, 15% dashboard handler coverage)
- Zero `auth_ok` tests (the most complex handler)
- Encryption nonce state risks silent data corruption during extraction

The recommended path: move dashboard first (#2518), expand store-core incrementally with types and utilities (Phase 2), then extract handlers in 4-6 weeks after convergence work and test hardening. The Minimalist's 50-line alternative is too conservative, but the issue's full-extraction proposal is too aggressive. The phased approach threads the needle.

## Appendix

| File | Agent | Rating |
|------|-------|--------|
| [01-skeptic.md](01-skeptic.md) | Skeptic | 3.5/5 |
| [02-builder.md](02-builder.md) | Builder | 3.0/5 |
| [03-guardian.md](03-guardian.md) | Guardian | 3.2/5 |
| [04-minimalist.md](04-minimalist.md) | Minimalist | 2.0/5 |
| [05-futurist.md](05-futurist.md) | Futurist | 3.0/5 |
| [06-tester.md](06-tester.md) | Tester | 2.5/5 |
