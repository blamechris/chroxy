# Master Assessment: Chroxy System Audit

**Date**: 2026-02-10
**Target**: Full Chroxy codebase (packages/server + packages/app)
**Codebase size**: ~22,700 lines (7,462 server, 7,835 app, 7,404 tests)
**Agents**: 6 (Skeptic, Builder, Guardian, Minimalist, Tester, Adversary)

---

## a. Auditor Panel

| # | Agent | Perspective | Rating | Key Contribution |
|---|-------|-------------|--------|-----------------|
| 1 | Skeptic | Claims vs reality, false assumptions | 3.5/5 | Found session-manager.test.js P1 class bug, tunnel URL change invisible to clients |
| 2 | Builder | Implementability, effort, dependencies | 3.8/5 | Identified connection.ts monolith, unpinned SDK, engine field mismatch |
| 3 | Guardian | Safety, failure modes, race conditions | 3.3/5 | settings.json as single point of failure, stale hooks = 5min hang, no atomic writes |
| 4 | Minimalist | YAGNI, complexity reduction, 80/20 cuts | 3.0/5 | PTY mode is ~5,600 lines of dead weight, deploy rollback is phantom infrastructure |
| 5 | Tester | Testability, coverage gaps, test strategy | 3.0/5 | supervisor.js untested, zero app component tests, timer-based assertions fragile |
| 6 | Adversary | Attack surface, abuse cases, security | 2.5/5 | Permission bypass via auto mode, shell injection in tunnel setup, no auth rate limiting |

---

## b. Consensus Findings (4+ agents agree)

### CF-1: session-manager.test.js writes to real `~/.chroxy/session-state.json` (6/6 agents)

**All six agents** independently identified this as the same P1 class bug that caused the settings.json contamination incident.

- **Skeptic**: "exact same class of bug as #429"
- **Guardian**: "hardcoded `homedir()` path -- no test isolation possible"
- **Tester**: "if test crashes, stale file causes phantom session restoration"
- **Adversary**: corroborated via filesystem safety analysis

**Evidence**: `session-manager.test.js:9` -- `const STATE_FILE = join(homedir(), '.chroxy', 'session-state.json')`

**Recommended action**: Immediate fix -- make `session-manager.js` accept configurable `stateFilePath` parameter (same pattern planned for #429).

### CF-2: PTY/tmux mode is legacy dead weight (5/6 agents)

**Skeptic, Builder, Guardian, Minimalist, Tester** all identified that PTY mode is the legacy prototype superseded by structured JSON.

- **Minimalist**: "~5,600 lines of dead weight" (~31% of codebase with tests)
- **Builder**: "output parser is 518 lines of stateful regex matching"
- **Skeptic**: "`_useLegacyCli` flag is a time bomb -- two distinct code paths"
- **Tester**: "output-parser.test.js has 1,980 lines testing behavior that structured JSON gives for free"

**Recommended action**: Schedule cleanup milestone to remove PTY mode. Closes issues #5, #9, eliminates ~5,600 lines.

### CF-3: `connection.ts` is a monolith (5/6 agents)

**Skeptic, Builder, Guardian, Minimalist, Tester** flagged the 1,921-line Zustand store.

- **Skeptic**: "750-line handleMessage with 11 mutable state variables"
- **Builder**: "will be bottleneck for any feature touching client state"
- **Minimalist**: "dual state (flat + per-session) driven by PTY backward compatibility"

**Recommended action**: After PTY removal, eliminate legacy flat state path. Then extract handleMessage into a message router module.

### CF-4: supervisor.js has zero tests (4/6 agents)

**Builder, Guardian, Tester, Minimalist** noted the 447-line production-critical process manager has no test coverage.

- **Tester**: "most operationally critical component in named tunnel mode"
- **Minimalist**: "deploy rollback is ~100 lines of untested phantom infrastructure"

**Recommended action**: Create `supervisor.test.js` with mock child process. Strip unused deploy rollback code.

### CF-5: No auth rate limiting (4/6 agents)

**Skeptic, Guardian, Adversary, Tester** identified the absence of auth attempt throttling.

- **Adversary**: "unlimited WebSocket connections, unlimited token guesses"
- **Guardian**: "no per-client message rate limit, no backpressure mechanism"

**Recommended action**: Add per-IP rate limiting for auth failures (max 5/min with exponential backoff).

---

## c. Contested Points

### Permission mode bypass: Security risk vs intended feature?

- **Adversary** (2/5): "highest-severity finding -- any client can disable all permission gates"
- **Builder** (4/5): "this is by design -- the mobile client needs to control permission modes"
- **Guardian** (3/5): "need confirmation handshake before enabling auto mode"

**Assessment**: The Adversary is right that this needs guardrails. The Builder is right that it's an intended feature. The Guardian's middle ground is correct: add a confirmation step for `auto` mode specifically, since it maps to `allowDangerouslySkipPermissions`. The other modes (default, acceptEdits, plan) are safe to switch without confirmation.

### Should PTY mode be deleted NOW or deprecated gradually?

- **Minimalist** (2/5): "delete entirely now -- 5,600 lines of dead weight"
- **Builder** (4/5): "it works, users may depend on terminal view, deprecate gradually"
- **Skeptic** (4/5): "the dual-mode architecture is cleanly separated, it's not actively harmful"

**Assessment**: The Minimalist makes the strongest case by the numbers, but the Builder's caution is warranted. The terminal view (even in plain text) provides value for users who want raw output. Deprecate with a timeline: announce PTY deprecation, give 2 releases notice, then remove.

### Token timing attack: Real risk or theoretical?

- **Adversary** (2/5): "`===` is not constant-time, timing side-channel possible"
- **Builder** (4/5): "122 bits of entropy makes brute force infeasible regardless of timing"

**Assessment**: The Builder is right -- with 122-bit tokens, timing attacks are impractical. However, the fix is trivial (`crypto.timingSafeEqual`) and follows security best practices. Fix opportunistically.

---

## d. Factual Corrections

| Claim | Source | Correction | Found By |
|-------|--------|------------|----------|
| Engine field `>=18` | package.json | Should be `>=22` -- node-pty requires Node 22 | Builder |
| `allowAlways` persists decisions | Implied by UI | `allowAlways` is silently treated as `allow` -- not persisted | Guardian |
| Deploy rollback is functional | supervisor.js code | `KNOWN_GOOD_FILE` is never written by any code in the repo | Minimalist |
| `uuid` package needed | package.json | `crypto.randomUUID()` available since Node 16, could drop dep | Builder |

---

## e. Risk Heatmap

```
                    IMPACT
            Low     Medium    High     Critical
         +--------+--------+--------+--------+
  High   |        | Timer  |   No   | Perm   |
         |        | flakes | rate   | bypass |
         |        |  (CI)  | limit  |  auto  |
L        +--------+--------+--------+--------+
I  Med   | ANSI   | Deploy | Super- | State  |
K        | regex  | roll-  | visor  | file   |
E        | 4x dup | back   | 0 test | writes |
L        +--------+--------+--------+--------+
I  Low   | uuid   | No app | Shell  | Stale  |
H        | dep    | render | inject | hooks  |
O        |        | tests  | in CLI | 5m hang|
O        +--------+--------+--------+--------+
D
```

---

## f. Recommended Action Plan

### Priority 1: Safety (immediate)

| # | Action | Effort | Impact | Agents |
|---|--------|--------|--------|--------|
| 1 | Fix session-manager.test.js to use configurable state file path | 2h | Prevents P1 class incident | All 6 |
| 2 | Fix #429: configurable settingsPath in permission-hook.js | 4h | Enables test coverage, prevents contamination | Guardian, Tester, Skeptic |
| 3 | Replace `execSync` with `execFileSync` in cli.js tunnel setup | 1h | Eliminates shell injection | Adversary |
| 4 | Set `chmod 0600` on config.json after write | 30m | Protects API token | Adversary |

### Priority 2: Reliability (this sprint)

| # | Action | Effort | Impact | Agents |
|---|--------|--------|--------|--------|
| 5 | Add auth rate limiting (5 failures/min/IP) | 4h | Prevents brute force | Adversary, Guardian |
| 6 | Add confirmation for `set_permission_mode auto` | 2h | Defense in depth for permission bypass | Adversary, Guardian |
| 7 | Create supervisor.test.js with mock child process | 6h | Cover critical untested infrastructure | Tester, Builder |
| 8 | Fix engine field to `>=22` in package.json | 5m | Prevent confusing install failures | Builder |
| 9 | Strip deploy rollback code from supervisor.js | 1h | Remove untested phantom infrastructure | Minimalist |

### Priority 3: Simplification (next milestone)

| # | Action | Effort | Impact | Agents |
|---|--------|--------|--------|--------|
| 10 | Deprecate PTY mode (announce timeline) | 1h | Signal to users, begin removal process | Minimalist, Tester |
| 11 | Remove PTY mode | 8h | -5,600 lines, close #5 + #9, simplify ws-server | Minimalist |
| 12 | Simplify connection.ts (remove legacy flat state) | 6h | -200-300 lines, eliminate dual-sync bugs | Skeptic, Builder, Minimalist |
| 13 | Extract `_killAndRespawn()` in cli-session.js | 1h | Dedup setModel/setPermissionMode | Minimalist |
| 14 | Pin `@anthropic-ai/claude-agent-sdk` to exact version | 5m | Prevent surprise SDK breakage | Builder |

### Priority 4: Quality (ongoing)

| # | Action | Effort | Impact | Agents |
|---|--------|--------|--------|--------|
| 15 | Add ESLint + Prettier with CI check | 2h | Enforce code style | Builder |
| 16 | Add test coverage reporting to CI | 2h | Visibility into gaps | Tester |
| 17 | Add app component render tests (ChatView, ConnectScreen, InputBar) | 8h | Cover 6,793 LOC of untested UI | Tester |
| 18 | Use fake timers in output-parser tests | 2h | Eliminate CI flake risk | Tester |
| 19 | Remove `/version` endpoint or add auth | 30m | Fix info disclosure | Adversary |

---

## g. Final Verdict

**Aggregate Rating: 3.2 / 5** (weighted: core panel 1.0x, extended 0.8x)

| Agent | Rating | Weight | Weighted |
|-------|--------|--------|----------|
| Skeptic | 3.5 | 1.0 | 3.5 |
| Builder | 3.8 | 1.0 | 3.8 |
| Guardian | 3.3 | 1.0 | 3.3 |
| Minimalist | 3.0 | 1.0 | 3.0 |
| Tester | 3.0 | 0.8 | 2.4 |
| Adversary | 2.5 | 0.8 | 2.0 |
| **Total** | | **5.6** | **18.0** |
| **Average** | | | **3.2** |

The Chroxy codebase is **adequate for a v0.1.0 with known gaps that need addressing before public release**. The architecture is sound, the module boundaries are clean, and the EventEmitter-based session abstraction works well. The immediate priorities are safety fixes (test contamination, shell injection, file permissions) and the configurable settings path (#429). The medium-term win is removing PTY mode, which eliminates ~31% of the codebase complexity. The security posture is the weakest area -- permission bypass via auto mode and lack of auth rate limiting need hardening before this system should be exposed to untrusted networks. The project is in a good position to reach production quality with focused effort on the P1/P2 action items above.

---

## h. Appendix: Individual Reports

| # | Report | Agent | Rating |
|---|--------|-------|--------|
| 1 | [01-skeptic.md](./01-skeptic.md) | Skeptic | 3.5/5 |
| 2 | [02-builder.md](./02-builder.md) | Builder | 3.8/5 |
| 3 | [03-guardian.md](./03-guardian.md) | Guardian | 3.3/5 |
| 4 | [04-minimalist.md](./04-minimalist.md) | Minimalist | 3.0/5 |
| 5 | [05-tester.md](./05-tester.md) | Tester | 3.0/5 |
| 6 | [06-adversary.md](./06-adversary.md) | Adversary | 2.5/5 |
