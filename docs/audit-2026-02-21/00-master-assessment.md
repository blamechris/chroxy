# Master Assessment: Chroxy Project Status Audit (Feb 21, 2026)

**Audit Target**: Chroxy project health vs competitive audit action plan + overall codebase state
**Agent Count**: 8
**Date**: 2026-02-21
**Aggregate Rating**: 3.3 / 5 (weighted)

---

## a. Auditor Panel

| # | Agent | Perspective | Rating | Key Contribution |
|---|-------|------------|--------|-----------------|
| 1 | Skeptic | Claims vs reality | 4.0 | Verified 12/15 action items done in 3 days; found 5 stale issues, acceptEdits skipped entirely |
| 2 | Builder | Implementability | 3.8 | Mapped effort for all remaining items; found 3 in-app-dev items marked "not started" are actually done |
| 3 | Guardian | Security/reliability | 3.5 | Confirmed all 3 Feb 19 security fixes; found GetDiffSchema bug, hostname leak, nonce desync on send failure |
| 4 | Minimalist | Complexity reduction | 2.5 | Identified 4,500+ LOC of dead PTY mode code, 21 YAGNI issues, two conflicting roadmaps |
| 5 | Operator | User experience | 3.0 | Found auto-connect IS implemented (corrects prior claims); identified disconnect-clears-savedConnection as worst UX bug |
| 6 | Futurist | Long-term viability | 3.4 | Narrow SDK coupling is a strength; two monolith files (ws-server.js + connection.ts) approaching breaking point |
| 7 | Tester | Test coverage | 3.5 | 1,284 tests total; mock sendMessage is no-op (never verifies input reaches session); zero app component tests |
| 8 | Adversary | Attack surface | 3.2 | [HIGH] create_session accepts arbitrary CWD, bypassing file browser restrictions; auth token visible pre-encryption |

---

## b. Consensus Findings (5+ agents agree)

### 1. The competitive audit action plan is mostly done (8/8 agents agree)

Phases 1-3 (Immediate + 30-Day + 60-Day): **12/15 items completed in 3 days**. Only `acceptEdits` permission mode (30-Day) was skipped. Phase 4 (90-Day) has 0/5 done, which is expected at day 3.

**Evidence**: Skeptic verified each item against code with file:line references. Builder independently confirmed. All security fixes verified by Guardian. Zod validation, EventNormalizer, Maestro E2E, encryption threat model all confirmed shipped.

**Action**: Declare phases 1-3 effectively complete. Track the 2 remaining items (acceptEdits, privacy narrative) as standalone issues.

### 2. Close the stale issues (7/8 agents flagged)

5 open issues have been resolved by merged PRs but never closed: #607, #662, #663, #665, #713. The Minimalist additionally identified 21 issues as YAGNI that should be closed or deprioritized.

**Action**: Close #607, #662, #663, #665, #713 immediately. Triage the rest.

### 3. The two-roadmap problem needs resolution (6/8 agents agree)

The competitive audit plan and in-app-dev phases overlap, sometimes conflict, and neither references the other. The Builder found 3 in-app-dev items marked "not started" that are actually done (session serialization, IPC drain, rollback). Nobody is tracking the real state.

**Consensus recommendation**: The competitive audit should be the primary roadmap. In-app-dev items slot in as backlog. Merge into a single tracking document.

### 4. ws-server.js is the #1 architectural problem (5/8 agents agree)

At 2,691 lines with three parallel message-handling switch statements, the file is a god object that makes every change harder. The Futurist calls it "approaching breaking point." The Minimalist notes the EventNormalizer didn't reduce it — it added a layer on top. The Builder estimates splitting it would save 30% time on every subsequent feature.

**Action**: Extract file operations, auth/encryption, and session routing into separate handler modules before adding new features.

### 5. `acceptEdits` permission mode is the highest-impact UX gap (5/8 agents agree)

The Operator, Skeptic, Builder, Futurist, and Minimalist (indirectly) all identify the binary choice between "approve everything individually" and "bypass all" as the top daily friction. The Operator estimates 80% of permission prompts are file operations that are almost always approved.

**Action**: Implement `acceptEdits` mode — auto-approve file read/write/edit, prompt for bash and external tools. Estimated effort: 4-6 hours.

---

## c. Contested Points

### PTY mode: Delete it vs Keep it

**DELETE** (Minimalist, Builder): 4,500+ lines of code and tests for a deprecated fallback. CLI headless mode replaced it. The node-pty dependency requires Node 22. Every new feature needs three code paths. Zero users on PTY mode.

**KEEP** (Guardian, Futurist — implicitly): It provides fallback if the SDK/CLI breaks. Terminal emulation is a differentiator mentioned in the Futurist's Anthropic risk analysis.

**Assessment**: The Minimalist is right about the maintenance burden but wrong about the risk. **Deprecate but don't delete yet.** Stop adding PTY mode support to new features. Add a deprecation warning on `--terminal`. Delete in v0.2.0 once CLI mode has proven stable over months.

### Issue backlog: Close 21 as YAGNI vs Keep open

**CLOSE** (Minimalist): 21 of 29 open issues solve problems a single user doesn't have. Enterprise self-hosting guide, biometric app lock, WebSocket compression — all YAGNI. Having 29 open issues creates phantom work.

**KEEP** (Builder, Futurist — partially): Some "YAGNI" items become relevant if the project grows. Issues are cheap to maintain. Closing creates information loss.

**Assessment**: Compromise. **Label the 21 issues as `backlog-deferred`** instead of closing them. They stay searchable but don't clutter the active issue list. Reduces visible backlog from 29 to ~8.

### Zod schemas: Over-engineering vs Defense-in-depth

**OVER-ENGINEERED** (Minimalist): 1,323 LOC (schemas + tests) for validating messages you send to yourself. TypeScript and tests already catch type errors.

**WORTHWHILE** (Guardian, Adversary, Tester): Schema validation catches malformed messages at the boundary, prevents prototype pollution from `.passthrough()`, and provides self-documenting protocol specs.

**Assessment**: The Guardian and Adversary are right. **Keep the schemas.** They provide defense-in-depth at a reasonable cost and serve as living protocol documentation. But the Minimalist has a point about test scope — the 957-line schema test file mostly tests that Zod works, not that the app works. Consider reducing schema tests to boundary/edge cases only.

---

## d. Factual Corrections

| Claim | Correction | Found By |
|-------|-----------|----------|
| "Auto-connect NOT DONE" (competitive audit tracker) | Auto-connect IS implemented in ConnectScreen.tsx:79-98 | Operator |
| "In-app-dev Phase 1.2 (session serialization): Not started" | `serializeState()`/`restoreState()` exist at session-manager.js:443-528 | Builder |
| "In-app-dev Phase 1.3 (IPC drain): Not started" | Implemented at server-cli-child.js:85-119 | Builder |
| "In-app-dev Phase 2.6 (rollback): Not started" | `_rollbackToKnownGood()` exists at supervisor.js:456-493 | Builder |
| MEMORY.md claims "all 4 permission modes" | Only 3 exist in code: approve, auto, plan (ws-server.js:138-142) | Skeptic |
| GetDiffSchema allows `base` parameter | Zod strips `base` field (no `.passthrough()`), always defaults to HEAD | Guardian |

---

## e. Risk Heatmap

```
                    IMPACT
           Low      Medium     High
        +---------+---------+---------+
  High  |         | Stale   | Two     |
  L     |         | issues  | roadmaps|
  I     |         | confuse | = no    |
  K     |         | work    | roadmap |
  E     +---------+---------+---------+
  L     | Health  | ws-server| create_ |
  I     | endpoint| god     | session |
  H     | hostname| object  | arb CWD |
  O     |         |         |         |
  O     +---------+---------+---------+
  D     | Nonce   | No app  | Auth    |
        | overflow| component| token  |
        |         | tests   | pre-E2E |
        +---------+---------+---------+
```

---

## f. Recommended Action Plan

### This Week (hours, not days)

1. **Close 5 stale issues** (#607, #662, #663, #665, #713) — 10 min
2. **Fix MEMORY.md "4 permission modes" error** — 5 min
3. **Label 18-21 low-priority issues as `backlog-deferred`** — 15 min
4. **Update in-app-dev doc** marking 3 items as actually done — 15 min
5. **Restrict `create_session` CWD** to project directory or home directory subtree — 2h (Adversary F2, HIGH severity)

### Next 2 Weeks

6. **Implement `acceptEdits` permission mode** — 4-6h (highest-impact UX improvement)
7. **Remove hostname from health endpoint** — 30 min (Guardian finding)
8. **Fix binary file detection in untracked previews** (#716) — 1h
9. **Dynamic model list** (#686) — 4h (query SDK or accept arbitrary IDs)
10. **Fix 12 locally-failing tests** (git PATH issue in test setup) — 2-3h

### Next 30 Days

11. **Split ws-server.js** into handler modules (auth, files, sessions) — 2-3 days
12. **Client-side state persistence** (AsyncStorage) (#685) — 2-3 days
13. **Merge roadmaps** into single tracking document — 1h
14. **Add test spies** to mock session (verify sendMessage/setModel called) — 2h
15. **Deprecate PTY mode** (add warning, stop adding PTY support to new features)

### 60+ Days

16. Image-bearing tool results (#684) — 5-8 days
17. MCP server awareness (#683) — 3-5 days
18. Split connection.ts into domain stores — 2-3 days
19. Evaluate SQLite for persistence (#679) — 3-5 days

---

## g. Final Verdict

**Aggregate Rating: 3.3 / 5** (Core panel: 3.45 at 1.0x weight. Extended panel: 3.03 at 0.8x weight.)

Chroxy has executed remarkably well against the competitive audit's action plan — 12 of 15 items from phases 1-3 shipped in 3 days, including major architectural improvements (Zod validation, EventNormalizer, Maestro E2E) that were scoped as 60-day work. The security posture is solid: all three critical Feb 19 bugs are fixed, E2E encryption has no downgrade path, and the test suite covers the security-sensitive paths well. The project is functional and shippable today.

However, the project is at an inflection point. The two unreconciled roadmaps create confusion about what to work on next. The ws-server.js monolith (2,691 lines) and connection.ts monolith (2,764 lines) are approaching the complexity threshold where every new feature takes disproportionately longer. The `create_session` arbitrary CWD issue is a real security gap for an authenticated attacker. The issue backlog (29 open, 5 stale, 21 arguably unnecessary) creates an illusion of massive remaining work that demoralizes rather than directs. And the single most impactful UX recommendation from the original competitive audit — `acceptEdits` permission mode — was the one item that got skipped entirely.

The path forward is clear: housekeeping first (close stale issues, fix MEMORY.md, merge roadmaps, restrict create_session CWD), then the two highest-ROI features (acceptEdits + dynamic models), then structural investment (split the monoliths, add client persistence). The 90-day items (MCP, images, SQLite) can wait — they're valuable but not urgent. What matters now is converting a working v0.1 into a reliable daily-driver by closing the UX gaps and paying down the architectural debt before it compounds.

---

## h. Appendix: Individual Reports

| # | Agent | File | Rating |
|---|-------|------|--------|
| 1 | Skeptic | [01-skeptic.md](01-skeptic.md) | 4.0/5 |
| 2 | Builder | [02-builder.md](02-builder.md) | 3.8/5 |
| 3 | Guardian | [03-guardian.md](03-guardian.md) | 3.5/5 |
| 4 | Minimalist | [04-minimalist.md](04-minimalist.md) | 2.5/5 |
| 5 | Operator | [05-operator.md](05-operator.md) | 3.0/5 |
| 6 | Futurist | [06-futurist.md](06-futurist.md) | 3.4/5 |
| 7 | Tester | [07-tester.md](07-tester.md) | 3.5/5 |
| 8 | Adversary | [08-adversary.md](08-adversary.md) | 3.2/5 |
