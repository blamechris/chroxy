# Futurist's Audit: Long-Term Architecture

**Agent**: Futurist — extensibility, tech-debt forecast, decisions that calcify
**Overall Rating**: 4 / 5 (architectural soundness of the forward plan)
**Date**: 2026-06-13

---

## 1. Harness-preamble — SOUND, with one revision (don't invent a new fold mechanism)
Prompt assembled in `BaseSession._buildSystemPrompt()` (`base-session.js:1091-1107`): a 3-way concat (preamble / hint / skills). **Repo+session folding happens at create time, not here** — `session-manager.js:777-816` calls `resolveSessionPreset()` then `foldPreamble(resolved.preamble, sessionPreamble)` (`session-preset.js:201-213`) and stores the *single folded string* into `sessionPreamble`. The 4000-char cap (`SESSION_PREAMBLE_MAX_LENGTH`, base-session.js:42) is enforced on that folded result.

**Load-bearing finding:** if the global harness text is prepended into the same `sessionPreamble` slot, it **competes for the same 4000-char budget** and will silently truncate the user's trusted repo/session voice; the existing `capped` disclosure fires on content the user didn't author.

**Revision (clean, non-calcifying):**
1. Keep the harness preamble as its **own `parts.push()` entry in `_buildSystemPrompt()`**, not folded into `sessionPreamble`. Add `harnessPreamble` to the `BaseSession` ctor destructure AND `BASE_SESSION_OPT_KEYS` (same PR — the #5367 picker contract forwards it to every provider for free). Order: `harnessPreamble → sessionPreamble(folded) → hint → skills`.
2. Give it its **own cap** (or none — operator-authored in `~/.chroxy/config.json`, same trust class as the daemon override). Do NOT route through `foldPreamble`'s shared budget.

**Per-provider tailoring:** maps cleanly onto the existing `static capabilities` getter (`claude-tui-session.js:87-114`). **Generate** the note from `ProviderClass.capabilities` at create — don't let operators hand-author per-provider variants (that re-creates the #5631 drift one layer up).

## 2. Model-metadata (#5631) — STRUCTURAL; the server is mostly there, the debt is the dashboard
Server side already structurally fixed: `models.js` is a real registry (`createModelsRegistry()` line 536) with a **user-extensible overlay** (`~/.chroxy/models.json`, `loadModelsOverlay` line 330) seeding new ids/labels/windows/pricing with no code change. `FALLBACK_MODELS` now has `fable`/`claude-fable-5`+`opus-4-7`. Graceful degradation real: `humanizeModelId` (490), `computePromptCostUsd` returns `null` not `0` (263-284), warn-once drift guard (819-825).

**Unfixed seam = the dashboard.** `model-pricing.ts` is an independent hardcoded 3.7/3.5-era table that can't see the overlay and is the single source for `CLIENT_ESTIMATED_COST_PROVIDERS`. The wire makes it worse: `ServerAvailableModelsEntrySchema` (`protocol/server.ts:409-418`) carries `{id,label,fullId,contextWindow}` but **no pricing** — server *knows* overlay pricing, dashboard *can't receive it*. #5745 was a manual patch — the treadmill.

**Recommendation (structural):** extend `ServerAvailableModelsEntrySchema` with optional `pricing`, populate from `resolveModelPricing` (overlay-aware), demote `model-pricing.ts` to fallback-only. Single source of truth end-to-end; a new model = one overlay entry priced in both. The remaining #5631 work is ~80% "wire pricing through + retire the dashboard table," not greenfield. One valid server gap: `session-manager.js` doesn't validate the initial model against `getAllowedModelIds()` (point 6) — soft-validate-and-warn for non-Claude.

## 3. Top 5 long-term findings
1. **Dual pricing tables with a wire gap that forbids convergence.** Highest-leverage structural debt. Fix = add `pricing` to the wire entry; demote the dashboard table.
2. **Harness-preamble 4000-char budget collision** if folded into `sessionPreamble`. Pre-empt with its own slot + own cap.
3. **`BASE_SESSION_OPT_KEYS` is the most important extension contract** (lint-enforced). Any new preamble/metadata opt MUST route through the picker — else re-open the #3224/#4790 middle-layer trap.
4. **Per-provider tailoring is tempting to hand-author and will rot.** `static capabilities` is the correct *generative* source; any parallel table becomes drift.
5. **`humanizeModelId` is a Claude-shaped heuristic doing double duty as the universal fallback** — latent mis-render as providers proliferate; ensure new providers supply `getModelMetadata`.

## 4. Cleanup items — real vs cosmetic
- **#5618 dispatch-table — REAL debt (prioritize).** The twin message-handlers grew +968 lines with only ~21 of ~95 cases on the shared `runDispatch` table; the rest unprotected from drift — the same dual-table failure mode as the pricing tables, at the handler layer.
- **#5621 retry-ladder dedupe — REAL but small.** `MAX_RETRIES`/`RETRY_DELAYS` hand-redeclared in both `connection.ts` despite `connect-flow.ts` exporting them. Two stragglers that can silently diverge.
- **#5620 dual JSON-write — COSMETIC/dead-code.** `JsonStateFile` never instantiated. Defer/opportunistic.

## 5. Reconnect items — point fixes correct, no missing abstraction
The reconnect state machine already exists + is shared (`ConnectionPhase` + `createReconnectScheduler` + `RECONNECT_MAX_RUNG`, `connection.ts:151-158,1480`). #5724/#5737 *extended* it rather than scattering fixes — the abstraction is holding. #5623/#5613 are state-resync gaps, not a missing machine; #5622 is an orthogonal backpressure gap. No rewrite warranted.

## Verdict: 4 / 5
The codebase is healthier than the report's framing — the server has the overlay registry and shared reconnect machine that #5631 and the reconnect backlog ostensibly need, so most "new feature" work is *finishing convergence*, not greenfield. The one place the plan would calcify is the harness-preamble if folded into the existing `sessionPreamble` slot sharing the 4000-char budget; its own slot + own cap + picker-forwarding + capability-*generated* notes turns it into the cleanest extension point. Docked one point: the report treats the dual pricing tables + pricing-less wire schema as a UX nit when it's the load-bearing extensibility decision, and proposes per-provider tailoring without naming the capability registry as the source.
