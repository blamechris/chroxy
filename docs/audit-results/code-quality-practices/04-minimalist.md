# Minimalist's Audit: Codebase-Wide Code Quality

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.5 / 5
**Date**: 2026-03-15

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Server — Core Session Layer | 3/5 | Provider abstraction earns its keep; copy-paste resolvers |
| Server — WsServer & Decomposed Modules | 3/5 | Duplicated backpressure logic; dead tunnel-events.js |
| Server — Utility Modules | 2/5 | Dead `cost-analytics.js`, micro-modules with 1 caller |
| Server — Config System | 4/5 | Clean schema, minor derivable map duplication |
| App — Store Layer | 3/5 | `utils.ts` duplicated between app and dashboard |
| App — Syntax Highlighter | 2/5 | Two complete independent implementations (~700 lines) |
| Dashboard — Theme System | 3/5 | Dead token exports |
| Legacy Mode Infrastructure | 2/5 | ~50 lines of dead adapter code |

---

## Finding 1: `cost-analytics.js` — Dead Module (181 Lines)

**File:** `packages/server/src/cost-analytics.js`

Exports `createCostTracker`, `computeSummary`, `groupCostsBySession`, `groupCostsByHour`, `formatCost`. Zero imports in production server code. Not used by dashboard or app. Built for a planned analytics visualization that was never connected.

**Recommendation:** Delete `cost-analytics.js` and its test file.

---

## Finding 2: Duplicate Syntax Highlighter — 700 Lines of Redundancy

**Files:**
- `packages/app/src/utils/syntax/languages.ts` (285 lines) + `tokenizer.ts` (84 lines)
- `packages/server/src/dashboard-next/src/lib/syntax.ts` (325 lines)

Two complete implementations of the same 15+ language tokenizer using the same sticky-regex approach. No platform-specific dependencies. Should live in `@chroxy/store-core` or a sibling `@chroxy/syntax` package.

---

## Finding 3: Triplicate Binary Resolver Pattern

**Files:**
- `packages/server/src/git.js:resolveGit()`
- `packages/server/src/gemini-session.js:30-49` `resolveGemini()`
- `packages/server/src/codex-session.js:32-51` `resolveCodex()`

All three do: run `which <binary>`, catch error, iterate hardcoded fallback paths. Create `utils/resolve-binary.js` — 1 line per caller instead of 20.

---

## Finding 4: Dead Legacy Mode Adapter (~50 Lines)

**Files:**
- `packages/server/src/ws-message-handlers.js:71-114` `createCliSessionAdapter`, `handleCliMessage`
- `packages/server/src/ws-server.js:291,435-439,832-834` `cliSession` parameter

The `cliSession` path is structurally unreachable — `server-cli.js` always passes `sessionManager`. Remove the parameter, adapter, and routing branch.

---

## Finding 5: Single-Call-Site Modules with No Abstraction Value

- `no-auth-warnings.js` (20 lines, 1 call site)
- `mask-token.js` (10 lines, 2 call sites)
- `tunnel-events.js` (23 lines, 1 call site)
- `CodexSession.setModel()` — 3-line override that only calls `super.setModel()`

Inline these. Net reduction: ~60 lines, 3 files.

---

## Bonus Observations

- **`theme/tokens.ts` and `theme/index.ts`**: Generated design tokens (139 lines) exported but never imported by any dashboard component. Dead export infrastructure.
- **`request_cost_summary` WS message**: Defined in protocol, handled server-side, never sent by any client.
- **Backpressure logic duplicated in `WsBroadcaster`**: `_broadcast` and `_broadcastToSession` contain identical 8-line blocks.
- **`utils.ts` duplication**: `stripAnsi`, `nextMessageId`, `withJitter` duplicated between app and dashboard stores.
