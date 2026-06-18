# Minimalist's Audit: Status Report Backlog

**Agent**: Minimalist — ruthless YAGNI; best code is no code
**Overall Rating**: 3 / 5 (plan leanness)
**Date**: 2026-06-13

---

## Per-item verdicts

### Friction backlog (§3)
| Item | Verdict | Justification |
|---|---|---|
| #5631 model-metadata | **SIMPLIFY → KEEP-thin** | Much already fixed; #5745 added drift-warn. Remaining = a fallback-rendering pass (unknown model → show id, gate off capability chips), not a metadata service. Cut any "fetch model catalog from API" ambition. |
| #5623/#5613 reconnect role | **KEEP — but already shipped** | #5737 re-emits `session_role`; effectively closed on dashboard. Verify+close. Only live remainder = app-side `sessionRole` reset. |
| #5622 reconnect-storm perf | **DEFER (until measured)** | `maxPendingConnections=20` (`ws-server.js:524`) already bounds pre-auth sockets. "Starves the event loop" is plausible-but-unproven. Don't build a derivation queue/worker-pool on spec — defer until a flamegraph shows `box.before` dominating under a real storm. |
| #5674 mobile attribution | **KEEP** | Genuine parity gap; `buildPromptSessionLabel` exists + tested. Finish-the-port, cheapest real win. |
| #5668 mic surfacing | **SIMPLIFY → tiny** | Code half shipped; real fix was the .app rebuild. What remains = one `session_error` on spawn-fail. Don't build a mic-diagnostics panel. |

### Cleanup list
| Item | Verdict | Justification |
|---|---|---|
| #5618 dispatch-table | DEFER | Handlers already modular via `handlerRegistry`. Further migration = refactor-for-elegance, zero user payoff. |
| #5620 dual JSON-write | DEFER/CUT | Silent-loss risk already addressed (#5729/#5734). Remaining "collapse" is cosmetic. |
| #5621 retry-ladder dedupe | DEFER | Ladder just reworked (#5724); user-facing behavior already correct. |
| #5617 claude-tui FormDriver | DEFER (unless it fixes a wedge) | If it reduces wedge risk → KEEP; if just testability → DEFER. |
| #5619 both-clients contract | SIMPLIFY → KEEP-thin | Real leverage given store-core ripple pain. Scope to a lint that'd have caught actual regressions, not a full contract DSL. |

### #5731 dregs — all three CUT (wontfix)
- `resume_budget`: `resume()` is `this._budgetPaused.delete(sessionId)` (`cost-budget-manager.js:132`); harmless when never paused. Clean fix needs a new wire type. **Fix more complex than the bug.**
- standby EADDRINUSE: already retries 20×500ms=10s (`supervisor.js:33-34,542`). One-line cap bump at most.
- question-answer toolUseId: high-blast-radius for a near-unreachable legacy case.

## Harness-preamble (§4) — YAGNI. CUT, or build the 30-minute version.
`_buildSystemPrompt()` already concatenates `sessionPreamble → hint → skills` (`base-session.js:1091-1107`); per-repo presets already fold automatically (`repos[].sessionPreset`, `findRepoPresetFile`, `foldPreamble` at `session-preset.js:201`, `session-manager.js:789`). **A motivated user gets ~95% today** by dropping onboarding text into `~/.chroxy/config.json` `sessionPreset.preamble`. The global key only adds "one preamble across all repos." The §4 framing oversells the gap. If built: one `harnessPreamble` string, folded first via the existing chain. **Cut the per-provider notes entirely** — pure YAGNI, multiplies config surface + test matrix. Real uncosted risk: a global preamble burns context tokens on *every turn of every session* — a permanent tax for a hunch.

## Top 5 smallest-change-biggest-friction
1. **Verify+close #5623/#5613** — already paid for.
2. **#5674 mobile attribution** — port the shipped `buildPromptSessionLabel`.
3. **#5631 unknown-model graceful default** — one fallback path (reuse the #5747 capability-gating pattern).
4. **#5668 mic spawn-fail surfacing** — one `session_error` broadcast.
5. **Close #5731 (3 dregs wontfix) + close §4 as "use per-repo preset"** — backlog hygiene, removes 4 phantom items.

## Verdict: 3 / 5
The plan is *half* lean. Discipline on shipped work was genuinely good (closing #5697 wontfix, the `switchSession` no-op). But §5 drifts toward capability: a "reconnect sprint" around #5622 (likely already bounded by the 20-cap), and "build the harness preamble" when per-repo presets already deliver ~95%. **Single highest-leverage cut: kill the harness-preamble feature.** It's the only new surface proposed, it's YAGNI against working plumbing, its per-provider sub-feature is unbounded speculation, and it imposes a permanent per-turn token tax. Then close #5731 + the cleanup issues to stop the backlog masquerading as work.
