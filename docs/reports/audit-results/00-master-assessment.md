# Master Assessment — Swarm Audit of the 2026-06-13 Status Report Backlog

**Date**: 2026-06-13
**Target**: open backlog in `docs/reports/status-2026-06-13.html` — §3 friction items, §4 harness-preamble feature, the #5731 "dregs"
**Panel**: 6 agents (4 core + Operator + Futurist), each verifying every claim against current `main`
**Aggregate rating of the report's *forward plan* (§5 next-moves)**: **3.1 / 5** — the engineering *narrative* (§1.5) is trustworthy and every "merged" claim spot-checked real; the *forward-looking* §3 table and §5 list are a snapshot from the **start** of the marathon and never re-baselined against the 19 PRs the same report documents merging.

---

## a. Auditor panel

| Agent | Lens | Rating | Key contribution |
|-------|------|:------:|------------------|
| Skeptic | Claims vs reality | 2.5 / 5 | Proved §3/§5 are stale: #5623 + #5674 already CLOSED, #5613 fixed-in-code but orphaned-open, #5631 ~60% done by pre-session #5663 |
| Builder | Implementability | 4 / 5 | File-by-file build order; flagged #5631 as a 4-package pricing-reconciliation iceberg mislabeled "cleanup"; verified harness-preamble is genuinely S |
| Guardian | Failure modes | 3 / 5 | #5622 is unbounded **synchronous** crypto on the main loop, self-DoS on restart fan-in; elevated qa-stale-`toolUseId` to a real intra-session integrity hole |
| Minimalist | YAGNI / cuts | 3 / 5 | Argues harness-preamble is ~95% covered by existing per-repo `sessionPreset`; close all 3 dregs + 4 cleanup issues |
| Operator | Daily UX | 3 / 5 | The missing #1 felt pain: **#5668 desktop voice error is silently swallowed** (concrete wiring gap); reconnect flash also an a11y false-alarm |
| Futurist | Architecture | 4 / 5 | Harness-preamble must get its own `_buildSystemPrompt` slot + own cap (not the shared 4000 budget); the real #5631 fix is wiring pricing through the wire schema to retire the dashboard's drift table |

---

## b. Consensus findings (4+ agents agree)

### C1 — The report's §3 friction table and §5 next-moves are STALE. (6/6)
The report body (§1.5) documents merging #5737, #5694, #5673 this marathon, but the §3 table and §5 list still treat their issues as open:
- **#5623** ("stale Observing flash") — **CLOSED 2026-06-13** (subsumed by #5737's server re-emit).
- **#5674** ("mobile permission attribution") — **CLOSED 2026-06-13** via #5694; yet §5 re-recommends it as next-move #5.
- **#5613** ("session_role not re-emitted") — **fixed in code** by #5737 (`ws-history.js:752-769`, comment cites `#5613`) but the **issue is still OPEN** — GitHub's closing-keyword regex only auto-closes the *first* id in `Fixes #5623, #5613` (the documented `feedback_gh_closing_keywords_list.md` gotcha).
- **#5631** — **~60% already shipped** by pre-session #5663 (`cc424e310`): `FALLBACK_MODELS` now has a `fable`/`claude-fable-5` entry, user overlay, default-model fallback.

**Action:** re-baseline before planning. The "reconnect sprint" the report headlines collapses to essentially one perf task (#5622) plus a residual client-side flash fix.

### C2 — A residual client-side reconnect flash survives #5737. (Operator, Guardian, Skeptic, Builder)
#5737 fixed the *server re-emit*, but **neither client clears `sessionRole`/`primaryClientId` on disconnect**:
- App: `packages/app/src/store/connection.ts` `socket.onclose` (~1195-1248) clears streaming/plan/inactivity state but not `sessionRole`.
- Dashboard: `packages/dashboard/src/store/connection.ts` (~1682-1707) — identical hole.

So a stale "Observing"/driver badge persists through the reconnect gap until the server round-trip lands. Worse (Operator): `ObserverBanner` is `accessibilityRole="alert"` + live-region, so screen readers **re-announce** a soon-to-be-cleared "Observing" on every reconnect. **Fix is a symmetric ~2-line clear in both `onclose` paths** — highest frequency × cheapest fix in the whole backlog.

### C3 — #5631's real remaining work is narrow and structural, not a UI-wide rewrite. (Skeptic, Builder, Operator, Futurist)
The **server** is already overlay-driven and graceful (`models.js` `createModelsRegistry`, `~/.chroxy/models.json` overlay, `null`-not-`0` for unknown pricing). The unfixed seam is the **dashboard**: `packages/dashboard/src/lib/model-pricing.ts` is an independent, stale table (mislabels `claude-sonnet-4-5` as "Claude 3.7 Sonnet", no 4.x/fable), and the wire schema `ServerAvailableModelsEntrySchema` carries `{id,label,fullId,contextWindow}` but **no pricing** — so the two tables *structurally cannot converge*. Quick win: bump `FALLBACK_MODELS` opus→4-8 + fix the dashboard labels. Structural fix: add optional `pricing` to the wire entry, demote the dashboard table to fallback. Plus server gap: `session-manager.js` never validates the initial model against `getAllowedModelIds()` (#5631 point 6).

### C4 — The #5731 dregs should be reconciled, not silently carried. (5/6)
- `resume_budget` — Guardian found it's a literal **no-op stub** (`ws-message-handlers.js:136 resumeBudget: () => {}`) while the real `sessionManager.resumeBudget()` exists unused (`session-manager.js:2653`). It's a **dead button**, not just "no-op when not paused." Wiring the stub is trivial; the *clean ack* needs a dedicated `budget_resume_ack` wire-type (reusing `budget_resumed` injects a false "session resumed" chat message).
- standby `EADDRINUSE` — confirmed `MAX_STANDBY_EADDRINUSE_RETRIES=20 × 500ms ≈ 10s` (`supervisor.js:33`). One-line cap bump; niche.
- question-answer stale-`toolUseId` — Guardian elevates this above "dreg": cli/sdk `respondToQuestion` route on a bare `_waitingForAnswer` boolean with **no toolUseId match**, and unmapped answers fall back to `client.activeSessionId` (`input-handlers.js:808`). A late answer to a rotated prompt can land on the *current* prompt (a deny becoming an approve). Intra-session only (cross-session is gated), but real.

---

## c. Contested points

### P1 — #5622 severity: HIGH or DEFER?
- **Guardian (HIGH):** unbounded **synchronous** pure-JS X25519 scalar-mults + Ed25519 sign per *authenticated* reconnect, on the main loop (`ws-history.js:185-197`, `crypto.ts` tweetnacl). The only backstop (`maxPendingConnections=20`) counts **unauthenticated** sockets — wrong layer. Trigger = supervisor restart / tunnel flap fanning N clients in simultaneously → self-DoS on cold start.
- **Minimalist/Operator (DEFER):** invisible to a 1-2 device daily driver; the 20-cap likely bounds real storms; #5724's ladder cap already de-amplifies. Don't build a worker-pool on spec.
- **Builder (middle):** a cheap **concurrency gate** (cap in-flight derivations, `setImmediate`-yield) is the right unattended scope; the worker-thread offload is a deliberate design call, not autonomous work.

**My assessment:** Guardian is technically right that the *mitigation in the report is aimed at the wrong layer* (client backoff is already bounded; server derivation throughput is the uncapped surface). But Minimalist is right it's **not user-felt for the solo driver**. Resolution: **don't fold #5622 into a "reconnect sprint" as if user-facing**; file it as a server-bounding task (per-identity throttle + optional crypto offload) with Guardian's analysis attached, prioritized below the felt-friction items. Severity = real-but-not-urgent.

### P2 — harness-preamble: build it, or YAGNI?
- **Minimalist (CUT):** existing per-repo `sessionPreset` + `foldPreamble` already deliver ~95%; the global key is a DRY convenience; per-provider notes are pure speculation; it's a permanent per-turn token tax.
- **Futurist/Builder (BUILD, minimal):** it's genuinely S and server-only, but **only if** it gets its own `_buildSystemPrompt` slot + own cap (not the shared 4000 budget — else a verbose global blurb silently truncates the user's trusted repo/session text) and routes through `BASE_SESSION_OPT_KEYS`. Per-provider notes should be **generated from `static capabilities`**, never hand-authored (hand-authoring re-creates the #5631 drift).

**My assessment:** both are right about something. Ship **only** if it earns the Futurist design (own slot, own cap, picker-forwarded, capability-*generated* notes); **cut** the hand-authored per-provider tailoring entirely. Given it's a *new feature* and every agent ranks the friction fixes above it, it's a follow-up, not this session's lead. Defer with a precise design note so it doesn't calcify if/when built.

---

## d. Factual corrections to the report

| Report claim | Correction | Found by |
|--------------|-----------|----------|
| §3 lists #5623 as open friction | CLOSED 2026-06-13 (subsumed by #5737) | Skeptic, Builder |
| §3 lists #5674 as open; §5 re-recommends it as move #5 | CLOSED 2026-06-13 via #5694 | Skeptic, Builder |
| §3/§5 treat #5613 as open | Fixed in code (#5737); issue only orphaned-open by the comma-list closing-keyword bug | Skeptic |
| §5 move #4 frames #5631 as untouched, degrading "across the UI" | ~60% shipped by #5663; server authoritative for Claude cost; real defect is dashboard table drift + pricing-less wire schema | Skeptic, Operator, Futurist |
| §5 "confirm the mic" treats #5668 as resolved-pending-launch | The "surface spawn failures" half is a **live, unfixed wiring gap** (`voiceInput.error` never rendered) | Operator |
| §5 bundles #5622 into a reconnect sprint as user-felt | Server-CPU only; invisible to a solo driver; mitigation aimed at the wrong layer | Guardian, Minimalist, Operator |

---

## e. Risk heatmap

```
            IMPACT →
          LOW            MEDIUM           HIGH
        +--------------+----------------+----------------+
  HIGH  |              | #5622 eager    |                |
        |              | key-deriv      |                |
        +--------------+----------------+----------------+
  MED   | resume_budget| harness cap/   | qa-stale-      |
        | dead button  | precedence     | toolUseId      |
        |              |                | mis-route      |
        +--------------+----------------+----------------+
  LOW   | standby      | #5631 table    | #5668 voice    |
        | EADDRINUSE   | drift / #5674  | silent fail*   |
        | #5613 fixed  | residual       | (*felt, not    |
        |              |                |  integrity)    |
        +--------------+----------------+----------------+
```

Two different problems pull top-right: **#5622** (high-likelihood, medium-impact — volume) and **qa-stale-toolUseId** (low-likelihood, high-impact — integrity). #5668 is high *felt* pain, low technical risk.

---

## f. Recommended action plan (prioritized: consensus × felt-friction × effort)

**Tier A — ship now (cheap, high felt-friction, no protocol/client coordination):**
1. **#5668 — surface desktop voice errors.** Add `error` to the `voiceInput` prop (`InputBar.tsx`) and render it (`App.tsx:2132`); the hook already exposes `error` (`useVoiceInput.ts:300,479`). Operator's #1 felt pain on a headline feature. *(S)*
2. **#5623/#5613 residual — clear `sessionRole`/`primaryClientId` on disconnect** in both `connection.ts` `onclose` paths. Kills the most-frequent reconnect jank + the a11y false-alarm. *(S, symmetric)*
3. **#5631 quick-win — bump `FALLBACK_MODELS` opus→4-8 + fix the dashboard `model-pricing.ts` stale labels/4.x rows.** Stops the worst degradation. *(S)*

**Tier B — parity + structural (this session if time, else issues):**
4. **#5674 residual — mobile per-tab pending-permission dot** in `SessionPicker.tsx` (+ assertive a11y announcement of a new prompt, the mobile mirror of #5733). Port the dashboard's `derivePendingPermissionSessions`. *(M)*
5. **#5631 structural — add `pricing` to `ServerAvailableModelsEntrySchema`**, populate from the overlay-aware registry, demote the dashboard table to fallback. Ends the drift treadmill. *(M, protocol + both clients)*

**Tier C — file as issues, decide deliberately:**
6. **#5622 server-bounding** — per-identity derivation throttle + optional crypto offload (Guardian's analysis). *(M/L, not user-felt)*
7. **harness-preamble (§4)** — only as the Futurist-minimal design; cut per-provider hand-authoring. *(S feature, deferred)*
8. **resume_budget** — wire the stub + add `budget_resume_ack` wire-type. *(M, protocol)*
9. **session-manager initial-model soft-validate** (#5631 point 6). *(S)*

**Reconcile (backlog hygiene):**
- **Close #5613** (fixed by #5737, orphaned by the comma-list gotcha).
- Confirm #5623, #5674 are closed (they are).
- Update #5731: close the EADDRINUSE + question-answer dregs decisions explicitly; keep resume_budget as a real (if minor) bug.

**Cleanup list verdicts:** #5618 dispatch-table = **real debt** (Futurist: bend the dual-table drift curve down) — prioritize; #5621 retry-ladder dedupe = real-but-small (two straggler constants); #5620 dual JSON-write = cosmetic/dead-code, defer.

---

## g. Final verdict

**Aggregate: 3.1 / 5** (core panel 1.0×: 2.5/4/3/3; extended 0.8×: Operator 3, Futurist 4 → weighted ≈ 3.1).

The report's *record of work done* is excellent and honest — every merged PR I sampled is real on `main`, and the scope-discipline calls (closing #5697 wontfix, the `switchSession` no-op verification) show good instincts. But its *forward plan* was never re-baselined against its own marathon: half the §3/§5 items already shipped, and the two genuinely-open felt-friction wins (desktop voice silent-fail, the residual reconnect flash) aren't even on the next-moves list. The path forward is mostly **finishing convergence** (clear role on disconnect, retire the dashboard pricing table, port the mobile pending dot) rather than greenfield — with exactly one item (the harness-preamble) that needs a deliberate design call before it calcifies. Re-baseline, close the three already-done issues, ship Tier A, and the backlog snaps back to reality.

---

## h. Appendix — individual reports

| Agent | File |
|-------|------|
| Skeptic | [`01-skeptic.md`](01-skeptic.md) |
| Builder | [`02-builder.md`](02-builder.md) |
| Guardian | [`03-guardian.md`](03-guardian.md) |
| Minimalist | [`04-minimalist.md`](04-minimalist.md) |
| Operator | [`05-operator.md`](05-operator.md) |
| Futurist | [`06-futurist.md`](06-futurist.md) |
