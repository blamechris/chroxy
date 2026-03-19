# Futurist's Audit: Workspace Extraction (#2518, #2510)

**Agent**: Futurist -- Strategic architect who thinks in 5-year arcs
**Overall Rating**: 3.0/5
**Date**: 2026-03-19

## Methodology

Analyzed codebase evolution trajectory, projected future consumer growth, and evaluated extraction timing against architectural maturity signals. Looked at git history trends, feature roadmap, and platform divergence indicators.

## Finding 1: Divergence Trajectory -- Sawtooth Pattern

**Severity**: Medium (timing signal)

Git history reveals a sawtooth pattern in handler similarity:

```
Similarity
  90% |  *
  85% |   *  *
  80% |      * *
  75% |        * *     *
  70% |          * *  * *
  65% |            * *    *
  60% |                    *
      +---------------------> Time
       v0.1  v0.3  v0.5  v0.6
```

Pattern: Dashboard lags app by 2-4 weeks, then catches up in a burst (usually a dedicated "dashboard parity" sprint). Each catch-up cycle brings handlers closer, but the baseline similarity trends downward.

**6-month projection**: Shared handler logic drops to ~65%. App develops richer interaction patterns (gestures, haptics, offline-first). Dashboard develops richer visualization (multi-pane, keyboard shortcuts, dev tools integration).

**12-month projection**: Handlers become genuinely different applications that happen to speak the same protocol. The protocol layer (types, schemas, encryption) remains shared. The handler layer diverges.

**Implication**: Extracting handlers NOW captures peak similarity. But the extracted code will face increasing pressure to fork, leading to `if (platform === 'mobile')` branching inside the "shared" handlers -- which is worse than duplication.

## Finding 2: Future Consumer Analysis

**Severity**: Medium (justifies eventual extraction)

Within 12 months, 2-3 additional consumers of the WebSocket protocol are plausible:

| Consumer | Likelihood | Timeline | Handler needs |
|----------|-----------|----------|---------------|
| Mobile web client | High | 3-6 months | Similar to dashboard but with touch/mobile constraints |
| Browser extension | Medium | 6-12 months | Minimal handler (status monitoring, notifications) |
| CLI dashboard (terminal UI) | Low | 12+ months | Completely different rendering (blessed/ink) |

The mobile web client is the strongest argument for extraction -- it would be a third consumer with ~80% overlap with the dashboard handler. At that point, the abstraction pays for itself.

But that consumer doesn't exist yet. Extracting for a hypothetical third consumer is premature. Extract when the third consumer arrives and the pattern is concrete.

## Finding 3: The Right Time to Extract Is NOT Now

**Severity**: High (timing recommendation)

Several in-flight architectural changes make extraction premature:

1. **App sub-store decomposition**: The app is actively being refactored from a large `connection.ts` store into specialized sub-stores. This changes the state access patterns that any shared handler would need to target.

2. **Dashboard HANDLERS map**: The dashboard recently moved from switch-based to Map-based handler dispatch. This pattern is still stabilizing (new handlers being added, error boundaries being refined).

3. **Agent SDK migration**: The server is migrating from `cli-session.js` (legacy `claude -p`) to `sdk-session.js` (Agent SDK). This changes the message format and introduces new message types that both handlers need to support.

**Wait 4-6 weeks** for these changes to stabilize. Extracting now means extracting a moving target and re-extracting when the target settles.

## Finding 4: Dashboard Independence Has Concrete Near-Term Value

**Severity**: Medium (supports #2518)

Unlike handler extraction, dashboard workspace independence (#2518) has concrete, near-term benefits:

1. **Clean dependency graph**: `npm ls` for server shows only server dependencies. Easier to audit, easier to prune.
2. **Independent CI**: Dashboard tests can run in parallel with server tests. Currently they're part of the server test suite, which means dashboard test failures block server releases.
3. **Tauri simplification**: Desktop app can depend directly on `@chroxy/dashboard` package instead of reaching into `packages/server/dashboard/`. Cleaner bundling.
4. **Build caching**: Unchanged dashboard doesn't rebuild when server code changes (with proper workspace caching).

These benefits are available today, independent of handler extraction.

## Finding 5: Phased store-core Expansion

**Severity**: Informational (strategic plan)

The right architecture evolves store-core in phases aligned with actual needs:

### Phase 1: Types + Utilities (now, 1-2 days)
- `SessionState` base type with `createEmptySessionState()`
- Delta batching logic (message coalescing)
- Stream ID collision resolution
- Message queue logic

This is low-risk, high-value. Both consumers already need these. No DI, no factories, just shared pure functions.

### Phase 2: Stateless Handler Functions (4-6 weeks, 2-3 days)
After sub-store and HANDLERS map stabilize:
- Pure handler functions for ~15 stateless message types (error, ping, models_updated, etc.)
- These handlers have no side effects and no platform-specific behavior
- Import directly, no factory needed

### Phase 3: Handler Factory (3-6 months, 5-6 days)
When the third consumer arrives (mobile web):
- `createMessageHandler()` factory with platform DI
- Migrate remaining shared handlers
- Platform adapters for state, side effects, notifications

This phased approach:
- Delivers value at each step
- Validates assumptions before scaling
- Allows course correction if divergence accelerates
- Doesn't over-invest in abstraction before it's proven

## Recommendation

**Do #2518 soon** -- it has concrete near-term value and is prerequisite for everything else. The implementation is mechanical and low-risk.

**Expand store-core incrementally** -- Phase 1 (types + utilities) now, Phase 2 (stateless handlers) in 4-6 weeks. This captures the genuinely shared code without premature abstraction.

**Full handler extraction in 4-6 weeks** -- only after sub-store decomposition and HANDLERS map stabilize. The third consumer (mobile web) is the trigger for Phase 3.

**Do NOT attempt big-bang extraction** -- the codebase is actively evolving in ways that change the extraction target. Wait for stability, then extract what's settled.
