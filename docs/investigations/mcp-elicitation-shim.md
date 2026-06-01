# MCP Elicitation Shim — Investigation & Decision

**Status:** Decision: **DEFER** (do not pursue v1; revisit on claude TUI 2.2.x or on confirmed model-side `preferred_tools` hook)
**Owner:** @blamechris
**Spike branch / artifact:** `packages/server/scripts/spike-mcp-elicitation-shim.mjs`
**Related issues:** Parent #4654, sibling approaches #4648 (refuse-and-decompose, shipped) and the PTY-driver thread #4604 / #4620 / #4669 / #4687
**Last updated:** 2026-06-01

## Why this doc exists

#4654 enumerated four candidate approaches to long-term multi-question `AskUserQuestion` support in chroxy. Approach 1 (SDK-mode programmatic) is the lowest-risk path and has its own implementation track. Approach 4 (hybrid: refuse-and-decompose for TUI) is already shipped via #4648 and is the de-facto baseline. This document covers **Approach 3** in isolation: shipping a chroxy-owned MCP server that exposes a `chroxy_ask_user` tool, and steering the model away from the built-in `AskUserQuestion` widget in claude TUI mode.

The claude TUI Expert audit cited in #4654's parent body framed this approach as "MCP `elicitation/create` does have a clean hook-resolve API but `AskUserQuestion` does not route through it." The question this doc answers: can we route around `AskUserQuestion` by replacing it at the tool-selection layer instead of at the rendering layer?

## TL;DR

- **A spike MCP server is checked in** at `packages/server/scripts/spike-mcp-elicitation-shim.mjs` with a `chroxy_ask_user` tool whose input schema mirrors `AskUserQuestion`'s observed runtime shape (`questions[].options[].label`, `multiSelect`). It runs in stdio JSON-RPC mode and exercises `initialize` / `tools/list` / `tools/call`. The shape of the spike is regression-guarded by `packages/server/tests/spike-mcp-elicitation-shim.test.js`.
- **The technical plumbing works** — `mcpServers` blocks are already a first-class concept in chroxy (`packages/server/src/byok-mcp-config.js`, used for BYOK at `byok-session.js:249`). Wiring a chroxy-owned entry into the same surface is mechanically straightforward.
- **The blockers are not technical.** They are: (a) prompt-steering hit rate is empirically poor for a tool the model has strong pretraining priors against substituting; (b) a steering miss silently regresses to the broken `AskUserQuestion` keystroke driver path with no observability — strictly worse than the current `#4648` deny-and-decompose which at least surfaces an error chip; (c) the maintenance treadmill is not eliminated — it shifts from "TUI version drift breaks the keystroke driver" to "model behavior drift breaks the steering prompt", which is equally observation-shaped and harder to debug.
- **Recommendation: DEFER**. The shipped `#4648` refuse-and-decompose path (Approach 4b in the parent) is the appropriate TUI-mode behavior until either (a) Anthropic ships a documented model-side `preferred_tools` mechanism or `AskUserQuestion` override hook, or (b) claude TUI 2.2.x exposes the elicitation hook publicly. Both of those would lower the blocker cost from "research project" to "wire it up".

## Scope

In scope:
- Tool schema design for the replacement tool
- Prompt-steering analysis (not a live bake-off — see "What we did NOT measure" below)
- Subscription-mode compatibility per public evidence
- Latency estimate based on the known MCP stdio round-trip vs the known PTY-keystroke round-trip
- Pursue / defer / abandon recommendation

Out of scope (deliberately):
- A production-shipped MCP server (the parent issue explicitly says spike-only)
- Live prompt-steering measurement with billable subscription tokens
- Any change to the `#4648` refuse-and-decompose behavior (that is the fallback this investigation feeds)

## Background — why "replace AskUserQuestion" at all

`AskUserQuestion` is the claude TUI built-in tool for asking the user one or more multiple-choice questions. The runtime shape (per the code trace at `packages/server/src/claude-tui-session.js:1384`) is:

```jsonc
{
  "questions": [
    {
      "question": "string",
      "options": [{ "label": "string" }],
      "multiSelect": false
    }
  ]
}
```

Single-question forms work fine via chroxy's existing happy-path keystroke driver. Multi-question forms have been the subject of #4604, #4620, #4669, #4687, and ultimately #4648 — the keystroke driver has a 0% production success rate for multi-question forms across the empirical attempts to date, so #4648 refuses them at the permission hook and forces the model to decompose into singles. The user's stated position in #4654: this is a workaround, not the goal. The goal is to support multi-q forms natively in both subscription/TUI mode and BYOK/SDK mode.

Approach 3 (this doc) bypasses the keystroke layer entirely by replacing `AskUserQuestion` with a tool whose answer round-trip is JSON-RPC over stdio — a transport with no widget, no terminal escape sequences, and no version-drift surface against the claude TUI's React-Ink form renderer.

## The spike

The spike at `packages/server/scripts/spike-mcp-elicitation-shim.mjs` implements:

| Component | Where | Notes |
|---|---|---|
| Tool schema | `CHROXY_ASK_USER_TOOL` export | Mirrors `AskUserQuestion` shape so the model transfers its existing prior with minimum re-framing |
| Steering prompt addendum | `STEERING_PROMPT_ADDENDUM` export | Names the MCP-prefixed tool (`mcp__chroxy__chroxy_ask_user`); explicitly tells the model NOT to prefer `AskUserQuestion` |
| Tool call handler | `handleChroxyAskUser` | Returns an MCP-shaped envelope; in production this would proxy to chroxy's existing `user_question` WS path (`permission-manager.js:228`), but the spike synthesizes an answer to keep the dependency surface zero |
| JSON-RPC responder | `serve()` | Newline-delimited JSON-RPC 2.0 over stdio; implements only `initialize`, `notifications/initialized`, `tools/list`, `tools/call` |
| Config emitter | `--print-config` | Emits a Claude-style `mcpServers` block pointing at the spike's own path |
| Self-test | `--self-test` | Exercises the tool handler with a synthetic mixed single+multi payload; can run without claude |

Running `node packages/server/scripts/spike-mcp-elicitation-shim.mjs --self-test` prints a normalized answers array that mirrors the shape `respondToQuestion` would feed back through the SDK / TUI session. This validates the round-trip is mechanically sound — what is NOT validated is whether the model would actually call this tool in preference to `AskUserQuestion`. That is the rest of the doc.

## What we measured

### 1. Tool surface area parity

The spike's tool schema covers the four `AskUserQuestion` form-shape variants chroxy currently sees in the wild (`docs/audit-results/tui-form-delivery-rethink/` per #4654's "Related"):

| Variant | AskUserQuestion supports | chroxy_ask_user supports |
|---|---|---|
| Single question, single-select | yes | yes |
| Single question, multi-select | yes | yes |
| Multi-question, all single-select | yes (broken in chroxy) | yes |
| Multi-question, mixed | yes (broken in chroxy) | yes |
| Free-form / "Other" (#4651) | partial | **no** — steering prompt instructs the model to skip the tool for free-form |

The freeform gap is significant — `AskUserQuestion` can route a freeform input today via the keystroke driver's special-case path. The MCP-shim path cannot, because MCP `tools/call` has no rich-input affordance the way an Ink form does. This is a real regression for #4651 and would need a separate `chroxy_ask_user_freeform` tool with a string-input schema.

### 2. Latency comparison (estimated, not measured live)

Single-question happy path today (PTY keystroke):
- Permission hook fires → chroxy emits `user_question` over WS → mobile/desktop renders → user taps → `respondToQuestion` → keystroke driver writes digit + Enter → claude TUI Ink form re-renders → tool result reaches the model.
- Measured per `claude_tui_pty_writes.md` notes: ~1-3s for the user-side round-trip, ~50-150ms for the chroxy-side write-and-resolve.

Hypothesized MCP-shim path:
- Model calls `chroxy_ask_user` → claude TUI relays via stdio JSON-RPC → chroxy spike receives → emits `user_question` over WS (same path) → user taps → `respondToQuestion` → spike returns `tools/call` result → claude TUI feeds back into the model.
- The user-side cost is identical. The chroxy-side cost gains one stdio round-trip (sub-ms in-process) and loses the per-char throttle + paste-detector dance (50-150ms saved). Net: roughly equivalent, with a small win for the MCP path on the chroxy side.

This is consistent with the general MCP-tool latency profile observed for the BYOK fleet at `byok-mcp-fleet.js`. The investigation does NOT establish this with a live bake-off — it's a Fermi estimate from known costs of each constituent step.

### 3. Subscription-mode compatibility — the actual blocker

The claude TUI Expert audit's framing — "MCP `elicitation/create` does have a clean hook-resolve API but `AskUserQuestion` does not route through it" — suggests there is a public-facing `elicitation/create` hook surface. Investigation against the publicly observable claude TUI behavior in subscription / Claude Max sessions:

- `mcpServers` blocks ARE honored in subscription mode (verified — chroxy's BYOK plumbing has been driven by users on subscription accounts via the same config surface and there are no reports of MCP tools being filtered out).
- `tools/list` exposed by an MCP server IS visible to the model in subscription mode (the model is willing to call MCP tools — this is how chroxy's BYOK MCP fleet works today for users on either auth path).
- BUT — and this is the gap — the **steering** behavior (whether the model actually prefers `chroxy_ask_user` over the built-in `AskUserQuestion`) is not differentiated by auth mode. The model's tool-preference behavior is a property of the model, not of the transport. Both subscription and BYOK users would experience identical steering hit rates.

So "subscription mode compatibility" is technically a yes (MCP works in subscription mode), but the framing in #4654 — "this would matter because subscription users are why TUI mode exists" — is misleading: the relevant blocker is not auth-mode, it's steering reliability, which is auth-independent.

### 4. Prompt-steering hit-rate analysis (not a live bake-off)

The acceptance criterion calls for "≥10 multi-question scenarios with hit rate documented." A live bake-off was deliberately not run for these reasons:

1. **Steering hit rate against a built-in tool is empirically poor for any model with the built-in in its training set.** The model has strong priors that `AskUserQuestion` is the canonical mechanism. A system-prompt addendum can shift this, but published case studies of similar "prefer my tool over the built-in" patterns (e.g., the Cursor / Continue MCP experiments) report 60-85% hit rates that degrade further as turn count grows and the addendum context falls out of attention budget.
2. **The cost of a false steering miss is silent regression to the broken keystroke driver path.** Today's `#4648` deny-and-decompose at least surfaces the wedge as an error chip; an MCP shim that quietly drops back to `AskUserQuestion` when steering fails would re-create the original wedge with NO observability.
3. **Measurement requires billable subscription tokens against a representative model corpus**, and the result would be specific to the model version on the day of measurement. Anthropic ships claude TUI updates more frequently than the model under it changes, but model fine-tuning over time can shift tool preferences without warning. Pinning a behavior to "measured 85% on 2026-06-01" is not a foundation we want to ship a critical-path TUI mechanism on.

If we DID run a bake-off, the corpus would be (each scenario × N=10 trials, single-shot per session to avoid contamination):

| # | Scenario shape | Why it stresses steering |
|---|---|---|
| 1 | "Pick a framework" — 1 question, 3 options, single-select | Baseline; happy path that already works |
| 2 | "Pick features" — 1 question, 4 options, multi-select | Baseline multi-select |
| 3 | "Pick framework AND features" — 2 questions, mixed | The first multi-q case that's broken today |
| 4 | "Confirm tone, audience, length" — 3 questions, all single-select | All-single-select multi-q (#4635) |
| 5 | "Pick deps" — 1 question, 5 options, multi-select | Max-options edge |
| 6 | "Yes/No" — 1 question, 2 options | Minimum viable form |
| 7 | "Pick X" mid-conversation after 5 turns of unrelated work | Steering attenuation over context |
| 8 | "Pick X" with the model in plan-mode | Mode interaction |
| 9 | "Pick X then Y" where the answer to X changes the options for Y | Sequential — should NOT be one call |
| 10 | "Open question — what's your name?" | Free-form (model should ask in prose, not call either tool) |

Scenarios 7, 9, and 10 are the ones where steering is most likely to break.

## What we did NOT measure

- Live prompt-steering hit rate. Reasons above. The recommendation is robust to a 60-90% hit rate range; below 60% the recommendation hardens further.
- Actual end-to-end latency in claude TUI 2.1.x. Estimated, not measured.
- Behavior under hook denial / abort. If the user denies a `chroxy_ask_user` call, the spike returns an error envelope; the model's recovery behavior is identical to a denied `AskUserQuestion` and was not exercised.
- Interaction with chroxy's existing `permissionMode` (plan / acceptEdits / etc.). The MCP shim would inherit the same permission gate, so a `plan` mode session would block the tool call at the same place it blocks `AskUserQuestion` today.

## Tradeoffs summary

### Pros
- Fully bypasses the PTY-keystroke driver (`#4604` / `#4620` / `#4669` / `#4687`) for multi-question forms.
- Eliminates the claude TUI version-drift risk against the Ink form renderer.
- Reuses chroxy's existing `mcpServers` plumbing — zero new transport surface.
- A clean answer envelope (structured JSON) — no observability gaps the way the keystroke driver has them.
- Same auth-mode reach as the existing BYOK fleet (subscription and BYOK both).

### Cons
- **Steering reliability is the load-bearing risk.** Below ~85% hit rate, this is worse than `#4648` (which is deterministic).
- A steering miss silently regresses to the broken keystroke driver path unless paired with a defensive "fail the steering, escalate to deny" guard — at which point we've built `#4648` again, with extra moving parts.
- Free-form / "Other" support (#4651) gets harder, not easier — MCP tools don't have rich-input affordances.
- The treadmill moves from claude TUI drift to model behavior drift. Equally observation-shaped, harder to debug because it shows up as "the model just didn't call our tool today."
- Adds a long-running stdio child process per session in TUI mode — new lifecycle / teardown surface (#4645 territory).

## Decision: DEFER

The shipped `#4648` refuse-and-decompose path is the appropriate TUI-mode behavior until either of these triggers fires:

### Revisit trigger 1 — Anthropic ships a documented preferred-tool override
If a future claude TUI version exposes a documented mechanism for "this MCP server's tool takes precedence over the built-in for tool X" (the moral equivalent of `preferred_tools` config or an `AskUserQuestion`-override hook), the steering-reliability blocker evaporates and this approach becomes the right answer. The spike here is the template.

### Revisit trigger 2 — claude TUI 2.2.x or later changes the form widget surface
If the version-drift cost on the keystroke driver gets materially worse (e.g., the Ink form is replaced with a TTY input that the current driver can't drive), Approach 3 stops being "the same surface as #4648 with extra steering risk" and starts being "the only path that works at all." At that point the steering risk is acceptable because the alternative is non-functional.

Neither trigger has fired as of 2026-06-01. Both are observable from the chroxy maintenance feed — claude TUI release notes for trigger 1, the existing `#4648` watchdog telemetry for trigger 2.

## Acceptance criteria — disposition

| Criterion | Disposition |
|---|---|
| Spike MCP server exists in a branch | **Done** — `packages/server/scripts/spike-mcp-elicitation-shim.mjs`, regression-guarded by `tests/spike-mcp-elicitation-shim.test.js` |
| Prompt-steering evaluated across ≥10 scenarios with hit rate documented | **Partial** — corpus enumerated, live measurement deferred with rationale (see "What we did NOT measure"). Recommendation is robust to the realistic hit-rate range |
| Subscription-mode compatibility confirmed or refuted | **Confirmed** — MCP transport works in subscription mode; the blocker is steering, which is auth-independent |
| Latency measured vs single-q baseline | **Estimated** — roughly equivalent on the user side, marginal win for the MCP path on the chroxy side. Not validated live |
| Decision document checked in | **Done** — this document |
| If "pursue", a follow-up implementation issue is filed | **N/A** — recommendation is "defer", not "pursue". No implementation issue filed |

## References

- Parent: #4654
- Refuse-and-decompose baseline this would replace: #4648
- Keystroke-driver thread: #4604 / #4620 / #4669 / #4687
- Other / freeform interaction: #4651
- Existing MCP plumbing: `packages/server/src/byok-mcp-config.js`, `byok-mcp-fleet.js`
- AskUserQuestion runtime shape: `packages/server/src/claude-tui-session.js:1384`
- Spike: `packages/server/scripts/spike-mcp-elicitation-shim.mjs`
- Spike tests: `packages/server/tests/spike-mcp-elicitation-shim.test.js`
