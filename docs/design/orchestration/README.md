# Orchestration / Delegation Harness ("Committee") — Design

Epic: [#6691](https://github.com/blamechris/chroxy/issues/6691). Sub-issues (delivery order):
M-1 #6692 → S-1 #6693 → M-2 #6694 → M-3 #6695 → E-1 #6696 → S-2 #6697 → E-2 #6698 →
E-3 #6699 → E-4 #6700 → M-4 #6701 → S-3 #6702 → S-4 #6703.

An expensive **architect** model decomposes an epic into subtasks; cheaper **worker** models
execute them as their own Chroxy sessions; the architect reviews worker plan-of-attack summaries
before execution and result summaries after (committee loop); the daemon durably records the run —
including a per-role/per-model **token ledger** — so delegated cost can be compared against a
monolithic frontier-model session. First dogfood: a full self-audit of this repo.

## Documents

| Doc | Slice |
|---|---|
| [engine.md](engine.md) | OrchestrationManager: run/subtask state machines, TurnDriver, decision contract, permission gate, git merge-back, failure matrix |
| [metering.md](metering.md) | Per-model usage capture fixes, RunLedger store, budget evaluator, report + baseline |
| [surface.md](surface.md) | Wire protocol (`orchestration_*`), lint-compliance checklist, dashboard Runs tab, gate UX |
| [verification-consistency.md](verification-consistency.md) | Adversarial cross-slice review — 30 findings (F1–F30) |
| [verification-source-claims.md](verification-source-claims.md) | Source spot-verification of 13 load-bearing claims |

The three slice docs were written by independent design passes and then adversarially reviewed.
**Where a slice doc conflicts with the reconciliations below, the reconciliations win.**
Note on prior art: #5018 and #5020 are CLOSED (completed) — #5018 shipped the subagent *profile
registry* but its per-profile *model override* AC was deferred and remains unbuilt (byok Task
children still inherit the parent model, `byok-session.js:1367`), so metering.md's "that PR must
split the synthesized map" note still applies to whichever future PR adds the override.

## Canonical reconciliations (supersede the slice docs)

1. **Enums** — protocol (`schemas/server/orchestration.ts`) is the single source; the engine
   imports them. Run states: `created, planning, plan_review, executing, paused, budget_paused,
   synthesizing, cancelling, suspended, completed, failed, cancelled` (`paused` = user-requested
   pause via `orchestration_run_action`; distinct from `budget_paused` so the UI can render the
   cause — without it, reconciliation 10's `resume`-from-`paused` would be unserializable in the
   strict wire enum). Subtask states: `pending,
   spawning, briefing, poa_review, executing, result_review, respawning, merging, conflict_fixup,
   escalated, done, skipped, failed, cancelled, interrupted`. Committee verdicts:
   `approve | revise | redelegate | escalate` (engine's `accept` renamed). (F1, F2, F10)
2. **Gates** — one registry, one engine API `resolveGate(runId, gateId, {decision, note,
   budgetUsd})`. Kinds: `epic_plan, escalation, bash_permission, budget_overrun` — user-approver
   only; architect reviews are timeline entries, not gates. Decisions:
   `approve | reject | revise | skip` (+ `budgetUsd` on budget_overrun approve — the only v1
   budget-change path). Gate statuses include `expired` (timeout, `resolvedBy:'policy'`; the
   permission gate checks request liveness before answering at timeout). The gate policy must
   cover the **full, current** `NEVER_AUTO_ALLOW` roster — now 7 entries including
   `request_permissions` (#6610) and `mcp_elicitation` (#6635), not the 5 engine.md §8 lists —
   with an explicit posture per entry: audit workers/architect → deny; implement workers →
   escalate; enumerate the roster from `permission-manager.js` at implementation time, not from
   the design doc. (F3, F17, F19, F23, F27)
3. **Store** — metering's RunLedger directory layout wins (`~/.chroxy/orchestration/` with
   `runs-index.json` + `runs/<runId>/{run.json, events.jsonl, report.*}`); the engine's
   `run-store.js` single file is deleted from the design. runId = `run_<ts>_<rand>`. Engine
   RunRecord extras (`plan`, `synthesis`, `integration`, gates) merge into `run.json`. (F4, F30)
4. **Worktrees vs ledger** — integration worktrees live at
   `~/.chroxy/orchestration/worktrees/<runId>/`, never under `runs/`; the orphan sweep scans only
   the worktrees subtree (a run-id–keyed sweep over the shared dir could have deleted the ledger).
   Restart-reconcile cleans terminal runs' worktrees via `git worktree remove --force` +
   `git worktree prune -C <run.cwd>`. (F5, F18)
5. **Events** — all engine emissions funnel through one projection layer
   (`orchestration/to-wire.js`, engine-owned) into the surface's four wire types; deltas broadcast
   via `_broadcastOrchestrationDelta` to **unbound clients only**. Metering's `orch_*` wire names
   are dropped; budget warn/cap surface as delta `run` upserts + timeline entries. No
   dispatch-table entries (would credit both clients; v1 is dashboard-only). (F6, F7, F13)
6. **Wire seq** — a dedicated per-run counter bumped only on *successful* broadcast; journal seq
   is unusable (usage coalescing ≤1/s would force permanent client re-requests). Snapshots stamp
   the current wire seq. Events emitted before wsServer exists must not burn seqs. (F14, F26)
7. **Money math** — the ledger owns all of it. The engine forwards raw terminal payloads +
   `{role, turnLabel, subtaskId}`; the ledger applies the `_trackUsage` gates, prices `cost:null`
   turns into `pricedCostUsd` (never contaminating provider-reported signed `costUsd`), and
   computes `effectiveUsd`. Engine's `estimatedUsd` field is deleted. Canonical `turn_usage`
   journal line = metering's shape + `turnLabel` + dotted roles (`architect`, `architect.review`,
   `worker.audit`, `worker.implement`, `worker.fixup`). (F9, F29, F22-adjacent)
8. **Budget v1** — config `{maxUsd, warnPercent}` only (perRole/maxTokens deferred); wire levels
   `ok | warned | capped`; evaluation before every new delegation AND every committee turn;
   one-shot latches; refunds recompute level without unfiring latches. (F8, F22, F24, F25)
9. **Wire additions for the dogfood** — client `orchestration_run_annotate {runId,
   baselineSessionId?, verdictQuality?}`; terminal `orchestration_run_snapshot` carries optional
   `report{json, markdown}`. Dedicated `RunUsageSchema` (tokens + `costUsd` + `pricedCostUsd` +
   `effectiveUsd` + `unknownCostTurns`) + `meteringGaps` on RunDetail. (F16, F20)
10. **Run actions** — `cancel | pause | resume`; engine gains `pauseRun`; `resume` valid from
    `suspended | budget_paused | paused` with per-state guards. (F12)
11. **Ownership** — `handlers/orchestration-handlers.js` + `ws-message-handlers.js` registration
    belong to S-2 (driven against a stub `ctx.services.orchestrationManager`); the engine (E-4)
    only implements that interface. Session badges (`orchestrationRunId/Role` on session_list)
    are engine-owned via a persisted `metadata` opt on `createSession`. (F21, F15)
12. **`orchestration_run_snapshot` is pull-only** (reply to `orchestration_run_detail_request`);
    the engine's push need is served entirely by deltas. (F11)

## Provider eligibility (source-verified)

| Provider | respondToPermission | setPermissionRules | v1 roles |
|---|---|---|---|
| claude-sdk | ✓ | ✓ | architect + all workers |
| claude-byok | ✓ | ✓ | architect + all workers |
| codex (app-server) | ✓ | ✗ — use per-session `codexSandbox: 'read-only'` (#6690, landed 2026-07-16) | workers |
| claude-cli | ✗ (HTTP hook only) | ✗ | excluded v1 |
| gemini | ✗ (no permission surface) | ✗ | excluded v1 |
| claude-tui / channel | n/a | n/a | excluded (no usage telemetry) |

Notes: `reserveSessions` does not exist in SessionManager — the engine scheduler implements its
own headroom under `maxSessions` (default 5, tight; config validation warns). One run at a time
in v1. `#6690` landed after the engine doc was written and supersedes its "codex sandbox opt"
gap: `createSession({codexSandbox: 'read-only'})` is the audit-worker posture for codex.
