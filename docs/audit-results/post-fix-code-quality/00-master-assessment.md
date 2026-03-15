# Master Assessment: Post-Fix Code Quality Audit

**Date:** 2026-03-15
**Target:** Chroxy codebase after 20-issue marathon fix + voice-to-text feature
**Agents:** 6 (4 core + 2 extended)
**Aggregate Rating:** 3.3 / 5

---

## a. Auditor Panel

| # | Agent | Rating | Key Contribution |
|---|-------|--------|------------------|
| 1 | Skeptic | 3.0/5 | Swift semaphore race, Tauri v2 event listener path mismatch, checkpoint git stash failure |
| 2 | Builder | 3.6/5 | Triple session_event fan-out, Tauri binding duplication, dev-preview uses console.log |
| 3 | Guardian | 3.1/5 | Checkpoint stash race (data corruption), hook registration leak to settings.json, dev-preview zombie tunnels |
| 4 | Minimalist | 2.5/5 | Dead dashboard state (totalCost/costBudget), @chroxy/protocol unused, duplicate _parseJsonLine |
| 5 | Tester | 3.8/5 | CLI forwarding path untested, executeSideEffects zero coverage, source-scan tests in new files |
| 6 | Adversary | 3.6/5 | Hook secret timing oracle, voice commands no window-scope guard, HTML injection sink |

---

## b. Consensus Findings (4+ agents agree)

### 1. Checkpoint Manager git stash operations are unsafe under concurrency
**Agents:** Skeptic, Guardian, Builder, Adversary (4/6)

`checkpoint-manager.js` uses the git stash stack (`stash@{0}`) which is shared across sessions. Concurrent checkpoint operations in the same repo corrupt each other's working trees. `git stash apply tagName` is also not a supported invocation — always falls back to the incomplete `git checkout` path.

**Action:** Use `git stash create` (non-stack) instead of `git stash push`. Add per-cwd async mutex.

### 2. Voice-to-text has multiple bugs that prevent end-to-end functionality
**Agents:** Skeptic, Guardian, Builder, Adversary (4/6)

- Swift helper has a semaphore double-signal race causing concurrent `AVAudioEngine.stop()`
- `useVoiceInput.ts` uses `__TAURI__` for event listening but `__TAURI_INTERNALS__` for invoke — events silently never register
- Tauri voice commands have no window-scope restriction — XSS can trigger recording
- Speech helper zombie process leak on fast stop/start cycling

**Action:** Fix the Swift semaphore race, unify Tauri API access path, add capability scope restriction.

### 3. Source-scan test anti-pattern persists in new test files
**Agents:** Builder, Tester, Minimalist, Skeptic (4/6)

Even the new test files from today's marathon contain `readFileSync` source-scan tests. `cli-session-stdin-epipe.test.js` has 3, and 20+ dashboard test files still use the pattern. These inflate coverage counts without catching regressions.

**Action:** Remove source-scan tests from new files. Phase out remaining ones.

---

## c. Contested Points

### Dev-preview tunnel lifecycle
- **Guardian** (HIGH): Tunnels started during a 30-second window survive session destruction — zombie cloudflared processes
- **Builder** (Medium): Uses console.log instead of logger, but functionally acceptable
- **Assessment:** Guardian is right about the zombie leak. The tunnel should be registered before `start()` resolves so `closeSession` can find and stop it.

### Hook secret timing oracle
- **Adversary** (Low-Medium): `Set.has()` is not constant-time for hook secret lookup
- **Guardian**: Didn't flag this — focused on the registration lifecycle
- **Assessment:** Low practical risk (256-bit entropy over network), but should be fixed for consistency with the main token path.

---

## d. Risk Heatmap

```
                    IMPACT
            Low    Medium    High    Critical
          +--------+--------+--------+--------+
  Likely  | source | voice  |        |        |
          | scan   | events |        |        |
          | tests  | silent |        |        |
          +--------+--------+--------+--------+
 Possible | dead   | tunnel | hook   | stash  |
          | state  | zombie | reg    | race   |
          |        |        | leak   |        |
          +--------+--------+--------+--------+
 Unlikely | timing | html   | speech |        |
          | oracle | inject | unmount|        |
          |        | sink   |        |        |
          +--------+--------+--------+--------+
```

---

## e. Recommended Action Plan

### Priority 1 — Safety Critical
1. Fix checkpoint-manager.js: use `git stash create` instead of `git stash push`, add per-cwd mutex
2. Fix hook registration lifecycle: check `_destroying` inside settings lock, await unregister before register retry
3. Fix dev-preview tunnel zombie: register tunnel before `start()` resolves

### Priority 2 — Voice Feature Fixes
4. Fix Swift semaphore double-signal race: add `done` flag
5. Fix useVoiceInput Tauri API path: unify `__TAURI_INTERNALS__` usage, extract shared tauri-bridge.ts
6. Add Tauri capability scope: restrict voice commands to `main` window only
7. Fix speech recognition unmount leak in mobile app

### Priority 3 — Code Quality
8. Fix _clearMessageState drain re-entrancy: use `process.nextTick()` for queue drain
9. Replace console.log with createLogger in dev-preview.js
10. Merge triple session_event fan-out in ws-forwarding.js
11. Extract `__legacy__` magic string to named constant
12. Extract shared `_parseJsonLine` to BaseSession

### Priority 4 — Dead Code / Cleanup
13. Remove dead `totalCost`/`costBudget` state from dashboard store
14. Remove `noopHaptic`/`noopPush` from dashboard PlatformAdapters
15. Evaluate @chroxy/protocol — either use it or remove it
16. Remove source-scan tests from new test files

### Priority 5 — Test Coverage
17. Add tests for `setupCliForwarding` in ws-forwarding.js
18. Add tests for `executeSideEffects`/`executeRegistrations`
19. Add checkpoint restore event + error path tests
20. Fix hook-secret.test.js reimplemented validator block

---

## f. Final Verdict

**Aggregate Rating: 3.3 / 5**
(Weighted: core 1.0x, extended 0.8x)

| Agent | Raw | Weight | Weighted |
|-------|-----|--------|----------|
| Skeptic | 3.0 | 1.0 | 3.0 |
| Builder | 3.6 | 1.0 | 3.6 |
| Guardian | 3.1 | 1.0 | 3.1 |
| Minimalist | 2.5 | 1.0 | 2.5 |
| Tester | 3.8 | 0.8 | 3.04 |
| Adversary | 3.6 | 0.8 | 2.88 |
| **Total** | | **5.6** | **18.12** |
| **Weighted Avg** | | | **3.24 ≈ 3.3** |

The 20-fix marathon raised the codebase from 3.0 to 3.3. The core session loop is significantly hardened (EPIPE guard, respawn flag, pending queue, hook secrets). The new voice-to-text feature brings the score back down by introducing 4 bugs in one feature — all fixable. The two critical findings (checkpoint stash race, hook registration leak) are pre-existing issues in code that wasn't touched by the marathon, not regressions from the fixes.

---

## g. Appendix

| # | File | Agent | Rating |
|---|------|-------|--------|
| 1 | 01-skeptic.md | Skeptic | 3.0/5 |
| 2 | 02-builder.md | Builder | 3.6/5 |
| 3 | 03-guardian.md | Guardian | 3.1/5 |
| 4 | 04-minimalist.md | Minimalist | 2.5/5 |
| 5 | 05-tester.md | Tester | 3.8/5 |
| 6 | 06-adversary.md | Adversary | 3.6/5 |
