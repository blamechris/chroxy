# Master Assessment: Chroxy v0.6.0 Tech Debt Audit

**Date**: 2026-03-18
**Agents**: 6-agent swarm audit
**Aggregate Rating**: 2.7/5

---

## Auditor Panel

| # | Agent | Perspective | Rating |
|---|-------|-------------|--------|
| 1 | Skeptic | Dead code, stale abstractions, documentation drift | 2.3/5 |
| 2 | Builder | Developer experience, architecture friction | 2.9/5 |
| 3 | Guardian | Safety, security, crash recovery | 3.1/5 |
| 4 | Minimalist | Unnecessary complexity, deletable code | 2.4/5 |
| 5 | Futurist | Debt trajectory, scaling, migration readiness | 3.0/5 |
| 6 | Tester | Coverage, test quality, confidence | 3.0/5 |

---

## Consensus Findings

Issues where 4 or more agents independently identified the same concern.

### 1. Message Handler Duplication (6/6 agents agree)

**The single most important finding.** Every agent flagged the forked message handler as the top tech debt item.

- `packages/app/src/store/message-handler.ts` — 2,271 lines
- `packages/server/src/dashboard-next/src/store/message-handler.ts` — 2,209 lines
- ~80% shared logic, ~20% platform-specific
- Diverging with every release (Futurist projects <50% shared by v0.8.0)
- Every protocol change requires synchronized edits in both files
- No shared source of truth for session state shape

**Recommended action**: Extract `@chroxy/store-core` workspace package with shared message handler, session state types, and connection state management.

### 2. EnvironmentManager Needs Concurrency Guards (4/6: Guardian, Builder, Futurist, Tester)

`environment-manager.js` has zero concurrency protection. Concurrent WebSocket clients can trigger parallel Docker operations on the same environment, causing:
- Port allocation conflicts
- Orphaned containers
- Corrupted environment state
- Non-atomic restore operations

**Recommended action**: Add per-environment mutex (Promise-based queue). Serialize operations on the same environment ID.

### 3. Dead Backward-Compat Shims (4/6: Skeptic, Minimalist, Builder, Futurist)

Three files exist solely as re-export shims with zero consumers:
- `tunnel.js` (5 lines) — re-exports `cloudflare-tunnel.js`
- `ws-file-ops.js` (2 lines) — re-exports split file modules
- Dead re-exports in `ws-message-handlers.js`

Plus `ws-schemas.js` (105 lines) used only in tests and not covering outbound messages.

**Recommended action**: Delete shims, update any remaining imports, inline schema tests.

### 4. Dashboard Should Be Its Own Package (4/6: Builder, Minimalist, Futurist, Tester)

`packages/server/src/dashboard-next/` is a full React+TypeScript+Vite application living inside the server package. It has:
- Its own tsconfig.json, Vite config, component tree, store, types
- Different language (TypeScript vs server's JavaScript)
- Different build toolchain (Vite vs server's plain Node)
- Zero test coverage (partially because it is not a first-class workspace member)

**Recommended action**: Move to `packages/dashboard/` as an npm workspace package. Server serves the built output.

---

## Contested Points

Areas where agents disagreed or assigned significantly different severity.

### Provider registry complexity
- **Minimalist** (2.5/5): Over-abstracted — 4 static providers don't need a registry pattern.
- **Builder** (pass): Did not flag; the registry works and is not a friction point.
- **Verdict**: Low priority. The registry is unnecessary abstraction but not causing bugs.

### ws-schemas.js value
- **Skeptic**: Dead weight, only used in tests.
- **Tester**: The schemas have value as a protocol contract, just need to be expanded.
- **Verdict**: Schemas should evolve into a `@chroxy/protocol` package rather than being deleted.

### TypeScript migration urgency
- **Futurist** (3.5/5): Migration surface is tractable, good foundation.
- **Skeptic** (not flagged): Not tech debt per se, just a missing capability.
- **Verdict**: Not urgent. Focus on package extraction first; TS migration is easier after boundaries are clean.

### Supervisor IPC error handling
- **Guardian** (flagged): Unhandled IPC sends can crash the supervisor.
- **Builder** (not flagged): Supervisor has been stable in production.
- **Verdict**: Low probability but high impact. Worth a try/catch wrap (trivial fix).

---

## Factual Corrections

Issues that are objectively wrong in the current codebase, not matters of opinion.

### 1. Crypto algorithm documentation is wrong
`docs/architecture/reference.md` states E2E encryption uses **AES-256-GCM**. The actual implementation in `packages/server/src/crypto.js` uses `tweetnacl`'s `secretbox`, which is **XSalsa20-Poly1305**. This is not a minor naming difference — they are fundamentally different algorithms (symmetric block cipher vs stream cipher, different nonce sizes, different authentication mechanisms).

### 2. Phantom files in reference.md
The architecture reference lists files removed in v0.2.0:
- `packages/server/src/pty-session.js` (removed)
- `packages/server/src/tmux-manager.js` (removed)
- `packages/server/src/terminal-output.js` (consolidated)

### 3. Stale environment variables
`config.js` documents env vars that are no longer read:
- `CHROXY_TRANSFORMS`
- `CHROXY_SANDBOX`
- `CHROXY_PTY_SHELL`

---

## Risk Heatmap

```
                  LIKELIHOOD
                  Low    Med    High
              +--------+--------+--------+
  Critical    |        | EnvMgr |        |
              |        | Races  |        |
              +--------+--------+--------+
  High    S   | Mount  | Auth   | MsgHdlr|
  E       E   | Valid  | Map    | Diverge|
  V       V   +--------+--------+--------+
  E       E   | Superv | Docker | Console|
  R       R   | IPC    | Leaks  | Logs   |
  I       I   +--------+--------+--------+
  T       T   | State  | Test   | Dead   |
  Y       Y   | Atomic | Gaps   | Shims  |
              +--------+--------+--------+
              Low      Med      High
```

**Legend**:
- **EnvMgr Races**: Concurrent Docker operations produce incorrect results
- **MsgHdlr Diverge**: Forked handler divergence increases bug surface with each feature
- **Auth Map**: Unbounded _authFailures Map (memory exhaustion)
- **Mount Valid**: DevContainer mounts not validated against home directory
- **Console Logs**: 312 raw console calls bypass structured logging
- **Docker Leaks**: Containers survive crashes without reconciliation
- **Dead Shims**: Backward-compat files with zero consumers
- **Test Gaps**: ~30% critical server files untested, all screens untested

---

## Recommended Action Plan

Prioritized by consensus strength, impact, and effort.

### Phase 1: Critical (1-2 weeks)

| # | Issue | Consensus | Effort | Impact |
|---|-------|-----------|--------|--------|
| 1 | Extract shared message handler into @chroxy/store-core | 6/6 | Large | Eliminates ~3,000 lines duplication |
| 2 | Add concurrency guards to EnvironmentManager | 4/6 | Small | Prevents data corruption |
| 3 | Validate DevContainer mounts against home dir | 4/6 | Small | Security hardening |
| 4 | Cap _authFailures Map size | 3/6 | Trivial | Prevents memory exhaustion |

### Phase 2: High Priority (2-4 weeks)

| # | Issue | Consensus | Effort | Impact |
|---|-------|-----------|--------|--------|
| 5 | Delete dead backward-compat shims | 4/6 | Trivial | Cleaner codebase |
| 6 | Fix crypto algorithm documentation | 2/6 | Trivial | Factual correctness |
| 7 | Consolidate server crypto.js into store-core | 2/6 | Small | Eliminate duplicate crypto |
| 8 | Replace raw console calls with createLogger | 3/6 | Medium | Consistent logging |
| 9 | Add test coverage measurement (c8 + jest) | 2/6 | Small | Enable coverage tracking |

### Phase 3: Medium Priority (backlog)

| # | Issue | Consensus | Effort | Impact |
|---|-------|-----------|--------|--------|
| 10 | Move dashboard to own workspace package | 4/6 | Medium | Clean package boundaries |
| 11 | Add EnvironmentManager error recovery for restore | 2/6 | Medium | Prevent data loss on failed restore |
| 12 | Test handler-utils.js security-critical functions | 2/6 | Small | Security coverage |

---

## Final Verdict

### Weighted Aggregate Rating

**Core auditors** (1.0x weight) — structural concerns, direct code quality:
- Skeptic: 2.3
- Builder: 2.9
- Guardian: 3.1
- Minimalist: 2.4
- Core average: **2.675**

**Extended auditors** (0.8x weight) — forward-looking, test infrastructure:
- Futurist: 3.0
- Tester: 3.0
- Extended average: **3.0** (weighted: 2.4)

**Weighted aggregate**: (2.3 + 2.9 + 3.1 + 2.4 + 3.0*0.8 + 3.0*0.8) / (4 + 2*0.8) = **2.7/5**

### Interpretation

A rating of **2.7/5** indicates significant tech debt that is actively impeding development velocity. The codebase is functional and stable in production, but the cost of each new feature is higher than it should be due to:

1. **Duplication tax**: Every protocol change requires parallel implementation
2. **Boundary violations**: God classes resist decomposition and parallel development
3. **Safety gaps**: EnvironmentManager concurrency and security validation
4. **Confidence deficit**: Missing test coverage makes refactoring risky

The good news: the debt is concentrated. Addressing items 1-4 in the action plan would meaningfully improve the rating. The message handler extraction alone would eliminate the most expensive recurring cost.

### Comparison with Previous Audit

The previous audit (tech-debt-solid-dry-coverage, 2026-03-13) scored **3.1/5 aggregate**. The drop to 2.7/5 reflects:
- New EnvironmentManager code (v0.5.0-v0.6.0) added without concurrency guards
- Message handler divergence worsening with each release
- Dashboard remaining inside server package despite being flagged previously

---

## Appendix: Individual Reports

| Report | File |
|--------|------|
| Skeptic | [01-skeptic.md](01-skeptic.md) |
| Builder | [02-builder.md](02-builder.md) |
| Guardian | [03-guardian.md](03-guardian.md) |
| Minimalist | [04-minimalist.md](04-minimalist.md) |
| Futurist | [05-futurist.md](05-futurist.md) |
| Tester | [06-tester.md](06-tester.md) |
