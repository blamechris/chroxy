# Skeptic's Audit: Status Report Backlog

**Agent**: Skeptic — cynical systems engineer; cross-references every claim against actual code
**Overall Rating**: 2.5 / 5 (implementation-readiness of §5 next-moves)
**Date**: 2026-06-13

---

**Bottom line up front:** The report's §3 "Friction backlog" table is **stale and self-contradicting**. It lists 6 open friction items, but **2 are already CLOSED** (#5623, #5674), **1 is fixed-but-not-auto-closed** (#5613, victim of the `Fixes #A, #B` GH gotcha), and **1 is structurally half-done by a pre-session PR the report under-credits** (#5631). The report's own narrative body (§1.5) correctly describes shipping #5737 which closes these — but nobody updated the §3 table to match. Someone reading only §3 + §5 would re-do work that's already merged.

## Per-item verdicts

| Item | Verdict | Evidence |
|------|---------|----------|
| **#5623** stale "Observing" banner | **ALREADY FIXED (closed)** | Issue `CLOSED/COMPLETED` (18:41:57Z), auto-closed by PR #5737 (`Fixes #5623`). Server re-emits `session_role` in `sendSessionInfo` (`ws-history.js:763-769`), `getPrimary` wired at `ws-server.js:726,799`. App handler is a pure state-setter (`message-handler.ts:3068-3084`). **Caveat:** the pure client-side reset-on-disconnect the issue body called "a one-liner worth having regardless" was NOT implemented — app `connection.ts` never nulls `sessionRole` on `onclose`, so a flash window survives between disconnect and the reconnect re-emit. Closed anyway. |
| **#5613** session_role not re-emitted | **FIXED IN CODE, issue STILL OPEN (stale)** | Code fix is live (`ws-history.js:752-769`, comment cites `#5613`). But #5613 is still `OPEN`, zero comments. Cause: PR #5737's `Fixes #5623, #5613` — GitHub's closing-keyword regex only auto-closes the **first** id in a comma list (`feedback_gh_closing_keywords_list.md`). **Action: manually close #5613.** |
| **#5631** model metadata hardcoded | **PARTIALLY FIXED (~60%), report under-credits it** | Pre-session PR **#5663** (`cc424e310`, June 12) landed a big slice. Point 1 FIXED — `FALLBACK_MODELS` has a `fable`/`claude-fable-5` entry (`models.js:68`). Points 3+5 addressed via the user overlay + deterministic fallback. Point 4 partially via #5745. **STILL REAL:** Point 2 (pricing rows — opus still `4-7` only) and **Point 6 (session-manager never validates model against `getAllowedModelIds()` — zero matches in `session-manager.js`).** #5732 is irrelevant to #5631 (it guards `set_model` capability, not metadata). |
| **#5622** reconnect-storm | **STILL REAL** | No concurrency cap. `deriveSharedKey`+`createKeyPair`+HKDF run synchronously + unbounded in the eager auth path (`ws-history.js:182-208`). No semaphore anywhere. The biggest genuinely-unfixed perf item. |
| **#5674** mobile permission attribution | **ALREADY FIXED (closed)** | `CLOSED/COMPLETED` (08:33:03Z). #5673 routed `sessionId` server-side + stamped `originSessionId` in the app handler. Report lists it open AND re-recommends it as next-move #5 — both wrong. |
| **#5668** mic helper-spawn silent revert | **PARTIALLY FIXED / mostly stale** | Code half fixed in #5672. Issue stays open only for the "surface helper-spawn failures" nicety — NOT implemented (no spawn-error surfacing in the speech helper). Real-world fix was the .app rebuild. Low value remaining. |

## #5731 dregs — all three verified STILL REAL and accurately described
- **resume_budget no-op:** `input-handlers.js:666-677` returns with no ack/error when not paused.
- **standby EADDRINUSE:** `supervisor.js:33-34,542` — 20 × 500ms ≈ 10s then gives up.
- **question-answer stale toolUseId:** consistent with "mostly mitigated"; lowest value.

## Harness preamble (§4)
Accurately scoped. `sessionPreamble` → `_buildSystemPrompt()` plumbing + `set_session_preamble` exist; the global `harnessPreamble` key genuinely doesn't. The one item that's cleanly real and implementation-ready.

## Top 5 findings
1. **#5613 is done but the issue is still open** — comma-list closing-keyword bug. Don't reimplement; close it.
2. **The §3 table contradicts the report's own §1.5 narrative** — lists #5623 and #5674 as open when both are CLOSED.
3. **#5631 is ~60% done by pre-session #5663** — remaining work is narrow: point 6 (session-manager validation) + point 2 (pricing rows).
4. **#5622 is the one genuinely-untouched perf item and bigger than its LOW label** — unbounded synchronous X25519 DH per connect.
5. **The "reconnect sprint" is two-thirds already done** — #5623 + #5613 merged via #5737; only #5622 remains.

## Verdict
The engineering narrative (§1.5) is honest and well-evidenced. But §3/§5 are a snapshot from the *start* of the session: they re-list closed issues and frame #5631 as untouched when its foundation landed the day before. Cleanly-real open items: **#5622**, the residual ~40% of **#5631**, the **harness-preamble**, the **three dregs** — and **#5613 should just be closed**.
